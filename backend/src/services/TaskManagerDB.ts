// TaskManagerDB.ts - PostgreSQL-backed task management (replacement for JSON file)
import { EventEmitter } from 'events';
import { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { buildDiscordThreadUrl, resolveTaskDiscordThreadId } from '../utils/discordLinks';
import { notificationManager } from './NotificationManager';
import { taskHistoryService } from './TaskHistoryService';

// Re-export types from TaskManager for compatibility
export type TaskStatus = 'ideas' | 'todo' | 'in-progress' | 'review' | 'stuck' | 'completed' | 'archived';
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low' | 'someday';
export type TaskLinkType = 'project' | 'tool' | 'git' | 'doc' | 'memory' | 'session' | 'report';
export type TaskPlanningMode = 'fixed' | 'refine' | 'adaptive';

// Phase 4: 6-state subtask lifecycle
// empty       - Not started
// in_progress - Agent working on it
// review      - Awaiting orchestrator review
// blocked     - Cannot proceed, needs intervention
// skipped     - Intentionally skipped (counts as "done")
// completed   - Approved by orchestrator
export type SubtaskStatus = 'empty' | 'in_progress' | 'review' | 'blocked' | 'skipped' | 'completed';

// Valid statuses for different roles
export const AGENT_ALLOWED_STATUSES: SubtaskStatus[] = ['in_progress', 'review'];
export const ORCHESTRATOR_ALLOWED_STATUSES: SubtaskStatus[] = ['empty', 'in_progress', 'review', 'blocked', 'skipped', 'completed'];
// "Done" statuses for completion checks
export const DONE_STATUSES: SubtaskStatus[] = ['completed', 'skipped'];

// Disposition recorded when a task transitions into 'archived':
//   completed - the work was actually done (task was completed at archive time,
//               or every subtask ended completed/skipped)
//   abandoned - archived without the work being finished
export type ArchiveDisposition = 'completed' | 'abandoned';

export interface DashboardTaskSummary {
  ideas: number;
  todo: number;
  inProgress: number;
  stuck: number;
  completed: number;
  archived: number;
  recentCompleted: number;
  total: number;
}

/**
 * Typed dependency validation failure. Routes map this to HTTP 400 with a
 * machine-readable `code` and the offending ids, instead of the generic
 * 404/500 that plain Errors fall into.
 */
export type DependencyValidationCode = 'UNKNOWN_DEPENDENCY' | 'SELF_DEPENDENCY';

export class DependencyValidationError extends Error {
  readonly code: DependencyValidationCode;
  readonly offendingIds: string[];

  constructor(code: DependencyValidationCode, message: string, offendingIds: string[] = []) {
    super(message);
    this.name = 'DependencyValidationError';
    this.code = code;
    this.offendingIds = offendingIds;
  }
}

// ============================================================
// Dependency semantics — SINGLE SOURCE OF TRUTH
// (task af900dd2: dependency referential integrity)
// ============================================================

/**
 * A dependency blocks until its work is semantically satisfied. Archiving is
 * not completion: archived-abandoned/unknown parents remain fail-closed.
 * Any SQL that derives blocked-ness must mirror this predicate.
 */
export function dependencyBlocks(depStatus: string, archiveDisposition?: string | null): boolean {
  return !dependencySatisfied(depStatus, archiveDisposition);
}

/**
 * A dependency is semantically SATISFIED when its work actually happened:
 * status completed, or archived with archive_disposition = 'completed'.
 * This is also the inverse of dependencyBlocks so scheduler, board and doctor
 * cannot disagree about whether a child may advance.
 */
export function dependencySatisfied(depStatus: string, archiveDisposition?: string | null): boolean {
  return depStatus === 'completed' || (depStatus === 'archived' && archiveDisposition === 'completed');
}

/**
 * Heuristic for archive_disposition, applied both at archive time (updateTask)
 * and by migration 040's backfill of pre-existing archived rows:
 * 'completed' when the task was completed at archive time, or when every
 * subtask ended in a done state (completed/skipped); otherwise 'abandoned'.
 */
export function computeArchiveDisposition(
  previousStatus: string | null,
  subtasks: Array<{ status?: string | null }>
): ArchiveDisposition {
  if (previousStatus === 'completed') return 'completed';
  if (
    subtasks.length > 0 &&
    subtasks.every(s => s.status === 'completed' || s.status === 'skipped')
  ) {
    return 'completed';
  }
  return 'abandoned';
}

// ============================================================
// Unified archive policy — SINGLE SOURCE OF TRUTH
// (task 7d2a60a6: archiving is allowed from ANY status, through BOTH the
// dedicated POST /tasks/:id/archive endpoint and PATCH status->archived,
// with identical semantics: same disposition heuristic, same warning, same
// optional reason note.)
// ============================================================

/**
 * Warning surfaced when a task that never reached 'completed' is archived.
 * Embeds the disposition actually recorded — usually 'abandoned', but
 * 'completed' when every subtask ended done (see computeArchiveDisposition).
 * Returns undefined when the task was completed at archive time.
 */
export function archiveWarningForStatus(
  previousStatus: string | null,
  disposition: ArchiveDisposition
): string | undefined {
  if (previousStatus === 'completed') return undefined;
  return `archiving non-completed task (disposition: ${disposition})`;
}

/**
 * Note line appended to task notes when an archive carries a reason.
 * Identical format for both archive paths.
 */
export function archiveReasonNote(disposition: ArchiveDisposition, reason: string): string {
  return `Archived (${disposition}): ${reason}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Subtask {
  id: string;
  text: string;
  completed?: boolean; // Legacy field
  status: SubtaskStatus;
  reviewNote?: string;
  blockedReason?: string; // Why is this subtask blocked?
  completedAt?: string;
  sessionRef?: string;
}

export interface TaskLink {
  type: TaskLinkType;
  url: string;
  title: string;
  icon?: string;
}

export type TaskExecutionMode = 'main' | 'subagent' | 'interactive';
export type TaskExecutionHarness = 'openclaw' | 'hermes';
export type TaskAccessProfile = 'safe' | 'dev' | 'network' | 'homelab' | 'browser' | 'elevated';
export type TaskCapability = 'browser' | 'host-browser' | 'elevated' | 'network' | 'discord-thread' | 'long-running';

export interface TaskExecutionProfile {
  mode: TaskExecutionMode;
  harness?: TaskExecutionHarness;
  accessProfile: TaskAccessProfile;
  requiredCapabilities?: TaskCapability[];
  allowOverrideAtSpawn?: boolean;
  notes?: string;
  planningMode?: TaskPlanningMode;
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

export type ReviewDecision = 'running' | 'pass' | 'reject' | 'escalate';

export interface ReviewFinding {
  severity: 'info' | 'warning' | 'error';
  message: string;
  evidence?: string[];
}

export interface ReviewWorkspaceEvidence {
  workingDirectory?: string;
  gitBranch?: string;
  changedFiles?: string[];
  diffStat?: string;
  commandEvidence?: string[];
}

export interface ReviewHistoryEntry {
  id: string;
  decision: ReviewDecision;
  summary: string;
  triggeredBy: 'user' | 'agent' | 'system';
  createdAt: string;
  completedAt?: string;
  statusBefore?: TaskStatus;
  statusAfter?: TaskStatus;
  findings: ReviewFinding[];
  evidence: {
    successCriteria: string[];
    reports: Array<{ id: string; title: string; summary?: string | null }>;
    sessionRefs: string[];
    completedBy?: { name?: string; sessionKey?: string; harness?: TaskExecutionHarness } | null;
    workspace?: ReviewWorkspaceEvidence;
    testSignals?: string[];
  };
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
  // Set when status transitions into 'archived'; null for non-archived tasks
  archiveDisposition?: ArchiveDisposition | null;

  // Blocking
  blockedBy: string[];
  blockedReason?: string;
  
  // Task Dependencies
  dependsOn?: string[];
  blocked?: boolean;
  blockingTasks?: Array<{ id: string; title: string }>;
  dependentTasks?: Array<{ id: string; title: string }>;
  
  // Metadata
  project?: string;
  tags: string[];
  created: string;
  updated: string;
  
  // AI execution
  model?: string;
  executionMode?: TaskExecutionMode;
  executionProfile?: TaskExecutionProfile;
  activeAgent?: {
    name: string;
    sessionKey: string;
    harness?: TaskExecutionHarness;
    pid?: number;
    sourceTag?: string;
    logPath?: string;
  } | null;
  completedBy?: {
    name: string;
    sessionKey: string;
    harness?: TaskExecutionHarness;
    pid?: number;
    sourceTag?: string;
    logPath?: string;
  } | null;
  needsReview?: boolean;
  successCriteria?: string | string[];
  reviewHistory?: ReviewHistoryEntry[];
  maxRetries?: number;
  definitionOfDone?: string | string[];
  constraints?: string | string[];
  acpSessionKey?: string | null;  // ACP session key for interactive sessions
  discordThreadId?: string | null;  // Discord thread ID for interactive sessions (Phase 3)
  discordThreadUrl?: string | null;  // Guild-scoped link derived via utils/discordLinks (read-only)
  
  // Thinking level
  thinking?: 'low' | 'medium' | 'high';
  thinkingAutoEstimated?: boolean;
  attemptCount?: number;
  
  // Phase 1 Hub Redesign
  trackerUrl?: string;
  phaseTag?: string;
  taskResources?: TaskResources;
  
  // Agent persona type
  agentTypeId?: string | null;
  agentType?: { id: string; slug: string; name: string; color: string | null; category: string | null } | null;

  // Legacy fields
  parentId?: string | null;
  notes?: string;
  completed?: string | null;
}

export interface TaskFilters {
  status?: string;
  statuses?: string[];
  project?: string;
  projects?: string[];
  priority?: string;
  priorities?: string[];
  tag?: string;
  tags?: string[];
  parentId?: string | null;
  q?: string;
  limit?: number;
  offset?: number;
  excludeTaskId?: string;
  includeArchived?: boolean;
}

export interface TaskFilterOptions {
  tags: string[];
  projects: string[];
}

export interface BoardColumnResult {
  items: Task[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface BoardQueryResult {
  columns: Record<string, BoardColumnResult>;
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
   * Return dashboard lifecycle counts from the authoritative PostgreSQL board.
   * Archive membership is status-based; archived_at is transition metadata and
   * can be null on legacy rows without removing them from the archived bucket.
   */
  async getDashboardSummary(): Promise<DashboardTaskSummary> {
    const result = await this.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'ideas')::int AS ideas,
        COUNT(*) FILTER (WHERE status = 'todo')::int AS todo,
        COUNT(*) FILTER (WHERE status = 'in-progress')::int AS in_progress,
        COUNT(*) FILTER (WHERE status = 'stuck')::int AS stuck,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'archived')::int AS archived,
        COUNT(*) FILTER (
          WHERE status IN ('completed', 'archived')
            AND completed_at >= NOW() - INTERVAL '7 days'
        )::int AS recent_completed,
        COUNT(*)::int AS total
      FROM tasks
    `);
    const row = result.rows[0];
    return {
      ideas: row.ideas,
      todo: row.todo,
      inProgress: row.in_progress,
      stuck: row.stuck,
      completed: row.completed,
      archived: row.archived,
      recentCompleted: row.recent_completed,
      total: row.total,
    };
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
   * Resolve project name to UUID (for create/update)
   */
  private async resolveProjectId(nameOrId: string, client?: PoolClient): Promise<string | null> {
    const executor = client || this.pool;
    // Try as UUID first
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidPattern.test(nameOrId)) {
      return nameOrId;
    }
    // Look up by name
    const res = await executor.query('SELECT id FROM projects WHERE name = $1', [nameOrId]);
    return res.rows.length > 0 ? res.rows[0].id : null;
  }

  /**
   * Resolve project UUID to name (for reads)
   */
  private async resolveProjectName(projectId: string | null, client?: PoolClient): Promise<string | undefined> {
    if (!projectId) return undefined;
    const executor = client || this.pool;
    const res = await executor.query('SELECT name FROM projects WHERE id = $1', [projectId]);
    return res.rows.length > 0 ? res.rows[0].name : undefined;
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
      blockedReason: s.blocked_reason || undefined,
      completedAt: s.completed_at || undefined,
      // Legacy field for backward compat
      completed: s.status === 'completed' || s.status === 'skipped',
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
    const executionProfile = row.execution_profile || undefined;
    const successCriteria = row.success_criteria ?? undefined;
    const reviewHistory = row.review_history ?? undefined;
    const maxRetries = row.max_retries ?? undefined;
    const definitionOfDone = row.definition_of_done ?? undefined;
    const constraints = row.constraints ?? undefined;
    // active_agent / completed_by may come back as JSON strings on older schemas
    // or already-decoded objects on newer JSON/JSONB-backed schemas.
    const parseAgentRef = (value: any) => {
      if (!value) return null;
      if (typeof value === 'object') return value;
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return null;
    };

    const activeAgent = parseAgentRef(row.active_agent);
    const completedBy = parseAgentRef(row.completed_by);
    
    const taskResources = row.task_resources || undefined;

    const derivedAcpSessionKey = row.acp_session_key || (
      row.execution_mode === 'interactive' && activeAgent?.sessionKey && activeAgent.sessionKey !== 'pending'
        ? activeAgent.sessionKey
        : null
    );

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
      archiveDisposition: row.archive_disposition ?? null,
      blockedBy: [], // Computed from dependencies
      blockedReason: row.blocked_reason || undefined,
      dependsOn,
      project: await this.resolveProjectName(row.project_id, executor as any) || undefined,
      tags,
      created: row.created_at,
      updated: row.updated_at,
      model: row.model || undefined,
      executionMode: row.execution_mode || executionProfile?.mode || undefined,
      executionProfile,
      activeAgent,
      completedBy,
      needsReview: row.needs_review || false,
      successCriteria,
      reviewHistory,
      maxRetries,
      definitionOfDone,
      constraints,
      acpSessionKey: derivedAcpSessionKey,
      discordThreadId: resolveTaskDiscordThreadId({
        discordThreadId: row.discord_thread_id,
        acpSessionKey: derivedAcpSessionKey,
        activeAgentSessionKey: activeAgent?.sessionKey,
        completedBySessionKey: completedBy?.sessionKey,
      }),
      discordThreadUrl: buildDiscordThreadUrl(resolveTaskDiscordThreadId({
        discordThreadId: row.discord_thread_id,
        acpSessionKey: derivedAcpSessionKey,
        activeAgentSessionKey: activeAgent?.sessionKey,
        completedBySessionKey: completedBy?.sessionKey,
      })),
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
      agentTypeId: row.agent_type_id || null,
      agentType: row.agent_type_id ? {
        id: row.agent_type_id,
        slug: row.at_slug || null,
        name: row.at_name || null,
        color: row.at_color || null,
        category: row.at_category || null,
      } : null,
    };

    return task;
  }

  /**
   * Add lightweight dependency metadata used by task board cards.
   * hydrateTask() deliberately only returns dependency IDs; without this pass the
   * board UI cannot distinguish ready todo tasks from dependency-locked tasks.
   */
  private async addDependencyMeta(tasks: Task[]): Promise<Task[]> {
    if (tasks.length === 0) return tasks;

    const taskIds = tasks.map(task => task.id);
    const byId = new Map(tasks.map(task => [task.id, task]));

    const blockingRes = await this.pool.query(
      `SELECT d.task_id,
              dep.id,
              dep.title,
              dep.status,
              dep.archive_disposition
       FROM task_dependencies d
       JOIN tasks dep ON dep.id = d.depends_on_task_id
       WHERE d.task_id = ANY($1::uuid[])
       ORDER BY dep.created_at ASC`,
      [taskIds]
    );

    const dependentRes = await this.pool.query(
      `SELECT d.depends_on_task_id AS task_id,
              child.id,
              child.title,
              child.status
       FROM task_dependencies d
       JOIN tasks child ON child.id = d.task_id
       WHERE d.depends_on_task_id = ANY($1::uuid[])
       ORDER BY child.created_at ASC`,
      [taskIds]
    );

    for (const task of tasks) {
      task.blockingTasks = [];
      task.dependentTasks = [];
      task.blocked = false;
    }

    for (const row of blockingRes.rows) {
      const task = byId.get(row.task_id);
      if (!task) continue;
      if (dependencyBlocks(row.status, row.archive_disposition)) {
        task.blockingTasks!.push({ id: row.id, title: row.title });
        task.blocked = true;
      }
    }

    for (const row of dependentRes.rows) {
      const task = byId.get(row.task_id);
      if (!task) continue;
      task.dependentTasks!.push({ id: row.id, title: row.title });
    }

    return tasks;
  }

  /**
   * Query tasks with filters
   */
  private async buildTaskWhere(filters: TaskFilters = {}): Promise<{ conditions: string[]; params: any[]; orderClause: string; filterParamCount: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;
    let orderClause = 'ORDER BY t.created_at DESC';

    if (filters.statuses && filters.statuses.length > 0) {
      conditions.push(`t.status = ANY($${paramIndex++})`);
      params.push(filters.statuses);
    } else if (filters.status) {
      conditions.push(`t.status = $${paramIndex++}`);
      params.push(filters.status);
    } else if (!filters.includeArchived) {
      conditions.push(`t.status <> 'archived'`);
    }

    if (filters.projects && filters.projects.length > 0) {
      const resolvedProjectIds = (await Promise.all(filters.projects.map(p => this.resolveProjectId(p)))).filter(Boolean);
      if (resolvedProjectIds.length > 0) {
        conditions.push(`t.project_id = ANY($${paramIndex++})`);
        params.push(resolvedProjectIds);
      } else {
        conditions.push('FALSE');
      }
    } else if (filters.project) {
      const projId = await this.resolveProjectId(filters.project);
      if (projId) {
        conditions.push(`t.project_id = $${paramIndex++}`);
        params.push(projId);
      } else {
        conditions.push('FALSE');
      }
    }

    if (filters.priorities && filters.priorities.length > 0) {
      conditions.push(`t.priority = ANY($${paramIndex++})`);
      params.push(filters.priorities);
    } else if (filters.priority) {
      conditions.push(`t.priority = $${paramIndex++}`);
      params.push(filters.priority);
    }

    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`t.id IN (SELECT task_id FROM task_tags WHERE tag = ANY($${paramIndex++}))`);
      params.push(filters.tags);
    } else if (filters.tag) {
      conditions.push(`t.id IN (SELECT task_id FROM task_tags WHERE tag = $${paramIndex++})`);
      params.push(filters.tag);
    }

    if (filters.parentId !== undefined) {
      if (filters.parentId === null) {
        conditions.push(`t.parent_id IS NULL`);
      } else {
        conditions.push(`t.parent_id = $${paramIndex++}`);
        params.push(filters.parentId);
      }
    }

    let filterParamCount = params.length;

    const searchQuery = filters.q?.trim();
    if (searchQuery) {
      const normalizedSearch = searchQuery.replace(/-/g, '').toLowerCase();
      conditions.push(`(
        t.title ILIKE $${paramIndex}
        OR t.description ILIKE $${paramIndex}
        OR t.id::text ILIKE $${paramIndex}
        OR REPLACE(LOWER(t.id::text), '-', '') LIKE $${paramIndex + 1}
        OR p.name ILIKE $${paramIndex}
      )`);
      params.push(`%${searchQuery}%`, `%${normalizedSearch}%`);
      paramIndex += 2;

      const exactIdParam = `$${paramIndex++}`;
      const exactCompactIdParam = `$${paramIndex++}`;
      const exactShortIdParam = `$${paramIndex++}`;
      const exactTitleParam = `$${paramIndex++}`;
      const titlePrefixParam = `$${paramIndex++}`;
      const titleContainsParam = `$${paramIndex++}`;
      const projectPrefixParam = `$${paramIndex++}`;
      params.push(
        searchQuery.toLowerCase(),
        normalizedSearch,
        normalizedSearch.slice(0, 8),
        searchQuery.toLowerCase(),
        `${searchQuery.toLowerCase()}%`,
        `%${searchQuery.toLowerCase()}%`,
        `${searchQuery.toLowerCase()}%`
      );

      orderClause = `ORDER BY
        CASE
          WHEN LOWER(t.id::text) = ${exactIdParam} OR REPLACE(LOWER(t.id::text), '-', '') = ${exactCompactIdParam} THEN 0
          WHEN LEFT(REPLACE(LOWER(t.id::text), '-', ''), 8) = ${exactShortIdParam} THEN 1
          WHEN LOWER(t.title) = ${exactTitleParam} THEN 2
          WHEN LOWER(t.title) LIKE ${titlePrefixParam} THEN 3
          WHEN LOWER(t.title) LIKE ${titleContainsParam} THEN 4
          WHEN LOWER(COALESCE(p.name, '')) LIKE ${projectPrefixParam} THEN 5
          ELSE 6
        END,
        t.updated_at DESC,
        t.created_at DESC`;
    }

    filterParamCount = searchQuery ? params.length - 7 : params.length;

    if (filters.excludeTaskId) {
      conditions.push(`t.id <> $${paramIndex++}`);
      params.push(filters.excludeTaskId);
    }

    if (filters.excludeTaskId) {
      filterParamCount = params.length;
    }

    return { conditions, params, orderClause, filterParamCount };
  }

  /**
   * Query tasks with filters
   */
  async queryTasks(filters: TaskFilters = {}): Promise<Task[]> {
    const { conditions, params, orderClause } = await this.buildTaskWhere(filters);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filters.limit && filters.limit > 0 ? `LIMIT ${Math.min(filters.limit, 100)}` : '';
    const offsetClause = filters.offset && filters.offset > 0 ? `OFFSET ${Math.max(filters.offset, 0)}` : '';

    const query = `
      SELECT t.*,
        at.slug AS at_slug, at.name AS at_name, at.color AS at_color, at.category AS at_category
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN agent_types at ON at.id = t.agent_type_id
      ${whereClause}
      ${orderClause}
      ${limitClause}
      ${offsetClause}
    `;

    const result = await this.pool.query(query, params);

    const tasks = await Promise.all(
      result.rows.map(row => this.hydrateTask(row))
    );

    return tasks;
  }

  async getTaskFilterOptions(includeArchived = true): Promise<TaskFilterOptions> {
    const taskScope = includeArchived ? '' : "WHERE t.status <> 'archived'";
    const [tagsRes, projectsRes] = await Promise.all([
      this.pool.query(
        `SELECT DISTINCT tt.tag
         FROM task_tags tt
         JOIN tasks t ON t.id = tt.task_id
         ${taskScope}
         ORDER BY tt.tag ASC`
      ),
      this.pool.query(
        `SELECT DISTINCT p.name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         ${taskScope}
         ORDER BY p.name ASC`
      ),
    ]);

    return {
      tags: tagsRes.rows.map((row: any) => row.tag),
      projects: projectsRes.rows.map((row: any) => row.name),
    };
  }

  async queryBoardColumns(statuses: string[], baseFilters: Omit<TaskFilters, 'status' | 'statuses' | 'limit' | 'offset'> = {}, perColumn = 6, offsets: Record<string, number> = {}): Promise<BoardQueryResult> {
    const columns: Record<string, BoardColumnResult> = {};

    for (const status of statuses) {
      const statusFilters: TaskFilters = {
        ...baseFilters,
        statuses: status === 'stuck' ? ['stuck', 'review'] : [status],
        includeArchived: baseFilters.includeArchived ?? status === 'archived',
      };

      const { conditions, params, orderClause, filterParamCount } = await this.buildTaskWhere(statusFilters);
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const offset = Math.max(offsets[status] || 0, 0);
      const limit = Math.min(Math.max(perColumn, 1), 100);

      const countQuery = `
        SELECT COUNT(*)::int AS total
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        ${whereClause}
      `;

      const dataQuery = `
        SELECT t.*, at.slug AS at_slug, at.name AS at_name, at.color AS at_color, at.category AS at_category
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN agent_types at ON at.id = t.agent_type_id
        ${whereClause}
        ${orderClause}
        LIMIT ${limit}
        OFFSET ${offset}
      `;

      const countParams = params.slice(0, filterParamCount);
      const [countRes, dataRes] = await Promise.all([
        this.pool.query(countQuery, countParams),
        this.pool.query(dataQuery, params),
      ]);

      const hydratedItems = await Promise.all(dataRes.rows.map(row => this.hydrateTask(row)));
      const items = await this.addDependencyMeta(hydratedItems);
      const total = Number(countRes.rows[0]?.total || 0);

      columns[status] = {
        items,
        total,
        offset,
        limit,
        hasMore: offset + items.length < total,
      };
    }

    return { columns };
  }

  /**
   * Get a single task by ID
   */
  async getTask(id: string): Promise<Task | undefined> {
    const result = await this.pool.query(
      `SELECT t.*, at.slug AS at_slug, at.name AS at_name, at.color AS at_color, at.category AS at_category
       FROM tasks t LEFT JOIN agent_types at ON at.id = t.agent_type_id WHERE t.id = $1`,
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

      // Validate dependencies before creating. The task has no id yet, so
      // there is no self/circular dependency to check — only referential
      // integrity. (Previously this passed dependsOn[0] as the "current task
      // id", which made every create-with-dependencies trip the
      // self-dependency check.)
      if (data.dependsOn && data.dependsOn.length > 0) {
        await this.validateDependencies(data.dependsOn, undefined, client);
      }

      // Resolve thinking level
      const thinking = this.resolveThinking(data);

      // Insert task
      const taskResult = await client.query(
        `INSERT INTO tasks (
          title, description, status, priority, project_id,
          thinking_budget, thinking_auto_estimated, model, execution_mode,
          execution_profile, success_criteria, review_history, max_retries, definition_of_done, constraints, auto_created, auto_start, blocked_reason, status_reason,
          active_agent, completed_by, attempt_count, session_refs,
          parent_id, agent_type_id, created_at, updated_at, started_at, completed_at, archived_at, archive_disposition
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31
        ) RETURNING *`,
        [
          data.title || 'Untitled Task',
          data.description || '',
          data.status || 'todo',
          data.priority || 'normal',
          data.project ? await this.resolveProjectId(data.project, client) : null,
          thinking.thinking,
          thinking.thinkingAutoEstimated,
          data.model || null,
          data.executionMode || data.executionProfile?.mode || null,
          data.executionProfile ? JSON.stringify(data.executionProfile) : null,
          data.successCriteria !== undefined ? JSON.stringify(data.successCriteria) : null,
          data.reviewHistory !== undefined ? JSON.stringify(data.reviewHistory) : '[]',
          data.maxRetries ?? 3,
          data.definitionOfDone !== undefined ? JSON.stringify(data.definitionOfDone) : null,
          data.constraints !== undefined ? JSON.stringify(data.constraints) : null,
          data.autoCreated !== undefined ? data.autoCreated : false,
          // Lifecycle gate: autoStart defaults FALSE (explicit opt-in only).
          // Previously defaulted true for any non-ideas status, which made the
          // orchestration loop auto-pick freshly created tasks unattended.
          data.autoStart !== undefined ? data.autoStart : false,
          data.blockedReason || null,
          null, // status_reason
          data.activeAgent ? JSON.stringify(data.activeAgent) : null,
          data.completedBy ? JSON.stringify(data.completedBy) : null,
          data.attemptCount || 0,
          data.sessionRefs ? JSON.stringify(data.sessionRefs) : '[]',
          data.parentId || null,
          (data as any).agentTypeId || null,
          now,
          now,
          data.status === 'in-progress' ? now : data.startedAt || null,
          data.status === 'completed' ? now : data.completedAt || null,
          data.status === 'archived' ? now : data.archivedAt || null,
          // Direct create in archived status is rare, but record a disposition
          // so the row never ends up archived-with-NULL-disposition.
          data.status === 'archived' ? computeArchiveDisposition(null, data.subtasks || []) : null,
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
            [taskId, i, s.text, s.status || 'empty', s.reviewNote || null, s.completedAt || null]
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
   * Update an existing task.
   *
   * `archiveReason` (not a Task field) is only honored on a transition INTO
   * 'archived': it is appended to task notes as
   * "Archived (<disposition>): <reason>". Both archive paths (PATCH
   * status->archived with body field archiveReason, and archiveTask() below)
   * funnel through here, so the semantics are identical by construction.
   */
  async updateTask(id: string, updates: Partial<Task> & { archiveReason?: string }): Promise<Task> {
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
        // Status moves preserve the task's autoStart setting (Wadera 2026-07-04):
        // arming auto-pickup is always an explicit action, never a side effect.
        if (updates.status === 'in-progress' && !current.started_at) {
          statusUpdates.started_at = now;
        }
        if (updates.status === 'completed' && !current.completed_at) {
          statusUpdates.completed_at = now;
        }
        if (updates.status === 'archived' && !current.archived_at) {
          statusUpdates.archived_at = now;
        }
        // Archive disposition: recorded on every transition INTO archived,
        // cleared when a task is un-archived (so a later re-archive recomputes
        // it from the then-current state). Heuristic: completed at archive
        // time, or all subtasks done → 'completed'; otherwise 'abandoned'.
        if (updates.status === 'archived' && oldStatus !== 'archived') {
          const subRes = await client.query(
            'SELECT status FROM subtasks WHERE task_id = $1',
            [id]
          );
          statusUpdates.archive_disposition = computeArchiveDisposition(oldStatus, subRes.rows);
          // Unified archive policy (task 7d2a60a6): optional reason is
          // appended to task notes so the "why" survives the archive.
          const reason = typeof updates.archiveReason === 'string' ? updates.archiveReason.trim() : '';
          if (reason) {
            const line = archiveReasonNote(statusUpdates.archive_disposition, reason);
            statusUpdates.notes = current.notes ? `${current.notes}\n${line}` : line;
          }
        }
        // Generic notes updates: persist when explicitly provided (the notes
        // column exists since migration 041; before that these were dropped).
        if (typeof updates.notes === 'string' && statusUpdates.notes === undefined) {
          statusUpdates.notes = updates.notes;
        }
 else if (oldStatus === 'archived' && updates.status !== 'archived') {
          statusUpdates.archive_disposition = null;
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
      if (updates.project !== undefined) addField('project_id', updates.project ? await this.resolveProjectId(updates.project, client) : null);
      if (updates.thinking !== undefined) addField('thinking_budget', updates.thinking);
      if (updates.thinkingAutoEstimated !== undefined) addField('thinking_auto_estimated', updates.thinkingAutoEstimated);
      if (updates.model !== undefined) addField('model', updates.model);
      if (updates.executionMode !== undefined) addField('execution_mode', updates.executionMode);
      if ((updates as any).executionProfile !== undefined) addField('execution_profile', (updates as any).executionProfile ? JSON.stringify((updates as any).executionProfile) : null);
      if (updates.successCriteria !== undefined) addField('success_criteria', updates.successCriteria !== null ? JSON.stringify(updates.successCriteria) : null);
      if (updates.reviewHistory !== undefined) addField('review_history', updates.reviewHistory !== null ? JSON.stringify(updates.reviewHistory) : null);
      if (updates.maxRetries !== undefined) addField('max_retries', updates.maxRetries);
      if (updates.needsReview !== undefined) addField('needs_review', updates.needsReview);
      if ((updates as any).definitionOfDone !== undefined) addField('definition_of_done', (updates as any).definitionOfDone !== null ? JSON.stringify((updates as any).definitionOfDone) : null);
      if ((updates as any).constraints !== undefined) addField('constraints', (updates as any).constraints !== null ? JSON.stringify((updates as any).constraints) : null);
      if (updates.autoCreated !== undefined) addField('auto_created', updates.autoCreated);
      if (updates.autoStart !== undefined) addField('auto_start', updates.autoStart);
      if (updates.blockedReason !== undefined) addField('blocked_reason', updates.blockedReason);
      if (updates.notes !== undefined && statusUpdates.notes === undefined) addField('notes', updates.notes);
      if (updates.activeAgent !== undefined) addField('active_agent', updates.activeAgent ? JSON.stringify(updates.activeAgent) : null);
      if (updates.completedBy !== undefined) addField('completed_by', updates.completedBy ? JSON.stringify(updates.completedBy) : null);
      if (updates.acpSessionKey !== undefined) addField('acp_session_key', updates.acpSessionKey || null);
      if (updates.discordThreadId !== undefined) addField('discord_thread_id', updates.discordThreadId || null);
      if (updates.attemptCount !== undefined) addField('attempt_count', updates.attemptCount);
      if (updates.sessionRefs !== undefined) addField('session_refs', JSON.stringify(updates.sessionRefs));
      if (updates.parentId !== undefined) addField('parent_id', updates.parentId);
      if ((updates as any).agentTypeId !== undefined) addField('agent_type_id', (updates as any).agentTypeId || null);
      if (updates.lastChecked !== undefined) addField('last_checked', updates.lastChecked);
      if (statusUpdates.started_at) addField('started_at', statusUpdates.started_at);
      if (statusUpdates.completed_at) addField('completed_at', statusUpdates.completed_at);
      if (statusUpdates.archived_at) addField('archived_at', statusUpdates.archived_at);
      if (statusUpdates.archive_disposition !== undefined) addField('archive_disposition', statusUpdates.archive_disposition);
      if (statusUpdates.notes !== undefined) addField('notes', statusUpdates.notes);

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
            [id, i, s.text, s.status || 'empty', s.reviewNote || null, s.completedAt || null]
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
   * Archive a task from ANY status (unified archive policy, task 7d2a60a6).
   *
   * Same semantics as PATCH status->archived: disposition computed by
   * computeArchiveDisposition inside updateTask; optional reason appended to
   * task notes as "Archived (<disposition>): <reason>"; a warning is returned
   * when the task was not completed at archive time. Archiving an
   * already-archived task is an idempotent no-op that preserves the existing
   * disposition (the reason, if any, is ignored).
   */
  async archiveTask(
    id: string,
    options: { reason?: string } = {}
  ): Promise<{
    success: boolean;
    archived: boolean;
    disposition: ArchiveDisposition | null;
    warning?: string;
    task: Task;
  }> {
    const task = await this.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    const oldStatus = task.status;
    if (oldStatus === 'archived') {
      return { success: true, archived: true, disposition: task.archiveDisposition ?? null, task };
    }

    const updated = await this.updateTask(id, {
      status: 'archived' as TaskStatus,
      archiveReason: options.reason,
    });
    const disposition = (updated.archiveDisposition ?? 'abandoned') as ArchiveDisposition;

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

    console.log('[TaskManagerDB] Archived task:', id, `(disposition: ${disposition})`);
    const warning = archiveWarningForStatus(oldStatus, disposition);
    return {
      success: true,
      archived: true,
      disposition,
      ...(warning ? { warning } : {}),
      task: updated,
    };
  }

  /**
   * Auto-pickup queue: tasks that are eligible for unattended orchestrator
   * pickup. Lifecycle gate — autoStart is honored ONLY for status 'todo'
   * (the queryTasks filter below), and only when explicitly true, and only
   * when the task is not blocked by dependencies. Sorted by priority, then
   * creation time (FIFO within a priority).
   */
  async getAutoStartQueue(): Promise<Task[]> {
    const todoTasks = await this.queryTasks({ status: 'todo' });

    const priorityOrder: Record<string, number> = {
      urgent: 0, high: 1, normal: 2, low: 3, someday: 4
    };

    // Filter out blocked tasks (async check against DB)
    const autoStartTasks: Task[] = [];
    for (const t of todoTasks) {
      if (t.autoStart === true) {
        const blocked = await this.isTaskBlocked(t.id);
        if (!blocked) {
          autoStartTasks.push(t);
        }
      }
    }

    autoStartTasks.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 99;
      const pb = priorityOrder[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return new Date(a.created).getTime() - new Date(b.created).getTime();
    });

    return autoStartTasks;
  }

  /**
   * Get next task to work on (todo + autoStart + not blocked by dependencies)
   */
  async getNextTask(): Promise<Task | null> {
    const queue = await this.getAutoStartQueue();
    return queue[0] || null;
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
   * Update subtask status with role-based permission enforcement
   * 
   * Agent permissions:
   *   - CAN set: in_progress, review
   *   - CANNOT set: completed, skipped, blocked, empty
   * 
   * Orchestrator permissions:
   *   - CAN set: any status
   */
  async updateSubtaskStatus(
    taskId: string,
    subtaskIndex: number,
    newStatus: SubtaskStatus,
    role: 'agent' | 'orchestrator' = 'orchestrator',
    reviewNote?: string,
    blockedReason?: string
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

    // Permission checks for agents
    if (role === 'agent') {
      if (!AGENT_ALLOWED_STATUSES.includes(newStatus)) {
        throw new Error(`Agents cannot set subtask status to '${newStatus}'. Allowed: ${AGENT_ALLOWED_STATUSES.join(', ')}`);
      }
      // Agents cannot modify completed/skipped subtasks
      if (DONE_STATUSES.includes(currentStatus)) {
        throw new Error(`Cannot change status of ${currentStatus} subtasks`);
      }
      // Agents cannot modify blocked subtasks (orchestrator must unblock)
      if (currentStatus === 'blocked') {
        throw new Error('Cannot modify blocked subtask. Orchestrator must unblock first.');
      }
    }

    const now = new Date().toISOString();

    // Determine completed_at: set when status becomes completed, clear otherwise
    const completedAt = newStatus === 'completed' ? now : null;

    // Update in database
    await this.pool.query(
      `UPDATE subtasks
       SET status = $1, note = $2, blocked_reason = $3, completed_at = $4, updated_at = $5
       WHERE task_id = $6 AND index = $7`,
      [
        newStatus,
        reviewNote || subtask.reviewNote || null,
        newStatus === 'blocked' ? (blockedReason || null) : null,
        completedAt,
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

    console.log(`[TaskManagerDB] Subtask ${subtaskIndex} of task ${taskId} changed from '${currentStatus}' to '${newStatus}' by ${role}`);
    return updatedTask;
  }

  async markSubtaskInReview(taskId: string, subtaskIndex: number, reviewNote?: string): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'review', 'agent', reviewNote);
  }

  async markSubtaskInProgress(taskId: string, subtaskIndex: number): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'in_progress', 'agent');
  }

  async approveSubtask(taskId: string, subtaskIndex: number): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'completed', 'orchestrator');
  }

  async rejectSubtask(taskId: string, subtaskIndex: number, note?: string): Promise<Task> {
    const task = await this.updateSubtaskStatus(taskId, subtaskIndex, 'empty', 'orchestrator');
    if (note && task.subtasks && task.subtasks[subtaskIndex]) {
      task.subtasks[subtaskIndex].reviewNote = `REJECTED: ${note}`;
      await this.pool.query(
        'UPDATE subtasks SET note = $1 WHERE task_id = $2 AND index = $3',
        [`REJECTED: ${note}`, taskId, subtaskIndex]
      );
    }
    return task;
  }

  async blockSubtask(taskId: string, subtaskIndex: number, reason?: string): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'blocked', 'orchestrator', undefined, reason);
  }

  async skipSubtask(taskId: string, subtaskIndex: number): Promise<Task> {
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'skipped', 'orchestrator');
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
    return this.updateSubtaskStatus(taskId, subtaskIndex, 'empty', 'orchestrator');
  }

  allSubtasksCompleted(_id: string): boolean {
    // This is a sync method in the original, but we need async for DB
    // For now, throw error - callers should use async version
    throw new Error('Use allSubtasksCompletedAsync instead');
  }

  /**
   * Check if all subtasks are in a "done" state (completed or skipped)
   */
  async allSubtasksCompletedAsync(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task || !task.subtasks || task.subtasks.length === 0) {
      return true;
    }
    return task.subtasks.every(s => DONE_STATUSES.includes(s.status));
  }

  /**
   * Check if any subtask is blocked
   */
  async hasBlockedSubtasks(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task || !task.subtasks) {
      return false;
    }
    return task.subtasks.some(s => s.status === 'blocked');
  }

  getSubtaskSummary(_id: string): { total: number; empty: number; in_progress: number; review: number; blocked: number; skipped: number; completed: number } {
    // Sync method - throw error
    throw new Error('Use getSubtaskSummaryAsync instead');
  }

  async getSubtaskSummaryAsync(taskId: string): Promise<{ total: number; empty: number; in_progress: number; review: number; blocked: number; skipped: number; completed: number }> {
    const task = await this.getTask(taskId);
    if (!task || !task.subtasks) {
      return { total: 0, empty: 0, in_progress: 0, review: 0, blocked: 0, skipped: 0, completed: 0 };
    }
    return {
      total: task.subtasks.length,
      empty: task.subtasks.filter(s => s.status === 'empty').length,
      in_progress: task.subtasks.filter(s => s.status === 'in_progress').length,
      review: task.subtasks.filter(s => s.status === 'review').length,
      blocked: task.subtasks.filter(s => s.status === 'blocked').length,
      skipped: task.subtasks.filter(s => s.status === 'skipped').length,
      completed: task.subtasks.filter(s => s.status === 'completed').length,
    };
  }

  // ============================================================
  // Task Dependency Management
  // ============================================================

  /**
   * Referential integrity for dependsOn: every id must reference an existing
   * task (any status, archived included) and none may be the task itself.
   * Throws DependencyValidationError (mapped to HTTP 400 by the routes)
   * listing ALL offending ids, not just the first.
   */
  private async validateDependencies(dependsOn: string[] | undefined, currentTaskId?: string, client?: PoolClient): Promise<void> {
    if (!dependsOn || dependsOn.length === 0) return;

    const executor = client || this.pool;

    const selfDeps = currentTaskId ? dependsOn.filter(depId => depId === currentTaskId) : [];
    if (selfDeps.length > 0) {
      throw new DependencyValidationError('SELF_DEPENDENCY', 'Task cannot depend on itself', selfDeps);
    }

    // Malformed ids can never reference a task, and would make the uuid cast
    // below throw a 22P02 (→ opaque 500) — treat them as unknown up front.
    const malformed = dependsOn.filter(depId => typeof depId !== 'string' || !UUID_RE.test(depId));
    const candidates = dependsOn.filter(depId => typeof depId === 'string' && UUID_RE.test(depId));

    let missing: string[] = [...malformed];
    if (candidates.length > 0) {
      const result = await executor.query(
        'SELECT id FROM tasks WHERE id = ANY($1::uuid[])',
        [candidates]
      );
      const found = new Set(result.rows.map((r: any) => r.id));
      missing = missing.concat(candidates.filter(depId => !found.has(depId)));
    }

    if (missing.length > 0) {
      throw new DependencyValidationError(
        'UNKNOWN_DEPENDENCY',
        `Unknown dependency task id(s): ${missing.join(', ')}`,
        missing
      );
    }
  }

  private async hasCircularDependency(taskId: string, depId: string, visited = new Set<string>(), client?: PoolClient): Promise<boolean> {
    // Walk the dependency chain from depId. If we ever reach taskId, adding
    // taskId→depId would create a cycle.  `visited` tracks depIds we've
    // already expanded so we don't loop on existing (non-taskId) cycles.
    if (visited.has(depId)) {
      return false; // already explored this node, no cycle found
    }
    
    visited.add(depId);
    const executor = client || this.pool;
    
    // Follow the dependency chain from depId: what does depId depend on?
    const result = await executor.query(
      'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $1',
      [depId]
    );
    
    for (const row of result.rows) {
      const nextDep = row.depends_on_task_id;
      if (nextDep === taskId) {
        return true; // cycle: depId depends on something that eventually reaches taskId
      }
      if (await this.hasCircularDependency(taskId, nextDep, visited, client)) {
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
      // Missing deps (deleted rows) are prevented by the foreign key and are
      // still surfaced by doctor if historical drift exists.
      if (depTask && dependencyBlocks(depTask.status, depTask.archiveDisposition)) {
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

  /**
   * Get full dependency info for a task (both directions)
   */
  async getTaskDependencies(taskId: string): Promise<{ dependsOn: Task[]; blockedBy: Task[] }> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // dependsOn: tasks this task depends on (all, regardless of status)
    const dependsOnTasks: Task[] = [];
    if (task.dependsOn && task.dependsOn.length > 0) {
      for (const depId of task.dependsOn) {
        const depTask = await this.getTask(depId);
        if (depTask) {
          dependsOnTasks.push(depTask);
        }
      }
    }

    // blockedBy: tasks that depend on this task (reverse direction)
    const dependentTasks = await this.getDependentTasks(taskId);

    return { dependsOn: dependsOnTasks, blockedBy: dependentTasks };
  }

  /**
   * Add a single dependency (taskId depends on dependsOnId)
   */
  async addDependency(taskId: string, dependsOnId: string): Promise<void> {
    // Validate the parent task exists (missing parent → 404 at the route)
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Referential integrity + self-reference (typed → 400 at the route)
    await this.validateDependencies([dependsOnId], taskId);

    // Check for circular dependency
    if (await this.hasCircularDependency(taskId, dependsOnId, new Set())) {
      throw new Error(`Circular dependency detected: ${taskId} -> ${dependsOnId}`);
    }

    // Check if already exists
    const existing = await this.pool.query(
      'SELECT 1 FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2',
      [taskId, dependsOnId]
    );
    if (existing.rows.length > 0) {
      throw new Error(`Dependency already exists: ${taskId} -> ${dependsOnId}`);
    }

    await this.pool.query(
      'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)',
      [taskId, dependsOnId]
    );

    // Update task's updated_at
    await this.pool.query(
      'UPDATE tasks SET updated_at = $1 WHERE id = $2',
      [new Date().toISOString(), taskId]
    );

    console.log(`[TaskManagerDB] Added dependency: ${taskId} depends on ${dependsOnId}`);
  }

  /**
   * Remove a single dependency
   */
  async removeDependency(taskId: string, dependsOnId: string): Promise<void> {
    const result = await this.pool.query(
      'DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2',
      [taskId, dependsOnId]
    );

    if (result.rowCount === 0) {
      throw new Error(`Dependency not found: ${taskId} -> ${dependsOnId}`);
    }

    // Update task's updated_at
    await this.pool.query(
      'UPDATE tasks SET updated_at = $1 WHERE id = $2',
      [new Date().toISOString(), taskId]
    );

    console.log(`[TaskManagerDB] Removed dependency: ${taskId} no longer depends on ${dependsOnId}`);
  }

  /**
   * Get all tasks that are blocked by unmet dependencies (for clawbeat)
   */
  async getBlockedTasks(): Promise<Task[]> {
    // Find all tasks that have at least one semantically unsatisfied dependency.
    // NOTE: the WHERE clause below is the SQL mirror of dependencyBlocks() —
    // keep the two in sync (see the helper's doc comment for the semantics).
    const result = await this.pool.query(`
      SELECT DISTINCT td.task_id
      FROM task_dependencies td
      JOIN tasks dep ON dep.id = td.depends_on_task_id
      JOIN tasks t ON t.id = td.task_id
      WHERE NOT (
        dep.status = 'completed'
        OR (dep.status = 'archived' AND dep.archive_disposition = 'completed')
      )
        AND t.status NOT IN ('completed', 'archived')
    `);

    const blocked: Task[] = [];
    for (const row of result.rows) {
      const task = await this.getTask(row.task_id);
      if (task) {
        blocked.push(task);
      }
    }

    return blocked;
  }

  async isTaskBlocked(id: string): Promise<boolean> {
    const blocking = await this.getBlockingTasks(id);
    return blocking.length > 0;
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
