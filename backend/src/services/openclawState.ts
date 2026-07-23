/**
 * Helpers for locating OpenClaw's live session state across store formats.
 *
 * OpenClaw 2026.6.11 renamed the primary session key in sessions.json from
 * `agent:<agentId>:main` to `agent:<agentId>:explicit:main` and stopped
 * updating the legacy entries — they stay frozen at their pre-upgrade values
 * (stale model, stale updatedAt). The new entries also drop the cumulative
 * token counters and instead carry a split `modelProvider` + `model` pair
 * plus a `contextBudgetStatus` snapshot with the actual context-window fill.
 */

export interface OpenClawSessionEntry {
  sessionId?: string;
  model?: string | null;
  modelProvider?: string | null;
  updatedAt?: number;
  contextTokens?: number;
  totalTokens?: number;
  contextBudgetStatus?: {
    estimatedPromptTokens?: number;
    contextTokenBudget?: number;
  } | null;
  [key: string]: unknown;
}

export interface MainSessionEntry {
  key: string;
  session: OpenClawSessionEntry;
}

export interface ContextUsage {
  used: number;
  max: number;
  percent: number;
}

const EXPLICIT_MAIN_KEY_RE = /^agent:([^:]+):explicit:main$/;

/** True for the 2026.6.11+ primary session key form `agent:<id>:explicit:main`. */
export function isExplicitMainSessionKey(key: string): boolean {
  return EXPLICIT_MAIN_KEY_RE.test(key);
}

/** True for the pre-2026.6.11 primary session key form (`agent:<id>:main` etc.). */
export function isLegacyMainSessionKey(key: string): boolean {
  return key.includes('main:main') && !key.includes('subagent');
}

/**
 * Find the primary ("main") session entry in a sessions.json map.
 * Prefers the 2026.6.11+ `agent:<id>:explicit:main` key — the legacy
 * `agent:<id>:main` entry is frozen after that upgrade — and falls back
 * to the legacy key for older OpenClaw versions.
 */
export function findMainSessionEntry(
  sessions: Record<string, OpenClawSessionEntry>
): MainSessionEntry | null {
  const explicitEntries = Object.entries(sessions).filter(
    ([key]) => EXPLICIT_MAIN_KEY_RE.test(key)
  );
  if (explicitEntries.length > 0) {
    // Prefer the "main" agent, then the most recently updated entry
    explicitEntries.sort(([aKey, a], [bKey, b]) => {
      const aIsMainAgent = aKey === 'agent:main:explicit:main' ? 1 : 0;
      const bIsMainAgent = bKey === 'agent:main:explicit:main' ? 1 : 0;
      if (aIsMainAgent !== bIsMainAgent) return bIsMainAgent - aIsMainAgent;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    const [key, session] = explicitEntries[0];
    return { key, session };
  }

  // Legacy (< 2026.6.11): agent:main:main
  const legacyEntry = Object.entries(sessions).find(
    ([key]) => isLegacyMainSessionKey(key)
  );
  if (legacyEntry) {
    return { key: legacyEntry[0], session: legacyEntry[1] };
  }
  return null;
}

/**
 * Resolve the fully-qualified model id for a session entry.
 * 2026.6.11 splits the provider out of `model` (e.g. modelProvider "litellm"
 * + model "gemini/gemini-3-flash-preview"); older entries carry the full id
 * in `model`. Returns null when the entry has no model so the caller can
 * fall back to the configured default.
 */
export function resolveSessionModel(session: OpenClawSessionEntry): string | null {
  const model = typeof session.model === 'string' && session.model ? session.model : null;
  if (!model) return null;
  const provider = typeof session.modelProvider === 'string' ? session.modelProvider : '';
  if (provider && !model.startsWith(`${provider}/`)) {
    return `${provider}/${model}`;
  }
  return model;
}

/**
 * Compute context-window usage for a session entry.
 * Prefers the 2026.6.11 `contextBudgetStatus` snapshot (real window fill);
 * falls back to the legacy cumulative totalTokens estimate.
 */
export function resolveContextUsage(session: OpenClawSessionEntry): ContextUsage {
  const budget = session.contextBudgetStatus;
  if (budget && Number.isFinite(budget.estimatedPromptTokens)) {
    const used = Number(budget.estimatedPromptTokens);
    const max = Number(budget.contextTokenBudget) || session.contextTokens || 200000;
    const percent = max > 0 ? Math.min(Math.round((used / max) * 100), 100) : 0;
    return { used, max, percent };
  }

  // Legacy: totalTokens is cumulative across the entire session, NOT the
  // current context window fill. Use modulo to estimate post-compaction
  // usage when totalTokens exceeds the window.
  const contextTokens = session.contextTokens || 200000;
  const totalTokens = session.totalTokens || 0;
  const used = totalTokens > contextTokens
    ? totalTokens % contextTokens || contextTokens
    : totalTokens;
  const percent = contextTokens > 0
    ? Math.min(Math.round((used / contextTokens) * 100), 100)
    : 0;
  return { used, max: contextTokens, percent };
}
