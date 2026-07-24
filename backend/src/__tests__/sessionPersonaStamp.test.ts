/**
 * sessionPersonaStamp.test.ts
 *
 * Persona analytics: task.agentTypeId must be stamped onto session rows so
 * "which persona ran which sessions" queries work.
 *
 * Covers:
 *   - agentTypeStampAliases()  — alias expansion used by every stamp point
 *   - taskAgentTypeSubquery()  — the SQL fragment the ingesters embed
 *   - SubAgentTaskUpdater bind step — stamps agent_type_id when a provisional
 *     Hermes session resolves to its real session key
 */

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
}));

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

jest.mock('../services/HermesRuntime', () => ({
  hermesSessionKeyFor: jest.requireActual('../services/HermesRuntime').hermesSessionKeyFor,
  getHermesSessionRuntimeState: jest.fn(),
  isProcessAlive: jest.fn(),
  resolveLaunchedHermesSession: jest.fn(),
}));

import { pool } from '../db/connection';
import { SubAgentTaskUpdater } from '../services/SubAgentTaskUpdater';
import { taskManagerDB } from '../services/TaskManagerDB';
import { resolveLaunchedHermesSession } from '../services/HermesRuntime';
import {
  agentTypeStampAliases,
  taskAgentTypeSubquery,
} from '../services/SessionIngester';

const CRON_JOB_ID = '3a419d09-48eb-4621-b7c9-a5b1ab78446f';
const RUN_ID = '9cb4c3d0-1111-2222-3333-444455556666';
const AGENT_TYPE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000';
const HERMES_SESSION_ID = '20260703_120000_ab12cd';

// ─────────────────────────────────────────────────────────────────
// agentTypeStampAliases
// ─────────────────────────────────────────────────────────────────

describe('agentTypeStampAliases', () => {
  it('returns just the key itself for non-cron, non-hermes keys', () => {
    expect(agentTypeStampAliases('agent:main:main')).toEqual(['agent:main:main']);
  });

  it('expands legacy cron:<jobId> to the canonical agent:main:cron form', () => {
    const aliases = agentTypeStampAliases(`cron:${CRON_JOB_ID}`);
    expect(aliases).toContain(`cron:${CRON_JOB_ID}`);
    expect(aliases).toContain(`agent:main:cron:${CRON_JOB_ID}`);
  });

  it('expands agent:main:cron:<jobId> back to the legacy cron:<jobId> ref', () => {
    const aliases = agentTypeStampAliases(`agent:main:cron:${CRON_JOB_ID}`);
    expect(aliases).toContain(`cron:${CRON_JOB_ID}`);
    expect(aliases).toContain(`agent:main:cron:${CRON_JOB_ID}`);
  });

  it('maps :run: child sessions to their parent cron job refs', () => {
    const key = `agent:main:cron:${CRON_JOB_ID}:run:${RUN_ID}`;
    const aliases = agentTypeStampAliases(key);
    expect(aliases).toContain(key);
    expect(aliases).toContain(`cron:${CRON_JOB_ID}`);
    expect(aliases).toContain(`agent:main:cron:${CRON_JOB_ID}`);
  });

  it('adds the bare state-db id for hermes:<source>:<id> keys', () => {
    const aliases = agentTypeStampAliases(`hermes:tool:${HERMES_SESSION_ID}`);
    expect(aliases).toContain(`hermes:tool:${HERMES_SESSION_ID}`);
    expect(aliases).toContain(HERMES_SESSION_ID);
  });

  it('does not fabricate cron aliases for non-uuid cron-ish keys', () => {
    expect(agentTypeStampAliases('cron:not-a-uuid')).toEqual(['cron:not-a-uuid']);
  });
});

// ─────────────────────────────────────────────────────────────────
// taskAgentTypeSubquery
// ─────────────────────────────────────────────────────────────────

describe('taskAgentTypeSubquery', () => {
  it('references the alias parameter at the requested position', () => {
    const sql = taskAgentTypeSubquery(21);
    expect(sql).toContain('$21::text[]');
    expect(sql).not.toContain('$1::text[]');
  });

  it('checks every task→session link field and never overreaches', () => {
    const sql = taskAgentTypeSubquery(6);
    expect(sql).toContain('t.acp_session_key');
    expect(sql).toContain('t.session_refs');
    expect(sql).toContain("t.completed_by->>'sessionKey'");
    expect(sql).toContain("t.active_agent->>'sessionKey'");
    expect(sql).toContain('t.agent_type_id IS NOT NULL');
    expect(sql).toContain('LIMIT 1');
  });
});

// ─────────────────────────────────────────────────────────────────
// SubAgentTaskUpdater bind step
// ─────────────────────────────────────────────────────────────────

function buildTask(overrides: Record<string, any> = {}): any {
  const startedAt = new Date(Date.now() - 120000).toISOString();
  return {
    id: 'task-1',
    title: 'Persona stamp test task',
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
    },
    ...overrides,
  };
}

async function tick(task: any): Promise<void> {
  (taskManagerDB.getAllTasks as jest.Mock).mockResolvedValue([task]);
  const updater = new SubAgentTaskUpdater('/nonexistent/sessions.json');
  await (updater as any).checkSessionsAndUpdateTasks();
}

function sessionStampCalls(): any[][] {
  return (pool.query as jest.Mock).mock.calls.filter(
    (call) => typeof call[0] === 'string' && /UPDATE sessions/i.test(call[0]) && /agent_type_id/.test(call[0])
  );
}

describe('SubAgentTaskUpdater bind step persona stamping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (pool.query as jest.Mock).mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('stamps the task agentTypeId onto the bound session row', async () => {
    const row = { id: HERMES_SESSION_ID, source: 'tool-task-task-1', started_at: 1_751_500_010 };
    (resolveLaunchedHermesSession as jest.Mock).mockResolvedValue(row);

    await tick(buildTask({ agentTypeId: AGENT_TYPE_ID }));

    const stamps = sessionStampCalls();
    expect(stamps).toHaveLength(1);
    const [sql, params] = stamps[0];
    expect(sql).toContain('agent_type_id IS NULL'); // never overwrite an existing stamp
    expect(params[0]).toBe(AGENT_TYPE_ID);
    expect(params[1]).toContain(`hermes:tool:${HERMES_SESSION_ID}`);
    expect(params[1]).toContain(HERMES_SESSION_ID);
  });

  it('does not touch sessions when the task has no persona', async () => {
    const row = { id: HERMES_SESSION_ID, source: 'tool-task-task-1', started_at: 1_751_500_010 };
    (resolveLaunchedHermesSession as jest.Mock).mockResolvedValue(row);

    await tick(buildTask({ agentTypeId: null }));

    expect(sessionStampCalls()).toHaveLength(0);
    // The bind itself still happened.
    expect(taskManagerDB.updateTask).toHaveBeenCalledTimes(1);
  });
});
