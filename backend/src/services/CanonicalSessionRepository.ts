import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/connection';
import {
  CanonicalAdapterHealth,
  CanonicalAdapterHealthInput,
  CanonicalAliasInput,
  CanonicalAttempt,
  CanonicalEvent,
  CanonicalEventInput,
  CanonicalIngestionBatchInput,
  CanonicalIngestionBatchResult,
  EventInsertResult,
  LinkAttemptContextInput,
  ResolveAttemptInput,
  TaskAttemptHistoryRow,
} from '../types/CanonicalSession';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class CanonicalPersistenceConflict extends Error {
  constructor(
    public readonly code: 'identity_collision' | 'idempotency_payload_mismatch' | 'identity_decision_mismatch' | 'task_attempt_link_conflict',
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalPersistenceConflict';
  }
}

class ConcurrentAliasClaim extends Error {}

export class CanonicalSessionRepository {
  constructor(private readonly pool: Pool = defaultPool) {}

  private aliasTuple(alias: CanonicalAliasInput): unknown[] {
    return [
      alias.source,
      alias.sourceInstance,
      alias.kind,
      alias.value,
      alias.normalizationVersion ?? 1,
    ];
  }

  private async findAttemptsForAliases(
    client: PoolClient,
    aliases: CanonicalAliasInput[],
  ): Promise<Array<{ attemptId: string; alias: CanonicalAliasInput }>> {
    const claims: Array<{ attemptId: string; alias: CanonicalAliasInput }> = [];
    for (const alias of aliases) {
      const result = await client.query<{ attempt_id: string }>(
        `SELECT attempt_id FROM session_aliases
         WHERE source = $1 AND source_instance = $2 AND alias_kind = $3
           AND alias_value = $4 AND normalization_version = $5`,
        this.aliasTuple(alias),
      );
      for (const row of result.rows) claims.push({ attemptId: row.attempt_id, alias });
    }
    return claims;
  }

  private async insertDecisionReceipt(
    client: PoolClient,
    input: ResolveAttemptInput,
    decision: { attemptId?: string; collisionId?: string },
  ): Promise<void> {
    const aliasHashes = input.aliases.map(alias => ({
      source: alias.source,
      sourceInstance: alias.sourceInstance,
      kind: alias.kind,
      valueHash: sha256(alias.value),
      normalizationVersion: alias.normalizationVersion ?? 1,
    }));
    const inserted = await client.query<{ receipt_id: string }>(
      `INSERT INTO session_identity_decision_receipts
       (adapter, adapter_version, normalization_version, input_alias_hashes,
        attempt_id, collision_id, reason_code, idempotency_key)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING receipt_id`,
      [
        input.adapter,
        input.adapterVersion,
        Math.max(...input.aliases.map(alias => alias.normalizationVersion ?? 1)),
        JSON.stringify(aliasHashes),
        decision.attemptId ?? null,
        decision.collisionId ?? null,
        input.identityReason,
        input.idempotencyKey,
      ],
    );
    if (inserted.rows[0]) return;

    const existing = await client.query<{
      adapter: string;
      adapter_version: string;
      normalization_version: number;
      input_alias_hashes: unknown;
      attempt_id: string | null;
      collision_id: string | null;
      reason_code: string;
    }>(
      `SELECT adapter, adapter_version, normalization_version, input_alias_hashes,
              attempt_id, collision_id, reason_code
       FROM session_identity_decision_receipts WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    const receipt = existing.rows[0];
    if (!receipt
      || receipt.adapter !== input.adapter
      || receipt.adapter_version !== input.adapterVersion
      || receipt.normalization_version !== Math.max(...input.aliases.map(alias => alias.normalizationVersion ?? 1))
      || canonicalJson(receipt.input_alias_hashes) !== canonicalJson(aliasHashes)
      || receipt.attempt_id !== (decision.attemptId ?? null)
      || receipt.collision_id !== (decision.collisionId ?? null)
      || receipt.reason_code !== input.identityReason) {
      throw new CanonicalPersistenceConflict(
        'identity_decision_mismatch',
        'identity decision idempotency key was replayed for a different result',
      );
    }
  }

  private async persistCollision(
    client: PoolClient,
    input: ResolveAttemptInput,
    existingAttemptId: string,
    claimantAttemptId: string,
    alias: CanonicalAliasInput,
  ): Promise<string> {
    const evidenceRefs = JSON.stringify([...new Set(input.aliases.map(item => item.evidenceRef))]);
    const result = await client.query<{ collision_id: string }>(
      `INSERT INTO session_identity_collisions
       (source, source_instance, alias_kind, alias_value_hash, normalization_version,
        existing_attempt_id, claimant_attempt_id, reason_code, first_observed_at,
        last_observed_at, evidence_refs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10::jsonb)
       ON CONFLICT (source, source_instance, alias_kind, alias_value_hash,
                    normalization_version, existing_attempt_id, claimant_attempt_id)
       DO UPDATE SET last_observed_at = EXCLUDED.last_observed_at,
                     occurrence_count = session_identity_collisions.occurrence_count + 1,
                     evidence_refs = session_identity_collisions.evidence_refs || EXCLUDED.evidence_refs
       RETURNING collision_id`,
      [
        alias.source,
        alias.sourceInstance,
        alias.kind,
        sha256(alias.value),
        alias.normalizationVersion ?? 1,
        existingAttemptId,
        claimantAttemptId,
        'authoritative_aliases_resolve_to_multiple_attempts',
        input.observedAt,
        evidenceRefs,
      ],
    );
    return result.rows[0].collision_id;
  }

  /**
   * Resolve authoritative aliases or atomically create one execution attempt.
   * No fuzzy label/time matching is permitted. If aliases resolve to different
   * attempts, the caller receives a fail-closed collision.
   */
  async resolveOrCreateAttempt(input: ResolveAttemptInput): Promise<CanonicalAttempt> {
    return this.resolveOrCreateAttemptWithRetry(input, 1);
  }

  private async resolveOrCreateAttemptWithRetry(
    input: ResolveAttemptInput,
    retriesRemaining: number,
  ): Promise<CanonicalAttempt> {
    if (input.aliases.length === 0) throw new Error('at least one source alias is required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claims = await this.findAttemptsForAliases(client, input.aliases);
      const existingIds = [...new Set(claims.map(claim => claim.attemptId))];
      if (existingIds.length > 1) {
        const claimant = claims.find(claim => claim.attemptId === existingIds[1])!;
        const collisionId = await this.persistCollision(
          client,
          input,
          existingIds[0],
          existingIds[1],
          claimant.alias,
        );
        await this.insertDecisionReceipt(client, input, { collisionId });
        await client.query('COMMIT');
        throw new CanonicalPersistenceConflict(
          'identity_collision',
          'source aliases resolve to multiple canonical attempts',
        );
      }

      let attempt: CanonicalAttempt;
      if (existingIds.length === 1) {
        const result = await client.query<CanonicalAttempt>(
          'SELECT * FROM session_attempts WHERE attempt_id = $1',
          [existingIds[0]],
        );
        attempt = result.rows[0];
      } else {
        const result = await client.query<CanonicalAttempt>(
          `INSERT INTO session_attempts
           (harness, runtime_kind, first_observed_at, identity_confidence,
            identity_reason, created_by_adapter)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            input.harness,
            input.runtimeKind,
            input.observedAt,
            input.identityConfidence,
            input.identityReason,
            `${input.adapter}@${input.adapterVersion}`,
          ],
        );
        attempt = result.rows[0];
      }

      for (const alias of input.aliases) {
        const result = await client.query<{ attempt_id: string }>(
          `INSERT INTO session_aliases
           (attempt_id, source, source_instance, alias_kind, alias_value,
            normalization_version, valid_from, authority, evidence_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (source, source_instance, alias_kind, alias_value, normalization_version)
           DO UPDATE SET alias_value = EXCLUDED.alias_value
           RETURNING attempt_id`,
          [attempt.attempt_id, ...this.aliasTuple(alias), alias.observedAt, alias.authority, alias.evidenceRef],
        );
        if (result.rows[0].attempt_id !== attempt.attempt_id) {
          throw new ConcurrentAliasClaim('concurrent source-alias claim must be resolved again');
        }
      }

      await this.insertDecisionReceipt(client, input, { attemptId: attempt.attempt_id });
      await client.query('COMMIT');
      return attempt;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof ConcurrentAliasClaim && retriesRemaining > 0) {
        return this.resolveOrCreateAttemptWithRetry(input, retriesRemaining - 1);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Insert one already-redacted immutable event with exact replay semantics. */
  async appendEvent(input: CanonicalEventInput): Promise<EventInsertResult> {
    return this.appendEventWith(this.pool, input);
  }

  private async appendEventWith(
    queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    input: CanonicalEventInput,
  ): Promise<EventInsertResult> {
    const payloadHash = sha256(canonicalJson(input.payload));
    const result = await queryable.query<CanonicalEvent>(
      `INSERT INTO session_events
       (attempt_id, source, source_instance, stream_generation, event_kind,
        source_event_id, source_sequence, source_occurred_at, payload,
        payload_hash, redaction_policy_version, correlation_id,
        parent_event_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        input.attemptId, input.source, input.sourceInstance, input.streamGeneration,
        input.eventKind, input.sourceEventId ?? null, input.sourceSequence ?? null,
        input.sourceOccurredAt ?? null, canonicalJson(input.payload), payloadHash,
        input.redactionPolicyVersion, input.correlationId ?? null,
        input.parentEventId ?? null, input.idempotencyKey,
      ],
    );
    if (result.rows[0]) return { event: result.rows[0], inserted: true };

    const existing = await queryable.query<CanonicalEvent>(
      'SELECT * FROM session_events WHERE idempotency_key = $1',
      [input.idempotencyKey],
    );
    const event = existing.rows[0];
    if (!event || event.payload_hash !== payloadHash) {
      throw new CanonicalPersistenceConflict(
        'idempotency_payload_mismatch',
        'event idempotency key was replayed with a different redacted payload',
      );
    }
    return { event, inserted: false };
  }

  /** Atomically commit redacted events and their monotonic source scan cursor. */
  async commitIngestionBatch(input: CanonicalIngestionBatchInput): Promise<CanonicalIngestionBatchResult> {
    if (!/^\d+$/.test(input.cursorPosition)) throw new Error('cursor position must be a non-negative integer');
    if (!/^[0-9a-f]{64}$/.test(input.sourceChecksum)) throw new Error('source checksum must be sha256 hex');
    if (!input.cursorValue || input.cursorValue.length > 512) throw new Error('cursor value is missing or too long');
    for (const event of input.events) {
      if (event.source !== input.source
        || event.sourceInstance !== input.sourceInstance
        || event.streamGeneration !== input.streamGeneration) {
        throw new Error('batch event stream identity does not match cursor identity');
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{
        cursor_position: string; cursor_value: string; source_checksum: string; revision: string | number;
      }>(
        `SELECT cursor_position::text, cursor_value, source_checksum, revision
         FROM session_ingestion_cursors
         WHERE source=$1 AND source_instance=$2 AND stream_generation=$3 FOR UPDATE`,
        [input.source, input.sourceInstance, input.streamGeneration],
      );
      const current = selected.rows[0];
      if (current && BigInt(current.cursor_position) === BigInt(input.cursorPosition)
        && (current.source_checksum !== input.sourceChecksum || current.cursor_value !== input.cursorValue)) {
        throw new CanonicalPersistenceConflict(
          'idempotency_payload_mismatch',
          'ingestion cursor position was replayed with a different source checksum',
        );
      }

      let insertedEvents = 0;
      for (const event of input.events) {
        const result = await this.appendEventWith(client, event);
        if (result.inserted) insertedEvents += 1;
      }
      const samePosition = !!current && BigInt(input.cursorPosition) === BigInt(current.cursor_position);
      if (samePosition && insertedEvents > 0) {
        throw new CanonicalPersistenceConflict(
          'idempotency_payload_mismatch',
          'ingestion cursor replay attempted to introduce previously unseen events',
        );
      }
      const stale = !!current && BigInt(input.cursorPosition) < BigInt(current.cursor_position);
      if (stale && insertedEvents > 0) {
        throw new CanonicalPersistenceConflict(
          'idempotency_payload_mismatch',
          'stale ingestion cursor attempted to introduce previously unseen events',
        );
      }
      for (const gap of input.gaps || []) {
        await client.query(
          `INSERT INTO session_event_gaps
           (attempt_id, source, source_instance, stream_generation, gap_kind, expected_from, expected_to)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (source, source_instance, stream_generation, gap_kind, expected_from, expected_to)
           DO UPDATE SET attempt_id=COALESCE(session_event_gaps.attempt_id, EXCLUDED.attempt_id)`,
          [gap.attemptId ?? null, input.source, input.sourceInstance, input.streamGeneration,
            gap.gapKind, gap.expectedFrom, gap.expectedTo],
        );
      }

      let advances = !current || BigInt(input.cursorPosition) > BigInt(current.cursor_position);
      let revision = Number(current?.revision || 0);
      if (advances) {
        const updated = await client.query<{ revision: string | number }>(
          `INSERT INTO session_ingestion_cursors
           (source, source_instance, stream_generation, cursor_position, cursor_value, source_checksum, revision)
           VALUES ($1,$2,$3,$4::numeric,$5,$6,1)
           ON CONFLICT (source, source_instance, stream_generation)
           DO UPDATE SET cursor_position=EXCLUDED.cursor_position,
                         cursor_value=EXCLUDED.cursor_value,
                         source_checksum=EXCLUDED.source_checksum,
                         revision=session_ingestion_cursors.revision+1,
                         updated_at=NOW()
           WHERE session_ingestion_cursors.cursor_position < EXCLUDED.cursor_position
           RETURNING revision`,
          [input.source, input.sourceInstance, input.streamGeneration,
            input.cursorPosition, input.cursorValue, input.sourceChecksum],
        );
        if (!updated.rows[0]) {
          const winner = await client.query<{
            cursor_position: string; cursor_value: string; source_checksum: string; revision: string | number;
          }>(
            `SELECT cursor_position::text, cursor_value, source_checksum, revision
             FROM session_ingestion_cursors
             WHERE source=$1 AND source_instance=$2 AND stream_generation=$3 FOR UPDATE`,
            [input.source, input.sourceInstance, input.streamGeneration],
          );
          const concurrent = winner.rows[0];
          if (!concurrent
            || BigInt(concurrent.cursor_position) !== BigInt(input.cursorPosition)
            || concurrent.cursor_value !== input.cursorValue
            || concurrent.source_checksum !== input.sourceChecksum
            || insertedEvents > 0) {
            throw new CanonicalPersistenceConflict(
              'idempotency_payload_mismatch',
              'ingestion cursor advance lost a concurrent monotonic update race',
            );
          }
          advances = false;
          revision = Number(concurrent.revision);
        } else {
          revision = Number(updated.rows[0].revision);
        }
      }
      await client.query('COMMIT');
      return {
        insertedEvents,
        replayedEvents: input.events.length - insertedEvents,
        cursorAdvanced: advances,
        cursorRevision: revision,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Persist one bounded, payload-free adapter health snapshot. */
  async recordAdapterHealth(input: CanonicalAdapterHealthInput): Promise<CanonicalAdapterHealth> {
    const checkedAt = input.checkedAt || new Date();
    const safeDetails = input.safeDetails || {};
    for (const value of Object.values(safeDetails)) {
      if (value !== null && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error('adapter health details must contain aggregate scalar values only');
      }
    }
    const result = await this.pool.query<CanonicalAdapterHealth>(
      `INSERT INTO session_adapter_health
       (source, source_instance, adapter_version, status, reason_code, last_source_at,
        last_success_at, last_error_at, checked_at, safe_details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (source, source_instance) DO UPDATE SET
         adapter_version=EXCLUDED.adapter_version, status=EXCLUDED.status,
         reason_code=EXCLUDED.reason_code,
         last_source_at=COALESCE(EXCLUDED.last_source_at, session_adapter_health.last_source_at),
         last_success_at=COALESCE(EXCLUDED.last_success_at, session_adapter_health.last_success_at),
         last_error_at=COALESCE(EXCLUDED.last_error_at, session_adapter_health.last_error_at),
         checked_at=EXCLUDED.checked_at, safe_details=EXCLUDED.safe_details
       RETURNING *`,
      [input.source, input.sourceInstance, input.adapterVersion, input.status,
        input.reasonCode || null, input.lastSourceAt || null,
        input.succeeded ? checkedAt : null, input.succeeded ? null : checkedAt,
        checkedAt, JSON.stringify(safeDetails)],
    );
    return result.rows[0];
  }

  async listAdapterHealth(): Promise<CanonicalAdapterHealth[]> {
    const result = await this.pool.query<CanonicalAdapterHealth>(
      `SELECT source, source_instance, adapter_version, status, reason_code,
              last_source_at, last_success_at, last_error_at, checked_at, safe_details
       FROM session_adapter_health ORDER BY source, source_instance`,
    );
    return result.rows;
  }

  /**
   * Bind one canonical attempt to its task context without mutating prior
   * attempts. Exact replay is accepted; changed immutable context fails closed.
   */
  async linkAttemptContext(input: LinkAttemptContextInput): Promise<TaskAttemptHistoryRow> {
    if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1) {
      throw new Error('attempt number must be a positive integer');
    }
    if (input.subtaskIndex !== undefined
      && (!Number.isInteger(input.subtaskIndex) || input.subtaskIndex < 0)) {
      throw new Error('subtask index must be a non-negative integer');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<TaskAttemptHistoryRow>(
        `INSERT INTO task_attempt_links
         (task_id, subtask_index, attempt_id, role, attempt_number, link_state, source, evidence_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [input.taskId, input.subtaskIndex ?? null, input.attemptId, input.role,
          input.attemptNumber, input.linkState, input.source, input.evidenceRef],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<TaskAttemptHistoryRow>(
          `SELECT * FROM task_attempt_links
           WHERE (task_id=$1 AND attempt_id=$2 AND role=$3)
              OR (task_id=$1 AND role=$3 AND attempt_number=$4)
           ORDER BY linked_at LIMIT 2 FOR UPDATE`,
          [input.taskId, input.attemptId, input.role, input.attemptNumber],
        );
        const exact = existing.rows.length === 1 ? existing.rows[0] : undefined;
        if (!exact
          || exact.task_id !== input.taskId
          || exact.attempt_id !== input.attemptId
          || exact.role !== input.role
          || Number(exact.attempt_number) !== input.attemptNumber
          || exact.subtask_index !== (input.subtaskIndex ?? null)
          || exact.link_state !== input.linkState
          || exact.source !== input.source
          || exact.evidence_ref !== input.evidenceRef) {
          throw new CanonicalPersistenceConflict(
            'task_attempt_link_conflict',
            'task attempt identity was replayed with different immutable context',
          );
        }
      }

      if (input.project) {
        await client.query(
          `INSERT INTO attempt_project_links
           (attempt_id, project_id, role, source, evidence_ref)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [input.attemptId, input.project.projectId, input.project.role,
            input.project.source, input.project.evidenceRef],
        );
      }
      if (input.persona) {
        await client.query(
          `INSERT INTO attempt_persona_links
           (attempt_id, agent_type_id, source, valid_from, valid_to, evidence_ref)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [input.attemptId, input.persona.agentTypeId, input.persona.source,
            input.persona.validFrom, input.persona.validTo ?? null, input.persona.evidenceRef],
        );
      }
      if (input.parent) {
        const edge = await client.query<{ edge_id: string }>(
          `INSERT INTO session_attempt_edges
           (parent_attempt_id, child_attempt_id, relationship, authority, evidence_ref)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING edge_id`,
          [input.parent.attemptId, input.attemptId, input.parent.relationship,
            input.parent.authority, input.parent.evidenceRef],
        );
        if (!edge.rows[0]) {
          const replay = await client.query<{ edge_id: string }>(
            `SELECT edge_id FROM session_attempt_edges
             WHERE parent_attempt_id=$1 AND child_attempt_id=$2 AND relationship=$3
               AND authority=$4 AND evidence_ref=$5 AND invalidated_at IS NULL`,
            [input.parent.attemptId, input.attemptId, input.parent.relationship,
              input.parent.authority, input.parent.evidenceRef],
          );
          if (!replay.rows[0]) {
            throw new CanonicalPersistenceConflict(
              'task_attempt_link_conflict',
              'child attempt already has a different active execution parent',
            );
          }
        }
      }
      await client.query('COMMIT');
      const history = await this.listTaskAttemptHistory(input.taskId, input.attemptId);
      if (!history[0]) throw new Error('task attempt link disappeared after commit');
      return history[0];
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Resolve durable task context for authoritative runtime/session aliases.
   * Adapters call this immediately after identity resolution so linkage is
   * integrated into ingestion rather than exposed only as a repository API.
   */
  async linkAttemptContextForSessionKeys(
    attemptId: string,
    sessionKeys: string[],
    observedAt: Date,
  ): Promise<TaskAttemptHistoryRow[]> {
    const keys = [...new Set(sessionKeys.filter(key => typeof key === 'string' && key.length > 0))];
    if (keys.length === 0) return [];
    const tasks = await this.pool.query<{
      task_id: string;
      project_id: string | null;
      agent_type_id: string | null;
      parent_attempt_id: string | null;
      attempt_number: number;
      context_observed_at: Date;
    }>(
      `SELECT t.id AS task_id, t.project_id, t.agent_type_id,
              parent_link.attempt_id AS parent_attempt_id,
              COALESCE(existing.attempt_number, next_attempt.attempt_number) AS attempt_number,
              COALESCE(a.first_observed_at, $3::timestamptz) AS context_observed_at
         FROM tasks t
         JOIN session_attempts a ON a.attempt_id=$1
         LEFT JOIN LATERAL (
           SELECT l.attempt_number FROM task_attempt_links l
            WHERE l.task_id=t.id AND l.attempt_id=$1 AND l.role='implementation'
            LIMIT 1
         ) existing ON TRUE
         LEFT JOIN LATERAL (
           SELECT COALESCE(MAX(l.attempt_number), 0) + 1 AS attempt_number
             FROM task_attempt_links l WHERE l.task_id=t.id AND l.role='implementation'
         ) next_attempt ON TRUE
         LEFT JOIN LATERAL (
           SELECT l.attempt_id FROM task_attempt_links l
            WHERE l.task_id=t.parent_id AND l.role='implementation'
            ORDER BY l.attempt_number DESC, l.linked_at DESC LIMIT 1
         ) parent_link ON TRUE
        WHERE t.acp_session_key = ANY($2::text[])
           OR (jsonb_typeof(t.session_refs)='array' AND t.session_refs ?| $2::text[])
           OR (t.active_agent IS NOT NULL AND CASE WHEN t.active_agent::text ~ '^\\s*\\{'
                THEN t.active_agent::jsonb->>'sessionKey' = ANY($2::text[]) ELSE FALSE END)
           OR (t.completed_by IS NOT NULL AND CASE WHEN t.completed_by::text ~ '^\\s*\\{'
                THEN t.completed_by::jsonb->>'sessionKey' = ANY($2::text[]) ELSE FALSE END)
        ORDER BY t.updated_at, t.id`,
      [attemptId, keys, observedAt],
    );

    const linked: TaskAttemptHistoryRow[] = [];
    for (const task of tasks.rows) {
      linked.push(await this.linkAttemptContext({
        taskId: task.task_id,
        attemptId,
        role: 'implementation',
        attemptNumber: Number(task.attempt_number),
        linkState: 'bound',
        source: 'runtime_callback',
        evidenceRef: `runtime-session-alias:${sha256(keys.join('\u0000'))}`,
        project: task.project_id ? {
          projectId: task.project_id,
          role: 'implementation',
          source: 'task_project',
          evidenceRef: `task:${task.task_id}:project`,
        } : undefined,
        persona: task.agent_type_id ? {
          agentTypeId: task.agent_type_id,
          source: 'task_runtime_callback',
          validFrom: task.context_observed_at,
          evidenceRef: `task:${task.task_id}:persona`,
        } : undefined,
        parent: task.parent_attempt_id ? {
          attemptId: task.parent_attempt_id,
          relationship: 'spawned',
          authority: 'task_orchestrator',
          evidenceRef: `task:${task.task_id}:parent`,
        } : undefined,
      }));
    }
    return linked;
  }

  /** Read immutable current and historical attempts with their provenance. */
  async listTaskAttemptHistory(taskId: string, attemptId?: string): Promise<TaskAttemptHistoryRow[]> {
    const result = await this.pool.query<TaskAttemptHistoryRow>(
      `SELECT l.*, a.harness, a.runtime_kind, a.first_observed_at, a.started_at, a.ended_at,
              COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.linked_at)
                        FROM attempt_project_links p WHERE p.attempt_id=l.attempt_id), '[]'::jsonb) AS project_links,
              COALESCE((SELECT jsonb_agg(to_jsonb(pe) ORDER BY pe.valid_from)
                        FROM attempt_persona_links pe WHERE pe.attempt_id=l.attempt_id), '[]'::jsonb) AS persona_links,
              COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at)
                        FROM session_attempt_edges e WHERE e.child_attempt_id=l.attempt_id), '[]'::jsonb) AS parent_edges,
              COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at)
                        FROM session_attempt_edges e WHERE e.parent_attempt_id=l.attempt_id), '[]'::jsonb) AS child_edges
       FROM task_attempt_links l
       JOIN session_attempts a ON a.attempt_id=l.attempt_id
       WHERE l.task_id=$1 AND ($2::uuid IS NULL OR l.attempt_id=$2)
       ORDER BY l.attempt_number, l.linked_at, l.link_id`,
      [taskId, attemptId ?? null],
    );
    return result.rows;
  }
}

export const canonicalSessionRepository = new CanonicalSessionRepository();
