import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/connection';

export type LeaseHarness = 'hermes' | 'openclaw';

export interface ClaimTaskInput {
  taskId: string;
  snapshotUpdatedAt: string;
  harness: LeaseHarness;
  resourceKey: string;
  sessionKey?: string;
  ttlSeconds?: number;
  metadata?: Record<string, unknown>;
}

export interface TaskExecutionLease {
  id: string;
  taskId: string;
  resourceKey: string;
  harness: LeaseHarness;
  sessionKey?: string;
  status: 'active' | 'released' | 'expired' | 'failed';
  acquiredAt: string;
  expiresAt: string;
}

export interface ClaimTaskResult {
  lease: TaskExecutionLease;
  acquired: boolean;
}

export interface OrchestrationLimits {
  enabled: boolean;
  maxActiveGlobal: number;
  maxActivePerProject: number;
  leaseTtlSeconds: number;
}

export class OrchestrationConflictError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

function mapLease(row: any): TaskExecutionLease {
  return {
    id: row.id,
    taskId: row.task_id,
    resourceKey: row.resource_key,
    harness: row.harness,
    sessionKey: row.session_key || undefined,
    status: row.status,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

function sameTimestamp(left: unknown, right: unknown): boolean {
  const iso = (value: unknown): string => value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
  return iso(left) === iso(right);
}

export class TaskOrchestrationService {
  private limits: OrchestrationLimits;

  constructor(
    private readonly pool: Pool = defaultPool,
    limits: Partial<OrchestrationLimits> = {},
  ) {
    this.limits = {
      enabled: limits.enabled ?? false,
      maxActiveGlobal: limits.maxActiveGlobal ?? 1,
      maxActivePerProject: limits.maxActivePerProject ?? 1,
      leaseTtlSeconds: limits.leaseTtlSeconds ?? 900,
    };
  }

  configure(limits: OrchestrationLimits): void {
    if (!Number.isInteger(limits.maxActiveGlobal) || limits.maxActiveGlobal < 1) {
      throw new Error('maxActiveGlobal must be a positive integer');
    }
    if (!Number.isInteger(limits.maxActivePerProject) || limits.maxActivePerProject < 1) {
      throw new Error('maxActivePerProject must be a positive integer');
    }
    if (!Number.isInteger(limits.leaseTtlSeconds) || limits.leaseTtlSeconds < 30 || limits.leaseTtlSeconds > 3600) {
      throw new Error('leaseTtlSeconds must be an integer between 30 and 3600');
    }
    this.limits = { ...limits };
  }

  async claimReadyTask(input: ClaimTaskInput): Promise<ClaimTaskResult> {
    if (!this.limits.enabled) {
      throw new OrchestrationConflictError('Hardened orchestration is disabled', 'ORCHESTRATION_DISABLED');
    }
    const client = await this.pool.connect();
    const ttlSeconds = Math.max(30, Math.min(input.ttlSeconds ?? this.limits.leaseTtlSeconds, 3600));
    try {
      await client.query('BEGIN');
      await this.expireLeases(client);

      const taskResult = await client.query(
        `SELECT id, title, status, auto_start, updated_at, project_id,
                execution_mode, execution_profile, archive_disposition
           FROM tasks
          WHERE id = $1
          FOR UPDATE`,
        [input.taskId],
      );
      if (!taskResult.rowCount) {
        throw new OrchestrationConflictError('Task not found', 'TASK_NOT_FOUND');
      }
      const task = taskResult.rows[0];

      // A retry of the exact successful request is idempotent even though the
      // first request has already moved the task to in-progress.
      const existingResult = await client.query(
        `SELECT *
           FROM task_execution_leases
          WHERE task_id = $1 AND status = 'active'
          FOR UPDATE`,
        [input.taskId],
      );
      if (existingResult.rowCount) {
        const existing = existingResult.rows[0];
        // Once this task has an active lease, matching task/resource/harness
        // callers are replays regardless of timestamp precision. They must not
        // acquire wake ownership; stale snapshots therefore remain fail-safe.
        if (
          existing.resource_key === input.resourceKey
          && existing.harness === input.harness
        ) {
          await client.query('COMMIT');
          return { lease: mapLease(existing), acquired: false };
        }
        throw new OrchestrationConflictError('Task already has a different active lease', 'ACTIVE_LEASE_CONFLICT');
      }

      if (task.status !== 'todo') {
        throw new OrchestrationConflictError(`Task is not claimable from status ${task.status}`, 'TASK_NOT_TODO');
      }
      if (!task.auto_start) {
        throw new OrchestrationConflictError('Task auto-start is disabled', 'AUTO_START_DISABLED');
      }
      if (!sameTimestamp(task.updated_at, input.snapshotUpdatedAt)) {
        throw new OrchestrationConflictError('Task snapshot changed before claim', 'STALE_TASK_SNAPSHOT');
      }

      const configuredHarness = task.execution_profile?.harness;
      if (configuredHarness && configuredHarness !== input.harness) {
        throw new OrchestrationConflictError(
          `Task requires ${configuredHarness} harness, not ${input.harness}`,
          'HARNESS_MISMATCH',
        );
      }

      // Lock every parent in stable UUID order. Scheduler pre-filtering is
      // advisory; this transaction is the authoritative dependency check.
      const dependencies = await client.query(
        `SELECT parent.id, parent.status, parent.archive_disposition
           FROM task_dependencies d
           JOIN tasks parent ON parent.id = d.depends_on_task_id
          WHERE d.task_id = $1
          ORDER BY parent.id
          FOR UPDATE OF parent`,
        [input.taskId],
      );
      const unmet = dependencies.rows.find((parent: any) => !(
        parent.status === 'completed'
        || (parent.status === 'archived' && parent.archive_disposition === 'completed')
      ));
      if (unmet) {
        throw new OrchestrationConflictError('Task has unmet dependencies', 'UNMET_DEPENDENCY');
      }

      // Capacity is a cross-task invariant. Row locks on the candidate task
      // cannot serialize claims for different tasks/resources, so two READ
      // COMMITTED transactions could otherwise both observe count=0 and
      // exceed the configured global/project budget. One transaction-scoped
      // advisory lock serializes the short capacity-check + lease-insert
      // section for every scheduler claimant without holding a session lock.
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [1129072962, 1]);

      const globalCount = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM task_execution_leases
          WHERE status = 'active' AND expires_at > NOW()`,
      );
      if (Number(globalCount.rows[0]?.count || 0) >= this.limits.maxActiveGlobal) {
        throw new OrchestrationConflictError('Global active lease budget is exhausted', 'GLOBAL_CAPACITY_EXHAUSTED');
      }

      if (task.project_id) {
        const projectCount = await client.query(
          `SELECT COUNT(*)::int AS count
             FROM task_execution_leases lease
             JOIN tasks leased_task ON leased_task.id = lease.task_id
            WHERE lease.status = 'active' AND lease.expires_at > NOW()
              AND leased_task.project_id = $1`,
          [task.project_id],
        );
        if (Number(projectCount.rows[0]?.count || 0) >= this.limits.maxActivePerProject) {
          throw new OrchestrationConflictError('Project active lease budget is exhausted', 'PROJECT_CAPACITY_EXHAUSTED');
        }
      }

      const leaseResult = await client.query(
        `INSERT INTO task_execution_leases (
           task_id, resource_key, harness, session_key,
           claimed_task_updated_at, expires_at, metadata
         ) VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 second'), $7::jsonb)
         RETURNING *`,
        [
          input.taskId,
          input.resourceKey,
          input.harness,
          input.sessionKey || null,
          task.updated_at,
          ttlSeconds,
          JSON.stringify(input.metadata || {}),
        ],
      );

      // The task row has remained locked since the snapshot/dependency checks,
      // so status is the authoritative compare-and-set guard here. Do not
      // compare updated_at again: PostgreSQL may retain microseconds while the
      // node-postgres Date/API snapshot has millisecond precision, making an
      // unchanged row compare unequal.
      const moved = await client.query(
        `UPDATE tasks
            SET status = 'in-progress', started_at = COALESCE(started_at, NOW()),
                updated_at = NOW()
          WHERE id = $1 AND status = 'todo'
          RETURNING id`,
        [input.taskId],
      );
      if (!moved.rowCount) {
        throw new OrchestrationConflictError('Task changed during claim', 'CLAIM_COMPARE_AND_SET_FAILED');
      }

      await client.query(
        `INSERT INTO task_history (task_id, event_type, old_value, new_value, note)
         VALUES ($1, 'orchestration.claimed', 'todo', 'in-progress', $2)`,
        [input.taskId, `lease=${leaseResult.rows[0].id} | harness=${input.harness} | resource=${input.resourceKey}`],
      );

      await client.query('COMMIT');
      return { lease: mapLease(leaseResult.rows[0]), acquired: true };
    } catch (error: any) {
      await client.query('ROLLBACK');
      if (error?.code === '23505') {
        throw new OrchestrationConflictError('Task or resource already has an active lease', 'ACTIVE_LEASE_CONFLICT');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeatLease(taskId: string, leaseId: string, sessionKey?: string, ttlSeconds = 900): Promise<TaskExecutionLease> {
    const boundedTtl = Math.max(30, Math.min(ttlSeconds, 3600));
    const result = await this.pool.query(
      `UPDATE task_execution_leases
          SET heartbeat_at = NOW(), expires_at = NOW() + ($2 * INTERVAL '1 second'),
              session_key = COALESCE($3, session_key)
        WHERE id = $1 AND task_id = $4 AND status = 'active' AND expires_at > NOW()
        RETURNING *`,
      [leaseId, boundedTtl, sessionKey || null, taskId],
    );
    if (!result.rowCount) {
      throw new OrchestrationConflictError('Active lease not found or expired', 'LEASE_NOT_ACTIVE');
    }
    return mapLease(result.rows[0]);
  }

  async releaseLease(taskId: string, leaseId: string, status: 'released' | 'failed' = 'released', failureReason?: string): Promise<TaskExecutionLease> {
    const result = await this.pool.query(
      `UPDATE task_execution_leases
          SET status = $2, released_at = COALESCE(released_at, NOW()), failure_reason = COALESCE($3, failure_reason)
        WHERE id = $1 AND task_id = $4 AND status = 'active'
        RETURNING *`,
      [leaseId, status, failureReason || null, taskId],
    );
    if (!result.rowCount) {
      const existing = await this.pool.query(
        `SELECT * FROM task_execution_leases WHERE id = $1 AND task_id = $2 AND status = $3`,
        [leaseId, taskId, status],
      );
      if (existing.rowCount) return mapLease(existing.rows[0]);
      throw new OrchestrationConflictError('Active lease not found', 'LEASE_NOT_ACTIVE');
    }
    return mapLease(result.rows[0]);
  }

  async expireActiveLeases(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE task_execution_leases
          SET status = 'expired', released_at = NOW()
        WHERE status = 'active' AND expires_at <= NOW()`,
    );
    return result.rowCount || 0;
  }

  private async expireLeases(client: PoolClient): Promise<void> {
    await client.query(
      `UPDATE task_execution_leases
          SET status = 'expired', released_at = NOW()
        WHERE status = 'active' AND expires_at <= NOW()`,
    );
  }
}

export const taskOrchestrationService = new TaskOrchestrationService();
