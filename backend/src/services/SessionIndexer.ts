/**
 * SessionIndexer — Periodically indexes JSONL session transcripts into PostgreSQL.
 * 
 * Scans the sessions directory for new/modified JSONL files and upserts metadata
 * into the sessions table. Runs every 5 minutes by default.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { pool } from '../db/connection';

const SESSIONS_DIR = process.env.OPENCLAW_TRANSCRIPTS_DIR || process.env.CLAWDBOT_TRANSCRIPTS_DIR || '/clawdbot/sessions';
const INTERVAL_MS = parseInt(process.env.SESSION_INDEX_INTERVAL_MS || '300000'); // 5 min default

interface SessionMeta {
  sessionKey: string;
  transcriptPath: string;
  label: string | null;
  model: string | null;
  kind: string | null;
  status: string;
  messageCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalCost: number;
  startedAt: string | null;
  endedAt: string | null;
  lastActivityAt: string | null;
  fileSize: number;
  fileMtime: string;
}

/**
 * Parse a JSONL transcript file and extract session metadata.
 * Reads first 50 lines for header info and last 20 lines for end info.
 * For token totals, does a fast scan of the full file.
 */
async function parseSessionFile(filePath: string): Promise<SessionMeta | null> {
  const fileName = path.basename(filePath);
  const sessionKey = fileName.replace('.jsonl', '');

  const stats = fs.statSync(filePath);
  if (stats.size === 0) return null;

  const meta: SessionMeta = {
    sessionKey,
    transcriptPath: filePath,
    label: null,
    model: null,
    kind: null,
    status: 'completed',
    messageCount: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalCost: 0,
    startedAt: null,
    endedAt: null,
    lastActivityAt: null,
    fileSize: stats.size,
    fileMtime: stats.mtime.toISOString(),
  };

  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineCount = 0;
    let firstUserContent: string | null = null;

    rl.on('line', (line) => {
      lineCount++;
      if (!line.trim()) return;

      try {
        const entry = JSON.parse(line);
        const msg = entry.message || {};
        const ts = entry.timestamp;

        // Timestamps
        if (ts) {
          const isoTs = typeof ts === 'number' ? new Date(ts).toISOString() : ts;
          if (!meta.startedAt || isoTs < meta.startedAt) meta.startedAt = isoTs;
          if (!meta.lastActivityAt || isoTs > meta.lastActivityAt) meta.lastActivityAt = isoTs;
        }

        // Count messages
        const role = msg.role || '';
        if (role === 'user' || role === 'assistant' || role === 'toolResult') {
          meta.messageCount++;
        }
        if (role === 'assistant' && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'toolCall') meta.toolCallCount++;
          }
        }

        // Model
        if (msg.model && !meta.model) {
          meta.model = msg.model;
        }

        // Session key from entry
        if (entry.sessionKey && !meta.kind) {
          meta.sessionKey = entry.sessionKey;
          if (entry.sessionKey.includes(':subagent:')) meta.kind = 'subagent';
          else if (entry.sessionKey.includes(':heartbeat')) meta.kind = 'heartbeat';
          else if (entry.sessionKey.includes(':main')) meta.kind = 'main';
        }

        // Tokens (from usage in assistant messages)
        if (msg.usage) {
          meta.inputTokens += msg.usage.input_tokens || msg.usage.inputTokens || 0;
          meta.outputTokens += msg.usage.output_tokens || msg.usage.outputTokens || 0;
          meta.thinkingTokens += msg.usage.thinking_tokens || msg.usage.thinkingTokens || 0;
        }

        // Cost
        if (entry.cost) {
          meta.totalCost += typeof entry.cost === 'number' ? entry.cost : parseFloat(entry.cost) || 0;
        }

        // Label from first user message
        if (!firstUserContent && role === 'user') {
          let content = msg.content;
          if (Array.isArray(content)) {
            content = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ');
          }
          if (typeof content === 'string' && content.length > 0) {
            // Skip heartbeat/system messages
            if (!content.includes('HEARTBEAT') && !content.startsWith('System:') && !content.startsWith('Read HEARTBEAT')) {
              const taskMatch = content.match(/##\s*Task:\s*(.+?)(?:\n|$)/i);
              if (taskMatch) {
                meta.label = taskMatch[1].trim().slice(0, 100);
              } else {
                const lines = content.split('\n');
                const firstMeaningful = lines.find((l: string) => {
                  const t = l.trim();
                  return t.length > 5 && !t.startsWith('[') && !t.startsWith('System:') && !t.startsWith('#');
                });
                if (firstMeaningful) {
                  meta.label = firstMeaningful.trim().slice(0, 100);
                }
              }
              firstUserContent = content;
            }
          }
        }
      } catch {
        // Skip unparseable lines
      }
    });

    rl.on('close', () => {
      meta.endedAt = meta.lastActivityAt;
      resolve(meta);
    });

    rl.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Upsert a session into the database.
 */
async function upsertSession(meta: SessionMeta): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (
      session_key, transcript_path, label, model, kind, status,
      message_count, tool_call_count,
      input_tokens, output_tokens, thinking_tokens, total_cost_usd,
      started_at, ended_at, last_activity_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    ON CONFLICT (session_key) DO UPDATE SET
      label = COALESCE(EXCLUDED.label, sessions.label),
      model = COALESCE(EXCLUDED.model, sessions.model),
      kind = COALESCE(EXCLUDED.kind, sessions.kind),
      message_count = EXCLUDED.message_count,
      tool_call_count = EXCLUDED.tool_call_count,
      input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      thinking_tokens = EXCLUDED.thinking_tokens,
      total_cost_usd = EXCLUDED.total_cost_usd,
      last_activity_at = EXCLUDED.last_activity_at,
      ended_at = EXCLUDED.ended_at,
      updated_at = NOW()`,
    [
      meta.sessionKey, meta.transcriptPath, meta.label, meta.model,
      meta.kind || 'unknown', meta.status,
      meta.messageCount, meta.toolCallCount,
      meta.inputTokens, meta.outputTokens, meta.thinkingTokens, meta.totalCost,
      meta.startedAt, meta.endedAt, meta.lastActivityAt
    ]
  );
}

/**
 * Run a single indexing pass. Scans for files modified since last run.
 */
async function indexPass(lastRunTime: Date): Promise<{ indexed: number; errors: number }> {
  let indexed = 0;
  let errors = 0;

  let files: string[];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
  } catch (err) {
    console.warn(`⚠️  SessionIndexer: Cannot read ${SESSIONS_DIR}:`, (err as Error).message);
    return { indexed: 0, errors: 0 };
  }

  for (const file of files) {
    const filePath = path.join(SESSIONS_DIR, file);
    try {
      const stats = fs.statSync(filePath);
      // Skip files not modified since last run
      if (stats.mtime <= lastRunTime) continue;
      // Skip tiny files
      if (stats.size < 50) continue;

      const meta = await parseSessionFile(filePath);
      if (meta) {
        await upsertSession(meta);
        indexed++;
      }
    } catch (err) {
      errors++;
      console.warn(`⚠️  SessionIndexer: Error indexing ${file}:`, (err as Error).message);
    }
  }

  return { indexed, errors };
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
// First run: only index files from the last 24h (fast startup)
let lastRunTime = new Date(Date.now() - 24 * 60 * 60 * 1000);

/**
 * Start the periodic session indexer.
 */
export function startSessionIndexer(): void {
  console.log(`📇 SessionIndexer: Starting (interval: ${INTERVAL_MS / 1000}s, dir: ${SESSIONS_DIR})`);

  const runIndex = async () => {
    const runStart = new Date();
    try {
      const result = await indexPass(lastRunTime);
      console.log(`📇 SessionIndexer: Pass complete — ${result.indexed} indexed, ${result.errors} errors`);
    } catch (err) {
      console.error('❌ SessionIndexer: Pass failed:', (err as Error).message);
    }
    lastRunTime = runStart;
  };

  // Initial run after 10s delay (let DB connect first)
  setTimeout(async () => {
    await runIndex();
    // Then schedule periodic runs
    intervalHandle = setInterval(runIndex, INTERVAL_MS);
  }, 10000);
}

/**
 * Stop the periodic session indexer.
 */
export function stopSessionIndexer(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('📇 SessionIndexer: Stopped');
  }
}
