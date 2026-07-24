jest.mock('../db/connection', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

import fs from 'fs';
import { execFile } from 'child_process';
import { pool } from '../db/connection';
import { ImageGenerationService } from '../services/ImageGenerationService';

const mockQuery = pool.query as jest.Mock;
const mockExecFile = execFile as unknown as jest.Mock;
const originalEnv = process.env;

function resetEnv(overrides: Record<string, string | undefined> = {}) {
  process.env = { ...originalEnv };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CLAWBOARD_IMAGE_') || key === 'LITELLM_API_KEY') {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('ImageGenerationService provider bridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
    jest.spyOn(fs, 'copyFileSync').mockImplementation(() => undefined);
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'img-1',
        prompt: 'tiny robot avatar',
        model: 'openai/gpt-image-2',
        use_case: 'avatar',
        file_path: '/tmp/generated/img-1.png',
        status: 'generating',
        created_at: '2026-07-07T00:00:00Z',
      }],
    });
    delete (global as any).fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  it('uses OpenClaw CLI without requiring a Codex token in ClawBoard env', async () => {
    resetEnv({
      CLAWBOARD_IMAGE_PROVIDER: 'openclaw',
      CLAWBOARD_IMAGE_OUTPUT_DIR: '/tmp/generated',
      CLAWBOARD_IMAGE_OPENCLAW_MODEL: 'openai/gpt-image-2',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, JSON.stringify({ file_path: '/tmp/openclaw.png' }), ''));

    const service = new ImageGenerationService();
    await service.generate({ prompt: 'tiny robot avatar', useCase: 'avatar' });
    await flushAsyncWork();

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0][0]).toBe('openclaw');
    const args = mockExecFile.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining([
      'infer', 'image', 'generate', '--prompt', 'tiny robot avatar', '--model', 'openai/gpt-image-2', '--output'
    ]));
    const outputIndex = args.indexOf('--output') + 1;
    expect(args[outputIndex]).toMatch(/^\/tmp\/generated\/[0-9a-f-]+\.png$/);
    expect(process.env.OPENAI_CODEX_TOKEN).toBeUndefined();
    expect(fs.copyFileSync).toHaveBeenCalledWith('/tmp/openclaw.png', args[outputIndex]);
  });

  it('maps avatar and banner use cases to provider-specific env model knobs', async () => {
    resetEnv({
      CLAWBOARD_IMAGE_PROVIDER: 'openclaw',
      CLAWBOARD_IMAGE_OUTPUT_DIR: '/tmp/generated',
      CLAWBOARD_IMAGE_OPENCLAW_MODEL: 'openai/gpt-image-2',
      CLAWBOARD_IMAGE_OPENCLAW_AVATAR_MODEL: 'openai/gpt-image-2-avatar',
      CLAWBOARD_IMAGE_OPENCLAW_BANNER_MODEL: 'openai/gpt-image-2-banner',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '', ''));

    const service = new ImageGenerationService();
    await service.generate({ prompt: 'avatar prompt', useCase: 'avatar' });
    await service.generate({ prompt: 'banner prompt', useCase: 'banner' });
    await flushAsyncWork();

    expect(mockExecFile.mock.calls[0][1]).toEqual(expect.arrayContaining(['--model', 'openai/gpt-image-2-avatar']));
    expect(mockExecFile.mock.calls[1][1]).toEqual(expect.arrayContaining(['--model', 'openai/gpt-image-2-banner']));
  });

  it('reads LiteLLM API key from env instead of hardcoding a secret', async () => {
    resetEnv({
      CLAWBOARD_IMAGE_PROVIDER: 'litellm',
      CLAWBOARD_IMAGE_OUTPUT_DIR: '/tmp/generated',
      LITELLM_API_KEY: 'runtime-key',
    });
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }] }),
    });

    const service = new ImageGenerationService();
    await service.generate({ prompt: 'tiny banner' });
    await flushAsyncWork();

    expect((global as any).fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer runtime-key' }),
    }));
  });
});
