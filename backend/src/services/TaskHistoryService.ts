// TaskHistoryService.ts - Track task changes in the database for activity feed
import { pool } from '../db/connection';

export interface TaskHistoryEvent {
  type: string;
  taskId: string;
  taskTitle: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string;
  timestamp: string;
}

class TaskHistoryService {
  private columnCache: Set<string> | null = null;

  private async getColumns(): Promise<Set<string>> {
    if (this.columnCache) return this.columnCache;
    try {
      const result = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'task_history'`
      );
      this.columnCache = new Set(result.rows.map((row: any) => String(row.column_name)));
    } catch (err) {
      console.error('[TaskHistoryService] Error inspecting task_history schema:', err);
      this.columnCache = new Set();
    }
    return this.columnCache;
  }

  /**
   * Record a task change in the history table.
   * Supports both the newer task_history schema and the older live compatibility schema.
   */
  async recordChange(
    taskId: string,
    taskTitle: string,
    field: string,
    oldValue: string | null,
    newValue: string | null,
    changedBy: string = 'system'
  ): Promise<void> {
    try {
      const columns = await this.getColumns();
      if (columns.size === 0) return;

      if (columns.has('task_title') && columns.has('field') && columns.has('changed_by')) {
        await pool.query(
          `INSERT INTO task_history (task_id, task_title, field, old_value, new_value, changed_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [taskId, taskTitle, field, oldValue, newValue, changedBy]
        );
        return;
      }

      if (columns.has('event_type')) {
        const note = [`field=${field}`, changedBy ? `changedBy=${changedBy}` : null].filter(Boolean).join(' | ');
        await pool.query(
          `INSERT INTO task_history (task_id, event_type, old_value, new_value, note)
           VALUES ($1, $2, $3, $4, $5)`,
          [taskId, field, oldValue, newValue, note || null]
        );
      }
    } catch (err) {
      // Don't let history tracking break the main flow
      console.error('[TaskHistoryService] Error recording change:', err);
    }
  }

  /**
   * Get recent activity events.
   * Reads whichever task_history variant exists and joins tasks for titles when needed.
   */
  async getRecentActivity(limit: number = 10): Promise<TaskHistoryEvent[]> {
    try {
      const columns = await this.getColumns();
      if (columns.size === 0) return [];

      if (columns.has('task_title') && columns.has('field') && columns.has('changed_by')) {
        const result = await pool.query(
          `SELECT task_id, task_title, field, old_value, new_value, changed_by, created_at
           FROM task_history
           ORDER BY created_at DESC
           LIMIT $1`,
          [limit]
        );

        return result.rows.map((row: any) => ({
          type: this.getEventType(row.field),
          taskId: row.task_id,
          taskTitle: row.task_title,
          field: row.field,
          oldValue: row.old_value,
          newValue: row.new_value,
          changedBy: row.changed_by,
          timestamp: row.created_at.toISOString(),
        }));
      }

      if (columns.has('event_type')) {
        const result = await pool.query(
          `SELECT th.task_id, COALESCE(t.title, th.task_id::text) AS task_title,
                  th.event_type, th.old_value, th.new_value, th.note, th.created_at
           FROM task_history th
           LEFT JOIN tasks t ON t.id = th.task_id
           ORDER BY th.created_at DESC
           LIMIT $1`,
          [limit]
        );

        return result.rows.map((row: any) => ({
          type: this.getEventType(row.event_type),
          taskId: row.task_id,
          taskTitle: row.task_title,
          field: row.event_type,
          oldValue: row.old_value,
          newValue: row.new_value,
          changedBy: this.parseChangedBy(row.note),
          timestamp: row.created_at.toISOString(),
        }));
      }

      return [];
    } catch (err) {
      console.error('[TaskHistoryService] Error fetching activity:', err);
      return [];
    }
  }

  private parseChangedBy(note: string | null | undefined): string {
    const match = String(note || '').match(/changedBy=([^|]+)/);
    return match?.[1]?.trim() || 'system';
  }

  /**
   * Map field name to event type
   */
  private getEventType(field: string): string {
    switch (field) {
      case 'status': return 'status_change';
      case 'priority': return 'priority_change';
      case 'title': return 'title_change';
      case 'subtask': return 'subtask_update';
      default: return 'field_change';
    }
  }
}

export const taskHistoryService = new TaskHistoryService();
