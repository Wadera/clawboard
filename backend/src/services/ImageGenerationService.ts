// ImageGenerationService.ts - Generate images using configurable providers
import { pool } from '../db/connection';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type ImageProvider = 'litellm' | 'openclaw';
type ImageUseCase = 'default' | 'avatar' | 'banner';

export interface ImageGeneration {
  id: string;
  prompt: string;
  model: string;
  file_path: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  error_message?: string;
  created_at: string;
  completed_at?: string;
}

export interface GenerateImageInput {
  prompt: string;
  model?: string;
  useCase?: ImageUseCase;
}

interface LiteLLMResponse {
  data: Array<{
    b64_json: string;
  }>;
}

interface ProviderConfig {
  provider: ImageProvider;
  fallbackProvider?: ImageProvider;
  litellmApiUrl: string;
  litellmApiKey?: string;
  openclawCommand: string;
  openclawArgsTemplate: string;
  outputDir: string;
  timeoutMs: number;
}

const DEFAULT_OPENCLAW_ARGS_TEMPLATE = 'infer image generate --prompt {prompt} --model {model} --output {output}';

function readProvider(value: string | undefined, fallback: ImageProvider): ImageProvider {
  return value === 'openclaw' || value === 'litellm' ? value : fallback;
}

function readUseCase(value: string | undefined): ImageUseCase {
  return value === 'avatar' || value === 'banner' ? value : 'default';
}

function getProviderConfig(): ProviderConfig {
  const provider = readProvider(process.env.CLAWBOARD_IMAGE_PROVIDER, 'litellm');
  const fallbackProvider = process.env.CLAWBOARD_IMAGE_FALLBACK_PROVIDER
    ? readProvider(process.env.CLAWBOARD_IMAGE_FALLBACK_PROVIDER, provider)
    : undefined;

  return {
    provider,
    fallbackProvider: fallbackProvider && fallbackProvider !== provider ? fallbackProvider : undefined,
    litellmApiUrl: process.env.CLAWBOARD_IMAGE_LITELLM_URL || 'http://localhost:4000/v1/images/generations',
    litellmApiKey: process.env.LITELLM_API_KEY,
    openclawCommand: process.env.CLAWBOARD_IMAGE_OPENCLAW_COMMAND || 'openclaw',
    openclawArgsTemplate: process.env.CLAWBOARD_IMAGE_OPENCLAW_ARGS_TEMPLATE || DEFAULT_OPENCLAW_ARGS_TEMPLATE,
    outputDir: process.env.CLAWBOARD_IMAGE_OUTPUT_DIR || '/clawd-media/generated',
    timeoutMs: Number.parseInt(process.env.CLAWBOARD_IMAGE_TIMEOUT_MS || '180000', 10),
  };
}

function modelEnvName(provider: ImageProvider, useCase: ImageUseCase): string {
  const suffix = useCase === 'default' ? 'MODEL' : `${useCase.toUpperCase()}_MODEL`;
  return `CLAWBOARD_IMAGE_${provider.toUpperCase()}_${suffix}`;
}

function resolveModel(provider: ImageProvider, useCase: ImageUseCase, explicitModel?: string): string {
  if (explicitModel && explicitModel.trim()) return explicitModel.trim();

  const useCaseModel = process.env[modelEnvName(provider, useCase)];
  if (useCaseModel && useCaseModel.trim()) return useCaseModel.trim();

  const defaultProviderModel = process.env[modelEnvName(provider, 'default')];
  if (defaultProviderModel && defaultProviderModel.trim()) return defaultProviderModel.trim();

  if (provider === 'openclaw') return 'openai/gpt-image-2';
  return process.env.CLAWBOARD_IMAGE_MODEL || 'gemini/gemini-3-pro-image-preview';
}

function splitArgs(template: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (const char of template) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) args.push(current);
  return args;
}

function renderOpenClawArgs(template: string, prompt: string, model: string, outputPath: string): string[] {
  return splitArgs(template).map((arg) => arg
    .replace('{prompt}', prompt)
    .replace('{model}', model)
    .replace('{output}', outputPath));
}

function extractOutputPath(stdout: string, expectedOutputPath: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return expectedOutputPath;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['file_path', 'filePath', 'path', 'output_path', 'outputPath', 'mediaPath']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    // Non-JSON output is allowed; fall through to path extraction.
  }

  const pathMatch = trimmed.match(/(?:^|\s)(\/[^\s]+\.(?:png|jpg|jpeg|webp))(?:\s|$)/i);
  return pathMatch ? pathMatch[1] : expectedOutputPath;
}

export class ImageGenerationService {
  /**
   * Generate an image using the configured provider.
   */
  async generate(input: GenerateImageInput): Promise<ImageGeneration> {
    const config = getProviderConfig();
    const id = uuidv4();
    const useCase = readUseCase(input.useCase);
    const model = resolveModel(config.provider, useCase, input.model);
    const fileName = `${id}.png`;
    const filePath = path.join(config.outputDir, fileName);

    // Create initial database record
    const result = await pool.query(
      `INSERT INTO image_generations (id, prompt, model, file_path, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, input.prompt, model, filePath, 'generating']
    );

    const generation = result.rows[0];

    // Start image generation asynchronously
    this.runImageGeneration(id, input.prompt, model, filePath, config).catch(err => {
      console.error(`[ImageGeneration] Error generating image ${id}:`, err);
    });

    return generation;
  }

  /**
   * Call the configured provider to generate image.
   */
  private async runImageGeneration(
    id: string,
    prompt: string,
    model: string,
    outputPath: string,
    config: ProviderConfig
  ): Promise<void> {
    try {
      // Ensure output directory exists
      if (!fs.existsSync(config.outputDir)) {
        fs.mkdirSync(config.outputDir, { recursive: true });
      }

      console.log(`[ImageGeneration] Starting generation for ${id}:`, {
        provider: config.provider,
        prompt,
        model,
      });

      await this.generateWithProvider(config.provider, prompt, model, outputPath, config);

      console.log(`[ImageGeneration] Successfully generated image ${id}`);

      // Update database to completed
      await pool.query(
        `UPDATE image_generations 
         SET status = $1, completed_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        ['completed', id]
      );

    } catch (err) {
      if (config.fallbackProvider) {
        try {
          console.warn(`[ImageGeneration] Primary provider failed for ${id}; trying ${config.fallbackProvider}:`, err instanceof Error ? err.message : err);
          await this.generateWithProvider(config.fallbackProvider, prompt, model, outputPath, config);
          await pool.query(
            `UPDATE image_generations
             SET status = $1, completed_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            ['completed', id]
          );
          return;
        } catch (fallbackErr) {
          err = fallbackErr;
        }
      }

      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[ImageGeneration] Failed to generate image ${id}:`, errorMessage);

      // Update database to failed
      await pool.query(
        `UPDATE image_generations 
         SET status = $1, error_message = $2
         WHERE id = $3`,
        ['failed', errorMessage, id]
      );

      throw err;
    }
  }

  private async generateWithProvider(
    provider: ImageProvider,
    prompt: string,
    model: string,
    outputPath: string,
    config: ProviderConfig
  ): Promise<void> {
    if (provider === 'openclaw') {
      await this.generateWithOpenClaw(prompt, model, outputPath, config);
      return;
    }

    await this.generateWithLiteLLM(prompt, model, outputPath, config);
  }

  private async generateWithOpenClaw(
    prompt: string,
    model: string,
    outputPath: string,
    config: ProviderConfig
  ): Promise<void> {
    const args = renderOpenClawArgs(config.openclawArgsTemplate, prompt, model, outputPath);
    const result = await execFileAsync(config.openclawCommand, args, {
      timeout: config.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }) as { stdout?: string | Buffer; stderr?: string | Buffer } | string | Buffer;

    const stdout = typeof result === 'string' || Buffer.isBuffer(result)
      ? result.toString()
      : (result.stdout ?? '').toString();
    const generatedPath = extractOutputPath(stdout, outputPath);
    if (generatedPath !== outputPath) {
      if (!fs.existsSync(generatedPath)) {
        throw new Error(`OpenClaw reported output path that does not exist: ${generatedPath}`);
      }
      fs.copyFileSync(generatedPath, outputPath);
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error(`OpenClaw did not create expected image: ${outputPath}`);
    }
  }

  private async generateWithLiteLLM(
    prompt: string,
    model: string,
    outputPath: string,
    config: ProviderConfig
  ): Promise<void> {
    if (!config.litellmApiKey) {
      throw new Error('LITELLM_API_KEY is required when CLAWBOARD_IMAGE_PROVIDER=litellm');
    }

    const response = await fetch(config.litellmApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.litellmApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LiteLLM API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as LiteLLMResponse;

    if (!data.data || data.data.length === 0 || !data.data[0].b64_json) {
      throw new Error('Invalid response from LiteLLM API: missing b64_json data');
    }

    // Decode base64 and save to file
    const imageBuffer = Buffer.from(data.data[0].b64_json, 'base64');
    fs.writeFileSync(outputPath, imageBuffer);
  }

  /**
   * Get image generation by ID
   */
  async getById(id: string): Promise<ImageGeneration> {
    const result = await pool.query(
      'SELECT * FROM image_generations WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      throw new Error(`Image generation not found: ${id}`);
    }

    return result.rows[0];
  }

  /**
   * List all image generations (most recent first)
   */
  async list(limit: number = 50): Promise<ImageGeneration[]> {
    const result = await pool.query(
      `SELECT * FROM image_generations 
       ORDER BY created_at DESC 
       LIMIT $1`,
      [limit]
    );

    return result.rows;
  }

  /**
   * Get image file stream
   */
  getImageStream(filePath: string): fs.ReadStream {
    if (!fs.existsSync(filePath)) {
      throw new Error('Image file not found');
    }

    return fs.createReadStream(filePath);
  }

  /**
   * Check if image file exists
   */
  imageExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }
}

export const imageGenerationService = new ImageGenerationService();
