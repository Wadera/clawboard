/**
 * RetentionService — 30-day retention policy for session messages.
 *
 * POLICY:
 *   - Keep full message rows for `retentionDays` (default 30) after session last_activity_at
 *   - After retention period: preserve first/last 5 messages as JSON summary,
 *     then DELETE message rows — the session metadata row is NEVER deleted.
 *   - Configurable via clawboard.config.json: sessions.retentionDays
 *
 * SCHEDULE: Called once daily (e.g. 03:00 UTC) by the scheduler in server.ts
 */

import { pool } from '../db/connection';
import { clawboardConfig } from '../config/clawboard';

const DEFAULT_RETENTION_DAYS = 30;
const PRESERVE_FIRST_N = 5;
const PRESERVE_LAST_N = 5;

export interface RetentionResult {
  sessionsScanned: number;
  sessionsEligible: number;
  sessionsPurged: number;
  messagesDeleted: number;
  errors: string[];
  durationMs: number;
}

export class RetentionService {
  private getRetentionDays(): number {
    try {
      const cfg = clawboardConfig;
      return (cfg as any)?.sessions?.retentionDays ?? DEFAULT_RETENTION_DAYS;
    } catch {
      return DEFAULT_RETENTION_DAYS;
    }
  }

  /**
   * Run the retention cleanup. Returns stats on what was done.
   */
  async runCleanup(): Promise<RetentionResult> {
    const startMs = Date.now();
    const retentionDays = this.getRetentionDays();
    const result: RetentionResult = {
      sessionsScanned: 0,
      sessionsEligible: 0,
      sessionsPurged: 0,
      messagesDeleted: 0,
      errors: [],
      durationMs: 0,
    };

    console.log(`[RetentionService] Starting cleanup: retentionDays=${retentionDays}`);

    // Find sessions past retention period that haven't been purged yet
    // Use last_activity_at as the "age" anchor
    const eligibleResult = await pool.query<{
      id: string;
      session_key: string;
      last_activity_at: string;
      message_count: number;
    }>(`
      SELECT id, session_key, last_activity_at, message_count
      FROM sessions
      WHERE messages_purged = FALSE
        AND last_activity_at IS NOT NULL
        AND last_activity_at < NOW() - ($1 || ' days')::INTERVAL
      ORDER BY last_activity_at ASC
    `, [retentionDays]);

    result.sessionsScanned = eligibleResult.rowCount ?? 0;
    result.sessionsEligible = eligibleResult.rowCount ?? 0;

    for (const session of eligibleResult.rows) {
      try {
        const purged = await this._purgeSession(session.id, session.session_key);
        if (purged > 0) {
          result.sessionsPurged++;
          result.messagesDeleted += purged;
        }
      } catch (err) {
        const msg = `Failed to purge session ${session.session_key}: ${err instanceof Error ? err.message : err}`;
        console.error(`[RetentionService] ${msg}`);
        result.errors.push(msg);
      }
    }

    result.durationMs = Date.now() - startMs;
    console.log(
      `[RetentionService] Done: scanned=${result.sessionsScanned} purged=${result.sessionsPurged} ` +
      `messages_deleted=${result.messagesDeleted} errors=${result.errors.length} duration=${result.durationMs}ms`
    );

    // Log to audit
    try {
      await pool.query(
        `INSERT INTO audit_log (action, details) VALUES ($1, $2)`,
        ['retention_cleanup', JSON.stringify({ ...result, retentionDays })]
      );
    } catch { /* audit table optional */ }

    return result;
  }

  /**
   * Purge messages for a single session.
   * Saves first/last N messages as summary, then deletes all message rows.
   * Returns the number of messages deleted.
   */
  private async _purgeSession(sessionId: string, sessionKey: string): Promise<number> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Count messages
      const countRes = await client.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM session_messages WHERE session_id = $1',
        [sessionId]
      );
      const total = parseInt(countRes.rows[0].count, 10);
      if (total === 0) {
        // No messages — just mark as purged
        await client.query(
          `UPDATE sessions SET messages_purged = TRUE, messages_purged_at = NOW() WHERE id = $1`,
          [sessionId]
        );
        await client.query('COMMIT');
        return 0;
      }

      // Grab first N messages
      const firstRes = await client.query(
        `SELECT role, content, tool_name, tokens_in, tokens_out, created_at, ordinal
         FROM session_messages
         WHERE session_id = $1
         ORDER BY ordinal ASC NULLS LAST, created_at ASC
         LIMIT $2`,
        [sessionId, PRESERVE_FIRST_N]
      );

      // Grab last N messages
      const lastRes = await client.query(
        `SELECT role, content, tool_name, tokens_in, tokens_out, created_at, ordinal
         FROM session_messages
         WHERE session_id = $1
         ORDER BY ordinal DESC NULLS LAST, created_at DESC
         LIMIT $2`,
        [sessionId, PRESERVE_LAST_N]
      );

      // Token totals
      const tokenRes = await client.query<{ tokens_in: string; tokens_out: string }>(
        `SELECT SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out
         FROM session_messages WHERE session_id = $1`,
        [sessionId]
      );

      const summary = {
        purged_at: new Date().toISOString(),
        total_messages_purged: total,
        first_messages: firstRes.rows,
        last_messages: [...lastRes.rows].reverse(), // restore order
        token_totals: {
          tokens_in: parseInt(tokenRes.rows[0]?.tokens_in ?? '0', 10),
          tokens_out: parseInt(tokenRes.rows[0]?.tokens_out ?? '0', 10),
        },
      };

      // Delete all messages
      const delRes = await client.query(
        'DELETE FROM session_messages WHERE session_id = $1',
        [sessionId]
      );

      // Update session with summary and purge flag
      await client.query(
        `UPDATE sessions
         SET messages_purged = TRUE,
             messages_purged_at = NOW(),
             retention_summary = $2
         WHERE id = $1`,
        [sessionId, JSON.stringify(summary)]
      );

      await client.query('COMMIT');
      console.log(`[RetentionService] Purged session ${sessionKey}: deleted ${delRes.rowCount} messages`);
      return delRes.rowCount ?? 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export const retentionService = new RetentionService();
