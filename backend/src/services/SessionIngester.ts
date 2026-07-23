/**
 * SessionIngester — Unified session metadata service.
 *
 * Replaces:
 *   - SessionIndexer.ts  (periodic 5-min JSONL scanner → DB)
 *   - SessionMonitor.ts  (sessions.json watcher → WebSocket status)
 *
 * Two data sources:
 *   1. sessions.json  — authoritative metadata registry (session keys, kinds,
 *                       models, channels, spawn info)
 *   2. JSONL transcript files — message content, token counts, timestamps
 *
 * === Startup (one-time digest) ===
 *   - Read sessions.json → get all session keys with metadata
 *   - For each key, find corresponding JSONL file via sessionId
 *   - Parse JSONL for: message_count, tool_call_count, token totals, timestamps
 *   - UPSERT all into sessions table with status='active'
 *   - Scan for 'orphan' JSONL files (on disk but not in sessions.json)
 *
 * === Live tracking ===
 *   - fs.watch sessions.json (debounced 500ms) → detect new/updated entries
 *   - fs.watch transcripts dir (debounced 500ms, ignore .lock files)
 *   - On sessions.json change: diff old vs new, upsert changed, complete removed
 *   - On JSONL change: re-parse that file, update stats in DB
 *   - On .lock file change: emit session:live-state event
 *
 * === Emitted events ===
 *   'session:upserted'   — { sessionKey, sessionId, status, kind }
 *   'session:completed'  — { sessionKey }
 *   'session:live-state' — { sessionKey, sessionId, isActive }
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { EventEmitter } from 'events';
import { pool } from '../db/connection';
import { openClawCanonicalAdapter } from './OpenClawCanonicalAdapter';
import {
  deriveSessionHarness,
  deriveSessionType,
  getSessionDisplayLabel,
} from '../utils/sessionTaxonomy';

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────

const SESSIONS_JSON_PATH =
  process.env.OPENCLAW_SESSIONS_PATH ||
  process.env.CLAWDBOT_SESSIONS_PATH ||
  '/clawdbot/sessions/sessions.json';

const TRANSCRIPTS_DIR =
  process.env.OPENCLAW_TRANSCRIPTS_DIR ||
  process.env.CLAWDBOT_TRANSCRIPTS_DIR ||
  '/clawdbot/sessions';

const DEBOUNCE_MS = 500;

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

/** Shape of a single entry in sessions.json (value part of the Record). */
export interface SessionsJsonEntry {
  sessionId: string;
  label?: string;
  model?: string;
  channel?: string;
  updatedAt?: number;
  systemSent?: boolean;
  chatType?: string;
  /** Absolute path to the JSONL file (OpenClaw stores this as sessionFile). */
  sessionFile?: string;
  /** Parent session key (set on sub-agent spawns). */
  spawnedBy?: string;
  spawnDepth?: number;
  /** Delivery context: channel/to/accountId. */
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
  origin?: {
    label?: string;
    provider?: string;
    surface?: string;
    from?: string;
    to?: string;
    accountId?: string;
    chatType?: string;
  };
  [key: string]: unknown;
}

/** Aggregate stats parsed from a JSONL file. */
export interface JournalStats {
  messageCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number;
  startedAt: string | null;
  endedAt: string | null;
  lastActivityAt: string | null;
  label: string | null;
  model: string | null;
  fileSize: number;
}

/**
 * Internal/synthetic model names emitted by OpenClaw for non-LLM messages
 * (e.g. delivery-mirror for /new startup messages). These should be skipped
 * when determining the actual model used in a session transcript.
 */
const SYNTHETIC_MODELS = new Set([
  'delivery-mirror',
  'delivery',
  'system',
  'internal',
]);

// ─────────────────────────────────────────────────────────────────
// Kind detection — deterministic from session_key pattern
// ─────────────────────────────────────────────────────────────────

/**
 * Derive the session kind from the session_key string alone.
 * Rules are checked in priority order; first match wins.
 *
 * Valid kinds (must match sessions table CHECK constraint):
 *   main | heartbeat | cron | subagent | discord | acp | unknown
 *
 * Examples:
 *   'agent:main:main'                         → 'main'
 *   'agent:main:heartbeat'                    → 'heartbeat'
 *   'agent:main:cron:3a419d09-...'            → 'cron'
 *   'agent:main:subagent:26ff5830-...'        → 'subagent'
 *   'agent:main:discord:channel:146580...'    → 'discord'
 *   'agent:main:acp:...'                      → 'acp'
 *   anything else                              → 'unknown'
 */
export function deriveKind(sessionKey: string): string {
  if (sessionKey.includes(':heartbeat')) return 'heartbeat';
  if (sessionKey.includes(':cron:') || sessionKey.startsWith('cron:')) return 'cron';
  if (sessionKey.includes(':subagent:')) return 'subagent';
  if (sessionKey.includes(':discord:'))  return 'discord';
  if (sessionKey.includes(':acp:'))      return 'acp';
  if (sessionKey.endsWith(':main'))      return 'main';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────
// Persona stamping — resolve the owning task's agent_type_id
// ─────────────────────────────────────────────────────────────────

/**
 * Alias keys under which a task may reference a session
 * (tasks.acp_session_key / session_refs / completed_by / active_agent).
 *
 *   agent:main:cron:<jobId>[:run:<runId>]  <->  cron:<jobId>
 *   hermes:<source>:<id>                    ->  bare <id>
 */
export function agentTypeStampAliases(sessionKey: string): string[] {
  const aliases = new Set<string>([sessionKey]);
  const cronMatch = sessionKey.match(
    /^(?:agent:main:)?cron:([0-9a-f-]{36})(?::run:[0-9a-f-]{36})?$/i
  );
  if (cronMatch) {
    aliases.add(`cron:${cronMatch[1]}`);
    aliases.add(`agent:main:cron:${cronMatch[1]}`);
  }
  const hermesMatch = sessionKey.match(/^hermes:[a-z]+:(.+)$/i);
  if (hermesMatch) aliases.add(hermesMatch[1]);
  return Array.from(aliases);
}

/**
 * Scalar SQL subquery resolving the owning task's agent_type_id for a set of
 * session-key aliases supplied as a text[] parameter at position `paramIdx`.
 * Returns NULL when no task with a persona references any of the aliases.
 */
export function taskAgentTypeSubquery(paramIdx: number): string {
  const p = `$${paramIdx}::text[]`;
  return `(
    SELECT t.agent_type_id FROM tasks t
     WHERE t.agent_type_id IS NOT NULL
       AND (t.acp_session_key = ANY(${p})
         OR (jsonb_typeof(t.session_refs) = 'array' AND t.session_refs ?| ${p})
         OR t.completed_by->>'sessionKey' = ANY(${p})
         OR t.active_agent->>'sessionKey' = ANY(${p}))
     ORDER BY t.updated_at DESC NULLS LAST
     LIMIT 1
  )`;
}

// ─────────────────────────────────────────────────────────────────
// Label extraction — from first meaningful user message
// ─────────────────────────────────────────────────────────────────

/** Patterns that identify metadata / envelope lines we should not use as labels. */
const SKIP_LINE_PATTERNS: Array<string | RegExp> = [
  'Conversation info (untrusted metadata)',
  'Sender (untrusted metadata)',
  '<<HUMAN_CONVERSATION_START>>',
  '[media attached:',
  'Chat history (last',
];

function isMetadataLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (/^\{.*\}$/.test(t) || /^\[.*\]$/.test(t)) return true;
  if (t === '{' || t === '}') return true;
  for (const pat of SKIP_LINE_PATTERNS) {
    if (typeof pat === 'string' ? t.startsWith(pat) : pat.test(t)) return true;
  }
  return false;
}

function isSystemMessage(content: string): boolean {
  return (
    content.includes('HEARTBEAT') ||
    content.startsWith('System:') ||
    content.startsWith('Read HEARTBEAT') ||
    content.startsWith('Read SOUL.md') ||
    content.startsWith('Read AGENTS.md') ||
    content.startsWith('A new session was started') ||
    /^\[cron:[a-f0-9-]+/.test(content) ||
    /^\[spawn-task-/.test(content)
  );
}

/**
 * Extract a human-readable label (≤255 chars) from a user message body.
 * Returns null if the content is a system message or no meaningful text found.
 */
export function extractLabelFromContent(content: string): string | null {
  if (!content || isSystemMessage(content)) return null;

  // Prefer an explicit ## Task: heading (cron-spawned agent prompts use this)
  const taskMatch =
    content.match(/##\s*Task:\s*(.+?)(?:\n|$)/i) ||
    content.match(/#\s*Task:\s*(.+?)(?:\n|$)/i) ||
    content.match(/\*\*Task:\*\*\s*(.+?)(?:\n|$)/i);
  if (taskMatch) return taskMatch[1].trim().slice(0, 255);

  // Otherwise use first meaningful non-metadata line
  const lines = content.split('\n');
  const first = lines.find(l => {
    const t = l.trim();
    return (
      t.length > 5 &&
      !t.startsWith('[') &&
      !t.startsWith('System:') &&
      !t.startsWith('#') &&
      !t.startsWith('Read ') &&
      !t.startsWith('---') &&
      !isMetadataLine(l)
    );
  });
  return first ? first.trim().slice(0, 255) : null;
}

// ─────────────────────────────────────────────────────────────────
// JSONL stats parser
// ─────────────────────────────────────────────────────────────────

/**
 * Parse a JSONL transcript file and aggregate session stats.
 * Reads the full file line-by-line.
 * Returns null if the file is empty or unreadable.
 */
export async function parseJSONLStats(filePath: string): Promise<JournalStats | null> {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return null;

    const result: JournalStats = {
      messageCount: 0,
      toolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      totalCostUsd: 0,
      startedAt: null,
      endedAt: null,
      lastActivityAt: null,
      label: null,
      model: null,
      fileSize: stat.size,
    };

    return new Promise((resolve) => {
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let labelFound = false;

      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const entry = JSON.parse(line);

          // Timestamps — track first and last across all entries
          const ts = entry.timestamp;
          if (ts) {
            const isoTs =
              typeof ts === 'number' ? new Date(ts).toISOString() : String(ts);
            if (!result.startedAt || isoTs < result.startedAt) result.startedAt = isoTs;
            if (!result.lastActivityAt || isoTs > result.lastActivityAt)
              result.lastActivityAt = isoTs;
          }

          // Gateway-provided label (highest priority)
          if (!labelFound && (entry.label || entry.sessionLabel)) {
            const raw = (entry.label || entry.sessionLabel)?.toString().trim();
            if (raw && raw.length > 0) {
              result.label = raw.slice(0, 255);
              labelFound = true;
            }
          }

          const msg = entry.message as Record<string, unknown> | undefined;
          if (!msg) return;

          const role = msg.role as string | undefined;

          // Count messages
          if (role === 'user' || role === 'assistant' || role === 'toolResult') {
            result.messageCount++;
          }

          // Count tool calls (within assistant message content blocks)
          if (role === 'assistant' && Array.isArray(msg.content)) {
            for (const block of msg.content as any[]) {
              if (block.type === 'toolCall') result.toolCallCount++;
            }
          }

          // Model — use first real occurrence (skip internal/synthetic models)
          if (!result.model && msg.model) {
            const m = String(msg.model);
            if (!SYNTHETIC_MODELS.has(m)) {
              result.model = m;
            }
          }

          // Token usage
          const usage = msg.usage as Record<string, unknown> | undefined;
          if (usage) {
            result.inputTokens +=
              (usage.input_tokens as number) ??
              (usage.inputTokens as number) ??
              (usage.input as number) ?? 0;
            result.outputTokens +=
              (usage.output_tokens as number) ??
              (usage.outputTokens as number) ??
              (usage.output as number) ?? 0;
            result.thinkingTokens +=
              (usage.thinking_tokens as number) ??
              (usage.thinkingTokens as number) ?? 0;
            result.cacheReadTokens +=
              (usage.cache_read_input_tokens as number) ??
              (usage.cacheReadInputTokens as number) ??
              (usage.cacheRead as number) ?? 0;
          }

          // Cost
          if (entry.cost !== undefined) {
            result.totalCostUsd +=
              typeof entry.cost === 'number'
                ? entry.cost
                : parseFloat(String(entry.cost)) || 0;
          }

          // Label from first user message (fallback)
          if (!labelFound && role === 'user') {
            let content = msg.content;
            if (Array.isArray(content)) {
              content = (content as any[])
                .filter((c) => c.type === 'text')
                .map((c) => c.text as string)
                .join(' ');
            }
            if (typeof content === 'string' && content.length > 0) {
              const extracted = extractLabelFromContent(content);
              if (extracted) {
                result.label = extracted;
                labelFound = true;
              }
            }
          }
        } catch {
          // Skip unparseable lines
        }
      });

      rl.on('close', () => {
        result.endedAt = result.lastActivityAt;
        resolve(result);
      });

      rl.on('error', () => resolve(null));
    });
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Lock file helpers (live state detection)
// ─────────────────────────────────────────────────────────────────

function hasLockFile(transcriptsDir: string, sessionId: string): boolean {
  const lockPath = path.join(transcriptsDir, `${sessionId}.jsonl.lock`);
  try {
    fs.accessSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
// SessionIngester
// ─────────────────────────────────────────────────────────────────

export class SessionIngester extends EventEmitter {
  private sessionsJsonPath: string;
  private transcriptsDir: string;

  /** In-memory copy of the last-read sessions.json, used for diffing. */
  private currentSessions: Record<string, SessionsJsonEntry> = {};

  /** Lock state per sessionId — tracks idle/busy transitions. */
  private lockStates: Map<string, boolean> = new Map();

  /** Watcher handles */
  private sessionsJsonWatcher: fs.FSWatcher | null = null;
  private transcriptDirWatcher: fs.FSWatcher | null = null;

  /** Debounce timers */
  private sessionsJsonDebounce: NodeJS.Timeout | null = null;
  private jsonlDebounces: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    sessionsJsonPath = SESSIONS_JSON_PATH,
    transcriptsDir = TRANSCRIPTS_DIR
  ) {
    super();
    this.sessionsJsonPath = sessionsJsonPath;
    this.transcriptsDir = transcriptsDir;
  }

  // ── Public API ─────────────────────────────────────────────────

  /** Start the ingester: run startup digest, then begin live watchers. */
  async start(): Promise<void> {
    console.log('🗄️  SessionIngester: Starting...');
    console.log(`   sessions.json: ${this.sessionsJsonPath}`);
    console.log(`   transcripts:   ${this.transcriptsDir}`);
    await this._runStartupDigest();
    await this._reconcileEphemeralSessions();
    this._startWatchers();
    console.log('✅ SessionIngester: Running');
  }

  /** Stop all watchers and debounce timers. */
  stop(): void {
    console.log('🛑 SessionIngester: Stopping...');
    if (this.sessionsJsonWatcher) {
      this.sessionsJsonWatcher.close();
      this.sessionsJsonWatcher = null;
    }
    if (this.transcriptDirWatcher) {
      this.transcriptDirWatcher.close();
      this.transcriptDirWatcher = null;
    }
    if (this.sessionsJsonDebounce) {
      clearTimeout(this.sessionsJsonDebounce);
      this.sessionsJsonDebounce = null;
    }
    for (const t of this.jsonlDebounces.values()) clearTimeout(t);
    this.jsonlDebounces.clear();
  }

  // ── Startup reconciliation ─────────────────────────────────────

  /**
   * On startup, reconcile ephemeral sessions (cron, subagent, acp) that are
   * marked 'active' in DB but have no lock file — they're actually done.
   *
   * This handles the case where:
   *   1. A cron session finished while ClawBoard was down
   *   2. Gateway restarted and lost in-memory state
   *   3. The session:ended event was missed
   *
   * Lock files (.jsonl.lock) are the ground truth for whether a session is alive.
   */
  private async _reconcileEphemeralSessions(): Promise<void> {
    try {
      // Find all 'active' ephemeral sessions in DB
      const result = await pool.query(
        `SELECT session_key, session_id
         FROM sessions
         WHERE status = 'active'
           AND kind IN ('cron', 'subagent', 'acp')`
      );

      if (result.rows.length === 0) return;

      let reconciled = 0;
      for (const row of result.rows) {
        const sessionId = row.session_id ? String(row.session_id) : null;
        if (!sessionId) continue;

        // Check if a lock file exists — if not, session is dead
        const isAlive = hasLockFile(this.transcriptsDir, sessionId);
        if (!isAlive) {
          await pool.query(
            `UPDATE sessions
             SET status = 'completed', ended_at = COALESCE(ended_at, last_activity_at, NOW()), updated_at = NOW()
             WHERE session_key = $1 AND status = 'active'`,
            [row.session_key]
          );
          reconciled++;
          this.emit('session:completed', { sessionKey: row.session_key });
        }
      }

      if (reconciled > 0) {
        console.log(`🔄 SessionIngester: Reconciled ${reconciled} dead ephemeral sessions → completed`);
      }
    } catch (err) {
      console.warn('⚠️  SessionIngester: Reconciliation failed:', (err as Error).message);
    }
  }

  // ── Startup Digest ─────────────────────────────────────────────

  private async _runStartupDigest(): Promise<void> {
    console.log('📇 SessionIngester: Running startup digest...');

    // Step 1: Read sessions.json
    const sessionsJson = this._readSessionsJson();
    this.currentSessions = sessionsJson;
    const knownSessionIds = new Set<string>();

    // Step 2: UPSERT all sessions from sessions.json (status = 'active')
    let upsertCount = 0;
    for (const [sessionKey, entry] of Object.entries(sessionsJson)) {
      const sessionId = entry.sessionId;
      if (!sessionId) continue;
      knownSessionIds.add(sessionId);

      const transcriptPath = this._resolveTranscriptPath(entry, sessionId, sessionKey);
      let stats: JournalStats | null = null;
      if (transcriptPath && fs.existsSync(transcriptPath)) {
        stats = await parseJSONLStats(transcriptPath);
      }

      await this._upsertSession(sessionKey, entry, transcriptPath, stats, 'active');
      upsertCount++;
    }

    // Step 3: Scan for orphan JSONL files
    const orphanCount = await this._scanOrphans(knownSessionIds);

    console.log(
      `📇 SessionIngester: Startup digest complete — ` +
      `${upsertCount} active sessions upserted, ${orphanCount} orphans indexed`
    );
  }

  // ── Orphan JSONL scanner ────────────────────────────────────────

  /**
   * Scan the transcripts directory for JSONL files that don't correspond to
   * any session currently in sessions.json. These are historical/deleted sessions.
   */
  private async _scanOrphans(knownSessionIds: Set<string>): Promise<number> {
    let orphanCount = 0;

    let files: string[];
    try {
      files = fs.readdirSync(this.transcriptsDir);
    } catch (err) {
      console.warn('⚠️  SessionIngester: Cannot read transcripts dir:', (err as Error).message);
      return 0;
    }

    // Match both active (.jsonl) and completed (.jsonl.deleted.<timestamp>) transcripts
    const jsonlFiles = files.filter(
      f => (f.endsWith('.jsonl') || f.includes('.jsonl.deleted.')) &&
        !f.endsWith('.lock') &&
        !f.includes('.checkpoint.')
    );

    // Deduplicate: if both UUID.jsonl and UUID.jsonl.deleted.* exist, prefer .jsonl
    const seenOrphanIds = new Set<string>();

    for (const file of jsonlFiles) {
      // Extract sessionId from either "UUID.jsonl" or "UUID.jsonl.deleted.TIMESTAMP"
      const sessionId = file.split('.jsonl')[0];
      if (knownSessionIds.has(sessionId)) continue; // already covered
      if (seenOrphanIds.has(sessionId)) continue;    // already processed this orphan
      seenOrphanIds.add(sessionId);

      const filePath = path.join(this.transcriptsDir, file);
      try {
        const stats = await parseJSONLStats(filePath);
        if (!stats) continue;
        await this._upsertOrphanSession(sessionId, filePath, stats);
        orphanCount++;
      } catch (err) {
        console.warn(
          `⚠️  SessionIngester: Failed to index orphan ${sessionId}:`,
          (err as Error).message
        );
      }
    }

    return orphanCount;
  }

  // ── Watchers ───────────────────────────────────────────────────

  private _startWatchers(): void {
    // Watch sessions.json
    try {
      this.sessionsJsonWatcher = fs.watch(
        this.sessionsJsonPath,
        { persistent: true },
        () => this._scheduleSessionsJsonUpdate()
      );
    } catch (err) {
      console.warn(
        '⚠️  SessionIngester: Cannot watch sessions.json:',
        (err as Error).message
      );
    }

    // Watch transcripts directory for JSONL and lock file changes
    try {
      this.transcriptDirWatcher = fs.watch(
        this.transcriptsDir,
        { persistent: true, recursive: false },
        (_event, filename) => {
          if (!filename) return;

          // Lock files → live state detection only (don't update DB)
          if (filename.endsWith('.jsonl.lock')) {
            this._handleLockChange(filename);
            return;
          }

          // Active JSONL files → debounced stats update.
          // Ignore checkpoint artifacts (e.g. <uuid>.checkpoint.<uuid>.jsonl), which are
          // not real session IDs and will fail UUID parsing if treated as orphan sessions.
          if (filename.endsWith('.jsonl') && !filename.endsWith('.lock') && !filename.includes('.checkpoint.')) {
            const sessionId = filename.replace('.jsonl', '');
            this._scheduleJSONLUpdate(
              sessionId,
              path.join(this.transcriptsDir, filename)
            );
          }
        }
      );
    } catch (err) {
      console.warn(
        '⚠️  SessionIngester: Cannot watch transcripts dir:',
        (err as Error).message
      );
    }
  }

  // ── sessions.json change handler ───────────────────────────────

  private _scheduleSessionsJsonUpdate(): void {
    if (this.sessionsJsonDebounce) return;
    this.sessionsJsonDebounce = setTimeout(async () => {
      this.sessionsJsonDebounce = null;
      await this._onSessionsJsonChange();
    }, DEBOUNCE_MS);
  }

  private async _onSessionsJsonChange(): Promise<void> {
    const newSessions = this._readSessionsJson();
    const oldKeys = new Set(Object.keys(this.currentSessions));
    const newKeys = new Set(Object.keys(newSessions));

    // Detect added/changed sessions
    for (const [sessionKey, entry] of Object.entries(newSessions)) {
      const old = this.currentSessions[sessionKey];
      const changed =
        !old ||
        old.sessionId !== entry.sessionId ||
        (old.updatedAt ?? 0) !== (entry.updatedAt ?? 0) ||
        old.label !== entry.label ||
        old.model !== entry.model;

      if (changed) {
        const sessionId = entry.sessionId;
        if (!sessionId) continue;

        const transcriptPath = this._resolveTranscriptPath(entry, sessionId, sessionKey);
        let stats: JournalStats | null = null;
        if (transcriptPath && fs.existsSync(transcriptPath)) {
          stats = await parseJSONLStats(transcriptPath);
        }
        await this._upsertSession(sessionKey, entry, transcriptPath, stats, 'active');

        // Clean up orphan record if one was created before sessions.json was updated
        // (race: JSONL file appears → orphan created with UUID key → sessions.json links it)
        if (sessionKey !== sessionId) {
          await this._deleteOrphanIfExists(sessionId);
        }
      }
    }

    // Detect removed sessions → mark completed
    for (const key of oldKeys) {
      if (!newKeys.has(key)) {
        await this._markCompleted(key);
      }
    }

    this.currentSessions = newSessions;
  }

  // ── JSONL file change handler ───────────────────────────────────

  private _scheduleJSONLUpdate(sessionId: string, filePath: string): void {
    if (this.jsonlDebounces.has(sessionId)) return;
    const t = setTimeout(async () => {
      this.jsonlDebounces.delete(sessionId);
      await this._onJSONLChange(sessionId, filePath);
    }, DEBOUNCE_MS);
    this.jsonlDebounces.set(sessionId, t);
  }

  private async _onJSONLChange(sessionId: string, filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) return;

    // Find which sessions.json entry this belongs to
    const sessionKey = this._findKeyBySessionId(sessionId);

    if (!sessionKey) {
      // Not in currentSessions yet — sessions.json may not have been processed.
      // Re-read sessions.json to catch the common /new race condition.
      const freshSessions = this._readSessionsJson();
      const freshKey = Object.entries(freshSessions).find(
        ([, e]) => e.sessionId === sessionId
      )?.[0];

      if (freshKey) {
        // sessions.json already has it — update our cache and upsert properly
        this.currentSessions = freshSessions;
        const entry = freshSessions[freshKey];
        const stats = await parseJSONLStats(filePath);
        if (stats) await this._upsertSession(freshKey, entry, filePath, stats, 'active');
        return;
      }

      // Truly orphaned — update its stats
      const stats = await parseJSONLStats(filePath);
      if (stats) await this._upsertOrphanSession(sessionId, filePath, stats);
      return;
    }

    const entry = this.currentSessions[sessionKey];
    if (!entry) return;

    const stats = await parseJSONLStats(filePath);
    if (stats) {
      await this._upsertSession(sessionKey, entry, filePath, stats, 'active');
    }
  }

  // ── Lock file / live state handler ─────────────────────────────

  private _handleLockChange(filename: string): void {
    // filename is e.g. "d3ccf672-613f-4a51-b06d-2e5ec1de7e49.jsonl.lock"
    const match = filename.match(/^(.+)\.jsonl\.lock$/);
    if (!match) return;
    const sessionId = match[1];

    const isActive = hasLockFile(this.transcriptsDir, sessionId);
    const wasActive = this.lockStates.get(sessionId) ?? false;

    if (isActive !== wasActive) {
      this.lockStates.set(sessionId, isActive);
      const sessionKey = this._findKeyBySessionId(sessionId);
      if (sessionKey) {
        this.emit('session:live-state', { sessionKey, sessionId, isActive });

        // When a lock file disappears for an ephemeral session, mark it completed in DB.
        // This is a reliable fallback — even if we missed the cron:finished or chat:final event.
        if (!isActive && wasActive) {
          const kind = deriveKind(sessionKey);
          if (kind === 'cron' || kind === 'subagent' || kind === 'acp') {
            this._markCompleted(sessionKey).catch(() => {});
          }
        }
      }
    }
  }

  // ── DB helpers ─────────────────────────────────────────────────

  /**
   * UPSERT a session from sessions.json + JSONL stats into the sessions table.
   */
  private async _upsertSession(
    sessionKey: string,
    entry: Partial<SessionsJsonEntry>,
    transcriptPath: string | null,
    stats: JournalStats | null,
    status: 'active' | 'completed' | 'unknown'
  ): Promise<void> {
    try {
      const sessionId = entry.sessionId;
      if (!sessionId) return;

      const kind = deriveKind(sessionKey);
      const channel = entry.origin?.provider ?? entry.channel ?? null;
      const model = stats?.model ?? entry.model ?? null;

      // Label priority:
      //   1. sessions.json label field (authoritative)
      //   2. JSONL gateway-provided label (from parseJSONLStats)
      //   3. First meaningful user message (from parseJSONLStats)
      //   4. Fallback: Kind + date string
      let label: string | null = entry.label ?? stats?.label ?? null;
      if (!label && kind !== 'unknown') {
        const kindLabel = kind.charAt(0).toUpperCase() + kind.slice(1);
        const ts = stats?.startedAt
          ? new Date(stats.startedAt).toLocaleDateString('en-GB', {
              day: '2-digit',
              month: 'short',
            })
          : '';
        label = ts ? `${kindLabel}: ${ts}` : kindLabel;
      }

      // Build spawn_info JSONB
      const spawnInfo: Record<string, unknown> = {};
      if (entry.spawnedBy) spawnInfo.spawnedBy = entry.spawnedBy;
      if (entry.spawnDepth !== undefined) spawnInfo.spawnDepth = entry.spawnDepth;
      if (entry.chatType) spawnInfo.chatType = entry.chatType;

      const deliveryCtx = entry.deliveryContext;
      const origin = entry.origin;
      if (deliveryCtx) {
        spawnInfo.deliveryContext = deliveryCtx;
      } else if (origin?.to || origin?.provider) {
        spawnInfo.deliveryContext = {
          channel: origin.provider,
          from: origin.from,
          to: origin.to,
          accountId: origin.accountId,
        };
      }
      if (origin) {
        spawnInfo.origin = origin;
      }

      const harness = deriveSessionHarness({ sessionKey, kind, spawnInfo });
      const sessionType = deriveSessionType({ sessionKey, kind, harness });
      label = getSessionDisplayLabel({
        sessionKey,
        label,
        harness,
        sessionType,
      });

      // Determine effective transcript path
      const effectivePath =
        transcriptPath && fs.existsSync(transcriptPath) ? transcriptPath : null;

      await pool.query(
        `INSERT INTO sessions (
          session_key, session_id, kind, channel, label, model, status, spawn_info,
          message_count, tool_call_count,
          input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_cost_usd,
          started_at, ended_at, last_activity_at,
          file_size, transcript_path,
          agent_type_id,
          created_at, updated_at
        ) VALUES (
          $1, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb,
          $9, $10, $11, $12, $13, $14, $15,
          $16::timestamptz, $17::timestamptz, $18::timestamptz,
          $19, $20,
          ${taskAgentTypeSubquery(21)},
          NOW(), NOW()
        )
        ON CONFLICT (session_key) DO UPDATE SET
          session_id        = EXCLUDED.session_id,
          kind              = EXCLUDED.kind,
          channel           = COALESCE(EXCLUDED.channel, sessions.channel),
          label             = COALESCE(EXCLUDED.label, sessions.label),
          model             = COALESCE(EXCLUDED.model, sessions.model),
          status            = EXCLUDED.status,
          spawn_info        = EXCLUDED.spawn_info,
          message_count     = EXCLUDED.message_count,
          tool_call_count   = EXCLUDED.tool_call_count,
          input_tokens      = EXCLUDED.input_tokens,
          output_tokens     = EXCLUDED.output_tokens,
          thinking_tokens   = EXCLUDED.thinking_tokens,
          cache_read_tokens = EXCLUDED.cache_read_tokens,
          total_cost_usd    = EXCLUDED.total_cost_usd,
          started_at        = COALESCE(EXCLUDED.started_at, sessions.started_at),
          ended_at          = EXCLUDED.ended_at,
          last_activity_at  = EXCLUDED.last_activity_at,
          file_size         = EXCLUDED.file_size,
          transcript_path   = COALESCE(EXCLUDED.transcript_path, sessions.transcript_path),
          agent_type_id     = COALESCE(sessions.agent_type_id, EXCLUDED.agent_type_id),
          updated_at        = NOW()`,
        [
          sessionKey,
          sessionId,
          kind,
          channel,
          label,
          model,
          status,
          JSON.stringify(spawnInfo),
          stats?.messageCount ?? 0,
          stats?.toolCallCount ?? 0,
          stats?.inputTokens ?? 0,
          stats?.outputTokens ?? 0,
          stats?.thinkingTokens ?? 0,
          stats?.cacheReadTokens ?? 0,
          stats?.totalCostUsd ?? 0,
          stats?.startedAt ?? null,
          stats?.endedAt ?? null,
          stats?.lastActivityAt ?? null,
          stats?.fileSize ?? null,
          effectivePath,
          agentTypeStampAliases(sessionKey),
        ]
      );

      // Live canonical ingestion is limited to task-owned sessions. Historical
      // backfill is a separate bounded workflow; feeding every legacy transcript
      // through the adapter at startup would make availability depend on an
      // unbounded archive scan.
      const aliases = [sessionKey, sessionId];
      const linkedTask = await pool.query(
        `SELECT 1 FROM tasks t
          WHERE t.acp_session_key = ANY($1::text[])
             OR (jsonb_typeof(t.session_refs) = 'array' AND t.session_refs ?| $1::text[])
             OR t.completed_by->>'sessionKey' = ANY($1::text[])
             OR t.active_agent->>'sessionKey' = ANY($1::text[])
          LIMIT 1`,
        [aliases],
      );
      if ((linkedTask.rowCount ?? 0) > 0 && effectivePath) {
        try {
          await openClawCanonicalAdapter.ingestSessionFile(
            sessionKey,
            entry as SessionsJsonEntry,
            this.transcriptsDir,
          );
        } catch (canonicalError) {
          console.warn(`Canonical OpenClaw ingestion failed for ${sessionKey}:`, (canonicalError as Error).message);
        }
      }

      this.emit('session:upserted', { sessionKey, sessionId, status, kind });
    } catch (err) {
      console.error(
        `❌ SessionIngester: Failed to upsert ${sessionKey}:`,
        (err as Error).message
      );
    }
  }

  /**
   * UPSERT an orphan session (JSONL file with no sessions.json entry).
   * Uses the sessionId UUID as the session_key, status='unknown'.
   */
  private async _upsertOrphanSession(
    sessionId: string,
    filePath: string,
    stats: JournalStats
  ): Promise<void> {
    try {
      // For orphans we don't have a human-readable session_key, so use the UUID.
      // This is deterministic and ensures each orphan has a stable identity.
      const sessionKey = sessionId;

      await pool.query(
        `INSERT INTO sessions (
          session_key, session_id, kind, status, spawn_info,
          message_count, tool_call_count,
          input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_cost_usd,
          started_at, ended_at, last_activity_at,
          file_size, transcript_path, label, model,
          created_at, updated_at
        ) VALUES (
          $1, $2::uuid, 'unknown', 'unknown', '{}'::jsonb,
          $3, $4, $5, $6, $7, $8, $9,
          $10::timestamptz, $11::timestamptz, $12::timestamptz,
          $13, $14, $15, $16,
          NOW(), NOW()
        )
        ON CONFLICT (session_key) DO UPDATE SET
          message_count     = EXCLUDED.message_count,
          tool_call_count   = EXCLUDED.tool_call_count,
          input_tokens      = EXCLUDED.input_tokens,
          output_tokens     = EXCLUDED.output_tokens,
          thinking_tokens   = EXCLUDED.thinking_tokens,
          cache_read_tokens = EXCLUDED.cache_read_tokens,
          total_cost_usd    = EXCLUDED.total_cost_usd,
          started_at        = COALESCE(EXCLUDED.started_at, sessions.started_at),
          ended_at          = EXCLUDED.ended_at,
          last_activity_at  = EXCLUDED.last_activity_at,
          file_size         = EXCLUDED.file_size,
          label             = COALESCE(EXCLUDED.label, sessions.label),
          model             = COALESCE(EXCLUDED.model, sessions.model),
          updated_at        = NOW()`,
        [
          sessionKey,
          sessionId,
          stats.messageCount,
          stats.toolCallCount,
          stats.inputTokens,
          stats.outputTokens,
          stats.thinkingTokens,
          stats.cacheReadTokens,
          stats.totalCostUsd,
          stats.startedAt,
          stats.endedAt,
          stats.lastActivityAt,
          stats.fileSize,
          filePath,
          stats.label,
          stats.model,
        ]
      );
    } catch (err) {
      console.error(
        `❌ SessionIngester: Failed to upsert orphan ${sessionId}:`,
        (err as Error).message
      );
    }
  }

  /**
   * Mark a session as completed when its key disappears from sessions.json.
   */
  private async _markCompleted(sessionKey: string): Promise<void> {
    try {
      const result = await pool.query(
        `UPDATE sessions
         SET status = 'completed', ended_at = NOW(), updated_at = NOW()
         WHERE session_key = $1 AND status = 'active'`,
        [sessionKey]
      );
      if ((result.rowCount ?? 0) > 0) {
        console.log(`📦 SessionIngester: Marked completed: ${sessionKey}`);
        this.emit('session:completed', { sessionKey });
      }
    } catch (err) {
      console.error(
        `❌ SessionIngester: Failed to mark completed ${sessionKey}:`,
        (err as Error).message
      );
    }
  }

  // ── Utility helpers ────────────────────────────────────────────

  private _readSessionsJson(): Record<string, SessionsJsonEntry> {
    try {
      const raw = fs.readFileSync(this.sessionsJsonPath, 'utf-8');
      return JSON.parse(raw) as Record<string, SessionsJsonEntry>;
    } catch (err) {
      console.warn(
        '⚠️  SessionIngester: Cannot read sessions.json:',
        (err as Error).message
      );
      return {};
    }
  }

  /**
   * Resolve the JSONL transcript path for a sessions.json entry.
   * Priority:
   *   1. entry.sessionFile (absolute path stored by OpenClaw)
   *   2. <transcriptsDir>/<sessionId>.jsonl (conventional)
   *   3. <transcriptsDir>/<sessionId>.jsonl.deleted.<timestamp> (OpenClaw renames after completion)
   *   4. Parent cron session's transcript (for :run: child sessions)
   */
  private _resolveTranscriptPath(
    entry: Partial<SessionsJsonEntry>,
    sessionId: string,
    sessionKey?: string
  ): string | null {
    // 1. Explicit sessionFile from OpenClaw
    if (entry.sessionFile && typeof entry.sessionFile === 'string') {
      if (fs.existsSync(entry.sessionFile)) return entry.sessionFile;
    }

    // 2. Conventional path
    const conventional = path.join(this.transcriptsDir, `${sessionId}.jsonl`);
    if (fs.existsSync(conventional)) return conventional;

    // 3. Deleted/renamed variant
    const deleted = this._findDeletedTranscript(sessionId);
    if (deleted) return deleted;

    // 4. For :run: child sessions, fall back to parent cron session's transcript
    //    e.g. agent:main:cron:a68ace61:run:9cb4c3d0 → parent key = agent:main:cron:a68ace61
    if (sessionKey && sessionKey.includes(':run:')) {
      const runIdx = sessionKey.lastIndexOf(':run:');
      const parentKey = sessionKey.slice(0, runIdx);
      const parentEntry = this.currentSessions[parentKey];
      if (parentEntry?.sessionId) {
        return this._resolveTranscriptPath(parentEntry, parentEntry.sessionId);
      }
    }

    return null;
  }

  /**
   * Find a transcript that OpenClaw renamed after session completion.
   * OpenClaw renames: <id>.jsonl → <id>.jsonl.deleted.<timestamp>
   */
  private _findDeletedTranscript(sessionId: string): string | null {
    try {
      const prefix = `${sessionId}.jsonl.deleted.`;
      const files = fs.readdirSync(this.transcriptsDir);
      const match = files.find(f => f.startsWith(prefix));
      return match ? path.join(this.transcriptsDir, match) : null;
    } catch {
      return null;
    }
  }

  /**
   * Find the sessions.json session_key that maps to a given sessionId UUID.
   * Used when a JSONL file change comes in and we need to find its owner.
   */
  /**
   * Remove an orphan DB record (keyed by sessionId UUID) when the proper
   * session_key entry is established via sessions.json.
   */
  private async _deleteOrphanIfExists(sessionId: string): Promise<void> {
    try {
      const result = await pool.query(
        `DELETE FROM sessions WHERE session_key = $1 AND kind = 'unknown'`,
        [sessionId]
      );
      if (result.rowCount && result.rowCount > 0) {
        console.log(`🧹 SessionIngester: Cleaned up orphan record for ${sessionId.substring(0, 8)}...`);
      }
    } catch (err) {
      // Non-fatal — orphan may already be gone
    }
  }

  private _findKeyBySessionId(sessionId: string): string | null {
    for (const [key, entry] of Object.entries(this.currentSessions)) {
      if (entry.sessionId === sessionId) return key;
    }
    return null;
  }

  /** Diagnostic stats. */
  getStats() {
    return {
      trackedSessions: Object.keys(this.currentSessions).length,
      lockStates: Object.fromEntries(this.lockStates),
    };
  }
}

// Singleton instance (mirrors pattern used by TranscriptIngester)
export const sessionIngester = new SessionIngester();
