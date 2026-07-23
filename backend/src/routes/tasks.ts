// tasks.ts - API endpoints for task management
import { Router, Request, Response } from 'express';
import { taskManagerDB as taskManager, SubtaskStatus, DependencyValidationError, archiveWarningForStatus, ArchiveDisposition } from '../services/TaskManagerDB';
import { taskAutoUpdater } from '../services/TaskAutoUpdater';
import { taskAnalyzer } from '../services/taskAnalyzer';
import { generateTaskPromptWithTools } from '../utils/promptTemplate';
import { notificationManager } from '../services/NotificationManager';
import { taskReviewerService } from '../services/TaskReviewerService';
import { taskOrchestrationService, OrchestrationConflictError } from '../services/TaskOrchestrationService';
import type { GatewayConnector } from '../services/GatewayConnector';
import { discordThreadService } from '../services/DiscordThreadService';
import { attachmentCollector, Attachment } from '../services/AttachmentCollector';
import { writeAttachments, buildAttachmentPromptSection, cleanupAttachments } from '../services/AttachmentWriter';
import { projectService } from '../services/ProjectService';
import { createTaskExecutor } from '../services/TaskExecutors';
import { getHermesSessionRuntimeState, hermesSessionKeyFor, resolveLaunchedHermesSession, resolveWritableRuntimePath, shouldBlockHermesRespawn } from '../services/HermesRuntime';
import { taskTimelineService } from '../services/TaskTimelineService';
import { agentTypeStampAliases } from '../services/SessionIngester';
import { pool } from '../db/connection';
import { rejectInvalidTaskIdParam } from '../utils/taskIds';
import { resolveCreateAutoStart, dodWarningForStatusChange } from '../utils/taskLifecycle';
import { resolveTaskAutomationRole, type TaskAutomationRole } from '../utils/taskAutomationRole';
import { taskNotificationService, type TaskNotificationKind } from '../services/TaskNotificationService';
import { canonicalRuntimeSignalService } from '../services/CanonicalRuntimeSignalService';
import { classifyOpenClawRespawnState, taskSpawnGuard } from '../services/TaskSpawnGuard';

let gatewayConnector: GatewayConnector | null = null;

export function setTasksGatewayConnector(connector: GatewayConnector): void {
  gatewayConnector = connector;
}

const router = Router();

// Valid subtask statuses for validation (6-state lifecycle)
const VALID_SUBTASK_STATUSES: SubtaskStatus[] = ['empty', 'in_progress', 'review', 'blocked', 'skipped', 'completed'];
// Statuses agents can set (subtask-level)
const AGENT_ALLOWED_STATUSES: SubtaskStatus[] = ['in_progress', 'review'];
// Task-level statuses agents can set (orchestrator controls completed/todo/ideas/archived)
const AGENT_ALLOWED_TASK_STATUSES: string[] = ['in-progress', 'review', 'stuck'];

function getRequestAutomationRole(req: Request): TaskAutomationRole {
  return resolveTaskAutomationRole((req as Request & { userId?: string }).userId);
}

function rejectImplementationAgentOrchestratorAction(req: Request, res: Response, action: string): boolean {
  const role = getRequestAutomationRole(req);
  if (role === 'agent') {
    res.status(403).json({
      success: false,
      error: `Implementation agents cannot ${action}. Hand off to an independent QA/reviewer worker or orchestrator.`
    });
    return true;
  }
  return false;
}

const PROFILE_CAPABILITIES: Record<string, string[]> = {
  safe: [],
  dev: [],
  network: ['network'],
  homelab: ['network', 'long-running'],
  browser: ['browser'],
  elevated: ['elevated', 'network'],
};
const VALID_EXECUTION_MODES = ['main', 'subagent', 'interactive'];
const VALID_EXECUTION_HARNESSES = ['openclaw', 'hermes'];
const VALID_ACCESS_PROFILES = ['safe', 'dev', 'network', 'homelab', 'browser', 'elevated'];
const VALID_REQUIRED_CAPABILITIES = ['browser', 'host-browser', 'elevated', 'network', 'discord-thread', 'long-running'];

function normalizeExecutionProfile(input: any, fallbackMode?: string) {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('executionProfile must be an object');
  }

  const mode = input.mode || fallbackMode || 'subagent';
  if (!VALID_EXECUTION_MODES.includes(mode)) {
    throw new Error(`Invalid execution profile mode: "${mode}"`);
  }

  const harness = input.harness || 'openclaw';
  if (!VALID_EXECUTION_HARNESSES.includes(harness)) {
    throw new Error(`Invalid execution harness: "${harness}"`);
  }

  const accessProfile = input.accessProfile || 'dev';
  if (!VALID_ACCESS_PROFILES.includes(accessProfile)) {
    throw new Error(`Invalid access profile: "${accessProfile}"`);
  }

  const derivedCapabilities = PROFILE_CAPABILITIES[accessProfile] || [];
  const explicitCapabilities = input.requiredCapabilities === undefined
    ? []
    : input.requiredCapabilities;

  if (!Array.isArray(explicitCapabilities)) {
    throw new Error('executionProfile.requiredCapabilities must be an array');
  }

  const invalidCapabilities = explicitCapabilities.filter((cap: string) => !VALID_REQUIRED_CAPABILITIES.includes(cap));
  if (invalidCapabilities.length > 0) {
    throw new Error(`Invalid required capabilities: ${invalidCapabilities.join(', ')}`);
  }

  return {
    mode,
    harness,
    accessProfile,
    requiredCapabilities: Array.from(new Set([ ...derivedCapabilities, ...explicitCapabilities ])),
    allowOverrideAtSpawn: input.allowOverrideAtSpawn !== false,
    ...(typeof input.notes === 'string' && input.notes.trim() ? { notes: input.notes.trim() } : {}),
  };
}

function applyExecutionProfileDefaults(payload: any) {
  const normalizedProfile = normalizeExecutionProfile(payload.executionProfile, payload.executionMode);
  if (normalizedProfile === undefined) {
    if (payload.executionMode !== undefined) {
      if (!VALID_EXECUTION_MODES.includes(payload.executionMode)) {
        throw new Error(`Invalid execution mode: "${payload.executionMode}"`);
      }
      payload.executionProfile = {
        mode: payload.executionMode,
        harness: 'openclaw',
        accessProfile: 'dev',
        requiredCapabilities: [],
        allowOverrideAtSpawn: true,
      };
    }
    return payload;
  }

  if (normalizedProfile === null) {
    payload.executionProfile = null;
    return payload;
  }

  payload.executionProfile = normalizedProfile;
  payload.executionMode = normalizedProfile.mode;
  return payload;
}

async function getConfiguredDefaultModel(configPrimary: string): Promise<string> {
  try {
    const result = await pool.query(
      "SELECT value FROM user_preferences WHERE key = 'preferred_default_model'"
    );
    if (result.rows.length > 0 && result.rows[0].value) {
      return result.rows[0].value;
    }
  } catch {
    // Table might not exist yet, that's fine.
  }
  return configPrimary;
}

async function getConfiguredDefaultHarness(fallback: string): Promise<string> {
  try {
    const result = await pool.query(
      "SELECT value FROM user_preferences WHERE key = 'preferred_default_harness'"
    );
    if (result.rows.length > 0 && result.rows[0].value) {
      return result.rows[0].value;
    }
  } catch {
    // Table might not exist yet, that's fine.
  }
  return fallback;
}

function resolveTaskExecutionPolicy(task: any, requestBody: any = {}, defaultHarness: string = 'openclaw') {
  const profile = task.executionProfile || {};
  const allowOverrideAtSpawn = profile.allowOverrideAtSpawn !== false;

  const requestedMode = requestBody?.executionMode || requestBody?.mode;
  const requestedHarness = requestBody?.harness;
  const requestedAccessProfile = requestBody?.accessProfile;
  const requestedRequiredCapabilities = Array.isArray(requestBody?.requiredCapabilities)
    ? requestBody.requiredCapabilities
    : undefined;

  const mode = allowOverrideAtSpawn
    ? (requestedMode || profile.mode || task.executionMode || 'subagent')
    : (profile.mode || task.executionMode || 'subagent');
  const harness = allowOverrideAtSpawn
    ? (requestedHarness || profile.harness || defaultHarness)
    : (profile.harness || defaultHarness);
  const accessProfile = allowOverrideAtSpawn
    ? (requestedAccessProfile || profile.accessProfile || 'dev')
    : (profile.accessProfile || 'dev');

  const profileCapabilities = PROFILE_CAPABILITIES[accessProfile] || [];
  const explicitCapabilities = allowOverrideAtSpawn
    ? (requestedRequiredCapabilities || (Array.isArray(profile.requiredCapabilities) ? profile.requiredCapabilities : []))
    : (Array.isArray(profile.requiredCapabilities) ? profile.requiredCapabilities : []);
  const legacyCapabilityTags = Array.isArray(task.tags)
    ? task.tags.filter((tag: string) => ['browser', 'host-browser', 'elevated', 'network', 'discord-thread', 'long-running'].includes(tag))
    : [];

  const capabilities = new Set<string>([
    ...profileCapabilities,
    ...explicitCapabilities,
    ...legacyCapabilityTags,
  ]);

  const interactive = (allowOverrideAtSpawn && requestBody?.interactive === true)
    || mode === 'interactive'
    || capabilities.has('host-browser')
    || capabilities.has('discord-thread');

  return {
    mode: interactive ? 'interactive' : mode,
    interactive,
    harness,
    accessProfile,
    capabilities,
    allowOverrideAtSpawn,
    executionProfile: Object.keys(profile).length > 0 || requestedMode || requestedAccessProfile || requestedRequiredCapabilities || requestedHarness
      ? {
          ...profile,
          mode: interactive ? 'interactive' : mode,
          harness,
          accessProfile,
          requiredCapabilities: Array.from(new Set([ ...profileCapabilities, ...explicitCapabilities ])),
          allowOverrideAtSpawn,
        }
      : undefined,
  };
}

async function resolveTaskWorkingDirectory(task: any): Promise<string> {
  const fallbackPaths = [
    process.env.AGENT_WORKSPACE_DIR,
    process.env.HERMES_TASK_CWD,
    '/task-projects',
    '/workspace',
  ];

  if (!task?.project) return resolveWritableRuntimePath([], fallbackPaths);

  try {
    const projects = await projectService.list();
    const project = projects.find((p: any) => p.name === task.project || p.id === task.project);
    return resolveWritableRuntimePath([
      project?.resources?.localPaths?.ssdBuild,
      project?.source_dir,
      project?.resources?.localPaths?.nfsRoot,
      project?.nfs_dir,
    ], fallbackPaths);
  } catch {
    return resolveWritableRuntimePath([], fallbackPaths);
  }
}

function getActiveAgentPid(task: any): number | null {
  const raw = task?.activeAgent && typeof task.activeAgent === 'object' ? (task.activeAgent as any).pid : null;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function mergeSessionRefs(task: any, ...sessionKeys: Array<string | null | undefined>): string[] {
  const refs = new Set<string>(Array.isArray(task?.sessionRefs) ? task.sessionRefs.filter(Boolean) : []);
  for (const sessionKey of sessionKeys) {
    if (sessionKey && sessionKey !== 'pending') refs.add(sessionKey);
  }
  return Array.from(refs);
}

/**
 * GET /tasks
 * List all active tasks with optional filters
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const filters: any = {};
    const getList = (value: unknown): string[] | undefined => {
      if (Array.isArray(value)) return value.flatMap(v => String(v).split(',')).map(v => v.trim()).filter(Boolean);
      if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
      return undefined;
    };
    
    if (req.query.status) filters.status = req.query.status as string;
    const statuses = getList(req.query.statuses);
    if (statuses?.length) filters.statuses = statuses;
    if (req.query.project) filters.project = req.query.project as string;
    const projects = getList(req.query.projects);
    if (projects?.length) filters.projects = projects;
    if (req.query.priority) filters.priority = req.query.priority as string;
    const priorities = getList(req.query.priorities);
    if (priorities?.length) filters.priorities = priorities;
    if (req.query.tag) filters.tag = req.query.tag as string;
    const tags = getList(req.query.tags);
    if (tags?.length) filters.tags = tags;
    if (req.query.q) filters.q = req.query.q as string;
    if (req.query.excludeTaskId) filters.excludeTaskId = req.query.excludeTaskId as string;
    if (req.query.includeArchived !== undefined) {
      filters.includeArchived = String(req.query.includeArchived) === 'true';
    }
    if (req.query.limit) {
      const parsedLimit = Number(req.query.limit);
      if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
        filters.limit = parsedLimit;
      }
    }
    if (req.query.offset) {
      const parsedOffset = Number(req.query.offset);
      if (Number.isFinite(parsedOffset) && parsedOffset >= 0) {
        filters.offset = parsedOffset;
      }
    }
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
 * GET /tasks/filter-options
 * Return available filter values from the DB-backed task set
 */
router.get('/filter-options', async (req: Request, res: Response): Promise<void> => {
  try {
    const includeArchived = req.query.includeArchived === undefined
      ? true
      : String(req.query.includeArchived) === 'true';
    const options = await taskManager.getTaskFilterOptions(includeArchived);
    res.json({ success: true, ...options });
  } catch (err) {
    console.error('[Tasks API] Error loading filter options:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * GET /tasks/board
 * Per-column paginated task board, server-side filtered
 */
router.get('/board', async (req: Request, res: Response): Promise<void> => {
  try {
    const parseList = (value: unknown, fallback: string[] = []): string[] => {
      if (Array.isArray(value)) return value.flatMap(v => String(v).split(',')).map(v => v.trim()).filter(Boolean);
      if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
      return fallback;
    };

    const statuses = parseList(req.query.statuses, ['ideas', 'todo', 'in-progress', 'stuck', 'completed', 'archived']);
    const perColumnRaw = Number(req.query.perColumn);
    const perColumn = Number.isFinite(perColumnRaw) && perColumnRaw > 0 ? Math.min(perColumnRaw, 100) : 6;
    const includeArchived = req.query.includeArchived === undefined
      ? statuses.includes('archived')
      : String(req.query.includeArchived) === 'true';

    const offsets: Record<string, number> = {};
    for (const status of statuses) {
      const value = req.query[`offset_${status}` as keyof typeof req.query];
      const parsed = Number(Array.isArray(value) ? value[0] : value);
      if (Number.isFinite(parsed) && parsed >= 0) offsets[status] = parsed;
    }

    const board = await taskManager.queryBoardColumns(
      statuses,
      {
        q: req.query.q as string | undefined,
        projects: parseList(req.query.projects),
        priorities: parseList(req.query.priorities),
        tags: parseList(req.query.tags),
        includeArchived,
      },
      perColumn,
      offsets
    );

    res.json({
      success: true,
      columns: board.columns,
      meta: { statuses, perColumn, includeArchived },
    });
  } catch (err) {
    console.error('[Tasks API] Error loading board:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
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
 * POST /tasks/orchestration/:id/claim
 * Compare-and-set claim with dependency and active resource lease checks.
 */
router.post('/orchestration/:id/claim', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectImplementationAgentOrchestratorAction(req, res, 'claim scheduler work')) return;
    const { snapshotUpdatedAt, harness, resourceKey, sessionKey, ttlSeconds, metadata } = req.body || {};
    if (!snapshotUpdatedAt || !['hermes', 'openclaw'].includes(harness) || !resourceKey) {
      res.status(400).json({ success: false, error: 'snapshotUpdatedAt, harness, and resourceKey are required' });
      return;
    }
    const claim = await taskOrchestrationService.claimReadyTask({
      taskId: req.params.id,
      snapshotUpdatedAt,
      harness,
      resourceKey,
      sessionKey,
      ttlSeconds,
      metadata,
    });
    res.status(claim.acquired ? 201 : 200).json({ success: true, ...claim });
  } catch (err) {
    if (err instanceof OrchestrationConflictError) {
      res.status(err.code === 'TASK_NOT_FOUND' ? 404 : 409).json({ success: false, code: err.code, error: err.message });
      return;
    }
    console.error('[Tasks API] Error claiming orchestration task:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

router.post('/orchestration/:id/lease/:leaseId/heartbeat', async (req: Request, res: Response): Promise<void> => {
  try {
    const lease = await taskOrchestrationService.heartbeatLease(
      req.params.id,
      req.params.leaseId,
      req.body?.sessionKey,
      req.body?.ttlSeconds,
    );
    res.json({ success: true, lease });
  } catch (err) {
    const status = err instanceof OrchestrationConflictError ? 409 : 500;
    res.status(status).json({ success: false, code: err instanceof OrchestrationConflictError ? err.code : undefined, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

router.post('/orchestration/:id/lease/:leaseId/release', async (req: Request, res: Response): Promise<void> => {
  try {
    const status = req.body?.status === 'failed' ? 'failed' : 'released';
    const lease = await taskOrchestrationService.releaseLease(
      req.params.id,
      req.params.leaseId,
      status,
      req.body?.failureReason,
    );
    res.json({ success: true, lease });
  } catch (err) {
    const status = err instanceof OrchestrationConflictError ? 409 : 500;
    res.status(status).json({ success: false, code: err instanceof OrchestrationConflictError ? err.code : undefined, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * POST /tasks/reviewer/:id/run
 * Run the structured reviewer. Dry-run is guaranteed to skip task/history and
 * notification mutations inside TaskReviewerService.
 */
router.post('/reviewer/:id/run', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectImplementationAgentOrchestratorAction(req, res, 'run the independent reviewer')) return;
    const outcome = await taskReviewerService.runReview(req.params.id, {
      dryRun: req.body?.dryRun === true,
      triggeredBy: req.body?.triggeredBy || 'user',
    });
    res.json({ success: true, dryRun: req.body?.dryRun === true, outcome });
  } catch (err) {
    console.error('[Tasks API] Error running reviewer:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(/not found/i.test(message) ? 404 : 500).json({ success: false, error: message });
  }
});

/**
 * POST /tasks/reviewer/:id/reject
 * Record a structured independent rejection and bounded retry/escalation.
 */
router.post('/reviewer/:id/reject', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectImplementationAgentOrchestratorAction(req, res, 'reject tasks')) return;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) {
      res.status(400).json({ success: false, error: 'Reject reason is required' });
      return;
    }
    const outcome = await taskReviewerService.rejectTask(req.params.id, reason, {
      triggeredBy: req.body?.triggeredBy || 'user',
    });
    res.json({ success: true, outcome });
  } catch (err) {
    console.error('[Tasks API] Error rejecting reviewer task:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(/not found/i.test(message) ? 404 : 500).json({ success: false, error: message });
  }
});

/**
 * POST /tasks/:id/notifications/deliver
 * Reserve and deliver an operator notification through the durable receipt
 * ledger. Scheduler callers must not complete dedup before this returns a
 * transport receipt.
 */
router.post('/:id/notifications/deliver', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectImplementationAgentOrchestratorAction(req, res, 'deliver operator notifications')) return;
    const allowedKinds: TaskNotificationKind[] = ['review-escalation', 'blocked-human', 'stale', 'review'];
    const kind = req.body?.kind as TaskNotificationKind;
    const stateVersion = typeof req.body?.stateVersion === 'string' ? req.body.stateVersion.trim() : '';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!allowedKinds.includes(kind) || !stateVersion || !message) {
      res.status(400).json({ success: false, error: 'kind, stateVersion, and message are required' });
      return;
    }
    const task = await taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }
    const destination = task.discordThreadId || discordThreadService.getSystemNotificationChannelId();
    if (!destination) {
      res.status(409).json({ success: false, error: 'No configured task-thread or system notification destination' });
      return;
    }
    const result = await taskNotificationService.deliver({
      taskId: task.id,
      kind,
      stateVersion,
      destination,
      message,
    });
    res.status(result.status === 'failed' ? 503 : 200).json({
      success: result.status !== 'failed',
      ...result,
    });
  } catch (error) {
    console.error('[Tasks API] Durable notification delivery failed:', error);
    res.status(500).json({ success: false, error: 'Durable notification delivery failed' });
  }
});

/**
 * GET /tasks/next
 * Next auto-start task in the todo queue (todo + autoStart + not blocked).
 *
 * ROUTE ORDER MATTERS: 'next', 'current' and 'notifications' are reserved
 * static path segments. Express matches routes in registration order, so
 * every literal route MUST be registered BEFORE the '/:id' wildcard below —
 * otherwise '/:id' swallows the request and rejectInvalidTaskIdParam()
 * returns 400 INVALID_TASK_ID (this is exactly what broke `clawboard next`).
 * Covered by the route-registration-order test in taskLifecycleGates.test.ts.
 */
router.get('/next', async (_req: Request, res: Response): Promise<void> => {
  try {
    const queue = await taskManager.getAutoStartQueue();
    res.json({
      success: true,
      task: queue[0] || null,
      queueLength: queue.length,
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
 * GET /tasks/notifications
 * Get all notifications (with optional filter for unread only).
 * NOTE: Registered here (before '/:id') — see route-order comment on /next.
 * Previously registered after '/:id' and therefore unreachable (400).
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
 * GET /tasks/:id/timeline
 * Returns durable task/session timeline entries, including legacy fallbacks.
 */
router.get('/:id/timeline', async (req: Request, res: Response): Promise<void> => {
  try {
    if (rejectInvalidTaskIdParam(req.params.id, res)) {
      return;
    }

    const task = await taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    const events = await taskTimelineService.buildTimeline(task as any);
    res.json({ success: true, taskId: task.id, events });
  } catch (err) {
    console.error('[Tasks API] Error getting task timeline:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
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
    if (rejectInvalidTaskIdParam(req.params.id, res)) {
      return;
    }

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
      // AI execution/reviewer fields
      model, executionMode, executionProfile, activeAgent,
      successCriteria, reviewHistory, maxRetries, definitionOfDone, constraints,
      // Thinking level
      thinking,
      // Agent persona type
      agentTypeId,
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

    const createPayload = applyExecutionProfileDefaults({
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
      // Lifecycle gate: autoStart is opt-in. Missing/false-y -> FALSE so new
      // tasks are never silently eligible for orchestrator auto-pickup.
      autoStart: resolveCreateAutoStart(autoStart),
      blockedBy,
      blockedReason,
      // Task dependencies
      dependsOn,
      // AI execution fields
      model,
      executionMode,
      executionProfile,
      activeAgent,
      successCriteria,
      reviewHistory,
      maxRetries,
      definitionOfDone,
      constraints,
      // Thinking level
      thinking,
      // Agent persona type
      agentTypeId,
      // Legacy fields
      parentId,
      notes
    });

    const task = await taskManager.createTask(createPayload as any);

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
    if (err instanceof DependencyValidationError) {
      res.status(400).json({ success: false, error: err.message, code: err.code, offendingIds: err.offendingIds });
      return;
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = /executionProfile|execution profile|execution mode|access profile|required capabilities/i.test(message) ? 400 : 500;
    res.status(status).json({
      success: false,
      error: message
    });
  }
});

/**
 * PATCH /tasks/:id
 * Update an existing task
 */
router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const updates = applyExecutionProfileDefaults({ ...req.body });
    delete updates.id; // Don't allow ID changes
    delete updates.created; // Don't allow created timestamp changes

    // Validate thinking level if provided
    const validThinkingLevels = ['low', 'medium', 'high'];
    if (updates.thinking && !validThinkingLevels.includes(updates.thinking)) {
      res.status(400).json({ success: false, error: `Invalid thinking level: "${updates.thinking}". Must be one of: ${validThinkingLevels.join(', ')}` });
      return;
    }

    // Agent role enforcement for task status moves
    let dodWarning: string | undefined;
    let priorStatus: string | undefined;
    if (updates.status) {
      const role = getRequestAutomationRole(req);
      if (role === 'agent' && !AGENT_ALLOWED_TASK_STATUSES.includes(updates.status)) {
        res.status(403).json({
          success: false,
          error: `Agents cannot move tasks to '${updates.status}'. Allowed: ${AGENT_ALLOWED_TASK_STATUSES.join(', ')}. Only the orchestrator can mark tasks as completed.`
        });
        return;
      }

      // Lifecycle gate (non-blocking): warn on ideas -> todo without a
      // definitionOfDone. The move still succeeds; the response carries a
      // 'warning' field callers may surface (CLI prints it).
      const existing = await taskManager.getTask(req.params.id);
      if (existing) {
        priorStatus = existing.status;
        const effectiveDod = updates.definitionOfDone !== undefined
          ? updates.definitionOfDone
          : (existing as any).definitionOfDone;
        dodWarning = dodWarningForStatusChange(existing.status, updates.status, effectiveDod);
      }
    }

    const task = await taskManager.updateTask(req.params.id, updates);

    // Unified archive policy (task 7d2a60a6): PATCH status->archived carries
    // the same warning as POST /tasks/:id/archive when the task was not
    // completed at archive time. The optional body field `archiveReason`
    // flowed through updates into updateTask, which appended it to task notes.
    let archiveWarning: string | undefined;
    if (updates.status === 'archived' && priorStatus && priorStatus !== 'archived') {
      archiveWarning = archiveWarningForStatus(
        priorStatus,
        (task.archiveDisposition ?? 'abandoned') as ArchiveDisposition
      );
    }

    // Add computed dependency fields (same as GET endpoints)
    const taskWithDeps = {
      ...task,
      blocked: await taskManager.isTaskBlocked(task.id),
      blockingTasks: (await taskManager.getBlockingTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
      dependentTasks: (await taskManager.getDependentTasks(task.id)).map(t => ({ id: t.id, title: t.title })),
    };

    // dodWarning (ideas->todo) and archiveWarning (->archived) are mutually
    // exclusive transitions, but join defensively if both ever appear.
    const warning = [dodWarning, archiveWarning].filter(Boolean).join('; ') || undefined;
    res.json({ success: true, task: taskWithDeps, ...(warning ? { warning } : {}) });
  } catch (err) {
    console.error('[Tasks API] Error updating task:', err);
    if (err instanceof DependencyValidationError) {
      res.status(400).json({ success: false, error: err.message, code: err.code, offendingIds: err.offendingIds });
      return;
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      const status = /executionProfile|execution profile|execution mode|access profile|required capabilities/i.test(message) ? 400 : 500;
      res.status(status).json({ 
        success: false, 
        error: message 
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
 * Archive a task from ANY status (unified archive policy, task 7d2a60a6).
 * Body (optional): { reason?: string } — appended to task notes as
 * "Archived (<disposition>): <reason>". `archiveReason` is accepted as an
 * alias to mirror the PATCH body field.
 * Response: { success, archived, disposition, warning?, task } — `warning`
 * ("archiving non-completed task (disposition: ...)") is present when the
 * task was not completed at archive time.
 */
router.post('/:id/archive', async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body || {};
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason
      : (typeof body.archiveReason === 'string' ? body.archiveReason : undefined);
    const result = await taskManager.archiveTask(req.params.id, { reason });
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
 * Legacy preview/start endpoint. Defaults to ACP-interactive execution metadata.
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

    const defaultHarness = await getConfiguredDefaultHarness('openclaw');
    const policy = resolveTaskExecutionPolicy(task, req.body, defaultHarness);

    // Generate the prompt (with DB-backed tool context if available)
    const prompt = await generateTaskPromptWithTools(task, { interactive: policy.interactive });

    // Move to in-progress with placeholder execution metadata
    await taskManager.updateTask(task.id, {
      status: 'in-progress',
      startedAt: new Date().toISOString(),
      activeAgent: { name: policy.interactive ? 'interactive-agent' : 'sub-agent', sessionKey: 'pending' },
      executionMode: policy.mode as any,
      executionProfile: policy.executionProfile,
    });

    res.json({ success: true, prompt, taskId: task.id, harness: policy.harness, interactive: policy.interactive, executionMode: policy.mode, executionProfile: policy.executionProfile || null });
  } catch (err) {
    console.error('[Tasks API] Error spawning task:', err);
    res.status(500).json({ 
      success: false, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

/**
 * POST /tasks/:id/spawn-prompt
 * Dry-run: build and return the full agent prompt without spawning
 * Returns { prompt, model, thinking, taskId } — no side effects
 */
router.post('/:id/spawn-prompt', async (req: Request, res: Response): Promise<void> => {
  const task = await taskManager.getTask(req.params.id);
  if (!task) {
    res.status(404).json({ success: false, error: 'Task not found' });
    return;
  }
  const prompt = await generateTaskPromptWithTools(task);
  const configuredDefaultModel = await getConfiguredDefaultModel('openai-codex/gpt-5.4');
  const model = req.body?.model || task.model || configuredDefaultModel;
  const thinking = req.body?.thinking || 'low';
  res.json({ success: true, prompt, model, thinking, taskId: task.id });
});

/**
 * POST /tasks/:id/spawn-agent
 * Spawn an isolated agent for the task via OpenClaw gateway cron.add
 * Returns { childSessionKey, runId } and updates task activeAgent
 */
router.post('/:id/spawn-agent', async (req: Request, res: Response): Promise<void> => {
  await taskSpawnGuard.run(req.params.id, async () => {
    let attachmentAbsDir: string | null = null;

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

    const defaultHarness = await getConfiguredDefaultHarness('openclaw');
    const policy = resolveTaskExecutionPolicy(task, req.body, defaultHarness);
    const harness = policy.harness;

    if (harness === 'openclaw' && !gatewayConnector) {
      res.status(503).json({ success: false, error: 'Gateway connector not initialized' });
      return;
    }

    // ── Dedup guard: avoid launching duplicate turns for the same task ───────
    const forceSpawn = req.body?.force === true;
    if (!forceSpawn && task.activeAgent?.sessionKey) {
      const existingKey = task.activeAgent.sessionKey as string;
      if (harness === 'openclaw' && gatewayConnector) {
        try {
          // Background OpenClaw jobs use deleteAfterRun=true, so cron.list can
          // lose the one-shot job while its child session is still running.
          // Query the harness executor, which checks both cron and live state.
          const executor = createTaskExecutor('openclaw', gatewayConnector);
          const existing = await executor.getSessionStatus({
            taskId: task.id,
            sessionKey: existingKey,
            model: task.model || null,
            interactive: task.executionMode === 'interactive',
          });
          const decision = classifyOpenClawRespawnState(existing.state);
          if (decision === 'block') {
            console.log(`[Tasks API] Dedup: active OpenClaw session already exists for task ${task.id} (${existingKey}, ${existing.state})`);
            res.json({
              success: true,
              childSessionKey: existingKey,
              runId: existingKey.split(':').pop() || null,
              taskId: task.id,
              cronJob: (existing.raw as any)?.cronJob || null,
              attachmentsWritten: false,
              harness,
              interactive: policy.interactive,
              duplicate: true,
            });
            return;
          }
          if (decision === 'unknown') {
            console.error(`[Tasks API] OpenClaw runtime state is unknown; refusing an unverified respawn for ${task.id}:`, existing.reason);
            res.status(503).json({
              success: false,
              error: 'Cannot verify the existing OpenClaw runtime; spawn refused to prevent a duplicate',
              code: 'SPAWN_DEDUP_UNAVAILABLE',
              harness,
            });
            return;
          }
        } catch (dedupErr) {
          console.error('[Tasks API] OpenClaw dedup check unavailable; refusing an unverified respawn:', dedupErr);
          res.status(503).json({
            success: false,
            error: 'Cannot verify the existing OpenClaw runtime; spawn refused to prevent a duplicate',
            code: 'SPAWN_DEDUP_UNAVAILABLE',
            harness,
          });
          return;
        }
      }

      if (harness === 'hermes') {
        try {
          let dedupKey = existingKey;

          // Provisional window: the previous spawn returned before Hermes
          // registered its sessions row. Try a synchronous bind first so dedup
          // evaluates the REAL session's state instead of the 'pending'
          // sentinel (which resolves to state 'none' once the PID dies).
          if (existingKey === 'pending' && task.activeAgent?.sourceTag) {
            const spawnedAtUnix = typeof (task.activeAgent as any).spawnedAtUnix === 'number'
              ? (task.activeAgent as any).spawnedAtUnix as number
              : Math.floor(new Date(task.startedAt || task.updated).getTime() / 1000) - 2;
            const row = await resolveLaunchedHermesSession(
              task.activeAgent.sourceTag,
              spawnedAtUnix,
              task.activeAgent.logPath || '',
            );
            if (row) {
              const realSessionKey = hermesSessionKeyFor(row);
              console.log(`🔗 [Tasks API] Dedup bound provisional Hermes session for task ${task.id}: ${realSessionKey}`);
              await taskManager.updateTask(task.id, {
                activeAgent: { ...task.activeAgent, sessionKey: realSessionKey },
                sessionRefs: mergeSessionRefs(task, realSessionKey),
                ...((task as any).executionMode === 'interactive' ? { acpSessionKey: realSessionKey } : {}),
              });
              dedupKey = realSessionKey;
            }
            // If unresolvable: with a live PID the state check below reports
            // 'starting' and blocks; with a dead PID it reports 'none' and the
            // respawn proceeds (accepted narrow edge).
          }

          const existing = await getHermesSessionRuntimeState(dedupKey, getActiveAgentPid(task));
          if (shouldBlockHermesRespawn(existing)) {
            console.log(`[Tasks API] Dedup: active Hermes session already exists for task ${task.id} (${existing.sessionKey})`);
            res.json({
              success: true,
              childSessionKey: existing.sessionKey,
              runId: getActiveAgentPid(task) ? String(getActiveAgentPid(task)) : null,
              taskId: task.id,
              attachmentsWritten: false,
              harness,
              interactive: policy.interactive,
              duplicate: true,
              ...(policy.interactive ? { acpSessionKey: task.acpSessionKey || existing.sessionKey } : {}),
            });
            return;
          }
        } catch (dedupErr) {
          console.error('[Tasks API] Hermes dedup check unavailable; refusing an unverified respawn:', dedupErr);
          res.status(503).json({
            success: false,
            error: 'Cannot verify the existing Hermes runtime; spawn refused to prevent a duplicate',
            code: 'SPAWN_DEDUP_UNAVAILABLE',
            harness,
          });
          return;
        }
      }
    }

    // ── Attachment handling ────────────────────────────────────────────────────
    // Attachments can come from:
    //   1. req.body.attachments  — explicit list from CLI (--attach <file>)
    //   2. Auto-collected from project context (unless req.body.noAttach = true)
    //
    // Files are materialised into the agent workspace at
    //   .openclaw/attachments/<uuid>/
    // and a summary section is prepended to the agent prompt so the agent knows
    // exactly where to read from (no filesystem path guessing).

    const noAttach = req.body?.noAttach === true;
    let attachmentsToWrite: Attachment[] = [];

    if (!noAttach) {
      // Start with any explicitly provided attachments from the CLI
      const explicit: Attachment[] = Array.isArray(req.body?.attachments)
        ? req.body.attachments
        : [];

      if (explicit.length > 0) {
        attachmentsToWrite = explicit;
        console.log(`[Tasks API] Using ${explicit.length} explicitly-provided attachment(s)`);
      } else {
        // Auto-collect project context files
        try {
          // Resolve project to get paths
          let projectSsdPath: string | null = null;
          const taskLinkUrls: string[] = [];

          if (task.project) {
            const projects = await projectService.list();
            const project = projects.find(
              (p: any) => p.name === task.project || p.id === task.project,
            );
            if (project) {
              projectSsdPath = project.source_dir || null;
              // Collect file:// link URLs from project links
              if (project.links) {
                for (const link of project.links) {
                  if (link.url?.startsWith('file://')) {
                    taskLinkUrls.push(link.url);
                  }
                }
              }
            }
          }

          // Also collect file:// links from task's own link list
          if (task.links) {
            for (const link of (task.links as any[])) {
              if (link.url?.startsWith('file://')) {
                taskLinkUrls.push(link.url);
              }
            }
          }

          // Subtask descriptions for file path extraction
          const subtaskTexts = (task.subtasks || []).map((s: any) =>
            typeof s === 'string' ? s : s.text || '',
          );

          const candidatePaths = attachmentCollector.buildCandidatePaths({
            projectSsdPath,
            taskLinkUrls,
            subtaskTexts,
          });

          if (candidatePaths.length > 0) {
            // Allow per-request limit overrides from request body
            const limitOverrides = req.body?.attachmentLimits && typeof req.body.attachmentLimits === 'object'
              ? req.body.attachmentLimits
              : {};
            const { AttachmentCollector: AC } = await import('../services/AttachmentCollector');
            const collector = Object.keys(limitOverrides).length > 0
              ? new AC(limitOverrides)
              : attachmentCollector;
            const collected = collector.collect(candidatePaths);
            attachmentsToWrite = collected.attachments;

            if (collected.skipped.length > 0) {
              console.log(
                `[Tasks API] Attachment collection: ${collected.attachments.length} collected, ` +
                `${collected.skipped.length} skipped`,
              );
              for (const sk of collected.skipped) {
                console.log(`  skip: ${sk.path} — ${sk.reason}`);
              }
            } else {
              console.log(`[Tasks API] Auto-collected ${attachmentsToWrite.length} attachment(s) from project context`);
            }
          }
        } catch (attachErr) {
          // Non-fatal: if collection fails, proceed without attachments
          console.warn('[Tasks API] Auto-attachment collection failed (non-fatal):', attachErr);
        }
      }
    }

    // ── Generate the agent prompt ──────────────────────────────────────────────
    // Allow spawn-time agentTypeId override (--agent-type CLI flag)
    const spawnAgentTypeId = req.body?.agentTypeId;
    const taskForPrompt = {
      ...task,
      ...(spawnAgentTypeId ? { agentTypeId: spawnAgentTypeId } : {}),
      executionMode: policy.mode,
      executionProfile: policy.executionProfile || task.executionProfile,
    };
    let prompt = await generateTaskPromptWithTools(taskForPrompt as any, { interactive: policy.interactive });
    const workdir = await resolveTaskWorkingDirectory(task);

    // Hermes runs must receive attachments inside the same writable workspace
    // they use as cwd. OpenClaw still expects the legacy shared workspace root
    // exposed by the gateway runtime.
    const { existsSync: existsSyncWs } = await import('fs');
    const attachmentWorkspace = harness === 'hermes'
      ? workdir
      : (process.env.AGENT_WORKSPACE_DIR
        || (existsSyncWs('/workspace') ? '/workspace' : '/home/clawd/clawd'));

    // ── Materialise attachments into the agent workspace ──────────────────────
    if (attachmentsToWrite.length > 0) {
      try {
        const manifest = await writeAttachments(attachmentWorkspace, attachmentsToWrite);
        attachmentAbsDir = manifest.absDir;

        // Prepend attachment section to the prompt so the agent sees it first
        const attachSection = buildAttachmentPromptSection(manifest);
        if (attachSection) {
          prompt = attachSection + '\n\n' + prompt;
        }

        console.log(
          `[Tasks API] Wrote ${manifest.count} attachment(s) → ${manifest.relDir} ` +
          `(${(manifest.totalBytes / 1024).toFixed(1)} KB total) in ${attachmentWorkspace}`,
        );
      } catch (writeErr) {
        // Non-fatal: if writing fails, proceed without attachments (path just won't be in prompt)
        console.warn('[Tasks API] Failed to write attachments (non-fatal):', writeErr);
        attachmentAbsDir = null;
      }
    }

    // Determine model: request body > task field > configured default
    const configuredDefaultModel = await getConfiguredDefaultModel('openai-codex/gpt-5.4');
    const model = (policy.allowOverrideAtSpawn ? req.body?.model : null) || task.model || configuredDefaultModel;
    const thinking = (policy.allowOverrideAtSpawn ? req.body?.thinking : null) || task.thinking || 'low';
    const interactive = policy.interactive;
    const capabilityTags = policy.capabilities;

    if (!interactive && (capabilityTags.has('host-browser') || capabilityTags.has('discord-thread'))) {
      res.status(400).json({
        success: false,
        error: 'This task requires interactive execution because it is tagged with host-browser or discord-thread.',
      });
      return;
    }

    // Delivery destination: env var or hardcoded fallback
    const announceTo = process.env.SPAWN_AGENT_ANNOUNCE_TO || 'user:204643948960940033';
    const announceChannel = process.env.SPAWN_AGENT_ANNOUNCE_CHANNEL || 'discord';

    const jobName = `spawn-task-${task.id.slice(0, 8)}`;
    const executor = createTaskExecutor(harness as any, gatewayConnector);
    const spawned = await executor.spawn({
      taskId: task.id,
      title: task.title,
      prompt,
      model,
      thinking,
      interactive,
      jobName,
      announceTo,
      announceChannel,
      cwd: workdir,
    });

    const runId = spawned.runId || null;
    const childSessionKey = spawned.sessionKey;
    const acpSessionKey = spawned.controlSessionKey || null;
    const spawnMetadata = spawned.raw || {};
    const nextSessionRefs = mergeSessionRefs(task, childSessionKey, acpSessionKey);

    // Note: GatewayConnector no longer tracks task sessions (removed anti-prune logic).
    // SessionIngester watches sessions.json for metadata; live state is populated from streaming events.

    // Update task to in-progress with activeAgent
    await taskManager.updateTask(task.id, {
      status: 'in-progress',
      startedAt: task.startedAt || new Date().toISOString(),
      sessionRefs: nextSessionRefs,
      activeAgent: {
        name: interactive ? 'interactive-agent' : 'sub-agent',
        sessionKey: childSessionKey,
        harness,
        ...(typeof spawnMetadata.pid === 'number' ? { pid: spawnMetadata.pid as number } : {}),
        ...(typeof spawnMetadata.sourceTag === 'string' ? { sourceTag: spawnMetadata.sourceTag as string } : {}),
        ...(typeof spawnMetadata.logPath === 'string' ? { logPath: spawnMetadata.logPath as string } : {}),
        ...(typeof spawnMetadata.spawnedAtUnix === 'number' ? { spawnedAtUnix: spawnMetadata.spawnedAtUnix as number } : {}),
      },
      executionMode: policy.mode as any,
      executionProfile: policy.executionProfile || task.executionProfile,
      ...(acpSessionKey ? { acpSessionKey } : { acpSessionKey: null }),
    });

    // Persona analytics: stamp the task's agentTypeId onto any session rows
    // already persisted under the spawned keys. Best-effort — rows created
    // later are stamped by the SessionIngester upsert subquery (which reads
    // the sessionRefs written above) or the SubAgentTaskUpdater bind step.
    const stampAgentTypeId = spawnAgentTypeId || task.agentTypeId || null;
    if (stampAgentTypeId) {
      const stampKeys = Array.from(new Set(
        [childSessionKey, acpSessionKey]
          .filter((key): key is string => Boolean(key) && key !== 'pending')
          .flatMap(key => agentTypeStampAliases(key))
      ));
      if (stampKeys.length > 0) {
        pool.query(
          `UPDATE sessions
              SET agent_type_id = $1, updated_at = NOW()
            WHERE (session_key = ANY($2::text[])
                   OR session_key LIKE ANY(SELECT k || ':run:%' FROM unnest($2::text[]) AS k))
              AND agent_type_id IS NULL`,
          [stampAgentTypeId, stampKeys]
        ).catch(err => console.warn(`[Tasks API] Failed to stamp agent type on spawned session(s) for task ${task.id}:`, err));
      }
    }

    await taskTimelineService.recordEvent({
      taskId: task.id,
      eventType: 'session.spawned',
      title: 'Spawned task session',
      description: `${interactive ? 'Interactive' : 'Background'} ${harness} session started for this task.`,
      sessionKey: childSessionKey,
      actor: interactive ? 'interactive-agent' : 'sub-agent',
      harness,
      metadata: {
        runId,
        acpSessionKey,
        interactive,
        model,
        thinking,
        attachmentsWritten: Boolean(attachmentAbsDir),
        provisional: spawnMetadata.provisional === true,
      },
    });

    // Phase 3: Create Discord thread for interactive tasks
    let discordThreadId: string | null = null;
    if (interactive) {
      discordThreadService.createThreadForTask(task.id, task.title, childSessionKey)
        .then(threadId => {
          if (threadId) {
            discordThreadId = threadId;
            console.log(`🧵 [Tasks API] Discord thread created: ${threadId} for task ${task.id}`);
          }
        })
        .catch(err => {
          // Non-fatal — log and continue
          console.warn(`[Tasks API] Discord thread creation failed for task ${task.id}:`, err);
        });
    }

    console.log(
      `[Tasks API] Spawned ${interactive ? 'interactive' : 'standard'} ${harness} agent for task ${task.id}: ` +
      `session ${childSessionKey}`,
    );

    res.json({
      success: true,
      childSessionKey,
      runId,
      taskId: task.id,
      cronJob: spawnMetadata.cronJob || null,
      attachmentsWritten: attachmentAbsDir ? true : false,
      harness,
      interactive,
      provisional: spawnMetadata.provisional === true,
      ...(acpSessionKey ? { acpSessionKey } : {}),
      ...(discordThreadId ? { discordThreadId } : {}),
      ...(Object.keys(spawnMetadata).length > 0 ? { metadata: spawnMetadata } : {}),
    });
    } catch (err) {
      // Clean up attachment directory on error
      if (attachmentAbsDir) {
        await cleanupAttachments(attachmentAbsDir).catch(() => {});
      }
      console.error('[Tasks API] Error spawning agent:', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });
});

/**
 * POST /tasks/:id/steer
 * Send a steering message to a linked interactive session.
 * Requires executionMode='interactive' and acpSessionKey set on the task.
 */
router.post('/:id/steer', async (req: Request, res: Response): Promise<void> => {
  try {
    const task = await taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    const message = req.body?.message;
    if (!message || typeof message !== 'string') {
      res.status(400).json({ success: false, error: 'message is required' });
      return;
    }

    const harness = task.executionProfile?.harness || task.activeAgent?.harness || 'openclaw';

    // Resolve session key: prefer acpSessionKey, fall back to activeAgent.sessionKey
    const sessionKey = task.acpSessionKey || task.activeAgent?.sessionKey;
    if (!sessionKey) {
      res.status(400).json({
        success: false,
        error: 'No active session linked to this task. Spawn an interactive session first.',
      });
      return;
    }

    const executor = createTaskExecutor(harness as any, gatewayConnector);
    const workdir = await resolveTaskWorkingDirectory(task);
    const steerResult = await executor.steer({
      taskId: task.id,
      sessionKey,
      message,
      model: task.model || null,
      cwd: workdir,
    });

    const raw = steerResult.raw || {};
    if (harness === 'hermes' && (raw.pid || raw.sourceTag || raw.logPath)) {
      await taskManager.updateTask(task.id, {
        activeAgent: {
          ...(task.activeAgent || { name: task.executionMode === 'interactive' ? 'interactive-agent' : 'sub-agent', sessionKey }),
          sessionKey,
          harness,
          ...(typeof raw.pid === 'number' ? { pid: raw.pid as number } : {}),
          ...(typeof raw.sourceTag === 'string' ? { sourceTag: raw.sourceTag as string } : {}),
          ...(typeof raw.logPath === 'string' ? { logPath: raw.logPath as string } : {}),
        },
      });
    }

    await taskTimelineService.recordEvent({
      taskId: task.id,
      eventType: 'session.steered',
      title: 'Sent steering message',
      description: message.trim(),
      sessionKey,
      actor: 'user',
      harness,
      metadata: {
        sessionKey,
        acknowledged: steerResult.acknowledged,
        acknowledgedAt: steerResult.acknowledgedAt,
        acknowledgement: steerResult.acknowledgement,
        returnedSessionKey: steerResult.sessionKey,
        messagePreview: message.trim().slice(0, 500),
      },
    });

    console.log(`[Tasks API] Steered ${harness} session ${sessionKey} for task ${task.id}`);

    res.json({
      success: true,
      sent: steerResult.acknowledged,
      acknowledgedAt: steerResult.acknowledgedAt,
      acknowledgement: steerResult.acknowledgement,
      sessionKey,
      taskId: task.id,
      harness,
      ...(Object.keys(raw).length > 0 ? { metadata: raw } : {}),
    });
  } catch (err) {
    console.error('[Tasks API] Error steering session:', err);
    if (err instanceof Error && (err.name === 'HermesSessionStartingError' || (err as any).code === 'HERMES_SESSION_STARTING')) {
      // Expected transient condition, not a server fault: the Hermes session
      // id has not been linked to the task yet.
      res.status(409).json({
        success: false,
        error: err.message,
        code: 'HERMES_SESSION_STARTING',
      });
      return;
    }
    if (err instanceof Error && (err.name === 'HarnessSessionMismatchError' || (err as any).code === 'HARNESS_SESSION_MISMATCH')) {
      res.status(409).json({ success: false, error: err.message, code: 'HARNESS_SESSION_MISMATCH' });
      return;
    }
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * POST /tasks/:id/cancel
 * Kill the interactive session linked to this task.
 * Also resets task to 'stuck' so the orchestrator can review.
 */
router.post('/:id/cancel', async (req: Request, res: Response): Promise<void> => {
  try {
    const task = await taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    const harness = task.executionProfile?.harness || task.activeAgent?.harness || 'openclaw';

    const sessionKey = task.acpSessionKey || task.activeAgent?.sessionKey;
    if (!sessionKey) {
      res.status(400).json({
        success: false,
        error: 'No active session linked to this task.',
      });
      return;
    }

    const executor = createTaskExecutor(harness as any, gatewayConnector);
    const cancelResult = await executor.cancel({
      taskId: task.id,
      sessionKey,
      pid: getActiveAgentPid(task),
    });

    await taskTimelineService.recordEvent({
      taskId: task.id,
      // A rejected/failed cancellation must not be represented as a completed
      // cancellation in the durable audit stream. Timeline consumers classify
      // event types, not only the human-readable title.
      eventType: cancelResult.killed && cancelResult.acknowledged
        ? 'session.cancelled'
        : 'session.cancellation_failed',
      title: cancelResult.killed ? 'Cancelled task session' : 'Task session cancellation not acknowledged',
      description: cancelResult.killed
        ? 'The linked task session was cancelled and the task moved to stuck.'
        : 'The linked runtime did not acknowledge cancellation; task ownership was preserved.',
      sessionKey,
      actor: 'user',
      harness,
      metadata: {
        killed: cancelResult.killed,
        acknowledged: cancelResult.acknowledged,
        acknowledgedAt: cancelResult.acknowledgedAt,
        acknowledgement: cancelResult.acknowledgement,
        killError: cancelResult.killError || null,
      },
    });

    if (!cancelResult.killed || !cancelResult.acknowledged) {
      res.status(409).json({
        success: false,
        killed: false,
        sessionKey,
        taskId: task.id,
        harness,
        code: 'CANCELLATION_NOT_ACKNOWLEDGED',
        error: cancelResult.killError || 'The linked runtime did not acknowledge cancellation.',
        acknowledgedAt: cancelResult.acknowledgedAt,
        acknowledgement: cancelResult.acknowledgement,
      });
      return;
    }

    // Clear ownership only after the exact harness runtime acknowledged the
    // cancellation. A failed kill must never manufacture a stuck/no-session task.
    await taskManager.updateTask(task.id, {
      status: 'stuck',
      activeAgent: null,
      acpSessionKey: null,
      completedBy: task.activeAgent ? { ...task.activeAgent } : undefined,
      sessionRefs: mergeSessionRefs(task, sessionKey),
    });

    console.log(`[Tasks API] Cancelled ${harness} session ${sessionKey} for task ${task.id} (killed: ${cancelResult.killed})`);

    res.json({
      success: true,
      killed: true,
      acknowledgedAt: cancelResult.acknowledgedAt,
      acknowledgement: cancelResult.acknowledgement,
      sessionKey,
      taskId: task.id,
      harness,
      ...(cancelResult.raw ? { metadata: cancelResult.raw } : {}),
    });
  } catch (err) {
    console.error('[Tasks API] Error cancelling session:', err);
    if (err instanceof Error && (err.name === 'HarnessSessionMismatchError' || (err as any).code === 'HARNESS_SESSION_MISMATCH')) {
      res.status(409).json({ success: false, error: err.message, code: 'HARNESS_SESSION_MISMATCH' });
      return;
    }
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /tasks/:id/session-status
 * Return the ACP session state for a task.
 */
router.get('/:id/session-status', async (req: Request, res: Response): Promise<void> => {
  try {
    const task = await taskManager.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found' });
      return;
    }

    const sessionKey = task.acpSessionKey || task.activeAgent?.sessionKey;
    const harness = task.executionProfile?.harness
      || task.activeAgent?.harness
      || (typeof sessionKey === 'string' && sessionKey.startsWith('hermes:') ? 'hermes' : 'openclaw');
    const interactive = (task.executionMode || task.executionProfile?.mode) === 'interactive';
    const executor = createTaskExecutor(harness as any, gatewayConnector);
    const status = await executor.getSessionStatus({
      taskId: task.id,
      sessionKey: sessionKey || null,
      pid: getActiveAgentPid(task),
      model: task.model || null,
      interactive,
    });

    // Canonical task-attempt evidence is the shared orchestration contract.
    // Keep the executor status for backwards-compatible diagnostics, but do
    // not make the whole endpoint fail during a staged schema rollout.
    let canonicalRuntimeSignals: Awaited<ReturnType<typeof canonicalRuntimeSignalService.listTaskSignals>> = [];
    let canonicalRuntimeError: string | null = null;
    try {
      canonicalRuntimeSignals = await canonicalRuntimeSignalService.listTaskSignals(task.id);
    } catch (error) {
      canonicalRuntimeError = error instanceof Error ? error.message : 'canonical runtime lookup failed';
      console.warn(`[Tasks API] Canonical runtime lookup failed for ${task.id}: ${canonicalRuntimeError}`);
    }

    res.json({
      success: true,
      data: {
        taskId: task.id,
        sessionKey: sessionKey || null,
        acpSessionKey: task.acpSessionKey || null,
        executionMode: task.executionMode || task.executionProfile?.mode || null,
        executionProfile: task.executionProfile || null,
        startedAt: status.startedAt || task.startedAt || null,
        state: status.state,
        label: status.label || (task.activeAgent ? `Task: ${task.title}` : null),
        model: status.model || task.model || null,
        interactive,
        discordThreadId: task.discordThreadId || null,
        harness,
        canonicalRuntime: canonicalRuntimeSignals[0] || null,
        runtimeContract: {
          version: 'canonical-session-events-v1',
          available: canonicalRuntimeError === null,
          attemptCount: canonicalRuntimeSignals.length,
          ...(canonicalRuntimeError ? { reason: canonicalRuntimeError } : {}),
        },
        ...(status.reason ? { reason: status.reason } : {}),
        ...(status.raw ? { metadata: status.raw } : {}),
      },
    });
  } catch (err) {
    console.error('[Tasks API] Error getting session status:', err);
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
    if (err instanceof DependencyValidationError) {
      res.status(400).json({ success: false, error: err.message, code: err.code, offendingIds: err.offendingIds });
      return;
    }
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
    const { status, reviewNote, blockedReason } = req.body;

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
    const validatedRole = getRequestAutomationRole(req) === 'agent' ? 'agent' : 'orchestrator';

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
    if (rejectImplementationAgentOrchestratorAction(req, res, 'approve subtasks')) return;
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
    if (rejectImplementationAgentOrchestratorAction(req, res, 'reject subtasks')) return;
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
    if (rejectImplementationAgentOrchestratorAction(req, res, 'block subtasks')) return;
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
    if (rejectImplementationAgentOrchestratorAction(req, res, 'skip subtasks')) return;
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

// NOTE: GET /notifications moved above the '/:id' wildcard (route order) —
// see the /next route comment. POST routes below are safe: no bare POST /:id
// route exists, so these literal POST paths cannot be shadowed.

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
