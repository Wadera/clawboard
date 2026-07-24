import { OrchestrationConflictError, TaskOrchestrationService } from '../services/TaskOrchestrationService';

interface FakeOptions {
  dependencies?: any[];
  existingLease?: any;
  globalCount?: number;
  projectCount?: number;
  insertError?: any;
}

function fakePool(task: any, options: FakeOptions = {}) {
  const queries: Array<{ sql: string; params?: any[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
      if (sql.includes("SET status = 'expired'")) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM tasks') && sql.includes('FOR UPDATE')) return { rowCount: task ? 1 : 0, rows: task ? [task] : [] };
      if (sql.includes('FROM task_execution_leases') && sql.includes('task_id = $1') && sql.includes('FOR UPDATE')) {
        return options.existingLease
          ? { rowCount: 1, rows: [options.existingLease] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM task_dependencies')) {
        const rows = options.dependencies || [];
        return { rowCount: rows.length, rows };
      }
      if (sql.includes('COUNT(*)::int') && sql.includes('JOIN tasks leased_task')) {
        return { rowCount: 1, rows: [{ count: options.projectCount || 0 }] };
      }
      if (sql.includes('COUNT(*)::int') && sql.includes('FROM task_execution_leases')) {
        return { rowCount: 1, rows: [{ count: options.globalCount || 0 }] };
      }
      if (sql.includes('INSERT INTO task_execution_leases')) {
        if (options.insertError) throw options.insertError;
        return {
          rowCount: 1,
          rows: [{
            id: 'lease-1', task_id: task.id, resource_key: params?.[1], harness: params?.[2],
            session_key: params?.[3], status: 'active', claimed_task_updated_at: task.updated_at,
            acquired_at: '2026-07-15T00:00:00.000Z', expires_at: '2026-07-15T00:15:00.000Z',
          }],
        };
      }
      if (sql.includes('UPDATE tasks')) return { rowCount: 1, rows: [{ id: task.id }] };
      if (sql.includes('INSERT INTO task_history')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
    release: jest.fn(),
  };
  return {
    pool: { connect: jest.fn(async () => client) } as any,
    client,
    queries,
  };
}

const readyTask = {
  id: 'task-1',
  title: 'Ready task',
  status: 'todo',
  auto_start: true,
  updated_at: '2026-07-15T10:00:00.000Z',
  project_id: 'project-1',
  execution_mode: 'subagent',
  execution_profile: { harness: 'hermes' },
  archive_disposition: null,
};

function claim(service: TaskOrchestrationService, overrides: Record<string, unknown> = {}) {
  return service.claimReadyTask({
    taskId: readyTask.id,
    snapshotUpdatedAt: readyTask.updated_at,
    harness: 'hermes',
    resourceKey: 'worktree:a422c1eb',
    ...overrides,
  });
}

function enabledService(pool: any, limits: Record<string, unknown> = {}) {
  return new TaskOrchestrationService(pool, {
    enabled: true,
    maxActiveGlobal: 1,
    maxActivePerProject: 1,
    leaseTtlSeconds: 900,
    ...limits,
  });
}

describe('TaskOrchestrationService', () => {
  test('atomically claims a ready dependency-safe auto-start task and writes history', async () => {
    const fake = fakePool(readyTask);
    const service = enabledService(fake.pool, { maxActiveGlobal: 2, maxActivePerProject: 2 });
    const result = await claim(service);

    expect(result.acquired).toBe(true);
    expect(result.lease.id).toBe('lease-1');
    expect(result.lease.harness).toBe('hermes');
    expect(fake.client.query).toHaveBeenCalledWith('COMMIT');
    expect(fake.queries.some(({ sql }) => sql.includes("status = 'in-progress'"))).toBe(true);
    expect(fake.queries.some(({ sql }) => sql.includes('INSERT INTO task_history'))).toBe(true);
    expect(fake.queries.find(({ sql }) => sql.includes('FROM task_dependencies'))?.sql).toContain('FOR UPDATE OF parent');
    expect(fake.queries.some(({ sql }) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  test('returns the same non-acquiring lease for a matching replay despite timestamp precision drift', async () => {
    const existingLease = {
      id: 'lease-existing', task_id: readyTask.id, resource_key: 'worktree:a422c1eb', harness: 'hermes',
      status: 'active', claimed_task_updated_at: readyTask.updated_at,
      acquired_at: '2026-07-15T00:00:00.000Z', expires_at: '2026-07-15T00:15:00.000Z',
    };
    const fake = fakePool({ ...readyTask, status: 'in-progress' }, { existingLease });
    const result = await claim(enabledService(fake.pool), { snapshotUpdatedAt: '2026-07-15T10:00:00.001Z' });
    expect(result).toMatchObject({ acquired: false, lease: { id: 'lease-existing' } });
    expect(fake.queries.some(({ sql }) => sql.includes('INSERT INTO task_execution_leases'))).toBe(false);
    expect(fake.client.query).toHaveBeenCalledWith('COMMIT');
  });

  test('accepts an API ISO snapshot matching a PostgreSQL Date with milliseconds', async () => {
    const updatedAt = new Date('2026-07-15T10:00:00.123Z');
    const task = { ...readyTask, updated_at: updatedAt };
    const fake = fakePool(task);
    await expect(enabledService(fake.pool).claimReadyTask({
      taskId: task.id,
      snapshotUpdatedAt: updatedAt.toISOString(),
      harness: 'hermes',
      resourceKey: 'worktree:a422c1eb',
    })).resolves.toMatchObject({ acquired: true, lease: { id: 'lease-1' } });
  });

  test('fails closed when auto-start is disabled', async () => {
    const fake = fakePool({ ...readyTask, auto_start: false });
    await expect(claim(enabledService(fake.pool))).rejects.toMatchObject({ code: 'AUTO_START_DISABLED' });
    expect(fake.client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  test('rejects a harness that differs from the task execution profile', async () => {
    const fake = fakePool(readyTask);
    await expect(claim(enabledService(fake.pool), { harness: 'openclaw' }))
      .rejects.toMatchObject({ code: 'HARNESS_MISMATCH' });
  });

  test.each([
    [{ id: 'p1', status: 'todo', archive_disposition: null }],
    [{ id: 'p1', status: 'archived', archive_disposition: 'abandoned' }],
  ])('rejects operationally unmet dependencies %#', async (parent: any) => {
    const fake = fakePool(readyTask, { dependencies: [parent] });
    await expect(claim(enabledService(fake.pool)))
      .rejects.toMatchObject({ code: 'UNMET_DEPENDENCY' });
  });

  test.each([
    [{ id: 'p1', status: 'completed', archive_disposition: null }],
    [{ id: 'p1', status: 'archived', archive_disposition: 'completed' }],
  ])('accepts completion-satisfying dependencies %#', async (parent: any) => {
    const fake = fakePool(readyTask, { dependencies: [parent] });
    await expect(claim(enabledService(fake.pool))).resolves.toMatchObject({ acquired: true, lease: { id: 'lease-1' } });
  });

  test('enforces global and per-project active lease budgets', async () => {
    const global = fakePool(readyTask, { globalCount: 1 });
    await expect(claim(enabledService(global.pool)))
      .rejects.toMatchObject({ code: 'GLOBAL_CAPACITY_EXHAUSTED' });

    const project = fakePool(readyTask, { projectCount: 1 });
    await expect(claim(enabledService(project.pool, { maxActiveGlobal: 2, maxActivePerProject: 1 })))
      .rejects.toMatchObject({ code: 'PROJECT_CAPACITY_EXHAUSTED' });
  });

  test('maps unique active task/resource conflicts to a stable error', async () => {
    const fake = fakePool(readyTask, { insertError: { code: '23505' } });
    await expect(claim(enabledService(fake.pool)))
      .rejects.toEqual(expect.objectContaining<Partial<OrchestrationConflictError>>({ code: 'ACTIVE_LEASE_CONFLICT' }));
  });

  test('fails closed without the hardened rollout switch', async () => {
    const fake = fakePool(readyTask);
    await expect(claim(new TaskOrchestrationService(fake.pool)))
      .rejects.toMatchObject({ code: 'ORCHESTRATION_DISABLED' });
    expect(fake.pool.connect).not.toHaveBeenCalled();
  });
});
