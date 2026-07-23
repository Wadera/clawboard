import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  CanonicalSessionRepository,
  canonicalSessionRepository,
} from './CanonicalSessionRepository';
import { redactHermesText } from './HermesCanonicalAdapter';
import type { SessionsJsonEntry } from './SessionIngester';
import type { CanonicalAliasInput, CanonicalEventInput } from '../types/CanonicalSession';

const ADAPTER_NAME = 'openclaw-jsonl';
const ADAPTER_VERSION = '1.0.0';
const REDACTION_POLICY_VERSION = 'openclaw-v1';

export interface OpenClawTranscriptEntry {
  id?: string;
  type?: string;
  timestamp?: string | number;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    tool_call_id?: string;
    toolName?: string;
    tool_name?: string;
    usage?: Record<string, unknown>;
    stopReason?: string;
    finish_reason?: string;
  };
  [key: string]: unknown;
}

export interface OpenClawIngestResult {
  attemptId: string;
  insertedEvents: number;
  replayedEvents: number;
  lifecycle: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  availability: 'available' | 'unavailable';
  freshness: 'fresh' | 'expired' | 'not_applicable';
}

interface OpenClawCanonicalRepository {
  resolveOrCreateAttempt: CanonicalSessionRepository['resolveOrCreateAttempt'];
  appendEvent: CanonicalSessionRepository['appendEvent'];
  commitIngestionBatch?: CanonicalSessionRepository['commitIngestionBatch'];
  recordAdapterHealth?: CanonicalSessionRepository['recordAdapterHealth'];
  linkAttemptContextForSessionKeys?: CanonicalSessionRepository['linkAttemptContextForSessionKeys'];
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function unsafeCredentialShape(value: string): boolean {
  return /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i.test(value)
    || /\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credential|cookie|password|passwd|secret)\b\s*(?::|=|\s)\s*(?!\[REDACTED(?:_[A-Z_]+)?\])/i.test(value)
    || /\bBearer\s+(?!\[REDACTED\])\S+/i.test(value)
    || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)
    || /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/i.test(value)
    || /[?&](?:access_token|api_key|key|token|secret|signature)=(?!\[REDACTED\])[^&#\s]*/i.test(value);
}

function safeMetadata(value: unknown, fallback: string, maxLength: number): string | null {
  const text = typeof value === 'string' && value ? value : fallback;
  if (!text || text.length > maxLength || !/^[A-Za-z0-9_.:-]+$/.test(text)) return null;
  const redacted = redactHermesText(text);
  return redacted === text && !unsafeCredentialShape(text) ? text : null;
}

function occurredAt(entry: OpenClawTranscriptEntry): Date {
  if (typeof entry.timestamp === 'number') {
    return new Date(entry.timestamp < 10_000_000_000 ? entry.timestamp * 1000 : entry.timestamp);
  }
  if (typeof entry.timestamp === 'string') {
    const parsed = new Date(entry.timestamp);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(0);
}

function lifecycleFor(
  session: SessionsJsonEntry,
  lockActive: boolean,
): Pick<OpenClawIngestResult, 'lifecycle' | 'availability' | 'freshness'> & { reason: string } {
  const status = String(session.status || '').toLowerCase();
  if (['completed', 'complete', 'finished', 'success'].includes(status)) {
    return { lifecycle: 'completed', availability: 'available', freshness: 'not_applicable', reason: 'openclaw_terminal_completed' };
  }
  if (['failed', 'error'].includes(status)) {
    return { lifecycle: 'failed', availability: 'available', freshness: 'not_applicable', reason: 'openclaw_terminal_failed' };
  }
  if (['cancelled', 'canceled', 'aborted'].includes(status)) {
    return { lifecycle: 'cancelled', availability: 'available', freshness: 'not_applicable', reason: 'openclaw_terminal_cancelled' };
  }
  if (lockActive) {
    return { lifecycle: 'running', availability: 'available', freshness: 'fresh', reason: 'openclaw_transcript_lock_active' };
  }
  return { lifecycle: 'unknown', availability: 'unavailable', freshness: 'expired', reason: 'openclaw_no_live_or_terminal_evidence' };
}

function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter(block => block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string')
    .map(block => (block as any).text as string);
}

function toolCallBlocks(content: unknown): any[] {
  if (!Array.isArray(content)) return [];
  return content.filter(block => block && typeof block === 'object' && ['toolCall', 'tool_call'].includes((block as any).type));
}

export class OpenClawCanonicalAdapter {
  constructor(
    private readonly repository: OpenClawCanonicalRepository = canonicalSessionRepository,
    private readonly sourceInstance = process.env.OPENCLAW_CANONICAL_SOURCE_INSTANCE || 'openclaw-gateway/default',
  ) {}

  async ingestSessionFile(
    sessionKey: string,
    session: SessionsJsonEntry,
    transcriptsDir: string,
    now = new Date(),
  ): Promise<OpenClawIngestResult> {
    if (!session.sessionId) throw new Error('OpenClaw registry entry is missing sessionId');
    const transcriptPath = session.sessionFile || path.join(transcriptsDir, `${session.sessionId}.jsonl`);
    const lockPath = `${transcriptPath}.lock`;
    const [raw, lockActive] = await Promise.all([
      fs.readFile(transcriptPath, 'utf8'),
      fs.access(lockPath).then(() => true).catch(() => false),
    ]).catch(async error => {
      await this.repository.recordAdapterHealth?.({
        source: 'openclaw_jsonl', sourceInstance: this.sourceInstance, adapterVersion: ADAPTER_VERSION,
        status: 'unavailable', reasonCode: 'openclaw_source_read_failed', succeeded: false, checkedAt: now,
        safeDetails: { sourceReadFailed: true },
      });
      throw error;
    });
    const entries: OpenClawTranscriptEntry[] = [];
    const lines = raw.split(/\r?\n/);
    for (const [lineIndex, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') entries.push(parsed);
      } catch {
        entries.push({ id: `malformed-line-${lineIndex + 1}`, type: '__parse_error' });
      }
    }
    return this.ingestSnapshot(sessionKey, session, entries, lockActive, now, lines.length);
  }

  async ingestSnapshot(
    sessionKey: string,
    session: SessionsJsonEntry,
    entries: OpenClawTranscriptEntry[],
    lockActive: boolean,
    now = new Date(),
    sourceCursorPosition = entries.length,
  ): Promise<OpenClawIngestResult> {
    if (!sessionKey || !session.sessionId) throw new Error('OpenClaw canonical identity requires session key and sessionId');
    const observedAt = session.updatedAt ? new Date(session.updatedAt) : now;
    const aliases: CanonicalAliasInput[] = [
      {
        source: 'openclaw_registry', sourceInstance: this.sourceInstance, kind: 'session_key', value: sessionKey,
        authority: 'source_authoritative', evidenceRef: `openclaw:session-key:${digest(sessionKey)}`, observedAt,
      },
      {
        source: 'openclaw_registry', sourceInstance: this.sourceInstance, kind: 'runtime_session_id', value: session.sessionId,
        authority: 'source_reported', evidenceRef: `openclaw:session-id:${digest(session.sessionId)}`, observedAt,
      },
    ];
    const identityDigest = digest(JSON.stringify(aliases.map(alias => ({
      source: alias.source, sourceInstance: alias.sourceInstance, kind: alias.kind,
      valueHash: digest(alias.value), normalizationVersion: alias.normalizationVersion ?? 1,
    }))));
    const attempt = await this.repository.resolveOrCreateAttempt({
      harness: 'openclaw', runtimeKind: 'openclaw_gateway', identityConfidence: 'authoritative',
      identityReason: 'authoritative_registry_key', adapter: ADAPTER_NAME, adapterVersion: ADAPTER_VERSION,
      idempotencyKey: `openclaw-identity:${this.sourceInstance}:${identityDigest}`, observedAt, aliases,
    });
    await this.repository.linkAttemptContextForSessionKeys?.(
      attempt.attempt_id,
      [sessionKey, session.sessionId],
      observedAt,
    );

    const state = lifecycleFor(session, lockActive);
    const events: CanonicalEventInput[] = [{
      attemptId: attempt.attempt_id, source: 'openclaw_registry', sourceInstance: this.sourceInstance,
      streamGeneration: `session:${digest(session.sessionId)}`, eventKind: 'lifecycle',
      sourceEventId: `state:${state.lifecycle}:${session.updatedAt || 0}`, sourceOccurredAt: observedAt,
      payload: { ...state, source: 'openclaw_registry' }, redactionPolicyVersion: REDACTION_POLICY_VERSION,
      idempotencyKey: `openclaw:${this.sourceInstance}:${digest(session.sessionId)}:lifecycle:${state.lifecycle}:${session.updatedAt || 0}`,
    }];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const nativeId = safeMetadata(entry.id, '', 256);
      if (!nativeId) {
        events.push({
          attemptId: attempt.attempt_id, source: 'openclaw_jsonl', sourceInstance: this.sourceInstance,
          streamGeneration: `session:${digest(session.sessionId)}`, eventKind: 'error',
          sourceEventId: `line:${index + 1}:identity-quarantine`, sourceSequence: index + 1,
          sourceOccurredAt: occurredAt(entry), payload: { reason: 'openclaw_entry_identity_quarantined', rawPayloadRetained: false },
          redactionPolicyVersion: REDACTION_POLICY_VERSION,
          idempotencyKey: `openclaw:${this.sourceInstance}:${digest(session.sessionId)}:line:${index + 1}:identity-quarantine`,
        });
        continue;
      }
      const base = `openclaw:${this.sourceInstance}:${digest(session.sessionId)}:${digest(nativeId)}`;
      const eventBase = {
        attemptId: attempt.attempt_id, source: 'openclaw_jsonl', sourceInstance: this.sourceInstance,
        streamGeneration: `session:${digest(session.sessionId)}`, sourceOccurredAt: occurredAt(entry),
        redactionPolicyVersion: REDACTION_POLICY_VERSION,
      };
      if (entry.type === '__parse_error') {
        events.push({ ...eventBase, eventKind: 'error', sourceEventId: `entry:${nativeId}:parse-gap`,
          sourceSequence: index + 1, payload: { reason: 'openclaw_jsonl_parse_gap', rawPayloadRetained: false },
          idempotencyKey: `${base}:parse-gap` });
        continue;
      }
      const message = entry.message;
      if (!message || typeof message !== 'object') continue;
      const rawRole = typeof message.role === 'string' ? message.role : 'unknown';
      const safeRole = safeMetadata(rawRole, 'unknown', 64);
      if (!safeRole) {
        events.push({ ...eventBase, eventKind: 'error', sourceEventId: `entry:${nativeId}:role-quarantine`,
          sourceSequence: index + 1, payload: { reason: 'openclaw_message_role_quarantined', rawPayloadRetained: false },
          idempotencyKey: `${base}:role-quarantine` });
        continue;
      }
      const role = ['user', 'assistant', 'toolResult', 'tool', 'system'].includes(safeRole)
        ? safeRole
        : 'unknown';
      const isToolResult = role === 'toolResult' || role === 'tool';
      const texts = textBlocks(message.content);
      if (texts.length && !isToolResult) {
        const content = redactHermesText(texts.join('\n'));
        if (unsafeCredentialShape(content)) {
          events.push({ ...eventBase, eventKind: 'error', sourceEventId: `entry:${nativeId}:content-quarantine`,
            sourceSequence: index + 1, payload: { reason: 'openclaw_message_content_quarantined', rawPayloadRetained: false },
            idempotencyKey: `${base}:content-quarantine` });
        } else {
          events.push({ ...eventBase, eventKind: 'message', sourceEventId: `entry:${nativeId}:content`,
            sourceSequence: index + 1, payload: { role, content }, idempotencyKey: `${base}:content` });
        }
      }
      for (const [toolIndex, block] of toolCallBlocks(message.content).entries()) {
        const callId = safeMetadata(block.id || block.call_id, '', 256);
        const toolName = safeMetadata(block.name || block.toolName, 'unknown', 160);
        if (!callId || !toolName) {
          events.push({ ...eventBase, eventKind: 'error', sourceEventId: `entry:${nativeId}:tool:${toolIndex}:quarantine`,
            sourceSequence: `${index + 1}.${String(toolIndex + 1).padStart(6, '0')}`,
            payload: { reason: 'openclaw_tool_call_quarantined', rawPayloadRetained: false },
            idempotencyKey: `${base}:tool:${toolIndex}:quarantine` });
          continue;
        }
        events.push({ ...eventBase, eventKind: 'tool_call', sourceEventId: `entry:${nativeId}:tool:${callId}`,
          sourceSequence: `${index + 1}.${String(toolIndex + 1).padStart(6, '0')}`, correlationId: callId,
          payload: { role: 'assistant', toolName, arguments: { redacted: true } },
          idempotencyKey: `${base}:tool:${digest(callId)}` });
      }
      if (role === 'toolResult' || role === 'tool') {
        const callId = safeMetadata(message.toolCallId || message.tool_call_id, '', 256);
        const toolName = safeMetadata(message.toolName || message.tool_name, 'unknown', 160);
        if (!callId || !toolName) {
          events.push({ ...eventBase, eventKind: 'error', sourceEventId: `entry:${nativeId}:tool-result-quarantine`,
            sourceSequence: index + 1, payload: { reason: 'openclaw_tool_result_quarantined', rawPayloadRetained: false },
            idempotencyKey: `${base}:tool-result-quarantine` });
        } else {
          events.push({ ...eventBase, eventKind: 'tool_result', sourceEventId: `entry:${nativeId}:tool-result`,
            sourceSequence: index + 1, correlationId: callId,
            payload: { role: 'tool', toolName, result: { redacted: true } }, idempotencyKey: `${base}:tool-result` });
        }
      }
      if (message.usage && typeof message.usage === 'object') {
        const usage = message.usage;
        const numeric = (key: string): number => Number(usage[key] || 0) || 0;
        events.push({ ...eventBase, eventKind: 'usage', sourceEventId: `entry:${nativeId}:usage`, sourceSequence: index + 1,
          payload: { inputTokens: numeric('input_tokens') || numeric('input'), outputTokens: numeric('output_tokens') || numeric('output') },
          idempotencyKey: `${base}:usage` });
      }
    }

    if (this.repository.commitIngestionBatch) {
      // Registry lifecycle observations and JSONL transcript entries are
      // independent canonical streams. Persist the registry event separately;
      // the transcript cursor transaction must contain only events carrying
      // the same openclaw_jsonl stream identity as the cursor itself.
      const registryEvents = events.filter(event => event.source === 'openclaw_registry');
      const transcriptEvents = events.filter(event => event.source === 'openclaw_jsonl');
      let insertedRegistryEvents = 0;
      for (const event of registryEvents) {
        const result = await this.repository.appendEvent(event);
        if (result.inserted) insertedRegistryEvents += 1;
      }
      const committed = await this.repository.commitIngestionBatch({
        source: 'openclaw_jsonl', sourceInstance: this.sourceInstance,
        streamGeneration: `session:${digest(session.sessionId)}`,
        cursorPosition: String(sourceCursorPosition), cursorValue: `line:${sourceCursorPosition}`,
        sourceChecksum: digest(JSON.stringify(transcriptEvents
          .map(event => ({ key: event.idempotencyKey, payload: event.payload })))),
        events: transcriptEvents,
        gaps: entries.flatMap(entry => entry.type === '__parse_error'
          ? [{ attemptId: attempt.attempt_id, gapKind: 'malformed_jsonl_line',
            expectedFrom: String(entry.id).replace('malformed-line-', ''),
            expectedTo: String(entry.id).replace('malformed-line-', '') }] : []),
      });
      await this.repository.recordAdapterHealth?.({
        source: 'openclaw_jsonl', sourceInstance: this.sourceInstance, adapterVersion: ADAPTER_VERSION,
        status: state.availability === 'available' ? 'healthy' : 'degraded', reasonCode: state.reason,
        lastSourceAt: observedAt, succeeded: true, checkedAt: now,
        safeDetails: { entriesScanned: entries.length, eventsInserted: committed.insertedEvents,
          eventsReplayed: committed.replayedEvents,
          gapsObserved: entries.filter(entry => entry.type === '__parse_error').length },
      });
      return { attemptId: attempt.attempt_id,
        insertedEvents: committed.insertedEvents + insertedRegistryEvents,
        replayedEvents: committed.replayedEvents + registryEvents.length - insertedRegistryEvents,
        lifecycle: state.lifecycle,
        availability: state.availability, freshness: state.freshness };
    }

    let insertedEvents = 0;
    for (const event of events) {
      const result = await this.repository.appendEvent(event);
      if (result.inserted) insertedEvents += 1;
    }
    return { attemptId: attempt.attempt_id, insertedEvents, replayedEvents: events.length - insertedEvents,
      lifecycle: state.lifecycle, availability: state.availability, freshness: state.freshness };
  }
}

export const openClawCanonicalAdapter = new OpenClawCanonicalAdapter();
