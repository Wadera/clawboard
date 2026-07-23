import { resolveStatusSource, UntrustedStatusTriggerError } from '../services/PersonalityStatusTrigger';
import { PersonalityStatusInput } from '../services/PersonalityStatusPolicy';

const completedAt = '2026-07-12T10:00:00.000Z';
const input = {
  mood: 'Pleased', status_text: 'I finished something meaningful and feel pleased with the result.',
  author: 'Hermes', author_harness: 'hermes', trigger: 'meaningful_goal_completed',
  event_id: 'task:516c4974-1234-4abc-8def-1234567890ab', event_completed_at: completedAt,
} as PersonalityStatusInput;

describe('trusted personality status source', () => {
  test('selects the task and emits server-owned completion timestamps', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{
      id: input.event_id.slice(5), status: 'completed', completed_at: completedAt, updated_at: '2026-07-12T10:01:00.000Z',
    }] });
    await expect(resolveStatusSource({ query }, input)).resolves.toEqual({
      issuer: 'clawboard-server', receipt_version: 'personality-status-source.v2',
      kind: 'trusted_task_completion', event_id: input.event_id, completed_at: completedAt,
      task_updated_at: '2026-07-12T10:01:00.000Z',
      sensitivity_review_contract: 'personality_status_editorial_contract_v1',
      sensitivity_review_outcome: 'passed',
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM tasks'), [input.event_id.slice(5)]);
  });

  test('rejects a missing trusted task row', async () => {
    await expect(resolveStatusSource({ query: jest.fn().mockResolvedValue({ rows: [] }) }, input))
      .rejects.toBeInstanceOf(UntrustedStatusTriggerError);
  });

  test('rejects an incomplete trusted task row', async () => {
    const rows = [{ id: input.event_id.slice(5), status: 'in-progress', completed_at: null }];
    await expect(resolveStatusSource({ query: jest.fn().mockResolvedValue({ rows }) }, input))
      .rejects.toBeInstanceOf(UntrustedStatusTriggerError);
  });

  test('rejects a caller timestamp that differs from the trusted completion', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{
      id: input.event_id.slice(5), status: 'completed', completed_at: completedAt, updated_at: completedAt,
    }] });
    await expect(resolveStatusSource({ query }, { ...input, event_completed_at: '2026-07-12T10:00:01Z' }))
      .rejects.toThrow(/does not match/);
  });

  test('manual source is explicit and never queries tasks', async () => {
    const query = jest.fn();
    await expect(resolveStatusSource({ query }, { ...input, trigger: 'manual', event_id: 'manual:wadera-request' }))
      .resolves.toMatchObject({
        kind: 'manual', event_id: 'manual:wadera-request', issuer: 'clawboard-server',
        receipt_version: 'personality-status-source.v2', sensitivity_review_outcome: 'passed',
      });
    expect(query).not.toHaveBeenCalled();
  });
});
