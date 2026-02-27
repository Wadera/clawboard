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
  /**
   * Record a task change in the history table
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
      await pool.query(
        `INSERT INTO task_history (task_id, task_title, field, old_value, new_value, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [taskId, taskTitle, field, oldValue, newValue, changedBy]
      );
    } catch (err) {
      // Don't let history tracking break the main flow
      console.error('[TaskHistoryService] Error recording change:', err);
    }
  }

  /**
   * Get recent activity events
   */
  async getRecentActivity(limit: number = 10): Promise<TaskHistoryEvent[]> {
    try {
      const result = await pool.query(
        `SELECT task_id, task_title, field, old_value, new_value, changed_by, created_at
         FROM task_history
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );

      return result.rows.map(row => ({
        type: this.getEventType(row.field),
        taskId: row.task_id,
        taskTitle: row.task_title,
        field: row.field,
        oldValue: row.old_value,
        newValue: row.new_value,
        changedBy: row.changed_by,
        timestamp: row.created_at.toISOString(),
      }));
    } catch (err) {
      console.error('[TaskHistoryService] Error fetching activity:', err);
      return [];
    }
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
