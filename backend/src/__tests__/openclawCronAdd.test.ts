/**
 * OpenClaw gateway cron.add payload contract.
 *
 * The 2026.6.x gateway validates cron.add params with a strict TypeBox schema
 * (CronAddParamsSchema, additionalProperties: false). Root-level `model` /
 * `thinking` are rejected with "invalid cron.add params: at root: unexpected
 * property 'model'". Those options belong inside the agentTurn payload
 * (cronAgentTurnPayloadSchema). These tests pin the exact payload shape built
 * by OpenClawTaskExecutor at the connector boundary.
 */

jest.mock('../services/HermesRuntime', () => ({
  getHermesSessionRuntimeState: jest.fn(),
  killProcess: jest.fn(),
  launchHermesTurn: jest.fn(),
}));

import { OpenClawTaskExecutor } from '../services/TaskExecutors';
import type { GatewayConnector } from '../services/GatewayConnector';

const baseSpawnInput = {
  taskId: '2ce2478c-1111-2222-3333-444455556666',
  title: 'Harness spawn fix',
  prompt: 'do the thing',
  model: 'claude-fable-5',
  thinking: 'high',
  interactive: false,
  jobName: 'task-2ce2478c-agent',
  announceTo: 'user:111111111111111111',
  announceChannel: 'discord',
};

// Root-level properties accepted by the installed gateway's CronAddParamsSchema
// (schema-Ctppm7Dp.js: name + CronCommonOptionalFields + schedule/sessionTarget/
// wakeMode/payload/delivery/failureAlert). wakeMode is defaulted server-side by
// normalizeCronJobCreate, so the client may omit it.
const ALLOWED_ROOT_KEYS = new Set([
  'name',
  'agentId',
  'sessionKey',
  'description',
  'enabled',
  'deleteAfterRun',
  'schedule',
  'sessionTarget',
  'wakeMode',
  'payload',
  'delivery',
  'failureAlert',
]);

function createConnectorMock() {
  const sendGatewayRequest = jest.fn(async (method: string, _params?: Record<string, unknown>) => {
    if (method === 'cron.add') {
      return { id: 'job-abc123', name: baseSpawnInput.jobName };
    }
    return {};
  });
  const spawnInteractiveSession = jest.fn(async () => ({
    sessionKey: 'agent:main:cron:job-abc123',
    runId: 'job-abc123',
    cronJob: { id: 'job-abc123' },
  }));
  const connector = {
    sendGatewayRequest,
    spawnInteractiveSession,
  } as unknown as GatewayConnector;
  return { connector, sendGatewayRequest, spawnInteractiveSession };
}

describe('OpenClawTaskExecutor cron.add payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('non-interactive spawn nests model/thinking inside the agentTurn payload', async () => {
    const { connector, sendGatewayRequest } = createConnectorMock();
    const executor = new OpenClawTaskExecutor(connector);

    const result = await executor.spawn({ ...baseSpawnInput });

    const cronAddCall = sendGatewayRequest.mock.calls.find(([method]) => method === 'cron.add');
    expect(cronAddCall).toBeDefined();
    const params = cronAddCall![1] as unknown as Record<string, unknown>;
    expect(params).toBeDefined();

    // Exact shape (schedule.at is time-dependent, checked separately).
    expect(params).toEqual({
      name: 'task-2ce2478c-agent',
      sessionTarget: 'isolated',
      schedule: { kind: 'at', at: expect.any(String) },
      payload: {
        kind: 'agentTurn',
        message: 'do the thing',
        model: 'claude-fable-5',
        thinking: 'high',
      },
      deleteAfterRun: true,
      delivery: {
        mode: 'announce',
        channel: 'discord',
        to: 'user:111111111111111111',
      },
    });

    // Regression guard: gateway rejects unknown root properties.
    expect(Object.prototype.hasOwnProperty.call(params, 'model')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(params, 'thinking')).toBe(false);
    for (const key of Object.keys(params)) {
      expect(ALLOWED_ROOT_KEYS.has(key)).toBe(true);
    }

    // schedule.at must be a valid ISO timestamp (kind: 'at' job).
    const schedule = params.schedule as { kind: string; at: string };
    expect(Number.isNaN(Date.parse(schedule.at))).toBe(false);

    // Model semantics preserved end-to-end in the payload.
    const payload = params.payload as Record<string, unknown>;
    expect(payload.model).toBe(baseSpawnInput.model);
    expect(payload.thinking).toBe(baseSpawnInput.thinking);

    expect(result.harness).toBe('openclaw');
    expect(result.runId).toBe('job-abc123');
    expect(result.sessionKey).toBe('cron:job-abc123');
    expect(result.interactive).toBe(false);
  });

  it('non-interactive spawn force-runs the created job via cron.run', async () => {
    const { connector, sendGatewayRequest } = createConnectorMock();
    const executor = new OpenClawTaskExecutor(connector);

    await executor.spawn({ ...baseSpawnInput });

    expect(sendGatewayRequest).toHaveBeenCalledWith('cron.run', { jobId: 'job-abc123' });
  });

  it('interactive spawn delegates model/thinking to spawnInteractiveSession', async () => {
    const { connector, sendGatewayRequest, spawnInteractiveSession } = createConnectorMock();
    const executor = new OpenClawTaskExecutor(connector);

    const result = await executor.spawn({ ...baseSpawnInput, interactive: true });

    expect(sendGatewayRequest).not.toHaveBeenCalledWith('cron.add', expect.anything());
    expect(spawnInteractiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: baseSpawnInput.jobName,
        prompt: baseSpawnInput.prompt,
        model: baseSpawnInput.model,
        thinking: baseSpawnInput.thinking,
      })
    );
    expect(result.interactive).toBe(true);
    expect(result.sessionKey).toBe('agent:main:cron:job-abc123');
  });
});
