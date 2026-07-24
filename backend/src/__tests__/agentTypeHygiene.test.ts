// agentTypeHygiene.test.ts — ClawBoard task c8f4dd95 (persona registry hygiene)
//
// Covers:
//   * PROVENANCE backfill: syncFromRepo() stamps source='git' on every row it
//     upserts from the agency-agents repo manifest (INSERT and ON CONFLICT).
//   * SAFE RETIRE: retireDuplicate() repoints every task AND session that
//     references the loser to the canonical winner — across ALL statuses,
//     including archived — then soft-deletes the loser (retired_at set, row
//     preserved). Idempotent when loser is absent / already retired.
//   * DOCTOR no longer errors on names: list() excludes retired rows, so the
//     duplicate-persona-name check (re-implemented here over the live listing)
//     finds one live persona per name.
//
// Uses an in-memory SQL-dispatching mock of the pg pool, matching the pattern in
// dependencyIntegrity.test.ts. No real database or filesystem repo is touched;
// the repo directory is faked via fs mocks so syncFromRepo() reads fixtures.

import * as fs from 'fs';

// ---- in-memory store ------------------------------------------------------
interface ATRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  color: string | null;
  content: string | null;
  source_file: string | null;
  is_custom: boolean;
  source: string;
  retired_at: string | null;
  retired_reason: string | null;
  retired_in_favor_of: string | null;
}
interface RefRow { id: string; agent_type_id: string | null; status: string }

let agentTypes: ATRow[] = [];
let tasks: RefRow[] = [];
let sessions: RefRow[] = [];
let idSeq = 0;

function newRow(partial: Partial<ATRow>): ATRow {
  return {
    id: `id-${++idSeq}`,
    slug: '',
    name: '',
    description: null,
    category: null,
    color: null,
    content: null,
    source_file: null,
    is_custom: false,
    source: 'legacy-db',
    retired_at: null,
    retired_reason: null,
    retired_in_favor_of: null,
    ...partial,
  };
}

// ---- SQL dispatcher -------------------------------------------------------
function dispatch(sql: any, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
  const text = (typeof sql === 'string' ? sql : sql?.text || '').trim();
  const ok = (rows: any[] = []) => Promise.resolve({ rows, rowCount: rows.length });

  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return ok();

  // sync upsert
  if (text.startsWith('INSERT INTO agent_types (slug')) {
    const [slug, name, description, category, color, content, source_file] = params;
    const existing = agentTypes.find(r => r.slug === slug);
    if (existing) {
      if (existing.retired_at !== null) return ok();
      Object.assign(existing, { name, description, category, color, content, source_file, source: 'git' });
      return ok([{ slug }]);
    }
    agentTypes.push(newRow({ slug, name, description, category, color, content, source_file, is_custom: false, source: 'git' }));
    return ok([{ slug }]);
  }

  // list()  — SELECT ... FROM agent_types [WHERE ...] ORDER BY category, name
  if (text.startsWith('SELECT id, slug, name, description, category, color, is_custom, source, retired_at FROM agent_types')) {
    let rows = agentTypes.slice();
    if (/retired_at IS NULL/.test(text)) rows = rows.filter(r => r.retired_at === null);
    // optional category filter is the last positional param
    if (/category = \$/.test(text)) {
      const cat = params[params.length - 1];
      rows = rows.filter(r => r.category === cat);
    }
    return ok(rows.map(r => ({
      id: r.id, slug: r.slug, name: r.name, description: r.description,
      category: r.category, color: r.color, is_custom: r.is_custom,
      source: r.source, retired_at: r.retired_at,
    })));
  }

  // retireDuplicate lookups
  if (text.startsWith('SELECT id, retired_at FROM agent_types WHERE slug')) {
    const r = agentTypes.find(a => a.slug === params[0]);
    return ok(r ? [{ id: r.id, retired_at: r.retired_at }] : []);
  }
  if (text.startsWith('SELECT id FROM agent_types WHERE slug')) {
    const r = agentTypes.find(a => a.slug === params[0]);
    return ok(r ? [{ id: r.id }] : []);
  }

  // repoints
  if (text.startsWith('UPDATE tasks SET agent_type_id')) {
    const [winnerId, loserId] = params;
    let n = 0;
    for (const t of tasks) if (t.agent_type_id === loserId) { t.agent_type_id = winnerId; n++; }
    return Promise.resolve({ rows: [], rowCount: n });
  }
  if (text.startsWith('UPDATE sessions SET agent_type_id')) {
    const [winnerId, loserId] = params;
    let n = 0;
    for (const s of sessions) if (s.agent_type_id === loserId) { s.agent_type_id = winnerId; n++; }
    return Promise.resolve({ rows: [], rowCount: n });
  }

  // soft-delete
  if (text.startsWith('UPDATE agent_types')) {
    const [loserId, reason, winnerId] = params;
    const r = agentTypes.find(a => a.id === loserId);
    if (r) { r.retired_at = '2026-07-04T00:00:00.000Z'; r.retired_reason = reason; r.retired_in_favor_of = winnerId; }
    return Promise.resolve({ rows: [], rowCount: r ? 1 : 0 });
  }

  if (text.startsWith('SELECT DISTINCT category')) {
    const cats = Array.from(new Set(agentTypes.filter(r => r.retired_at === null && r.category).map(r => r.category)));
    return ok(cats.map(c => ({ category: c })));
  }

  throw new Error('unhandled SQL in test: ' + text.slice(0, 80));
}

const mockClient = { query: (s: any, p?: any[]) => dispatch(s, p), release: jest.fn() };
jest.mock('../db/connection', () => ({
  pool: {
    query: (s: any, p?: any[]) => dispatch(s, p),
    connect: jest.fn(() => Promise.resolve(mockClient)),
  },
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(() => ({ isDirectory: () => true })),
  readFileSync: jest.fn(),
}));

import { agentTypeService } from '../services/AgentTypeService';

const REPO = '/fake/agency-agents';

// Minimal fake repo. Optionally include the source files for retired duplicate
// slugs to reproduce a real agency-agents sync cycle.
function stubRepo(includeRetiredFiles = false) {
  const files: Record<string, string[]> = {
    [REPO]: includeRetiredFiles ? ['engineering', 'support'] : ['engineering'],
    [`${REPO}/engineering`]: [
      'engineering-openclaw-plugin-dev.md',
      'engineering-technical-writer.md',
      ...(includeRetiredFiles ? ['openclaw-plugin-dev.md'] : []),
    ],
    [`${REPO}/support`]: includeRetiredFiles ? ['support-technical-writer.md'] : [],
  };
  (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === REPO);
  (fs.readdirSync as jest.Mock).mockImplementation((p: string) => files[p] || []);
  (fs.readFileSync as jest.Mock).mockImplementation((p: string) => {
    if (String(p).includes('openclaw-plugin-dev')) {
      return '---\nname: OpenClaw Plugin Developer\ndescription: canonical\ncolor: purple\n---\nbody';
    }
    return '---\nname: Technical Writer\ndescription: canonical\ncolor: teal\n---\nbody';
  });
}

/** Re-implementation of clawboard doctor's duplicate-persona-name check. */
function duplicateNameErrors(rows: Array<{ name: string }>): string[] {
  const byName = new Map<string, number>();
  for (const r of rows) {
    const k = (r.name || '').trim().toLowerCase();
    if (k) byName.set(k, (byName.get(k) || 0) + 1);
  }
  return [...byName.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

beforeEach(() => {
  agentTypes = [];
  tasks = [];
  sessions = [];
  idSeq = 0;
});

describe('provenance backfill via sync', () => {
  test('syncFromRepo stamps source=git on inserted rows', async () => {
    stubRepo();
    const res = await agentTypeService.syncFromRepo(REPO);
    expect(res.synced).toBe(2);
    expect(agentTypes.every(r => r.source === 'git')).toBe(true);
    expect(agentTypes.map(r => r.slug).sort()).toEqual([
      'engineering-openclaw-plugin-dev', 'engineering-technical-writer',
    ]);
  });

  test('re-syncing an existing legacy-db row promotes it to source=git', async () => {
    // Pre-existing row with the same slug but source=legacy-db and no source_file.
    agentTypes.push(newRow({
      slug: 'engineering-technical-writer', name: 'Technical Writer',
      category: 'engineering', source: 'legacy-db', source_file: null,
    }));
    stubRepo();
    await agentTypeService.syncFromRepo(REPO);
    const row = agentTypes.find(r => r.slug === 'engineering-technical-writer')!;
    expect(row.source).toBe('git');
    expect(row.source_file).toBe('engineering/engineering-technical-writer.md');
  });
});

describe('safe retire of duplicate personas', () => {
  function seedDuplicates() {
    const winnerW = newRow({ slug: 'engineering-openclaw-plugin-dev', name: 'OpenClaw Plugin Developer', category: 'engineering', source: 'git' });
    const loserW = newRow({ slug: 'openclaw-plugin-dev', name: 'OpenClaw Plugin Developer', category: 'engineering', source: 'legacy-db' });
    const winnerT = newRow({ slug: 'engineering-technical-writer', name: 'Technical Writer', category: 'engineering', source: 'git' });
    const loserT = newRow({ slug: 'support-technical-writer', name: 'Technical Writer', category: 'support', source: 'git' });
    agentTypes.push(winnerW, loserW, winnerT, loserT);
    // Loser refs across statuses: archived task on openclaw loser, live todo + a session on TW loser.
    tasks.push({ id: 'task-archived', agent_type_id: loserW.id, status: 'archived' });
    tasks.push({ id: 'task-todo', agent_type_id: loserT.id, status: 'todo' });
    sessions.push({ id: 'sess-1', agent_type_id: loserT.id, status: 'ended' });
    return { winnerW, loserW, winnerT, loserT };
  }

  test('repoints task+session refs (incl. archived) and soft-deletes loser', async () => {
    const { winnerW, loserW, winnerT, loserT } = seedDuplicates();

    const r1 = await agentTypeService.retireDuplicate('openclaw-plugin-dev', 'engineering-openclaw-plugin-dev');
    expect(r1).toMatchObject({ tasksRepointed: 1, sessionsRepointed: 0 });
    const r2 = await agentTypeService.retireDuplicate('support-technical-writer', 'engineering-technical-writer');
    expect(r2).toMatchObject({ tasksRepointed: 1, sessionsRepointed: 1 });

    // Archived task now points at the winner (no persona lost).
    expect(tasks.find(t => t.id === 'task-archived')!.agent_type_id).toBe(winnerW.id);
    expect(tasks.find(t => t.id === 'task-todo')!.agent_type_id).toBe(winnerT.id);
    expect(sessions.find(s => s.id === 'sess-1')!.agent_type_id).toBe(winnerT.id);

    // Losers soft-deleted, rows preserved and annotated; winners untouched.
    expect(loserW.retired_at).not.toBeNull();
    expect(loserW.retired_in_favor_of).toBe(winnerW.id);
    expect(loserT.retired_at).not.toBeNull();
    expect(loserT.retired_in_favor_of).toBe(winnerT.id);
    expect(winnerW.retired_at).toBeNull();
    expect(winnerT.retired_at).toBeNull();
    // No hard delete.
    expect(agentTypes.filter(r => r.retired_at !== null).length).toBe(2);
  });

  test('retireDuplicate is idempotent / safe when absent or already retired', async () => {
    seedDuplicates();
    await agentTypeService.retireDuplicate('openclaw-plugin-dev', 'engineering-openclaw-plugin-dev');
    // second call is a no-op (already retired)
    expect(await agentTypeService.retireDuplicate('openclaw-plugin-dev', 'engineering-openclaw-plugin-dev')).toBeNull();
    // unknown loser
    expect(await agentTypeService.retireDuplicate('does-not-exist', 'engineering-technical-writer')).toBeNull();
    // missing winner
    expect(await agentTypeService.retireDuplicate('support-technical-writer', 'no-such-winner')).toBeNull();
  });

  test('doctor duplicate-name check has zero errors after retire (list excludes retired)', async () => {
    seedDuplicates();

    const before = await agentTypeService.list();
    expect(duplicateNameErrors(before).sort()).toEqual(['openclaw plugin developer', 'technical writer']);

    await agentTypeService.retireDuplicate('openclaw-plugin-dev', 'engineering-openclaw-plugin-dev');
    await agentTypeService.retireDuplicate('support-technical-writer', 'engineering-technical-writer');

    const after = await agentTypeService.list();
    expect(duplicateNameErrors(after)).toEqual([]);
    // Retired rows still resolvable via includeRetired for historical display.
    const withRetired = await agentTypeService.list(undefined, true);
    expect(withRetired.length).toBe(before.length);
    expect(after.length).toBe(before.length - 2);
  });

  test('repo sync cannot resurrect retired slugs whose source files still exist', async () => {
    const { loserW, loserT } = seedDuplicates();
    await agentTypeService.retireDuplicate('openclaw-plugin-dev', 'engineering-openclaw-plugin-dev');
    await agentTypeService.retireDuplicate('support-technical-writer', 'engineering-technical-writer');
    const retiredState = [loserW, loserT].map(row => ({
      slug: row.slug,
      retired_at: row.retired_at,
      retired_reason: row.retired_reason,
      retired_in_favor_of: row.retired_in_favor_of,
      source_file: row.source_file,
    }));

    stubRepo(true);
    const result = await agentTypeService.syncFromRepo(REPO);

    expect(result).toEqual({ synced: 2, errors: 0 });
    expect([loserW, loserT].map(row => ({
      slug: row.slug,
      retired_at: row.retired_at,
      retired_reason: row.retired_reason,
      retired_in_favor_of: row.retired_in_favor_of,
      source_file: row.source_file,
    }))).toEqual(retiredState);
    expect(duplicateNameErrors(await agentTypeService.list())).toEqual([]);
  });
});
