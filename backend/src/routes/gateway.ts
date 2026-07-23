import { Router, Request, Response } from 'express';
import { GatewayConnector } from '../services/GatewayConnector';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pool } from '../db/connection';

const router = Router();
const TRANSCRIPTS_DIR = process.env.OPENCLAW_TRANSCRIPTS_DIR || process.env.CLAWDBOT_TRANSCRIPTS_DIR || '/clawdbot/sessions';
const MEDIA_BASE_DIR = '/clawdbot/media';

// ─────────────────────────────────────────────────────────────────
// BUG-01: session_key → sessions.id resolution cache
// The gateway reports sessionId = session_key (e.g. 911d4ee1-...)
// but session_messages.session_id stores sessions.id (the DB PK UUID).
// We must resolve before querying session_messages.
// ─────────────────────────────────────────────────────────────────
const sessionKeyToDbIdCache = new Map<string, string>();

// NOTE: session_messages table was dropped in migration 033.
// This function is kept for compatibility but now returns session_key directly
// (the PK in the new schema). The endpoints that use it (/session/:id/messages,
// /session/:id/tools, /sessions/:id/search) will fail on session_messages queries
// but won't crash. They'll be replaced in Phase 4.
async function resolveDbSessionId(sessionKey: string): Promise<string | null> {
  const cached = sessionKeyToDbIdCache.get(sessionKey);
  if (cached) return cached;
  try {
    const result = await pool.query<{ session_key: string }>(
      'SELECT session_key FROM sessions WHERE session_key = $1 LIMIT 1',
      [sessionKey]
    );
    if (result.rows.length > 0) {
      sessionKeyToDbIdCache.set(sessionKey, result.rows[0].session_key);
      return result.rows[0].session_key;
    }
  } catch (err) {
    console.error('[resolveDbSessionId] DB error:', err);
  }
  return null;
}

let gatewayConnector: GatewayConnector | null = null;

export function setGatewayConnector(connector: GatewayConnector): void {
  gatewayConnector = connector;
}

// GET /gateway/queue — DEPRECATED (Phase 4)
// Replaced by GET /api/sessions (with liveState overlay).
// Returns a 301 redirect for API consumers that haven't updated yet.
router.get('/queue', (_req: Request, res: Response) => {
  res.status(301).json({
    success: false,
    deprecated: true,
    message: 'GET /gateway/queue is deprecated. Use GET /api/sessions instead.',
    redirect: '/api/sessions',
  });
});

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function transcriptExists(sessionId: string): boolean {
  return fs.existsSync(path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`));
}

function isValidUUID(id: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(id);
}

// ─────────────────────────────────────────────────────────────────
// File-based fallback helpers (original logic extracted)
// ─────────────────────────────────────────────────────────────────

function readMessagesFromFile(sessionId: string, limit: number, all: boolean) {
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
  let rawLines: string;
  try {
    const tailLines = all ? 5000 : 500;
    rawLines = execSync(all ? `cat "${transcriptPath}"` : `tail -${tailLines} "${transcriptPath}"`, {
      encoding: 'utf-8', timeout: 10000, maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    return [];
  }

  const lines = rawLines.trim().split('\n').filter(l => l.trim());
  const messages: Array<{ role: string; text: string; fullText?: string; truncated: boolean; timestamp: string }> = [];

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.type !== 'message') continue;
      const role = msg.message?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const content = msg.message?.content;
      let text = '';
      if (typeof content === 'string') { text = content; }
      else if (Array.isArray(content)) { for (const c of content) { if (c.type === 'text') text += c.text || ''; } }
      if (!text.trim()) continue;
      const truncated = text.length > 500;
      messages.push({ role, text: truncated ? text.substring(0, 500) : text, ...(truncated ? { fullText: text } : {}), truncated, timestamp: msg.timestamp || '' });
    } catch { /* skip */ }
  }
  return messages.slice(-limit);
}

function readToolsFromFile(sessionId: string, limit: number, all: boolean) {
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
  let rawLines: string;
  try {
    rawLines = all
      ? execSync(`cat "${transcriptPath}"`, { encoding: 'utf-8', timeout: 10000, maxBuffer: 10 * 1024 * 1024 })
      : execSync(`tail -200 "${transcriptPath}"`, { encoding: 'utf-8', timeout: 5000, maxBuffer: 10 * 1024 * 1024 });
  } catch {
    return { tools: [], total: 0 };
  }

  const lines = rawLines.trim().split('\n').filter(l => l.trim());

  interface ToolCallInfo {
    id: string; name: string; input: string; inputData: Record<string, any>;
    output?: string; timestamp: string; completedTimestamp?: string;
    status: 'running' | 'done' | 'error'; durationMs?: number; hasImage?: boolean;
  }

  const toolCalls: Map<string, ToolCallInfo> = new Map();
  const toolResults: Map<string, { text: string; timestamp: string; hasImage: boolean }> = new Map();

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      const role = msg.message?.role;
      const content = msg.message?.content;
      const timestamp = msg.timestamp || '';
      if (role === 'toolResult' && Array.isArray(content)) {
        const toolCallId = msg.message?.toolCallId || '';
        let text = ''; let hasImage = false;
        for (const c of content) { if (c.type === 'text') text += c.text || ''; if (c.type === 'image') hasImage = true; }
        if (toolCallId) toolResults.set(toolCallId, { text: text.substring(0, 2000), timestamp, hasImage });
      }
    } catch { /* skip */ }
  }

  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      const role = msg.message?.role;
      const content = msg.message?.content;
      const timestamp = msg.timestamp || '';
      if (role === 'assistant' && Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'toolCall' && c.id) {
            const result = toolResults.get(c.id);
            const args = c.arguments || {};
            let inputPreview = '';
            if (args.command) inputPreview = `$ ${args.command}`;
            else if (args.url || args.targetUrl) inputPreview = args.url || args.targetUrl;
            else if (args.file_path || args.path) inputPreview = args.file_path || args.path;
            else if (args.query) inputPreview = args.query;
            else if (args.action) inputPreview = `${args.action}${args.target ? ` → ${args.target}` : ''}`;
            else inputPreview = JSON.stringify(args).substring(0, 300);
            toolCalls.set(c.id, {
              id: c.id, name: c.name || 'unknown',
              input: inputPreview.substring(0, 500), inputData: args,
              output: result?.text, timestamp, completedTimestamp: result?.timestamp,
              status: result ? 'done' : 'running',
              durationMs: result?.timestamp && timestamp ? new Date(result.timestamp).getTime() - new Date(timestamp).getTime() : undefined,
              hasImage: result?.hasImage,
            });
          }
        }
      }
    } catch { /* skip */ }
  }

  const allTools = Array.from(toolCalls.values()).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const total = allTools.length;
  const tools = all ? allTools : allTools.slice(-limit);
  return { tools, total };
}

// ─────────────────────────────────────────────────────────────────
// DB-based message fetchers
// ─────────────────────────────────────────────────────────────────

async function fetchMessagesFromDB(
  sessionId: string,
  opts: { limit: number; after?: number; forceDB?: boolean; latest?: boolean }
): Promise<{
  rows: Array<{ role: string; text: string; fullText?: string; truncated: boolean; timestamp: string; ordinal?: number; toolName?: string; toolCallId?: string }>;
  hasMore: boolean; nextCursor?: number; hasOlder?: boolean; beforeCursor?: number;
} | null> {
  const { limit, after, latest } = opts;

  // BUG-01: sessionId is the gateway UUID (= session_key); resolve to DB PK
  const dbId = await resolveDbSessionId(sessionId);
  if (!dbId) {
    if (opts.forceDB) {
      return { rows: [], hasMore: false };
    }
    return null; // trigger JSONL fallback
  }

  // Default to latest-first for initial loads (no cursor) — shows recent messages instead of 7-day-old ones
  const useLatest = latest || (after === undefined);

  if (useLatest) {
    // Fetch last N messages in DESC order, then reverse to chronological
    const result = await pool.query(
      `SELECT role, content, created_at, ordinal, tool_name, tool_call_id
       FROM session_messages
       WHERE session_id = $1 AND role IN ('user', 'assistant', 'tool')
       ORDER BY COALESCE(ordinal, 2147483647) DESC, created_at DESC
       LIMIT $2`,
      [dbId, limit + 1]
    );

    if (result.rows.length === 0 && !opts.forceDB) return null;

    const hasOlder = result.rows.length > limit;
    const rows = result.rows.slice(0, limit).reverse(); // back to chronological
    const oldestOrdinal = rows[0]?.ordinal;

    const messages = rows.map((row: any) => buildMessageRow(row)).filter(Boolean);

    return {
      rows: messages as any,
      hasMore: false,
      hasOlder,
      beforeCursor: hasOlder && oldestOrdinal != null ? oldestOrdinal : undefined,
    };
  }

  // Forward pagination (after cursor provided)
  const params: unknown[] = [dbId, limit + 1];
  let afterClause = '';
  if (after !== undefined) {
    params.push(after);
    afterClause = `AND COALESCE(ordinal, 2147483647) > $${params.length}`;
  }

  const result = await pool.query(
    `SELECT role, content, created_at, ordinal, tool_name, tool_call_id
     FROM session_messages
     WHERE session_id = $1 AND role IN ('user', 'assistant', 'tool')
     ${afterClause}
     ORDER BY COALESCE(ordinal, 2147483647) ASC, created_at ASC
     LIMIT $2`,
    params
  );

  if (result.rows.length === 0 && !opts.forceDB) return null;

  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const lastOrdinal = rows[rows.length - 1]?.ordinal;

  const messages = rows.map((row: any) => buildMessageRow(row)).filter(Boolean);

  return { rows: messages as any, hasMore, nextCursor: hasMore && lastOrdinal != null ? lastOrdinal : undefined };
}

async function fetchToolsFromDB(sessionId: string, limit: number, all: boolean): Promise<{ tools: any[]; total: number } | null> {
  // BUG-01: sessionId is the gateway UUID (= session_key); resolve to DB PK
  const dbId = await resolveDbSessionId(sessionId);
  if (!dbId) return null;

  const result = await pool.query(
    `SELECT role, content, tool_name, tool_call_id, created_at, ordinal, metadata
     FROM session_messages
     WHERE session_id = $1 AND role = 'tool'
     ORDER BY COALESCE(ordinal, 2147483647) ASC, created_at ASC`,
    [dbId]
  );

  if (result.rows.length === 0) return null;

  // Pair: for a given tool_call_id, first row = call input, second = result
  const callsByKey: Map<string, any> = new Map();
  const resultsByKey: Map<string, any> = new Map();

  for (const row of result.rows) {
    const key = row.tool_call_id;
    if (!key) continue;
    if (!callsByKey.has(key)) { callsByKey.set(key, row); }
    else if (!resultsByKey.has(key)) { resultsByKey.set(key, row); }
  }

  const allTools: any[] = [];
  for (const [key, callRow] of callsByKey) {
    const resultRow = resultsByKey.get(key);
    let inputData: Record<string, any> = {};
    try { inputData = JSON.parse(callRow.content || '{}'); } catch { /* ok */ }

    let inputPreview = '';
    if (inputData.command) inputPreview = `$ ${inputData.command}`;
    else if (inputData.url || inputData.targetUrl) inputPreview = inputData.url || inputData.targetUrl;
    else if (inputData.file_path || inputData.path) inputPreview = inputData.file_path || inputData.path;
    else if (inputData.query) inputPreview = inputData.query;
    else if (inputData.action) inputPreview = `${inputData.action}${inputData.target ? ` → ${inputData.target}` : ''}`;
    else inputPreview = (callRow.content || '').substring(0, 300);

    const callTs = callRow.created_at?.toISOString?.() || String(callRow.created_at) || '';
    const resultTs = resultRow?.created_at?.toISOString?.() || String(resultRow?.created_at) || '';

    allTools.push({
      id: key, name: callRow.tool_name || 'unknown',
      input: inputPreview.substring(0, 500), inputData,
      output: resultRow ? (resultRow.content || '').substring(0, 2000) : undefined,
      timestamp: callTs, completedTimestamp: resultRow ? resultTs : undefined,
      status: resultRow ? (resultRow.metadata?.is_error ? 'error' : 'done') : 'running',
      durationMs: resultRow && callTs && resultTs ? new Date(resultTs).getTime() - new Date(callTs).getTime() : undefined,
    });
  }

  const total = allTools.length;
  return { tools: all ? allTools : allTools.slice(-limit), total };
}

// ─────────────────────────────────────────────────────────────────
// GET /gateway/session/:sessionId/tools
// ─────────────────────────────────────────────────────────────────
router.get('/session/:sessionId/tools', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit as string) || 20;
    const all = req.query.all === 'true';
    const forceDB = req.query.source === 'db';

    if (!isValidUUID(sessionId)) {
      // Non-UUID session ID (e.g., 'cron:UUID'): try JSONL file with UUID stripped from prefix
      console.log(`[tools] Non-UUID sessionId "${sessionId}", trying prefix-stripped fallback`);
      const colonIdx = sessionId.lastIndexOf(':');
      const fileId = colonIdx !== -1 && isValidUUID(sessionId.substring(colonIdx + 1))
        ? sessionId.substring(colonIdx + 1) : null;
      if (fileId && transcriptExists(fileId)) {
        const fileResult = readToolsFromFile(fileId, limit, all);
        res.json({ success: true, ...fileResult, source: 'file' });
        return;
      }
      res.json({ success: true, tools: [], total: 0, source: 'none' });
      return;
    }

    const dbResult = await fetchToolsFromDB(sessionId, limit, all);
    if (dbResult) {
      res.json({ success: true, ...dbResult, source: 'db' });
      return;
    }

    if (forceDB) {
      res.json({ success: true, tools: [], total: 0, source: 'db' });
      return;
    }

    if (!transcriptExists(sessionId)) {
      res.json({ success: true, tools: [], total: 0, source: 'none' });
      return;
    }

    const fileResult = readToolsFromFile(sessionId, limit, all);
    res.json({ success: true, ...fileResult, source: 'file' });
  } catch (err: any) {
    console.error('Failed to get session tools:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /gateway/session/:sessionId/messages
// ?source=db (force DB) | ?after=ordinal | ?limit=N | ?all=true
// Returns: { messages, hasMore, nextCursor, source }
// ─────────────────────────────────────────────────────────────────
router.get('/session/:sessionId/messages', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const all = req.query.all === 'true';
    const forceDB = req.query.source === 'db';
    const after = req.query.after !== undefined ? parseInt(req.query.after as string) : undefined;
    const limit = all ? 9999 : Math.min(parseInt(req.query.limit as string) || 50, 200);

    if (!isValidUUID(sessionId)) {
      // Non-UUID session ID (e.g., 'cron:UUID'): fall back to session_key query
      console.log(`[messages] Non-UUID sessionId "${sessionId}", falling back to session_key query`);
      const skParams: unknown[] = [sessionId, limit + 1];
      let skAfterClause = '';
      if (after !== undefined) {
        skParams.push(after);
        skAfterClause = `AND COALESCE(ordinal, 2147483647) > $${skParams.length}`;
      }
      try {
        const skResult = await pool.query(
          `SELECT role, content, created_at, ordinal, tool_name, tool_call_id
           FROM session_messages
           WHERE session_key = $1 AND role IN ('user', 'assistant', 'tool')
           ${skAfterClause}
           ORDER BY COALESCE(ordinal, 2147483647) ASC, created_at ASC
           LIMIT $2`,
          skParams
        );
        if (skResult.rows.length > 0) {
          const hasMore = skResult.rows.length > limit;
          const rows = skResult.rows.slice(0, limit);
          const lastOrdinal = rows[rows.length - 1]?.ordinal;
          const messages = rows.map((row: any) => {
            const rawText: string = row.content || '';
            const text = rawText || (row.role === 'assistant' && row.tool_name ? `[Tool call: ${row.tool_name}]` : '');
            const displayText = text || (row.role === 'tool' && row.tool_name ? `[Tool result: ${row.tool_name}]` : '');
            if (!displayText) return null;
            const truncated = displayText.length > 500;
            return {
              role: row.role, text: truncated ? displayText.substring(0, 500) : displayText,
              ...(truncated ? { fullText: displayText } : {}), truncated,
              timestamp: row.created_at?.toISOString?.() || String(row.created_at) || '',
              ordinal: row.ordinal ?? undefined,
              ...(row.tool_name ? { toolName: row.tool_name } : {}),
              ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
            };
          }).filter(Boolean);
          res.json({ success: true, messages, hasMore, nextCursor: hasMore && lastOrdinal != null ? lastOrdinal : undefined, source: 'db' });
          return;
        }
      } catch (skErr) {
        console.error('[messages] session_key fallback DB error:', skErr);
      }
      // Try JSONL file with UUID extracted from prefix (e.g., 'cron:UUID' → UUID.jsonl)
      const colonIdx = sessionId.lastIndexOf(':');
      const fileId = colonIdx !== -1 && isValidUUID(sessionId.substring(colonIdx + 1))
        ? sessionId.substring(colonIdx + 1) : null;
      if (fileId && transcriptExists(fileId)) {
        const messages = readMessagesFromFile(fileId, limit, all);
        res.json({ success: true, messages, hasMore: false, source: 'file' });
        return;
      }
      res.json({ success: true, messages: [], hasMore: false, source: 'none' });
      return;
    }

    const dbResult = await fetchMessagesFromDB(sessionId, { limit, after, forceDB });
    if (dbResult !== null) {
      res.json({ success: true, messages: dbResult.rows, hasMore: dbResult.hasMore, nextCursor: dbResult.nextCursor, source: 'db' });
      return;
    }

    if (forceDB) {
      res.json({ success: true, messages: [], hasMore: false, source: 'db' });
      return;
    }

    const transcriptPath = path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
    console.log(`[messages] DB empty, falling back to file: ${transcriptPath}`);

    if (!transcriptExists(sessionId)) {
      console.log(`[messages] No transcript file found for sessionId: ${sessionId}`);
      res.json({ success: true, messages: [], hasMore: false, source: 'none' });
      return;
    }

    const messages = readMessagesFromFile(sessionId, limit, all);
    res.json({ success: true, messages, hasMore: false, source: 'file' });
  } catch (err: any) {
    console.error('Failed to get session messages:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /gateway/session/:sessionKey/messages-by-key
// Lookup by session_key (string, not UUID). Supports pagination.
//
// BUG-06: Added `latest=true` and `before` cursor params.
//   ?latest=true  → return last N messages in chronological order (default for initial load)
//   ?before=N     → return N messages older than ordinal N (load-older pagination)
//   ?after=N      → return N messages newer than ordinal N (load-newer / live polling)
// Response fields:
//   hasMore / nextCursor   — for ?after pagination (newer messages)
//   hasOlder / beforeCursor — for ?before / ?latest pagination (older messages)
// ─────────────────────────────────────────────────────────────────

function buildMessageRow(row: any) {
  const rawText: string = row.content || '';
  const text = rawText || (row.role === 'assistant' && row.tool_name ? `[Tool call: ${row.tool_name}]` : '');
  const displayText = text || (row.role === 'tool' && row.tool_name ? `[Tool result: ${row.tool_name}]` : '');
  if (!displayText) return null;
  const truncated = displayText.length > 500;
  return {
    role: row.role,
    text: truncated ? displayText.substring(0, 500) : displayText,
    ...(truncated ? { fullText: displayText } : {}),
    truncated,
    timestamp: row.created_at?.toISOString?.() || String(row.created_at) || '',
    ordinal: row.ordinal ?? undefined,
    ...(row.tool_name ? { toolName: row.tool_name } : {}),
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
  };
}

router.get('/session/:sessionKey/messages-by-key', async (req: Request, res: Response) => {
  try {
    const { sessionKey } = req.params;
    const after = req.query.after !== undefined ? parseInt(req.query.after as string) : undefined;
    const before = req.query.before !== undefined ? parseInt(req.query.before as string) : undefined;
    const latest = req.query.latest === 'true';
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    if (!/^[\w\-:]{1,128}$/.test(sessionKey)) {
      res.status(400).json({ success: false, error: 'Invalid session key' });
      return;
    }

    // ── Latest mode (default for initial load): return last N in chronological order ──
    if (latest || (after === undefined && before === undefined)) {
      const result = await pool.query(
        `SELECT role, content, created_at, ordinal, tool_name, tool_call_id
         FROM session_messages
         WHERE session_key = $1 AND role IN ('user', 'assistant', 'tool')
         ORDER BY COALESCE(ordinal, 2147483647) DESC, created_at DESC
         LIMIT $2`,
        [sessionKey, limit + 1]
      );

      const hasOlder = result.rows.length > limit;
      const rows = result.rows.slice(0, limit).reverse(); // back to chronological
      const messages = rows.map(buildMessageRow).filter(Boolean);
      const oldestOrdinal = rows[0]?.ordinal;

      res.json({
        success: true,
        messages,
        hasMore: false, // we're already at latest
        hasOlder,
        beforeCursor: hasOlder && oldestOrdinal != null ? oldestOrdinal : undefined,
        source: 'db',
      });
      return;
    }

    // ── Before mode: load older messages for backward pagination ──
    if (before !== undefined) {
      const result = await pool.query(
        `SELECT role, content, created_at, ordinal, tool_name, tool_call_id
         FROM session_messages
         WHERE session_key = $1
           AND role IN ('user', 'assistant', 'tool')
           AND COALESCE(ordinal, 2147483647) < $3
         ORDER BY COALESCE(ordinal, 2147483647) DESC, created_at DESC
         LIMIT $2`,
        [sessionKey, limit + 1, before]
      );

      const hasOlder = result.rows.length > limit;
      const rows = result.rows.slice(0, limit).reverse();
      const messages = rows.map(buildMessageRow).filter(Boolean);
      const oldestOrdinal = rows[0]?.ordinal;

      res.json({
        success: true,
        messages,
        hasMore: false,
        hasOlder,
        beforeCursor: hasOlder && oldestOrdinal != null ? oldestOrdinal : undefined,
        source: 'db',
      });
      return;
    }

    // ── After mode: forward pagination (load newer messages / live polling) ──
    const params: unknown[] = [sessionKey, limit + 1];
    let afterClause = '';
    if (after !== undefined) {
      params.push(after);
      afterClause = `AND COALESCE(ordinal, 2147483647) > $${params.length}`;
    }

    const result = await pool.query(
      `SELECT role, content, created_at, ordinal, tool_name, tool_call_id
       FROM session_messages
       WHERE session_key = $1 AND role IN ('user', 'assistant', 'tool')
       ${afterClause}
       ORDER BY COALESCE(ordinal, 2147483647) ASC, created_at ASC
       LIMIT $2`,
      params
    );

    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const lastOrdinal = rows[rows.length - 1]?.ordinal;
    const messages = rows.map(buildMessageRow).filter(Boolean);

    res.json({
      success: true,
      messages,
      hasMore,
      nextCursor: hasMore && lastOrdinal != null ? lastOrdinal : undefined,
      hasOlder: false,
      source: 'db',
    });
  } catch (err: any) {
    console.error('Failed to get messages by key:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /gateway/sessions/:sessionId/search?q=term
// Full-text search across messages for a session
// ─────────────────────────────────────────────────────────────────
router.get('/sessions/:sessionId/search', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const q = (req.query.q as string || '').trim();
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    if (!isValidUUID(sessionId)) {
      res.status(400).json({ success: false, error: 'Invalid session ID' });
      return;
    }
    if (!q) {
      res.status(400).json({ success: false, error: 'Missing search term ?q=' });
      return;
    }

    // BUG-01: resolve session_key → DB PK before querying session_messages
    const dbId = await resolveDbSessionId(sessionId);
    if (!dbId) {
      res.json({ success: true, matches: [], total: 0, query: q });
      return;
    }

    const result = await pool.query(
      `SELECT role, content, created_at, ordinal, tool_name, tool_call_id
       FROM session_messages
       WHERE session_id = $1 AND content ILIKE $2
       ORDER BY COALESCE(ordinal, 2147483647) ASC, created_at ASC
       LIMIT $3`,
      [dbId, `%${q}%`, limit]
    );

    const matches = result.rows.map((row: any) => {
      const text: string = row.content || '';
      const idx = text.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, idx - 75);
      const end = Math.min(text.length, idx + q.length + 75);
      const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
      return {
        role: row.role, snippet, fullText: text,
        timestamp: row.created_at?.toISOString?.() || String(row.created_at) || '',
        ordinal: row.ordinal ?? undefined,
        toolName: row.tool_name ?? undefined,
        toolCallId: row.tool_call_id ?? undefined,
      };
    });

    res.json({ success: true, matches, total: matches.length, query: q });
  } catch (err: any) {
    console.error('Failed to search session messages:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /gateway/sessions/archive — DEPRECATED (Phase 4)
// Replaced by GET /api/sessions (all statuses, with filters).
// ─────────────────────────────────────────────────────────────────
router.get('/sessions/archive', (_req: Request, res: Response) => {
  res.status(301).json({
    success: false,
    deprecated: true,
    message: 'GET /gateway/sessions/archive is deprecated. Use GET /api/sessions instead.',
    redirect: '/api/sessions',
  });
});

// POST /gateway/session/:sessionId/abort
// sessionId may be a UUID (from gateway sessions.list) or a session key string.
router.post('/session/:sessionId/abort', async (req: Request, res: Response) => {
  try {
    if (!gatewayConnector) {
      res.status(503).json({ success: false, error: 'Gateway connector not initialized' });
      return;
    }
    const { sessionId } = req.params;

    // Resolve sessionKey: check if sessionId is already a key in liveStates
    let sessionKey = sessionId;
    const liveStates = gatewayConnector.getLiveStates();
    if (!liveStates.has(sessionId)) {
      // Try to look up by session_id UUID in the DB
      try {
        const dbResult = await pool.query(
          'SELECT session_key FROM sessions WHERE session_id = $1::uuid LIMIT 1',
          [sessionId]
        );
        if (dbResult.rows.length > 0) {
          sessionKey = dbResult.rows[0].session_key;
        } else {
          res.status(404).json({ success: false, error: 'Session not found' });
          return;
        }
      } catch {
        // sessionId may not be a valid UUID — treat it as a session key directly
        sessionKey = sessionId;
      }
    }

    await gatewayConnector.abortSession(sessionKey);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Failed to abort session:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to abort session' });
  }
});

// GET /gateway/history — returns recently-completed sessions from DB
router.get('/history', async (_req: Request, res: Response) => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = await pool.query(
      `SELECT session_key, session_id::text AS session_id, label, model, kind, channel,
              started_at, ended_at, last_activity_at, input_tokens, output_tokens
       FROM sessions
       WHERE status = 'completed' AND last_activity_at > $1
       ORDER BY last_activity_at DESC
       LIMIT 50`,
      [cutoff]
    );

    const sessions = result.rows.map((row: any) => ({
      sessionId: row.session_id || row.session_key,
      label: row.label || row.session_key,
      channel: row.channel || 'unknown',
      completedAt: row.ended_at ? new Date(row.ended_at).getTime() : (row.last_activity_at ? new Date(row.last_activity_at).getTime() : 0),
      startedAt: row.started_at ? new Date(row.started_at).getTime() : 0,
      durationMs: (row.ended_at && row.started_at)
        ? new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()
        : 0,
      model: row.model || 'unknown',
      tokenUsage: {
        total: (row.input_tokens || 0) + (row.output_tokens || 0),
        context: 200000,
        percentUsed: 0,
      },
      kind: row.kind || 'unknown',
    }));

    res.json({ success: true, sessions });
  } catch (err: any) {
    console.error('Failed to get session history:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve media files
router.get('/media/*', (req: Request, res: Response) => {
  const mediaPath = req.params[0];
  if (!mediaPath) { res.status(400).json({ error: 'No path specified' }); return; }
  const fullPath = path.join(MEDIA_BASE_DIR, mediaPath);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(MEDIA_BASE_DIR))) { res.status(403).json({ error: 'Forbidden' }); return; }
  if (!fs.existsSync(resolved)) { res.status(404).json({ error: 'Not found' }); return; }
  res.sendFile(resolved);
});

export default router;
