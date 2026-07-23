import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

// HermesRuntime reads its path constants from the environment at module load,
// so the fixture tree and env vars must exist BEFORE the module is imported.
// state.db must exist so the gated 'get'/'list' operations reach the mocked
// python subprocess instead of short-circuiting to [].
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-resolve-'));
const stateDbPath = path.join(tmpRoot, 'state.db');
fs.writeFileSync(stateDbPath, '');

process.env.HERMES_STATE_DB_PATH = stateDbPath;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveLaunchedHermesSession } = require('../services/HermesRuntime');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile } = require('child_process');

const SOURCE_TAG = 'tool-task-d825502e';
const SPAWNED_AT = 1_751_500_000;

type StateResponder = (op: string, arg: string) => any[];

function mockHermesState(responder: StateResponder): void {
  (execFile as jest.Mock).mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
    // args = ['-c', script, dbPath, operation, arg]
    cb(null, { stdout: JSON.stringify(responder(args[3], args[4] || '')) });
  });
}

function seenOperations(): string[] {
  return (execFile as jest.Mock).mock.calls.map((call) => call[1][3]);
}

function seenDbPaths(): string[] {
  return (execFile as jest.Mock).mock.calls.map((call) => call[1][2]);
}

describe('resolveLaunchedHermesSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    // The reconciler must ALWAYS query the container-private (writable-side)
    // HERMES_STATE_DB_PATH — never the read-only live-view mount
    // (HERMES_READ_STATE_DB_PATH), where task-spawned sessions never appear.
    for (const dbPath of seenDbPaths()) {
      expect(dbPath).toBe(stateDbPath);
    }
  });

  it('resolves via the source tag when Hermes recorded it', async () => {
    const row = { id: '20260703_120000_ab12cd', source: SOURCE_TAG, started_at: SPAWNED_AT + 10 };
    mockHermesState((op) => (op === 'findBySource' ? [row] : []));

    const resolved = await resolveLaunchedHermesSession(SOURCE_TAG, SPAWNED_AT, '/nonexistent.log');

    expect(resolved).toEqual(row);
    expect(seenOperations()).toEqual(['findBySource']);
  });

  it('picks the OLDEST matching row when multiple sessions carry the source tag', async () => {
    // Nested hermes runs inherit HERMES_SESSION_SOURCE and register AFTER the
    // root turn, so with findBySource ordering newest-first the root turn is
    // the LAST (oldest) row — a newest-first pick would bind the nested run.
    const rootRow = { id: '20260703_120000_ab12cd', source: SOURCE_TAG, started_at: SPAWNED_AT + 5 };
    const nestedRow = { id: '20260703_121500_ee66aa', source: SOURCE_TAG, started_at: SPAWNED_AT + 900 };
    mockHermesState((op) => (op === 'findBySource' ? [nestedRow, rootRow] : []));

    const resolved = await resolveLaunchedHermesSession(SOURCE_TAG, SPAWNED_AT, '/nonexistent.log');

    expect(resolved).toEqual(rootRow);
    expect(seenOperations()).toEqual(['findBySource']);
  });

  it('falls back to the session_id line in the run log when the source misses', async () => {
    const logPath = path.join(tmpRoot, 'run.log');
    fs.writeFileSync(logPath, 'Final response text\nsession_id: 20260703_120000_ab12cd\n');
    const row = { id: '20260703_120000_ab12cd', source: 'cli', started_at: SPAWNED_AT + 10 };
    mockHermesState((op, arg) => (op === 'get' && arg === '20260703_120000_ab12cd' ? [row] : []));

    const resolved = await resolveLaunchedHermesSession(SOURCE_TAG, SPAWNED_AT, logPath);

    expect(resolved).toEqual(row);
    expect(seenOperations()).toEqual(['findBySource', 'get']);
  });

  it('does NOT bind a single unattributed recent row (unfiltered fallback removed)', async () => {
    // A lone new row with a foreign source could be a concurrent task spawn or
    // a user CLI/Discord chat: binding it mis-attributes the task. The old
    // "exactly one new row" fallback must stay deleted.
    const row = { id: '20260703_120500_cc44ee', source: 'cli', started_at: SPAWNED_AT + 20 };
    const oldRow = { id: '20260601_090000_aa11bb', source: 'cli', started_at: SPAWNED_AT - 5000 };
    mockHermesState((op) => (op === 'list' ? [row, oldRow] : []));

    const resolved = await resolveLaunchedHermesSession(SOURCE_TAG, SPAWNED_AT, '/nonexistent.log');

    expect(resolved).toBeNull();
    expect(seenOperations()).toEqual(['findBySource']);
    expect(seenOperations()).not.toContain('list');
  });

  it('returns null when neither the source tag nor the run log resolves', async () => {
    const rows = [
      { id: '20260703_120500_cc44ee', source: 'cli', started_at: SPAWNED_AT + 20 },
      { id: '20260703_120501_dd55ff', source: 'cli', started_at: SPAWNED_AT + 21 },
    ];
    mockHermesState((op) => (op === 'list' ? rows : []));

    const resolved = await resolveLaunchedHermesSession(SOURCE_TAG, SPAWNED_AT, '/nonexistent.log');

    expect(resolved).toBeNull();
    expect(seenOperations()).toEqual(['findBySource']);
  });
});
