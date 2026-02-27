import express, { Request, Response, Router } from 'express';
import { pool } from '../db/connection';
import { readFile } from 'fs/promises';
import path from 'path';

const router: Router = express.Router();

const SESSIONS_DIR = process.env.OPENCLAW_TRANSCRIPTS_DIR || process.env.CLAWDBOT_TRANSCRIPTS_DIR || '/openclaw/sessions';

/**
 * GET /sessions
 * List sessions with pagination, filters, sorting
 */
router.get('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const {
      page = '1',
      limit = '20',
      status,
      kind,
      model,
      dateFrom,
      dateTo,
      search,
      sortBy = 'last_activity_at',
      sortOrder = 'DESC'
    } = req.query;

    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
    const limitNum = parseInt(limit as string);

    // Build WHERE clause
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(status);
    }

    if (kind) {
      conditions.push(`kind = $${paramIndex++}`);
      params.push(kind);
    }

    if (model) {
      conditions.push(`model = $${paramIndex++}`);
      params.push(model);
    }

    if (dateFrom) {
      conditions.push(`started_at >= $${paramIndex++}`);
      params.push(dateFrom);
    }

    if (dateTo) {
      conditions.push(`started_at <= $${paramIndex++}`);
      params.push(dateTo);
    }

    if (search) {
      conditions.push(`(session_key ILIKE $${paramIndex} OR label ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Validate sortBy to prevent SQL injection
    const allowedSortFields = ['last_activity_at', 'started_at', 'message_count', 'total_cost_usd'];
    const sortField = allowedSortFields.includes(sortBy as string) ? sortBy : 'last_activity_at';
    const order = sortOrder === 'ASC' ? 'ASC' : 'DESC';

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM sessions ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total);

    // Get sessions
    const sessionsResult = await pool.query(
      `SELECT 
        id, session_key, label, model, kind, status,
        parent_session_id, task_id,
        message_count, tool_call_count,
        input_tokens, output_tokens, thinking_tokens, total_cost_usd,
        transcript_path,
        started_at, ended_at, last_activity_at,
        created_at, updated_at,
        metadata
       FROM sessions
       ${whereClause}
       ORDER BY ${sortField} ${order}
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limitNum, offset]
    );

    res.json({
      success: true,
      sessions: sessionsResult.rows,
      pagination: {
        page: parseInt(page as string),
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /sessions/stats
 * Aggregate stats across all sessions
 */
router.get('/stats', async (_req: Request, res: Response): Promise<any> => {
  try {
    // Overall stats
    const overallResult = await pool.query(`
      SELECT 
        COUNT(*) as total_sessions,
        SUM(message_count) as total_messages,
        SUM(tool_call_count) as total_tool_calls,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(thinking_tokens) as total_thinking_tokens,
        SUM(total_cost_usd) as total_cost
      FROM sessions
    `);

    // Stats by model
    const byModelResult = await pool.query(`
      SELECT 
        model,
        COUNT(*) as session_count,
        SUM(message_count) as messages,
        SUM(total_cost_usd) as cost,
        SUM(input_tokens + output_tokens + thinking_tokens) as total_tokens
      FROM sessions
      WHERE model IS NOT NULL
      GROUP BY model
      ORDER BY session_count DESC
    `);

    // Stats by kind
    const byKindResult = await pool.query(`
      SELECT 
        kind,
        COUNT(*) as count,
        SUM(total_cost_usd) as cost
      FROM sessions
      GROUP BY kind
    `);

    // Stats by status
    const byStatusResult = await pool.query(`
      SELECT 
        status,
        COUNT(*) as count
      FROM sessions
      GROUP BY status
    `);

    res.json({
      success: true,
      overall: overallResult.rows[0],
      byModel: byModelResult.rows,
      byKind: byKindResult.rows,
      byStatus: byStatusResult.rows
    });
  } catch (error) {
    console.error('Error fetching session stats:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /sessions/:id
 * Get session details + first/last N messages from JSONL
 */
router.get('/:id', async (req: Request, res: Response): Promise<any> => {
  try {
    const { id } = req.params;
    const { firstMessages = '5', lastMessages = '5' } = req.query;

    // Get session from DB
    const sessionResult = await pool.query(
      'SELECT * FROM sessions WHERE id = $1',
      [id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    const session = sessionResult.rows[0];

    // Read JSONL transcript
    const transcriptPath = path.join(SESSIONS_DIR, `${id}.jsonl`);
    
    try {
      const content = await readFile(transcriptPath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());
      
      // Parse all lines
      const messages = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);

      // Get first N and last N
      const firstN = parseInt(firstMessages as string);
      const lastN = parseInt(lastMessages as string);
      
      const first = messages.slice(0, firstN);
      const last = messages.slice(-lastN);

      res.json({
        success: true,
        session,
        transcript: {
          totalMessages: messages.length,
          first,
          last
        }
      });
    } catch (err) {
      // Transcript file not found or unreadable
      res.json({
        success: true,
        session,
        transcript: {
          error: 'Transcript file not found or unreadable'
        }
      });
    }
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /sessions/:id/transcript
 * Stream full JSONL transcript
 */
router.get('/:id/transcript', async (req: Request, res: Response): Promise<any> => {
  try {
    const { id } = req.params;

    // Verify session exists
    const sessionResult = await pool.query(
      'SELECT id FROM sessions WHERE id = $1',
      [id]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    const transcriptPath = path.join(SESSIONS_DIR, `${id}.jsonl`);

    // Stream the file
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="${id}.jsonl"`);

    const content = await readFile(transcriptPath, 'utf-8');
    res.send(content);
  } catch (error) {
    console.error('Error streaming transcript:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
