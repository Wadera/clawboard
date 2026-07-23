import type { Task } from '../services/TaskManagerDB';
import {
  TaskReviewerService,
  type ReviewerDependencies,
} from '../services/TaskReviewerService';
import { buildCanonicalReviewSlice } from '../services/TaskReviewAttemptService';
import type { ReviewHistoryEntry } from '../services/TaskManagerDB';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-123',
    title: 'Automated reviewer test task',
    description: 'Verify reviewer behavior',
    status: 'review',
    priority: 'normal',
    subtasks: [
      { id: 'sub-1', text: 'Ship feature', status: 'review' },
    ],
    links: [],
    sessionRefs: ['sess-1'],
    autoCreated: false,
    autoStart: true,
    blockedBy: [],
    tags: ['qa'],
    created: '2026-04-21T10:00:00.000Z',
    updated: '2026-04-21T10:00:00.000Z',
    attemptCount: 0,
    ...overrides,
  };
}

function createDeps(task: Task, reports: Array<{ id: string; title: string; summary: string | null; content: string }> = []): ReviewerDependencies {
  return {
    getTask: jest.fn(async (taskId: string) => (taskId == task.id ? task : undefined)),
    updateTask: jest.fn(async (_taskId: string, updates: Partial<Task>) => ({
      ...task,
      ...updates,
      reviewHistory: updates.reviewHistory as ReviewHistoryEntry[] | undefined,
    } as Task)),
    getReportsForTask: jest.fn(async () => reports),
    collectWorkspaceEvidence: jest.fn(async () => ({
      workingDirectory: '/tmp/repo',
      gitBranch: 'feature/reviewer',
      changedFiles: ['backend/src/services/TaskReviewerService.ts'],
      diffStat: '1 file changed, 120 insertions(+)',
      commandEvidence: ['npm test -- --runInBand passed'],
    })),
    notifyEscalation: jest.fn(async () => undefined),
  };
}

describe('TaskReviewerService', () => {
  test('passes tasks that have explicit criteria, review-ready subtasks, and evidence', async () => {
    const task = makeTask({ successCriteria: ['All reviewer tests pass', 'Report includes proof'] as any });
    const deps = createDeps(task, [
      {
        id: 'report-1',
        title: 'DEV proof',
        summary: 'Reviewer smoke test passed',
        content: 'npm test -- --runInBand passed\nreviewer route returned success',
      },
    ]);

    const service = new TaskReviewerService(deps);
    const outcome = await service.runReview(task.id);

    expect(outcome.decision).toBe('pass');
    expect(outcome.applied.status).toBe('review');
    expect(outcome.applied.attemptCount).toBe(0);
    expect(deps.updateTask).toHaveBeenCalled();
    expect(outcome.evidence.reports).toHaveLength(1);
  });

  test('rejects tasks with unfinished subtasks and bumps the attempt counter', async () => {
    const task = makeTask({
      subtasks: [
        { id: 'sub-1', text: 'Ship feature', status: 'in_progress' },
      ],
      successCriteria: ['All subtasks reviewed'] as any,
      attemptCount: 1,
    });
    const deps = createDeps(task);

    const service = new TaskReviewerService(deps);
    const outcome = await service.runReview(task.id);

    expect(outcome.decision).toBe('reject');
    expect(outcome.applied.status).toBe('in-progress');
    expect(outcome.applied.attemptCount).toBe(2);
    expect(outcome.findings.some((finding) => finding.message.includes('not ready for review'))).toBe(true);
  });

  test('accepts a contiguous reviewed prefix while later work remains empty', async () => {
    const task = makeTask({
      notes: 'implementation receipt commit 0123456789012345678901234567890123456789',
      subtasks: [
        { id: 'sub-0', text: 'Plan', status: 'completed' },
        { id: 'sub-1', text: 'Implemented slice', status: 'review', reviewNote: 'commit 0123456789012345678901234567890123456789' },
        { id: 'sub-2', text: 'Future slice', status: 'empty' },
      ],
      successCriteria: ['Reviewed prefix is independently verifiable'],
    });
    const slice = buildCanonicalReviewSlice(task);
    expect(slice.map((item) => item.index)).toEqual([1]);

    const deps = createDeps(task);
    const outcome = await new TaskReviewerService(deps).runReview(task.id);
    expect(outcome.decision).toBe('pass');
    expect(outcome.applied.status).toBe('review');
  });

  test('does not duplicate compatibility history when another reviewer already committed the attempt', async () => {
    const existingHistory = [{ id: 'persisted-verdict' }] as unknown as ReviewHistoryEntry[];
    const task = makeTask({
      successCriteria: ['Independent evidence passes'],
      reviewHistory: existingHistory,
      attemptCount: 1,
    });
    const deps = createDeps(task);
    const attemptService = {
      beginAttempt: jest.fn(async () => ({
        id: 'attempt-1',
        attemptNo: 2,
        idempotencyKey: 'review:task-123:2:snapshot:hash',
        reviewSlice: [],
        status: 'running',
      })),
      recordVerdict: jest.fn(async () => ({
        status: 'review',
        attemptCount: 1,
        applied: false,
      })),
    };

    const outcome = await new TaskReviewerService(deps, attemptService as any).runReview(task.id);

    expect(outcome.applied.mutated).toBe(false);
    expect(outcome.applied.reviewHistoryLength).toBe(1);
    expect(deps.updateTask).not.toHaveBeenCalled();
    expect(deps.notifyEscalation).not.toHaveBeenCalled();
  });

  test('escalates tasks that are missing success criteria and sends a notification', async () => {
    const task = makeTask({ maxRetries: 2 as any });
    const deps = createDeps(task);

    const service = new TaskReviewerService(deps);
    const outcome = await service.runReview(task.id);

    expect(outcome.decision).toBe('escalate');
    expect(outcome.applied.status).toBe('stuck');
    expect(outcome.findings.some((finding) => finding.message.includes('success criteria'))).toBe(true);
    expect(deps.notifyEscalation).toHaveBeenCalledTimes(1);
  });
});
