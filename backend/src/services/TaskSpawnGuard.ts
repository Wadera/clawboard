/**
 * Serializes spawn decisions for one task inside this backend process.
 *
 * The spawn route must re-read task state after the previous request has
 * persisted its activeAgent. Without this guard, two concurrent requests can
 * both observe the same pre-spawn state and launch duplicate runtimes.
 */
export class TaskSpawnGuard {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(taskId, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(taskId) === tail) {
        this.tails.delete(taskId);
      }
    }
  }

  pendingTaskCount(): number {
    return this.tails.size;
  }
}

export const taskSpawnGuard = new TaskSpawnGuard();

export type RespawnDecision = 'block' | 'allow' | 'unknown';

/**
 * Interpret an OpenClaw executor status conservatively for respawn.
 * Unknown/degraded adapter results must never become permission to launch a
 * second runtime. Terminal states are the only states that permit a respawn.
 */
export function classifyOpenClawRespawnState(state: string | null | undefined): RespawnDecision {
  const normalized = String(state || 'unknown').trim().toLowerCase();
  // GatewayConnector's streaming states are busy/thinking/typing/tool-use;
  // treating those as adapter failures is safe but dishonest and prevents the
  // route from returning its normal duplicate receipt for a verified live run.
  if (['starting', 'queued', 'running', 'active', 'idle', 'busy', 'thinking', 'typing', 'tool-use'].includes(normalized)) return 'block';
  if (['completed', 'failed', 'error', 'cancelled', 'canceled', 'ended', 'none'].includes(normalized)) return 'allow';
  return 'unknown';
}