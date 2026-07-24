export type SessionRuntimeState = 'live' | 'starting' | 'missing' | 'ended';
export type SessionTranscriptState = 'available' | 'missing' | 'none';
export type SessionOperationsBucket = 'active' | 'degraded' | 'history';
export type SessionOperationsView = SessionOperationsBucket | 'all';

export interface SessionOperationsInput {
  status?: string | null;
  runtimeState?: SessionRuntimeState | null;
  runtimeStateReason?: string | null;
  transcriptState?: SessionTranscriptState | null;
  transcriptStateReason?: string | null;
  hasLiveState: boolean;
}

export interface SessionTokenUsageInput {
  inputTokens?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
}

export interface SessionTokenUsageSummary {
  input: number;
  output: number;
  thinking: number;
  total: number;
  source: 'canonical-session-aggregate';
}

/** Classify only from server-authored state; never guess from client-side age. */
export function getSessionOperationsBucket(input: SessionOperationsInput): SessionOperationsBucket {
  if (input.status === 'errored' || input.status === 'stuck'
    || input.runtimeState === 'missing' || input.transcriptState === 'missing') {
    return 'degraded';
  }
  if (input.hasLiveState || input.runtimeState === 'live' || input.runtimeState === 'starting') {
    return 'active';
  }
  return 'history';
}

/** Return the backend-authored operational reason with runtime failures taking precedence. */
export function getSessionOperationsReason(input: SessionOperationsInput): string | null {
  if (input.runtimeState === 'missing' || input.status === 'errored' || input.status === 'stuck') {
    return input.runtimeStateReason || 'Runtime is unavailable.';
  }
  if (input.transcriptState === 'missing') {
    return input.transcriptStateReason || 'Transcript is unavailable.';
  }
  if (input.runtimeState === 'starting' && input.runtimeStateReason) {
    return input.runtimeStateReason;
  }
  return null;
}

/** Derive one total from the three canonical, mutually exclusive aggregate counters. */
export function getSessionTokenUsage(input: SessionTokenUsageInput): SessionTokenUsageSummary {
  const normalize = (value?: number | null) => Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
  const usage = {
    input: normalize(input.inputTokens),
    output: normalize(input.outputTokens),
    thinking: normalize(input.thinkingTokens),
  };
  return {
    ...usage,
    total: usage.input + usage.output + usage.thinking,
    source: 'canonical-session-aggregate',
  };
}

export function getSessionOperationsEmptyState(view: SessionOperationsView, hasFilters: boolean): string {
  if (hasFilters) return 'No sessions match the current filters.';
  if (view === 'active') return 'No active runtimes. Check Degraded for adapters needing attention or History for completed work.';
  if (view === 'degraded') return 'No degraded sessions reported by the backend.';
  if (view === 'history') return 'No completed session history is available.';
  return 'No sessions are available.';
}

export interface SessionEmptyStateInput {
  runtimeState?: SessionRuntimeState | null;
  runtimeStateReason?: string | null;
  transcriptState?: SessionTranscriptState | null;
  transcriptStateReason?: string | null;
  messageCount: number;
  transcriptUnavailable: boolean;
  isActive: boolean;
  isLive: boolean;
}

export function getSessionMessagesEmptyState(input: SessionEmptyStateInput): string {
  if (input.transcriptUnavailable || input.transcriptState === 'missing') {
    return input.transcriptStateReason || 'Transcript unavailable';
  }

  if (input.isActive && input.isLive) {
    if (input.runtimeState === 'missing') {
      return input.runtimeStateReason || 'Runtime missing';
    }
    if (input.messageCount > 0) {
      return 'Loading transcript…';
    }
    if (input.runtimeState === 'starting') {
      return 'Session is starting…';
    }
    return 'No messages yet';
  }

  if (input.messageCount > 0) {
    return input.transcriptStateReason || 'Transcript unavailable';
  }

  return 'No messages recorded';
}