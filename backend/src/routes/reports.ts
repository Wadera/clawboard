// reports.ts - API endpoints for reports/notes management
import { Router, Request, Response } from 'express';
import { reportManager } from '../services/ReportManager';

const router = Router();

/**
 * GET /reports
 * List reports with pagination, filtering, and search
 * Query params: q, tags (comma-separated), project_id, pinned, limit, offset
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const q = req.query.q as string | undefined;
    const tagsParam = req.query.tags as string | undefined;
    const tags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : undefined;
    const project_id = req.query.project_id as string | undefined;
    const pinnedParam = req.query.pinned as string | undefined;
    const pinned = pinnedParam !== undefined ? pinnedParam === 'true' : undefined;
    const limit = parseInt(req.query.limit as string, 10) || 10;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const result = await reportManager.list({ q, tags, project_id, pinned, limit, offset });

    res.json({
      success: true,
      reports: result.reports,
      total: result.total,
      hasMore: result.hasMore,
    });
  } catch (err) {
    console.error('[Reports API] Error listing reports:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * GET /reports/:id
 * Get a single report by ID
 */
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const report = await reportManager.getById(req.params.id);
    if (!report) {
      res.status(404).json({ success: false, error: 'Report not found' });
      return;
    }
    res.json({ success: true, report });
  } catch (err) {
    console.error('[Reports API] Error getting report:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * POST /reports
 * Create a new report
 * Body: { title, content, summary?, tags?, project_id?, task_ids?, author?, pinned? }
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, content, summary, tags, project_id, task_ids, author, pinned } = req.body;

    if (!title || !content) {
      res.status(400).json({ success: false, error: 'Title and content are required' });
      return;
    }

    const report = await reportManager.create({
      title,
      content,
      summary,
      tags,
      project_id,
      task_ids,
      author,
      pinned,
    });

    res.status(201).json({ success: true, report });
  } catch (err) {
    console.error('[Reports API] Error creating report:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * PATCH /reports/:id
 * Partial update of a report
 */
router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const updates = { ...req.body };
    delete updates.id;
    delete updates.created_at;

    const report = await reportManager.update(req.params.id, updates);
    if (!report) {
      res.status(404).json({ success: false, error: 'Report not found' });
      return;
    }

    res.json({ success: true, report });
  } catch (err) {
    console.error('[Reports API] Error updating report:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /reports/:id
 * Delete a report
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await reportManager.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Report not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Reports API] Error deleting report:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

export default router;
