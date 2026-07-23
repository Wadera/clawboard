/**
 * BackfillService — Bulk-ingest historical .jsonl transcripts into session_messages.
 *
 * Scans TRANSCRIPTS_DIR for all .jsonl files, matches each to a session row
 * by filename (sessionKey.jsonl), and bulk-ingests messages in batches of 100.
 *
 * IDEMPOTENT: Sessions marked backfilled=true are skipped.
 * STREAMING: Files are read line-by-line to handle large transcripts.
 * BATCH: Inserts 100 rows at a time (configurable via BACKFILL_BATCH_SIZE).
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { pool } from '../db/connection';
import { sessionMessageRepository } from './SessionMessageRepository';
import type { NewSessionMessage, MessageRole } from '../types/SessionMessage';

const TRANSCRIPTS_DIR =
  process.env.OPENCLAW_TRANSCRIPTS_DIR ||
  process.env.CLAWDBOT_TRANSCRIPTS_DIR ||
  '/clawdbot/sessions';

const BATCH_SIZE = parseInt(process.env.BACKFILL_BATCH_SIZE || '100', 10);

export interface BackfillStats {
  filesScanned: number;
  filesSkipped: number;    // already backfilled or no DB session
  filesIngested: number;
  messagesInserted: number;
  errors: string[];
  durationMs: number;
}

// ─── Minimal line parser (replicates TranscriptIngester logic) ───

type MessageRole2 = 'user' | 'assistant' | 'system' | 'tool';

interface ParsedMsg {
  ordinal: number;
  role: MessageRole2;
  content?: string;
  tool_name?: string;
  tool_call_id?: string;
  thinking?: string;
  tokens_in?: number;
  tokens_out?: number;
  created_at?: Date;
  metadata?: Record<string, unknown>;
}

function extractText(blocks: unknown[]): string {
  if (!Array.isArray(blocks)) return '';
  return (blocks as any[])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');
}

function parseLine(line: string, ordinal: number): ParsedMsg[] {
  if (!line.trim()) return [];
  let entry: any;
  try { entry = JSON.parse(line); } catch { return []; }
  if (entry.type !== 'message') return [];

  const msg = entry.message ?? {};
  const role: string = msg.role ?? '';
  const ts = entry.timestamp;
  const created_at = ts ? new Date(typeof ts === 'number' ? ts : ts) : undefined;

  const results: ParsedMsg[] = [];

  if (role === 'user') {
    const content = Array.isArray(msg.content)
      ? extractText(msg.content)
      : typeof msg.content === 'string' ? msg.content : '';
    if (content) results.push({ ordinal, role: 'user', content, created_at });
  }

  if (role === 'assistant') {
    const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
    const text = extractText(blocks);
    const thinking = blocks.filter(b => b?.type === 'thinking').map(b => b.thinking).join('\n') || undefined;
    const usage = msg.usage ?? entry.usage ?? {};
    const tokens_in = usage.input_tokens ?? undefined;
    const tokens_out = usage.output_tokens ?? undefined;

    if (text || thinking) {
      results.push({
        ordinal,
        role: 'assistant',
        content: text || undefined,
        thinking,
        tokens_in,
        tokens_out,
        created_at,
        metadata: msg.model ? { model: msg.model } : undefined,
      });
    }

    // Tool calls as separate rows
    for (const block of blocks) {
      if (block?.type === 'toolCall') {
        results.push({
          ordinal: ordinal + 0.1,
          role: 'tool' as MessageRole2,
          tool_name: block.name,
          tool_call_id: block.id,
          content: block.arguments ? JSON.stringify(block.arguments) : undefined,
          created_at,
        });
      }
    }
  }

  if (role === 'toolResult') {
    const content = Array.isArray(msg.content)
      ? extractText(msg.content)
      : typeof msg.content === 'string' ? msg.content : '';
    results.push({
      ordinal,
      role: 'tool',
      tool_call_id: msg.toolCallId ?? undefined,
      content: content || undefined,
      created_at,
    });
  }

  return results;
}

// ─── Session ID resolver ─────────────────────────────────────────

async function resolveOrCreateSession(sessionKey: string, filePath: string): Promise<string | null> {
  const res = await pool.query<{ id: string }>(
    'SELECT id FROM sessions WHERE session_key = $1',
    [sessionKey]
  );
  if (res.rows.length > 0) return res.rows[0].id;

  // Try to create minimal session row from file stats
  try {
    const stats = fs.statSync(filePath);
    const insertRes = await pool.query<{ id: string }>(
      `INSERT INTO sessions (session_key, status, transcript_path, created_at, updated_at)
       VALUES ($1, 'completed', $2, $3, $3)
       ON CONFLICT (session_key) DO UPDATE SET updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [sessionKey, filePath, stats.mtime]
    );
    return insertRes.rows[0]?.id ?? null;
  } catch (err) {
    console.warn(`[BackfillService] Could not create session row for ${sessionKey}:`, err);
    return null;
  }
}

// ─── File streaming ingester ─────────────────────────────────────

async function ingestFile(
  filePath: string,
  sessionId: string,
  sessionKey: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let ordinal = 0;
    let batch: NewSessionMessage[] = [];
    let totalInserted = 0;

    const flushBatch = async () => {
      if (batch.length === 0) return;
      try {
        const res = await sessionMessageRepository.bulkInsert(batch);
        totalInserted += res.inserted;
      } catch (err) {
        console.error(`[BackfillService] Batch insert error for ${sessionKey}:`, err);
      }
      batch = [];
    };

    let linePromise = Promise.resolve();

    rl.on('line', (line) => {
      ordinal++;
      const msgs = parseLine(line, ordinal);
      for (const p of msgs) {
        batch.push({
          session_id: sessionId,
          session_key: sessionKey,
          ordinal: Math.round(p.ordinal),
          role: p.role as MessageRole,
          content: p.content,
          tool_name: p.tool_name,
          tool_call_id: p.tool_call_id,
          thinking: p.thinking,
          tokens_in: p.tokens_in,
          tokens_out: p.tokens_out,
          created_at: p.created_at,
          metadata: p.metadata,
        });
      }
      if (batch.length >= BATCH_SIZE) {
        const toFlush = [...batch];
        batch = [];
        linePromise = linePromise.then(() =>
          sessionMessageRepository.bulkInsert(toFlush).then(r => { totalInserted += r.inserted; })
        );
      }
    });

    rl.on('close', () => {
      linePromise
        .then(() => flushBatch())
        .then(() => resolve(totalInserted))
        .catch(reject);
    });
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

// ─── Main BackfillService ────────────────────────────────────────

export class BackfillService {
  /**
   * Scan TRANSCRIPTS_DIR and backfill all unprocessed sessions.
   */
  async runBackfill(transcriptsDir?: string): Promise<BackfillStats> {
    const dir = transcriptsDir ?? TRANSCRIPTS_DIR;
    const startMs = Date.now();
    const stats: BackfillStats = {
      filesScanned: 0,
      filesSkipped: 0,
      filesIngested: 0,
      messagesInserted: 0,
      errors: [],
      durationMs: 0,
    };

    if (!fs.existsSync(dir)) {
      console.warn(`[BackfillService] Transcripts dir not found: ${dir}`);
      stats.durationMs = Date.now() - startMs;
      return stats;
    }

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    stats.filesScanned = files.length;
    console.log(`[BackfillService] Found ${files.length} .jsonl files in ${dir}`);

    for (const file of files) {
      const sessionKey = file.replace('.jsonl', '');
      const filePath = path.join(dir, file);

      try {
        // Check if already backfilled
        const alreadyRes = await pool.query<{ id: string; backfilled: boolean; messages_purged: boolean }>(
          'SELECT id, backfilled, messages_purged FROM sessions WHERE session_key = $1',
          [sessionKey]
        );

        if (alreadyRes.rows.length > 0) {
          const row = alreadyRes.rows[0];
          if (row.backfilled && !row.messages_purged) {
            stats.filesSkipped++;
            continue;
          }
          // If purged, skip too — retention already ran
          if (row.messages_purged) {
            stats.filesSkipped++;
            continue;
          }
        }

        const sessionId = await resolveOrCreateSession(sessionKey, filePath);
        if (!sessionId) {
          stats.filesSkipped++;
          continue;
        }

        // Check if messages already exist
        const existingRes = await pool.query<{ count: string }>(
          'SELECT COUNT(*) AS count FROM session_messages WHERE session_id = $1',
          [sessionId]
        );
        const existing = parseInt(existingRes.rows[0].count, 10);
        if (existing > 0) {
          // Mark as backfilled even if we didn't do the ingestion now
          await pool.query(
            'UPDATE sessions SET backfilled = TRUE, backfilled_at = NOW() WHERE id = $1',
            [sessionId]
          );
          stats.filesSkipped++;
          continue;
        }

        // Ingest
        console.log(`[BackfillService] Ingesting ${sessionKey}...`);
        const inserted = await ingestFile(filePath, sessionId, sessionKey);

        // Mark as backfilled
        await pool.query(
          'UPDATE sessions SET backfilled = TRUE, backfilled_at = NOW() WHERE id = $1',
          [sessionId]
        );

        stats.filesIngested++;
        stats.messagesInserted += inserted;
        console.log(`[BackfillService] ✅ ${sessionKey}: ${inserted} messages`);
      } catch (err) {
        const msg = `Error processing ${sessionKey}: ${err instanceof Error ? err.message : err}`;
        console.error(`[BackfillService] ${msg}`);
        stats.errors.push(msg);
      }
    }

    stats.durationMs = Date.now() - startMs;
    const rate = stats.messagesInserted / Math.max(stats.durationMs / 1000, 1);
    console.log(
      `[BackfillService] Complete: ingested=${stats.filesIngested} skipped=${stats.filesSkipped} ` +
      `messages=${stats.messagesInserted} rate=${rate.toFixed(0)}/s errors=${stats.errors.length} ` +
      `duration=${stats.durationMs}ms`
    );

    return stats;
  }
}

export const backfillService = new BackfillService();
