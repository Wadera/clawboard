/**
 * TranscriptIngester — Reads OpenClaw JSONL transcripts and persists messages
 * to the session_messages table.
 *
 * TWO MODES:
 *   LIVE:  File-tail watcher for active sessions (debounced, 500ms minimum).
 *          Tracks byte offsets so we never re-read already-ingested lines.
 *   BATCH: Called explicitly when a session completes; reads the full file
 *          and bulk-inserts all messages in one transaction.
 *
 * JSONL FORMAT (OpenClaw v3 transcript):
 *   Each line is a JSON object.  We care about lines where type === "message".
 *   The message object has:
 *     role: "user" | "assistant" | "toolResult"
 *     content: array of content blocks, e.g.
 *       {type:"text", text: "..."}
 *       {type:"thinking", thinking: "..."}
 *       {type:"toolCall", id, name, arguments}
 *   Tool results are messages with role:"toolResult" and toolCallId set.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { EventEmitter } from 'events';
import { pool } from '../db/connection';
import { sessionMessageRepository } from './SessionMessageRepository';
import { agentTypeStampAliases, taskAgentTypeSubquery } from './SessionIngester';
import type { NewSessionMessage, MessageRole } from '../types/SessionMessage';

const TRANSCRIPTS_DIR =
  process.env.OPENCLAW_TRANSCRIPTS_DIR ||
  process.env.CLAWDBOT_TRANSCRIPTS_DIR ||
  '/clawdbot/sessions';

const DEBOUNCE_MS = 500; // Never fire file watches faster than this

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

interface FileState {
  bytesRead: number;
  watcher: fs.FSWatcher | null;
  debounceTimer: NodeJS.Timeout | null;
  ingesting: boolean;
  lineCount: number;
}

/** Parsed representation of one meaningful JSONL entry. */
interface ParsedMessage {
  ordinal: number;
  role: MessageRole;
  content?: string;
  tool_name?: string;
  tool_call_id?: string;
  thinking?: string;
  tokens_in?: number;
  tokens_out?: number;
  created_at?: Date;
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────
// Content-block helpers
// ─────────────────────────────────────────────────────────────────

function extractText(blocks: unknown[]): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null)
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n');
}

function extractThinking(blocks: unknown[]): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const parts = blocks
    .filter((b): b is { type: string; thinking?: string } => typeof b === 'object' && b !== null)
    .filter(b => b.type === 'thinking' && typeof b.thinking === 'string')
    .map(b => b.thinking as string);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function extractToolCalls(blocks: unknown[]): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter(
      (b): b is { type: string; id: string; name: string; arguments: unknown } =>
        typeof b === 'object' && b !== null && (b as any).type === 'toolCall'
    )
    .map(b => ({ id: b.id, name: b.name, input: b.arguments }));
}

// ─────────────────────────────────────────────────────────────────
// Line parser
// ─────────────────────────────────────────────────────────────────

/**
 * Parse a single JSONL line into zero or more ParsedMessages.
 * Returns empty array for non-message lines or malformed input.
 */
function parseLine(line: string, ordinal: number): ParsedMessage[] {
  if (!line.trim()) return [];

  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line);
  } catch {
    return []; // skip malformed JSON silently
  }

  if (entry.type !== 'message') return [];

  const msg = entry.message as Record<string, unknown> | undefined;
  if (!msg) return [];

  const role = msg.role as string;
  const timestamp = (entry.timestamp as string | undefined) || (msg.timestamp as string | undefined);
  const created_at = timestamp ? new Date(timestamp) : undefined;
  const rawContent = msg.content;
  const contentBlocks: unknown[] = Array.isArray(rawContent) ? rawContent : [];
  const results: ParsedMessage[] = [];

  if (role === 'user') {
    const text = typeof rawContent === 'string' ? rawContent : extractText(contentBlocks);
    if (text) results.push({ ordinal, role: 'user', content: text, created_at });

  } else if (role === 'assistant') {
    const usage = msg.usage as Record<string, unknown> | undefined;
    const tokens_in = typeof usage?.input === 'number' ? usage.input : undefined;
    const tokens_out = typeof usage?.output === 'number' ? usage.output : undefined;
    const model = msg.model as string | undefined;
    const stop_reason = msg.stopReason as string | undefined;
    const thinking = extractThinking(contentBlocks);
    const text = typeof rawContent === 'string' ? rawContent : extractText(contentBlocks);

    results.push({
      ordinal,
      role: 'assistant',
      content: text || undefined,
      thinking,
      tokens_in,
      tokens_out,
      created_at,
      metadata: {
        ...(model ? { model } : {}),
        ...(stop_reason ? { finish_reason: stop_reason } : {}),
      },
    });

    // Each tool call gets its own row
    const toolCalls = extractToolCalls(contentBlocks);
    for (const tc of toolCalls) {
      results.push({
        ordinal, // same ordinal as assistant turn
        role: 'tool',
        content: JSON.stringify(tc.input),
        tool_name: tc.name,
        tool_call_id: tc.id,
        created_at,
      });
    }

  } else if (role === 'toolResult') {
    const toolCallId = msg.toolCallId as string | undefined;
    const toolName = msg.toolName as string | undefined;
    const isError = msg.isError === true;
    let content: string | undefined;
    if (Array.isArray(rawContent)) {
      content = extractText(rawContent);
    } else if (typeof rawContent === 'string') {
      content = rawContent;
    }
    results.push({
      ordinal,
      role: 'tool',
      content,
      tool_name: toolName,
      tool_call_id: toolCallId,
      created_at,
      metadata: isError ? { is_error: true } : undefined,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────
// Session ID resolver (cached)
// ─────────────────────────────────────────────────────────────────

const sessionIdCache = new Map<string, string>();

async function resolveSessionId(sessionKey: string): Promise<string | null> {
  const cached = sessionIdCache.get(sessionKey);
  if (cached) return cached;
  try {
    const result = await pool.query<{ id: string }>(
      'SELECT id FROM sessions WHERE session_key = $1 LIMIT 1',
      [sessionKey]
    );
    if (result.rows.length > 0) {
      sessionIdCache.set(sessionKey, result.rows[0].id);
      return result.rows[0].id;
    }
  } catch (err) {
    console.error(`TranscriptIngester: DB error resolving session_id for ${sessionKey}:`, err);
  }
  return null;
}

/**
 * Ensure a session exists in the sessions table. If not found, inserts a minimal
 * stub record so that live ingestion can proceed. This handles cron-spawned agent
 * sessions that haven't been indexed yet by the 5-minute SessionIndexer sweep.
 */
async function ensureSessionInDB(
  sessionKey: string,
  transcriptPath: string,
  opts?: { label?: string; model?: string; kind?: string }
): Promise<string | null> {
  // Fast path: check cache first
  const cached = sessionIdCache.get(sessionKey);
  if (cached) return cached;

  try {
    // Try to find existing record
    const existing = await pool.query<{ id: string }>(
      'SELECT id FROM sessions WHERE session_key = $1 LIMIT 1',
      [sessionKey]
    );
    if (existing.rows.length > 0) {
      sessionIdCache.set(sessionKey, existing.rows[0].id);
      return existing.rows[0].id;
    }

    // Infer kind from session key pattern (e.g. agent:main:cron:UUID:run:XXX)
    const inferredKind = opts?.kind ?? (
      sessionKey.includes(':cron:') && sessionKey.includes(':run:') ? 'subagent' :
      sessionKey.includes(':cron:') ? 'cron' :
      sessionKey.includes(':subagent:') ? 'subagent' :
      sessionKey.includes(':heartbeat') ? 'heartbeat' :
      'main'
    );

    // Upsert a minimal stub so live ingestion can proceed.
    // Persona analytics: stamp the owning task's agent_type_id at creation
    // time when a task already references this session key.
    const insert = await pool.query<{ id: string }>(
      `INSERT INTO sessions (session_key, status, transcript_path, label, model, kind, agent_type_id, created_at, updated_at)
       VALUES ($1, 'active', $2, $3, $4, $5, ${taskAgentTypeSubquery(6)}, NOW(), NOW())
       ON CONFLICT (session_key) DO UPDATE
         SET updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [
        sessionKey,
        transcriptPath,
        opts?.label ?? null,
        opts?.model ?? null,
        inferredKind,
        agentTypeStampAliases(sessionKey),
      ]
    );

    const id = insert.rows[0]?.id ?? null;
    if (id) {
      sessionIdCache.set(sessionKey, id);
      console.log(`TranscriptIngester: 🆕 Created stub session record for ${sessionKey} (kind=${inferredKind})`);
    }
    return id;
  } catch (err) {
    console.error(`TranscriptIngester: Failed to ensure session in DB for ${sessionKey}:`, err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// File readers
// ─────────────────────────────────────────────────────────────────

async function readAllMessages(filePath: string): Promise<ParsedMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: ParsedMessage[] = [];
    let ordinal = 0;
    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => { ordinal++; messages.push(...parseLine(line, ordinal)); });
      rl.on('close', () => resolve(messages));
      rl.on('error', reject);
      stream.on('error', reject);
    } catch (err) { reject(err); }
  });
}

async function readNewMessages(
  filePath: string,
  fromByte: number,
  baseOrdinal: number
): Promise<{ messages: ParsedMessage[]; newOffset: number }> {
  return new Promise((resolve, reject) => {
    const messages: ParsedMessage[] = [];
    let ordinal = baseOrdinal;
    try {
      let size: number;
      try { size = fs.statSync(filePath).size; } catch { return resolve({ messages: [], newOffset: fromByte }); }
      if (size <= fromByte) return resolve({ messages: [], newOffset: fromByte });

      const stream = fs.createReadStream(filePath, { encoding: 'utf-8', start: fromByte });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => { ordinal++; messages.push(...parseLine(line, ordinal)); });
      rl.on('close', () => resolve({ messages, newOffset: size }));
      rl.on('error', reject);
      stream.on('error', reject);
    } catch (err) { reject(err); }
  });
}

// ─────────────────────────────────────────────────────────────────
// TranscriptIngester
// ─────────────────────────────────────────────────────────────────

export class TranscriptIngester extends EventEmitter {
  private fileStates: Map<string, FileState> = new Map();
  private ingested: Set<string> = new Set();
  /** BUG-07c: track sessions currently being initialized to avoid double-start races */
  private pendingWatches: Set<string> = new Set();

  // ── Batch ingest ──────────────────────────────────────────────

  /**
   * Batch-ingest a completed session transcript.
   * Idempotent: skips if already ingested or if messages already exist in DB.
   */
  async ingestCompleted(sessionKey: string, transcriptPath?: string): Promise<void> {
    if (this.ingested.has(sessionKey)) return;

    const filePath = this._resolvePath(sessionKey, transcriptPath);
    if (!fs.existsSync(filePath)) {
      console.warn(`TranscriptIngester: File not found for batch ingest: ${filePath}`);
      return;
    }

    // Stop live watcher to avoid races
    this.stopLiveWatch(sessionKey);

    try {
      // Use ensureSessionInDB so we create a stub record for sessions not yet indexed by
      // SessionIndexer (cron-spawned agents that complete before the 5-minute sweep).
      const session_id = await ensureSessionInDB(sessionKey, filePath);
      if (!session_id) {
        console.warn(`TranscriptIngester: Could not ensure session in DB for ${sessionKey} — skipping batch ingest`);
        return;
      }

      const existing = await sessionMessageRepository.countBySession(session_id);
      if (existing > 0) {
        console.log(`TranscriptIngester: ${sessionKey} already has ${existing} messages — skipping`);
        this.ingested.add(sessionKey);
        return;
      }

      const parsed = await readAllMessages(filePath);
      if (parsed.length === 0) { this.ingested.add(sessionKey); return; }

      const rows: NewSessionMessage[] = parsed.map(p => this._toRow(p, session_id, sessionKey));
      const result = await sessionMessageRepository.bulkInsert(rows);
      console.log(
        `TranscriptIngester: ✅ Batch-ingested ${result.inserted} messages for ${sessionKey} (${result.duration_ms}ms)`
      );
      this.ingested.add(sessionKey);
      this.emit('ingested', { sessionKey, session_id, count: result.inserted });
    } catch (err) {
      console.error(`TranscriptIngester: Batch ingest error for ${sessionKey}:`, err);
    }
  }

  // ── Live tail ─────────────────────────────────────────────────

  /**
   * Start tailing a transcript file and streaming new lines to DB.
   * No-op if already watching or already fully ingested.
   *
   * BUG-07c: Loads persisted byte offset from DB so we resume from where we
   * left off after a backend restart (instead of re-reading from byte 0).
   */
  startLiveWatch(sessionKey: string, transcriptPath?: string): void {
    if (
      this.ingested.has(sessionKey) ||
      this.fileStates.has(sessionKey) ||
      this.pendingWatches.has(sessionKey)
    ) return;

    const filePath = this._resolvePath(sessionKey, transcriptPath);
    if (!fs.existsSync(filePath)) {
      console.warn(`TranscriptIngester: Cannot watch — not found: ${filePath}`);
      return;
    }

    // Mark as pending to prevent race conditions while async state loads
    this.pendingWatches.add(sessionKey);

    // Load persisted offset async, then start watching
    this._loadPersistedState(sessionKey)
      .then(({ bytesRead, lineCount }) => {
        // Check again in case stop was called during async load
        if (this.ingested.has(sessionKey)) {
          this.pendingWatches.delete(sessionKey);
          return;
        }

        const state: FileState = {
          bytesRead,
          watcher: null,
          debounceTimer: null,
          ingesting: false,
          lineCount,
        };
        this.fileStates.set(sessionKey, state);
        this.pendingWatches.delete(sessionKey);

        if (bytesRead > 0) {
          console.log(`TranscriptIngester: 👁 Live watch resumed: ${sessionKey} (byte ${bytesRead})`);
        } else {
          console.log(`TranscriptIngester: 👁 Live watch started: ${sessionKey}`);
        }

        this._scheduleLiveRead(sessionKey, filePath, state);

        try {
          state.watcher = fs.watch(filePath, () => this._scheduleLiveRead(sessionKey, filePath, state));
          state.watcher.on('error', () => this.stopLiveWatch(sessionKey));
        } catch {
          console.warn(`TranscriptIngester: fs.watch unavailable for ${filePath}`);
        }
      })
      .catch((err) => {
        this.pendingWatches.delete(sessionKey);
        console.error(`TranscriptIngester: Failed to initialize watch for ${sessionKey}:`, err);
      });
  }

  /** BUG-07c: Load persisted byte offset from transcript_ingester_state table. */
  private async _loadPersistedState(sessionKey: string): Promise<{ bytesRead: number; lineCount: number }> {
    try {
      const result = await pool.query<{ bytes_read: string; line_count: string }>(
        'SELECT bytes_read, line_count FROM transcript_ingester_state WHERE session_key = $1',
        [sessionKey]
      );
      if (result.rows.length > 0) {
        return {
          bytesRead: parseInt(result.rows[0].bytes_read, 10) || 0,
          lineCount: parseInt(result.rows[0].line_count, 10) || 0,
        };
      }
    } catch (err) {
      console.warn(`TranscriptIngester: Could not load persisted state for ${sessionKey}:`, err);
    }
    return { bytesRead: 0, lineCount: 0 };
  }

  /** BUG-07c: Persist byte offset so restarts resume from correct position. */
  private async _persistState(sessionKey: string, bytesRead: number, lineCount: number): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO transcript_ingester_state (session_key, bytes_read, line_count, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (session_key) DO UPDATE
           SET bytes_read  = EXCLUDED.bytes_read,
               line_count  = EXCLUDED.line_count,
               updated_at  = NOW()`,
        [sessionKey, bytesRead, lineCount]
      );
    } catch (err) {
      console.warn(`TranscriptIngester: Could not persist state for ${sessionKey}:`, err);
    }
  }

  stopLiveWatch(sessionKey: string): void {
    const state = this.fileStates.get(sessionKey);
    if (!state) return;
    if (state.debounceTimer) { clearTimeout(state.debounceTimer); state.debounceTimer = null; }
    if (state.watcher) { try { state.watcher.close(); } catch { /* ignore */ } state.watcher = null; }
    this.fileStates.delete(sessionKey);
    console.log(`TranscriptIngester: 🛑 Live watch stopped: ${sessionKey}`);
  }

  private _scheduleLiveRead(sessionKey: string, filePath: string, state: FileState): void {
    if (state.debounceTimer) return;
    state.debounceTimer = setTimeout(async () => {
      state.debounceTimer = null;
      if (state.ingesting) return;
      state.ingesting = true;
      try { await this._doLiveRead(sessionKey, filePath, state); }
      finally { state.ingesting = false; }
    }, DEBOUNCE_MS);
  }

  private async _doLiveRead(sessionKey: string, filePath: string, state: FileState): Promise<void> {
    try {
      const { messages, newOffset } = await readNewMessages(filePath, state.bytesRead, state.lineCount);
      if (messages.length === 0) { state.bytesRead = newOffset; return; }

      // Try to resolve session ID from DB; if not found, create a stub record so cron-spawned
      // sessions (not yet indexed by SessionIndexer) can still have messages ingested live.
      let session_id = await resolveSessionId(sessionKey);
      if (!session_id) {
        session_id = await ensureSessionInDB(sessionKey, filePath);
      }
      if (!session_id) { state.bytesRead = newOffset; return; }

      const rows: NewSessionMessage[] = messages.map(p => this._toRow(p, session_id, sessionKey));
      await sessionMessageRepository.bulkInsert(rows);
      state.bytesRead = newOffset;
      state.lineCount += messages.length;

      // BUG-07c: Persist offset so we resume from here after a backend restart
      await this._persistState(sessionKey, state.bytesRead, state.lineCount);

      console.log(`TranscriptIngester: 📝 Live-ingested ${messages.length} messages for ${sessionKey}`);
    } catch (err) {
      console.error(`TranscriptIngester: Live read error for ${sessionKey}:`, err);
    }
  }

  // ── Directory auto-discovery ──────────────────────────────────

  /**
   * Watch TRANSCRIPTS_DIR for new .jsonl files and auto-start live watch.
   */
  watchDirectory(): void {
    if (!fs.existsSync(TRANSCRIPTS_DIR)) {
      console.warn(`TranscriptIngester: TRANSCRIPTS_DIR not found: ${TRANSCRIPTS_DIR}`);
      return;
    }
    console.log(`TranscriptIngester: 📂 Watching directory: ${TRANSCRIPTS_DIR}`);
    try {
      fs.watch(TRANSCRIPTS_DIR, (_event, filename) => {
        if (!filename) return;

        if (filename.endsWith('.jsonl')) {
          // New active session transcript
          const key = filename.replace('.jsonl', '');
          if (!this.ingested.has(key) && !this.fileStates.has(key)) {
            this.startLiveWatch(key, filename);
          }
          return;
        }

        // OpenClaw renames completed transcripts to <uuid>.jsonl.deleted.<ISO-timestamp>.
        // Trigger batch ingestion of the deleted file so we don't miss these sessions.
        const deletedMatch = filename.match(/^(.+)\.jsonl\.deleted\./);
        if (deletedMatch) {
          const sessionKey = deletedMatch[1];
          if (!this.ingested.has(sessionKey)) {
            console.log(`TranscriptIngester: 🗑️  Detected renamed transcript: ${filename} → batch ingesting`);
            this.stopLiveWatch(sessionKey); // Stop live watch if running
            this.ingestCompleted(sessionKey, path.join(TRANSCRIPTS_DIR, filename)).catch(err =>
              console.error(`TranscriptIngester: Error ingesting deleted file ${filename}:`, err)
            );
          }
        }
      });
    } catch (err) {
      console.warn(`TranscriptIngester: Could not watch directory ${TRANSCRIPTS_DIR}:`, err);
    }
  }

  // ── Utils ─────────────────────────────────────────────────────

  private _resolvePath(sessionKey: string, transcriptPath?: string): string {
    if (transcriptPath) {
      return path.isAbsolute(transcriptPath) ? transcriptPath : path.join(TRANSCRIPTS_DIR, transcriptPath);
    }
    const primary = path.join(TRANSCRIPTS_DIR, `${sessionKey}.jsonl`);
    if (fs.existsSync(primary)) return primary;

    // Fallback: OpenClaw renames completed cron session transcripts to
    // <session-id>.jsonl.deleted.<ISO-timestamp>. Search for it.
    const deleted = this._findDeletedFile(sessionKey, TRANSCRIPTS_DIR);
    if (deleted) {
      console.log(`TranscriptIngester: 🗑️  Using .jsonl.deleted fallback for ${sessionKey}: ${path.basename(deleted)}`);
      return deleted;
    }
    return primary; // Return original path even if not found — caller checks existence
  }

  /**
   * Scan the sessions directory for a .jsonl.deleted.* file matching the given session key.
   * OpenClaw renames completed cron transcripts to <uuid>.jsonl.deleted.<ISO-timestamp>.
   */
  private _findDeletedFile(sessionKey: string, dir: string): string | null {
    try {
      const prefix = `${sessionKey}.jsonl.deleted.`;
      const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix));
      if (files.length === 0) return null;
      // Prefer the most recent if multiple exist (shouldn't happen but be safe)
      files.sort().reverse();
      return path.join(dir, files[0]);
    } catch {
      return null;
    }
  }

  private _toRow(p: ParsedMessage, session_id: string, sessionKey: string): NewSessionMessage {
    return {
      session_id,
      session_key: sessionKey,
      ordinal: Math.round(p.ordinal),
      role: p.role,
      content: p.content,
      tool_name: p.tool_name,
      tool_call_id: p.tool_call_id,
      thinking: p.thinking,
      tokens_in: p.tokens_in,
      tokens_out: p.tokens_out,
      created_at: p.created_at,
      metadata: p.metadata,
    };
  }

  getStats() {
    return {
      watching: this.fileStates.size,
      ingested: this.ingested.size,
      watchedKeys: Array.from(this.fileStates.keys()),
    };
  }
}

export const transcriptIngester = new TranscriptIngester();
