import { describe, expect, it } from 'vitest';
import { getCancellationSuccessMessage, getSessionCancellationPlan } from './sessionControls';

describe('session cancellation controls', () => {
  it('routes linked Hermes and OpenClaw sessions through the harness-aware audited task endpoint', () => {
    expect(getSessionCancellationPlan({
      sessionKey: 'hermes:tool:abc',
      harness: 'hermes',
      taskId: 'task-1234',
    })).toMatchObject({
      enabled: true,
      endpoint: '/tasks/task-1234/cancel',
      auditScope: 'task',
    });

    expect(getSessionCancellationPlan({
      sessionKey: 'agent:main:task-2',
      sessionId: 'session-2',
      harness: 'openclaw',
      taskId: 'task-2',
    })).toMatchObject({
      endpoint: '/tasks/task-2/cancel',
      auditScope: 'task',
    });
  });

  it('allows a direct OpenClaw gateway abort while naming the missing task audit trail', () => {
    const plan = getSessionCancellationPlan({
      sessionKey: 'agent:main:standalone',
      sessionId: 'runtime-1',
      harness: 'openclaw',
    });
    expect(plan).toMatchObject({
      enabled: true,
      endpoint: '/gateway/session/runtime-1/abort',
      auditScope: 'gateway',
    });
    expect(getCancellationSuccessMessage(plan, { success: true })).toContain('No linked task audit trail');
  });

  it('infers an unlinked OpenClaw gateway target from its canonical session key', () => {
    const plan = getSessionCancellationPlan({
      sessionKey: 'agent:main:standalone',
    });
    expect(plan).toMatchObject({
      enabled: true,
      endpoint: '/gateway/session/agent%3Amain%3Astandalone/abort',
      auditScope: 'gateway',
    });
  });

  it('fails closed for an unlinked Hermes session', () => {
    expect(getSessionCancellationPlan({
      sessionKey: 'hermes:tool:unlinked',
      harness: 'hermes',
    })).toMatchObject({
      enabled: false,
      endpoint: null,
      auditScope: 'none',
    });
  });

  it('requires a positive task cancellation acknowledgement before reporting success', () => {
    const plan = getSessionCancellationPlan({
      sessionKey: 'hermes:tool:abc',
      harness: 'hermes',
      taskId: 'task-1234',
    });
    expect(() => getCancellationSuccessMessage(plan, { success: false, killed: false }))
      .toThrow('did not acknowledge');
    expect(getCancellationSuccessMessage(plan, {
      success: true,
      killed: true,
      acknowledgement: 'process_exit_confirmed',
    })).toBe("Cancellation acknowledged (process exit confirmed). The linked task's audited control path was used.");
  });
});
