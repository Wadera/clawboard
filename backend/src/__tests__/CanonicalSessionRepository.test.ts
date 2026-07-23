import {
  CanonicalPersistenceConflict,
  CanonicalSessionRepository,
} from '../services/CanonicalSessionRepository';

const clientQuery = jest.fn();
const poolQuery = jest.fn();
const client = { query: clientQuery, release: jest.fn() };
const pool = { connect: jest.fn(async () => client), query: poolQuery } as any;

const alias = {
  source: 'hermes_sqlite',
  sourceInstance: 'default/state.db',
  kind: 'runtime_session_id',
  value: 'opaque-runtime-id',
  authority: 'source_authoritative' as const,
  evidenceRef: 'sqlite:sessions:opaque-runtime-id',
  observedAt: new Date('2026-07-16T10:00:00Z'),
};

const resolveInput = {
  harness: 'hermes' as const,
  runtimeKind: 'hermes_chat',
  identityConfidence: 'authoritative' as const,
  identityReason: 'authoritative_runtime_id',
  adapter: 'hermes-sqlite',
  adapterVersion: '1.0.0',
  idempotencyKey: 'identity:one',
  observedAt: new Date('2026-07-16T10:00:00Z'),
  aliases: [alias],
};

const attempt = {
  attempt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  contract_version: '1.0.0-draft.1',
  schema_version: 1,
  harness: 'hermes',
  runtime_kind: 'hermes_chat',
  first_observed_at: resolveInput.observedAt,
  identity_confidence: 'authoritative',
  identity_reason: 'authoritative_runtime_id',
  created_by_adapter: 'hermes-sqlite@1.0.0',
};

describe('CanonicalSessionRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clientQuery.mockReset();
    poolQuery.mockReset();
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT attempt_id FROM session_aliases')) return { rows: [] };
      if (sql.includes('INSERT INTO session_attempts')) return { rows: [attempt] };
      if (sql.includes('INSERT INTO session_aliases')) return { rows: [{ attempt_id: attempt.attempt_id }] };
      if (sql.includes('INSERT INTO session_identity_decision_receipts')) {
        return { rows: [{ receipt_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }] };
      }
      return { rows: [] };
    });
  });

  it('atomically creates an attempt, source aliases and a decision receipt', async () => {
    const repo = new CanonicalSessionRepository(pool);
    const result = await repo.resolveOrCreateAttempt(resolveInput);

    expect(result.attempt_id).toBe(attempt.attempt_id);
    expect(clientQuery).toHaveBeenCalledWith('BEGIN');
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO session_identity_decision_receipts'))).toBe(true);
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();

    const receiptCall = clientQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO session_identity_decision_receipts'));
    expect(receiptCall[1][3]).not.toContain(alias.value);
    expect(receiptCall[1][3]).toMatch(/[0-9a-f]{64}/);
  });

  it('reuses the exact source alias without creating another attempt', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT attempt_id FROM session_aliases')) return { rows: [{ attempt_id: attempt.attempt_id }] };
      if (sql.includes('SELECT * FROM session_attempts')) return { rows: [attempt] };
      if (sql.includes('INSERT INTO session_aliases')) return { rows: [{ attempt_id: attempt.attempt_id }] };
      if (sql.includes('INSERT INTO session_identity_decision_receipts')) {
        return { rows: [{ receipt_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }] };
      }
      return { rows: [] };
    });
    const repo = new CanonicalSessionRepository(pool);
    await repo.resolveOrCreateAttempt(resolveInput);

    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO session_attempts'))).toBe(false);
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('fails closed when input aliases resolve to different attempts', async () => {
    const secondAlias = { ...alias, kind: 'control_key', value: 'other' };
    let lookup = 0;
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT attempt_id FROM session_aliases')) {
        lookup += 1;
        return { rows: [{ attempt_id: lookup === 1 ? attempt.attempt_id : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] };
      }
      if (sql.includes('INSERT INTO session_identity_collisions')) {
        return { rows: [{ collision_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }] };
      }
      if (sql.includes('INSERT INTO session_identity_decision_receipts')) {
        return { rows: [{ receipt_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }] };
      }
      return { rows: [] };
    });
    const repo = new CanonicalSessionRepository(pool);

    await expect(repo.resolveOrCreateAttempt({ ...resolveInput, aliases: [alias, secondAlias] }))
      .rejects.toMatchObject({ code: 'identity_collision' });
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO session_attempts'))).toBe(false);
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO session_identity_collisions'))).toBe(true);
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('re-resolves a concurrent alias claim instead of exposing a uniqueness race', async () => {
    let lookup = 0;
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT attempt_id FROM session_aliases')) {
        lookup += 1;
        return { rows: lookup === 1 ? [] : [{ attempt_id: attempt.attempt_id }] };
      }
      if (sql.includes('INSERT INTO session_attempts')) {
        return { rows: [{ ...attempt, attempt_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }] };
      }
      if (sql.includes('INSERT INTO session_aliases')) return { rows: [{ attempt_id: attempt.attempt_id }] };
      if (sql.includes('SELECT * FROM session_attempts')) return { rows: [attempt] };
      if (sql.includes('INSERT INTO session_identity_decision_receipts')) {
        return { rows: [{ receipt_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }] };
      }
      return { rows: [] };
    });

    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.resolveOrCreateAttempt(resolveInput)).resolves.toMatchObject({ attempt_id: attempt.attempt_id });
    expect(clientQuery.mock.calls.filter(([sql]) => sql === 'BEGIN')).toHaveLength(2);
    expect(clientQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('rejects an identity decision idempotency key reused for another result', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT attempt_id FROM session_aliases')) return { rows: [] };
      if (sql.includes('INSERT INTO session_attempts')) return { rows: [attempt] };
      if (sql.includes('INSERT INTO session_aliases')) return { rows: [{ attempt_id: attempt.attempt_id }] };
      if (sql.includes('INSERT INTO session_identity_decision_receipts')) return { rows: [] };
      if (sql.includes('SELECT adapter, adapter_version')) {
        return { rows: [{ attempt_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', collision_id: null }] };
      }
      return { rows: [] };
    });

    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.resolveOrCreateAttempt(resolveInput))
      .rejects.toMatchObject({ code: 'identity_decision_mismatch' });
  });

  it('rejects an identity decision idempotency key reused with changed immutable inputs', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT attempt_id FROM session_aliases')) return { rows: [{ attempt_id: attempt.attempt_id }] };
      if (sql.includes('SELECT * FROM session_attempts')) return { rows: [attempt] };
      if (sql.includes('INSERT INTO session_aliases')) return { rows: [{ attempt_id: attempt.attempt_id }] };
      if (sql.includes('INSERT INTO session_identity_decision_receipts')) return { rows: [] };
      if (sql.includes('SELECT adapter, adapter_version')) {
        return { rows: [{
          adapter: resolveInput.adapter,
          adapter_version: resolveInput.adapterVersion,
          normalization_version: 1,
          input_alias_hashes: [{
            source: alias.source,
            sourceInstance: alias.sourceInstance,
            kind: alias.kind,
            valueHash: '0'.repeat(64),
            normalizationVersion: 1,
          }],
          attempt_id: attempt.attempt_id,
          collision_id: null,
          reason_code: resolveInput.identityReason,
        }] };
      }
      return { rows: [] };
    });

    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.resolveOrCreateAttempt(resolveInput))
      .rejects.toMatchObject({ code: 'identity_decision_mismatch' });
  });

  it('deduplicates an exact event replay independent of JSON key order', async () => {
    const persisted = {
      event_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      attempt_id: attempt.attempt_id,
      event_kind: 'message',
      payload: { a: 1, b: 2 },
      payload_hash: '',
      idempotency_key: 'event:1',
      ingested_at: new Date(),
    };
    poolQuery.mockResolvedValueOnce({ rows: [{ ...persisted, payload_hash: 'placeholder' }] });
    const repo = new CanonicalSessionRepository(pool);
    const input = {
      attemptId: attempt.attempt_id,
      source: 'hermes_sqlite',
      sourceInstance: 'default/state.db',
      streamGeneration: 'inode:1',
      eventKind: 'message' as const,
      payload: { b: 2, a: 1 },
      redactionPolicyVersion: '1',
      idempotencyKey: 'event:1',
    };
    const inserted = await repo.appendEvent(input);
    expect(inserted.inserted).toBe(true);

    const insertParams = poolQuery.mock.calls[0][1];
    persisted.payload_hash = insertParams[9];
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [persisted] });
    const replay = await repo.appendEvent({ ...input, payload: { a: 1, b: 2 } });
    expect(replay.inserted).toBe(false);
    expect(replay.event.event_id).toBe(persisted.event_id);
  });

  it('rejects same event key with a different redacted payload', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ payload_hash: '0'.repeat(64) }] });
    const repo = new CanonicalSessionRepository(pool);

    await expect(repo.appendEvent({
      attemptId: attempt.attempt_id,
      source: 'openclaw_gateway',
      sourceInstance: 'gateway/default',
      streamGeneration: 'boot:1',
      eventKind: 'tool_result',
      payload: { result: 'redacted' },
      redactionPolicyVersion: '1',
      idempotencyKey: 'event:conflict',
    })).rejects.toBeInstanceOf(CanonicalPersistenceConflict);
  });

  it('commits events and a monotonic ingestion cursor in one transaction', async () => {
    const persisted = { event_id: 'event-1', payload_hash: 'hash', idempotency_key: 'batch:event' };
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM session_ingestion_cursors')) return { rows: [] };
      if (sql.includes('INSERT INTO session_events')) return { rows: [persisted] };
      if (sql.includes('INSERT INTO session_ingestion_cursors')) return { rows: [{ revision: '1' }] };
      return { rows: [] };
    });
    const repo = new CanonicalSessionRepository(pool);
    const result = await repo.commitIngestionBatch({
      source: 'hermes_sqlite', sourceInstance: 'runtime/default', streamGeneration: 'session:abc',
      cursorPosition: '90071992547409930', cursorValue: 'message:90071992547409930',
      sourceChecksum: 'a'.repeat(64),
      events: [{ attemptId: attempt.attempt_id, source: 'hermes_sqlite', sourceInstance: 'runtime/default',
        streamGeneration: 'session:abc', eventKind: 'message', payload: { content: 'safe' },
        redactionPolicyVersion: 'v1', idempotencyKey: 'batch:event' }],
      gaps: [{ attemptId: attempt.attempt_id, gapKind: 'missing_sequence', expectedFrom: '2', expectedTo: '3' }],
    });
    expect(result).toMatchObject({ insertedEvents: 1, replayedEvents: 0, cursorAdvanced: true, cursorRevision: 1 });
    expect(clientQuery.mock.calls.findIndex(([sql]) => sql.includes('INSERT INTO session_events')))
      .toBeLessThan(clientQuery.mock.calls.findIndex(([sql]) => sql.includes('INSERT INTO session_ingestion_cursors')));
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO session_event_gaps'))).toBe(true);
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('rejects a changed checksum at the same cursor position and rolls back', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM session_ingestion_cursors')) {
        return { rows: [{ cursor_position: '7', source_checksum: 'b'.repeat(64), revision: '2' }] };
      }
      return { rows: [] };
    });
    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.commitIngestionBatch({
      source: 'openclaw_jsonl', sourceInstance: 'gateway/default', streamGeneration: 'session:def',
      cursorPosition: '7', cursorValue: 'line:7', sourceChecksum: 'c'.repeat(64), events: [],
    })).rejects.toMatchObject({ code: 'idempotency_payload_mismatch' });
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rejects a same-position replay that introduces an unseen event', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM session_ingestion_cursors')) {
        return { rows: [{ cursor_position: '7', cursor_value: 'line:7',
          source_checksum: 'c'.repeat(64), revision: '2' }] };
      }
      if (sql.includes('INSERT INTO session_events')) {
        return { rows: [{ event_id: 'event-new', payload_hash: 'hash', idempotency_key: 'same-position:new' }] };
      }
      return { rows: [] };
    });
    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.commitIngestionBatch({
      source: 'openclaw_jsonl', sourceInstance: 'gateway/default', streamGeneration: 'session:def',
      cursorPosition: '7', cursorValue: 'line:7', sourceChecksum: 'c'.repeat(64),
      events: [{ attemptId: attempt.attempt_id, source: 'openclaw_jsonl', sourceInstance: 'gateway/default',
        streamGeneration: 'session:def', eventKind: 'message', payload: { content: 'safe' },
        redactionPolicyVersion: 'v1', idempotencyKey: 'same-position:new' }],
    })).rejects.toMatchObject({ code: 'idempotency_payload_mismatch' });
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rejects an event whose source does not match the cursor stream', async () => {
    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.commitIngestionBatch({
      source: 'hermes_sqlite', sourceInstance: 'runtime/default', streamGeneration: 'session:abc',
      cursorPosition: '1', cursorValue: 'message:1', sourceChecksum: 'a'.repeat(64),
      events: [{ attemptId: attempt.attempt_id, source: 'openclaw_jsonl', sourceInstance: 'runtime/default',
        streamGeneration: 'session:abc', eventKind: 'message', payload: { content: 'safe' },
        redactionPolicyVersion: 'v1', idempotencyKey: 'wrong-source:event' }],
    })).rejects.toThrow('batch event stream identity does not match cursor identity');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('fails closed instead of regressing a cursor after a concurrent first insert', async () => {
    let cursorReads = 0;
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM session_ingestion_cursors')) {
        cursorReads += 1;
        return cursorReads === 1
          ? { rows: [] }
          : { rows: [{ cursor_position: '8', cursor_value: 'line:8', source_checksum: 'd'.repeat(64), revision: '1' }] };
      }
      if (sql.includes('INSERT INTO session_ingestion_cursors')) return { rows: [] };
      return { rows: [] };
    });
    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.commitIngestionBatch({
      source: 'openclaw_jsonl', sourceInstance: 'gateway/default', streamGeneration: 'session:def',
      cursorPosition: '7', cursorValue: 'line:7', sourceChecksum: 'c'.repeat(64), events: [],
    })).rejects.toMatchObject({ code: 'idempotency_payload_mismatch' });
    const cursorInsert = clientQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO session_ingestion_cursors'));
    expect(cursorInsert[0]).toContain(
      'WHERE session_ingestion_cursors.cursor_position < EXCLUDED.cursor_position',
    );
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('accepts an exact concurrent first-insert replay without claiming a cursor advance', async () => {
    let cursorReads = 0;
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM session_ingestion_cursors')) {
        cursorReads += 1;
        return cursorReads === 1
          ? { rows: [] }
          : { rows: [{ cursor_position: '7', cursor_value: 'line:7', source_checksum: 'c'.repeat(64), revision: '1' }] };
      }
      if (sql.includes('INSERT INTO session_ingestion_cursors')) return { rows: [] };
      return { rows: [] };
    });
    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.commitIngestionBatch({
      source: 'openclaw_jsonl', sourceInstance: 'gateway/default', streamGeneration: 'session:def',
      cursorPosition: '7', cursorValue: 'line:7', sourceChecksum: 'c'.repeat(64), events: [],
    })).resolves.toMatchObject({
      insertedEvents: 0, replayedEvents: 0, cursorAdvanced: false, cursorRevision: 1,
    });
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('records payload-free health while preserving prior success/error timestamps', async () => {
    const row = { source: 'hermes_sqlite', source_instance: 'runtime/default', status: 'degraded' };
    poolQuery.mockResolvedValueOnce({ rows: [row] });
    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.recordAdapterHealth({
      source: 'hermes_sqlite', sourceInstance: 'runtime/default', adapterVersion: '1.0.0',
      status: 'degraded', reasonCode: 'source_stale', succeeded: true,
      safeDetails: { messagesScanned: 3, gapsObserved: 1 },
    })).resolves.toBe(row);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toContain('last_success_at=COALESCE');
    expect(sql).toContain('last_error_at=COALESCE');
    expect(params[9]).toBe('{"messagesScanned":3,"gapsObserved":1}');
  });

  it('rejects free-form adapter health details', async () => {
    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.recordAdapterHealth({
      source: 'hermes_sqlite', sourceInstance: 'runtime/default', adapterVersion: '1.0.0',
      status: 'unavailable', succeeded: false,
      safeDetails: { leaked: 'source payload' } as any,
    })).rejects.toThrow('aggregate scalar values only');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  const taskLinkInput = {
    taskId: '11111111-1111-4111-8111-111111111111',
    subtaskIndex: 0,
    attemptId: attempt.attempt_id,
    role: 'implementation' as const,
    attemptNumber: 1,
    linkState: 'bound' as const,
    source: 'runtime_callback' as const,
    evidenceRef: 'runtime:hermes:opaque-id',
    project: {
      projectId: '22222222-2222-4222-8222-222222222222',
      role: 'implementation', source: 'task_project', evidenceRef: 'task:project',
    },
    persona: {
      agentTypeId: '33333333-3333-4333-8333-333333333333', source: 'task_spawn',
      validFrom: new Date('2026-07-16T12:00:00Z'), evidenceRef: 'spawn:persona',
    },
    parent: {
      attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      relationship: 'spawned' as const, authority: 'task_orchestrator' as const,
      evidenceRef: 'spawn:parent',
    },
  };

  it('atomically stamps task, project, persona, and parent context then returns history', async () => {
    const link = { ...taskLinkInput, link_id: 'link-1', task_id: taskLinkInput.taskId,
      subtask_index: 0, attempt_id: attempt.attempt_id, attempt_number: 1,
      link_state: 'bound', source: 'runtime_callback', evidence_ref: taskLinkInput.evidenceRef };
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO task_attempt_links')) return { rows: [link] };
      if (sql.includes('INSERT INTO session_attempt_edges')) return { rows: [{ edge_id: 'edge-1' }] };
      return { rows: [] };
    });
    poolQuery.mockResolvedValueOnce({ rows: [{ ...link, project_links: [{}], persona_links: [{}],
      parent_edges: [{}], child_edges: [] }] });
    const repo = new CanonicalSessionRepository(pool);

    await expect(repo.linkAttemptContext(taskLinkInput)).resolves.toMatchObject({ link_id: 'link-1' });
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO attempt_project_links'))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO attempt_persona_links'))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO session_attempt_edges'))).toBe(true);
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('accepts exact task-attempt replay without overwriting history', async () => {
    const existing = { task_id: taskLinkInput.taskId, subtask_index: 0,
      attempt_id: attempt.attempt_id, role: 'implementation', attempt_number: 1,
      link_state: 'bound', source: 'runtime_callback', evidence_ref: taskLinkInput.evidenceRef };
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO task_attempt_links')) return { rows: [] };
      if (sql.includes('SELECT * FROM task_attempt_links')) return { rows: [existing] };
      return { rows: [] };
    });
    poolQuery.mockResolvedValueOnce({ rows: [{ ...existing, link_id: 'link-1' }] });
    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.linkAttemptContext({
      taskId: taskLinkInput.taskId, attemptId: taskLinkInput.attemptId,
      subtaskIndex: 0, role: 'implementation', attemptNumber: 1,
      linkState: 'bound', source: 'runtime_callback', evidenceRef: taskLinkInput.evidenceRef,
    })).resolves.toMatchObject({ link_id: 'link-1' });
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('UPDATE task_attempt_links'))).toBe(false);
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('fails closed when an attempt number is reused for another attempt', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO task_attempt_links')) return { rows: [] };
      if (sql.includes('SELECT * FROM task_attempt_links')) return { rows: [{
        task_id: taskLinkInput.taskId, subtask_index: 0,
        attempt_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', role: 'implementation',
        attempt_number: 1, link_state: 'bound', source: 'runtime_callback',
        evidence_ref: taskLinkInput.evidenceRef,
      }] };
      return { rows: [] };
    });
    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.linkAttemptContext({
      taskId: taskLinkInput.taskId, attemptId: taskLinkInput.attemptId,
      subtaskIndex: 0, role: 'implementation', attemptNumber: 1,
      linkState: 'bound', source: 'runtime_callback', evidenceRef: taskLinkInput.evidenceRef,
    })).rejects.toMatchObject({ code: 'task_attempt_link_conflict' });
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('fails closed instead of silently keeping a different execution parent', async () => {
    const link = { task_id: taskLinkInput.taskId, subtask_index: 0,
      attempt_id: attempt.attempt_id, role: 'implementation', attempt_number: 1,
      link_state: 'bound', source: 'runtime_callback', evidence_ref: taskLinkInput.evidenceRef };
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO task_attempt_links')) return { rows: [link] };
      if (sql.includes('INSERT INTO session_attempt_edges')) return { rows: [] };
      if (sql.includes('SELECT edge_id FROM session_attempt_edges')) return { rows: [] };
      return { rows: [] };
    });
    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.linkAttemptContext(taskLinkInput))
      .rejects.toMatchObject({ code: 'task_attempt_link_conflict' });
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('bridges authoritative session aliases into durable task linkage during ingestion', async () => {
    const link = { task_id: taskLinkInput.taskId, subtask_index: null,
      attempt_id: attempt.attempt_id, role: 'implementation', attempt_number: 2,
      link_state: 'bound', source: 'runtime_callback', evidence_ref: 'runtime-session-alias:hash' };
    poolQuery
      .mockResolvedValueOnce({ rows: [{ task_id: taskLinkInput.taskId, project_id: null,
        agent_type_id: null, parent_attempt_id: null, attempt_number: 2,
        context_observed_at: new Date('2026-07-16T12:00:00Z') }] })
      .mockResolvedValueOnce({ rows: [{ ...link, link_id: 'link-2' }] });
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO task_attempt_links')) return { rows: [link] };
      return { rows: [] };
    });
    const repo = new CanonicalSessionRepository(pool);

    await expect(repo.linkAttemptContextForSessionKeys(
      attempt.attempt_id,
      ['hermes:tool:runtime-1', 'runtime-1', 'runtime-1'],
      new Date('2026-07-16T12:00:00Z'),
    )).resolves.toHaveLength(1);
    const [lookupSql, lookupParams] = poolQuery.mock.calls[0];
    expect(lookupSql).toContain('t.acp_session_key = ANY');
    expect(lookupSql).toContain('t.session_refs ?|');
    expect(lookupSql).toContain('parent_link.attempt_id');
    expect(lookupParams).toEqual([
      attempt.attempt_id,
      ['hermes:tool:runtime-1', 'runtime-1'],
      new Date('2026-07-16T12:00:00Z'),
    ]);
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO task_attempt_links'))).toBe(true);
  });

  it('lists all task attempts in stable historical order with context provenance', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ attempt_number: 1 }, { attempt_number: 2 }] });
    const repo = new CanonicalSessionRepository(pool);
    await expect(repo.listTaskAttemptHistory(taskLinkInput.taskId)).resolves.toHaveLength(2);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toContain('ORDER BY l.attempt_number, l.linked_at, l.link_id');
    expect(sql).toContain('FROM attempt_project_links');
    expect(sql).toContain('FROM attempt_persona_links');
    expect(sql).toContain('FROM session_attempt_edges');
    expect(params).toEqual([taskLinkInput.taskId, null]);
  });
});
