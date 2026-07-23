jest.mock('../services/HermesRuntime', () => ({
  getHermesSessionRuntimeState: jest.fn(),
  killProcess: jest.fn(),
  launchHermesTurn: jest.fn(),
}));

import { HermesTaskExecutor, OpenClawTaskExecutor } from '../services/TaskExecutors';
import { getHermesSessionRuntimeState, killProcess, launchHermesTurn } from '../services/HermesRuntime';

const baseSpawnInput = {
  taskId: 'd825502e-3f05-4368-87e4-90825e98a63c',
  title: 'Test task',
  prompt: 'do the thing',
  model: 'gpt-5.5',
  thinking: 'medium',
  interactive: true,
  jobName: 'spawn-task-d825502e',
};

const provisionalLaunch = {
  pid: 4242,
  sessionId: null,
  sessionKey: 'pending',
  sourceTag: 'tool-task-d825502e',
  logPath: '/data/hermes-task-runs/d825502e-run.log',
  provisional: true,
  spawnedAtUnix: 1_751_500_000,
};

const boundLaunch = {
  pid: 4242,
  sessionId: '20260703_120000_ab12cd',
  sessionKey: 'hermes:tool:20260703_120000_ab12cd',
  sourceTag: 'tool-task-d825502e',
  logPath: '/data/hermes-task-runs/d825502e-run.log',
  provisional: false,
  spawnedAtUnix: 1_751_500_000,
};

describe('OpenClawTaskExecutor control acknowledgements', () => {
  it('returns gateway acknowledgement and rejects Hermes-owned keys', async () => {
    const gateway = {
      steerSession: jest.fn().mockResolvedValue({ accepted: true, requestId: 'steer-1' }),
      abortSession: jest.fn().mockResolvedValue({ accepted: true }),
    } as any;
    const executor = new OpenClawTaskExecutor(gateway);
    await expect(executor.steer({
      taskId: baseSpawnInput.taskId, sessionKey: 'agent:main:task-1', message: 'continue',
    })).resolves.toMatchObject({ acknowledged: true, acknowledgement: 'gateway_accepted' });
    await expect(executor.cancel({
      taskId: baseSpawnInput.taskId, sessionKey: 'agent:main:task-1',
    })).resolves.toMatchObject({ killed: true, acknowledged: true, acknowledgement: 'gateway_aborted' });
    await expect(executor.steer({
      taskId: baseSpawnInput.taskId, sessionKey: boundLaunch.sessionKey, message: 'wrong harness',
    })).rejects.toMatchObject({ name: 'HarnessSessionMismatchError' });
  });

  it('does not acknowledge a failed gateway cancellation', async () => {
    const gateway = {
      abortSession: jest.fn().mockRejectedValue(new Error('gateway unavailable')),
    } as any;
    const executor = new OpenClawTaskExecutor(gateway);

    await expect(executor.cancel({
      taskId: baseSpawnInput.taskId,
      sessionKey: 'agent:main:task-1',
    })).resolves.toMatchObject({
      killed: false,
      acknowledged: false,
      acknowledgement: 'not_cancelled',
      killError: 'gateway unavailable',
    });
  });

  it('uses live session state after a one-shot cron job has disappeared', async () => {
    const gateway = {
      sendGatewayRequest: jest.fn().mockResolvedValue([]),
      getSessionState: jest.fn().mockReturnValue({ state: 'running' }),
    } as any;
    const executor = new OpenClawTaskExecutor(gateway);

    await expect(executor.getSessionStatus({
      taskId: baseSpawnInput.taskId,
      sessionKey: 'cron:deleted-one-shot-job',
      model: baseSpawnInput.model,
      interactive: false,
    })).resolves.toMatchObject({ state: 'running' });
  });

  it('reports a retained cron job with a future run as queued', async () => {
    const gateway = {
      sendGatewayRequest: jest.fn().mockResolvedValue([{
        id: 'queued-job',
        name: `spawn-task-${baseSpawnInput.taskId.slice(0, 8)}`,
        state: { nextRunAtMs: Date.now() + 1_000 },
      }]),
      getSessionState: jest.fn(),
    } as any;
    const executor = new OpenClawTaskExecutor(gateway);

    await expect(executor.getSessionStatus({
      taskId: baseSpawnInput.taskId,
      sessionKey: 'cron:queued-job',
      model: baseSpawnInput.model,
      interactive: false,
    })).resolves.toMatchObject({ state: 'queued' });
    expect(gateway.getSessionState).not.toHaveBeenCalled();
  });

  it('reports a retained successful cron job as completed', async () => {
    const gateway = {
      sendGatewayRequest: jest.fn().mockResolvedValue([{
        id: 'completed-job',
        name: `spawn-task-${baseSpawnInput.taskId.slice(0, 8)}`,
        state: { lastStatus: 'success' },
      }]),
      getSessionState: jest.fn(),
    } as any;
    const executor = new OpenClawTaskExecutor(gateway);

    await expect(executor.getSessionStatus({
      taskId: baseSpawnInput.taskId,
      sessionKey: 'cron:completed-job',
      model: baseSpawnInput.model,
      interactive: false,
    })).resolves.toMatchObject({ state: 'completed' });
    expect(gateway.getSessionState).not.toHaveBeenCalled();
  });

  it('returns unknown when neither cron nor live runtime can verify the session', async () => {
    const gateway = {
      sendGatewayRequest: jest.fn().mockRejectedValue(new Error('adapter unavailable')),
      getSessionState: jest.fn().mockReturnValue(null),
    } as any;
    const executor = new OpenClawTaskExecutor(gateway);

    await expect(executor.getSessionStatus({
      taskId: baseSpawnInput.taskId,
      sessionKey: 'cron:unverifiable-job',
      model: baseSpawnInput.model,
      interactive: false,
    })).resolves.toMatchObject({ state: 'unknown', reason: 'adapter unavailable' });
  });
});

describe('HermesTaskExecutor', () => {
  const executor = new HermesTaskExecutor();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('spawn maps a provisional launch to sessionKey pending with no control key', async () => {
    (launchHermesTurn as jest.Mock).mockResolvedValue(provisionalLaunch);

    const spawned = await executor.spawn({ ...baseSpawnInput, interactive: true });

    expect(spawned.sessionKey).toBe('pending');
    expect(spawned.controlSessionKey).toBeNull();
    expect(spawned.runId).toBe('4242');
    expect(spawned.raw).toMatchObject({
      pid: 4242,
      sourceTag: 'tool-task-d825502e',
      logPath: '/data/hermes-task-runs/d825502e-run.log',
      hermesSessionId: null,
      provisional: true,
      spawnedAtUnix: 1_751_500_000,
    });
  });

  it('spawn maps a resolved interactive launch to a real session key and control key', async () => {
    (launchHermesTurn as jest.Mock).mockResolvedValue(boundLaunch);

    const spawned = await executor.spawn({ ...baseSpawnInput, interactive: true });

    expect(spawned.sessionKey).toBe('hermes:tool:20260703_120000_ab12cd');
    expect(spawned.controlSessionKey).toBe('hermes:tool:20260703_120000_ab12cd');
    expect(spawned.raw).toMatchObject({ provisional: false, hermesSessionId: '20260703_120000_ab12cd' });
  });

  it('spawn never sets a control key for non-interactive launches', async () => {
    (launchHermesTurn as jest.Mock).mockResolvedValue(boundLaunch);

    const spawned = await executor.spawn({ ...baseSpawnInput, interactive: false });

    expect(spawned.controlSessionKey).toBeNull();
  });

  it('steer rejects a pending session key without touching the runtime', async () => {
    await expect(executor.steer({
      taskId: baseSpawnInput.taskId,
      sessionKey: 'pending',
      message: 'keep going',
    })).rejects.toThrow(/still starting/);

    expect(getHermesSessionRuntimeState).not.toHaveBeenCalled();
    expect(launchHermesTurn).not.toHaveBeenCalled();
  });

  it('steer rejects a missing session key without touching the runtime', async () => {
    await expect(executor.steer({
      taskId: baseSpawnInput.taskId,
      sessionKey: '',
      message: 'keep going',
    })).rejects.toThrow(/still starting/);

    expect(getHermesSessionRuntimeState).not.toHaveBeenCalled();
  });

  it('returns an explicit acknowledgement after launching the exact Hermes resume', async () => {
    (getHermesSessionRuntimeState as jest.Mock).mockResolvedValue({ sessionId: boundLaunch.sessionId });
    (launchHermesTurn as jest.Mock).mockResolvedValue(boundLaunch);
    const result = await executor.steer({
      taskId: baseSpawnInput.taskId,
      sessionKey: boundLaunch.sessionKey,
      message: 'keep going',
    });
    expect(result).toMatchObject({
      acknowledged: true,
      acknowledgement: 'hermes_resume_launched',
      sessionKey: boundLaunch.sessionKey,
    });
    expect(launchHermesTurn).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: boundLaunch.sessionId }));
  });

  it('rejects a session owned by the other harness', async () => {
    await expect(executor.steer({
      taskId: baseSpawnInput.taskId,
      sessionKey: 'agent:openclaw-session',
      message: 'keep going',
    })).rejects.toMatchObject({ name: 'HarnessSessionMismatchError' });
    expect(getHermesSessionRuntimeState).not.toHaveBeenCalled();
  });

  it('preserves cancellation when runtime identity is absent', async () => {
    (getHermesSessionRuntimeState as jest.Mock).mockResolvedValue({
      sessionId: null, sessionKey: boundLaunch.sessionKey, pid: 4242, pidAlive: true,
    });
    const result = await executor.cancel({
      taskId: baseSpawnInput.taskId, sessionKey: boundLaunch.sessionKey, pid: 4242,
    });
    expect(result).toMatchObject({ killed: false, acknowledged: false, acknowledgement: 'not_cancelled' });
    expect(killProcess).not.toHaveBeenCalled();
  });

  it('signals only a live PID verified against the exact Hermes session', async () => {
    (getHermesSessionRuntimeState as jest.Mock).mockResolvedValue({
      sessionId: boundLaunch.sessionId,
      sessionKey: boundLaunch.sessionKey,
      pid: 4242,
      pidAlive: true,
    });
    (killProcess as jest.Mock).mockReturnValue(true);
    const result = await executor.cancel({
      taskId: baseSpawnInput.taskId, sessionKey: boundLaunch.sessionKey, pid: 4242,
    });
    expect(killProcess).toHaveBeenCalledWith(4242);
    expect(result).toMatchObject({
      killed: true, acknowledged: true, acknowledgement: 'hermes_process_signalled',
    });
  });

  it('getSessionStatus exposes messageCount and toolCallCount from the state row', async () => {
    (getHermesSessionRuntimeState as jest.Mock).mockResolvedValue({
      sessionId: '20260703_120000_ab12cd',
      sessionKey: 'hermes:tool:20260703_120000_ab12cd',
      source: 'tool',
      state: 'running',
      pid: 4242,
      pidAlive: true,
      label: 'Hermes 20260703',
      model: 'gpt-5.5',
      startedAt: '2026-07-03T12:00:00.000Z',
      endedAt: null,
      updatedAt: '2026-07-03T12:01:00.000Z',
      row: { id: '20260703_120000_ab12cd', source: 'tool', message_count: 7, tool_call_count: 3 },
      reason: null,
    });

    const status = await executor.getSessionStatus({
      taskId: baseSpawnInput.taskId,
      sessionKey: 'hermes:tool:20260703_120000_ab12cd',
      pid: 4242,
      interactive: true,
    });

    expect(status.state).toBe('running');
    expect(status.raw).toMatchObject({ messageCount: 7, toolCallCount: 3 });
  });
});
