jest.mock('../db/connection', () => ({
  pool: { query: jest.fn().mockRejectedValue(new Error('no db in tests')) },
}));
jest.mock('../services/websocket', () => ({ WebSocketService: class {} }));

// chokidar v4 ships ESM only, which ts-jest cannot parse. Replace it with a
// fake watcher that records watched paths and lets tests emit events, so the
// config-watch / configDirty / reload path is actually exercised.
type WatchHandler = (...args: any[]) => void;
interface FakeWatcher {
  paths: string[];
  on(event: string, cb: WatchHandler): FakeWatcher;
  emit(event: string, ...args: any[]): void;
  close: jest.Mock;
}
const mockWatchInstances: FakeWatcher[] = [];
jest.mock('chokidar', () => ({
  __esModule: true,
  default: {
    watch: jest.fn((paths: any) => {
      const handlers: Record<string, WatchHandler[]> = {};
      const watcher: FakeWatcher = {
        paths: Array.isArray(paths) ? paths : [paths],
        on(event: string, cb: WatchHandler) {
          (handlers[event] = handlers[event] || []).push(cb);
          return watcher;
        },
        emit(event: string, ...args: any[]) {
          (handlers[event] || []).forEach((cb) => cb(...args));
        },
        close: jest.fn(),
      };
      mockWatchInstances.push(watcher);
      return watcher;
    }),
  },
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ModelStatusService } from '../services/modelStatus';

const HOUR_AGO = Date.now() - 60 * 60 * 1000;

const CONFIG = {
  agents: { defaults: { model: { primary: 'litellm/gemini/gemini-3-flash-preview' } } },
};

const AUTH_PROFILES = {
  lastGood: { anthropic: 'anthropic:test-max-profile' },
};

// Post-2026.6.11 sessions.json: the legacy agent:main:main entry is frozen at
// its pre-upgrade values while agent:main:explicit:main is the live session.
// Shape mirrors the real frozen row on the live host, which DOES carry
// modelProvider ("codex-cli") alongside model ("gpt-5.4").
const FROZEN_LEGACY_ENTRY = {
  sessionId: '5b72fd84-21cb-4046-b213-5d3f87c4dc9b',
  model: 'gpt-5.4',
  modelProvider: 'codex-cli',
  updatedAt: HOUR_AGO - 60 * 60 * 1000,
  totalTokens: 411717,
  contextTokens: 200000,
  inputTokens: 400000,
  outputTokens: 11717,
};

const EXPLICIT_MAIN_ENTRY = {
  sessionId: 'main',
  model: 'gemini/gemini-3-flash-preview',
  modelProvider: 'litellm',
  updatedAt: HOUR_AGO,
  contextTokens: 128000,
  contextBudgetStatus: { estimatedPromptTokens: 23369, contextTokenBudget: 128000 },
};

function setupFixture(sessions: Record<string, any>, config: Record<string, any> = CONFIG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-status-'));
  const sessionsPath = path.join(dir, 'sessions.json');
  const configPath = path.join(dir, 'openclaw.json');
  const authProfilesPath = path.join(dir, 'auth-profiles.json');
  fs.writeFileSync(sessionsPath, JSON.stringify(sessions));
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(authProfilesPath, JSON.stringify(AUTH_PROFILES));
  // Pin auth profiles to the fixture so tests never read live host credentials
  // through the homedir fallback (host-state-dependent branches).
  process.env.OPENCLAW_AUTH_PROFILES_PATH = authProfilesPath;
  return { dir, sessionsPath, configPath, authProfilesPath };
}

function writeTranscript(dir: string, sessionId: string, mtimeMs: number) {
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, '{}\n');
  fs.utimesSync(transcriptPath, mtimeMs / 1000, mtimeMs / 1000);
}

async function createService(sessionsPath: string, configPath: string) {
  const service = new ModelStatusService(sessionsPath, configPath, { broadcast: jest.fn() } as any);
  await (service as any).loadDefaultModel();
  return service;
}

afterEach(() => {
  delete process.env.OPENCLAW_AUTH_PROFILES_PATH;
  delete process.env.USAGE_STATS_PATH;
  mockWatchInstances.length = 0;
});

describe('ModelStatusService with OpenClaw 2026.6.11 session store', () => {
  it('reads model and context from the live explicit:main entry, not the frozen legacy one', async () => {
    const { dir, sessionsPath, configPath } = setupFixture({
      'agent:main:main': FROZEN_LEGACY_ENTRY,
      'agent:main:explicit:main': EXPLICIT_MAIN_ENTRY,
    });
    writeTranscript(dir, 'main', HOUR_AGO);

    const service = await createService(sessionsPath, configPath);
    const status = await service.getStatus();

    expect(status).not.toBeNull();
    expect(status!.session.key).toBe('agent:main:explicit:main');
    expect(status!.model).toBe('litellm/gemini/gemini-3-flash-preview');
    expect(status!.modelAlias).toBe('Gemini 3 Flash');
    expect(status!.defaultModel).toBe('litellm/gemini/gemini-3-flash-preview');
    expect(status!.isOverride).toBe(false);
    expect(status!.contextUsage).toEqual({ used: 23369, max: 128000, percent: 18 });
    expect(status!.agentStatus).toBe('idle');
    expect(status!.authProfile).toEqual({
      name: 'test-max-profile',
      provider: 'anthropic',
      isAutoSelected: true,
    });
  });

  it('detects a working session from a fresh transcript mtime', async () => {
    const { dir, sessionsPath, configPath } = setupFixture({
      'agent:main:main': FROZEN_LEGACY_ENTRY,
      'agent:main:explicit:main': EXPLICIT_MAIN_ENTRY,
    });
    writeTranscript(dir, 'main', Date.now());

    const service = await createService(sessionsPath, configPath);
    const status = await service.getStatus();

    expect(status!.agentStatus).toBe('working');
  });

  it('marks provider usage stale when cron only touched an old failed snapshot', async () => {
    const { dir, sessionsPath, configPath } = setupFixture({
      'agent:main:explicit:main': EXPLICIT_MAIN_ENTRY,
    });
    writeTranscript(dir, 'main', HOUR_AGO);
    fs.writeFileSync(path.join(dir, 'usage-stats.json'), JSON.stringify({
      session: { label: '5h', percentLeft: 95, timeLeft: '1h 42m' },
      weekly: { label: 'Weekly', percentLeft: 94, timeLeft: '3d 10h' },
      updatedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
      checkedAt: new Date().toISOString(),
      dataAge: 4 * 24 * 60 * 60,
      source: 'openclaw-status',
      provider: 'openai-codex',
      failureClass: 'oauth_token_expired',
      statusReason: 'usage refresh failed: re-authenticate Codex; preserving previous snapshot',
    }));

    const service = await createService(sessionsPath, configPath);
    const status = await service.getStatus();

    expect(status!.usageStats).toEqual(expect.objectContaining({
      stale: true,
      source: 'openclaw-status',
      provider: 'openai-codex',
      failureClass: 'oauth_token_expired',
      statusReason: 'usage refresh failed: re-authenticate Codex; preserving previous snapshot',
    }));
    expect(status!.usageStats!.session!.label).toBe('5h');
    expect(status!.usageStats!.weekly!.label).toBe('Weekly');
  });

  it('keeps a fresh provider snapshot live when the current plan exposes only a weekly window', async () => {
    const { dir, sessionsPath, configPath } = setupFixture({
      'agent:main:explicit:main': EXPLICIT_MAIN_ENTRY,
    });
    writeTranscript(dir, 'main', HOUR_AGO);
    fs.writeFileSync(path.join(dir, 'usage-stats.json'), JSON.stringify({
      weekly: { label: 'Weekly', percentLeft: 80, timeLeft: '6d 1h' },
      updatedAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      dataAge: 0,
      source: 'hermes-codex-usage-api',
      provider: 'openai-codex',
      plan: 'pro',
      failureClass: null,
      statusReason: 'live OpenAI Codex usage via Hermes OAuth; 5h window not provided by the current plan',
    }));

    const service = await createService(sessionsPath, configPath);
    const status = await service.getStatus();

    expect(status!.usageStats).toEqual(expect.objectContaining({
      stale: false,
      session: undefined,
      weekly: { label: 'Weekly', percentLeft: 80, timeLeft: '6d 1h' },
      source: 'hermes-codex-usage-api',
      failureClass: null,
    }));
  });

  it('reads an isolated usage snapshot from USAGE_STATS_PATH', async () => {
    const { dir, sessionsPath, configPath } = setupFixture({
      'agent:main:explicit:main': EXPLICIT_MAIN_ENTRY,
    });
    writeTranscript(dir, 'main', HOUR_AGO);
    const isolatedPath = path.join(dir, 'usage-stats-dev.json');
    fs.writeFileSync(isolatedPath, JSON.stringify({
      session: { label: '5h', percentLeft: 85, timeLeft: '1h' },
      weekly: { label: 'Weekly', percentLeft: 95, timeLeft: '6d' },
      updatedAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      dataAge: 0,
      failureClass: 'oauth_token_expired',
      statusReason: 're-authenticate the OpenClaw Codex provider',
    }));
    process.env.USAGE_STATS_PATH = isolatedPath;

    const service = await createService(sessionsPath, configPath);
    const status = await service.getStatus();

    expect(status!.usageStats).toEqual(expect.objectContaining({
      stale: true,
      failureClass: 'oauth_token_expired',
      statusReason: 're-authenticate the OpenClaw Codex provider',
    }));
  });

  it('detects a working session from a fresh transcript lock file', async () => {
    const { dir, sessionsPath, configPath } = setupFixture({
      'agent:main:explicit:main': EXPLICIT_MAIN_ENTRY,
    });
    writeTranscript(dir, 'main', HOUR_AGO);
    fs.writeFileSync(path.join(dir, 'main.jsonl.lock'), '');

    const service = await createService(sessionsPath, configPath);
    const status = await service.getStatus();

    expect(status!.agentStatus).toBe('working');
  });

  it('falls back to the configured default model when the entry has no model', async () => {
    const { dir, sessionsPath, configPath } = setupFixture({
      'agent:main:explicit:main': { ...EXPLICIT_MAIN_ENTRY, model: undefined, modelProvider: undefined },
    });
    writeTranscript(dir, 'main', HOUR_AGO);

    const service = await createService(sessionsPath, configPath);
    const status = await service.getStatus();

    expect(status!.model).toBe('litellm/gemini/gemini-3-flash-preview');
    expect(status!.isOverride).toBe(false);
  });

  it('still supports pre-2026.6.11 stores via the legacy main:main entry', async () => {
    const { dir, sessionsPath, configPath } = setupFixture({
      'agent:main:main': FROZEN_LEGACY_ENTRY,
    });
    writeTranscript(dir, FROZEN_LEGACY_ENTRY.sessionId, HOUR_AGO);

    const service = await createService(sessionsPath, configPath);
    const status = await service.getStatus();

    expect(status!.session.key).toBe('agent:main:main');
    // The real legacy row carries modelProvider "codex-cli"; the resolved id
    // is provider-qualified but the alias strips it for display.
    expect(status!.model).toBe('codex-cli/gpt-5.4');
    expect(status!.modelAlias).toBe('gpt-5.4');
    // Legacy cumulative estimate: 411717 % 200000 = 11717
    expect(status!.contextUsage).toEqual({ used: 11717, max: 200000, percent: 6 });
    expect(status!.tokens.total).toBe(411717);
  });

  it('does not flag an override when only the codex-cli provider prefix differs from the default', async () => {
    const { dir, sessionsPath, configPath } = setupFixture(
      { 'agent:main:main': FROZEN_LEGACY_ENTRY },
      { agents: { defaults: { model: { primary: 'gpt-5.4' } } } },
    );
    writeTranscript(dir, FROZEN_LEGACY_ENTRY.sessionId, HOUR_AGO);

    const service = await createService(sessionsPath, configPath);
    const status = await service.getStatus();

    expect(status!.model).toBe('codex-cli/gpt-5.4');
    expect(status!.defaultModel).toBe('gpt-5.4');
    expect(status!.isOverride).toBe(false);
  });
});

describe('ModelStatusService config watching', () => {
  const NEW_CONFIG = {
    agents: { defaults: { model: { primary: 'anthropic/claude-opus-4-6' } } },
  };

  function neutralizeMtimeFallback(service: ModelStatusService, configPath: string) {
    // Pre-seed the polled mtime with the file's current value so a reload can
    // only come from the watcher's configDirty path, not the mtime fallback.
    (service as any).configMtimeMs = fs.statSync(configPath).mtimeMs;
  }

  // Fake timers do not advance real fs I/O — cycle the (unfaked) event loop
  // until the condition holds so in-flight readFile/stat promises inside
  // updateAndBroadcast can settle. Assertions after this still fail loudly
  // if the condition never became true.
  async function waitFor(predicate: () => boolean, maxIterations = 5000) {
    for (let i = 0; i < maxIterations; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async function startService(sessionsPath: string, configPath: string) {
    const broadcast = jest.fn();
    const service = new ModelStatusService(sessionsPath, configPath, { broadcast } as any);
    await service.start();
    // Let the initial updateAndBroadcast settle
    await waitFor(() => (service as any).lastStatus != null);
    return { service, broadcast };
  }

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('watches the OpenClaw config alongside sessions.json and usage-stats.json', async () => {
    const { dir, sessionsPath, configPath } = setupFixture({
      'agent:main:explicit:main': EXPLICIT_MAIN_ENTRY,
    });
    writeTranscript(dir, 'main', HOUR_AGO);

    const { service } = await startService(sessionsPath, configPath);
    try {
      expect(mockWatchInstances.length).toBeGreaterThan(0);
      const watched = mockWatchInstances[0].paths;
      expect(watched).toContain(sessionsPath);
      expect(watched).toContain(configPath);
    } finally {
      service.stop();
    }
  });

  it('reloads the default model when the watcher reports a config change', async () => {
    const { dir, sessionsPath, configPath } = setupFixture({
      'agent:main:explicit:main': EXPLICIT_MAIN_ENTRY,
    });
    writeTranscript(dir, 'main', HOUR_AGO);

    const { service, broadcast } = await startService(sessionsPath, configPath);
    try {
      expect((await service.getStatus())!.defaultModel).toBe('litellm/gemini/gemini-3-flash-preview');

      fs.writeFileSync(configPath, JSON.stringify(NEW_CONFIG));
      neutralizeMtimeFallback(service, configPath);
      mockWatchInstances[0].emit('change', configPath);
      await jest.advanceTimersByTimeAsync(600);
      await waitFor(() => (service as any).lastStatus?.defaultModel === 'anthropic/claude-opus-4-6');

      const status = await service.getStatus();
      expect(status!.defaultModel).toBe('anthropic/claude-opus-4-6');
      expect(status!.isOverride).toBe(true);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'model:status' })
      );
    } finally {
      service.stop();
    }
  });

  it('reloads the default model on a replace-style unlink/add event sequence', async () => {
    const { dir, sessionsPath, configPath } = setupFixture({
      'agent:main:explicit:main': EXPLICIT_MAIN_ENTRY,
    });
    writeTranscript(dir, 'main', HOUR_AGO);

    const { service } = await startService(sessionsPath, configPath);
    try {
      fs.writeFileSync(configPath, JSON.stringify(NEW_CONFIG));
      neutralizeMtimeFallback(service, configPath);
      mockWatchInstances[0].emit('unlink', configPath);
      mockWatchInstances[0].emit('add', configPath);
      await jest.advanceTimersByTimeAsync(600);
      await waitFor(() => (service as any).lastStatus?.defaultModel === 'anthropic/claude-opus-4-6');

      expect((await service.getStatus())!.defaultModel).toBe('anthropic/claude-opus-4-6');
    } finally {
      service.stop();
    }
  });

  it('reloads the default model via the mtime fallback poll when the watcher misses the event', async () => {
    const { dir, sessionsPath, configPath } = setupFixture({
      'agent:main:explicit:main': EXPLICIT_MAIN_ENTRY,
    });
    writeTranscript(dir, 'main', HOUR_AGO);

    const { service } = await startService(sessionsPath, configPath);
    try {
      fs.writeFileSync(configPath, JSON.stringify(NEW_CONFIG));
      // Force a different observed mtime even on coarse-grained filesystems.
      const bumped = (Date.now() + 5000) / 1000;
      fs.utimesSync(configPath, bumped, bumped);
      // No watcher event at all — only the 10s fallback interval runs.
      await jest.advanceTimersByTimeAsync(10_500);
      await waitFor(() => (service as any).lastStatus?.defaultModel === 'anthropic/claude-opus-4-6');

      expect((await service.getStatus())!.defaultModel).toBe('anthropic/claude-opus-4-6');
    } finally {
      service.stop();
    }
  });
});
