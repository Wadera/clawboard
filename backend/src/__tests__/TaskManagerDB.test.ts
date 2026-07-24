import { TaskManagerDB } from '../services/TaskManagerDB';

const mockQuery = jest.fn();

jest.mock('../db/connection', () => ({
  pool: {
    query: (...args: any[]) => mockQuery(...args),
    connect: jest.fn(),
  },
}));

const baseRow = {
  id: '1ad5375c-2f1d-4768-a71c-864f6edfeee7',
  title: 'Dependency picker fix',
  description: 'Fix dependency search',
  status: 'todo',
  priority: 'high',
  project_id: null,
  thinking_budget: 'high',
  thinking_auto_estimated: false,
  model: null,
  execution_mode: 'interactive',
  auto_created: false,
  auto_start: true,
  blocked_reason: null,
  status_reason: null,
  active_agent: null,
  completed_by: null,
  attempt_count: 0,
  session_refs: [],
  parent_id: null,
  agent_type_id: null,
  created_at: '2026-04-10T00:00:00.000Z',
  updated_at: '2026-04-10T00:00:00.000Z',
  started_at: null,
  completed_at: null,
  archived_at: null,
  at_slug: null,
  at_name: null,
  at_color: null,
  at_category: null,
};

describe('TaskManagerDB queryTasks search', () => {
  let taskManager: TaskManagerDB;

  beforeEach(() => {
    taskManager = new TaskManagerDB();
    mockQuery.mockReset();
  });

  function mockHydrateQueries() {
    mockQuery
      .mockResolvedValueOnce({ rows: [baseRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
  }

  test('searches by title fragments, excludes the current task, and ranks exact matches first', async () => {
    mockHydrateQueries();

    const tasks = await taskManager.queryTasks({
      q: 'dependency picker',
      excludeTaskId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      limit: 12,
    });

    expect(tasks).toHaveLength(1);

    const [query, params] = mockQuery.mock.calls[0];
    expect(query).toContain('t.status <> \'archived\'');
    expect(query).toContain('t.title ILIKE');
    expect(query).toContain('t.id::text ILIKE');
    expect(query).toContain('REPLACE(LOWER(t.id::text), \'-\', \'\') LIKE');
    expect(query).toContain('LEFT(REPLACE(LOWER(t.id::text), \'-\', \'\'), 8)');
    expect(query).toContain('LOWER(t.title) =');
    expect(query).toContain('t.id <>');
    expect(query).toContain('LIMIT 12');
    expect(params).toEqual([
      '%dependency picker%',
      '%dependency picker%',
      'dependency picker',
      'dependency picker',
      'dependen',
      'dependency picker',
      'dependency picker%',
      '%dependency picker%',
      'dependency picker%',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ]);
  });

  test('normalizes hyphenless and short id searches', async () => {
    mockHydrateQueries();

    await taskManager.queryTasks({ q: '1ad5375c2f1d4768a71c864f6edfeee7', limit: 5 });

    let [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe('%1ad5375c2f1d4768a71c864f6edfeee7%');
    expect(params[1]).toBe('%1ad5375c2f1d4768a71c864f6edfeee7%');
    expect(params[2]).toBe('1ad5375c2f1d4768a71c864f6edfeee7');
    expect(params[3]).toBe('1ad5375c2f1d4768a71c864f6edfeee7');
    expect(params[4]).toBe('1ad5375c');

    mockQuery.mockReset();
    mockHydrateQueries();

    await taskManager.queryTasks({ q: '1ad5375c', limit: 5 });

    [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe('%1ad5375c%');
    expect(params[1]).toBe('%1ad5375c%');
    expect(params[2]).toBe('1ad5375c');
    expect(params[3]).toBe('1ad5375c');
    expect(params[4]).toBe('1ad5375c');
  });
});
