// TaskManager.ts - Core task management system for bots
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import chokidar, { FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';
import { notificationManager } from './NotificationManager';
import { taskHistoryService } from './TaskHistoryService';

const TASKS_FILE = process.env.TASKS_FILE || '/clawdbot/memory/tasks.json';
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || '/clawdbot/memory/tasks/archive';
const ARCHIVE_AFTER_DAYS = 7;

// Phase 4: Enhanced Task System with Work Orchestration
export type TaskStatus = 'ideas' | 'todo' | 'in-progress' | 'stuck' | 'completed' | 'archived';
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low' | 'someday';
export type TaskLinkType = 'project' | 'tool' | 'git' | 'doc' | 'memory' | 'session';

// Phase 1 Hub Redesign: Tri-state subtask status
export type SubtaskStatus = 'new' | 'in_review' | 'completed';

export interface Subtask {
  id: string;
  text: string;
  // Legacy field (kept for backward compatibility during migration)
  completed?: boolean;
  // New tri-state status field
  status: SubtaskStatus;
  // Optional review note when agent marks for review
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

// Phase 1 Hub Redesign: Task-specific resources
export interface TaskResources {
  links?: Array<{
    type: 'git' | 'url' | 'file' | 'reference' | 'doc';
    title: string;
    url: string;
  }>;
  files?: string[];       // Paths to relevant files
  relatedTasks?: string[]; // IDs of related tasks
}

export interface Task {
  // Core fields
  id: string;
  title: string;
  description: string;
  
  // Status
  status: TaskStatus;
  priority: TaskPriority;
  
  // Subtasks (checkboxes with tri-state status)
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
  
  // Task Dependencies (for task chains / phases)
  dependsOn?: string[]; // Array of task IDs this task depends on
  
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
  needsReview?: boolean;  // Set when agent completes task
  
  // Thinking level: controls AI agent reasoning depth
  thinking?: 'low' | 'medium' | 'high';
  thinkingAutoEstimated?: boolean;  // true if thinking was auto-estimated, not explicitly set
  attemptCount?: number;  // Escalation tracking: how many times this task has been attempted
  
  // Phase 1 Hub Redesign: Multi-phase tracking
  trackerUrl?: string;          // Path to shared tracker doc for multi-phase jobs
  phaseTag?: string;            // Consistent tag linking related tasks (e.g., 'project-hub-redesign')
  
  // Phase 1 Hub Redesign: Task-specific resources
  taskResources?: TaskResources;
  
  // Legacy fields (for backward compatibility)
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

export interface TaskData {
  version: string;
  updated: string;
  tasks: Task[];
}

export class TaskManager extends EventEmitter {
  private tasks: Task[] = [];
  private watcher: FSWatcher | null = null;
  private isReloading = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private isSaving = false;

  /**
   * Ensure all subtasks have unique IDs and proper status
   * This fixes the bug where subtasks without IDs share state incorrectly
   * Also migrates legacy `completed: boolean` to `status: SubtaskStatus`
   */
  private ensureSubtaskIds(subtasks: Subtask[] | undefined): Subtask[] {
    if (!subtasks || !Array.isArray(subtasks)) return [];
    return subtasks.map(s => {
      // Migrate legacy completed boolean to status
      let status: SubtaskStatus = s.status || 'new';
      if (s.status === undefined && s.completed !== undefined) {
        status = s.completed ? 'completed' : 'new';
      }
      
      return {
        ...s,
        id: s.id || uuidv4(), // Generate ID if missing
        status, // Ensure status is always set
      };
    });
  }

  /**
   * Resolve thinking level for a task.
   * If explicitly provided, use it. Otherwise, auto-estimate based on task properties.
   */
  private resolveThinking(data: Partial<Task>): { thinking: 'low' | 'medium' | 'high'; thinkingAutoEstimated: boolean } {
    const validLevels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
    
    // If explicitly provided and valid, use it
    if (data.thinking && validLevels.includes(data.thinking)) {
      return { thinking: data.thinking, thinkingAutoEstimated: false };
    }
    
    // Auto-estimate based on task properties
    const levels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
    let levelIndex = 0; // Start at 'low'
    
    // Subtask count heuristic
    const subtaskCount = (data.subtasks || []).length;
    if (subtaskCount >= 8) {
      levelIndex = 2; // high
    } else if (subtaskCount >= 4) {
      levelIndex = 1; // medium
    }
    
    // Tags override: bugfix/hotfix → low, architecture/refactor/security → high
    const tags = (data.tags || []).map(t => t.toLowerCase());
    if (tags.some(t => ['bugfix', 'hotfix'].includes(t))) {
      levelIndex = 0; // low — focused fixes
    } else if (tags.some(t => ['architecture', 'refactor', 'security'].includes(t))) {
      levelIndex = 2; // high
    }
    
    // Priority bump: urgent/high → bump up one level
    if (data.priority === 'urgent' || data.priority === 'high') {
      levelIndex = Math.min(levelIndex + 1, 2);
    }
    
    return { thinking: levels[levelIndex], thinkingAutoEstimated: true };
  }

  /**
   * Initialize task manager - load tasks and start file watcher
   */
  async initialize(): Promise<void> {
    // Clean up stale temp files from previous crashed writes
    try {
      const tmpFile = TASKS_FILE + '.tmp';
      await fs.unlink(tmpFile);
      console.log('[TaskManager] Cleaned up stale temp file:', tmpFile);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.warn('[TaskManager] Error cleaning temp file:', err.message);
      }
      // ENOENT is fine - no stale temp file
    }

    await this.loadTasks();
    this.startFileWatcher();
    console.log('[TaskManager] Initialized with', this.tasks.length, 'tasks');
  }

  /**
   * Load tasks from disk
   */
  async loadTasks(): Promise<void> {
    try {
      const data = await fs.readFile(TASKS_FILE, 'utf8');
      const parsed: TaskData = JSON.parse(data);
      this.tasks = parsed.tasks || [];
      
      // Ensure all subtasks have unique IDs and proper status (migration for legacy data)
      let needsSave = false;
      for (const task of this.tasks) {
        if (task.subtasks && task.subtasks.length > 0) {
          const fixed = this.ensureSubtaskIds(task.subtasks);
          // Check if any IDs were generated or status was migrated
          const changed = fixed.some((s, i) => {
            const original = task.subtasks[i];
            return s.id !== original?.id || s.status !== original?.status;
          });
          if (changed) {
            task.subtasks = fixed;
            needsSave = true;
          }
        }
      }
      if (needsSave) {
        console.log('[TaskManager] Migrated subtasks to have unique IDs and tri-state status');
        await this.saveTasks();
      }
      
      console.log('[TaskManager] Loaded', this.tasks.length, 'tasks');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // File doesn't exist - initialize empty
        this.tasks = [];
        await this.saveTasks();
        console.log('[TaskManager] Created new tasks.json');
      } else if (err instanceof SyntaxError) {
        // Corrupted JSON — try to recover
        console.error('[TaskManager] Corrupted tasks.json, attempting recovery...');
        try {
          const raw = await fs.readFile(TASKS_FILE, 'utf8');
          // Try to parse up to the first valid JSON object
          const match = raw.match(/^[\s\S]*?\n\}/);
          if (match) {
            const recovered: TaskData = JSON.parse(match[0]);
            this.tasks = recovered.tasks || [];
            await this.saveTasks(); // Overwrite with clean data
            console.log('[TaskManager] Recovered', this.tasks.length, 'tasks from corrupted file');
          } else {
            console.error('[TaskManager] Could not recover, keeping in-memory tasks');
          }
        } catch (recoverErr) {
          console.error('[TaskManager] Recovery failed, keeping in-memory tasks:', recoverErr);
        }
      } else {
        console.error('[TaskManager] Error loading tasks:', err);
        // Don't throw — keep serving with in-memory tasks
      }
    }
  }

  /**
   * Save tasks to disk (serialized — prevents concurrent write corruption)
   */
  async saveTasks(): Promise<void> {
    // Queue writes sequentially to prevent race conditions
    this.writeQueue = this.writeQueue.then(async () => {
      this.isSaving = true;
      try {
        const data: TaskData = {
          version: '1.0',
          updated: new Date().toISOString(),
          tasks: this.tasks
        };

        // Ensure directory exists
        await fs.mkdir(path.dirname(TASKS_FILE), { recursive: true });
        
        // Write to temp file first, then atomic rename
        const tmpFile = TASKS_FILE + '.tmp';
        
        // Try to write with retry logic
        let retryCount = 0;
        const maxRetries = 1;
        
        while (retryCount <= maxRetries) {
          try {
            await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
            await fs.rename(tmpFile, TASKS_FILE);
            console.log('[TaskManager] Saved', this.tasks.length, 'tasks');
            break; // Success - exit retry loop
          } catch (writeErr: any) {
            retryCount++;
            
            if (writeErr.code === 'EACCES' || writeErr.code === 'EPERM') {
              console.warn(`[TaskManager] Permission error writing tasks.json (attempt ${retryCount}/${maxRetries + 1}):`, writeErr.message);
              
              if (retryCount <= maxRetries) {
                console.log('[TaskManager] Retrying in 1 second...');
                await new Promise(resolve => setTimeout(resolve, 1000));
              } else {
                console.error('[TaskManager] CRITICAL: Failed to save tasks after retries - permission denied');
                // Don't throw - we want to keep the server running
                // The in-memory state is still intact
              }
            } else {
              // Other errors - log and don't retry
              console.error('[TaskManager] Error writing tasks.json:', writeErr.message);
              
              // Clean up temp file if it exists
              try {
                await fs.unlink(tmpFile);
              } catch (cleanupErr) {
                // Ignore cleanup errors
              }
              
              // Don't throw - keep server running
              break;
            }
          }
        }
      } catch (err: any) {
        // Catch any outer errors (e.g., mkdir failure)
        console.error('[TaskManager] Error in saveTasks:', err.message);
        // Don't throw - keep server running with in-memory state
      } finally {
        this.isSaving = false;
      }
    });
    
    return this.writeQueue;
  }

  /**
   * Watch tasks file for external changes (bot editing manually)
   */
  startFileWatcher(): void {
    if (this.watcher) return;

    this.watcher = chokidar.watch(TASKS_FILE, {
      persistent: true,
      ignoreInitial: true
    });

    // Debounce rapid changes
    let debounceTimer: NodeJS.Timeout | null = null;
    this.watcher.on('change', () => {
      if (this.isReloading || this.isSaving) return; // Skip own writes and reloads

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        console.log('[TaskManager] External file change detected, reloading...');
        this.isReloading = true;
        await this.loadTasks();
        this.isReloading = false;
        this.emit('tasks:updated', this.tasks);
      }, 100);
    });

    console.log('[TaskManager] File watcher started');
  }

  /**
   * Create a new task (Phase 4 enhanced)
   */
  async createTask(data: Partial<Task>): Promise<Task> {
    const now = new Date().toISOString();
    const tempId = uuidv4(); // Generate ID early for validation
    
    // Validate dependencies before creating task
    if (data.dependsOn && data.dependsOn.length > 0) {
      this.validateAndCheckCircular(tempId, data.dependsOn);
    }
    
    const task: Task = {
      // Core fields
      id: tempId,
      title: data.title || 'Untitled Task',
      description: data.description || '',
      
      // Status
      status: data.status || 'todo',
      priority: data.priority || 'normal',
      
      // Subtasks (Phase 4: array of objects, not string IDs)
      // Ensure all subtasks have unique IDs to prevent state sharing bugs
      subtasks: this.ensureSubtaskIds(data.subtasks),
      
      // Rich context (Phase 4)
      links: data.links || [],
      
      // Audit trail (Phase 4)
      sessionRefs: data.sessionRefs || [],
      
      // Work tracking (Phase 4)
      autoCreated: data.autoCreated !== undefined ? data.autoCreated : false,
      autoStart: data.autoStart !== undefined ? data.autoStart : (data.status !== 'ideas'),
      lastChecked: data.lastChecked,
      startedAt: data.status === 'in-progress' ? now : data.startedAt,
      completedAt: data.status === 'completed' ? now : data.completedAt,
      archivedAt: data.status === 'archived' ? now : data.archivedAt,
      
      // Blocking
      blockedBy: data.blockedBy || [],
      blockedReason: data.blockedReason,
      
      // Task Dependencies
      dependsOn: data.dependsOn || [],
      
      // AI execution
      model: data.model,
      executionMode: data.executionMode,
      activeAgent: data.activeAgent || null,
      completedBy: data.completedBy || null,
      
      // Thinking level
      ...this.resolveThinking(data),
      attemptCount: data.attemptCount ?? 0,
      
      // Phase 1 Hub Redesign: Multi-phase tracking
      trackerUrl: data.trackerUrl,
      phaseTag: data.phaseTag,
      taskResources: data.taskResources,
      
      // Metadata
      project: data.project,
      tags: data.tags || [],
      created: now,
      updated: now,
      
      // Legacy fields (backward compatibility)
      parentId: data.parentId,
      notes: data.notes,
      completed: data.status === 'completed' ? now : null
    };

    this.tasks.push(task);
    await this.saveTasks();
    this.emit('task:created', task);
    
    // Record creation in task history
    taskHistoryService.recordChange(task.id, task.title, 'status', null, task.status, 'system');
    
    console.log('[TaskManager] Created task:', task.id, task.title, `(auto: ${task.autoCreated}, autoStart: ${task.autoStart})`);
    return task;
  }

  /**
   * Update an existing task (Phase 4 enhanced)
   */
  async updateTask(id: string, updates: Partial<Task>): Promise<Task> {
    const task = this.tasks.find(t => t.id === id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    const now = new Date().toISOString();
    const oldStatus = task.status;
    const oldPriority = task.priority;
    
    // Validate dependencies if being updated
    if (updates.dependsOn !== undefined) {
      this.validateAndCheckCircular(id, updates.dependsOn);
    }

    // Track status transitions
    if (updates.status && updates.status !== task.status) {
      // Auto-set autoStart when moving to todo (for heartbeat auto-pickup)
      if (updates.status === 'todo') {
        updates.autoStart = true;
      }
      if (updates.status === 'in-progress' && !task.startedAt) {
        updates.startedAt = now;
      }
      if (updates.status === 'completed' && !task.completedAt) {
        updates.completedAt = now;
        updates.completed = now; // Legacy field
      }
      if (updates.status === 'archived' && !task.archivedAt) {
        updates.archivedAt = now;
      }
    }

    // Ensure subtasks have IDs if being updated
    if (updates.subtasks) {
      updates.subtasks = this.ensureSubtaskIds(updates.subtasks);
    }

    // Merge updates
    Object.assign(task, {
      ...updates,
      updated: now
    });

    // Backward compatibility: 'done' → 'completed', 'blocked' → 'stuck'
    // @ts-ignore - Allow legacy status values
    if (updates.status === 'done') {
      task.status = 'completed';
    }
    // @ts-ignore - Allow legacy status values
    if (updates.status === 'blocked') {
      task.status = 'stuck';
    }

    await this.saveTasks();
    this.emit('task:updated', task);

    // Emit notification and record history if status changed
    if (updates.status && updates.status !== oldStatus) {
      await notificationManager.notifyStatusChange(
        task.id,
        task.title,
        oldStatus,
        task.status,
        'user'
      );
      // Record to task_history for activity feed
      taskHistoryService.recordChange(task.id, task.title, 'status', oldStatus, task.status, 'user');
    }

    // Record priority changes
    if (updates.priority && updates.priority !== oldPriority) {
      taskHistoryService.recordChange(task.id, task.title, 'priority', oldPriority, task.priority, 'user');
    }

    console.log('[TaskManager] Updated task:', task.id, task.title);
    return task;
  }

  /**
   * Delete a task (and its subtasks)
   */
  async deleteTask(id: string): Promise<{ success: boolean }> {
    const task = this.tasks.find(t => t.id === id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    // Phase 4: subtasks are now Subtask objects, not child task IDs
    // Subtasks are embedded in the task, not separate tasks
    // So we don't need to delete them recursively

    // Remove from parent's subtasks array (legacy support)
    if (task.parentId) {
      const parent = this.tasks.find(t => t.id === task.parentId);
      if (parent) {
        // Legacy: parent.subtasks was string[]
        // Now it's Subtask[], but we keep backward compat for now
        // @ts-ignore - Legacy support
        parent.subtasks = parent.subtasks.filter(s => 
          typeof s === 'string' ? s !== id : s.id !== id
        );
      }
    }

    // Remove task
    this.tasks = this.tasks.filter(t => t.id !== id);
    
    await this.saveTasks();
    this.emit('task:deleted', id);

    console.log('[TaskManager] Deleted task:', id);
    return { success: true };
  }

  /**
   * Archive a completed task
   */
  async archiveTask(id: string): Promise<{ success: boolean; archived: boolean }> {
    const task = this.tasks.find(t => t.id === id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    if (task.status !== 'completed') {
      throw new Error('Can only archive completed tasks');
    }

    // Move to archived status (stays in active task list, visible in Kanban)
    const oldStatus = task.status;
    
    task.status = 'archived' as any;
    task.archivedAt = new Date().toISOString();
    task.updated = new Date().toISOString();
    await this.saveTasks();
    this.emit('task:archived', id);
    this.emit('tasks:updated', this.tasks);

    // Emit notification for status change
    await notificationManager.notifyStatusChange(
      task.id,
      task.title,
      oldStatus,
      'archived',
      'system'
    );

    // Also save a copy to archive file for historical record
    try {
      await fs.mkdir(ARCHIVE_DIR, { recursive: true });
      const date = task.completed ? task.completed.split('T')[0] : new Date().toISOString().split('T')[0];
      const archiveFile = path.join(ARCHIVE_DIR, `${date}.json`);

      let archive: { date: string; tasks: Task[] } = { date, tasks: [] };
      try {
        const data = await fs.readFile(archiveFile, 'utf8');
        archive = JSON.parse(data);
      } catch (err) {
        // File doesn't exist, use empty archive
      }

      archive.tasks.push({ ...task });
      await fs.writeFile(archiveFile, JSON.stringify(archive, null, 2), 'utf8');
    } catch (err) {
      console.error('[TaskManager] Failed to write archive file:', err);
      // Non-fatal — task is already archived in main list
    }

    console.log('[TaskManager] Archived task:', id);
    return { success: true, archived: true };
  }

  /**
   * Auto-archive old completed tasks (run periodically)
   */
  async autoArchiveOldTasks(): Promise<number> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - (ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000));

    const toArchive = this.tasks.filter(task => {
      if (task.status !== 'completed' || !task.completedAt) return false;
      const completedDate = new Date(task.completedAt);
      return completedDate < cutoff;
    });

    for (const task of toArchive) {
      try {
        await this.archiveTask(task.id);
      } catch (err) {
        console.error('[TaskManager] Error auto-archiving task:', task.id, err);
      }
    }

    if (toArchive.length > 0) {
      console.log('[TaskManager] Auto-archived', toArchive.length, 'old completed tasks');
    }

    return toArchive.length;
  }

  /**
   * Query tasks with filters
   */
  queryTasks(filters: TaskFilters = {}): Task[] {
    let results = [...this.tasks];

    if (filters.status) {
      const status = filters.status;
      results = results.filter(t => t.status === status);
    }

    if (filters.project) {
      const project = filters.project;
      results = results.filter(t => t.project === project);
    }

    if (filters.priority) {
      const priority = filters.priority;
      results = results.filter(t => t.priority === priority);
    }

    if (filters.tag) {
      const tag = filters.tag;
      results = results.filter(t => t.tags.includes(tag));
    }

    if (filters.parentId !== undefined) {
      const targetParentId = filters.parentId;
      results = results.filter(t => t.parentId === targetParentId);
    }

    return results;
  }

  /**
   * Get a single task by ID
   */
  getTask(id: string): Task | undefined {
    return this.tasks.find(t => t.id === id);
  }

  /**
   * Get all active tasks
   */
  getAllTasks(): Task[] {
    return this.tasks;
  }

  // ============================================================
  // Phase 1 Hub Redesign: Subtask Status Management
  // ============================================================

  /**
   * Update subtask status with role-based permission checks
   * @param taskId - Task ID
   * @param subtaskIndex - Index of subtask in array
   * @param newStatus - New status
   * @param role - 'agent' or 'orchestrator'
   * @param reviewNote - Optional note when marking for review
   */
  async updateSubtaskStatus(
    taskId: string, 
    subtaskIndex: number, 
    newStatus: SubtaskStatus, 
    role: 'agent' | 'orchestrator' = 'orchestrator',
    reviewNote?: string
  ): Promise<Task> {
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (!task.subtasks || subtaskIndex < 0 || subtaskIndex >= task.subtasks.length) {
      throw new Error(`Subtask not found at index ${subtaskIndex}`);
    }

    const subtask = task.subtasks[subtaskIndex];
    const currentStatus = subtask.status;

    // Permission checks based on role
    if (role === 'agent') {
      // Agents can only mark as 'in_review', not 'completed'
      if (newStatus === 'completed') {
        throw new Error('Agents cannot mark subtasks as completed. Mark as in_review instead.');
      }
      // Agents cannot modify completed subtasks
      if (currentStatus === 'completed') {
        throw new Error('Cannot change status of completed subtasks');
      }
    }

    // Update subtask
    const now = new Date().toISOString();
    subtask.status = newStatus;
    
    if (reviewNote) {
      subtask.reviewNote = reviewNote;
    }
    
    if (newStatus === 'completed') {
      subtask.completedAt = now;
      // Keep legacy field in sync
      subtask.completed = true;
    } else if (newStatus === 'new') {
      subtask.completedAt = undefined;
      subtask.completed = false;
    }

    task.updated = now;
    
    await this.saveTasks();
    this.emit('task:updated', task);
    
    console.log(`[TaskManager] Subtask ${subtaskIndex} of task ${taskId} changed to '${newStatus}' by ${role}`);
    return task;
  }

  /**
   * Mark subtask as in_review (for agents)
   */
  async markSubtaskInReview(taskId: string, subtaskIndex: number, reviewNote?: string): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'in_review', 'agent', reviewNote);
  }

  /**
   * Approve subtask (mark as completed - orchestrator only)
   */
  async approveSubtask(taskId: string, subtaskIndex: number): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'completed', 'orchestrator');
  }

  /**
   * Reject subtask (mark back to new - orchestrator only)
   */
  async rejectSubtask(taskId: string, subtaskIndex: number, note?: string): Promise<Task> {
    const task = await this.updateSubtaskStatus(taskId, subtaskIndex, 'new', 'orchestrator');
    // Add rejection note
    if (note && task.subtasks && task.subtasks[subtaskIndex]) {
      task.subtasks[subtaskIndex].reviewNote = `REJECTED: ${note}`;
      await this.saveTasks();
    }
    return task;
  }

  /**
   * Check if all subtasks are completed
   */
  allSubtasksCompleted(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task || !task.subtasks || task.subtasks.length === 0) {
      return true; // No subtasks = all complete
    }
    return task.subtasks.every(s => s.status === 'completed');
  }

  /**
   * Get subtask completion summary
   */
  getSubtaskSummary(taskId: string): { total: number; new: number; in_review: number; completed: number } {
    const task = this.getTask(taskId);
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
  // Task Dependency Management (Task Chains)
  // ============================================================

  /**
   * Validate that all task IDs in dependsOn array exist
   */
  private validateDependencies(dependsOn: string[] | undefined, currentTaskId?: string): void {
    if (!dependsOn || dependsOn.length === 0) return;
    
    for (const depId of dependsOn) {
      if (currentTaskId && depId === currentTaskId) {
        throw new Error('Task cannot depend on itself');
      }
      
      const depTask = this.tasks.find(t => t.id === depId);
      if (!depTask) {
        throw new Error(`Dependency task not found: ${depId}`);
      }
    }
  }

  /**
   * Detect circular dependencies using DFS
   */
  private hasCircularDependency(taskId: string, depId: string, visited = new Set<string>()): boolean {
    if (visited.has(taskId)) {
      return true;
    }
    
    visited.add(taskId);
    
    const depTask = this.tasks.find(t => t.id === depId);
    if (!depTask || !depTask.dependsOn) {
      return false;
    }
    
    for (const nextDep of depTask.dependsOn) {
      if (nextDep === taskId || this.hasCircularDependency(taskId, nextDep, new Set(visited))) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Validate dependencies and check for circular references
   */
  private validateAndCheckCircular(taskId: string, dependsOn: string[] | undefined): void {
    if (!dependsOn || dependsOn.length === 0) return;
    
    this.validateDependencies(dependsOn, taskId);
    
    for (const depId of dependsOn) {
      if (this.hasCircularDependency(taskId, depId)) {
        throw new Error(`Circular dependency detected: ${taskId} -> ${depId}`);
      }
    }
  }

  /**
   * Get incomplete tasks that this task depends on
   */
  getBlockingTasks(id: string): Task[] {
    const task = this.getTask(id);
    if (!task || !task.dependsOn || task.dependsOn.length === 0) {
      return [];
    }
    
    return task.dependsOn
      .map(depId => this.getTask(depId))
      .filter((t): t is Task => t !== undefined && t.status !== 'completed' && t.status !== 'archived');
  }

  /**
   * Get tasks that depend on this task
   */
  getDependentTasks(id: string): Task[] {
    return this.tasks.filter(t => 
      t.dependsOn && t.dependsOn.includes(id)
    );
  }

  /**
   * Check if a task is blocked by unmet dependencies
   */
  isTaskBlocked(id: string): boolean {
    return this.getBlockingTasks(id).length > 0;
  }

  /**
   * Cleanup watcher on shutdown
   */
  async shutdown(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      console.log('[TaskManager] File watcher stopped');
    }
  }
}

// Singleton instance
export const taskManager = new TaskManager();
