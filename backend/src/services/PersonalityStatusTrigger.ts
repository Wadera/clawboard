import { PersonalityStatusInput } from './PersonalityStatusPolicy';

export interface StatusSourceReceipt {
  kind: 'trusted_task_completion' | 'manual';
  issuer: 'clawboard-server';
  receipt_version: 'personality-status-source.v2';
  event_id: string;
  completed_at: string;
  task_updated_at?: string;
  sensitivity_review_contract: 'personality_status_editorial_contract_v1';
  sensitivity_review_outcome: 'passed';
}

const receiptPolicy = {
  issuer: 'clawboard-server' as const,
  receipt_version: 'personality-status-source.v2' as const,
  sensitivity_review_contract: 'personality_status_editorial_contract_v1' as const,
  sensitivity_review_outcome: 'passed' as const,
};

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export class UntrustedStatusTriggerError extends Error {
  constructor(message: string, public readonly statusCode = 409) {
    super(message);
    this.name = 'UntrustedStatusTriggerError';
  }
}

export async function resolveStatusSource(client: Queryable, input: PersonalityStatusInput): Promise<StatusSourceReceipt> {
  if (input.trigger === 'manual') {
    return { ...receiptPolicy, kind: 'manual', event_id: input.event_id, completed_at: new Date(input.event_completed_at).toISOString() };
  }

  const taskId = input.event_id.slice('task:'.length);
  const result = await client.query(
    'SELECT id, status, completed_at, updated_at FROM tasks WHERE id=$1 FOR SHARE',
    [taskId],
  );
  const task = result.rows[0];
  if (!task || task.status !== 'completed' || !task.completed_at) {
    throw new UntrustedStatusTriggerError('meaningful goal trigger is not backed by a completed task');
  }

  const trustedCompletedAt = new Date(task.completed_at);
  const assertedCompletedAt = new Date(input.event_completed_at);
  if (!Number.isFinite(trustedCompletedAt.getTime()) || trustedCompletedAt.getTime() !== assertedCompletedAt.getTime()) {
    throw new UntrustedStatusTriggerError('event_completed_at does not match the trusted task completion timestamp');
  }

  return {
    ...receiptPolicy,
    kind: 'trusted_task_completion',
    event_id: `task:${task.id}`,
    completed_at: trustedCompletedAt.toISOString(),
    task_updated_at: new Date(task.updated_at).toISOString(),
  };
}
