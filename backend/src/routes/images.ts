// images.ts - API endpoints for image generation
import { Router, Request, Response } from 'express';
import { imageGenerationService } from '../services/ImageGenerationService';
import fs from 'fs';
import path from 'path';

const router = Router();

// Screenshot directory (mounted from host)
const SCREENSHOT_DIR = '/clawdbot/media/browser';
// Generated images directory (mounted from host)
const GENERATED_DIR = '/clawd-media/generated';

interface Screenshot {
  id: string;
  filename: string;
  path: string;
  timestamp: string;
  type: 'screenshot';
}

interface UnifiedImage {
  id: string;
  type: 'generated' | 'screenshot';
  timestamp: string;
  filename: string;
  path?: string;
  prompt?: string;
  model?: string;
  status?: string;
  error_message?: string;
}

/**
 * Scan generated images directory and return metadata
 */
function getFilesystemGeneratedImages(): UnifiedImage[] {
  try {
    if (!fs.existsSync(GENERATED_DIR)) {
      console.warn(`[Images] Generated directory not found: ${GENERATED_DIR}`);
      return [];
    }

    const files = fs.readdirSync(GENERATED_DIR);
    const images: UnifiedImage[] = [];

    for (const file of files) {
      if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(file)) continue;

      const fullPath = path.join(GENERATED_DIR, file);
      const stats = fs.statSync(fullPath);

      // Extract prompt from filename: "1769865989-a-cute-orange-cat.png" -> "a cute orange cat"
      const nameWithoutExt = path.parse(file).name;
      // Remove leading numeric/uuid prefix
      const promptPart = nameWithoutExt.replace(/^[0-9a-f-]{8,}[-]?/i, '');
      const prompt = promptPart ? promptPart.replace(/-/g, ' ').trim() : undefined;

      images.push({
        id: `fs-generated-${file}`,
        type: 'generated',
        timestamp: stats.mtime.toISOString(),
        filename: file,
        prompt: prompt || undefined,
        status: 'completed'
      });
    }

    return images;
  } catch (err) {
    console.error('[Images] Error scanning generated directory:', err);
    return [];
  }
}

/**
 * Scan screenshot directory and return metadata
 */
function getScreenshots(): Screenshot[] {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      console.warn(`[Images] Screenshot directory not found: ${SCREENSHOT_DIR}`);
      return [];
    }

    const files = fs.readdirSync(SCREENSHOT_DIR);
    const screenshots: Screenshot[] = [];

    for (const file of files) {
      // Only process image files
      if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(file)) {
        continue;
      }

      const fullPath = path.join(SCREENSHOT_DIR, file);
      const stats = fs.statSync(fullPath);

      screenshots.push({
        id: `screenshot-${file}`,
        filename: file,
        path: fullPath,
        timestamp: stats.mtime.toISOString(),
        type: 'screenshot'
      });
    }

    return screenshots;
  } catch (err) {
    console.error('[Images] Error scanning screenshots:', err);
    return [];
  }
}

/**
 * POST /api/images/generate
 * Generate a new image from a prompt
 */
router.post('/generate', async (req: Request, res: Response): Promise<void> => {
  try {
    const { prompt, model, useCase } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Prompt is required and must be a string'
      });
      return;
    }

    if (prompt.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Prompt cannot be empty'
      });
      return;
    }

    const generation = await imageGenerationService.generate({
      prompt,
      model,
      useCase
    });

    res.status(201).json({
      success: true,
      generation
    });
  } catch (err) {
    console.error('[Images API] Error generating image:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/images
 * List all generated images
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;

    if (isNaN(limit) || limit < 1 || limit > 100) {
      res.status(400).json({
        success: false,
        error: 'Limit must be a number between 1 and 100'
      });
      return;
    }

    const generations = await imageGenerationService.list(limit);

    res.json({
      success: true,
      generations
    });
  } catch (err) {
    console.error('[Images API] Error listing images:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/images/screenshots
 * List all browser screenshots
 */
router.get('/screenshots', async (_req: Request, res: Response): Promise<void> => {
  try {
    const screenshots = getScreenshots();

    res.json({
      success: true,
      screenshots
    });
  } catch (err) {
    console.error('[Images API] Error listing screenshots:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/images/all
 * Unified endpoint: merge generated images + screenshots
 * Query params:
 *   - type: 'generated' | 'screenshot' | 'all' (default: 'all')
 *   - sort: 'newest' | 'oldest' (default: 'newest')
 *   - search: filename/prompt search string
 */
router.get('/all', async (req: Request, res: Response): Promise<void> => {
  try {
    const typeFilter = (req.query.type as string) || 'all';
    const sortOrder = (req.query.sort as string) || 'newest';
    const searchQuery = (req.query.search as string) || '';

    let allImages: UnifiedImage[] = [];

    // Fetch generated images (DB + filesystem, deduplicated)
    if (typeFilter === 'all' || typeFilter === 'generated') {
      const generations = await imageGenerationService.list(200);
      const dbFilenames = new Set<string>();
      const generatedImages: UnifiedImage[] = generations.map(gen => {
        const fname = path.basename(gen.file_path);
        dbFilenames.add(fname);
        return {
          id: gen.id,
          type: 'generated',
          timestamp: gen.created_at,
          filename: fname,
          prompt: gen.prompt,
          model: gen.model,
          status: gen.status,
          error_message: gen.error_message
        };
      });
      allImages = [...allImages, ...generatedImages];

      // Also scan filesystem, add any not already in DB
      const fsImages = getFilesystemGeneratedImages();
      for (const fsImg of fsImages) {
        if (!dbFilenames.has(fsImg.filename)) {
          allImages.push(fsImg);
        }
      }
    }

    // Fetch screenshots
    if (typeFilter === 'all' || typeFilter === 'screenshot') {
      const screenshots = getScreenshots();
      const screenshotImages: UnifiedImage[] = screenshots.map(scr => ({
        id: scr.id,
        type: 'screenshot',
        timestamp: scr.timestamp,
        filename: scr.filename,
        path: scr.path
      }));
      allImages = [...allImages, ...screenshotImages];
    }

    // Apply search filter
    if (searchQuery) {
      const searchLower = searchQuery.toLowerCase();
      allImages = allImages.filter(img => {
        const filenameMatch = img.filename.toLowerCase().includes(searchLower);
        const promptMatch = img.prompt?.toLowerCase().includes(searchLower);
        return filenameMatch || promptMatch;
      });
    }

    // Sort
    allImages.sort((a, b) => {
      const dateA = new Date(a.timestamp).getTime();
      const dateB = new Date(b.timestamp).getTime();
      return sortOrder === 'newest' ? dateB - dateA : dateA - dateB;
    });

    res.json({
      success: true,
      images: allImages,
      count: allImages.length
    });
  } catch (err) {
    console.error('[Images API] Error fetching unified images:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/images/generated/:filename
 * Serve a generated image file from filesystem
 */
router.get('/generated/:filename', async (req: Request, res: Response): Promise<void> => {
  try {
    const { filename } = req.params;
    const filePath = path.join(GENERATED_DIR, filename);

    if (!filePath.startsWith(GENERATED_DIR)) {
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ success: false, error: 'Generated image not found' });
      return;
    }

    const ext = path.extname(filename).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.gif': 'image/gif'
    };
    res.setHeader('Content-Type', contentTypes[ext] || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('[Images API] Error serving generated image:', err);
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * GET /api/images/screenshot/:filename
 * Serve a screenshot file
 */
router.get('/screenshot/:filename', async (req: Request, res: Response): Promise<void> => {
  try {
    const { filename } = req.params;
    const filePath = path.join(SCREENSHOT_DIR, filename);

    // Security: prevent directory traversal
    if (!filePath.startsWith(SCREENSHOT_DIR)) {
      res.status(403).json({
        success: false,
        error: 'Access denied'
      });
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.status(404).json({
        success: false,
        error: 'Screenshot not found'
      });
      return;
    }

    // Determine content type
    const ext = path.extname(filename).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif'
    };
    const contentType = contentTypes[ext] || 'image/png';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err) {
    console.error('[Images API] Error serving screenshot:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/images/:id
 * Get image generation details by ID
 */
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const generation = await imageGenerationService.getById(id);

    res.json({
      success: true,
      generation
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: err.message
      });
    } else {
      console.error('[Images API] Error getting image:', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  }
});

/**
 * GET /api/images/:id/file
 * Serve the actual image file
 */
router.get('/:id/file', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const generation = await imageGenerationService.getById(id);

    // Check if image file exists
    if (!imageGenerationService.imageExists(generation.file_path)) {
      res.status(404).json({
        success: false,
        error: 'Image file not found on disk'
      });
      return;
    }

    // Stream the image file
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
    
    const stream = imageGenerationService.getImageStream(generation.file_path);
    stream.pipe(res);
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: err.message
      });
    } else {
      console.error('[Images API] Error serving image file:', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  }
});

export default router;
