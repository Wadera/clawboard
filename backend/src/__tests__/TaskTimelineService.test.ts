import { taskTimelineService } from '../services/TaskTimelineService';
import { agentHistoryService } from '../services/AgentHistoryService';

const mockQuery = jest.fn();

jest.mock('../db/connection', () => ({
  pool: {
    query: (...args: any[]) => mockQuery(...args),
  },
}));

jest.mock('../services/AgentHistoryService', () => ({
  agentHistoryService: {
    findByTaskId: jest.fn(),
  },
}));

describe('TaskTimelineService', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    (agentHistoryService.findByTaskId as jest.Mock).mockReset();
  });

  test('records timeline events with metadata JSON', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await taskTimelineService.recordEvent({
      taskId: 'task-1',
      eventType: 'session.spawned',
      title: 'Spawned task session',
      description: 'Started a new session',
      sessionKey: 'agent:main:test',
      actor: 'sub-agent',
      harness: 'hermes',
      metadata: { model: 'sonnet' },
      createdAt: '2026-04-22T00:00:00.000Z',
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO task_timeline_events');
    expect(params[1]).toBe('task-1');
    expect(params[2]).toBe('session.spawned');
    expect(params[3]).toBe('Spawned task session');
    expect(params[5]).toBe('agent:main:test');
    expect(params[8]).toBe(JSON.stringify({ model: 'sonnet' }));
  });

  test('builds merged timeline with stored, review, and agent-history events', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'evt-1',
          task_id: 'task-1',
          event_type: 'session.spawned',
          title: 'Spawned task session',
          description: 'Started a new session',
          session_key: 'agent:main:test',
          actor: 'sub-agent',
          harness: 'hermes',
          metadata: { model: 'sonnet' },
          created_at: new Date('2026-04-22T00:00:00.000Z'),
        },
      ],
    });
    (agentHistoryService.findByTaskId as jest.Mock).mockResolvedValueOnce([
      {
        name: 'sub-agent',
        label: 'Respawned run',
        sessionKey: 'agent:main:respawn',
        taskId: 'task-1',
        startedAt: '2026-04-22T01:00:00.000Z',
        completedAt: '2026-04-22T01:30:00.000Z',
        outcome: 'completed',
      },
    ]);

    const events = await taskTimelineService.buildTimeline({
      id: 'task-1',
      title: 'Timeline task',
      description: '',
      status: 'review',
      priority: 'normal',
      subtasks: [],
      links: [],
      sessionRefs: ['legacy-session'],
      autoCreated: false,
      autoStart: true,
      blockedBy: [],
      tags: [],
      created: '2026-04-21T00:00:00.000Z',
      updated: '2026-04-22T02:00:00.000Z',
      reviewHistory: [
        {
          id: 'review-1',
          decision: 'reject',
          summary: 'Missing test evidence',
          triggeredBy: 'system',
          createdAt: '2026-04-22T02:30:00.000Z',
          completedAt: '2026-04-22T02:30:00.000Z',
          findings: [],
          evidence: { successCriteria: [], reports: [], sessionRefs: [] },
        },
      ],
    } as any);

    expect(events.map((event) => event.title)).toEqual([
      'Automated reviewer rejected task',
      'Legacy session reference',
      'Session finished',
      'Spawned session',
      'Spawned task session',
    ]);
    expect(events[0].source).toBe('review-history');
    expect(events[1].source).toBe('legacy');
    expect(events[2].source).toBe('agent-history');
    expect(events[4].source).toBe('timeline');
  });

  test('normalizes legacy reviewer history entries into durable timeline events', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    (agentHistoryService.findByTaskId as jest.Mock).mockResolvedValueOnce([]);

    const events = await taskTimelineService.buildTimeline({
      id: 'task-legacy',
      title: 'Legacy review task',
      description: '',
      status: 'in-progress',
      priority: 'normal',
      subtasks: [],
      links: [],
      sessionRefs: [],
      autoCreated: false,
      autoStart: true,
      blockedBy: [],
      tags: [],
      created: '2026-04-22T04:00:00.000Z',
      updated: '2026-04-22T05:00:00.000Z',
      reviewHistory: [
        {
          at: '2026-04-22T04:30:00.000Z',
          actor: { triggeredBy: 'system' },
          details: 'Automated review requires task.successCriteria to be defined.',
          outcome: 'needs_human_review',
          summary: 'Missing success criteria',
          attemptCount: 0,
        },
      ],
    } as any);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'review.escalate',
      title: 'Automated reviewer escalated task',
      description: 'Missing success criteria',
      createdAt: '2026-04-22T04:30:00.000Z',
      actor: 'system',
      source: 'review-history',
    });
    expect(events[0].metadata).toMatchObject({
      decision: 'escalate',
      outcome: 'needs_human_review',
      attemptCount: 0,
    });
  });
});
