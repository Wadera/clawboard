/**
 * Phase 4: Clean Sessions REST API
 *
 * Replaces:
 *   - /gateway/queue           → GET /sessions (with liveState overlay)
 *   - /gateway/sessions/archive → GET /sessions (already merged)
 *   - /sessions (old sessions.ts) → this file
 *
 * Endpoints:
 *   GET /sessions                        — list sessions with filters
 *   GET /sessions/stats                  — aggregate statistics
 *   GET /sessions/:key                   — single session + live state
 *   GET /sessions/:key/transcript        — stream raw JSONL
 *   GET /sessions/:key/messages          — parsed messages (on-the-fly from JSONL)
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import readline from 'readline';
import { pool } from '../db/connection';
import { buildDiscordThreadUrl } from '../utils/discordLinks';
import { GatewayConnector, getSessionKeyAliases } from '../services/GatewayConnector';
import { taskManagerDB as taskManager } from '../services/TaskManagerDB';
import { projectService } from '../services/ProjectService';
import { createTaskExecutor } from '../services/TaskExecutors';
import {
  HermesMessageStateRow,
  HermesSessionStateRow,
  extractHermesSessionId,
  hermesSessionKeyFor,
  hermesTimestampToIso,
  inferHermesSessionState,
  listHermesMessages,
  listHermesSessionStateRows,
  normalizeHermesSource,
  getHermesSessionStateRow,
  parseHermesMessageRows,
  translateHostPathToRuntime,
} from '../services/HermesRuntime';
import { buildSteeringMessage, getSteeringAttachmentConfig, materializeSteeringAttachments } from '../services/SteeringAttachmentService';
import { cleanupAttachments } from '../services/AttachmentWriter';
import {
  deriveSessionHarness,
  deriveSessionType,
  getHarnessBadgeLabel,
  getSessionDisplayLabel,
  getSessionTypeBadgeLabel,
} from '../utils/sessionTaxonomy';
import { resolveRuntimeAvailability, resolveTranscriptAvailability } from '../utils/sessionAvailability';
import { agentTypeStampAliases, taskAgentTypeSubquery } from '../services/SessionIngester';
import { agentHistoryService } from '../services/AgentHistoryService';
import { sessionMessageRepository } from '../services/SessionMessageRepository';
import type { NewSessionMessage } from '../types/SessionMessage';
import { canonicalSessionRepository } from '../services/CanonicalSessionRepository';

const router = Router();

export async function getPipelineHealth(_req: Request, res: Response): Promise<void> {
  try {
    const adapters = await canonicalSessionRepository.listAdapterHealth();
    const degraded = adapters.some(adapter => adapter.status !== 'healthy');
    res.json({
      success: true,
      status: adapters.length === 0 ? 'unknown' : (degraded ? 'degraded' : 'healthy'),
      adapters,
    });
  } catch (error) {
    console.error('Failed to read canonical session pipeline health:', error);
    res.status(503).json({ success: false, status: 'unavailable', error: 'pipeline_health_unavailable' });
  }
}

router.get('/pipeline-health', getPipelineHealth);

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────

const TRANSCRIPTS_DIR =
  process.env.OPENCLAW_TRANSCRIPTS_DIR ||
  process.env.CLAWDBOT_TRANSCRIPTS_DIR ||
  '/clawdbot/sessions';

const SESSIONS_JSON_PATH =
  process.env.OPENCLAW_SESSIONS_PATH ||
  process.env.CLAWDBOT_SESSIONS_PATH ||
  '/clawdbot/sessions/sessions.json';

const HERMES_STATE_DB_PATH = process.env.HERMES_STATE_DB_PATH || '/home/hermes/.hermes/state.db';
const HERMES_READ_STATE_DB_PATH = process.env.HERMES_READ_STATE_DB_PATH || HERMES_STATE_DB_PATH;

function formatTokensCompact(n: number): string {
  if (!n || !isFinite(n)) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function estimateContextWindow(model?: string | null): number | null {
  if (!model) return null;
  const value = model.toLowerCase();
  if (value.includes('gemini')) return 1_000_000;
  if (value.includes('gpt-5') || value.includes('gpt-4.1') || value.includes('o3') || value.includes('o4') || value.includes('codex')) return 400_000;
  if (value.includes('claude') || value.includes('opus') || value.includes('sonnet') || value.includes('haiku')) return 200_000;
  if (value.includes('phi')) return 128_000;
  return null;
}

function getContextLevel(percent: number | null, mode: 'runtime' | 'runtime-stale' | 'heuristic' | 'unavailable'): 'calm' | 'hint' | 'caution' | 'warning' | 'muted' {
  if (mode === 'unavailable' || percent == null) return 'muted';
  if (mode === 'runtime-stale') return percent >= 85 ? 'warning' : percent >= 60 ? 'caution' : 'hint';
  if (percent >= 90) return 'warning';
  if (percent >= 70) return 'caution';
  if (percent >= 35) return 'hint';
  return 'calm';
}

let openClawSessionSnapshotCache: {
  mtimeMs: number;
  loadedAt: number;
  raw: Record<string, any>;
} | null = null;

function readOpenClawSessionsSnapshotFile(): Record<string, any> | null {
  try {
    if (!fs.existsSync(SESSIONS_JSON_PATH)) return null;
    const stat = fs.statSync(SESSIONS_JSON_PATH);
    if (
      openClawSessionSnapshotCache
      && openClawSessionSnapshotCache.mtimeMs === stat.mtimeMs
      && (Date.now() - openClawSessionSnapshotCache.loadedAt) < 5000
    ) {
      return openClawSessionSnapshotCache.raw;
    }

    const raw = JSON.parse(fs.readFileSync(SESSIONS_JSON_PATH, 'utf8'));
    const normalized = raw && typeof raw === 'object' ? raw : {};
    openClawSessionSnapshotCache = {
      mtimeMs: stat.mtimeMs,
      loadedAt: Date.now(),
      raw: normalized,
    };
    return normalized;
  } catch {
    return null;
  }
}

function readOpenClawSessionSnapshot(sessionKey: string): any | null {
  try {
    const raw = readOpenClawSessionsSnapshotFile();
    if (!raw) return null;
    for (const alias of getSessionKeyAliases(sessionKey)) {
      if (raw[alias] && typeof raw[alias] === 'object') return raw[alias];
    }
    return null;
  } catch {
    return null;
  }
}

function buildContextTelemetry(row: any, sessionKey: string): any {
  const snapshot = readOpenClawSessionSnapshot(sessionKey);
  const tokenTotal = Math.max(0,
    Number(row.input_tokens || 0)
    + Number(row.output_tokens || 0)
    + Number(row.thinking_tokens || 0)
  );

  if (snapshot && Number(snapshot.contextTokens || 0) > 0) {
    const maxTokens = Number(snapshot.contextTokens || 0);
    const usedTokens = Math.max(0, Number(snapshot.totalTokens || 0));
    const percent = maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 100)) : null;
    const fresh = snapshot.totalTokensFresh === true;
    const mode = fresh ? 'runtime' : 'runtime-stale';
    const detail = fresh
      ? `${formatTokensCompact(usedTokens)} currently tracked in the live OpenClaw session snapshot.`
      : `${formatTokensCompact(usedTokens)} currently tracked in the runtime snapshot, but freshness is unclear.`;
    return {
      mode,
      usedTokens,
      maxTokens,
      percent,
      fresh,
      compactionCount: Number.isFinite(Number(snapshot.compactionCount)) ? Number(snapshot.compactionCount) : null,
      memoryFlushAt: Number.isFinite(Number(snapshot.memoryFlushAt)) ? Number(snapshot.memoryFlushAt) : null,
      headline: percent == null ? 'Runtime context available' : `${percent}% of ${formatTokensCompact(maxTokens)} current window`,
      detail,
      note: fresh
        ? 'Live session telemetry from the OpenClaw runtime snapshot.'
        : 'Runtime snapshot found, but freshness is unclear; treat this as potentially stale session telemetry.',
      level: getContextLevel(percent, mode),
    };
  }

  const maxTokens = estimateContextWindow(row.model || null);
  if (maxTokens && tokenTotal > 0) {
    const percent = Math.min(100, Math.round((tokenTotal / maxTokens) * 100));
    return {
      mode: 'heuristic',
      usedTokens: tokenTotal,
      maxTokens,
      percent,
      fresh: false,
      compactionCount: null,
      memoryFlushAt: null,
      headline: tokenTotal > maxTokens
        ? `Past one typical ${formatTokensCompact(maxTokens)} window`
        : `Up to ${percent}% of ${formatTokensCompact(maxTokens)}`,
      detail: tokenTotal > maxTokens
        ? `${formatTokensCompact(tokenTotal)} recorded across the session. Current live window may be lower after compaction or resets.`
        : `${formatTokensCompact(tokenTotal)} recorded so far from persisted session totals.`,
      note: 'Heuristic fallback only, based on persisted token totals plus model-family defaults — not live provider/runtime context telemetry.',
      level: getContextLevel(percent, 'heuristic'),
    };
  }

  return {
    mode: 'unavailable',
    usedTokens: tokenTotal,
    maxTokens: maxTokens || null,
    percent: null,
    fresh: false,
    compactionCount: null,
    memoryFlushAt: null,
    headline: 'Context telemetry unavailable',
    detail: 'This session does not expose a current context-window reading.',
    note: 'Showing token totals only is safer here than pretending we know the current window fill.',
    level: 'muted',
  };
}

// Open hermes rows only count as active/live while they show activity inside
// this window; older open rows are stale copies left behind by dead processes.
const HERMES_ACTIVE_WINDOW_SECONDS = 15 * 60;

export function hermesRowIsRecentlyActive(row: HermesSessionStateRow, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const lastActivity = row.last_message_at || row.started_at || 0;
  return lastActivity >= nowSeconds - HERMES_ACTIVE_WINDOW_SECONDS;
}

// Single source of truth for the status of a hermes state-db row. Used both by
// the live listing (mapHermesSessionToRow) and the pg archive upsert
// (ensureHermesSessionArchive) so the archived copy can never keep reporting a
// fabricated 'active' after the live window logic says 'completed'.
export function deriveHermesRowStatus(row: HermesSessionStateRow, nowSeconds = Math.floor(Date.now() / 1000)): 'active' | 'completed' {
  return row.ended_at || !hermesRowIsRecentlyActive(row, nowSeconds) ? 'completed' : 'active';
}

export function mapHermesSessionToRow(row: HermesSessionStateRow, options: { primarySessionId?: string | null } = {}): any {
  const source = normalizeHermesSource(row.source);
  const sessionKey = hermesSessionKeyFor(row);
  const lastActivityIso = hermesTimestampToIso(row.last_message_at || row.ended_at || row.started_at);
  const startedAtIso = hermesTimestampToIso(row.started_at);
  const endedAtIso = hermesTimestampToIso(row.ended_at);
  const rawTitle = row.title?.trim() || null;
  const isPrimarySession = row.id === options.primarySessionId;
  const title = isPrimarySession
    ? 'Main Hermes'
    : (rawTitle
        || (source === 'cli' ? `Hermes CLI ${row.id.slice(0, 8)}` : null)
        || (source === 'tool' ? `Hermes Tool ${row.id.slice(0, 8)}` : null));
  const kind = source === 'discord' ? 'discord' : 'unknown';
  const channel = source === 'unknown' ? null : source;
  return {
    session_key: sessionKey,
    session_id: row.id,
    kind,
    label: title,
    model: row.model || null,
    channel,
    status: deriveHermesRowStatus(row),
    spawn_info: {
      harness: 'hermes',
      hermes: true,
      hermesSessionId: row.id,
      source,
      messageSource: 'hermes-sqlite',
      stateDbPath: HERMES_STATE_DB_PATH,
    },
    message_count: row.message_count || 0,
    tool_call_count: row.tool_call_count || 0,
    input_tokens: row.input_tokens || 0,
    output_tokens: row.output_tokens || 0,
    thinking_tokens: row.reasoning_tokens || 0,
    total_cost_usd: row.actual_cost_usd || row.estimated_cost_usd || 0,
    started_at: startedAtIso,
    ended_at: endedAtIso,
    last_activity_at: lastActivityIso,
    _hermesLastMessageAt: row.last_message_at || null,
    transcript_path: null,
    file_size: null,
  };
}

export async function listHermesSessionRows(): Promise<any[]> {
  const rows = await listHermesSessionStateRows(HERMES_READ_STATE_DB_PATH);
  const norm = (row: HermesSessionStateRow) => normalizeHermesSource(row.source);
  const recent = (row: HermesSessionStateRow) => row.last_message_at || row.started_at || 0;
  const recentCutoff = Math.floor(Date.now() / 1000) - HERMES_ACTIVE_WINDOW_SECONDS;
  const activeRows = rows.filter((row: HermesSessionStateRow) => !row.ended_at);
  const recentActiveRows = activeRows.filter((row: HermesSessionStateRow) => recent(row) >= recentCutoff);
  const recentRows = rows.filter((row: HermesSessionStateRow) => recent(row) >= recentCutoff);
  const preferredPrimary = recentActiveRows.find((row: HermesSessionStateRow) => norm(row) === 'discord')
    || recentActiveRows.find((row: HermesSessionStateRow) => norm(row) === 'cli')
    || recentRows.find((row: HermesSessionStateRow) => norm(row) === 'discord')
    || recentRows.find((row: HermesSessionStateRow) => norm(row) === 'cli')
    || activeRows.find((row: HermesSessionStateRow) => norm(row) === 'discord')
    || activeRows.find((row: HermesSessionStateRow) => norm(row) === 'cli')
    || rows.find((row: HermesSessionStateRow) => norm(row) === 'discord')
    || rows.filter((row: HermesSessionStateRow) => norm(row) === 'cli').sort((a: HermesSessionStateRow, b: HermesSessionStateRow) => recent(b) - recent(a))[0]
    || rows[0]
    || null;
  return rows.map((row: HermesSessionStateRow) => mapHermesSessionToRow(row, {
    primarySessionId: preferredPrimary?.id || null,
  }));
}

async function findHermesSessionRow(key: string): Promise<any | null> {
  const sessionId = extractHermesSessionId(key);
  if (!sessionId) return null;
  const row = await getHermesSessionStateRow(sessionId, HERMES_READ_STATE_DB_PATH);
  return row ? mapHermesSessionToRow(row) : null;
}

async function parseHermesMessages(sessionId: string): Promise<ParsedMessage[]> {
  const rows = await listHermesMessages(sessionId, HERMES_READ_STATE_DB_PATH) as HermesMessageStateRow[];
  return parseHermesMessageRows(rows) as ParsedMessage[];
}

async function summarizeArchivedSessionMessages(sessionKey: string): Promise<{ messageCount: number; toolCallCount: number }> {
  const result = await pool.query<{ message_count: string; tool_call_count: string }>(
    `SELECT COUNT(*)::int AS message_count,
            COUNT(*) FILTER (WHERE role = 'tool')::int AS tool_call_count
       FROM session_messages
      WHERE session_key = $1`,
    [sessionKey]
  );
  return {
    messageCount: parseInt(result.rows[0]?.message_count || '0', 10) || 0,
    toolCallCount: parseInt(result.rows[0]?.tool_call_count || '0', 10) || 0,
  };
}

function mapArchivedMessages(rows: any[]): ParsedMessage[] {
  return rows.map((row) => ({
    role: row.role,
    content: row.content || '',
    timestamp: row.created_at ? new Date(row.created_at).toISOString() : null,
    ...(row.tool_name ? { toolName: row.tool_name } : {}),
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    ...(row.tokens_out ? { usage: { outputTokens: Number(row.tokens_out) || 0 } } : {}),
  }));
}

async function getArchivedMessages(sessionKey: string): Promise<ParsedMessage[]> {
  const rows = await sessionMessageRepository.getByKey(sessionKey, { limit: 50000, offset: 0, order: 'asc' });
  return mapArchivedMessages(rows);
}

async function ensureHermesSessionArchive(sessionKey: string, sessionId: string): Promise<{ messageCount: number; toolCallCount: number }> {
  const row = await getHermesSessionStateRow(sessionId, HERMES_READ_STATE_DB_PATH);
  if (!row) {
    return summarizeArchivedSessionMessages(sessionKey);
  }

  const source = normalizeHermesSource(row.source);
  const startedAt = hermesTimestampToIso(row.started_at);
  const endedAt = hermesTimestampToIso(row.ended_at);
  const lastActivityAt = hermesTimestampToIso(row.last_message_at || row.ended_at || row.started_at);
  const status = deriveHermesRowStatus(row);
  const channel = source === 'discord' || source === 'telegram' ? source : null;
  const kind = source === 'discord' ? 'discord' : 'unknown';
  const rawTitle = row.title?.trim() || null;
  const label = rawTitle || (source === 'cli' ? `Hermes ${row.id.slice(0, 8)}` : `Hermes ${row.id}`);
  const spawnInfo = {
    harness: 'hermes',
    hermes: true,
    hermesSessionId: row.id,
    source,
    messageSource: 'hermes-sqlite',
    stateDbPath: HERMES_READ_STATE_DB_PATH,
    archivedToDb: true,
  };

  // Persona analytics: hermes session rows only reach pg through this archive
  // upsert, so this is the stamp point for tasks that reference
  // hermes:<source>:<id> keys in acp_session_key/session_refs/completed_by.
  const upsert = await pool.query<{ session_id: string }>(
    `INSERT INTO sessions (
        session_key, session_id, kind, channel, label, model, status, spawn_info,
        message_count, tool_call_count, input_tokens, output_tokens, thinking_tokens, total_cost_usd,
        started_at, ended_at, last_activity_at, transcript_path, file_size,
        agent_type_id
      ) VALUES (
        $1, uuid_generate_v5(uuid_ns_url(), $2::text), $3, $4, $5, $6, $7, $8::jsonb,
        $9, $10, $11, $12, $13, $14,
        $15, $16, $17, NULL, NULL,
        ${taskAgentTypeSubquery(18)}
      )
      ON CONFLICT (session_key) DO UPDATE SET
        agent_type_id = COALESCE(sessions.agent_type_id, EXCLUDED.agent_type_id),
        kind = EXCLUDED.kind,
        channel = EXCLUDED.channel,
        label = EXCLUDED.label,
        model = EXCLUDED.model,
        status = EXCLUDED.status,
        spawn_info = EXCLUDED.spawn_info,
        message_count = EXCLUDED.message_count,
        tool_call_count = EXCLUDED.tool_call_count,
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        thinking_tokens = EXCLUDED.thinking_tokens,
        total_cost_usd = EXCLUDED.total_cost_usd,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        last_activity_at = EXCLUDED.last_activity_at,
        updated_at = NOW()
      RETURNING session_id`,
    [
      sessionKey,
      sessionKey,
      kind,
      channel,
      label,
      row.model || null,
      status,
      JSON.stringify(spawnInfo),
      row.message_count || 0,
      row.tool_call_count || 0,
      row.input_tokens || 0,
      row.output_tokens || 0,
      row.reasoning_tokens || 0,
      row.actual_cost_usd || row.estimated_cost_usd || 0,
      startedAt,
      endedAt,
      lastActivityAt,
      agentTypeStampAliases(sessionKey),
    ]
  );

  const archived = await summarizeArchivedSessionMessages(sessionKey);
  const liveRows = await listHermesMessages(sessionId, HERMES_READ_STATE_DB_PATH) as HermesMessageStateRow[];
  const parsed = parseHermesMessageRows(liveRows) as ParsedMessage[];
  if (archived.messageCount < parsed.length) {
    const dbSessionId = upsert.rows[0]?.session_id;
    if (!dbSessionId) {
      return summarizeArchivedSessionMessages(sessionKey);
    }
    const newRows: NewSessionMessage[] = parsed.slice(archived.messageCount).map((msg, idx) => ({
      session_id: dbSessionId,
      session_key: sessionKey,
      ordinal: archived.messageCount + idx + 1,
      role: (msg.role === 'tool' ? 'tool' : msg.role === 'assistant' ? 'assistant' : msg.role === 'user' ? 'user' : 'system'),
      content: msg.content || undefined,
      tool_name: msg.toolName || undefined,
      tool_call_id: msg.toolCallId || undefined,
      thinking: undefined,
      tokens_in: undefined,
      tokens_out: msg.usage?.outputTokens || undefined,
      created_at: msg.timestamp ? new Date(msg.timestamp) : new Date(),
      metadata: undefined,
    }));
    if (newRows.length > 0) {
      await sessionMessageRepository.bulkInsert(newRows);
    }
  }

  return summarizeArchivedSessionMessages(sessionKey);
}

function sessionMatchesFilters(session: any, filters: { kind?: string; status?: string; model?: string; channel?: string; search?: string; dateFrom?: string; dateTo?: string; }) {
  const { kind, status, model, channel, search, dateFrom, dateTo } = filters;
  if (kind && session.kind !== kind) return false;
  if (status && session.status !== status) return false;
  if (model && session.model !== model) return false;
  if (channel && session.channel !== channel) return false;
  if (search) {
    const needle = search.toLowerCase();
    const hay = `${session.session_key} ${session.label || ''} ${session.model || ''} ${session.channel || ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  const activity = session.last_activity_at || session.started_at || null;
  if (dateFrom && activity && activity < new Date(dateFrom).toISOString()) return false;
  if (dateTo && activity && activity > new Date(dateTo).toISOString()) return false;
  return true;
}

function compareSessionObjects(a: any, b: any, sortBy: string, order: 'ASC' | 'DESC') {
  const pick = (obj: any) => {
    switch (sortBy) {
      case 'started_at': return obj.startedAt || obj.started_at || null;
      case 'message_count': return obj.messageCount ?? obj.message_count ?? 0;
      case 'total_cost_usd': return obj.totalCost ?? obj.total_cost_usd ?? 0;
      case 'input_tokens': return obj.inputTokens ?? obj.input_tokens ?? 0;
      case 'output_tokens': return obj.outputTokens ?? obj.output_tokens ?? 0;
      case 'last_activity_at':
      default: return obj.lastActivityAt || obj.last_activity_at || obj.startedAt || obj.started_at || null;
    }
  };
  const av = pick(a);
  const bv = pick(b);
  let cmp = 0;
  if (av == null && bv == null) cmp = 0;
  else if (av == null) cmp = 1;
  else if (bv == null) cmp = -1;
  else if (typeof av === 'number' || typeof bv === 'number') cmp = Number(av) - Number(bv);
  else cmp = String(av).localeCompare(String(bv));
  return order === 'ASC' ? cmp : -cmp;
}

// ─────────────────────────────────────────────────────────────────
// Gateway connector (injected from server.ts)
// ─────────────────────────────────────────────────────────────────

let gatewayConnector: GatewayConnector | null = null;

export function setSessionsGatewayConnector(connector: GatewayConnector): void {
  gatewayConnector = connector;
}

async function resolveTaskWorkingDirectory(task: any): Promise<string | null> {
  const fallback = translateHostPathToRuntime(process.env.HERMES_TASK_CWD || '/workspace');
  if (!task?.project) return fallback;

  try {
    const projects = await projectService.list();
    const project = projects.find((p: any) => p.name === task.project || p.id === task.project);
    const hostPath = project?.resources?.localPaths?.ssdBuild || project?.source_dir || null;
    return translateHostPathToRuntime(hostPath) || fallback;
  } catch {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

/** Build a liveState overlay object from the connector. */
function buildLiveStateOverlay(sessionKey: string, lastActivityAt?: Date | null) {
  if (!gatewayConnector) return null;

  let live: any = null;
  for (const alias of getSessionKeyAliases(sessionKey)) {
    const candidate = gatewayConnector.getLiveStates().get(alias);
    if (candidate) {
      live = candidate;
      break;
    }
  }

  if (live) {
    return {
      state: live.state,
      recentTools: live.tools,
      lastActivity: live.lastActivity,
      isGenerating: live.state !== 'idle',
    };
  }
  // Main session is always implicitly "live" (it's the persistent session)
  // — ensures it sorts at the top of the sessions list even when idle
  if (sessionKey.endsWith(':main') || sessionKey === 'agent:main:main') {
    return {
      state: 'idle' as const,
      recentTools: [],
      lastActivity: lastActivityAt ? lastActivityAt.getTime() : Date.now(),
      isGenerating: false,
    };
  }
  return null;
}


// Session rows reach us with mixed timestamp encodings: hermes sqlite rows use
// epoch seconds, pg rows surface JS Dates, and mapped rows carry ISO strings.
// Normalize them all to epoch seconds before doing seconds-based state math.
export function toHermesEpochSeconds(value: string | number | Date | null | undefined): number | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Anything this large is epoch milliseconds (e.g. Date-derived), not seconds.
    return value >= 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const parsedMs = Date.parse(String(value));
  return Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) : null;
}

export function buildReadonlyHermesLiveState(row: any): { state: 'busy' | 'idle'; recentTools: string[]; lastActivity: number; isGenerating: boolean } | null {
  const sessionId = extractHermesSessionId(row?.session_key || row?.sessionKey || null);
  if (!sessionId) return null;

  const startedAtSeconds = toHermesEpochSeconds(row.started_at ?? null);
  const endedAtSeconds = toHermesEpochSeconds(row.ended_at ?? null);
  const lastMessageAtSeconds = toHermesEpochSeconds(row._hermesLastMessageAt ?? row.last_activity_at ?? null);

  const state = inferHermesSessionState({
    started_at: startedAtSeconds,
    ended_at: endedAtSeconds,
    last_message_at: lastMessageAtSeconds,
    // Both hermes-mapped rows and pg archive rows carry these counts; without
    // them inferHermesSessionState can never reach its 'running' branch and a
    // session that wrote a message seconds ago would show as merely idle.
    message_count: Number(row.message_count) || 0,
    tool_call_count: Number(row.tool_call_count) || 0,
  });

  if (state === 'completed' || state === 'failed' || state === 'none') {
    return null;
  }

  // Idle open rows without recent activity are stale leftovers, not live
  // sessions — do not fabricate a heartbeat for them. 'starting' stays live
  // because it is inside the startup grace window by definition.
  const lastActivitySeconds = lastMessageAtSeconds ?? startedAtSeconds;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (state === 'idle' && (lastActivitySeconds == null || lastActivitySeconds < nowSeconds - HERMES_ACTIVE_WINDOW_SECONDS)) {
    return null;
  }

  return {
    state: state === 'running' || state === 'starting' ? 'busy' : 'idle',
    recentTools: [],
    lastActivity: lastActivitySeconds != null ? lastActivitySeconds * 1000 : Date.now(),
    isGenerating: state === 'running' || state === 'starting',
  };
}

function mergeSessionRecords(preferred: any, candidate: any): any {
  const preferPinned = (value: any): boolean => {
    const label = String(value?.displayLabel || value?.label || '').toLowerCase();
    return label === 'main hermes' || label === 'main openclaw';
  };
  const scoreTranscript = (value: string | null | undefined): number => value === 'available' ? 3 : value === 'missing' ? 2 : value === 'none' ? 1 : 0;
  const lastActivity = (value: any): number => {
    const raw = value?.liveState?.lastActivity || value?.lastActivityAt || value?.startedAt || null;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  };

  const merged = { ...preferred };

  if (!preferred.liveState && candidate.liveState) merged.liveState = candidate.liveState;
  // The live hermes state db is authoritative for hermes session status. The
  // pg archive copy (spawnInfo.archivedToDb) sorts first in dedupe, so without
  // this a stale archived 'active' would win over the live row's 'completed'.
  const candidateIsLiveHermes = candidate?.spawnInfo?.hermes === true && candidate?.spawnInfo?.archivedToDb !== true;
  if (candidateIsLiveHermes && candidate.status && candidate.status !== merged.status) {
    merged.status = candidate.status;
    merged.endedAt = candidate.endedAt ?? merged.endedAt;
    merged.runtimeState = candidate.runtimeState;
    merged.runtimeStateReason = candidate.runtimeStateReason;
    merged.liveState = candidate.status === 'active' ? (candidate.liveState || merged.liveState) : candidate.liveState;
  }
  if (preferPinned(candidate) && !preferPinned(preferred)) {
    merged.label = candidate.label;
    merged.displayLabel = candidate.displayLabel;
  }
  if ((!merged.displayLabel || merged.displayLabel === merged.sessionKey) && candidate.displayLabel) merged.displayLabel = candidate.displayLabel;
  if ((!merged.label || merged.label === merged.sessionKey) && candidate.label) merged.label = candidate.label;
  if (scoreTranscript(candidate.transcriptState) > scoreTranscript(preferred.transcriptState)) {
    merged.transcriptState = candidate.transcriptState;
    merged.transcriptStateReason = candidate.transcriptStateReason;
    merged.transcriptPath = candidate.transcriptPath;
    merged.fileSize = candidate.fileSize;
  }
  if ((candidate.messageCount || 0) > (preferred.messageCount || 0)) merged.messageCount = candidate.messageCount;
  if ((candidate.toolCallCount || 0) > (preferred.toolCallCount || 0)) merged.toolCallCount = candidate.toolCallCount;
  if ((candidate.inputTokens || 0) > (preferred.inputTokens || 0)) merged.inputTokens = candidate.inputTokens;
  if ((candidate.outputTokens || 0) > (preferred.outputTokens || 0)) merged.outputTokens = candidate.outputTokens;
  if ((candidate.thinkingTokens || 0) > (preferred.thinkingTokens || 0)) merged.thinkingTokens = candidate.thinkingTokens;
  if ((candidate.totalCost || 0) > (preferred.totalCost || 0)) merged.totalCost = candidate.totalCost;
  if (lastActivity(candidate) > lastActivity(preferred)) merged.lastActivityAt = candidate.lastActivityAt;
  if ((!merged.runtimeState || merged.runtimeState === 'missing') && candidate.runtimeState && candidate.runtimeState !== 'missing') {
    merged.runtimeState = candidate.runtimeState;
    merged.runtimeStateReason = candidate.runtimeStateReason;
  }
  // Persona stamp lives on the pg archive copy; live hermes sqlite rows don't
  // carry it. Keep it whichever side of the dedupe pair has it.
  if (!merged.agentTypeId && candidate.agentTypeId) {
    merged.agentTypeId = candidate.agentTypeId;
    merged.agentType = candidate.agentType || null;
  }
  return merged;
}

export function dedupeSessions(sessions: any[]): any[] {
  const byKey = new Map<string, any>();
  for (const session of sessions) {
    const existing = byKey.get(session.sessionKey);
    byKey.set(session.sessionKey, existing ? mergeSessionRecords(existing, session) : session);
  }
  return Array.from(byKey.values());
}

async function summarizeArchivedSessionMessagesBatch(sessionKeys: string[]): Promise<Map<string, { messageCount: number; toolCallCount: number }>> {
  if (sessionKeys.length === 0) return new Map();
  const result = await pool.query<{ session_key: string; message_count: string; tool_call_count: string }>(
    `SELECT session_key,
            COUNT(*)::int AS message_count,
            COUNT(*) FILTER (WHERE role = 'tool')::int AS tool_call_count
       FROM session_messages
      WHERE session_key = ANY($1::text[])
      GROUP BY session_key`,
    [sessionKeys]
  );
  return new Map(result.rows.map((row) => [row.session_key, {
    messageCount: parseInt(row.message_count || '0', 10) || 0,
    toolCallCount: parseInt(row.tool_call_count || '0', 10) || 0,
  }]));
}

async function applyArchivedTranscriptAvailability<T extends { sessionKey: string; transcriptState?: string | null; transcriptStateReason?: string | null; messageCount?: number; toolCallCount?: number }>(sessions: T[]): Promise<T[]> {
  const archiveCounts = await summarizeArchivedSessionMessagesBatch(sessions.map((session) => session.sessionKey));
  return sessions.map((session) => {
    const archived = archiveCounts.get(session.sessionKey);
    if (!archived || archived.messageCount <= 0) return session;
    const transcriptState = session.transcriptState || null;
    if (transcriptState === 'available' || transcriptState === 'deleted') return {
      ...session,
      messageCount: Math.max(session.messageCount || 0, archived.messageCount),
      toolCallCount: Math.max(session.toolCallCount || 0, archived.toolCallCount),
    };
    return {
      ...session,
      transcriptState: 'available',
      transcriptStateReason: 'Archived messages are available from the session archive database.',
      messageCount: Math.max(session.messageCount || 0, archived.messageCount),
      toolCallCount: Math.max(session.toolCallCount || 0, archived.toolCallCount),
    };
  });
}

/**
 * Map a DB row to the canonical session shape.
 * Overlays live state if available.
 */
export function buildHistoricalSessionFromAgentRecord(record: any): any {
  const startedAt = record.startedAt || null;
  const endedAt = record.completedAt || null;
  const model = record.model || null;
  const sessionKind = record.sessionKey?.startsWith('hermes:') ? 'cli' : 'subagent';
  const harness = deriveSessionHarness({ sessionKey: record.sessionKey, kind: sessionKind, spawnInfo: { harness: record.sessionKey?.startsWith('hermes:') ? 'hermes' : 'openclaw' } });
  const sessionType = deriveSessionType({ sessionKey: record.sessionKey, kind: sessionKind, harness });
  const status = record.outcome === 'error' ? 'errored' : (record.completedAt ? 'completed' : 'active');
  return {
    sessionKey: record.sessionKey,
    sessionId: extractHermesSessionId(record.sessionKey) || record.sessionKey,
    kind: record.sessionKey?.startsWith('hermes:') ? 'cli' : 'subagent',
    harness,
    harnessLabel: getHarnessBadgeLabel(harness),
    sessionType,
    sessionTypeLabel: getSessionTypeBadgeLabel(sessionType),
    label: record.label || record.taskTitle || record.name || null,
    displayLabel: getSessionDisplayLabel({
      sessionKey: record.sessionKey,
      label: record.label || record.taskTitle || null,
      harness,
      sessionType,
    }),
    model,
    channel: null,
    status,
    liveState: null,
    runtimeState: 'ended',
    runtimeStateReason: 'Historical session restored from agent history; no live runtime heartbeat is expected.',
    messageCount: 0,
    toolCallCount: 0,
    inputTokens: record.tokenUsage?.input || 0,
    outputTokens: record.tokenUsage?.output || 0,
    thinkingTokens: 0,
    totalCost: 0,
    startedAt,
    endedAt,
    lastActivityAt: endedAt || startedAt,
    spawnInfo: { source: 'agent-history', historical: true },
    contextTelemetry: null,
    transcriptPath: null,
    transcriptState: 'none',
    transcriptStateReason: 'This historical session is preserved in task/agent history, but no transcript file is available in the live session store.',
    fileSize: null,
    task: null,
    steering: { supported: false, targetSessionKey: record.sessionKey, reason: 'Historical sessions cannot be steered.' },
  };
}

export function rowToSession(row: any): any {
  const spawnInfo = row.spawn_info ?? {};
  const harness = deriveSessionHarness({
    sessionKey: row.session_key,
    kind: row.kind,
    spawnInfo,
  });
  const gatewayLiveState = buildLiveStateOverlay(
    row.session_key,
    row.last_activity_at ? new Date(row.last_activity_at) : null
  );
  const liveState = gatewayLiveState || (harness === 'hermes' ? buildReadonlyHermesLiveState(row) : null);
  // A hermes-harness row claiming 'active' with no live heartbeat is a stale
  // snapshot (e.g. a pg archive copy upserted while the session was alive) —
  // report it as completed instead of resurrecting the fabricated liveness.
  const normalizedStatus = row.status === 'active' && !liveState && (row.ended_at || harness === 'hermes')
    ? 'completed'
    : row.status;
  const sessionType = deriveSessionType({
    sessionKey: row.session_key,
    kind: row.kind,
    harness,
  });
  const contextTelemetry = buildContextTelemetry(row, row.session_key);
  const transcriptAvailability = resolveTranscriptAvailability(row, TRANSCRIPTS_DIR);
  const runtimeAvailability = resolveRuntimeAvailability({
    ...row,
    status: normalizedStatus,
  }, liveState);
  return {
    sessionKey: row.session_key,
    sessionId: row.session_id ? String(row.session_id) : null,
    kind: row.kind,
    harness,
    harnessLabel: getHarnessBadgeLabel(harness),
    sessionType,
    sessionTypeLabel: getSessionTypeBadgeLabel(sessionType),
    label: row.label || null,
    displayLabel: getSessionDisplayLabel({
      sessionKey: row.session_key,
      label: row.label || null,
      harness,
      sessionType,
    }),
    model: row.model || null,
    channel: row.channel || null,
    status: normalizedStatus,
    liveState,
    runtimeState: runtimeAvailability.state,
    runtimeStateReason: runtimeAvailability.reason,
    messageCount: parseInt(row.message_count, 10) || 0,
    toolCallCount: parseInt(row.tool_call_count, 10) || 0,
    inputTokens: parseInt(row.input_tokens, 10) || 0,
    outputTokens: parseInt(row.output_tokens, 10) || 0,
    thinkingTokens: parseInt(row.thinking_tokens, 10) || 0,
    totalCost: parseFloat(row.total_cost_usd) || 0,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
    // Persona analytics: which agent type (persona) ran this session.
    // Stamped from the owning task at spawn/bind/ingest time (043 backfill).
    agentTypeId: row.agent_type_id || null,
    agentType: row.agent_type_id ? {
      id: row.agent_type_id,
      name: row.agent_type_name || null,
      slug: row.agent_type_slug || null,
      color: row.agent_type_color || null,
    } : null,
    spawnInfo,
    contextTelemetry,
    transcriptPath: transcriptAvailability.transcriptPath,
    transcriptState: transcriptAvailability.state,
    transcriptStateReason: transcriptAvailability.reason,
    fileSize: transcriptAvailability.fileSize,
    task: null,
    steering: null,
  };
}

async function loadLinkedTaskRows(): Promise<any[]> {
  const result = await pool.query(
    `SELECT t.id, t.title, t.status, t.execution_mode, t.execution_profile,
            t.model, t.thinking_budget, t.acp_session_key, t.discord_thread_id,
            t.active_agent, t.completed_by, t.session_refs, at.id AS agent_type_id, at.slug AS agent_type_slug,
            at.name AS agent_type_name, at.color AS agent_type_color, at.category AS agent_type_category,
            t.updated_at
       FROM tasks t
       LEFT JOIN agent_types at ON at.id = t.agent_type_id
      WHERE t.acp_session_key IS NOT NULL
         OR t.active_agent IS NOT NULL
         OR t.completed_by IS NOT NULL
      ORDER BY t.updated_at DESC NULLS LAST`
  );
  return result.rows;
}

function findTaskForSessionInRows(sessionKey: string, rows: any[]): LinkedTaskSummary | null {
  const runIdMatch = sessionKey.match(/:run:([0-9a-f-]{36})$/i);
  const cronIdMatch = sessionKey.match(/:cron:([0-9a-f-]{36})(?::run:[0-9a-f-]{36})?$/i);
  const labelTaskMatch = sessionKey.match(/spawn-task-([a-f0-9]{8,})/i);
  const hermesSessionId = extractHermesSessionId(sessionKey);

  const sessionKeyAliases = Array.from(new Set([
    sessionKey,
    sessionKey.startsWith('cron:') ? sessionKey.slice(5) : `cron:${sessionKey}`,
    ...(runIdMatch ? [runIdMatch[1]] : []),
    ...(cronIdMatch ? [cronIdMatch[1], `cron:${cronIdMatch[1]}`] : []),
    ...(hermesSessionId ? [
      hermesSessionId,
      `hermes:tool:${hermesSessionId}`,
      `agent:main:local:dm:${hermesSessionId}`,
      `agent:main:discord:channel:${hermesSessionId}`,
      `agent:main:telegram:dm:${hermesSessionId}`,
    ] : []),
  ]));

  const taskIdPrefix = labelTaskMatch?.[1] || null;

  for (const row of rows) {
    const activeAgent = parseActiveAgent(row.active_agent);
    const completedBy = parseActiveAgent(row.completed_by);
    const activeAgentSessionKey = activeAgent && typeof activeAgent === 'object' ? activeAgent.sessionKey : null;
    const completedBySessionKey = completedBy && typeof completedBy === 'object' ? completedBy.sessionKey : null;
    const matchedByAcp = sessionKeyAliases.includes(row.acp_session_key);
    const matchedByActiveAgent = activeAgentSessionKey ? sessionKeyAliases.includes(activeAgentSessionKey) : false;
    const matchedByCompletedBy = completedBySessionKey ? sessionKeyAliases.includes(completedBySessionKey) : false;
    const sessionRefs = Array.isArray(row.session_refs) ? row.session_refs : [];
    const matchedBySessionRefs = sessionRefs.some((ref: any) => typeof ref === 'string' && sessionKeyAliases.includes(ref));
    const matchedByTaskIdPrefix = !!(taskIdPrefix && typeof row.id === 'string' && row.id.startsWith(taskIdPrefix));

    if (!matchedByAcp && !matchedByActiveAgent && !matchedByCompletedBy && !matchedBySessionRefs && !matchedByTaskIdPrefix) continue;

    return {
      id: row.id,
      title: row.title,
      status: row.status,
      executionMode: row.execution_mode || null,
      executionProfile: row.execution_profile || null,
      model: row.model || null,
      thinking: row.thinking_budget || null,
      acpSessionKey: row.acp_session_key || null,
      discordThreadId: row.discord_thread_id || null,
      discordThreadUrl: buildDiscordThreadUrl(row.discord_thread_id || null),
      activeAgent,
      agentName: activeAgent?.name || row.agent_type_name || null,
      agentType: row.agent_type_id ? {
        id: row.agent_type_id,
        slug: row.agent_type_slug || null,
        name: row.agent_type_name || null,
        color: row.agent_type_color || null,
        category: row.agent_type_category || null,
      } : null,
      sessionMatch: matchedByAcp ? 'acpSessionKey' : matchedByActiveAgent ? 'activeAgent' : matchedByCompletedBy ? 'completedBy' : 'sessionRefs',
    };
  }

  return null;
}

async function enrichSessionsForList<T extends { sessionKey: string }>(sessions: T[]): Promise<Array<T & { task: LinkedTaskSummary | null; steering: ReturnType<typeof getSessionSteeringInfo> }>> {
  const linkedTaskRows = await loadLinkedTaskRows();
  return sessions.map((session) => {
    const task = findTaskForSessionInRows(session.sessionKey, linkedTaskRows);
    return {
      ...session,
      task,
      steering: getSessionSteeringInfo(session, task),
    };
  });
}

function isRunChildSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(':run:');
}

function resolveSteeringTargetSessionKey(session: any, linkedTask?: LinkedTaskSummary | null): string {
  if (isRunChildSessionKey(session.sessionKey) && linkedTask?.acpSessionKey) {
    return linkedTask.acpSessionKey;
  }
  return session.sessionKey;
}

function getSessionSteeringInfo(session: any, linkedTask?: LinkedTaskSummary | null) {
  const targetSessionKey = resolveSteeringTargetSessionKey(session, linkedTask);
  const targetLiveState = gatewayConnector?.getSessionState(targetSessionKey) || null;
  const effectiveLiveState = session.liveState || targetLiveState;

  if (session.harness === 'hermes') {
    const executionMode = linkedTask?.executionMode || linkedTask?.executionProfile?.mode || null;
    const hermesTargetSessionKey = linkedTask?.acpSessionKey || targetSessionKey;

    if (!linkedTask) {
      return {
        supported: false,
        reason: 'Only Hermes sessions linked to a task can be steered from the Sessions page.',
        attachmentSupport: getSteeringAttachmentConfig(),
        targetSessionKey: hermesTargetSessionKey,
      };
    }

    if (executionMode !== 'interactive') {
      return {
        supported: false,
        reason: 'Only interactive Hermes task sessions can be steered from the Sessions page.',
        attachmentSupport: getSteeringAttachmentConfig(),
        targetSessionKey: hermesTargetSessionKey,
      };
    }

    if (!['in-progress', 'review'].includes(linkedTask.status)) {
      return {
        supported: false,
        reason: 'This Hermes task is no longer in a steerable state.',
        attachmentSupport: getSteeringAttachmentConfig(),
        targetSessionKey: hermesTargetSessionKey,
      };
    }

    return {
      supported: true,
      reason: null,
      attachmentSupport: getSteeringAttachmentConfig(),
      targetSessionKey: hermesTargetSessionKey,
    };
  }

  if (isRunChildSessionKey(session.sessionKey) && (!linkedTask?.acpSessionKey || linkedTask.acpSessionKey === session.sessionKey)) {
    return {
      supported: false,
      reason: 'One-shot run child sessions cannot be steered directly. Open the parent session instead.',
      attachmentSupport: getSteeringAttachmentConfig(),
      targetSessionKey,
    };
  }

  if (session.kind === 'heartbeat') {
    return {
      supported: false,
      reason: 'Heartbeat sessions are automated and do not accept manual steering.',
      attachmentSupport: getSteeringAttachmentConfig(),
      targetSessionKey,
    };
  }

  if (!effectiveLiveState) {
    return {
      supported: false,
      reason: 'Only live sessions can be steered from the Sessions page.',
      attachmentSupport: getSteeringAttachmentConfig(),
      targetSessionKey,
    };
  }

  if (session.status === 'errored' || session.status === 'stuck') {
    return {
      supported: false,
      reason: 'This session is no longer in a steerable running state.',
      attachmentSupport: getSteeringAttachmentConfig(),
      targetSessionKey,
    };
  }

  return {
    supported: true,
    reason: null,
    attachmentSupport: getSteeringAttachmentConfig(),
    targetSessionKey,
  };
}

function isCronParentSessionKey(key: string): boolean {
  return /^agent:main:cron:[0-9a-f-]{36}$/i.test(key) || /^cron:[0-9a-f-]{36}$/i.test(key);
}

function canonicalCronParentSessionKey(key: string): string {
  return key.startsWith('cron:') ? `agent:main:cron:${key.slice(5)}` : key;
}

function isEmptyCronParentStub(row: any): boolean {
  return !!row
    && row.kind === 'cron'
    && typeof row.session_key === 'string'
    && !row.session_key.includes(':run:')
    && !row.started_at
    && Number(row.message_count || 0) === 0;
}

async function findLatestRunChildRow(parentKey: string): Promise<any | null> {
  const canonicalParentKey = canonicalCronParentSessionKey(parentKey);
  const result = await pool.query(
    `SELECT sessions.session_key, sessions.session_id, sessions.kind, sessions.label,
            sessions.model, sessions.channel, sessions.status,
            sessions.spawn_info, sessions.message_count, sessions.tool_call_count,
            sessions.input_tokens, sessions.output_tokens, sessions.thinking_tokens, sessions.total_cost_usd,
            sessions.started_at, sessions.ended_at, sessions.last_activity_at,
            sessions.transcript_path, sessions.file_size, sessions.created_at, sessions.updated_at,
            sessions.agent_type_id,
            at.name AS agent_type_name, at.slug AS agent_type_slug, at.color AS agent_type_color
       FROM sessions
       LEFT JOIN agent_types at ON at.id = sessions.agent_type_id
      WHERE sessions.session_key LIKE $1
      ORDER BY COALESCE(sessions.last_activity_at, sessions.started_at, sessions.updated_at) DESC NULLS LAST
      LIMIT 1`,
    [`${canonicalParentKey}:run:%`]
  );

  return result.rows[0] || null;
}

async function findSessionRecord(key: string): Promise<any | null> {
  const sessionSelectColumns = `
    sessions.session_key, sessions.session_id, sessions.kind, sessions.label,
    sessions.model, sessions.channel, sessions.status,
    sessions.spawn_info, sessions.message_count, sessions.tool_call_count,
    sessions.input_tokens, sessions.output_tokens, sessions.thinking_tokens, sessions.total_cost_usd,
    sessions.started_at, sessions.ended_at, sessions.last_activity_at,
    sessions.transcript_path, sessions.file_size, sessions.created_at, sessions.updated_at,
    sessions.agent_type_id,
    at.name AS agent_type_name, at.slug AS agent_type_slug, at.color AS agent_type_color`;

  let result = await pool.query(
    `SELECT ${sessionSelectColumns}
       FROM sessions
       LEFT JOIN agent_types at ON at.id = sessions.agent_type_id
      WHERE sessions.session_key = $1`,
    [key]
  );

  if (result.rows.length === 0) {
    result = await pool.query(
      `SELECT ${sessionSelectColumns}
         FROM sessions
         LEFT JOIN agent_types at ON at.id = sessions.agent_type_id
        WHERE sessions.session_id::text = $1`,
      [key]
    );
  }

  let row = result.rows[0] || null;

  if (!row) {
    row = await findHermesSessionRow(key);
  }

  if (isCronParentSessionKey(key)) {
    const runChild = await findLatestRunChildRow(key);
    if (runChild && (!row || isEmptyCronParentStub(row))) {
      row = runChild;
    }
  }

  return row;
}

interface LinkedTaskSummary {
  id: string;
  title: string;
  status: string;
  executionMode: string | null;
  executionProfile: Record<string, any> | null;
  model: string | null;
  thinking: string | null;
  acpSessionKey: string | null;
  discordThreadId: string | null;
  discordThreadUrl: string | null;
  activeAgent: any;
  agentName: string | null;
  agentType: {
    id: string;
    slug: string | null;
    name: string | null;
    color: string | null;
    category: string | null;
  } | null;
  sessionMatch: 'acpSessionKey' | 'activeAgent' | 'completedBy' | 'sessionRefs';
}

function parseActiveAgent(value: any): any {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringifyEvidence(value: any): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateEvidence(text: string, maxChars = 12000): string {
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n… truncated ${text.length - maxChars} character(s); open the raw run log on the host/container for full details.`;
}

function readTaskRunLogTail(logPath?: string | null): { content: string | null; note: string | null; lineCount: number | null } {
  if (!logPath) return { content: null, note: null, lineCount: null };
  if (!logPath.startsWith('/data/hermes-task-runs/')) {
    return { content: null, note: `Run log path is outside the allowed Hermes task-run directory: ${logPath}`, lineCount: null };
  }
  try {
    if (!fs.existsSync(logPath)) {
      return { content: null, note: `Run log path is recorded but not readable from this container: ${logPath}`, lineCount: null };
    }
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const lineCount = raw ? lines.length : 0;
    const tail = lines.slice(-180).join('\n').trim();
    if (!tail) {
      return { content: null, note: `Run log exists but is empty: ${logPath}`, lineCount };
    }
    return { content: truncateEvidence(tail), note: null, lineCount };
  } catch (err: any) {
    return { content: null, note: `Failed to read run log ${logPath}: ${err?.message || String(err)}`, lineCount: null };
  }
}

async function loadTaskEvidenceForSession(sessionKey: string, linkedTask?: LinkedTaskSummary | null): Promise<any | null> {
  const hermesSessionId = extractHermesSessionId(sessionKey);
  const aliases = Array.from(new Set([
    sessionKey,
    ...(hermesSessionId ? [hermesSessionId, `hermes:tool:${hermesSessionId}`] : []),
  ]));

  let taskRow: any | null = null;
  if (linkedTask?.id) {
    const result = await pool.query(
      `SELECT id, title, status, blocked_reason, status_reason, active_agent, completed_by,
              acp_session_key, session_refs, review_history, updated_at, created_at
         FROM tasks
        WHERE id = $1`,
      [linkedTask.id]
    );
    taskRow = result.rows[0] || null;
  }

  if (!taskRow) {
    const result = await pool.query(
      `SELECT id, title, status, blocked_reason, status_reason, active_agent, completed_by,
              acp_session_key, session_refs, review_history, updated_at, created_at
         FROM tasks
        WHERE acp_session_key = ANY($1::text[])
           OR (active_agent IS NOT NULL AND (CASE WHEN active_agent::text ~ '^\\s*\\{' THEN active_agent::jsonb ELSE NULL END)->>'sessionKey' = ANY($1::text[]))
           OR (completed_by IS NOT NULL AND (CASE WHEN completed_by::text ~ '^\\s*\\{' THEN completed_by::jsonb ELSE NULL END)->>'sessionKey' = ANY($1::text[]))
           OR session_refs ?| $1::text[]
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`,
      [aliases]
    );
    taskRow = result.rows[0] || null;
  }

  if (!taskRow) return null;
  const activeAgent = parseActiveAgent(taskRow.active_agent);
  const completedBy = parseActiveAgent(taskRow.completed_by);

  const timeline = await pool.query(
    `SELECT event_type, title, description, session_key, actor, harness, metadata, created_at
       FROM task_timeline_events
      WHERE task_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 12`,
    [taskRow.id]
  ).catch(() => ({ rows: [] as any[] }));

  const history = await pool.query(
    `SELECT event_type, old_value, new_value, note, created_at
       FROM task_history
      WHERE task_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 12`,
    [taskRow.id]
  ).catch(() => ({ rows: [] as any[] }));

  const logPath = completedBy?.logPath || activeAgent?.logPath || null;
  const runLog = readTaskRunLogTail(logPath);

  return { task: taskRow, activeAgent, completedBy, timeline: timeline.rows || [], history: history.rows || [], logPath, runLog };
}

async function buildHistoricalFallbackMessages(sessionKey: string, linkedTask?: LinkedTaskSummary | null): Promise<ParsedMessage[]> {
  const evidence = await loadTaskEvidenceForSession(sessionKey, linkedTask);
  if (!evidence) return [];
  const task = evidence.task;
  const ts = task.updated_at instanceof Date ? task.updated_at.toISOString() : (task.updated_at ? String(task.updated_at) : new Date().toISOString());
  const lines: string[] = [];
  lines.push('Historical Hermes transcript fallback');
  lines.push('');
  lines.push(`Session: ${sessionKey}`);
  lines.push(`Task: ${task.title} (${task.id})`);
  lines.push(`Status: ${task.status}`);
  if (task.status_reason) lines.push(`Status reason: ${task.status_reason}`);
  if (task.blocked_reason) lines.push(`Blocked reason: ${task.blocked_reason}`);
  if (evidence.logPath) lines.push(`Run log: ${evidence.logPath}`);
  if (evidence.completedBy) lines.push(`Completed-by record: ${stringifyEvidence(evidence.completedBy)}`);
  if (evidence.activeAgent) lines.push(`Active-agent record: ${stringifyEvidence(evidence.activeAgent)}`);

  const messages: ParsedMessage[] = [{
    role: 'system',
    content: lines.join('\n'),
    timestamp: ts,
  }];

  if (evidence.timeline.length > 0) {
    messages.push({
      role: 'system',
      content: `Task timeline evidence (newest first):\n${evidence.timeline.map((row: any) => {
        const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
        const metadata = row.metadata && Object.keys(row.metadata).length ? `\nmetadata: ${stringifyEvidence(row.metadata)}` : '';
        return `- ${created} [${row.event_type}] ${row.title}${row.session_key ? ` (${row.session_key})` : ''}${row.description ? `\n  ${row.description}` : ''}${metadata}`;
      }).join('\n')}`,
      timestamp: ts,
    });
  }

  if (evidence.history.length > 0) {
    messages.push({
      role: 'system',
      content: `Task history evidence (newest first):\n${evidence.history.map((row: any) => {
        const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
        return `- ${created} [${row.event_type}] ${row.old_value || ''} → ${row.new_value || ''}${row.note ? `\n  ${row.note}` : ''}`;
      }).join('\n')}`,
      timestamp: ts,
    });
  }

  if (evidence.runLog.content) {
    messages.push({
      role: 'tool',
      toolName: 'hermes-task-run-log',
      content: `Tail of ${evidence.logPath}${evidence.runLog.lineCount != null ? ` (${evidence.runLog.lineCount} line(s))` : ''}:\n\n${evidence.runLog.content}`,
      timestamp: ts,
    });
  } else if (evidence.runLog.note) {
    messages.push({
      role: 'tool',
      toolName: 'hermes-task-run-log',
      content: evidence.runLog.note,
      timestamp: ts,
    });
  }

  if (messages.length === 1 && !task.status_reason && !task.blocked_reason && !evidence.completedBy && !evidence.activeAgent) {
    return [];
  }
  return messages;
}


async function findTaskForSession(sessionKey: string): Promise<LinkedTaskSummary | null> {
  const runIdMatch = sessionKey.match(/:run:([0-9a-f-]{36})$/i);
  const cronIdMatch = sessionKey.match(/:cron:([0-9a-f-]{36})(?::run:[0-9a-f-]{36})?$/i);
  const labelTaskMatch = sessionKey.match(/spawn-task-([a-f0-9]{8,})/i);
  const hermesSessionId = extractHermesSessionId(sessionKey);

  const sessionKeyAliases = Array.from(new Set([
    sessionKey,
    sessionKey.startsWith('cron:') ? sessionKey.slice(5) : `cron:${sessionKey}`,
    ...(runIdMatch ? [runIdMatch[1]] : []),
    ...(cronIdMatch ? [cronIdMatch[1], `cron:${cronIdMatch[1]}`] : []),
    ...(hermesSessionId ? [
      hermesSessionId,
      `hermes:tool:${hermesSessionId}`,
      `agent:main:local:dm:${hermesSessionId}`,
      `agent:main:discord:channel:${hermesSessionId}`,
      `agent:main:telegram:dm:${hermesSessionId}`,
    ] : []),
  ]));

  const taskIdPrefix = labelTaskMatch?.[1] || null;

  const result = await pool.query(
    `SELECT t.id, t.title, t.status, t.execution_mode, t.execution_profile,
            t.model, t.thinking_budget, t.acp_session_key, t.discord_thread_id,
            t.active_agent, t.completed_by, t.session_refs, at.id AS agent_type_id, at.slug AS agent_type_slug,
            at.name AS agent_type_name, at.color AS agent_type_color, at.category AS agent_type_category
       FROM tasks t
       LEFT JOIN agent_types at ON at.id = t.agent_type_id
      WHERE t.acp_session_key = ANY($1::text[])
         OR (
              t.active_agent IS NOT NULL
          AND (
                CASE
                  WHEN t.active_agent::text ~ '^\s*\{' THEN t.active_agent::jsonb
                  ELSE NULL
                END
              )->>'sessionKey' = ANY($1::text[])
         )
         OR (
              t.completed_by IS NOT NULL
          AND (
                CASE
                  WHEN t.completed_by::text ~ '^\s*\{' THEN t.completed_by::jsonb
                  ELSE NULL
                END
              )->>'sessionKey' = ANY($1::text[])
         )
         OR (t.session_refs IS NOT NULL AND t.session_refs ?| $1::text[])
         OR ($2::text IS NOT NULL AND left(t.id::text, length($2::text)) = $2::text)
      ORDER BY
        CASE
          WHEN t.acp_session_key = ANY($1::text[]) THEN 0
          WHEN t.active_agent IS NOT NULL AND (
                CASE
                  WHEN t.active_agent::text ~ '^\s*\{' THEN t.active_agent::jsonb
                  ELSE NULL
                END
              )->>'sessionKey' = ANY($1::text[]) THEN 1
          WHEN t.completed_by IS NOT NULL AND (
                CASE
                  WHEN t.completed_by::text ~ '^\s*\{' THEN t.completed_by::jsonb
                  ELSE NULL
                END
              )->>'sessionKey' = ANY($1::text[]) THEN 2
          WHEN t.session_refs IS NOT NULL AND t.session_refs ?| $1::text[] THEN 3
          WHEN $2::text IS NOT NULL AND left(t.id::text, length($2::text)) = $2::text THEN 4
          ELSE 5
        END,
        t.updated_at DESC NULLS LAST
      LIMIT 20`,
    [sessionKeyAliases, taskIdPrefix]
  );

  for (const row of result.rows) {
    const activeAgent = parseActiveAgent(row.active_agent);
    const completedBy = parseActiveAgent(row.completed_by);
    const activeAgentSessionKey = activeAgent && typeof activeAgent === 'object' ? activeAgent.sessionKey : null;
    const completedBySessionKey = completedBy && typeof completedBy === 'object' ? completedBy.sessionKey : null;
    const matchedByAcp = sessionKeyAliases.includes(row.acp_session_key);
    const matchedByActiveAgent = activeAgentSessionKey ? sessionKeyAliases.includes(activeAgentSessionKey) : false;
    const matchedByCompletedBy = completedBySessionKey ? sessionKeyAliases.includes(completedBySessionKey) : false;
    const sessionRefs = Array.isArray(row.session_refs) ? row.session_refs : [];
    const matchedBySessionRefs = sessionRefs.some((ref: any) => typeof ref === 'string' && sessionKeyAliases.includes(ref));
    const matchedByTaskIdPrefix = !!(taskIdPrefix && typeof row.id === 'string' && row.id.startsWith(taskIdPrefix));

    if (!matchedByAcp && !matchedByActiveAgent && !matchedByCompletedBy && !matchedBySessionRefs && !matchedByTaskIdPrefix) continue;

    return {
      id: row.id,
      title: row.title,
      status: row.status,
      executionMode: row.execution_mode || null,
      executionProfile: row.execution_profile || null,
      model: row.model || null,
      thinking: row.thinking_budget || null,
      acpSessionKey: row.acp_session_key || null,
      discordThreadId: row.discord_thread_id || null,
      discordThreadUrl: buildDiscordThreadUrl(row.discord_thread_id || null),
      activeAgent,
      agentName: activeAgent?.name || row.agent_type_name || null,
      agentType: row.agent_type_id ? {
        id: row.agent_type_id,
        slug: row.agent_type_slug || null,
        name: row.agent_type_name || null,
        color: row.agent_type_color || null,
        category: row.agent_type_category || null,
      } : null,
      sessionMatch: matchedByAcp ? 'acpSessionKey' : matchedByActiveAgent ? 'activeAgent' : matchedByCompletedBy ? 'completedBy' : 'sessionRefs',
    };
  }

  return null;
}

/** Resolve transcript path for a session key. */
async function resolveTranscriptPath(key: string): Promise<{ row: any; transcriptPath: string } | null> {
  const row = await findSessionRecord(key);
  if (!row) return null;

  const transcript = resolveTranscriptAvailability(row, TRANSCRIPTS_DIR);
  return { row, transcriptPath: transcript.transcriptPath || '' };
}

// ─────────────────────────────────────────────────────────────────
// JSONL message parser (on-the-fly, no DB)
// ─────────────────────────────────────────────────────────────────

interface ParsedMessage {
  role: string;
  content: string;
  timestamp: string | null;
  toolName?: string;
  toolCallId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
  };
}

/**
 * Strip OpenClaw envelope metadata from user messages, keeping only the actual user text.
 * OpenClaw wraps user messages with: [media attached:...], send instructions,
 * Conversation info JSON, Sender JSON — the real message follows after.
 */
function stripUserMetadata(text: string): string {
  let cleaned = text;

  // Remove [media attached: ...] lines
  cleaned = cleaned.replace(/^\[media attached[^\]]*\]\n?/gm, '');

  // Remove "To send an image back..." instruction block (ends at the next blank line or metadata block)
  cleaned = cleaned.replace(/^To send an image back,.*?(?=\n(?:Conversation info|Sender|\n|$))/s, '');

  // Remove Conversation info block (includes the JSON code fence)
  cleaned = cleaned.replace(/Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, '');

  // Remove Sender block (includes the JSON code fence)
  cleaned = cleaned.replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, '');

  // Remove [image data removed...] markers
  cleaned = cleaned.replace(/\[image data removed[^\]]*\]\s*/g, '');

  return cleaned.trim();
}

/**
 * Parse all messages from a JSONL transcript file.
 * Supports roles: user, assistant, tool (toolResult).
 */
async function parseJSONLMessages(filePath: string): Promise<ParsedMessage[]> {
  const messages: ParsedMessage[] = [];

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const timestamp = entry.timestamp || null;
    const msg = entry.message;
    if (!msg) continue;

    const role: string = msg.role || '';
    const content = msg.content;

    if (role === 'user') {
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text') text += c.text || '';
        }
      }
      if (text.trim()) {
        // Detect OpenClaw system-injected messages masquerading as user role
        const cleanedText = stripUserMetadata(text);
        const isSystemMessage = /^(Pre-compaction memory flush|Read HEARTBEAT\.md|Heartbeat prompt:|ORCHESTRATE|Session startup|A new session was started via)/i.test(cleanedText);
        if (cleanedText) {
          messages.push({ role: isSystemMessage ? 'system' : 'user', content: cleanedText, timestamp });
        }
      }
    } else if (role === 'assistant') {
      let text = '';
      const usage: ParsedMessage['usage'] = {};

      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text') text += c.text || '';
          else if (c.type === 'thinking') {
            // skip thinking blocks
          } else if (c.type === 'toolCall') {
            // Tool calls are handled separately
            const toolName = c.name || 'unknown';
            const inputStr = typeof c.arguments === 'object'
              ? JSON.stringify(c.arguments).substring(0, 500)
              : String(c.arguments || '');
            messages.push({
              role: 'assistant',
              content: `[Tool call: ${toolName}] ${inputStr}`,
              timestamp,
              toolName,
              toolCallId: c.id,
            });
          }
        }
      }

      // Extract usage if present
      if (entry.usage) {
        usage.inputTokens = entry.usage.input_tokens;
        usage.outputTokens = entry.usage.output_tokens;
        usage.thinkingTokens = entry.usage.thinking_tokens;
      }

      if (text.trim()) {
        messages.push({
          role: 'assistant',
          content: text,
          timestamp,
          ...(Object.keys(usage).length > 0 ? { usage } : {}),
        });
      }
    } else if (role === 'toolResult') {
      let text = '';
      const toolName = msg.toolName || undefined;
      const toolCallId = msg.toolCallId || undefined;

      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text') text += c.text || '';
        }
      }

      messages.push({
        role: 'tool',
        content: text.substring(0, 2000),
        timestamp,
        toolName,
        toolCallId,
      });
    }
  }

  return messages;
}

// ─────────────────────────────────────────────────────────────────
// Subtask 0 + 1 + 2 + 3 + 4: Route handlers
// ─────────────────────────────────────────────────────────────────

/**
 * GET /sessions
 * List sessions with filters. Reads from DB + live state overlay.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      kind,
      status,
      model,
      channel,
      harness,
      search,
      dateFrom,
      dateTo,
      sortBy = 'last_activity_at',
      sortOrder = 'DESC',
      page = '1',
      limit = '50',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit as string) || 50));
    const offset = (pageNum - 1) * limitNum;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (kind) {
      conditions.push(`kind = $${paramIndex++}`);
      params.push(kind);
    }
    if (status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(status);
    }
    if (model) {
      conditions.push(`model = $${paramIndex++}`);
      params.push(model);
    }
    if (channel) {
      conditions.push(`channel = $${paramIndex++}`);
      params.push(channel);
    }
    if (dateFrom) {
      conditions.push(`last_activity_at >= $${paramIndex++}`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`last_activity_at <= $${paramIndex++}`);
      params.push(dateTo);
    }
    if (search) {
      conditions.push(
        `(session_key ILIKE $${paramIndex} OR label ILIKE $${paramIndex})`
      );
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Exclude only empty cron parent stubs when a :run: child exists.
    // Recent OpenClaw behavior can leave the parent row as a real session with messages,
    // so hiding every parent-with-child breaks task-linked steering and focus.
    conditions.push(
      `NOT (kind = 'cron' AND session_key NOT LIKE '%:run:%'
           AND started_at IS NULL AND message_count = 0
           AND EXISTS (SELECT 1 FROM sessions c WHERE c.session_key LIKE sessions.session_key || ':run:%'))`
    );

    // Hide empty :run: sub-sessions (message_count=0, no started_at) — these are unfilled
    // child execution stubs that the SessionIngester couldn't find a transcript for.
    // When they DO have messages they are shown normally (and get a sub-session badge in the UI).
    conditions.push(
      `NOT (session_key LIKE '%:run:%' AND message_count = 0 AND started_at IS NULL)`
    );

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const allowedSortFields: Record<string, string> = {
      last_activity_at: 'last_activity_at',
      started_at: 'started_at',
      message_count: 'message_count',
      total_cost_usd: 'total_cost_usd',
      input_tokens: 'input_tokens',
      output_tokens: 'output_tokens',
    };
    const sortField = allowedSortFields[sortBy as string] || 'last_activity_at';
    const order = (sortOrder as string).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const dataResult = await pool.query(
      `SELECT
         sessions.session_key, sessions.session_id, sessions.kind, sessions.label,
         sessions.model, sessions.channel, sessions.status,
         sessions.spawn_info, sessions.message_count, sessions.tool_call_count,
         sessions.input_tokens, sessions.output_tokens, sessions.thinking_tokens, sessions.total_cost_usd,
         sessions.started_at, sessions.ended_at, sessions.last_activity_at,
         sessions.transcript_path, sessions.file_size,
         sessions.agent_type_id,
         at.name AS agent_type_name, at.slug AS agent_type_slug, at.color AS agent_type_color
       FROM sessions
       LEFT JOIN agent_types at ON at.id = sessions.agent_type_id
       ${whereClause}`,
      params
    );

    const dbRows = dataResult.rows;
    let sessions = dbRows.map(rowToSession);
    if (harness) {
      sessions = sessions.filter((session) => session.harness === harness);
    }
    if (status) {
      // rowToSession can downgrade a stale hermes 'active' snapshot to
      // 'completed' — re-apply the requested status filter post-normalization
      // so ?status=active never returns sessions we just declared completed.
      sessions = sessions.filter((session) => session.status === status);
    }

    const hermesRows = await listHermesSessionRows();
    const hermesSessions = hermesRows
      .filter((row) => sessionMatchesFilters(row, { kind: kind as string | undefined, status: status as string | undefined, model: model as string | undefined, channel: channel as string | undefined, search: search as string | undefined, dateFrom: dateFrom as string | undefined, dateTo: dateTo as string | undefined }))
      .map(rowToSession);

    sessions = [...sessions, ...(harness && harness !== 'hermes' ? [] : hermesSessions)];

    // Add ephemeral sessions (active in gateway but not yet in DB)
    if (gatewayConnector && !harness && !kind && !status && !model && !channel && !search && !dateFrom && !dateTo) {
      const liveStates = gatewayConnector.getLiveStates();
      const dbKeys = new Set(dbRows.map((r: any) => r.session_key));
      const thirtyMinAgo = Date.now() - 30 * 60 * 1000;

      for (const [sessionKey, live] of liveStates.entries()) {
        if (!dbKeys.has(sessionKey) && live.lastActivity > thirtyMinAgo) {
          sessions.push({
            sessionKey,
            sessionId: null,
            kind: 'unknown',
            label: sessionKey,
            model: null,
            channel: null,
            status: 'active',
            liveState: {
              state: live.state,
              recentTools: live.tools,
              lastActivity: live.lastActivity,
              isGenerating: live.state !== 'idle',
            },
            runtimeState: 'live',
            runtimeStateReason: 'Live runtime heartbeat is available for this session.',
            messageCount: 0,
            toolCallCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            thinkingTokens: 0,
            totalCost: 0,
            startedAt: null,
            endedAt: null,
            lastActivityAt: new Date(live.lastActivity).toISOString(),
            spawnInfo: {},
            transcriptPath: null,
            transcriptState: 'none',
            transcriptStateReason: 'No transcript has been recorded for this session yet.',
            fileSize: null,
            task: null,
          });
        }
      }
    }

    sessions = dedupeSessions(sessions);
    sessions.sort((a: any, b: any) => compareSessionObjects(a, b, sortField, order as 'ASC' | 'DESC'));

    const pinnedLabels = new Set(['Main OpenClaw', 'Main Hermes']);
    const pinnedSessions = sessions.filter((session: any) => pinnedLabels.has(session.displayLabel));
    const unpinnedSessions = sessions.filter((session: any) => !pinnedLabels.has(session.displayLabel));
    const orderedSessions = [
      ...pinnedSessions.sort((a: any, b: any) => a.displayLabel.localeCompare(b.displayLabel)),
      ...unpinnedSessions,
    ];

    const total = orderedSessions.length;
    const pagedSessions = await applyArchivedTranscriptAvailability(orderedSessions.slice(offset, offset + limitNum));
    const enrichedSessions = await enrichSessionsForList(pagedSessions);

    res.json({
      success: true,
      sessions: enrichedSessions,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err: any) {
    console.error('[GET /sessions] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// Subtask 1: GET /sessions/stats
// ─────────────────────────────────────────────────────────────────

// SQL twin of rowToSession's staleness normalization: an archived hermes copy
// still marked 'active' with no activity inside the window (or already ended)
// is effectively completed — keep the aggregate counts consistent with the
// per-session view instead of counting fabricated 'active' rows.
const HERMES_STALE_ACTIVE_SQL = `(status = 'active' AND spawn_info->>'harness' = 'hermes'
  AND (ended_at IS NOT NULL OR COALESCE(last_activity_at, started_at) < NOW() - INTERVAL '${HERMES_ACTIVE_WINDOW_SECONDS} seconds'))`;

router.get('/stats', async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo } = req.query;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (dateFrom) {
      conditions.push(`started_at >= $${paramIndex++}`);
      params.push(dateFrom);
    }
    if (dateTo) {
      conditions.push(`started_at <= $${paramIndex++}`);
      params.push(dateTo);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [overallResult, byModelResult, byKindResult, byChannelResult, byStatusResult] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) AS total_sessions,
           COUNT(*) FILTER (WHERE status = 'active' AND NOT ${HERMES_STALE_ACTIVE_SQL}) AS active_sessions,
           COUNT(*) FILTER (WHERE status = 'completed' OR ${HERMES_STALE_ACTIVE_SQL}) AS completed_sessions,
           SUM(message_count) AS total_messages,
           SUM(tool_call_count) AS total_tool_calls,
           SUM(input_tokens) AS total_input_tokens,
           SUM(output_tokens) AS total_output_tokens,
           SUM(thinking_tokens) AS total_thinking_tokens,
           SUM(total_cost_usd) AS total_cost,
           MIN(started_at) AS oldest_session,
           MAX(last_activity_at) AS newest_session
         FROM sessions ${whereClause}`,
        params
      ),
      pool.query(
        `SELECT
           model,
           COUNT(*) AS session_count,
           SUM(message_count) AS messages,
           SUM(total_cost_usd) AS cost,
           SUM(input_tokens + output_tokens + thinking_tokens) AS total_tokens
         FROM sessions
         ${whereClause ? whereClause + ' AND model IS NOT NULL' : 'WHERE model IS NOT NULL'}
         GROUP BY model
         ORDER BY session_count DESC
         LIMIT 20`,
        params
      ),
      pool.query(
        `SELECT kind, COUNT(*) AS count, SUM(total_cost_usd) AS cost
         FROM sessions ${whereClause}
         GROUP BY kind ORDER BY count DESC`,
        params
      ),
      pool.query(
        `SELECT channel, COUNT(*) AS count
         FROM sessions
         ${whereClause ? whereClause + ' AND channel IS NOT NULL' : 'WHERE channel IS NOT NULL'}
         GROUP BY channel ORDER BY count DESC`,
        params
      ),
      pool.query(
        `SELECT CASE WHEN ${HERMES_STALE_ACTIVE_SQL} THEN 'completed' ELSE status END AS status,
                COUNT(*) AS count
         FROM sessions ${whereClause}
         GROUP BY 1`,
        params
      ),
    ]);

    // PostgreSQL returns BIGINT/NUMERIC aggregates as strings — coerce to numbers
    const raw = overallResult.rows[0] || {};
    const overall = {
      total_sessions: parseInt(raw.total_sessions, 10) || 0,
      active_sessions: parseInt(raw.active_sessions, 10) || 0,
      completed_sessions: parseInt(raw.completed_sessions, 10) || 0,
      total_messages: parseInt(raw.total_messages, 10) || 0,
      total_tool_calls: parseInt(raw.total_tool_calls, 10) || 0,
      total_input_tokens: parseInt(raw.total_input_tokens, 10) || 0,
      total_output_tokens: parseInt(raw.total_output_tokens, 10) || 0,
      total_thinking_tokens: parseInt(raw.total_thinking_tokens, 10) || 0,
      total_cost: parseFloat(raw.total_cost) || 0,
    };

    res.json({
      success: true,
      overall,
      byModel: byModelResult.rows,
      byKind: byKindResult.rows,
      byChannel: byChannelResult.rows,
      byStatus: byStatusResult.rows,
    });
  } catch (err: any) {
    console.error('[GET /sessions/stats] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


router.get('/attachment-limits', (_req: Request, res: Response) => {
  res.json({
    success: true,
    limits: getSteeringAttachmentConfig(),
  });
});

router.post('/:key/steer', async (req: Request, res: Response) => {
  let attachmentAbsDir: string | null = null;

  try {
    const row = await findSessionRecord(req.params.key);
    if (!row) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    const session = rowToSession(row);
    const linkedTask = await findTaskForSession(session.sessionKey);
    const steering = getSessionSteeringInfo(session, linkedTask);
    if (!steering.supported) {
      res.status(409).json({ success: false, error: steering.reason, steering });
      return;
    }

    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    const hasMessage = message.trim().length > 0;
    const hasAttachments = Array.isArray(req.body?.attachments) && req.body.attachments.length > 0;
    if (!hasMessage && !hasAttachments) {
      res.status(400).json({ success: false, error: 'message or attachments are required' });
      return;
    }

    const attachmentManifest = await materializeSteeringAttachments(req.body?.attachments);
    attachmentAbsDir = attachmentManifest?.absDir || null;
    const steeringMessage = buildSteeringMessage(message, attachmentManifest);

    if (session.harness === 'hermes') {
      if (!linkedTask) {
        res.status(409).json({ success: false, error: 'This Hermes session is not linked to a steerable task.', steering });
        return;
      }

      const task = await taskManager.getTask(linkedTask.id);
      if (!task) {
        res.status(404).json({ success: false, error: 'Linked task not found' });
        return;
      }

      const executor = createTaskExecutor('hermes', gatewayConnector);
      const workdir = await resolveTaskWorkingDirectory(task);
      const steerResult = await executor.steer({
        taskId: task.id,
        sessionKey: steering.targetSessionKey,
        message: steeringMessage,
        model: task.model || null,
        cwd: workdir,
      });

      const raw = steerResult.raw || {};
      if (raw.pid || raw.sourceTag || raw.logPath) {
        await taskManager.updateTask(task.id, {
          activeAgent: {
            ...(task.activeAgent || { name: task.executionMode === 'interactive' ? 'interactive-agent' : 'sub-agent', sessionKey: steerResult.sessionKey }),
            sessionKey: steerResult.sessionKey,
            harness: 'hermes',
            ...(typeof raw.pid === 'number' ? { pid: raw.pid as number } : {}),
            ...(typeof raw.sourceTag === 'string' ? { sourceTag: raw.sourceTag as string } : {}),
            ...(typeof raw.logPath === 'string' ? { logPath: raw.logPath as string } : {}),
          },
          ...(task.executionMode === 'interactive' ? { acpSessionKey: steerResult.sessionKey } : {}),
        });
      }

      res.json({
        success: true,
        sent: true,
        sessionKey: session.sessionKey,
        targetSessionKey: steerResult.sessionKey,
        steering,
        attachmentsWritten: !!attachmentManifest,
        attachmentManifest: attachmentManifest ? {
          relDir: attachmentManifest.relDir,
          count: attachmentManifest.count,
          totalBytes: attachmentManifest.totalBytes,
          files: attachmentManifest.files,
        } : null,
        ...(Object.keys(raw).length > 0 ? { metadata: raw } : {}),
      });
      return;
    }

    if (!gatewayConnector) {
      res.status(503).json({ success: false, error: 'Gateway connector not initialized' });
      return;
    }

    const gatewayStatus = gatewayConnector.getConnectionStatus();
    if (!gatewayStatus.connected) {
      res.status(503).json({
        success: false,
        error: gatewayStatus.lastError || 'Gateway connector unavailable',
      });
      return;
    }

    const liveState = gatewayConnector.getSessionState(steering.targetSessionKey);
    if (!liveState) {
      res.status(409).json({
        success: false,
        error: 'This session is not currently live in the gateway, so steering would time out. Refresh the Sessions page and use a fresh live steerable session.',
        steering: getSessionSteeringInfo({ ...session, liveState: null }, linkedTask),
      });
      return;
    }

    await gatewayConnector.steerSession(steering.targetSessionKey, steeringMessage);

    res.json({
      success: true,
      sent: true,
      sessionKey: session.sessionKey,
      targetSessionKey: steering.targetSessionKey,
      steering,
      attachmentsWritten: !!attachmentManifest,
      attachmentManifest: attachmentManifest ? {
        relDir: attachmentManifest.relDir,
        count: attachmentManifest.count,
        totalBytes: attachmentManifest.totalBytes,
        files: attachmentManifest.files,
      } : null,
    });
  } catch (err: any) {
    if (attachmentAbsDir) {
      await cleanupAttachments(attachmentAbsDir).catch(() => {});
    }
    console.error('[POST /sessions/:key/steer] Error:', err);
    const message = err?.message || 'Unknown error';
    if (err?.name === 'HermesSessionStartingError' || err?.code === 'HERMES_SESSION_STARTING') {
      // Expected transient condition: the Hermes session id has not been
      // linked to the task yet.
      res.status(409).json({ success: false, error: message, code: 'HERMES_SESSION_STARTING' });
      return;
    }
    const status = /attachments? .*required|attachments must be an array|unsupported|not supported|missing a name|empty|limit|too many attachments|added more than once/i.test(message)
      ? 400
      : /not accept manual steering|not be steered directly|Only live sessions|no longer in a steerable running state/i.test(message)
        ? 409
        : 500;
    res.status(status).json({ success: false, error: message });
  }
});

// ─────────────────────────────────────────────────────────────────
// Subtask 2: GET /sessions/:key — single session with live state
// ─────────────────────────────────────────────────────────────────

router.get('/:key', async (req: Request, res: Response) => {
  try {
    const row = await findSessionRecord(req.params.key);
    if (!row) {
      const history = await agentHistoryService.findBySessionKey(req.params.key);
      if (!history) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }
      const session = buildHistoricalSessionFromAgentRecord(history);
      const historicalHermesSessionId = extractHermesSessionId(session.sessionKey);
      if (historicalHermesSessionId) {
        await ensureHermesSessionArchive(session.sessionKey, historicalHermesSessionId).catch(() => {});
      }
      const archived = await summarizeArchivedSessionMessages(session.sessionKey);
      if (archived.messageCount > 0) {
        session.messageCount = Math.max(session.messageCount || 0, archived.messageCount);
        session.toolCallCount = Math.max(session.toolCallCount || 0, archived.toolCallCount);
        session.transcriptState = 'available';
        session.transcriptStateReason = 'Archived messages are available from the session archive database.';
      }
      session.task = await findTaskForSession(session.sessionKey);
      if (archived.messageCount === 0) {
        const fallbackMessages = await buildHistoricalFallbackMessages(session.sessionKey, session.task);
        if (fallbackMessages.length > 0) {
          session.messageCount = Math.max(session.messageCount || 0, fallbackMessages.length);
          session.transcriptState = 'available';
          session.transcriptStateReason = 'No live transcript was found; showing task history, run-log, and stuck-state evidence instead.';
          session.spawnInfo = {
            ...(session.spawnInfo || {}),
            fallbackEvidence: true,
            fallbackEvidenceSource: 'task-history-run-log',
          };
        }
      }
      res.json({ success: true, session });
      return;
    }

    const session = rowToSession(row);
    const archived = await summarizeArchivedSessionMessages(session.sessionKey);
    if (archived.messageCount > 0 && (session.transcriptState === 'none' || session.transcriptState === 'missing')) {
      session.messageCount = Math.max(session.messageCount || 0, archived.messageCount);
      session.toolCallCount = Math.max(session.toolCallCount || 0, archived.toolCallCount);
      session.transcriptState = 'available';
      session.transcriptStateReason = 'Archived messages are available from the session archive database.';
    }
    session.task = await findTaskForSession(session.sessionKey);
    if ((session.transcriptState === 'none' || session.transcriptState === 'missing') && archived.messageCount === 0) {
      const fallbackMessages = await buildHistoricalFallbackMessages(session.sessionKey, session.task);
      if (fallbackMessages.length > 0) {
        session.messageCount = Math.max(session.messageCount || 0, fallbackMessages.length);
        session.transcriptState = 'available';
        session.transcriptStateReason = 'No live transcript was found; showing task history, run-log, and stuck-state evidence instead.';
        session.spawnInfo = {
          ...(session.spawnInfo || {}),
          fallbackEvidence: true,
          fallbackEvidenceSource: 'task-history-run-log',
        };
      }
    }
    session.steering = getSessionSteeringInfo(session, session.task);
    res.json({ success: true, session });
  } catch (err: any) {
    console.error('[GET /sessions/:key] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// Subtask 3: GET /sessions/:key/transcript — stream raw JSONL
// ─────────────────────────────────────────────────────────────────

router.get('/:key/transcript', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const tailParam = req.query.messages; // e.g. 'last20'
    const format = req.query.format as string | undefined; // 'parsed' or undefined

    const resolved = await resolveTranscriptPath(key);
    if (!resolved) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    const { transcriptPath } = resolved;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      res.status(404).json({ success: false, error: 'Transcript file not found' });
      return;
    }

    if (format === 'parsed') {
      // Return structured JSON of parsed entries
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim());
      const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

      // Apply tail if requested
      let result = entries;
      if (tailParam && typeof tailParam === 'string') {
        const match = tailParam.match(/^last(\d+)$/);
        if (match) {
          const n = parseInt(match[1]);
          result = entries.slice(-n);
        }
      }

      res.json({ success: true, entries: result, total: entries.length });
      return;
    }

    // Apply tail if requested (streaming raw JSONL lines)
    if (tailParam && typeof tailParam === 'string') {
      const match = tailParam.match(/^last(\d+)$/);
      if (match) {
        const n = parseInt(match[1]);
        const content = fs.readFileSync(transcriptPath, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l.trim());
        const tailLines = lines.slice(-n);
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.send(tailLines.join('\n') + '\n');
        return;
      }
    }

    // Default: stream entire file
    const sessionId = resolved.row.session_id ? String(resolved.row.session_id) : key;
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="${sessionId}.jsonl"`);
    const stream = fs.createReadStream(transcriptPath);
    stream.on('error', (err) => {
      console.error('[transcript] Stream error:', err);
      res.end();
    });
    stream.pipe(res);
  } catch (err: any) {
    console.error('[GET /sessions/:key/transcript] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// Subtask 4: GET /sessions/:key/messages — parsed messages
// ─────────────────────────────────────────────────────────────────

router.get('/:key/messages', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const roleFilter = req.query.role as string | undefined; // 'user', 'assistant', 'tool'
    // tail=true (default): return the LAST N messages (most recent first for live sessions)
    const tail = req.query.tail !== 'false';

    let row = await findSessionRecord(key);
    if (!row) {
      const history = await agentHistoryService.findBySessionKey(key);
      if (!history) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }

      const historicalHermesSessionId = extractHermesSessionId(key);
      if (historicalHermesSessionId) {
        await ensureHermesSessionArchive(key, historicalHermesSessionId).catch((err) => {
          console.warn('[sessions] Historical Hermes archive sync failed:', err);
        });
      }

      const historicalArchivedMessages = await getArchivedMessages(key);
      const linkedTask = await findTaskForSession(key);
      const fallbackMessages = historicalArchivedMessages.length === 0
        ? await buildHistoricalFallbackMessages(key, linkedTask)
        : [];
      if (historicalArchivedMessages.length === 0 && fallbackMessages.length === 0) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }

      let messages = historicalArchivedMessages.length > 0 ? historicalArchivedMessages : fallbackMessages;
      if (roleFilter) {
        messages = messages.filter(m => m.role === roleFilter);
      }
      const total = messages.length;
      let page: ParsedMessage[];
      let hasMore: boolean;
      if (tail && offset === 0) {
        const start = Math.max(0, total - limit);
        page = messages.slice(start, total);
        hasMore = start > 0;
      } else {
        page = messages.slice(offset, offset + limit);
        hasMore = offset + limit < total;
      }
      res.json({ success: true, messages: page, total, offset: tail && offset === 0 ? Math.max(0, total - limit) : offset, limit, hasMore });
      return;
    }

    let messages: ParsedMessage[] = [];
    const hermesSessionId = row.spawn_info?.hermesSessionId
      ? String(row.spawn_info.hermesSessionId)
      : extractHermesSessionId(key);

    if (hermesSessionId) {
      await ensureHermesSessionArchive(key, hermesSessionId).catch((err) => {
        console.warn('[sessions] Hermes archive sync failed:', err);
      });
    }

    const archivedMessages = await getArchivedMessages(key);
    if (archivedMessages.length > 0) {
      messages = archivedMessages;
    } else if (row.spawn_info?.harness === 'hermes' && row.spawn_info?.hermesSessionId) {
      messages = await parseHermesMessages(String(row.spawn_info.hermesSessionId));
    } else {
      const resolved = await resolveTranscriptPath(key);
      if (!resolved) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }
      const { transcriptPath } = resolved;
      if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        const linkedTask = await findTaskForSession(key);
        const fallbackMessages = await buildHistoricalFallbackMessages(key, linkedTask);
        if (fallbackMessages.length === 0) {
          res.status(404).json({ success: false, error: 'Transcript file not found', messages: [], total: 0, hasMore: false });
          return;
        }
        messages = fallbackMessages;
      } else {
        messages = await parseJSONLMessages(transcriptPath);
      }
    }

    if (messages.length === 0) {
      const linkedTask = await findTaskForSession(key);
      messages = await buildHistoricalFallbackMessages(key, linkedTask);
    }

    // Filter by role
    if (roleFilter) {
      messages = messages.filter(m => m.role === roleFilter);
    }

    const total = messages.length;

    let page: ParsedMessage[];
    let hasMore: boolean;

    if (tail && offset === 0) {
      // Default: return the last N messages (most recent) for initial load
      const start = Math.max(0, total - limit);
      page = messages.slice(start, total);
      hasMore = start > 0;
    } else {
      // Explicit offset: return from that position (for "Load older" pagination)
      page = messages.slice(offset, offset + limit);
      hasMore = offset + limit < total;
    }

    res.json({
      success: true,
      messages: page,
      total,
      offset: tail && offset === 0 ? Math.max(0, total - limit) : offset,
      limit,
      hasMore,
    });
  } catch (err: any) {
    console.error('[GET /sessions/:key/messages] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
