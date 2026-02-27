// ImageGenerationService.ts - Generate images using LiteLLM API
import { pool } from '../db/connection';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

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
}

interface LiteLLMResponse {
  data: Array<{
    b64_json: string;
  }>;
}

export class ImageGenerationService {
  private litellmApiUrl = process.env.LITELLM_API_URL || 'http://localhost:4000/v1/images/generations';
  private litellmApiKey = process.env.LITELLM_API_KEY || '';
  private outputDir = '/clawd-media/generated';

  /**
   * Generate an image using imagine.py
   */
  async generate(input: GenerateImageInput): Promise<ImageGeneration> {
    const id = uuidv4();
    const model = input.model || 'gemini/gemini-3-pro-image-preview';
    const fileName = `${id}.png`;
    const filePath = path.join(this.outputDir, fileName);

    // Create initial database record
    const result = await pool.query(
      `INSERT INTO image_generations (id, prompt, model, file_path, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, input.prompt, model, filePath, 'generating']
    );

    const generation = result.rows[0];

    // Start image generation asynchronously
    this.runImageGeneration(id, input.prompt, model, filePath).catch(err => {
      console.error(`[ImageGeneration] Error generating image ${id}:`, err);
    });

    return generation;
  }

  /**
   * Call LiteLLM API to generate image
   */
  private async runImageGeneration(
    id: string,
    prompt: string,
    model: string,
    outputPath: string
  ): Promise<void> {
    try {
      // Ensure output directory exists
      if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
      }

      console.log(`[ImageGeneration] Starting generation for ${id}:`, { prompt, model });

      // Call LiteLLM API
      const response = await fetch(this.litellmApiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.litellmApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model,
          prompt: prompt,
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

      console.log(`[ImageGeneration] Successfully generated image ${id} (${imageBuffer.length} bytes)`);
      
      // Update database to completed
      await pool.query(
        `UPDATE image_generations 
         SET status = $1, completed_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        ['completed', id]
      );

    } catch (err) {
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
