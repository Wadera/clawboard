// SessionMessageRepository.ts
// High-throughput message persistence for session_messages table.
import { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/connection';
import {
  SessionMessage,
  NewSessionMessage,
  SessionMessageQuery,
  BulkInsertResult,
} from '../types/SessionMessage';

const INSERT_COLS = [
  'session_id', 'session_key', 'ordinal', 'role', 'content',
  'tool_name', 'tool_call_id', 'thinking',
  'tokens_in', 'tokens_out', 'created_at', 'metadata',
] as const;

function buildInsertParams(msg: NewSessionMessage) {
  return [
    msg.session_id,
    msg.session_key ?? null,
    msg.ordinal ?? null,
    msg.role,
    msg.content ?? null,
    msg.tool_name ?? null,
    msg.tool_call_id ?? null,
    msg.thinking ?? null,
    msg.tokens_in ?? null,
    msg.tokens_out ?? null,
    msg.created_at ?? new Date(),
    msg.metadata ? JSON.stringify(msg.metadata) : null,
  ];
}

export class SessionMessageRepository {
  private pool: Pool;

  constructor(pool: Pool = defaultPool) {
    this.pool = pool;
  }

  /**
   * Insert a single message. Returns the persisted record.
   */
  async insert(msg: NewSessionMessage, client?: PoolClient): Promise<SessionMessage> {
    const placeholders = INSERT_COLS.map((_, i) => `$${i + 1}`).join(', ');
    // BUG-07a: ON CONFLICT DO NOTHING prevents duplicates on restart
    const sql = `
      INSERT INTO session_messages (${INSERT_COLS.join(', ')})
      VALUES (${placeholders})
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    const params = buildInsertParams(msg);
    const executor = client ?? this.pool;
    const result = await executor.query<SessionMessage>(sql, params);
    return result.rows[0];
  }

  /**
   * Bulk insert a batch of messages in a single transaction.
   * Optimised for high write throughput: all rows in one multi-value INSERT.
   * Falls back to individual inserts if batch size > 500 (avoids huge queries).
   */
  async bulkInsert(messages: NewSessionMessage[]): Promise<BulkInsertResult> {
    if (messages.length === 0) return { inserted: 0, duration_ms: 0 };

    const start = Date.now();
    const BATCH_SIZE = 500;
    const rows: SessionMessage[] = [];

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);
        const colCount = INSERT_COLS.length;

        const valuePlaceholders = batch
          .map((_, rowIdx) =>
            `(${INSERT_COLS.map((__, colIdx) => `$${rowIdx * colCount + colIdx + 1}`).join(', ')})`
          )
          .join(', ');

        // BUG-07a: ON CONFLICT DO NOTHING prevents duplicates when the ingester
        // re-reads a file from byte 0 after a backend restart.
        // The unique index uq_session_messages_dedup (migration 027) covers
        // (session_key, ordinal, role, COALESCE(tool_call_id, '')) WHERE ordinal IS NOT NULL.
        const sql = `
          INSERT INTO session_messages (${INSERT_COLS.join(', ')})
          VALUES ${valuePlaceholders}
          ON CONFLICT DO NOTHING
          RETURNING *
        `;

        const params = batch.flatMap(buildInsertParams);
        const result = await client.query<SessionMessage>(sql, params);
        rows.push(...result.rows);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return {
      inserted: rows.length,
      first_id: rows[0]?.id,
      last_id: rows[rows.length - 1]?.id,
      duration_ms: Date.now() - start,
    };
  }

  /**
   * Fetch messages for a session, ordered by (ordinal ASC, created_at ASC).
   * Uses the (session_id, ordinal) index.
   */
  async getBySession(
    sessionId: string,
    query: Omit<SessionMessageQuery, 'session_id' | 'session_key'> = {}
  ): Promise<SessionMessage[]> {
    const { role, tool_name, limit = 1000, offset = 0, order = 'asc' } = query;
    const params: unknown[] = [sessionId];
    const filters: string[] = ['session_id = $1'];

    if (role) {
      params.push(role);
      filters.push(`role = $${params.length}`);
    }
    if (tool_name) {
      params.push(tool_name);
      filters.push(`tool_name = $${params.length}`);
    }

    params.push(limit, offset);

    const sql = `
      SELECT * FROM session_messages
      WHERE ${filters.join(' AND ')}
      ORDER BY COALESCE(ordinal, 2147483647) ${order.toUpperCase()}, created_at ${order.toUpperCase()}
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `;

    const result = await this.pool.query<SessionMessage>(sql, params);
    return result.rows;
  }

  /**
   * Fetch messages by session_key (no join needed).
   * Uses the session_key index.
   */
  async getByKey(
    sessionKey: string,
    query: Omit<SessionMessageQuery, 'session_id' | 'session_key'> = {}
  ): Promise<SessionMessage[]> {
    const { role, tool_name, limit = 1000, offset = 0, order = 'asc' } = query;
    const params: unknown[] = [sessionKey];
    const filters: string[] = ['session_key = $1'];

    if (role) {
      params.push(role);
      filters.push(`role = $${params.length}`);
    }
    if (tool_name) {
      params.push(tool_name);
      filters.push(`tool_name = $${params.length}`);
    }

    params.push(limit, offset);

    const sql = `
      SELECT * FROM session_messages
      WHERE ${filters.join(' AND ')}
      ORDER BY COALESCE(ordinal, 2147483647) ${order.toUpperCase()}, created_at ${order.toUpperCase()}
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `;

    const result = await this.pool.query<SessionMessage>(sql, params);
    return result.rows;
  }

  /**
   * Count messages for a session (quick check).
   */
  async countBySession(sessionId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*) FROM session_messages WHERE session_id = $1',
      [sessionId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Delete all messages for a session (cleanup).
   */
  async deleteBySession(sessionId: string): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM session_messages WHERE session_id = $1',
      [sessionId]
    );
    return result.rowCount ?? 0;
  }
}

// Singleton for use across the app
export const sessionMessageRepository = new SessionMessageRepository();
