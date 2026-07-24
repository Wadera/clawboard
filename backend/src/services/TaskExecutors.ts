import type { GatewayConnector } from './GatewayConnector';
import type { TaskExecutionHarness } from './TaskManagerDB';
import {
  getHermesSessionRuntimeState,
  killProcess,
  launchHermesTurn,
} from './HermesRuntime';

export interface TaskExecutorSpawnRequest {
  taskId: string;
  title: string;
  prompt: string;
  model: string;
  thinking: string;
  interactive: boolean;
  jobName: string;
  announceTo?: string;
  announceChannel?: string;
  cwd?: string | null;
}

export interface TaskExecutorSpawnResult {
  harness: TaskExecutionHarness;
  sessionKey: string;
  controlSessionKey?: string | null;
  runId?: string | null;
  interactive: boolean;
  raw?: Record<string, unknown>;
}

export interface TaskExecutorSteerRequest {
  taskId: string;
  sessionKey: string;
  message: string;
  model?: string | null;
  cwd?: string | null;
}

export interface TaskExecutorSteerResult {
  harness: TaskExecutionHarness;
  sessionKey: string;
  acknowledged: boolean;
  acknowledgedAt: string;
  acknowledgement: 'gateway_accepted' | 'hermes_resume_launched';
  raw?: Record<string, unknown>;
}

export interface TaskExecutorCancelRequest {
  taskId: string;
  sessionKey: string;
  pid?: number | null;
}

export interface TaskExecutorCancelResult {
  harness: TaskExecutionHarness;
  sessionKey: string;
  killed: boolean;
  acknowledged: boolean;
  acknowledgedAt: string;
  acknowledgement: 'gateway_aborted' | 'hermes_process_signalled' | 'not_cancelled';
  killError?: string | null;
  raw?: Record<string, unknown>;
}

export interface TaskExecutorSessionStatusRequest {
  taskId: string;
  sessionKey?: string | null;
  pid?: number | null;
  model?: string | null;
  interactive: boolean;
}

export interface TaskExecutorSessionStatusResult {
  harness: TaskExecutionHarness;
  sessionKey: string | null;
  state: string;
  label: string | null;
  model: string | null;
  startedAt: string | null;
  interactive: boolean;
  reason?: string | null;
  raw?: Record<string, unknown>;
}

export interface TaskExecutor {
  readonly harness: TaskExecutionHarness;
  spawn(input: TaskExecutorSpawnRequest): Promise<TaskExecutorSpawnResult>;
  steer(input: TaskExecutorSteerRequest): Promise<TaskExecutorSteerResult>;
  cancel(input: TaskExecutorCancelRequest): Promise<TaskExecutorCancelResult>;
  getSessionStatus(input: TaskExecutorSessionStatusRequest): Promise<TaskExecutorSessionStatusResult>;
}

function assertSessionOwnedByHarness(harness: TaskExecutionHarness, sessionKey: string): void {
  const isHermes = sessionKey.startsWith('hermes:');
  if ((harness === 'hermes') !== isHermes) {
    const error = new Error(`Session ${sessionKey} is not owned by the configured ${harness} harness.`);
    error.name = 'HarnessSessionMismatchError';
    (error as any).code = 'HARNESS_SESSION_MISMATCH';
    throw error;
  }
}

export class OpenClawTaskExecutor implements TaskExecutor {
  public readonly harness: TaskExecutionHarness = 'openclaw';

  constructor(private readonly gatewayConnector: GatewayConnector) {}

  async spawn(input: TaskExecutorSpawnRequest): Promise<TaskExecutorSpawnResult> {
    if (input.interactive) {
      const spawned = await this.gatewayConnector.spawnInteractiveSession({
        name: input.jobName,
        prompt: input.prompt,
        model: input.model,
        thinking: input.thinking,
        announceTo: input.announceTo || process.env.SPAWN_AGENT_ANNOUNCE_TO || '',
        announceChannel: input.announceChannel || 'discord',
        taskName: input.title,
      });

      return {
        harness: 'openclaw',
        sessionKey: spawned.sessionKey,
        controlSessionKey: spawned.sessionKey,
        runId: spawned.runId,
        interactive: true,
        raw: { cronJob: spawned.cronJob },
      };
    }

    const at = new Date(Date.now() + 1000).toISOString();
    const cronJob = await this.gatewayConnector.sendGatewayRequest('cron.add', {
      name: input.jobName,
      sessionTarget: 'isolated',
      schedule: { kind: 'at', at },
      // Gateway cron.add params are strict (additionalProperties: false) —
      // model/thinking live inside the agentTurn payload, not at the root.
      payload: {
        kind: 'agentTurn',
        message: input.prompt,
        model: input.model,
        thinking: input.thinking,
      },
      deleteAfterRun: true,
      delivery: {
        mode: 'announce',
        channel: input.announceChannel || 'discord',
        to: input.announceTo || process.env.SPAWN_AGENT_ANNOUNCE_TO || '',
      },
    });

    const runId = cronJob.id as string;
    try {
      await this.gatewayConnector.sendGatewayRequest('cron.run', { jobId: runId });
    } catch (error) {
      console.warn(`⚠️ [OpenClawTaskExecutor] cron.run failed for ${runId}, scheduler fallback will handle it:`, error);
    }

    return {
      harness: 'openclaw',
      sessionKey: `cron:${runId}`,
      runId,
      interactive: false,
      raw: { cronJob },
    };
  }

  async steer(input: TaskExecutorSteerRequest): Promise<TaskExecutorSteerResult> {
    assertSessionOwnedByHarness(this.harness, input.sessionKey);
    const gatewayReceipt = await this.gatewayConnector.steerSession(input.sessionKey, input.message);
    return {
      harness: 'openclaw',
      sessionKey: input.sessionKey,
      acknowledged: true,
      acknowledgedAt: new Date().toISOString(),
      acknowledgement: 'gateway_accepted',
      raw: gatewayReceipt && typeof gatewayReceipt === 'object' ? { gatewayReceipt } : undefined,
    };
  }

  async cancel(input: TaskExecutorCancelRequest): Promise<TaskExecutorCancelResult> {
    assertSessionOwnedByHarness(this.harness, input.sessionKey);
    let killed = false;
    let killError: string | null = null;
    try {
      await this.gatewayConnector.abortSession(input.sessionKey);
      killed = true;
    } catch (error) {
      killError = error instanceof Error ? error.message : String(error);
      console.warn(`[OpenClawTaskExecutor] abort failed for ${input.sessionKey}:`, killError);
    }

    return {
      harness: 'openclaw',
      sessionKey: input.sessionKey,
      killed,
      acknowledged: killed,
      acknowledgedAt: new Date().toISOString(),
      acknowledgement: killed ? 'gateway_aborted' : 'not_cancelled',
      killError,
    };
  }

  async getSessionStatus(input: TaskExecutorSessionStatusRequest): Promise<TaskExecutorSessionStatusResult> {
    let state = input.sessionKey ? 'unknown' : 'none';
    let reason: string | null = null;
    const raw: Record<string, unknown> = {};

    if (input.sessionKey?.startsWith('cron:') || input.sessionKey?.startsWith('agent:main:cron:')) {
      const cronJobId = input.sessionKey.split(':').pop() || '';
      try {
        const cronJobs = await this.gatewayConnector.sendGatewayRequest('cron.list', {});
        const cronJob = Array.isArray(cronJobs)
          ? cronJobs.find((job: any) => String(job?.id || '') === cronJobId)
            || cronJobs.find((job: any) => String(job?.name || '').includes(input.taskId.slice(0, 8)))
          : null;
        if (cronJob) {
          const cronState = cronJob.state || {};
          raw.cronJob = cronJob;
          if (cronState.runningAtMs) {
            state = 'running';
            reason = 'OpenClaw cron job is currently running.';
          } else if (cronState.nextRunAtMs) {
            state = 'queued';
            reason = 'OpenClaw cron job is queued.';
          } else if (cronState.lastStatus === 'success') {
            state = 'completed';
            reason = 'OpenClaw cron job finished successfully.';
          } else if (cronState.lastStatus === 'error' || cronState.lastStatus === 'failed') {
            state = 'error';
            reason = `OpenClaw cron job finished with status ${cronState.lastStatus}.`;
          }
        } else {
          reason = 'OpenClaw cron job was not found in gateway cron.list.';
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }

    if (input.sessionKey && state === 'unknown') {
      try {
        const live = this.gatewayConnector.getSessionState(input.sessionKey);
        if (live) state = live.state;
      } catch {
        // best effort
      }
    }

    return {
      harness: 'openclaw',
      sessionKey: input.sessionKey || null,
      state,
      label: input.sessionKey ? `Task session ${input.taskId.slice(0, 8)}` : null,
      model: input.model || null,
      startedAt: null,
      interactive: input.interactive,
      reason,
      raw: Object.keys(raw).length > 0 ? raw : undefined,
    };
  }
}

export class HermesTaskExecutor implements TaskExecutor {
  public readonly harness: TaskExecutionHarness = 'hermes';

  async spawn(input: TaskExecutorSpawnRequest): Promise<TaskExecutorSpawnResult> {
    const launched = await launchHermesTurn({
      taskId: input.taskId,
      prompt: input.prompt,
      model: input.model,
      cwd: input.cwd,
    });

    return {
      harness: 'hermes',
      sessionKey: launched.sessionKey || 'pending',
      controlSessionKey: !launched.provisional && launched.sessionId && input.interactive ? launched.sessionKey : null,
      runId: String(launched.pid),
      interactive: input.interactive,
      raw: {
        pid: launched.pid,
        sourceTag: launched.sourceTag,
        logPath: launched.logPath,
        hermesSessionId: launched.sessionId,
        provisional: launched.provisional,
        spawnedAtUnix: launched.spawnedAtUnix,
      },
    };
  }

  async steer(input: TaskExecutorSteerRequest): Promise<TaskExecutorSteerResult> {
    if (!input.sessionKey || input.sessionKey === 'pending') {
      // Distinguishable transient condition — routes map this to HTTP 409
      // instead of a generic 500.
      const err = new Error('Hermes session is still starting for this task; wait for ClawBoard to link the session id before steering.');
      err.name = 'HermesSessionStartingError';
      (err as any).code = 'HERMES_SESSION_STARTING';
      throw err;
    }
    assertSessionOwnedByHarness(this.harness, input.sessionKey);

    const status = await getHermesSessionRuntimeState(input.sessionKey);
    if (!status.sessionId) {
      throw new Error('Hermes session is not available for steering yet.');
    }

    const launched = await launchHermesTurn({
      taskId: input.taskId,
      prompt: input.message,
      model: input.model,
      cwd: input.cwd,
      resumeSessionId: status.sessionId,
    });

    return {
      harness: 'hermes',
      sessionKey: launched.sessionKey,
      acknowledged: true,
      acknowledgedAt: new Date().toISOString(),
      acknowledgement: 'hermes_resume_launched',
      raw: {
        pid: launched.pid,
        sourceTag: launched.sourceTag,
        logPath: launched.logPath,
        hermesSessionId: launched.sessionId,
      },
    };
  }

  async cancel(input: TaskExecutorCancelRequest): Promise<TaskExecutorCancelResult> {
    assertSessionOwnedByHarness(this.harness, input.sessionKey);
    const status = await getHermesSessionRuntimeState(input.sessionKey, input.pid);
    const runtimePid = status.pid;
    const sessionMatches = Boolean(status.sessionId) && status.sessionKey === input.sessionKey;
    const pidMatches = Boolean(runtimePid) && (!input.pid || runtimePid === input.pid);
    const killed = sessionMatches && pidMatches && status.pidAlive === true
      ? killProcess(runtimePid)
      : false;
    const killError = killed
      ? null
      : !sessionMatches
        ? 'The linked Hermes session identity could not be verified.'
        : !pidMatches
          ? 'The linked Hermes worker PID does not match the session runtime.'
          : status.pidAlive !== true
            ? 'The linked Hermes worker process is not alive.'
            : 'The linked Hermes worker process could not be signalled.';
    return {
      harness: 'hermes',
      sessionKey: input.sessionKey,
      killed,
      acknowledged: killed,
      acknowledgedAt: new Date().toISOString(),
      acknowledgement: killed ? 'hermes_process_signalled' : 'not_cancelled',
      killError,
      raw: {
        verifiedSessionId: status.sessionId || null,
        verifiedPid: runtimePid || null,
      },
    };
  }

  async getSessionStatus(input: TaskExecutorSessionStatusRequest): Promise<TaskExecutorSessionStatusResult> {
    const status = await getHermesSessionRuntimeState(input.sessionKey, input.pid);
    return {
      harness: 'hermes',
      sessionKey: status.sessionKey,
      state: status.state,
      label: status.label,
      model: status.model || input.model || null,
      startedAt: status.startedAt,
      interactive: input.interactive,
      reason: status.reason || null,
      raw: {
        pid: status.pid,
        pidAlive: status.pidAlive,
        source: status.source,
        endedAt: status.endedAt,
        updatedAt: status.updatedAt,
        hermesSessionId: status.sessionId,
        messageCount: status.row?.message_count || 0,
        toolCallCount: status.row?.tool_call_count || 0,
      },
    };
  }
}

export function createTaskExecutor(harness: TaskExecutionHarness, gatewayConnector: GatewayConnector | null): TaskExecutor {
  if (harness === 'hermes') return new HermesTaskExecutor();
  if (!gatewayConnector) {
    throw new Error('Gateway connector not initialized');
  }
  return new OpenClawTaskExecutor(gatewayConnector);
}
