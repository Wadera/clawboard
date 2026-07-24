import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

// HermesRuntime reads its path constants from the environment at module load,
// so the fixture tree and env vars must exist BEFORE the module is imported.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-launch-'));
const binaryPath = path.join(tmpRoot, 'hermes');
const homePath = path.join(tmpRoot, 'home');
const runLogDir = path.join(tmpRoot, 'runs');
const stateDbPath = path.join(tmpRoot, 'state.db'); // intentionally never created
const workDir = path.join(tmpRoot, 'work');

fs.writeFileSync(binaryPath, '#!/bin/sh\n');
fs.mkdirSync(path.join(homePath, '.hermes'), { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

process.env.HERMES_BINARY_PATH = binaryPath;
process.env.HERMES_HOME_PATH = homePath;
process.env.HERMES_RUN_LOG_DIR = runLogDir;
process.env.HERMES_STATE_DB_PATH = stateDbPath;
process.env.HERMES_TASK_CWD = workDir;
delete process.env.HERMES_SESSION_SOURCE;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { launchHermesTurn, buildHermesSourceTag } = require('../services/HermesRuntime');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile, spawn } = require('child_process');

const TASK_ID = 'd825502e-3f05-4368-87e4-90825e98a63c';
const SOURCE_TAG = buildHermesSourceTag(TASK_ID);

type StateResponder = (op: string, arg: string) => any[];

function mockHermesState(responder: StateResponder): void {
  (execFile as jest.Mock).mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
    // args = ['-c', script, dbPath, operation, arg]
    cb(null, { stdout: JSON.stringify(responder(args[3], args[4] || '')) });
  });
}

describe('launchHermesTurn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (spawn as jest.Mock).mockReturnValue({ pid: 4242, unref: jest.fn() });
  });

  it('returns a resolved launch when the session row appears in the quick poll', async () => {
    const row = { id: '20260703_120000_ab12cd', source: SOURCE_TAG, started_at: Math.floor(Date.now() / 1000) };
    mockHermesState((op) => (op === 'findBySource' ? [row] : []));

    const result = await launchHermesTurn({ taskId: TASK_ID, prompt: 'do the thing' });

    expect(result.provisional).toBe(false);
    expect(result.sessionId).toBe('20260703_120000_ab12cd');
    expect(result.sessionKey).toBe('hermes:tool:20260703_120000_ab12cd');
    expect(result.sourceTag).toBe(SOURCE_TAG);
    expect(result.pid).toBe(4242);
    expect(typeof result.spawnedAtUnix).toBe('number');
  });

  it('resolves provisionally instead of throwing when registration is slow', async () => {
    mockHermesState(() => []);

    const result = await launchHermesTurn({ taskId: TASK_ID, prompt: 'do the thing' });

    expect(result.provisional).toBe(true);
    expect(result.sessionId).toBeNull();
    expect(result.sessionKey).toBe('pending');
    expect(result.sourceTag).toBe(SOURCE_TAG);
    expect(result.pid).toBe(4242);
    expect(result.logPath).toContain(runLogDir);
    expect(typeof result.spawnedAtUnix).toBe('number');
  }, 20000);

  it('still throws when the child process starts without a PID', async () => {
    mockHermesState(() => []);
    (spawn as jest.Mock).mockReturnValue({ pid: undefined, unref: jest.fn() });

    await expect(launchHermesTurn({ taskId: TASK_ID, prompt: 'do the thing' }))
      .rejects.toThrow('Hermes process started without a PID');
  });

  it('tags the child via --source only, never via HERMES_SESSION_SOURCE in the env', async () => {
    // hermes exports HERMES_SESSION_SOURCE internally from --source. Setting it
    // in the child env as well would be inherited by nested hermes runs the
    // task's agent launches, tagging unrelated sessions with this source tag.
    const row = { id: '20260703_120001_ff00aa', source: SOURCE_TAG, started_at: Math.floor(Date.now() / 1000) };
    mockHermesState((op) => (op === 'findBySource' ? [row] : []));

    await launchHermesTurn({ taskId: TASK_ID, prompt: 'do the thing' });

    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = (spawn as jest.Mock).mock.calls[0][1];
    const sourceFlagIndex = spawnArgs.indexOf('--source');
    expect(sourceFlagIndex).toBeGreaterThan(-1);
    expect(spawnArgs[sourceFlagIndex + 1]).toBe(SOURCE_TAG);

    const spawnOptions = (spawn as jest.Mock).mock.calls[0][2];
    expect(spawnOptions.env.HERMES_SESSION_SOURCE).toBeUndefined();
  });
});
