import { classifyOpenClawRespawnState, TaskSpawnGuard } from '../services/TaskSpawnGuard';

describe('TaskSpawnGuard', () => {
  it('serializes concurrent spawn decisions for the same task', async () => {
    const guard = new TaskSpawnGuard();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const order: string[] = [];

    const first = guard.run('task-1', async () => {
      order.push('first:start');
      markFirstStarted();
      await firstMayFinish;
      order.push('first:end');
    });
    const second = guard.run('task-1', async () => {
      order.push('second:start');
      order.push('second:end');
    });

    await firstStarted;
    expect(order).toEqual(['first:start']);
    expect(guard.pendingTaskCount()).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(guard.pendingTaskCount()).toBe(0);
  });

  it('allows different tasks to make progress independently', async () => {
    const guard = new TaskSpawnGuard();
    let releaseA!: () => void;
    const waitForA = new Promise<void>(resolve => { releaseA = resolve; });
    const order: string[] = [];

    const a = guard.run('task-a', async () => {
      order.push('a:start');
      await waitForA;
      order.push('a:end');
    });
    const b = guard.run('task-b', async () => { order.push('b'); });

    await b;
    expect(order).toEqual(['a:start', 'b']);
    releaseA();
    await a;
  });

  it('releases the task after a failed spawn decision', async () => {
    const guard = new TaskSpawnGuard();
    await expect(guard.run('task-1', async () => {
      throw new Error('adapter unavailable');
    })).rejects.toThrow('adapter unavailable');

    await expect(guard.run('task-1', async () => 'retry')).resolves.toBe('retry');
    expect(guard.pendingTaskCount()).toBe(0);
  });
});

describe('classifyOpenClawRespawnState', () => {
  it.each(['starting', 'queued', 'running', 'active', 'idle', 'busy', 'thinking', 'typing', 'tool-use'])(
    'blocks a duplicate for live state %s',
    state => expect(classifyOpenClawRespawnState(state)).toBe('block'),
  );

  it.each(['completed', 'failed', 'error', 'cancelled', 'ended', 'none'])(
    'allows a respawn only for terminal state %s',
    state => expect(classifyOpenClawRespawnState(state)).toBe('allow'),
  );

  it.each(['unknown', '', undefined])(
    'fails closed for unavailable state %s',
    state => expect(classifyOpenClawRespawnState(state)).toBe('unknown'),
  );
});