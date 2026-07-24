// SessionMessageRepository.test.ts
// Tests insert() and bulkInsert() performance: 1000 messages under 500ms
// Uses mocked pg pool — no live DB required.

import { SessionMessageRepository } from '../services/SessionMessageRepository';
import { NewSessionMessage } from '../types/SessionMessage';

// --- Mock pg pool ---
const insertedRows: any[] = [];
let callCount = 0;

const mockQuery = jest.fn(async (sql: string, params?: any[]) => {
  if (sql.trim().startsWith('BEGIN') || sql.trim().startsWith('COMMIT') || sql.trim().startsWith('ROLLBACK')) {
    return { rows: [], rowCount: 0 };
  }
  if (sql.trim().toUpperCase().startsWith('INSERT')) {
    // Count rows from VALUES clauses: count $1 occurrences in first group
    // Each row has 12 columns, so rowCount = params.length / 12
    const colCount = 12;
    const rowCount = params ? Math.floor(params.length / colCount) : 1;
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: `uuid-${++callCount}-${i}`,
      session_id: params?.[0] ?? 'test-session',
      session_key: null,
      ordinal: i,
      role: 'user',
      content: 'test',
      tool_name: null,
      tool_call_id: null,
      thinking: null,
      tokens_in: null,
      tokens_out: null,
      created_at: new Date(),
      metadata: null,
    }));
    insertedRows.push(...rows);
    return { rows, rowCount };
  }
  return { rows: [], rowCount: 0 };
});

const mockClient = {
  query: mockQuery,
  release: jest.fn(),
};

jest.mock('../db/connection', () => ({
  pool: {
    query: (sql: string, params?: any[]) => mockQuery(sql, params),
    connect: jest.fn(async () => mockClient),
  },
}));

// ---------------------------------------------------------------

function makeMessage(sessionId: string, i: number): NewSessionMessage {
  return {
    session_id: sessionId,
    session_key: 'test-key',
    ordinal: i,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message number ${i} — some realistic content here.`,
    tokens_in: 10 + i,
    tokens_out: 20 + i,
    metadata: { model: 'anthropic/claude-sonnet-4-6', finish_reason: 'end_turn' },
  };
}

describe('SessionMessageRepository', () => {
  let repo: SessionMessageRepository;

  beforeEach(() => {
    repo = new SessionMessageRepository();
    insertedRows.length = 0;
    mockQuery.mockClear();
    callCount = 0;
  });

  // ── Single insert ──────────────────────────────────────────────
  it('insert() persists a single message', async () => {
    const msg = makeMessage('session-abc', 0);
    const result = await repo.insert(msg);
    expect(result).toBeDefined();
    expect(result.id).toBeDefined();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // ── Bulk insert 1000 messages under 500ms ─────────────────────
  it('bulkInsert() inserts 1000 messages in under 500ms', async () => {
    const messages = Array.from({ length: 1000 }, (_, i) =>
      makeMessage('session-perf', i)
    );

    const start = Date.now();
    const result = await repo.bulkInsert(messages);
    const elapsed = Date.now() - start;

    expect(result.inserted).toBe(1000);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(500);

    console.log(`✅ bulkInsert(1000): ${elapsed}ms wall / ${result.duration_ms}ms internal`);
  });

  // ── Batching: >500 messages splits into multiple INSERT calls ──
  it('bulkInsert() splits batches correctly for > 500 messages', async () => {
    const messages = Array.from({ length: 1000 }, (_, i) =>
      makeMessage('session-batch', i)
    );

    const result = await repo.bulkInsert(messages);
    expect(result.inserted).toBe(1000);

    // Expect BEGIN + 2 INSERT batches (500 each) + COMMIT
    const insertCalls = mockQuery.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.trim().toUpperCase().startsWith('INSERT')
    );
    expect(insertCalls.length).toBe(2);
  });

  // ── Empty bulk insert ─────────────────────────────────────────
  it('bulkInsert() handles empty array', async () => {
    const result = await repo.bulkInsert([]);
    expect(result.inserted).toBe(0);
    expect(result.duration_ms).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ── getBySession: verifies SELECT SQL ─────────────────────────
  it('getBySession() queries by session_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.getBySession('session-xyz');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('session_id = $1');
    expect(params?.[0]).toBe('session-xyz');
  });

  // ── getByKey: verifies session_key path ───────────────────────
  it('getByKey() queries by session_key', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.getByKey('my-session-key');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('session_key = $1');
    expect(params?.[0]).toBe('my-session-key');
  });

  // ── role filter ───────────────────────────────────────────────
  it('getBySession() filters by role', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.getBySession('session-xyz', { role: 'tool' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('role = $');
    expect(params).toContain('tool');
  });
});
