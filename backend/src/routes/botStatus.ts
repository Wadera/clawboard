import { Router, Request, Response } from 'express';
import path from 'path';
import { pool } from '../db/connection';
import { cadenceDecision, eventFingerprint, londonDayBounds, PersonalityStatusInput, validateEditorialContract } from '../services/PersonalityStatusPolicy';
import { resolveStatusSource, UntrustedStatusTriggerError } from '../services/PersonalityStatusTrigger';

const router = Router();
const STATUS_AVATAR_PUBLIC_PREFIX = '/media/generated/hermes-status/';
const STATUS_AVATAR_ROOT = path.resolve(process.env.STATUS_AVATAR_ROOT || '/clawd-media/generated/hermes-status');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Dashboard/status consumers receive narrative presentation fields only. Provenance,
// cadence and idempotency metadata remain server-side.
const publicProjection = 'id, mood, status_text, avatar_url, updated_at, author, author_harness';

router.get('/current', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(`SELECT ${publicProjection} FROM bot_status ORDER BY updated_at DESC LIMIT 1`);
    if (!result.rows.length) { res.status(404).json({ success: false, error: 'No status found' }); return; }
    res.json({ success: true, status: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.get('/:id/avatar', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!UUID.test(req.params.id)) { res.status(404).json({ success: false, error: 'Status avatar not found' }); return; }
    const result = await pool.query('SELECT avatar_url FROM bot_status WHERE id=$1', [req.params.id]);
    const avatarUrl = result.rows[0]?.avatar_url;
    if (typeof avatarUrl !== 'string' || !avatarUrl.startsWith(STATUS_AVATAR_PUBLIC_PREFIX)) {
      res.status(404).json({ success: false, error: 'Status avatar not found' });
      return;
    }
    const fileName = path.basename(avatarUrl.slice(STATUS_AVATAR_PUBLIC_PREFIX.length));
    if (!/^[0-9a-f]{24}\.png$/.test(fileName)) {
      res.status(404).json({ success: false, error: 'Status avatar not found' });
      return;
    }
    const resolved = path.resolve(STATUS_AVATAR_ROOT, fileName);
    if (!resolved.startsWith(`${STATUS_AVATAR_ROOT}${path.sep}`)) {
      res.status(404).json({ success: false, error: 'Status avatar not found' });
      return;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(resolved, (error) => {
      if (!error) return;
      if (!res.headersSent) res.status(404).json({ success: false, error: 'Status avatar not found' });
      else res.end();
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.post('/update', async (req: Request, res: Response): Promise<void> => {
  const validationError = validateEditorialContract(req.body);
  if (validationError) { res.status(400).json({ success: false, error: validationError }); return; }
  const input = req.body as PersonalityStatusInput;
  const fingerprint = eventFingerprint(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('bot_status:hermes'))`);
    const sourceReceipt = await resolveStatusSource(client, input);
    const replay = await client.query(`SELECT ${publicProjection} FROM bot_status WHERE idempotency_key=$1`, [fingerprint]);
    if (replay.rows.length) {
      await client.query('COMMIT');
      res.status(200).json({ success: true, outcome: 'duplicate', status: replay.rows[0] });
      return;
    }
    const clock = await client.query('SELECT CURRENT_TIMESTAMP AS now');
    const now = new Date(clock.rows[0].now);
    const recent = await client.query(`SELECT status_text, updated_at FROM bot_status WHERE author_harness='hermes' ORDER BY updated_at DESC LIMIT 50`);
    const suppression = cadenceDecision(input, recent.rows, now);
    if (suppression) {
      await client.query('ROLLBACK');
      res.status(409).json({ success: false, outcome: 'suppressed', reason: suppression });
      return;
    }
    const bounds = londonDayBounds(now);
    const result = await client.query(
      `INSERT INTO bot_status
       (mood,status_text,avatar_url,author,author_harness,source_receipts,idempotency_key,
        cadence_window_start,cadence_window_end,run_type,scheduler_tick_id,failure)
       VALUES ($1,$2,$3,'Hermes','hermes',$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb)
       RETURNING ${publicProjection}`,
      [input.mood.trim(), input.status_text.trim(), input.avatar_url || null,
       JSON.stringify([sourceReceipt]),
       fingerprint, bounds.start.toISOString(), bounds.end.toISOString(), input.trigger === 'manual' ? 'manual' : 'scheduled', input.event_id,
       input.avatar_failure ? JSON.stringify({ stage: 'avatar', code: input.avatar_failure }) : null]
    );
    await client.query('COMMIT');
    res.status(201).json({ success: true, outcome: 'created', status: result.rows[0] });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    const status = error instanceof UntrustedStatusTriggerError ? error.statusCode : 500;
    res.status(status).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  } finally {
    client.release();
  }
});

router.get('/history', async (req: Request, res: Response): Promise<void> => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;
    const [result, countResult] = await Promise.all([
      pool.query(`SELECT ${publicProjection} FROM bot_status ORDER BY updated_at DESC LIMIT $1 OFFSET $2`, [limit, offset]),
      pool.query('SELECT count(*) FROM bot_status'),
    ]);
    const total = parseInt(countResult.rows[0].count, 10);
    res.json({ success: true, history: result.rows, total, page, limit, hasMore: offset + result.rows.length < total });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
