export interface SessionCancellationInput {
  sessionId?: string | null;
  sessionKey: string;
  harness?: 'openclaw' | 'hermes' | 'unknown' | null;
  taskId?: string | null;
}

export interface SessionCancellationPlan {
  enabled: boolean;
  endpoint: string | null;
  auditScope: 'task' | 'gateway' | 'none';
  targetLabel: string;
  disabledReason: string | null;
}

export function getSessionCancellationPlan(input: SessionCancellationInput): SessionCancellationPlan {
  const explicitHarness = input.harness && input.harness !== 'unknown' ? input.harness : null;
  const harness = explicitHarness
    || (input.sessionKey.startsWith('hermes:') ? 'hermes' : null)
    || (input.sessionKey.startsWith('agent:') ? 'openclaw' : null)
    || 'unknown';
  if (input.taskId) {
    return {
      enabled: true,
      endpoint: `/tasks/${encodeURIComponent(input.taskId)}/cancel`,
      auditScope: 'task',
      targetLabel: `${harness} task ${input.taskId.slice(0, 8)}`,
      disabledReason: null,
    };
  }

  if (harness !== 'openclaw') {
    return {
      enabled: false,
      endpoint: null,
      auditScope: 'none',
      targetLabel: `${harness} session ${input.sessionKey}`,
      disabledReason: 'This session has no linked task, so a harness-aware audited cancellation target is unavailable.',
    };
  }

  const gatewayTarget = input.sessionId || input.sessionKey;
  if (!gatewayTarget) {
    return {
      enabled: false,
      endpoint: null,
      auditScope: 'none',
      targetLabel: 'OpenClaw session',
      disabledReason: 'This session has no runtime identifier to cancel.',
    };
  }

  return {
    enabled: true,
    endpoint: `/gateway/session/${encodeURIComponent(gatewayTarget)}/abort`,
    auditScope: 'gateway',
    targetLabel: `OpenClaw session ${input.sessionKey}`,
    disabledReason: null,
  };
}

export function getCancellationSuccessMessage(
  plan: SessionCancellationPlan,
  response: Record<string, unknown>,
): string {
  if (plan.auditScope === 'task') {
    if (response.success !== true || response.killed !== true) {
      throw new Error('The linked runtime did not acknowledge cancellation.');
    }
    const acknowledgement = typeof response.acknowledgement === 'string'
      ? ` (${response.acknowledgement.replace(/_/g, ' ')})`
      : '';
    return `Cancellation acknowledged${acknowledgement}. The linked task's audited control path was used.`;
  }

  if (response.success !== true) {
    throw new Error('The gateway did not acknowledge cancellation.');
  }
  return 'Cancellation acknowledged by the OpenClaw gateway. No linked task audit trail was available.';
}
