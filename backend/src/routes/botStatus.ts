import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';

const router = Router();

interface BotStatus {
  id: string;
  mood: string;
  status_text: string;
  avatar_url: string | null;
  updated_at: string;
}

/**
 * GET /api/nim-status/current
 * Returns the most recent status entry
 */
router.get('/current', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query<BotStatus>(
      `SELECT id, mood, status_text, avatar_url, updated_at 
       FROM bot_status 
       ORDER BY updated_at DESC 
       LIMIT 1`
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: 'No status found'
      });
      return;
    }

    res.json({
      success: true,
      status: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching current status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/nim-status/update
 * Creates a new status entry
 * Body: { mood: string, status_text: string, avatar_url?: string }
 */
router.post('/update', async (req: Request, res: Response): Promise<void> => {
  try {
    const { mood, status_text, avatar_url } = req.body;

    // Validation
    if (!mood || typeof mood !== 'string' || mood.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'mood is required and must be a non-empty string'
      });
      return;
    }

    if (!status_text || typeof status_text !== 'string' || status_text.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'status_text is required and must be a non-empty string'
      });
      return;
    }

    if (avatar_url !== undefined && avatar_url !== null && typeof avatar_url !== 'string') {
      res.status(400).json({
        success: false,
        error: 'avatar_url must be a string or null'
      });
      return;
    }

    // Insert new status
    const result = await pool.query<BotStatus>(
      `INSERT INTO bot_status (mood, status_text, avatar_url) 
       VALUES ($1, $2, $3) 
       RETURNING id, mood, status_text, avatar_url, updated_at`,
      [mood.trim(), status_text.trim(), avatar_url || null]
    );

    res.status(201).json({
      success: true,
      status: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
