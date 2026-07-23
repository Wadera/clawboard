// ReportManager.ts - PostgreSQL-backed report/notes management
import crypto from 'crypto';
import { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';

export interface Report {
  id: string;
  title: string;
  content: string;
  /** sha256 hex digest of content, computed server-side on INSERT/UPDATE (migration 056). */
  content_hash: string | null;
  summary: string | null;
  tags: string[];
  project_id: string | null;
  project_name?: string;
  task_ids: string[];
  /** Free-form, client-supplied author label. NOT verified — see author_actor_id. */
  author: string;
  /** Alias of `author` that makes its unverified nature explicit to consumers (migration 058). */
  author_unverified: string;
  /** Authenticated identity (req.userId) recorded server-side on POST; never client-settable. */
  author_actor_id: string | null;
  /** Creating surface ('api' | 'cli' | 'dashboard' | ...), from X-ClawBoard-Origin (migration 059). */
  origin: string;
  /** Visibility label (migration 061). Plumbing only — enforcement is fabric-side. */
  visibility: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  /** Tombstone timestamp (migration 060). Non-null rows are hidden unless include_deleted. */
  deleted_at: string | null;
}

export type ReportSortField = 'updated_at' | 'created_at';
export type ReportSortOrder = 'asc' | 'desc';

export interface ReportListOptions {
  q?: string;
  tags?: string[];
  project_id?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
  /** Inclusive lower bound on updated_at (ISO8601). Clients dedupe boundary rows by id. */
  updated_since?: string;
  /** Explicit sort column. When set, ordering is `<sort> <order>, id <order>` (stable). Default keeps legacy pinned-first ordering. */
  sort?: ReportSortField;
  /** Sort direction for `sort`; ignored without it. Default 'desc'. */
  order?: ReportSortOrder;
  /** Opt-in: include soft-deleted (tombstoned) rows. Default false. */
  include_deleted?: boolean;
}

export interface ReportCreateData {
  title: string;
  content: string;
  summary?: string;
  tags?: string[];
  project_id?: string;
  task_ids?: string[];
  author?: string;
  /** Set by the route layer from the authenticated identity only — never from the request body. */
  author_actor_id?: string | null;
  /** Set by the route layer from the validated X-ClawBoard-Origin header; defaults to 'api'. */
  origin?: string;
  /** Visibility label; validated by the route layer. Defaults to 'default'. */
  visibility?: string;
  pinned?: boolean;
}

export interface ReportUpdateData {
  title?: string;
  content?: string;
  summary?: string;
  tags?: string[];
  project_id?: string | null;
  task_ids?: string[];
  author?: string;
  /** Visibility label; validated by the route layer. */
  visibility?: string;
  pinned?: boolean;
}

export interface ReportListResult {
  reports: Report[];
  total: number;
  hasMore: boolean;
}

export interface ReviewerReportSummary {
  id: string;
  title: string;
  summary: string | null;
  content: string;
}

/**
 * A search query that IS a report id or id-prefix: at least the 8-char short id,
 * optionally continuing as a (partial) UUID. Hex + hyphens only, so it can never
 * carry LIKE wildcards into the id match.
 */
export function isReportIdQuery(q: string): boolean {
  return /^[0-9a-f]{8}(-[0-9a-f-]{0,28})?$/i.test(q.trim());
}

/**
 * PostgreSQL-backed Report Manager
 * Manages markdown reports/notes linked to projects and tasks
 */
export class ReportManager {
  private pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool || defaultPool;
  }

  /**
   * Map a database row to a Report object
   */
  /** sha256 hex digest of report content; single source of truth for content_hash. */
  static computeContentHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  private mapRow(row: any): Report {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      content_hash: row.content_hash || null,
      summary: row.summary || null,
      tags: row.tags || [],
      project_id: row.project_id || null,
      project_name: row.project_name || undefined,
      task_ids: row.task_ids || [],
      author: row.author || 'nim',
      author_unverified: row.author || 'nim',
      author_actor_id: row.author_actor_id || null,
      origin: row.origin || 'api',
      visibility: row.visibility || 'default',
      pinned: row.pinned || false,
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at || null,
    };
  }

  /**
   * List reports with pagination, filtering, and search
   */
  async list(opts: ReportListOptions = {}): Promise<ReportListResult> {
    const limit = Math.min(Math.max(opts.limit || 10, 1), 100);
    const offset = Math.max(opts.offset || 0, 0);

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    // Soft-deleted rows are invisible unless explicitly requested.
    if (!opts.include_deleted) {
      conditions.push('r.deleted_at IS NULL');
    }

    // Text search on title and content — except when q IS a report id/prefix:
    // ids are exchanged constantly (agents cite them in every report), so a
    // pasted id means "this exact report", not "reports that mention this id".
    if (opts.q) {
      if (isReportIdQuery(opts.q)) {
        conditions.push(`r.id::text ILIKE $${paramIndex}`);
        params.push(`${opts.q.trim().toLowerCase()}%`);
        paramIndex++;
      } else {
        const searchPattern = `%${opts.q}%`;
        conditions.push(`(r.title ILIKE $${paramIndex} OR r.content ILIKE $${paramIndex})`);
        params.push(searchPattern);
        paramIndex++;
      }
    }

    // Tag filter (contains all specified tags)
    if (opts.tags && opts.tags.length > 0) {
      conditions.push(`r.tags @> $${paramIndex}::text[]`);
      params.push(opts.tags);
      paramIndex++;
    }

    // Project filter
    if (opts.project_id) {
      conditions.push(`r.project_id = $${paramIndex}`);
      params.push(opts.project_id);
      paramIndex++;
    }

    // Pinned filter
    if (opts.pinned !== undefined) {
      conditions.push(`r.pinned = $${paramIndex}`);
      params.push(opts.pinned);
      paramIndex++;
    }

    // Incremental-sync filter: rows touched at or after the given instant.
    // Inclusive (>=) so boundary rows are never lost between polls; clients
    // dedupe by id. Route layer validates ISO8601 before it reaches here.
    if (opts.updated_since) {
      conditions.push(`r.updated_at >= $${paramIndex}::timestamptz`);
      params.push(opts.updated_since);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Explicit sort (updated_at|created_at) with a stable id tiebreak; the
    // legacy pinned-first ordering remains the default behaviour.
    const sortColumn = opts.sort === 'updated_at' ? 'r.updated_at'
      : opts.sort === 'created_at' ? 'r.created_at'
      : null;
    const sortDirection = opts.order === 'asc' ? 'ASC' : 'DESC';
    const orderClause = sortColumn
      ? `ORDER BY ${sortColumn} ${sortDirection}, r.id ${sortDirection}`
      : 'ORDER BY r.pinned DESC, r.created_at DESC';

    // Get total count
    const countResult = await this.pool.query(
      `SELECT COUNT(*) as total FROM reports r ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Get paginated results with project name join
    const dataParams = [...params, limit, offset];
    const dataResult = await this.pool.query(
      `SELECT r.*, p.name as project_name
       FROM reports r
       LEFT JOIN projects p ON r.project_id = p.id
       ${whereClause}
       ${orderClause}
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      dataParams
    );

    const reports = dataResult.rows.map((row: any) => this.mapRow(row));

    return {
      reports,
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Get a single report by ID with project name resolved.
   * Soft-deleted rows return null unless opts.includeDeleted.
   */
  async getById(id: string, opts: { includeDeleted?: boolean } = {}): Promise<Report | null> {
    const result = await this.pool.query(
      `SELECT r.*, p.name as project_name
       FROM reports r
       LEFT JOIN projects p ON r.project_id = p.id
       WHERE r.id = $1${opts.includeDeleted ? '' : ' AND r.deleted_at IS NULL'}`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  async getByTaskId(taskId: string): Promise<ReviewerReportSummary[]> {
    const result = await this.pool.query(
      `SELECT id, title, summary, content
       FROM reports
       WHERE $1::uuid = ANY(task_ids) AND deleted_at IS NULL
       ORDER BY pinned DESC, created_at DESC`,
      [taskId]
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      title: row.title,
      summary: row.summary || null,
      content: row.content,
    }));
  }

  /**
   * Create a new report
   * Auto-generates summary from first 500 chars of content if not provided
   */
  async create(data: ReportCreateData): Promise<Report> {
    // Auto-generate summary if not provided
    const summary = data.summary || this.generateSummary(data.content);

    const result = await this.pool.query(
      `INSERT INTO reports (title, content, content_hash, summary, tags, project_id, task_ids, author, author_actor_id, origin, visibility, pinned)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        data.title,
        data.content,
        ReportManager.computeContentHash(data.content),
        summary,
        data.tags || [],
        data.project_id || null,
        data.task_ids || [],
        data.author || 'nim',
        data.author_actor_id || null,
        data.origin || 'api',
        data.visibility || 'default',
        data.pinned || false,
      ]
    );

    const report = await this.getById(result.rows[0].id);
    console.log('[ReportManager] Created report:', report!.id, report!.title);
    return report!;
  }

  /**
   * Update an existing report (partial update)
   */
  async update(id: string, data: ReportUpdateData): Promise<Report | null> {
    // Check if report exists
    const existing = await this.getById(id);
    if (!existing) {
      return null;
    }

    const fields: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    const addField = (column: string, value: any) => {
      fields.push(`${column} = $${paramIndex++}`);
      params.push(value);
    };

    if (data.title !== undefined) addField('title', data.title);
    if (data.content !== undefined) {
      addField('content', data.content);
      addField('content_hash', ReportManager.computeContentHash(data.content));
    }
    if (data.summary !== undefined) addField('summary', data.summary);
    if (data.tags !== undefined) addField('tags', data.tags);
    if (data.project_id !== undefined) addField('project_id', data.project_id);
    if (data.task_ids !== undefined) addField('task_ids', data.task_ids);
    if (data.author !== undefined) addField('author', data.author);
    if (data.visibility !== undefined) addField('visibility', data.visibility);
    if (data.pinned !== undefined) addField('pinned', data.pinned);

    // Always update updated_at
    addField('updated_at', new Date().toISOString());

    if (fields.length === 0) {
      return existing;
    }

    params.push(id);
    await this.pool.query(
      `UPDATE reports SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
      params
    );

    const updated = await this.getById(id);
    console.log('[ReportManager] Updated report:', id);
    return updated;
  }

  /**
   * Soft delete: tombstone the report (deleted_at = NOW()). Already-deleted
   * rows are not re-stamped — they behave as missing (false).
   */
  async softDelete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE reports SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (result.rowCount === 0) {
      return false;
    }

    console.log('[ReportManager] Soft-deleted report:', id);
    return true;
  }

  /**
   * Hard delete: destroy the row. Route layer restricts this to the
   * dashboard_user identity (?hard=true escape hatch). Works on tombstoned
   * rows too, so soft-deleted reports can still be purged.
   */
  async hardDelete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM reports WHERE id = $1',
      [id]
    );

    if (result.rowCount === 0) {
      return false;
    }

    console.log('[ReportManager] Hard-deleted report:', id);
    return true;
  }

  /** @deprecated Destructive path kept for compatibility; prefer softDelete/hardDelete. */
  async delete(id: string): Promise<boolean> {
    return this.hardDelete(id);
  }

  /**
   * Get total count of reports (for dashboard stats). Excludes tombstones.
   */
  async getCount(): Promise<number> {
    const result = await this.pool.query('SELECT COUNT(*) as total FROM reports WHERE deleted_at IS NULL');
    return parseInt(result.rows[0].total, 10);
  }

  /**
   * Generate a summary from content (first 500 chars, trimmed to last word boundary)
   */
  private generateSummary(content: string): string {
    if (content.length <= 500) {
      return content.replace(/\n/g, ' ').trim();
    }

    // Strip markdown formatting for cleaner summary
    let plain = content
      .replace(/^#{1,6}\s+/gm, '')     // headers
      .replace(/\*\*(.+?)\*\*/g, '$1') // bold
      .replace(/\*(.+?)\*/g, '$1')     // italic
      .replace(/`(.+?)`/g, '$1')       // inline code
      .replace(/\n/g, ' ')             // newlines
      .trim();

    if (plain.length <= 500) {
      return plain;
    }

    // Trim to last word boundary within 500 chars
    const trimmed = plain.substring(0, 500);
    const lastSpace = trimmed.lastIndexOf(' ');
    return (lastSpace > 400 ? trimmed.substring(0, lastSpace) : trimmed) + '...';
  }
}

// Singleton instance
export const reportManager = new ReportManager();
