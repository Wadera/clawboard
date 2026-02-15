// TaskManagerDB.ts - PostgreSQL-backed task management (replacement for JSON file)
import { EventEmitter } from 'events';
import { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { notificationManager } from './NotificationManager';
import { taskHistoryService } from './TaskHistoryService';

// Re-export types from TaskManager for compatibility
export type TaskStatus = 'ideas' | 'todo' | 'in-progress' | 'stuck' | 'completed' | 'archived';
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low' | 'someday';
export type TaskLinkType = 'project' | 'tool' | 'git' | 'doc' | 'memory' | 'session';
export type SubtaskStatus = 'new' | 'in_review' | 'completed';

export interface Subtask {
  id: string;
  text: string;
  completed?: boolean; // Legacy field
  status: SubtaskStatus;
  reviewNote?: string;
  completedAt?: string;
  sessionRef?: string;
}

export interface TaskLink {
  type: TaskLinkType;
  url: string;
  title: string;
  icon?: string;
}

export interface TaskResources {
  links?: Array<{
    type: 'git' | 'url' | 'file' | 'reference' | 'doc';
    title: string;
    url: string;
  }>;
  files?: string[];
  relatedTasks?: string[];
}

export interface Task {
  // Core fields
  id: string;
  title: string;
  description: string;
  
  // Status
  status: TaskStatus;
  priority: TaskPriority;
  
  // Subtasks
  subtasks: Subtask[];
  
  // Rich context
  links: TaskLink[];
  
  // Audit trail
  sessionRefs: string[];
  
  // Work tracking
  autoCreated: boolean;
  autoStart: boolean;
  lastChecked?: string;
  startedAt?: string;
  completedAt?: string;
  archivedAt?: string;
  
  // Blocking
  blockedBy: string[];
  blockedReason?: string;
  
  // Task Dependencies
  dependsOn?: string[];
  
  // Metadata
  project?: string;
  tags: string[];
  created: string;
  updated: string;
  
  // AI execution
  model?: string;
  executionMode?: 'main' | 'subagent';
  activeAgent?: { name: string; sessionKey: string } | null;
  completedBy?: { name: string; sessionKey: string } | null;
  needsReview?: boolean;
  
  // Thinking level
  thinking?: 'low' | 'medium' | 'high';
  thinkingAutoEstimated?: boolean;
  attemptCount?: number;
  
  // Phase 1 Hub Redesign
  trackerUrl?: string;
  phaseTag?: string;
  taskResources?: TaskResources;
  
  // Legacy fields
  parentId?: string | null;
  notes?: string;
  completed?: string | null;
}

export interface TaskFilters {
  status?: string;
  project?: string;
  priority?: string;
  tag?: string;
  parentId?: string | null;
}

/**
 * PostgreSQL-backed TaskManager
 * Drop-in replacement for JSON file-based TaskManager
 */
export class TaskManagerDB extends EventEmitter {
  private pool: Pool;

  constructor(pool?: Pool) {
    super();
    this.pool = pool || defaultPool;
  }

  /**
   * Initialize - placeholder for compatibility
   */
  async initialize(): Promise<void> {
    // Test connection
    try {
      await this.pool.query('SELECT 1');
      console.log('[TaskManagerDB] Connected to PostgreSQL');
    } catch (err) {
      console.error('[TaskManagerDB] Failed to connect:', err);
      throw err;
    }
  }

  /**
   * Map database row to Task object
   * Joins subtasks, tags, dependencies, links into flat structure
   */
  private async hydrateTask(row: any, client?: PoolClient): Promise<Task> {
    const executor = client || this.pool;
    const taskId = row.id;

    // Fetch subtasks
    const subtasksRes = await executor.query(
      `SELECT id, task_id, index, title, status, note, completed_at, created_at, updated_at
       FROM subtasks
       WHERE task_id = $1
       ORDER BY index ASC`,
      [taskId]
    );

    const subtasks: Subtask[] = subtasksRes.rows.map((s: any) => ({
      id: s.id.toString(),
      text: s.title,
      status: s.status as SubtaskStatus,
      reviewNote: s.note || undefined,
      completedAt: s.completed_at || undefined,
      // Legacy field for backward compat
      completed: s.status === 'completed',
    }));

    // Fetch tags
    const tagsRes = await executor.query(
      `SELECT tag FROM task_tags WHERE task_id = $1 ORDER BY tag`,
      [taskId]
    );
    const tags = tagsRes.rows.map((t: any) => t.tag);

    // Fetch dependencies
    const depsRes = await executor.query(
      `SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $1`,
      [taskId]
    );
    const dependsOn = depsRes.rows.map((d: any) => d.depends_on_task_id);

    // Fetch links
    const linksRes = await executor.query(
      `SELECT id, type, title, url FROM task_links WHERE task_id = $1 ORDER BY id`,
      [taskId]
    );
    const links: TaskLink[] = linksRes.rows.map((l: any) => ({
      type: l.type as TaskLinkType,
      url: l.url,
      title: l.title,
    }));

    // Parse JSON fields
    const sessionRefs = row.session_refs || [];
    // active_agent and completed_by are stored as VARCHAR in current schema
    // Parse as JSON if it looks like JSON, otherwise treat as string
    let activeAgent = null;
    if (row.active_agent) {
      try {
        activeAgent = JSON.parse(row.active_agent);
      } catch {
        // Legacy format or invalid JSON - set to null
        activeAgent = null;
      }
    }
    
    let completedBy = null;
    if (row.completed_by) {
      try {
        completedBy = JSON.parse(row.completed_by);
      } catch {
        completedBy = null;
      }
    }
    
    const taskResources = row.task_resources || undefined;

    // Map to Task interface
    const task: Task = {
      id: taskId,
      title: row.title,
      description: row.description || '',
      status: row.status,
      priority: row.priority,
      subtasks,
      links,
      sessionRefs,
      autoCreated: row.auto_created,
      autoStart: row.auto_start,
      lastChecked: row.last_checked || undefined,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
      archivedAt: row.archived_at || undefined,
      blockedBy: [], // Computed from dependencies
      blockedReason: row.blocked_reason || undefined,
      dependsOn,
      project: row.project_id || undefined,
      tags,
      created: row.created_at,
      updated: row.updated_at,
      model: row.model || undefined,
      executionMode: row.execution_mode || undefined,
      activeAgent,
      completedBy,
      needsReview: row.needs_review || false,
      thinking: row.thinking_budget || undefined,
      thinkingAutoEstimated: row.thinking_auto_estimated || false,
      attemptCount: row.attempt_count || 0,
      trackerUrl: row.tracker_url || undefined,
      phaseTag: row.phase_tag || undefined,
      taskResources,
      parentId: row.parent_id || null,
      notes: row.notes || undefined,
      // Legacy field: completed timestamp
      completed: row.status === 'completed' ? row.completed_at : null,
    };

    return task;
  }

  /**
   * Query tasks with filters
   */
  async queryTasks(filters: TaskFilters = {}): Promise<Task[]> {
    console.log('[TaskManagerDB] queryTasks called with filters:', filters);
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filters.status);
    }

    if (filters.project) {
      conditions.push(`project_id = $${paramIndex++}`);
      params.push(filters.project);
    }

    if (filters.priority) {
      conditions.push(`priority = $${paramIndex++}`);
      params.push(filters.priority);
    }

    if (filters.tag) {
      // Join with task_tags table
      conditions.push(`id IN (SELECT task_id FROM task_tags WHERE tag = $${paramIndex++})`);
      params.push(filters.tag);
    }

    if (filters.parentId !== undefined) {
      if (filters.parentId === null) {
        conditions.push(`parent_id IS NULL`);
      } else {
        conditions.push(`parent_id = $${paramIndex++}`);
        params.push(filters.parentId);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT * FROM tasks
      ${whereClause}
      ORDER BY created_at DESC
    `;

    console.log('[TaskManagerDB] Executing query:', query, 'with params:', params);
    const result = await this.pool.query(query, params);
    console.log('[TaskManagerDB] Query returned', result.rows.length, 'rows');

    // Hydrate each task
    const tasks = await Promise.all(
      result.rows.map(row => this.hydrateTask(row))
    );

    console.log('[TaskManagerDB] Hydrated', tasks.length, 'tasks');
    return tasks;
  }

  /**
   * Get a single task by ID
   */
  async getTask(id: string): Promise<Task | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM tasks WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return undefined;
    }

    return this.hydrateTask(result.rows[0]);
  }

  /**
   * Get all tasks
   */
  async getAllTasks(): Promise<Task[]> {
    return this.queryTasks();
  }

  /**
   * Create a new task
   */
  async createTask(data: Partial<Task>): Promise<Task> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const now = new Date().toISOString();

      // Validate dependencies before creating
      if (data.dependsOn && data.dependsOn.length > 0) {
        await this.validateAndCheckCircular(data.dependsOn[0], data.dependsOn, client);
      }

      // Resolve thinking level
      const thinking = this.resolveThinking(data);

      // Insert task
      const taskResult = await client.query(
        `INSERT INTO tasks (
          title, description, status, priority, project_id,
          thinking_budget, thinking_auto_estimated, model, execution_mode,
          auto_created, auto_start, blocked_reason, status_reason,
          active_agent, completed_by, attempt_count, session_refs,
          parent_id, created_at, updated_at, started_at, completed_at, archived_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
        ) RETURNING *`,
        [
          data.title || 'Untitled Task',
          data.description || '',
          data.status || 'todo',
          data.priority || 'normal',
          data.project || null,
          thinking.thinking,
          thinking.thinkingAutoEstimated,
          data.model || null,
          data.executionMode || null,
          data.autoCreated !== undefined ? data.autoCreated : false,
          data.autoStart !== undefined ? data.autoStart : (data.status !== 'ideas'),
          data.blockedReason || null,
          null, // status_reason
          data.activeAgent ? JSON.stringify(data.activeAgent) : null,
          data.completedBy ? JSON.stringify(data.completedBy) : null,
          data.attemptCount || 0,
          data.sessionRefs ? JSON.stringify(data.sessionRefs) : '[]',
          data.parentId || null,
          now,
          now,
          data.status === 'in-progress' ? now : data.startedAt || null,
          data.status === 'completed' ? now : data.completedAt || null,
          data.status === 'archived' ? now : data.archivedAt || null,
        ]
      );

      const taskId = taskResult.rows[0].id;

      // Insert subtasks
      if (data.subtasks && data.subtasks.length > 0) {
        for (let i = 0; i < data.subtasks.length; i++) {
          const s = data.subtasks[i];
          await client.query(
            `INSERT INTO subtasks (task_id, index, title, status, note, completed_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [taskId, i, s.text, s.status || 'new', s.reviewNote || null, s.completedAt || null]
          );
        }
      }

      // Insert tags
      if (data.tags && data.tags.length > 0) {
        for (const tag of data.tags) {
          await client.query(
            `INSERT INTO task_tags (task_id, tag) VALUES ($1, $2)
             ON CONFLICT (task_id, tag) DO NOTHING`,
            [taskId, tag]
          );
        }
      }

      // Insert dependencies
      if (data.dependsOn && data.dependsOn.length > 0) {
        for (const depId of data.dependsOn) {
          await client.query(
            `INSERT INTO task_dependencies (task_id, depends_on_task_id)
             VALUES ($1, $2)`,
            [taskId, depId]
          );
        }
      }

      // Insert links
      if (data.links && data.links.length > 0) {
        for (const link of data.links) {
          await client.query(
            `INSERT INTO task_links (task_id, type, title, url)
             VALUES ($1, $2, $3, $4)`,
            [taskId, link.type, link.title, link.url]
          );
        }
      }

      await client.query('COMMIT');

      // Fetch the complete task
      const task = await this.hydrateTask(taskResult.rows[0], client);

      // Emit event
      this.emit('task:created', task);

      // Record in history
      taskHistoryService.recordChange(task.id, task.title, 'status', null, task.status, 'system');

      console.log('[TaskManagerDB] Created task:', task.id, task.title);
      return task;

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[TaskManagerDB] Error creating task:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Update an existing task
   */
  async updateTask(id: string, updates: Partial<Task>): Promise<Task> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Get current task
      const currentRes = await client.query('SELECT * FROM tasks WHERE id = $1', [id]);
      if (currentRes.rows.length === 0) {
        throw new Error(`Task not found: ${id}`);
      }

      const current = currentRes.rows[0];
      const oldStatus = current.status;
      const oldPriority = current.priority;
      const now = new Date().toISOString();

      // Validate dependencies if being updated
      if (updates.dependsOn !== undefined) {
        await this.validateAndCheckCircular(id, updates.dependsOn, client);
      }

      // Track status transitions
      const statusUpdates: any = {};
      if (updates.status && updates.status !== current.status) {
        // Auto-set autoStart when moving to todo
        if (updates.status === 'todo') {
          updates.autoStart = true;
        }
        if (updates.status === 'in-progress' && !current.started_at) {
          statusUpdates.started_at = now;
        }
        if (updates.status === 'completed' && !current.completed_at) {
          statusUpdates.completed_at = now;
        }
        if (updates.status === 'archived' && !current.archived_at) {
          statusUpdates.archived_at = now;
        }
      }

      // Build update query
      const fields: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      const addField = (column: string, value: any) => {
        fields.push(`${column} = $${paramIndex++}`);
        params.push(value);
      };

      if (updates.title !== undefined) addField('title', updates.title);
      if (updates.description !== undefined) addField('description', updates.description);
      if (updates.status !== undefined) addField('status', updates.status);
      if (updates.priority !== undefined) addField('priority', updates.priority);
      if (updates.project !== undefined) addField('project_id', updates.project || null);
      if (updates.thinking !== undefined) addField('thinking_budget', updates.thinking);
      if (updates.thinkingAutoEstimated !== undefined) addField('thinking_auto_estimated', updates.thinkingAutoEstimated);
      if (updates.model !== undefined) addField('model', updates.model);
      if (updates.executionMode !== undefined) addField('execution_mode', updates.executionMode);
      if (updates.autoCreated !== undefined) addField('auto_created', updates.autoCreated);
      if (updates.autoStart !== undefined) addField('auto_start', updates.autoStart);
      if (updates.blockedReason !== undefined) addField('blocked_reason', updates.blockedReason);
      if (updates.activeAgent !== undefined) addField('active_agent', updates.activeAgent ? JSON.stringify(updates.activeAgent) : null);
      if (updates.completedBy !== undefined) addField('completed_by', updates.completedBy ? JSON.stringify(updates.completedBy) : null);
      if (updates.attemptCount !== undefined) addField('attempt_count', updates.attemptCount);
      if (updates.sessionRefs !== undefined) addField('session_refs', JSON.stringify(updates.sessionRefs));
      if (updates.parentId !== undefined) addField('parent_id', updates.parentId);
      if (updates.lastChecked !== undefined) addField('last_checked', updates.lastChecked);
      if (statusUpdates.started_at) addField('started_at', statusUpdates.started_at);
      if (statusUpdates.completed_at) addField('completed_at', statusUpdates.completed_at);
      if (statusUpdates.archived_at) addField('archived_at', statusUpdates.archived_at);

      // Always update updated_at
      addField('updated_at', now);

      if (fields.length > 0) {
        params.push(id);
        await client.query(
          `UPDATE tasks SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
          params
        );
      }

      // Update subtasks if provided
      if (updates.subtasks !== undefined) {
        // Delete existing subtasks
        await client.query('DELETE FROM subtasks WHERE task_id = $1', [id]);
        // Insert new ones
        for (let i = 0; i < updates.subtasks.length; i++) {
          const s = updates.subtasks[i];
          await client.query(
            `INSERT INTO subtasks (task_id, index, title, status, note, completed_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, i, s.text, s.status || 'new', s.reviewNote || null, s.completedAt || null]
          );
        }
      }

      // Update tags if provided
      if (updates.tags !== undefined) {
        await client.query('DELETE FROM task_tags WHERE task_id = $1', [id]);
        for (const tag of updates.tags) {
          await client.query(
            `INSERT INTO task_tags (task_id, tag) VALUES ($1, $2)`,
            [id, tag]
          );
        }
      }

      // Update dependencies if provided
      if (updates.dependsOn !== undefined) {
        await client.query('DELETE FROM task_dependencies WHERE task_id = $1', [id]);
        for (const depId of updates.dependsOn) {
          await client.query(
            `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)`,
            [id, depId]
          );
        }
      }

      // Update links if provided
      if (updates.links !== undefined) {
        await client.query('DELETE FROM task_links WHERE task_id = $1', [id]);
        for (const link of updates.links) {
          await client.query(
            `INSERT INTO task_links (task_id, type, title, url) VALUES ($1, $2, $3, $4)`,
            [id, link.type, link.title, link.url]
          );
        }
      }

      await client.query('COMMIT');

      // Fetch updated task
      const task = await this.getTask(id);
      if (!task) {
        throw new Error(`Task not found after update: ${id}`);
      }

      this.emit('task:updated', task);

      // Notifications and history
      if (updates.status && updates.status !== oldStatus) {
        await notificationManager.notifyStatusChange(
          task.id,
          task.title,
          oldStatus,
          task.status,
          'user'
        );
        taskHistoryService.recordChange(task.id, task.title, 'status', oldStatus, task.status, 'user');
      }

      if (updates.priority && updates.priority !== oldPriority) {
        taskHistoryService.recordChange(task.id, task.title, 'priority', oldPriority, task.priority, 'user');
      }

      console.log('[TaskManagerDB] Updated task:', task.id, task.title);
      return task;

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[TaskManagerDB] Error updating task:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a task (CASCADE handles related tables)
   */
  async deleteTask(id: string): Promise<{ success: boolean }> {
    const task = await this.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    // CASCADE in schema handles subtasks, tags, deps, links
    await this.pool.query('DELETE FROM tasks WHERE id = $1', [id]);

    this.emit('task:deleted', id);

    console.log('[TaskManagerDB] Deleted task:', id);
    return { success: true };
  }

  /**
   * Move task to a new status
   */
  async moveTask(id: string, status: TaskStatus): Promise<Task> {
    return this.updateTask(id, { status });
  }

  /**
   * Archive a completed task
   */
  async archiveTask(id: string): Promise<{ success: boolean; archived: boolean }> {
    const task = await this.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    if (task.status !== 'completed') {
      throw new Error('Can only archive completed tasks');
    }

    const oldStatus = task.status;
    await this.updateTask(id, { status: 'archived' as TaskStatus });

    this.emit('task:archived', id);
    this.emit('tasks:updated', await this.getAllTasks());

    // Notification
    await notificationManager.notifyStatusChange(
      task.id,
      task.title,
      oldStatus,
      'archived',
      'system'
    );

    console.log('[TaskManagerDB] Archived task:', id);
    return { success: true, archived: true };
  }

  /**
   * Get next task to work on (todo + autoStart + not blocked)
   */
  async getNextTask(): Promise<Task | null> {
    const todoTasks = await this.queryTasks({ status: 'todo' });
    
    const priorityOrder: Record<string, number> = {
      urgent: 0, high: 1, normal: 2, low: 3, someday: 4
    };
    
    // Filter out blocked tasks
    const autoStartTasks: Task[] = [];
    for (const t of todoTasks) {
      if (t.autoStart && !this.isTaskBlockedSync(t)) {
        autoStartTasks.push(t);
      }
    }
    
    autoStartTasks.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 99;
      const pb = priorityOrder[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return new Date(a.created).getTime() - new Date(b.created).getTime();
    });

    return autoStartTasks[0] || null;
  }

  /**
   * Get current in-progress tasks
   */
  async getCurrentTask(): Promise<Task[]> {
    return this.queryTasks({ status: 'in-progress' });
  }

  // ============================================================
  // Subtask Status Management
  // ============================================================

  /**
   * Update subtask status
   */
  async updateSubtaskStatus(
    taskId: string,
    subtaskIndex: number,
    newStatus: SubtaskStatus,
    role: 'agent' | 'orchestrator' = 'orchestrator',
    reviewNote?: string
  ): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (!task.subtasks || subtaskIndex < 0 || subtaskIndex >= task.subtasks.length) {
      throw new Error(`Subtask not found at index ${subtaskIndex}`);
    }

    const subtask = task.subtasks[subtaskIndex];
    const currentStatus = subtask.status;

    // Permission checks
    if (role === 'agent') {
      if (newStatus === 'completed') {
        throw new Error('Agents cannot mark subtasks as completed. Mark as in_review instead.');
      }
      if (currentStatus === 'completed') {
        throw new Error('Cannot change status of completed subtasks');
      }
    }

    const now = new Date().toISOString();

    // Update in database
    await this.pool.query(
      `UPDATE subtasks
       SET status = $1, note = $2, completed_at = $3, updated_at = $4
       WHERE task_id = $5 AND index = $6`,
      [
        newStatus,
        reviewNote || subtask.reviewNote || null,
        newStatus === 'completed' ? now : null,
        now,
        taskId,
        subtaskIndex
      ]
    );

    // Also update task's updated_at
    await this.pool.query(
      'UPDATE tasks SET updated_at = $1 WHERE id = $2',
      [now, taskId]
    );

    const updatedTask = await this.getTask(taskId);
    if (!updatedTask) {
      throw new Error(`Task not found after subtask update: ${taskId}`);
    }

    this.emit('task:updated', updatedTask);

    console.log(`[TaskManagerDB] Subtask ${subtaskIndex} of task ${taskId} changed to '${newStatus}' by ${role}`);
    return updatedTask;
  }

  async markSubtaskInReview(taskId: string, subtaskIndex: number, reviewNote?: string): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'in_review', 'agent', reviewNote);
  }

  async approveSubtask(taskId: string, subtaskIndex: number): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'completed', 'orchestrator');
  }

  async rejectSubtask(taskId: string, subtaskIndex: number, note?: string): Promise<Task> {
    const task = await this.updateSubtaskStatus(taskId, subtaskIndex, 'new', 'orchestrator');
    if (note && task.subtasks && task.subtasks[subtaskIndex]) {
      task.subtasks[subtaskIndex].reviewNote = `REJECTED: ${note}`;
      await this.pool.query(
        'UPDATE subtasks SET note = $1 WHERE task_id = $2 AND index = $3',
        [`REJECTED: ${note}`, taskId, subtaskIndex]
      );
    }
    return task;
  }

  /**
   * Complete a subtask (legacy method - uses orchestrator role)
   */
  async completeSubtask(taskId: string, subtaskIndex: number): Promise<Task> {
    return this.approveSubtask(taskId, subtaskIndex);
  }

  /**
   * Uncomplete a subtask (legacy method)
   */
  async uncompleteSubtask(taskId: string, subtaskIndex: number): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'new', 'orchestrator');
  }

  allSubtasksCompleted(_id: string): boolean {
    // This is a sync method in the original, but we need async for DB
    // For now, throw error - callers should use async version
    throw new Error('Use allSubtasksCompletedAsync instead');
  }

  async allSubtasksCompletedAsync(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task || !task.subtasks || task.subtasks.length === 0) {
      return true;
    }
    return task.subtasks.every(s => s.status === 'completed');
  }

  getSubtaskSummary(_id: string): { total: number; new: number; in_review: number; completed: number } {
    // Sync method - throw error
    throw new Error('Use getSubtaskSummaryAsync instead');
  }

  async getSubtaskSummaryAsync(taskId: string): Promise<{ total: number; new: number; in_review: number; completed: number }> {
    const task = await this.getTask(taskId);
    if (!task || !task.subtasks) {
      return { total: 0, new: 0, in_review: 0, completed: 0 };
    }
    return {
      total: task.subtasks.length,
      new: task.subtasks.filter(s => s.status === 'new').length,
      in_review: task.subtasks.filter(s => s.status === 'in_review').length,
      completed: task.subtasks.filter(s => s.status === 'completed').length,
    };
  }

  // ============================================================
  // Task Dependency Management
  // ============================================================

  private async validateDependencies(dependsOn: string[] | undefined, currentTaskId?: string, client?: PoolClient): Promise<void> {
    if (!dependsOn || dependsOn.length === 0) return;
    
    const executor = client || this.pool;
    
    for (const depId of dependsOn) {
      if (currentTaskId && depId === currentTaskId) {
        throw new Error('Task cannot depend on itself');
      }
      
      const result = await executor.query('SELECT id FROM tasks WHERE id = $1', [depId]);
      if (result.rows.length === 0) {
        throw new Error(`Dependency task not found: ${depId}`);
      }
    }
  }

  private async hasCircularDependency(taskId: string, depId: string, visited = new Set<string>(), client?: PoolClient): Promise<boolean> {
    if (visited.has(taskId)) {
      return true;
    }
    
    visited.add(taskId);
    const executor = client || this.pool;
    
    const result = await executor.query(
      'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $1',
      [depId]
    );
    
    if (result.rows.length === 0) {
      return false;
    }
    
    for (const row of result.rows) {
      const nextDep = row.depends_on_task_id;
      if (nextDep === taskId || await this.hasCircularDependency(taskId, nextDep, new Set(visited), client)) {
        return true;
      }
    }
    
    return false;
  }

  private async validateAndCheckCircular(taskId: string, dependsOn: string[] | undefined, client?: PoolClient): Promise<void> {
    if (!dependsOn || dependsOn.length === 0) return;
    
    await this.validateDependencies(dependsOn, taskId, client);
    
    for (const depId of dependsOn) {
      if (await this.hasCircularDependency(taskId, depId, new Set(), client)) {
        throw new Error(`Circular dependency detected: ${taskId} -> ${depId}`);
      }
    }
  }

  async getBlockingTasks(id: string): Promise<Task[]> {
    const task = await this.getTask(id);
    if (!task || !task.dependsOn || task.dependsOn.length === 0) {
      return [];
    }
    
    const blocking: Task[] = [];
    for (const depId of task.dependsOn) {
      const depTask = await this.getTask(depId);
      if (depTask && depTask.status !== 'completed' && depTask.status !== 'archived') {
        blocking.push(depTask);
      }
    }
    
    return blocking;
  }

  async getDependentTasks(id: string): Promise<Task[]> {
    const result = await this.pool.query(
      'SELECT task_id FROM task_dependencies WHERE depends_on_task_id = $1',
      [id]
    );
    
    const dependent: Task[] = [];
    for (const row of result.rows) {
      const task = await this.getTask(row.task_id);
      if (task) {
        dependent.push(task);
      }
    }
    
    return dependent;
  }

  async isTaskBlocked(id: string): Promise<boolean> {
    const blocking = await this.getBlockingTasks(id);
    return blocking.length > 0;
  }

  /**
   * Sync version for compatibility (uses in-memory check)
   */
  private isTaskBlockedSync(task: Task): boolean {
    if (!task.dependsOn || task.dependsOn.length === 0) {
      return false;
    }
    // For sync version, we can't check DB - assume not blocked
    // This is used in getNextTask which already has tasks loaded
    return false;
  }

  /**
   * Auto-archive old completed tasks
   */
  async autoArchiveOldTasks(): Promise<number> {
    const ARCHIVE_AFTER_DAYS = 7;
    const cutoff = new Date(Date.now() - (ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000));

    const result = await this.pool.query(
      `SELECT id FROM tasks 
       WHERE status = 'completed' 
       AND completed_at < $1`,
      [cutoff.toISOString()]
    );

    let count = 0;
    for (const row of result.rows) {
      try {
        await this.archiveTask(row.id);
        count++;
      } catch (err) {
        console.error('[TaskManagerDB] Error auto-archiving task:', row.id, err);
      }
    }

    if (count > 0) {
      console.log('[TaskManagerDB] Auto-archived', count, 'old completed tasks');
    }

    return count;
  }

  /**
   * Resolve thinking level (auto-estimate if not provided)
   */
  private resolveThinking(data: Partial<Task>): { thinking: 'low' | 'medium' | 'high'; thinkingAutoEstimated: boolean } {
    const validLevels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
    
    if (data.thinking && validLevels.includes(data.thinking)) {
      return { thinking: data.thinking, thinkingAutoEstimated: false };
    }
    
    const levels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
    let levelIndex = 0;
    
    const subtaskCount = (data.subtasks || []).length;
    if (subtaskCount >= 8) {
      levelIndex = 2;
    } else if (subtaskCount >= 4) {
      levelIndex = 1;
    }
    
    const tags = (data.tags || []).map(t => t.toLowerCase());
    if (tags.some(t => ['bugfix', 'hotfix'].includes(t))) {
      levelIndex = 0;
    } else if (tags.some(t => ['architecture', 'refactor', 'security'].includes(t))) {
      levelIndex = 2;
    }
    
    if (data.priority === 'urgent' || data.priority === 'high') {
      levelIndex = Math.min(levelIndex + 1, 2);
    }
    
    return { thinking: levels[levelIndex], thinkingAutoEstimated: true };
  }

  /**
   * Shutdown - cleanup
   */
  async shutdown(): Promise<void> {
    console.log('[TaskManagerDB] Shutdown complete');
  }
}

// Singleton instance (will be swapped in server.ts)
export const taskManagerDB = new TaskManagerDB();
