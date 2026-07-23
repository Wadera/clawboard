import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { sendApiError } from '../utils/apiErrors';
import { validateBody, UUID_RE } from '../middleware/validate';

/** Webhook registry CRUD (task 3c7da35b). Delivery lives in WebhookService. */

const router = Router();

const WEBHOOK_EVENTS = [
  'task.created', 'task.updated', 'task.deleted', 'task.archived',
  'report.created', 'report.updated', 'report.deleted',
] as const;

const createSchema = {
  url: { type: 'string' as const, required: true, maxLen: 2000, pattern: /^https?:\/\//, patternHint: 'must be an http(s) URL' },
  secret: { type: 'string' as const, maxLen: 200 },
  events: { type: 'array' as const, itemsType: 'string' as const },
  description: { type: 'string' as const, maxLen: 500 },
  active: { type: 'boolean' as const },
};

function badEvents(events: unknown): string[] {
  if (!Array.isArray(events)) return [];
  return events.filter(e => !WEBHOOK_EVENTS.includes(e));
}

router.get('/', async (_req: Request, res: Response) => {
  const r = await pool.query('SELECT id, url, events, active, description, created_at, last_delivery_at, last_delivery_status, last_delivery_error, (secret IS NOT NULL) AS has_secret FROM webhooks ORDER BY created_at');
  res.json({ success: true, webhooks: r.rows });
});

router.post('/', validateBody(createSchema), async (req: Request, res: Response) => {
  const bad = badEvents(req.body.events);
  if (bad.length) {
    sendApiError(res, 400, 'UNKNOWN_EVENT', `Unknown event(s): ${bad.join(', ')}`,
      `Valid events: ${WEBHOOK_EVENTS.join(', ')}`);
    return;
  }
  const { url, secret, events, description, active } = req.body;
  const r = await pool.query(
    `INSERT INTO webhooks (url, secret, events, description, active)
     VALUES ($1, $2, COALESCE($3, ARRAY['task.created','task.updated','task.deleted','task.archived']), $4, COALESCE($5, true))
     RETURNING id, url, events, active, description, created_at`,
    [url, secret ?? null, events && events.length ? events : null, description ?? null, active],
  );
  res.status(201).json({ success: true, webhook: r.rows[0] });
});

router.patch('/:id', validateBody(createSchema, { allowUnknown: false }), async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) {
    sendApiError(res, 400, 'INVALID_WEBHOOK_ID', 'Webhook id must be a UUID'); return;
  }
  const bad = badEvents(req.body.events);
  if (bad.length) {
    sendApiError(res, 400, 'UNKNOWN_EVENT', `Unknown event(s): ${bad.join(', ')}`,
      `Valid events: ${WEBHOOK_EVENTS.join(', ')}`);
    return;
  }
  const { url, secret, events, description, active } = req.body;
  const r = await pool.query(
    `UPDATE webhooks SET
       url = COALESCE($2, url),
       secret = COALESCE($3, secret),
       events = COALESCE($4, events),
       description = COALESCE($5, description),
       active = COALESCE($6, active)
     WHERE id = $1
     RETURNING id, url, events, active, description, created_at`,
    [req.params.id, url ?? null, secret ?? null, events && events.length ? events : null, description ?? null, active ?? null],
  );
  if (!r.rowCount) { sendApiError(res, 404, 'WEBHOOK_NOT_FOUND', 'No webhook with that id'); return; }
  res.json({ success: true, webhook: r.rows[0] });
});

router.delete('/:id', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) {
    sendApiError(res, 400, 'INVALID_WEBHOOK_ID', 'Webhook id must be a UUID'); return;
  }
  const r = await pool.query('DELETE FROM webhooks WHERE id = $1', [req.params.id]);
  if (!r.rowCount) { sendApiError(res, 404, 'WEBHOOK_NOT_FOUND', 'No webhook with that id'); return; }
  res.json({ success: true });
});

export default router;
