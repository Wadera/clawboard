// tools.ts - API endpoints for tools management
import { Router, Request, Response } from 'express';
import { toolManager } from '../services/ToolManager';

const router = Router();

/**
 * GET /api/tools
 * List all tools with optional filters: ?category=, ?tag=, ?search=
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const category = req.query.category as string | undefined;
    const tag = req.query.tag as string | undefined;
    const search = req.query.search as string | undefined;

    const tools = await toolManager.list({ category, tag, search });
    res.json({ success: true, tools });
  } catch (err) {
    console.error('[Tools API] Error listing tools:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/tools/:id
 * Get a single tool by ID
 */
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const tool = await toolManager.getById(req.params.id);
    res.json({ success: true, tool });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Tools API] Error getting tool:', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
});

/**
 * POST /api/tools
 * Create a new tool
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, category, description, usage_instructions, config, tags, is_global } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ success: false, error: 'Tool name is required' });
      return;
    }

    const tool = await toolManager.create({
      name,
      category,
      description,
      usage_instructions,
      config,
      tags,
      is_global,
    });

    res.status(201).json({ success: true, tool });
  } catch (err) {
    // Handle unique constraint violation
    if (err instanceof Error && err.message.includes('duplicate key')) {
      res.status(409).json({ success: false, error: `Tool with name already exists` });
    } else {
      console.error('[Tools API] Error creating tool:', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
});

/**
 * PUT /api/tools/:id
 * Update an existing tool (auto-bumps version)
 */
router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, category, description, usage_instructions, config, tags, is_global } = req.body;

    const tool = await toolManager.update(req.params.id, {
      name,
      category,
      description,
      usage_instructions,
      config,
      tags,
      is_global,
    });

    res.json({ success: true, tool });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else if (err instanceof Error && err.message.includes('duplicate key')) {
      res.status(409).json({ success: false, error: 'Tool with that name already exists' });
    } else {
      console.error('[Tools API] Error updating tool:', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
});

/**
 * DELETE /api/tools/:id
 * Delete a tool
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    await toolManager.delete(req.params.id);
    res.json({ success: true, message: 'Tool deleted successfully' });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Tools API] Error deleting tool:', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
});

export default router;
