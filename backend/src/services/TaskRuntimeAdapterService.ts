import { readFile } from 'fs/promises';
import { getHermesSessionRuntimeState } from './HermesRuntime';
import type { HermesSessionRuntimeState } from './HermesRuntime';
import type { OpenClawSessionEntry } from './openclawState';

export type NormalizedRuntimeState = 'running' | 'idle' | 'stale' | 'failed' | 'completed' | 'none';

export interface NormalizedRuntimeEvidence {
  harness: 'hermes' | 'openclaw';
  state: NormalizedRuntimeState;
  sessionKey: string | null;
  messageCount: number;
  toolCallCount: number;
  lastActivityAt: string | null;
  processEvidence: { pid: number | null; alive: boolean } | null;
  errorClass: string | null;
}

const OPENCLAW_ACTIVE_WINDOW_MS = 90_000;
const OPENCLAW_STALE_WINDOW_MS = 9 * 60_000;

export function normalizeHermesRuntime(
  runtime: HermesSessionRuntimeState,
): NormalizedRuntimeEvidence {
  const state: NormalizedRuntimeState = runtime.state === 'starting'
    ? 'running'
    : runtime.state;
  return {
    harness: 'hermes',
    state,
    sessionKey: runtime.sessionKey,
    messageCount: Number(runtime.row?.message_count || 0),
    toolCallCount: Number(runtime.row?.tool_call_count || 0),
    lastActivityAt: runtime.updatedAt,
    processEvidence: runtime.pid == null ? null : { pid: runtime.pid, alive: runtime.pidAlive },
    errorClass: runtime.reason || null,
  };
}

export function normalizeOpenClawRuntime(
  sessionKey: string | null | undefined,
  session: OpenClawSessionEntry | null | undefined,
  nowMs = Date.now(),
): NormalizedRuntimeEvidence {
  if (!sessionKey || !session) {
    return {
      harness: 'openclaw', state: 'none', sessionKey: sessionKey || null,
      messageCount: 0, toolCallCount: 0, lastActivityAt: null,
      processEvidence: null, errorClass: null,
    };
  }

  const updatedAt = Number(session.updatedAt || 0);
  const ended = Boolean(session.endedAt || session.completedAt);
  const failed = Boolean(session.error || session.failed || session.aborted);
  const ageMs = updatedAt > 0 ? Math.max(0, nowMs - updatedAt) : Number.POSITIVE_INFINITY;
  let state: NormalizedRuntimeState;
  if (failed) state = 'failed';
  else if (ended) state = 'completed';
  else if (ageMs <= OPENCLAW_ACTIVE_WINDOW_MS) state = 'running';
  else if (ageMs <= OPENCLAW_STALE_WINDOW_MS) state = 'idle';
  else state = 'stale';

  return {
    harness: 'openclaw',
    state,
    sessionKey,
    messageCount: Number(session.messageCount || session.messages || 0),
    toolCallCount: Number(session.toolCallCount || session.toolCalls || 0),
    lastActivityAt: updatedAt > 0 ? new Date(updatedAt).toISOString() : null,
    processEvidence: null,
    errorClass: failed ? String(session.errorClass || 'OPENCLAW_SESSION_FAILED') : null,
  };
}

export class TaskRuntimeAdapterService {
  constructor(
    private readonly openClawSessionsPath = process.env.OPENCLAW_SESSIONS_PATH
      || process.env.CLAWDBOT_SESSIONS_PATH
      || '/clawdbot/sessions/sessions.json',
    private readonly hermesReader = getHermesSessionRuntimeState,
  ) {}

  async inspect(
    harness: 'hermes' | 'openclaw',
    sessionKey: string | null | undefined,
    pid?: number | null,
  ): Promise<NormalizedRuntimeEvidence> {
    if (harness === 'hermes') {
      return normalizeHermesRuntime(await this.hermesReader(sessionKey, pid));
    }

    try {
      const sessions = JSON.parse(await readFile(this.openClawSessionsPath, 'utf8')) as Record<string, OpenClawSessionEntry>;
      return normalizeOpenClawRuntime(sessionKey, sessionKey ? sessions[sessionKey] : null);
    } catch (error: any) {
      return {
        harness: 'openclaw', state: 'none', sessionKey: sessionKey || null,
        messageCount: 0, toolCallCount: 0, lastActivityAt: null,
        processEvidence: null, errorClass: error?.code || 'OPENCLAW_STATE_READ_FAILED',
      };
    }
  }
}

export const taskRuntimeAdapterService = new TaskRuntimeAdapterService();
