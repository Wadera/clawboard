jest.mock('../services/TaskManagerDB', () => ({
  taskManagerDB: {
    getAllTasks: jest.fn(),
    updateTask: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/AgentHistoryService', () => ({
  agentHistoryService: {
    recordStart: jest.fn().mockResolvedValue(undefined),
    recordCompletion: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/TaskTimelineService', () => ({
  taskTimelineService: {
    recordEvent: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/TranscriptIngester', () => ({
  transcriptIngester: {
    ingestCompleted: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/DiscordThreadService', () => ({
  discordThreadService: {
    postLifecycleMessage: jest.fn().mockResolvedValue(undefined),
    rebindTrackedSession: jest.fn(),
  },
}));

jest.mock('../services/GatewayConnector', () => ({
  canonicalizeSessionKey: jest.fn((key: string) => key),
  getSessionKeyAliases: jest.fn((key: string) => [key]),
}));

// hermesSessionKeyFor is a cheap pure function: use the REAL implementation so
// the derived binding keys (hermes:tool:* for tool sources, agent:main:local:dm:*
// for the 'cli' source Hermes actually records) are exercised, not stubbed.
jest.mock('../services/HermesRuntime', () => ({
  hermesSessionKeyFor: jest.requireActual('../services/HermesRuntime').hermesSessionKeyFor,
  getHermesSessionRuntimeState: jest.fn(),
  getHermesTaskStateDbPath: jest.fn(() => '/task-runtime/.hermes/state.db'),
  isProcessAlive: jest.fn(),
  resolveLaunchedHermesSession: jest.fn(),
}));

jest.mock('../services/HermesCanonicalAdapter', () => ({
  hermesCanonicalAdapter: {
    ingestSessionId: jest.fn().mockResolvedValue({ attemptId: 'attempt-1' }),
  },
}));

import { SubAgentTaskUpdater } from '../services/SubAgentTaskUpdater';
import { taskManagerDB } from '../services/TaskManagerDB';
import { agentHistoryService } from '../services/AgentHistoryService';
import { taskTimelineService } from '../services/TaskTimelineService';
import { discordThreadService } from '../services/DiscordThreadService';
import {
  getHermesSessionRuntimeState,
  isProcessAlive,
  resolveLaunchedHermesSession,
} from '../services/HermesRuntime';
import { hermesCanonicalAdapter } from '../services/HermesCanonicalAdapter';

const REAL_SESSION_ID = '20260703_120000_ab12cd';
const REAL_SESSION_KEY = `hermes:tool:${REAL_SESSION_ID}`;
const CLI_SESSION_KEY = `agent:main:local:dm:${REAL_SESSION_ID}`;

function buildTask(overrides: Record<string, any> = {}): any {
  const startedAt = new Date(Date.now() - 120000).toISOString();
  return {
    id: 'task-1',
    title: 'Test task',
    status: 'in-progress',
    startedAt,
    updated: startedAt,
    sessionRefs: [],
    subtasks: [],
    notes: null,
    executionMode: 'fire-and-forget',
    executionProfile: { harness: 'hermes', mode: 'fire-and-forget' },
    acpSessionKey: null,
    activeAgent: {
      name: 'sub-agent',
      sessionKey: 'pending',
      harness: 'hermes',
      pid: 4242,
      sourceTag: 'tool-task-task-1',
      logPath: '/data/hermes-task-runs/task-1-run.log',
      spawnedAtUnix: 1_751_500_000,
      ...(overrides.activeAgent || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'activeAgent')),
  };
}

function buildUpdater(): SubAgentTaskUpdater {
  return new SubAgentTaskUpdater('/nonexistent/sessions.json');
}

async function tick(updater: SubAgentTaskUpdater, tasks: any[]): Promise<void> {
  (taskManagerDB.getAllTasks as jest.Mock).mockResolvedValue(tasks);
  await (updater as any).checkSessionsAndUpdateTasks();
}

async function runTick(task: any): Promise<void> {
  await tick(buildUpdater(), [task]);
}

function updateCallsFor(taskId: string): any[][] {
  return (taskManagerDB.updateTask as jest.Mock).mock.calls.filter((call) => call[0] === taskId);
}

const NO_SESSION_STATE = {
  sessionId: null,
  sessionKey: null,
  source: 'unknown',
  state: 'none',
  pid: null,
  pidAlive: false,
  label: null,
  model: null,
  startedAt: null,
  endedAt: null,
  updatedAt: null,
  row: null,
  reason: null,
};

describe('SubAgentTaskUpdater hermes provisional binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('binds a pending session to the resolved Hermes row without changing status', async () => {
    const row = { id: REAL_SESSION_ID, source: 'tool-task-task-1', started_at: 1_751_500_010 };
    (resolveLaunchedHermesSession as jest.Mock).mockResolvedValue(row);

    const task = buildTask();
    await runTick(task);

    expect(resolveLaunchedHermesSession).toHaveBeenCalledWith('tool-task-task-1', 1_751_500_000, '/data/hermes-task-runs/task-1-run.log');
    expect(taskManagerDB.updateTask).toHaveBeenCalledTimes(1);
    const updates = (taskManagerDB.updateTask as jest.Mock).mock.calls[0][1];
    expect(updates.activeAgent.sessionKey).toBe(REAL_SESSION_KEY);
    expect(updates.activeAgent.pid).toBe(4242);
    expect(updates.sessionRefs).toContain(REAL_SESSION_KEY);
    expect(updates.status).toBeUndefined();
    expect(updates.acpSessionKey).toBeUndefined();
    expect(getHermesSessionRuntimeState).not.toHaveBeenCalled();
    expect(hermesCanonicalAdapter.ingestSessionId).toHaveBeenCalledWith(
      REAL_SESSION_ID,
      expect.any(Date),
      '/task-runtime/.hermes/state.db',
    );

    // Bind side effects: Discord thread rebound and a resolvable
    // 'session.linked' timeline follow-up for the provisional spawn event.
    expect(discordThreadService.rebindTrackedSession).toHaveBeenCalledWith('task-1', REAL_SESSION_KEY);
    expect(taskTimelineService.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      eventType: 'session.linked',
      sessionKey: REAL_SESSION_KEY,
      metadata: expect.objectContaining({
        realSessionKey: REAL_SESSION_KEY,
        sourceTag: 'tool-task-task-1',
        provisionalSince: 1_751_500_000,
      }),
    }));
  });

  it('also binds acpSessionKey for interactive tasks', async () => {
    const row = { id: REAL_SESSION_ID, source: 'tool-task-task-1', started_at: 1_751_500_010 };
    (resolveLaunchedHermesSession as jest.Mock).mockResolvedValue(row);

    const task = buildTask({ executionMode: 'interactive' });
    await runTick(task);

    const updates = (taskManagerDB.updateTask as jest.Mock).mock.calls[0][1];
    expect(updates.acpSessionKey).toBe(REAL_SESSION_KEY);
  });

  it('derives the resolve window from task.startedAt when spawnedAtUnix is missing', async () => {
    const startedAtIso = '2026-07-03T12:00:00.000Z';
    const expectedSpawnedAtUnix = Math.floor(new Date(startedAtIso).getTime() / 1000) - 2;
    const row = { id: REAL_SESSION_ID, source: 'tool-task-task-1', started_at: expectedSpawnedAtUnix + 10 };
    (resolveLaunchedHermesSession as jest.Mock).mockResolvedValue(row);

    const task = buildTask({ startedAt: startedAtIso, activeAgent: { spawnedAtUnix: undefined } });
    await runTick(task);

    expect(resolveLaunchedHermesSession).toHaveBeenCalledWith('tool-task-task-1', expectedSpawnedAtUnix, '/data/hermes-task-runs/task-1-run.log');
    const updates = (taskManagerDB.updateTask as jest.Mock).mock.calls[0][1];
    expect(updates.activeAgent.sessionKey).toBe(REAL_SESSION_KEY);
  });

  it('keeps waiting while the session is unresolvable but the worker PID is alive', async () => {
    (resolveLaunchedHermesSession as jest.Mock).mockResolvedValue(null);
    (isProcessAlive as jest.Mock).mockReturnValue(true);

    await runTick(buildTask());

    expect(taskManagerDB.updateTask).not.toHaveBeenCalled();
    expect(getHermesSessionRuntimeState).not.toHaveBeenCalled();
  });

  it('reaps an unresolvable pending session with a dead PID to stuck without persisting the pending sentinel', async () => {
    (resolveLaunchedHermesSession as jest.Mock).mockResolvedValue(null);
    (isProcessAlive as jest.Mock).mockReturnValue(false);
    (getHermesSessionRuntimeState as jest.Mock).mockResolvedValue({ ...NO_SESSION_STATE, pid: 4242 });

    await runTick(buildTask());

    expect(taskManagerDB.updateTask).toHaveBeenCalled();
    const updates = (taskManagerDB.updateTask as jest.Mock).mock.calls[0][1];
    expect(updates.status).toBe('stuck');
    expect(updates.activeAgent).toBeNull();
    expect(updates.acpSessionKey).toBeNull();
    // The literal 'pending' sentinel must never leak into persisted fields.
    expect(updates.sessionRefs).not.toContain('pending');
    expect(updates.completedBy.sessionKey).not.toBe('pending');
    expect(updates.completedBy.sessionKey).toBe('tool-task-task-1');
    // History bookkeeping uses the task-scoped pseudo key, not the shared sentinel.
    expect(agentHistoryService.recordCompletion).toHaveBeenCalledWith('pending:task-1', 'task-1', expect.anything());
  });

  it('reaping one dead provisional task does not block another provisional task from binding', async () => {
    const taskA = buildTask({ id: 'task-a', activeAgent: { pid: 1111, sourceTag: 'tool-task-task-a' } });
    const taskB = buildTask({ id: 'task-b', activeAgent: { pid: 2222, sourceTag: 'tool-task-task-b' } });
    const rowB = { id: REAL_SESSION_ID, source: 'tool-task-task-b', started_at: 1_751_500_010 };

    // Tick 1: neither session row is resolvable; A's worker is dead, B's alive.
    (resolveLaunchedHermesSession as jest.Mock).mockResolvedValue(null);
    (isProcessAlive as jest.Mock).mockImplementation((pid: number) => pid === 2222);
    (getHermesSessionRuntimeState as jest.Mock).mockResolvedValue({ ...NO_SESSION_STATE, pid: 1111 });

    const updater = buildUpdater();
    await tick(updater, [taskA, taskB]);

    const reapCalls = updateCallsFor('task-a');
    expect(reapCalls).toHaveLength(1);
    expect(reapCalls[0][1].status).toBe('stuck');
    expect(reapCalls[0][1].sessionRefs).not.toContain('pending');
    expect(updateCallsFor('task-b')).toHaveLength(0);

    // Tick 2, SAME updater instance: B's row appears and must bind even though
    // A was just reaped (no shared 'pending' sentinel in recentlyEndedSessions).
    (resolveLaunchedHermesSession as jest.Mock).mockImplementation(async (sourceTag: string) =>
      (sourceTag === 'tool-task-task-b' ? rowB : null));

    await tick(updater, [taskA, taskB]);

    // A is not double-reaped (its task-scoped ended entry dedups it) …
    expect(updateCallsFor('task-a')).toHaveLength(1);
    // … and B binds to its real session.
    const bindCalls = updateCallsFor('task-b');
    expect(bindCalls).toHaveLength(1);
    expect(bindCalls[0][1].activeAgent.sessionKey).toBe(REAL_SESSION_KEY);
    expect(bindCalls[0][1].sessionRefs).toContain(REAL_SESSION_KEY);
  });

  it('binds an already-ended cli-source row on tick 1 and moves the task to review on tick 2', async () => {
    const endedRow = { id: REAL_SESSION_ID, source: 'cli', started_at: 1_751_500_010, ended_at: 1_751_500_100 };
    (resolveLaunchedHermesSession as jest.Mock).mockResolvedValue(endedRow);

    const task = buildTask();
    const updater = buildUpdater();

    // Tick 1: bind only — cli-source rows must derive the real
    // agent:main:local:dm:* key, and binding must not complete the task yet.
    await tick(updater, [task]);

    expect(taskManagerDB.updateTask).toHaveBeenCalledTimes(1);
    const bindUpdates = (taskManagerDB.updateTask as jest.Mock).mock.calls[0][1];
    expect(bindUpdates.activeAgent.sessionKey).toBe(CLI_SESSION_KEY);
    expect(bindUpdates.sessionRefs).toContain(CLI_SESSION_KEY);
    expect(bindUpdates.status).toBeUndefined();

    // Simulate the bind having been persisted.
    task.activeAgent.sessionKey = CLI_SESSION_KEY;
    task.sessionRefs = [CLI_SESSION_KEY];

    (getHermesSessionRuntimeState as jest.Mock).mockResolvedValue({
      sessionId: REAL_SESSION_ID,
      sessionKey: CLI_SESSION_KEY,
      source: 'cli',
      state: 'completed',
      pid: 4242,
      pidAlive: false,
      label: 'Hermes 20260703',
      model: 'gpt-5.5',
      startedAt: '2026-07-03T12:00:00.000Z',
      endedAt: '2026-07-03T12:01:40.000Z',
      updatedAt: '2026-07-03T12:01:40.000Z',
      row: endedRow,
      reason: 'Hermes session has ended.',
    });

    // Tick 2, same instance: the freshly-bound ended session completes → review.
    await tick(updater, [task]);

    expect(taskManagerDB.updateTask).toHaveBeenCalledTimes(2);
    const reviewUpdates = (taskManagerDB.updateTask as jest.Mock).mock.calls[1][1];
    expect(reviewUpdates.status).toBe('review');
    expect(reviewUpdates.needsReview).toBe(true);
    expect(reviewUpdates.activeAgent).toBeNull();
    expect(reviewUpdates.sessionRefs).toContain(CLI_SESSION_KEY);
    expect(reviewUpdates.sessionRefs).not.toContain('pending');
  });

  it('moves a bound session with an ended row to review', async () => {
    (getHermesSessionRuntimeState as jest.Mock).mockResolvedValue({
      sessionId: REAL_SESSION_ID,
      sessionKey: REAL_SESSION_KEY,
      source: 'tool',
      state: 'completed',
      pid: 4242,
      pidAlive: false,
      label: 'Hermes 20260703',
      model: 'gpt-5.5',
      startedAt: '2026-07-03T12:00:00.000Z',
      endedAt: '2026-07-03T12:05:00.000Z',
      updatedAt: '2026-07-03T12:05:00.000Z',
      row: { id: REAL_SESSION_ID, source: 'tool', ended_at: 1_751_500_300 },
      reason: 'Hermes session has ended.',
    });

    await runTick(buildTask({ activeAgent: { sessionKey: REAL_SESSION_KEY } }));

    expect(resolveLaunchedHermesSession).not.toHaveBeenCalled();
    const updates = (taskManagerDB.updateTask as jest.Mock).mock.calls[0][1];
    expect(updates.status).toBe('review');
    expect(updates.activeAgent).toBeNull();
    expect(updates.needsReview).toBe(true);
  });
});
