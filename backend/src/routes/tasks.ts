// tasks.ts - API endpoints for task management
import { Router, Request, Response } from 'express';
import { taskManager, SubtaskStatus } from '../services/TaskManager';
import { taskAutoUpdater } from '../services/TaskAutoUpdater';
import { taskAnalyzer } from '../services/taskAnalyzer';
import { generateTaskPromptWithTools } from '../utils/promptTemplate';
import { notificationManager } from '../services/NotificationManager';

const router = Router();

// Valid subtask statuses for validation
const VALID_SUBTASK_STATUSES: SubtaskStatus[] = ['new', 'in_review', 'completed'];

/**
 * GET /tasks
 * List all active tasks with optional filters
 */
router.get('/', (req: Request, res: Response): void => {
  try {
    const filters: any = {};
    
    if (req.query.status) filters.status = req.query.status as string;
    if (req.query.project) filters.project = req.query.project as string;
    if (req.query.priority) filters.priority = req.query.priority as string;
    if (req.query.tag) filters.tag = req.query.tag as string;
    if (req.query.parentId !== undefined) {
      filters.parentId = req.query.parentId === 'null' ? null : req.query.parentId as string;
    }

    const tasks = taskManager.queryTasks(filters);
    
    // Add computed dependency fields
    const tasksWithDeps = tasks.map(task => ({
      ...task,
      blocked: taskManager.isTaskBlocked(task.id),
      blockingTasks: taskManager.getBlockingTasks(task.id).map(t => ({ id: t.id, title: t.title })),
      dependentTasks: taskManager.getDependentTasks(task.id).map(t => ({ id: t.id, title: t.title })),
    }));
    
    res.json({ success: true, tasks: tasksWithDeps });
  } catch (err) {
    console.error('[Tasks API] Error listing tasks:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

/**
 * GET /tasks/current
 * Get the task the bot is currently working on (auto-detected)
 * NOTE: Must be BEFORE /:id route to avoid being caught by wildcard
 */
router.get('/current', (_req: Request, res: Response): void => {
  try {
    const currentTask = taskAutoUpdater.getCurrentTask();
    const currentTaskId = taskAutoUpdater.getCurrentTaskId();
    
    res.json({ 
      success: true, 
      task: currentTask || null,
      taskId: currentTaskId || null,
      hasCurrentTask: currentTask !== null
    });
  } catch (err) {
    console.error('[Tasks API] Error getting current task:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

/**
 * GET /tasks/next
 * Get the next task to pick up (highest priority todo with autoStart=true)
 * Used by bot heartbeat cycle to auto-pick tasks
 * NOTE: Must be BEFORE /:id to avoid wildcard catch
 */
router.get('/next', (_req: Request, res: Response): void => {
  try {
    const todoTasks = taskManager.queryTasks({ status: 'todo' });
    
    const priorityOrder: Record<string, number> = {
      urgent: 0, high: 1, normal: 2, low: 3, someday: 4
    };
    
    const autoStartTasks = todoTasks
      .filter(t => t.autoStart && !taskManager.isTaskBlocked(t.id))
      .sort((a, b) => {
        const pa = priorityOrder[a.priority] ?? 99;
        const pb = priorityOrder[b.priority] ?? 99;
        if (pa !== pb) return pa - pb;
        return new Date(a.created).getTime() - new Date(b.created).getTime();
      });

    res.json({
      success: true,
      task: autoStartTasks[0] || null,
      queueLength: autoStartTasks.length,
    });
  } catch (err) {
    console.error('[Tasks API] Error getting next task:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

/**
 * GET /tasks/:id
 * Get a single task by ID
 * NOTE: This wildcard must be AFTER specific routes like /current and /next
 */
router.get('/:id', (req: Request, res: Response): void => {
  try {
    const task = taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    res.json({ success: true, task });
  } catch (err) {
    console.error('[Tasks API] Error getting task:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

/**
 * POST /tasks
 * Create a new task
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { 
      title, description, status, priority, project, tags, 
      // Phase 4 fields
      subtasks, links, sessionRefs, autoCreated, autoStart, blockedBy, blockedReason,
      // Task dependencies
      dependsOn,
      // AI execution fields
      model, executionMode, activeAgent,
      // Thinking level
      thinking,
      // Legacy fields
      parentId, notes 
    } = req.body;

    if (!title) {
      res.status(400).json({ success: false, error: 'Title is required' });
      return;
    }

    // Validate thinking level if provided
    const validThinkingLevels = ['low', 'medium', 'high'];
    if (thinking && !validThinkingLevels.includes(thinking)) {
      res.status(400).json({ success: false, error: `Invalid thinking level: "${thinking}". Must be one of: ${validThinkingLevels.join(', ')}` });
      return;
    }

    const task = await taskManager.createTask({
      title,
      description,
      status,
      priority,
      project,
      tags,
      // Phase 4 fields
      subtasks,
      links,
      sessionRefs,
      autoCreated,
      autoStart,
      blockedBy,
      blockedReason,
      // Task dependencies
      dependsOn,
      // AI execution fields
      model,
      executionMode,
      activeAgent,
      // Thinking level
      thinking,
      // Legacy fields
      parentId,
      notes
    });

    res.status(201).json({ success: true, task });
  } catch (err) {
    console.error('[Tasks API] Error creating task:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

/**
 * PATCH /tasks/:id
 * Update an existing task
 */
router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const updates = { ...req.body };
    delete updates.id; // Don't allow ID changes
    delete updates.created; // Don't allow created timestamp changes

    // Validate thinking level if provided
    const validThinkingLevels = ['low', 'medium', 'high'];
    if (updates.thinking && !validThinkingLevels.includes(updates.thinking)) {
      res.status(400).json({ success: false, error: `Invalid thinking level: "${updates.thinking}". Must be one of: ${validThinkingLevels.join(', ')}` });
      return;
    }

    const task = await taskManager.updateTask(req.params.id, updates);
    res.json({ success: true, task });
  } catch (err) {
    console.error('[Tasks API] Error updating task:', err);
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * DELETE /tasks/:id
 * Delete a task (and its subtasks)
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await taskManager.deleteTask(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[Tasks API] Error deleting task:', err);
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      res.status(500).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * POST /tasks/:id/archive
 * Archive a completed task
 */
router.post('/:id/archive', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await taskManager.archiveTask(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('[Tasks API] Error archiving task:', err);
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      res.status(400).json({ 
        success: false, 
        error: err instanceof Error ? err.message : 'Unknown error' 
      });
    }
  }
});

/**
 * POST /tasks/:id/spawn
 * Generate an agent prompt from task data and move to in-progress
 */
router.post('/:id/spawn', async (req: Request, res: Response): Promise<void> => {
  try {
    const task = taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    // Only allow spawning from certain statuses
    const spawnableStatuses = ['ideas', 'todo', 'stuck'];
    if (!spawnableStatuses.includes(task.status)) {
      res.status(400).json({ 
        success: false, 
        error: `Cannot spawn from status "${task.status}". Must be one of: ${spawnableStatuses.join(', ')}` 
      });
      return;
    }

    // Generate the prompt (with DB-backed tool context if available)
    const prompt = await generateTaskPromptWithTools(task);

    // Move to in-progress with activeAgent
    await taskManager.updateTask(task.id, {
      status: 'in-progress',
      startedAt: new Date().toISOString(),
      activeAgent: { name: 'sub-agent', sessionKey: 'pending' },
      executionMode: 'subagent'
    });

    res.json({ success: true, prompt, taskId: task.id });
  } catch (err) {
    console.error('[Tasks API] Error spawning task:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

/**
 * POST /tasks/:id/breakdown
 * Generate subtasks for a task using TaskAnalyzer
 */
router.post('/:id/breakdown', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await taskAnalyzer.breakdownTask(req.params.id);
    if (!result) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    res.json({ 
      success: true, 
      subtasks: result.subtasks,
      confidence: result.confidence,
      method: result.method
    });
  } catch (err) {
    console.error('[Tasks API] Error breaking down task:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

/**
 * POST /tasks/auto-archive
 * Manually trigger auto-archiving of old completed tasks
 */
router.post('/auto-archive', async (_req: Request, res: Response): Promise<void> => {
  try {
    const count = await taskManager.autoArchiveOldTasks();
    res.json({ success: true, archivedCount: count });
  } catch (err) {
    console.error('[Tasks API] Error auto-archiving:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

// ============================================================
// Phase 1 Hub Redesign: Subtask Status Management APIs
// ============================================================

/**
 * PATCH /tasks/:id/subtasks/:index/status
 * Update subtask status with role-based permissions
 * 
 * Body: { status: 'new' | 'in_review' | 'completed', role?: 'agent' | 'orchestrator', reviewNote?: string }
 * 
 * Role permissions:
 * - agent: can only mark as 'in_review', cannot mark as 'completed'
 * - orchestrator (default): can set any status
 */
router.patch('/:id/subtasks/:index/status', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const index = parseInt(req.params.index, 10);
    const { status, role, reviewNote } = req.body;

    // Validate index
    if (isNaN(index) || index < 0) {
      res.status(400).json({ success: false, error: 'Invalid subtask index' });
      return;
    }

    // Validate status
    if (!status || !VALID_SUBTASK_STATUSES.includes(status)) {
      res.status(400).json({ 
        success: false, 
        error: `Invalid status. Must be one of: ${VALID_SUBTASK_STATUSES.join(', ')}` 
      });
      return;
    }

    // Validate role if provided
    const validatedRole = role === 'agent' ? 'agent' : 'orchestrator';

    const task = await taskManager.updateSubtaskStatus(id, index, status, validatedRole, reviewNote);
    
    res.json({ 
      success: true, 
      task,
      subtaskSummary: taskManager.getSubtaskSummary(id)
    });
  } catch (err) {
    console.error('[Tasks API] Error updating subtask status:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else if (message.includes('cannot') || message.includes('Cannot')) {
      res.status(403).json({ success: false, error: message });
    } else {
      res.status(500).json({ success: false, error: message });
    }
  }
});

/**
 * PUT /tasks/:id/subtasks/:index
 * Legacy endpoint for subtask updates (backward compatible)
 * Supports both old {completed: boolean} and new {status: SubtaskStatus} format
 * 
 * SECURITY: To mark as 'completed', caller must either:
 * - Include header X-Orchestrator-Key with valid value
 * - Include orchestrator: true in request body (for trusted internal callers)
 * Otherwise, 'completed' status is blocked (use 'in_review' instead)
 */
router.put('/:id/subtasks/:index', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const index = parseInt(req.params.index, 10);
    const { completed, status, reviewNote, orchestrator } = req.body;

    if (isNaN(index) || index < 0) {
      res.status(400).json({ success: false, error: 'Invalid subtask index' });
      return;
    }

    // Determine new status from request
    let newStatus: SubtaskStatus;
    if (status !== undefined) {
      newStatus = status;
    } else if (completed !== undefined) {
      // Legacy format: map boolean to status
      newStatus = completed ? 'completed' : 'new';
    } else {
      res.status(400).json({ success: false, error: 'Either "status" or "completed" must be provided' });
      return;
    }

    // Determine role based on orchestrator flag or header
    // Only orchestrators can mark subtasks as 'completed'
    const orchestratorHeader = req.headers['x-orchestrator-key'] as string | undefined;
    const envKey = process.env.ORCHESTRATOR_KEY;
    const isOrchestrator = 
      orchestrator === true || 
      orchestratorHeader === 'nim-orchestrator' ||
      (envKey !== undefined && orchestratorHeader === envKey);
    const role = isOrchestrator ? 'orchestrator' : 'agent';

    // Block agents from marking as completed
    if (newStatus === 'completed' && role === 'agent') {
      res.status(403).json({ 
        success: false, 
        error: 'Agents cannot mark subtasks as completed. Use status "in_review" instead, or include orchestrator flag.' 
      });
      return;
    }

    const task = await taskManager.updateSubtaskStatus(id, index, newStatus, role, reviewNote);
    
    res.json({ success: true, task });
  } catch (err) {
    console.error('[Tasks API] Error updating subtask:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else if (message.includes('cannot') || message.includes('Cannot')) {
      res.status(403).json({ success: false, error: message });
    } else {
      res.status(500).json({ success: false, error: message });
    }
  }
});

/**
 * POST /tasks/:id/subtasks/:index/approve
 * Approve a subtask (orchestrator marks as completed)
 */
router.post('/:id/subtasks/:index/approve', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const index = parseInt(req.params.index, 10);

    if (isNaN(index) || index < 0) {
      res.status(400).json({ success: false, error: 'Invalid subtask index' });
      return;
    }

    const task = await taskManager.approveSubtask(id, index);
    
    res.json({ 
      success: true, 
      task,
      subtaskSummary: taskManager.getSubtaskSummary(id),
      allCompleted: taskManager.allSubtasksCompleted(id)
    });
  } catch (err) {
    console.error('[Tasks API] Error approving subtask:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else {
      res.status(500).json({ success: false, error: message });
    }
  }
});

/**
 * POST /tasks/:id/subtasks/:index/reject
 * Reject a subtask (orchestrator marks as new with optional note)
 */
router.post('/:id/subtasks/:index/reject', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const index = parseInt(req.params.index, 10);
    const { note } = req.body;

    if (isNaN(index) || index < 0) {
      res.status(400).json({ success: false, error: 'Invalid subtask index' });
      return;
    }

    const task = await taskManager.rejectSubtask(id, index, note);
    
    res.json({ 
      success: true, 
      task,
      subtaskSummary: taskManager.getSubtaskSummary(id)
    });
  } catch (err) {
    console.error('[Tasks API] Error rejecting subtask:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else {
      res.status(500).json({ success: false, error: message });
    }
  }
});

/**
 * GET /tasks/:id/subtasks/summary
 * Get subtask completion summary for a task
 */
router.get('/:id/subtasks/summary', (req: Request, res: Response): void => {
  try {
    const { id } = req.params;
    const task = taskManager.getTask(id);
    
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    const summary = taskManager.getSubtaskSummary(id);
    
    res.json({ 
      success: true, 
      taskId: id,
      summary,
      allCompleted: taskManager.allSubtasksCompleted(id)
    });
  } catch (err) {
    console.error('[Tasks API] Error getting subtask summary:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

// ============================================================
// Notification Endpoints
// ============================================================

/**
 * GET /notifications
 * Get all notifications (with optional filter for unread only)
 */
router.get('/notifications', async (req: Request, res: Response): Promise<void> => {
  try {
    const unreadOnly = req.query.unread === 'true';
    
    const notifications = unreadOnly 
      ? await notificationManager.getUnreadNotifications()
      : await notificationManager.getNotifications();
    
    res.json({ 
      success: true, 
      notifications,
      count: notifications.length,
      unreadCount: unreadOnly ? notifications.length : notifications.filter(n => !n.read).length
    });
  } catch (err) {
    console.error('[Tasks API] Error getting notifications:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

/**
 * POST /notifications/:id/read
 * Mark a notification as read
 */
router.post('/notifications/:id/read', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const success = await notificationManager.markAsRead(id);
    
    if (!success) {
      res.status(404).json({ success: false, error: 'Notification not found' });
      return;
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('[Tasks API] Error marking notification as read:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

/**
 * POST /notifications/read-all
 * Mark all notifications as read
 */
router.post('/notifications/read-all', async (_req: Request, res: Response): Promise<void> => {
  try {
    const count = await notificationManager.markAllAsRead();
    res.json({ success: true, markedCount: count });
  } catch (err) {
    console.error('[Tasks API] Error marking all notifications as read:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

export default router;
