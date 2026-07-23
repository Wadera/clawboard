/**
 * Tests for the live model-catalog resolver (backend/src/services/modelCatalog.ts):
 *  - aggregation across LiteLLM /v1/models + OpenClaw config + static floor
 *  - normalization equivalence (gpt-5.5 == openai-codex/gpt-5.5 == codex/gpt-5.5)
 *  - ~10min TTL cache behaviour (no LiteLLM fanout per call; force refresh)
 */

import { readFile } from 'fs/promises';
import {
  getModelCatalog,
  clearModelCatalogCache,
  normalizeModelId,
  isModelAvailable,
  STATIC_FLOOR_MODELS,
  MODEL_CATALOG_TTL_MS,
} from '../services/modelCatalog';

jest.mock('fs/promises', () => ({ readFile: jest.fn() }));

const mockReadFile = readFile as unknown as jest.Mock;

const CONFIG = {
  agents: {
    defaults: {
      model: {
        primary: 'codex/gpt-5.5',
        fallbacks: ['litellm/gemini/gemini-3-flash-preview'],
      },
      models: { 'openai-codex/gpt-5.5': { alias: 'gpt-5.5' } },
    },
  },
  models: {
    providers: {
      litellm: {
        baseUrl: 'https://litellm.example/v1',
        apiKey: 'sk-test-key',
        models: [{ id: 'openai/gpt-5.2' }, 'openai/gpt-4o'],
      },
      anthropic: {
        models: [{ id: 'anthropic/claude-opus-4-8' }],
      },
    },
  },
};

function mockLiteLLM(ids: string[], ok = true, status = 200) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ data: ids.map((id) => ({ id })) }),
  });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

beforeEach(() => {
  clearModelCatalogCache();
  mockReadFile.mockReset();
  mockReadFile.mockResolvedValue(JSON.stringify(CONFIG));
});

afterEach(() => {
  delete (global as any).fetch;
});

describe('normalizeModelId', () => {
  it('strips provider prefixes and lowercases', () => {
    expect(normalizeModelId('openai-codex/gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeModelId('codex/gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeModelId('gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeModelId('anthropic/Claude-Opus-4-8')).toBe('claude-opus-4-8');
  });

  it('treats Wadera canonical codex forms as equivalent', () => {
    const forms = ['gpt-5.5', 'openai-codex/gpt-5.5', 'codex/gpt-5.5'];
    const normalized = new Set(forms.map(normalizeModelId));
    expect(normalized.size).toBe(1);
  });

  it('strips only the leading provider segment, keeping nested LiteLLM routes distinct', () => {
    expect(normalizeModelId('litellm/gemini/gemini-3-flash-preview')).toBe(
      'gemini/gemini-3-flash-preview'
    );
    // distinct downstream models remain distinct
    expect(normalizeModelId('litellm/gemini/a')).not.toBe(normalizeModelId('litellm/gemini/b'));
  });

  it('returns empty string for empty/nullish input', () => {
    expect(normalizeModelId('')).toBe('');
    expect(normalizeModelId(undefined as any)).toBe('');
  });
});

describe('getModelCatalog aggregation', () => {
  it('aggregates LiteLLM + config + static floor', async () => {
    mockLiteLLM(['gemini/gemini-3-flash-preview', 'openai/gpt-5.2']);
    const catalog = await getModelCatalog(true);

    // LiteLLM ids present, both raw and litellm/-prefixed
    expect(catalog.ids).toContain('gemini/gemini-3-flash-preview');
    expect(catalog.ids).toContain('litellm/gemini/gemini-3-flash-preview');
    // config ids present
    expect(catalog.ids).toContain('codex/gpt-5.5');
    expect(catalog.ids).toContain('openai-codex/gpt-5.5');
    expect(catalog.ids).toContain('anthropic/claude-opus-4-8');
    // static floor present
    for (const id of STATIC_FLOOR_MODELS) expect(catalog.ids).toContain(id);

    expect(catalog.sources.litellm).toBeGreaterThan(0);
    expect(catalog.sources.config).toBeGreaterThan(0);
    expect(catalog.sources.floor).toBe(STATIC_FLOOR_MODELS.length);
  });

  it('degrades gracefully when LiteLLM is unreachable (config + floor only)', async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const catalog = await getModelCatalog(true);
    expect(catalog.sources.litellm).toBe(0);
    // config + floor still resolve
    expect(catalog.ids).toContain('codex/gpt-5.5');
    expect(isModelAvailable('gpt-5.5', catalog)).toBe(true);
  });

  it('degrades gracefully when LiteLLM returns non-200', async () => {
    mockLiteLLM([], false, 401);
    const catalog = await getModelCatalog(true);
    expect(catalog.sources.litellm).toBe(0);
    expect(catalog.ids).toContain('codex/gpt-5.5');
  });

  it('degrades gracefully when config is missing (floor only)', async () => {
    const enoent: any = new Error('not found');
    enoent.code = 'ENOENT';
    mockReadFile.mockRejectedValue(enoent);
    const catalog = await getModelCatalog(true);
    expect(catalog.sources.config).toBe(0);
    // fetch never called because no litellm conn from config
    expect(catalog.sources.litellm).toBe(0);
    expect(catalog.ids).toEqual(STATIC_FLOOR_MODELS);
  });

  it('resolves valid gpt-5.5 pins (all provider forms) against the catalog', async () => {
    mockLiteLLM([]);
    const catalog = await getModelCatalog(true);
    expect(isModelAvailable('gpt-5.5', catalog)).toBe(true);
    expect(isModelAvailable('openai-codex/gpt-5.5', catalog)).toBe(true);
    expect(isModelAvailable('codex/gpt-5.5', catalog)).toBe(true);
    // a genuinely unknown model is not available
    expect(isModelAvailable('no/such-model', catalog)).toBe(false);
  });
});

describe('getModelCatalog TTL cache', () => {
  it('does not re-fetch LiteLLM within the TTL window', async () => {
    const fetchMock = mockLiteLLM(['openai/gpt-5.2']);
    await getModelCatalog(true); // seed cache (1 fetch)
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await getModelCatalog(); // cached
    await getModelCatalog(); // cached
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches when the cache is expired past the TTL', async () => {
    const fetchMock = mockLiteLLM(['openai/gpt-5.2']);
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(1_000_000);
    await getModelCatalog(); // cold -> fetch #1
    expect(fetchMock).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_000_000 + MODEL_CATALOG_TTL_MS + 1);
    await getModelCatalog(); // expired -> fetch #2
    expect(fetchMock).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it('force=true bypasses the cache', async () => {
    const fetchMock = mockLiteLLM(['openai/gpt-5.2']);
    await getModelCatalog(); // fetch #1
    await getModelCatalog(true); // forced -> fetch #2
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent cold callers into a single LiteLLM probe', async () => {
    const fetchMock = mockLiteLLM(['openai/gpt-5.2']);
    const [a, b, c] = await Promise.all([
      getModelCatalog(),
      getModelCatalog(),
      getModelCatalog(),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
