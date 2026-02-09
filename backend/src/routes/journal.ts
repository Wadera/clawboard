// journal.ts - API endpoints for bot journal
import { Router, Request, Response } from 'express';
import { journalService } from '../services/JournalService';

const router = Router();

/**
 * GET /api/journal — list entries (paginated, newest first)
 */
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const { entries, total } = await journalService.list(limit, offset);

    res.json({ success: true, entries, total, limit, offset });
  } catch (err) {
    console.error('[Journal API] Error listing entries:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/journal/latest — most recent entry
 */
router.get('/latest', async (_req: Request, res: Response): Promise<void> => {
  try {
    const entry = await journalService.getLatest();
    if (!entry) {
      res.status(404).json({ success: false, error: 'No journal entries found' });
      return;
    }
    res.json({ success: true, entry });
  } catch (err) {
    console.error('[Journal API] Error getting latest entry:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/journal/:id — single entry
 */
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const entry = await journalService.getById(req.params.id);
    res.json({ success: true, entry });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ success: false, error: err.message });
    } else {
      console.error('[Journal API] Error getting entry:', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  }
});

/**
 * POST /api/journal — create entry
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { date, mood, reflection_text, image_path, highlights } = req.body;

    if (!date || !reflection_text) {
      res.status(400).json({
        success: false,
        error: 'date and reflection_text are required'
      });
      return;
    }

    const entry = await journalService.create({
      date,
      mood,
      reflection_text,
      image_path,
      highlights
    });

    res.status(201).json({ success: true, entry });
  } catch (err) {
    // Handle unique constraint violation (duplicate date)
    if (err instanceof Error && err.message.includes('duplicate key')) {
      res.status(409).json({
        success: false,
        error: 'A journal entry already exists for this date'
      });
    } else {
      console.error('[Journal API] Error creating entry:', err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  }
});

export default router;
