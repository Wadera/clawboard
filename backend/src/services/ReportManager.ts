// ReportManager.ts - PostgreSQL-backed report/notes management
import { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';

export interface Report {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  tags: string[];
  project_id: string | null;
  project_name?: string;
  task_ids: string[];
  author: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface ReportListOptions {
  q?: string;
  tags?: string[];
  project_id?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

export interface ReportCreateData {
  title: string;
  content: string;
  summary?: string;
  tags?: string[];
  project_id?: string;
  task_ids?: string[];
  author?: string;
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
  pinned?: boolean;
}

export interface ReportListResult {
  reports: Report[];
  total: number;
  hasMore: boolean;
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
  private mapRow(row: any): Report {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      summary: row.summary || null,
      tags: row.tags || [],
      project_id: row.project_id || null,
      project_name: row.project_name || undefined,
      task_ids: row.task_ids || [],
      author: row.author || 'nim',
      pinned: row.pinned || false,
      created_at: row.created_at,
      updated_at: row.updated_at,
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

    // Text search on title and content
    if (opts.q) {
      const searchPattern = `%${opts.q}%`;
      conditions.push(`(r.title ILIKE $${paramIndex} OR r.content ILIKE $${paramIndex})`);
      params.push(searchPattern);
      paramIndex++;
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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
       ORDER BY r.pinned DESC, r.created_at DESC
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
   * Get a single report by ID with project name resolved
   */
  async getById(id: string): Promise<Report | null> {
    const result = await this.pool.query(
      `SELECT r.*, p.name as project_name
       FROM reports r
       LEFT JOIN projects p ON r.project_id = p.id
       WHERE r.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  /**
   * Create a new report
   * Auto-generates summary from first 500 chars of content if not provided
   */
  async create(data: ReportCreateData): Promise<Report> {
    // Auto-generate summary if not provided
    const summary = data.summary || this.generateSummary(data.content);

    const result = await this.pool.query(
      `INSERT INTO reports (title, content, summary, tags, project_id, task_ids, author, pinned)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        data.title,
        data.content,
        summary,
        data.tags || [],
        data.project_id || null,
        data.task_ids || [],
        data.author || 'nim',
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
    if (data.content !== undefined) addField('content', data.content);
    if (data.summary !== undefined) addField('summary', data.summary);
    if (data.tags !== undefined) addField('tags', data.tags);
    if (data.project_id !== undefined) addField('project_id', data.project_id);
    if (data.task_ids !== undefined) addField('task_ids', data.task_ids);
    if (data.author !== undefined) addField('author', data.author);
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
   * Delete a report
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM reports WHERE id = $1',
      [id]
    );

    if (result.rowCount === 0) {
      return false;
    }

    console.log('[ReportManager] Deleted report:', id);
    return true;
  }

  /**
   * Get total count of reports (for dashboard stats)
   */
  async getCount(): Promise<number> {
    const result = await this.pool.query('SELECT COUNT(*) as total FROM reports');
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
