import { createHash } from 'crypto';
import {
  getHermesSessionStateRow,
  hermesSessionKeyFor,
  listHermesMessages,
  type HermesMessageStateRow,
  type HermesSessionStateRow,
} from './HermesRuntime';
import {
  CanonicalSessionRepository,
  canonicalSessionRepository,
} from './CanonicalSessionRepository';
import type { CanonicalAliasInput, CanonicalEventInput } from '../types/CanonicalSession';

const ADAPTER_NAME = 'hermes-sqlite';
const ADAPTER_VERSION = '1.0.0';
const REDACTION_POLICY_VERSION = 'hermes-v1';

export interface HermesIngestResult {
  attemptId: string;
  insertedEvents: number;
  replayedEvents: number;
  lifecycle: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  availability: 'available' | 'unavailable';
  freshness: 'fresh' | 'expired' | 'not_applicable';
}

interface HermesCanonicalRepository {
  resolveOrCreateAttempt: CanonicalSessionRepository['resolveOrCreateAttempt'];
  appendEvent: CanonicalSessionRepository['appendEvent'];
  commitIngestionBatch?: CanonicalSessionRepository['commitIngestionBatch'];
  recordAdapterHealth?: CanonicalSessionRepository['recordAdapterHealth'];
  linkAttemptContextForSessionKeys?: CanonicalSessionRepository['linkAttemptContextForSessionKeys'];
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Redact credential forms that can be safely recognized without retaining the
 * matched value. Callers must additionally run `hasUnsafeCredentialShape` and
 * fail closed when the remaining text still looks credential-bearing.
 */
export function redactHermesText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(AWS_SECRET_ACCESS_KEY|authorization|proxy[_-]?authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credential|cookie|set-cookie|password|passwd|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:access_token|api_key|key|token|secret|signature)=)[^&#\s]*/gi, '$1[REDACTED]');
}

function hasUnsafeCredentialShape(value: string): boolean {
  return /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i.test(value)
    || /\b(?:AWS_SECRET_ACCESS_KEY|authorization|proxy[_-]?authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credential|cookie|set-cookie|password|passwd|secret)\b\s*(?::|=|\s)\s*(?!\[REDACTED(?:_[A-Z_]+)?\])/i.test(value)
    || /\bBearer\s+(?!\[REDACTED\])\S+/i.test(value)
    || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)
    || /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/i.test(value)
    || /[?&](?:access_token|api_key|key|token|secret|signature)=(?!\[REDACTED\])[^&#\s]*/i.test(value);
}

interface ParsedToolCalls {
  calls: Array<{ id: string; name: string }>;
  error: 'malformed_json' | 'invalid_shape' | 'missing_native_id' | 'unsafe_metadata' | null;
}

function isSafeToolMetadata(value: string, maxLength: number): boolean {
  if (!value || value.length > maxLength || !/^[A-Za-z0-9_.:-]+$/.test(value)) return false;
  const redacted = redactHermesText(value);
  return redacted === value && !hasUnsafeCredentialShape(redacted);
}

function parseToolCalls(raw: string | null | undefined): ParsedToolCalls {
  if (!raw) return { calls: [], error: null };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { calls: [], error: 'invalid_shape' };
    const calls: Array<{ id: string; name: string }> = [];
    for (const entry of parsed) {
      const id = typeof entry?.call_id === 'string'
        ? entry.call_id
        : (typeof entry?.id === 'string' ? entry.id : '');
      if (!id) return { calls: [], error: 'missing_native_id' };
      const name = typeof entry?.function?.name === 'string'
        ? entry.function.name
        : (typeof entry?.name === 'string' ? entry.name : 'unknown');
      if (!isSafeToolMetadata(id, 256) || !isSafeToolMetadata(name, 160)) {
        return { calls: [], error: 'unsafe_metadata' };
      }
      calls.push({ id, name });
    }
    return { calls, error: null };
  } catch {
    return { calls: [], error: 'malformed_json' };
  }
}

function lifecycleFor(row: HermesSessionStateRow, nowSeconds: number): Pick<
  HermesIngestResult,
  'lifecycle' | 'availability' | 'freshness'
> & { reason: string } {
  if (row.ended_at) {
    const reason = String(row.end_reason || '').toLowerCase();
    if (reason.includes('cancel')) {
      return { lifecycle: 'cancelled', availability: 'available', freshness: 'not_applicable', reason: 'hermes_terminal_cancelled' };
    }
    if (reason && !['completed', 'complete', 'success', 'finished', 'normal'].includes(reason)) {
      return { lifecycle: 'failed', availability: 'available', freshness: 'not_applicable', reason: 'hermes_terminal_failed' };
    }
    return { lifecycle: 'completed', availability: 'available', freshness: 'not_applicable', reason: 'hermes_terminal_completed' };
  }

  const lastActivity = Number(row.last_message_at || row.started_at || 0);
  if (lastActivity > 0 && nowSeconds - lastActivity <= 90) {
    return { lifecycle: 'running', availability: 'available', freshness: 'fresh', reason: 'hermes_runtime_recent_activity' };
  }
  return { lifecycle: 'unknown', availability: 'unavailable', freshness: 'expired', reason: 'hermes_liveness_evidence_expired' };
}

function rowTimestamp(row: HermesMessageStateRow): Date {
  const value = Number(row.timestamp || 0);
  return value > 0 ? new Date(value * 1000) : new Date(0);
}

export class HermesCanonicalAdapter {
  constructor(
    private readonly repository: HermesCanonicalRepository = canonicalSessionRepository,
    private readonly sourceInstance = process.env.HERMES_CANONICAL_SOURCE_INSTANCE || 'hermes-runtime/default',
    private readonly stateDbPath = process.env.HERMES_READ_STATE_DB_PATH,
  ) {}

  async ingestSessionId(
    sessionId: string,
    now = new Date(),
    stateDbPath = this.stateDbPath,
  ): Promise<HermesIngestResult | null> {
    try {
      const row = await getHermesSessionStateRow(sessionId, stateDbPath);
      if (!row) {
        await this.repository.recordAdapterHealth?.({
          source: 'hermes_sqlite', sourceInstance: this.sourceInstance, adapterVersion: ADAPTER_VERSION,
          status: 'unavailable', reasonCode: 'hermes_session_not_found', succeeded: false, checkedAt: now,
          safeDetails: { sessionsFound: 0 },
        });
        return null;
      }
      const messages = await listHermesMessages(sessionId, stateDbPath);
      return this.ingestSnapshot(row, messages, now);
    } catch (error) {
      await this.repository.recordAdapterHealth?.({
        source: 'hermes_sqlite', sourceInstance: this.sourceInstance, adapterVersion: ADAPTER_VERSION,
        status: 'unavailable', reasonCode: 'hermes_ingestion_failed', succeeded: false, checkedAt: now,
        safeDetails: { sourceReadFailed: true },
      });
      throw error;
    }
  }

  async ingestSnapshot(
    row: HermesSessionStateRow,
    messages: HermesMessageStateRow[],
    now = new Date(),
  ): Promise<HermesIngestResult> {
    const observedAt = new Date(Number(row.last_message_at || row.ended_at || row.started_at || now.getTime() / 1000) * 1000);
    const aliases: CanonicalAliasInput[] = [{
      source: 'hermes_sqlite',
      sourceInstance: this.sourceInstance,
      kind: 'runtime_session_id',
      value: row.id,
      authority: 'source_authoritative',
      evidenceRef: `hermes:session:${digest(row.id)}`,
      observedAt,
    }];
    if (row.session_key && row.session_key !== row.id) {
      aliases.push({
        source: 'hermes_sqlite',
        sourceInstance: this.sourceInstance,
        kind: 'session_key',
        value: row.session_key,
        authority: 'source_reported',
        evidenceRef: `hermes:session-key:${digest(row.session_key)}`,
        observedAt,
      });
    }
    const identityInputDigest = digest(JSON.stringify(aliases.map(alias => ({
      source: alias.source,
      sourceInstance: alias.sourceInstance,
      kind: alias.kind,
      valueHash: digest(alias.value),
      normalizationVersion: alias.normalizationVersion ?? 1,
    }))));

    const attempt = await this.repository.resolveOrCreateAttempt({
      harness: 'hermes',
      runtimeKind: 'hermes_chat',
      identityConfidence: 'authoritative',
      identityReason: 'authoritative_runtime_id',
      adapter: ADAPTER_NAME,
      adapterVersion: ADAPTER_VERSION,
      // A source row may acquire an additional alias after first observation.
      // That is a new decision input, not a conflicting replay receipt.
      idempotencyKey: `hermes-identity:${this.sourceInstance}:${digest(row.id)}:${identityInputDigest}`,
      observedAt,
      aliases,
    });
    await this.repository.linkAttemptContextForSessionKeys?.(
      attempt.attempt_id,
      [row.id, row.session_key || '', hermesSessionKeyFor(row)],
      observedAt,
    );

    const state = lifecycleFor(row, now.getTime() / 1000);
    const events: CanonicalEventInput[] = [{
      attemptId: attempt.attempt_id,
      source: 'hermes_sqlite',
      sourceInstance: this.sourceInstance,
      streamGeneration: `session:${digest(row.id)}`,
      eventKind: 'lifecycle',
      sourceEventId: `state:${state.lifecycle}:${row.ended_at || row.last_message_at || row.started_at || 0}`,
      sourceOccurredAt: observedAt,
      payload: {
        lifecycle: state.lifecycle,
        availability: state.availability,
        freshness: state.freshness,
        reason: state.reason,
        source: 'hermes_sqlite',
      },
      redactionPolicyVersion: REDACTION_POLICY_VERSION,
      idempotencyKey: `hermes:${this.sourceInstance}:${digest(row.id)}:lifecycle:${state.lifecycle}:${row.ended_at || row.last_message_at || row.started_at || 0}`,
    }];

    const orderedMessages = [...messages]
      .filter((message): message is HermesMessageStateRow & { id: number } => message.id != null)
      .sort((left, right) => left.id - right.id);
    let previousMessageId: number | null = null;
    const gaps: Array<{ attemptId: string; gapKind: string; expectedFrom: string; expectedTo: string }> = [];
    for (const message of orderedMessages) {
      const numericMessageId = Number(message.id);
      if (Number.isSafeInteger(numericMessageId) && previousMessageId != null && numericMessageId > previousMessageId + 1) {
        gaps.push({ attemptId: attempt.attempt_id, gapKind: 'missing_message_sequence',
          expectedFrom: String(previousMessageId + 1), expectedTo: String(numericMessageId - 1) });
        events.push({
          attemptId: attempt.attempt_id, source: 'hermes_sqlite', sourceInstance: this.sourceInstance,
          streamGeneration: `session:${digest(row.id)}`, eventKind: 'error',
          sourceEventId: `message-gap:${previousMessageId + 1}:${numericMessageId - 1}`,
          sourceSequence: numericMessageId, sourceOccurredAt: rowTimestamp(message),
          payload: { reason: 'hermes_message_sequence_gap', expectedFrom: previousMessageId + 1,
            expectedTo: numericMessageId - 1, rawPayloadRetained: false },
          redactionPolicyVersion: REDACTION_POLICY_VERSION,
          idempotencyKey: `hermes:${this.sourceInstance}:${digest(row.id)}:gap:${previousMessageId + 1}:${numericMessageId - 1}`,
        });
      }
      if (Number.isSafeInteger(numericMessageId)) previousMessageId = numericMessageId;
      const messageKey = `${digest(row.id)}:${message.id}`;
      const occurredAt = rowTimestamp(message);
      const toolCalls = parseToolCalls(message.tool_calls);
      if (toolCalls.error) {
        events.push({
          attemptId: attempt.attempt_id,
          source: 'hermes_sqlite',
          sourceInstance: this.sourceInstance,
          streamGeneration: `session:${digest(row.id)}`,
          eventKind: 'error',
          sourceEventId: `message:${message.id}:tool-call-quarantine`,
          sourceSequence: message.id,
          sourceOccurredAt: occurredAt,
          payload: {
            reason: 'hermes_tool_call_quarantined',
            errorClass: toolCalls.error,
            rawPayloadRetained: false,
          },
          redactionPolicyVersion: REDACTION_POLICY_VERSION,
          idempotencyKey: `hermes:${this.sourceInstance}:${messageKey}:tool-call-quarantine`,
        });
      }
      for (const [index, call] of toolCalls.calls.entries()) {
        events.push({
          attemptId: attempt.attempt_id,
          source: 'hermes_sqlite',
          sourceInstance: this.sourceInstance,
          streamGeneration: `session:${digest(row.id)}`,
          eventKind: 'tool_call',
          sourceEventId: `message:${message.id}:tool:${call.id}`,
          sourceSequence: `${message.id}.${String(index + 1).padStart(6, '0')}`,
          sourceOccurredAt: occurredAt,
          correlationId: call.id,
          payload: { role: 'assistant', toolName: call.name, arguments: { redacted: true } },
          redactionPolicyVersion: REDACTION_POLICY_VERSION,
          idempotencyKey: `hermes:${this.sourceInstance}:${messageKey}:tool-call:${digest(call.id)}`,
        });
      }

      if (message.role === 'tool') {
        const callId = message.tool_call_id || `message-${message.id}`;
        const toolName = message.tool_name || 'unknown';
        if (!isSafeToolMetadata(callId, 256) || !isSafeToolMetadata(toolName, 160)) {
          events.push({
            attemptId: attempt.attempt_id,
            source: 'hermes_sqlite',
            sourceInstance: this.sourceInstance,
            streamGeneration: `session:${digest(row.id)}`,
            eventKind: 'error',
            sourceEventId: `message:${message.id}:tool-result-quarantine`,
            sourceSequence: message.id,
            sourceOccurredAt: occurredAt,
            payload: {
              reason: 'hermes_tool_result_quarantined',
              errorClass: 'unsafe_metadata',
              rawPayloadRetained: false,
            },
            redactionPolicyVersion: REDACTION_POLICY_VERSION,
            idempotencyKey: `hermes:${this.sourceInstance}:${messageKey}:tool-result-quarantine`,
          });
          continue;
        }
        events.push({
          attemptId: attempt.attempt_id,
          source: 'hermes_sqlite',
          sourceInstance: this.sourceInstance,
          streamGeneration: `session:${digest(row.id)}`,
          eventKind: message.finish_reason === 'error' ? 'error' : 'tool_result',
          sourceEventId: `message:${message.id}:tool-result`,
          sourceSequence: message.id,
          sourceOccurredAt: occurredAt,
          correlationId: callId,
          payload: {
            role: 'tool',
            toolName,
            result: { redacted: true },
          },
          redactionPolicyVersion: REDACTION_POLICY_VERSION,
          idempotencyKey: `hermes:${this.sourceInstance}:${messageKey}:tool-result`,
        });
        continue;
      }

      if (message.content?.trim()) {
        const content = redactHermesText(message.content);
        if (hasUnsafeCredentialShape(content)) {
          events.push({
            attemptId: attempt.attempt_id,
            source: 'hermes_sqlite',
            sourceInstance: this.sourceInstance,
            streamGeneration: `session:${digest(row.id)}`,
            eventKind: 'error',
            sourceEventId: `message:${message.id}:content-quarantine`,
            sourceSequence: message.id,
            sourceOccurredAt: occurredAt,
            payload: {
              role: message.role || 'assistant',
              reason: 'hermes_message_content_quarantined',
              rawPayloadRetained: false,
            },
            redactionPolicyVersion: REDACTION_POLICY_VERSION,
            idempotencyKey: `hermes:${this.sourceInstance}:${messageKey}:content-quarantine`,
          });
          continue;
        }
        events.push({
          attemptId: attempt.attempt_id,
          source: 'hermes_sqlite',
          sourceInstance: this.sourceInstance,
          streamGeneration: `session:${digest(row.id)}`,
          eventKind: 'message',
          sourceEventId: `message:${message.id}:content`,
          sourceSequence: message.id,
          sourceOccurredAt: occurredAt,
          payload: {
            role: message.role || 'assistant',
            content,
            ...(message.token_count == null ? {} : { outputTokens: Number(message.token_count) || 0 }),
          },
          redactionPolicyVersion: REDACTION_POLICY_VERSION,
          idempotencyKey: `hermes:${this.sourceInstance}:${messageKey}:content`,
        });
      }
    }

    if (this.repository.commitIngestionBatch) {
      const cursorPosition = orderedMessages.length
        ? String(Math.max(...orderedMessages.map(message => Number(message.id)))) : '0';
      const committed = await this.repository.commitIngestionBatch({
        source: 'hermes_sqlite', sourceInstance: this.sourceInstance,
        streamGeneration: `session:${digest(row.id)}`,
        cursorPosition, cursorValue: `message:${cursorPosition}`,
        sourceChecksum: digest(JSON.stringify(events.filter(event => event.eventKind !== 'lifecycle')
          .map(event => ({ key: event.idempotencyKey, payload: event.payload })))),
        events, gaps,
      });
      await this.repository.recordAdapterHealth?.({
        source: 'hermes_sqlite', sourceInstance: this.sourceInstance, adapterVersion: ADAPTER_VERSION,
        status: state.availability === 'available' ? 'healthy' : 'degraded', reasonCode: state.reason,
        lastSourceAt: observedAt, succeeded: true, checkedAt: now,
        safeDetails: { messagesScanned: orderedMessages.length, eventsInserted: committed.insertedEvents,
          eventsReplayed: committed.replayedEvents, gapsObserved: gaps.length },
      });
      return { attemptId: attempt.attempt_id, insertedEvents: committed.insertedEvents,
        replayedEvents: committed.replayedEvents, lifecycle: state.lifecycle,
        availability: state.availability, freshness: state.freshness };
    }

    let insertedEvents = 0;
    for (const event of events) {
      const result = await this.repository.appendEvent(event);
      if (result.inserted) insertedEvents += 1;
    }
    return {
      attemptId: attempt.attempt_id,
      insertedEvents,
      replayedEvents: events.length - insertedEvents,
      lifecycle: state.lifecycle,
      availability: state.availability,
      freshness: state.freshness,
    };
  }
}

export const hermesCanonicalAdapter = new HermesCanonicalAdapter();
