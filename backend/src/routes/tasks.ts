// tasks.ts - API endpoints for task management
import { Router, Request, Response } from 'express';
import { taskManagerDB as taskManager, SubtaskStatus } from '../services/TaskManagerDB';
import { taskAutoUpdater } from '../services/TaskAutoUpdater';
import { taskAnalyzer } from '../services/taskAnalyzer';
import { generateTaskPromptWithTools } from '../utils/promptTemplate';
import { notificationManager } from '../services/NotificationManager';
import type { GatewayConnector } from '../services/GatewayConnector';

let gatewayConnector: GatewayConnector | null = null;

export function setTasksGatewayConnector(connector: GatewayConnector): void {
  gatewayConnector = connector;
}

const router = Router();

// Valid subtask statuses for validation (6-state lifecycle)
const VALID_SUBTASK_STATUSES: SubtaskStatus[] = ['empty', 'in_progress', 'review', 'blocked', 'skipped', 'completed'];
// Statuses agents can set
const AGENT_ALLOWED_STATUSES: SubtaskStatus[] = ['in_progress', 'review'];

/**
 * GET /tasks
 * List all active tasks with optional filters
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const filters: any = {};
    
    if (req.query.status) filters.status = req.query.status as string;
    if (req.query.project) filters.project = req.query.project as string;
    if (req.query.priority) filters.priority = req.query.priority as string;
    if (req.query.tag) filters.tag = req.query.tag as string;
    if (req.query.parentId !== undefined) {
      filters.parentId = req.query.parentId === 'null' ? null : req.query.parentId as string;
    }

    const tasks = await taskManager.queryTasks(filters);
    
    // Add computed dependency fields
    const tasksWithDeps = await Promise.all(tasks.map(async task => ({
      ...task,
      blocked: await taskManager.isTaskBlocked(task.id),
      blockingTasks: (await taskManager.getBlockingTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
      dependentTasks: (await taskManager.getDependentTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
    })));
    
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
router.get('/current', async (_req: Request, res: Response): Promise<void> => {
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
router.get('/next', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Use getNextTask if available (TaskManagerDB), otherwise fall back to manual logic
    let task: any = null;
    if (typeof (taskManager as any).getNextTask === 'function') {
      task = await (taskManager as any).getNextTask();
    } else {
      const todoTasks = await taskManager.queryTasks({ status: 'todo' });
      
      const priorityOrder: Record<string, number> = {
        urgent: 0, high: 1, normal: 2, low: 3, someday: 4
      };
      
      const autoStartTasks = todoTasks
        .filter(t => t.autoStart)
        .sort((a, b) => {
          const pa = priorityOrder[a.priority] ?? 99;
          const pb = priorityOrder[b.priority] ?? 99;
          if (pa !== pb) return pa - pb;
          return new Date(a.created).getTime() - new Date(b.created).getTime();
        });
      
      task = autoStartTasks[0] || null;
    }

    res.json({
      success: true,
      task,
      queueLength: task ? 1 : 0,
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
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const task = await taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    
    // Add computed dependency fields (same as list endpoint)
    const taskWithDeps = {
      ...task,
      blocked: await taskManager.isTaskBlocked(task.id),
      blockingTasks: (await taskManager.getBlockingTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
      dependentTasks: (await taskManager.getDependentTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
    };
    
    res.json({ success: true, task: taskWithDeps });
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

    // Add computed dependency fields
    const taskWithDeps = {
      ...task,
      blocked: await taskManager.isTaskBlocked(task.id),
      blockingTasks: (await taskManager.getBlockingTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
      dependentTasks: (await taskManager.getDependentTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
    };

    res.status(201).json({ success: true, task: taskWithDeps });
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

    // Add computed dependency fields (same as GET endpoints)
    const taskWithDeps = {
      ...task,
      blocked: await taskManager.isTaskBlocked(task.id),
      blockingTasks: (await taskManager.getBlockingTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
      dependentTasks: (await taskManager.getDependentTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
    };

    res.json({ success: true, task: taskWithDeps });
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
    const task = await taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    // Only allow spawning from certain statuses
    const spawnableStatuses = ['ideas', 'todo', 'stuck', 'in-progress'];
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
 * POST /tasks/:id/spawn-agent
 * Spawn an isolated agent for the task via OpenClaw gateway cron.add
 * Returns { childSessionKey, runId } and updates task activeAgent
 */
router.post('/:id/spawn-agent', async (req: Request, res: Response): Promise<void> => {
  try {
    const task = await taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    // Only allow spawning from certain statuses
    const spawnableStatuses = ['ideas', 'todo', 'stuck', 'in-progress'];
    if (!spawnableStatuses.includes(task.status)) {
      res.status(400).json({
        success: false,
        error: `Cannot spawn from status "${task.status}". Must be one of: ${spawnableStatuses.join(', ')}`
      });
      return;
    }

    if (!gatewayConnector) {
      res.status(503).json({ success: false, error: 'Gateway connector not initialized' });
      return;
    }

    // Generate the agent prompt
    const prompt = await generateTaskPromptWithTools(task);

    // Determine model: request body > task field > default
    const model = req.body?.model || task.model || 'anthropic/claude-sonnet-4-6';
    const thinking = req.body?.thinking || 'low';

    // Delivery destination: env var or hardcoded fallback
    const announceTo = process.env.SPAWN_AGENT_ANNOUNCE_TO || 'user:204643948960940033';
    const announceChannel = process.env.SPAWN_AGENT_ANNOUNCE_CHANNEL || 'discord';

    // Schedule 1 second in the future
    const at = new Date(Date.now() + 1000).toISOString();
    const jobName = `spawn-task-${task.id.slice(0, 8)}`;

    // Call cron.add via gateway WebSocket
    const cronJob = await gatewayConnector.sendGatewayRequest('cron.add', {
      name: jobName,
      sessionTarget: 'isolated',
      schedule: { kind: 'at', at },
      payload: { kind: 'agentTurn', message: prompt },
      model,
      thinking,
      deleteAfterRun: true,
      delivery: {
        mode: 'announce',
        channel: announceChannel,
        to: announceTo,
      },
    });

    const runId = cronJob.id as string;
    const childSessionKey = `cron:${runId}`;

    // Update task to in-progress with activeAgent
    await taskManager.updateTask(task.id, {
      status: 'in-progress',
      startedAt: task.startedAt || new Date().toISOString(),
      activeAgent: { name: 'sub-agent', sessionKey: childSessionKey },
      executionMode: 'subagent',
    });

    console.log(`[Tasks API] Spawned agent for task ${task.id}: cron job ${runId}`);

    res.json({
      success: true,
      childSessionKey,
      runId,
      taskId: task.id,
      cronJob,
    });
  } catch (err) {
    console.error('[Tasks API] Error spawning agent:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
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
// Task Dependency Management APIs
// ============================================================

/**
 * GET /tasks/:id/dependencies
 * Get full dependency info for a task (both directions)
 * Returns { dependsOn: Task[], blockedBy: Task[] }
 */
router.get('/:id/dependencies', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const deps = await taskManager.getTaskDependencies(id);
    const blocked = await taskManager.isTaskBlocked(id);

    res.json({
      success: true,
      taskId: id,
      blocked,
      dependsOn: deps.dependsOn.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        project: t.project,
      })),
      blockedBy: deps.blockedBy.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        project: t.project,
      })),
    });
  } catch (err) {
    console.error('[Tasks API] Error getting dependencies:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else {
      res.status(500).json({ success: false, error: message });
    }
  }
});

/**
 * POST /tasks/:id/dependencies
 * Add a dependency (this task depends on another)
 * Body: { dependsOn: "task-uuid" }
 */
router.post('/:id/dependencies', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { dependsOn } = req.body;

    if (!dependsOn) {
      res.status(400).json({ success: false, error: 'dependsOn task ID is required' });
      return;
    }

    await taskManager.addDependency(id, dependsOn);

    // Return updated dependency info
    const deps = await taskManager.getTaskDependencies(id);
    const blocked = await taskManager.isTaskBlocked(id);

    res.status(201).json({
      success: true,
      taskId: id,
      blocked,
      dependsOn: deps.dependsOn.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
      })),
    });
  } catch (err) {
    console.error('[Tasks API] Error adding dependency:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else if (message.includes('Circular') || message.includes('itself') || message.includes('already exists')) {
      res.status(400).json({ success: false, error: message });
    } else {
      res.status(500).json({ success: false, error: message });
    }
  }
});

/**
 * DELETE /tasks/:id/dependencies/:depTaskId
 * Remove a dependency
 */
router.delete('/:id/dependencies/:depTaskId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id, depTaskId } = req.params;

    await taskManager.removeDependency(id, depTaskId);

    res.json({ success: true, taskId: id, removed: depTaskId });
  } catch (err) {
    console.error('[Tasks API] Error removing dependency:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else {
      res.status(500).json({ success: false, error: message });
    }
  }
});

// ============================================================
// Phase 1 Hub Redesign: Subtask Status Management APIs
// ============================================================

/**
 * PATCH /tasks/:id/subtasks/:index/status
 * Update subtask status with role-based permissions
 * 
 * Body: { 
 *   status: 'empty' | 'in_progress' | 'review' | 'blocked' | 'skipped' | 'completed', 
 *   role?: 'agent' | 'orchestrator', 
 *   reviewNote?: string,
 *   blockedReason?: string 
 * }
 * 
 * Role permissions:
 * - agent: can only set 'in_progress' or 'review'
 * - orchestrator (default): can set any status
 */
router.patch('/:id/subtasks/:index/status', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const index = parseInt(req.params.index, 10);
    const { status, role, reviewNote, blockedReason } = req.body;

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

    const task = await taskManager.updateSubtaskStatus(id, index, status, validatedRole, reviewNote, blockedReason);
    
    // Get subtask summary (always use async version for DB)
    const subtaskSummary = await (taskManager as any).getSubtaskSummaryAsync(id);
    const hasBlocked = await (taskManager as any).hasBlockedSubtasks(id);
    
    res.json({ 
      success: true, 
      task,
      subtaskSummary,
      hasBlocked
    });
  } catch (err) {
    console.error('[Tasks API] Error updating subtask status:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else if (message.includes('cannot') || message.includes('Cannot') || message.includes('Agents cannot')) {
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
 * SECURITY: To use restricted statuses (completed, blocked, skipped), caller must either:
 * - Include header X-Orchestrator-Key with valid value
 * - Include orchestrator: true in request body (for trusted internal callers)
 * Otherwise, only agent-allowed statuses (in_progress, review) are permitted.
 */
router.put('/:id/subtasks/:index', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const index = parseInt(req.params.index, 10);
    const { completed, status, reviewNote, blockedReason, orchestrator } = req.body;

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
      newStatus = completed ? 'completed' : 'empty';
    } else {
      res.status(400).json({ success: false, error: 'Either "status" or "completed" must be provided' });
      return;
    }

    // Determine role based on orchestrator flag or header
    const orchestratorHeader = req.headers['x-orchestrator-key'] as string | undefined;
    const envKey = process.env.ORCHESTRATOR_KEY;
    const isOrchestrator = 
      orchestrator === true || 
      orchestratorHeader === 'nim-orchestrator' ||
      (envKey !== undefined && orchestratorHeader === envKey);
    const role = isOrchestrator ? 'orchestrator' : 'agent';

    // Block agents from using non-agent statuses
    if (!AGENT_ALLOWED_STATUSES.includes(newStatus) && role === 'agent') {
      res.status(403).json({ 
        success: false, 
        error: `Agents cannot set status to '${newStatus}'. Use ${AGENT_ALLOWED_STATUSES.join(' or ')} instead, or include orchestrator flag.` 
      });
      return;
    }

    const task = await taskManager.updateSubtaskStatus(id, index, newStatus, role, reviewNote, blockedReason);
    
    // Add computed dependency fields
    const taskWithDeps = {
      ...task,
      blocked: await taskManager.isTaskBlocked(task.id),
      blockingTasks: (await taskManager.getBlockingTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
      dependentTasks: (await taskManager.getDependentTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
    };
    
    res.json({ success: true, task: taskWithDeps });
  } catch (err) {
    console.error('[Tasks API] Error updating subtask:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else if (message.includes('cannot') || message.includes('Cannot') || message.includes('Agents cannot')) {
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
    
    // Get subtask summary (always use async version for DB)
    const subtaskSummary = await (taskManager as any).getSubtaskSummaryAsync(id);
    const allCompleted = await (taskManager as any).allSubtasksCompletedAsync(id);
    
    res.json({ 
      success: true, 
      task,
      subtaskSummary,
      allCompleted
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
 * Reject a subtask (orchestrator marks as empty with optional note)
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
    
    // Get subtask summary (always use async version for DB)
    const subtaskSummary = await (taskManager as any).getSubtaskSummaryAsync(id);
    
    res.json({ 
      success: true, 
      task,
      subtaskSummary
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
 * POST /tasks/:id/subtasks/:index/block
 * Block a subtask (orchestrator only, requires reason)
 */
router.post('/:id/subtasks/:index/block', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const index = parseInt(req.params.index, 10);
    const { reason } = req.body;

    if (isNaN(index) || index < 0) {
      res.status(400).json({ success: false, error: 'Invalid subtask index' });
      return;
    }

    const task = await taskManager.blockSubtask(id, index, reason);
    
    const subtaskSummary = await (taskManager as any).getSubtaskSummaryAsync(id);
    
    res.json({ 
      success: true, 
      task,
      subtaskSummary,
      hasBlocked: true
    });
  } catch (err) {
    console.error('[Tasks API] Error blocking subtask:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    
    if (message.includes('not found')) {
      res.status(404).json({ success: false, error: message });
    } else {
      res.status(500).json({ success: false, error: message });
    }
  }
});

/**
 * POST /tasks/:id/subtasks/:index/skip
 * Skip a subtask (orchestrator only, counts as "done")
 */
router.post('/:id/subtasks/:index/skip', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const index = parseInt(req.params.index, 10);

    if (isNaN(index) || index < 0) {
      res.status(400).json({ success: false, error: 'Invalid subtask index' });
      return;
    }

    const task = await taskManager.skipSubtask(id, index);
    
    const subtaskSummary = await (taskManager as any).getSubtaskSummaryAsync(id);
    const allCompleted = await (taskManager as any).allSubtasksCompletedAsync(id);
    
    res.json({ 
      success: true, 
      task,
      subtaskSummary,
      allCompleted
    });
  } catch (err) {
    console.error('[Tasks API] Error skipping subtask:', err);
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
 * Returns counts for all 6 statuses: empty, in_progress, review, blocked, skipped, completed
 */
router.get('/:id/subtasks/summary', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const task = await taskManager.getTask(id);
    
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    // Get subtask summary (always use async version for DB)
    const summary = await (taskManager as any).getSubtaskSummaryAsync(id);
    const allCompleted = await (taskManager as any).allSubtasksCompletedAsync(id);
    const hasBlocked = await (taskManager as any).hasBlockedSubtasks(id);
    
    res.json({ 
      success: true, 
      taskId: id,
      summary,
      allCompleted,
      hasBlocked
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
