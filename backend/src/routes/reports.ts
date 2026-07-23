// reports.ts - API endpoints for reports/notes management
import { Router, Request, Response } from 'express';
import { reportManager, Report } from '../services/ReportManager';
import { webhookService } from '../services/WebhookService';
import { rejectInvalidReportIdParam } from '../utils/reportIds';

interface AuthedRequest extends Request {
  userId?: string;
}

const router = Router();

/** Compact webhook payload — same shape philosophy as taskSummary in WebhookService. */
function reportSummary(report: Report): Record<string, unknown> {
  return {
    id: report.id,
    title: report.title,
    project_id: report.project_id ?? null,
    tags: report.tags ?? [],
    pinned: report.pinned ?? false,
    author: report.author ?? null,
    author_actor_id: report.author_actor_id ?? null,
    origin: report.origin ?? 'api',
    visibility: report.visibility ?? 'default',
    content_hash: report.content_hash ?? null,
    updated_at: report.updated_at,
  };
}

/**
 * author_actor_id is verified provenance (recorded from the authenticated
 * identity) — a client-supplied value is always an impersonation attempt.
 * Returns true (and responds 400) when the body tries to set it.
 */
const ORIGIN_RE = /^[a-z0-9_-]{1,32}$/;
const VISIBILITY_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * Validate an optional visibility body value (migration 061 — plumbing only,
 * no enforcement here). Returns true (and responds 400) when malformed.
 */
function rejectBadVisibility(req: Request, res: Response): boolean {
  const value = req.body?.visibility;
  if (value === undefined) return false;
  if (typeof value !== 'string' || !VISIBILITY_RE.test(value)) {
    res.status(400).json({
      success: false,
      error: 'visibility must match [a-z0-9_-]{1,32} (e.g. default, private, team)',
      code: 'INVALID_VISIBILITY',
    });
    return true;
  }
  return false;
}

/**
 * Resolve the creating surface from the optional X-ClawBoard-Origin header
 * ('api' | 'cli' | 'dashboard' | ...). Returns null (after responding 400)
 * on a malformed value; defaults to 'api' when the header is absent.
 */
function resolveOrigin(req: Request, res: Response): string | null {
  const header = req.headers['x-clawboard-origin'];
  if (header === undefined) return 'api';
  const value = String(Array.isArray(header) ? header[0] : header).trim().toLowerCase();
  if (!ORIGIN_RE.test(value)) {
    res.status(400).json({
      success: false,
      error: 'X-ClawBoard-Origin must match [a-z0-9_-]{1,32} (e.g. api, cli, dashboard)',
      code: 'INVALID_ORIGIN',
    });
    return null;
  }
  return value;
}

function rejectBodyActorId(req: Request, res: Response): boolean {
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'author_actor_id')) {
    res.status(400).json({
      success: false,
      error: 'author_actor_id is set from the authenticated identity and cannot be supplied in the body (use author for a display label)',
      code: 'AUTHOR_ACTOR_ID_FORBIDDEN',
    });
    return true;
  }
  return false;
}

/**
 * GET /reports
 * List reports with pagination, filtering, and search
 * Query params: q, tags (comma-separated), project_id, pinned, limit, offset,
 *               updated_since (ISO8601, inclusive), sort (updated_at|created_at), order (asc|desc)
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

    const updated_since = req.query.updated_since as string | undefined;
    if (updated_since !== undefined && Number.isNaN(Date.parse(updated_since))) {
      res.status(400).json({
        success: false,
        error: 'updated_since must be an ISO8601 timestamp (e.g. 2026-07-21T00:00:00Z)',
        code: 'INVALID_UPDATED_SINCE',
      });
      return;
    }

    const sort = req.query.sort as string | undefined;
    if (sort !== undefined && sort !== 'updated_at' && sort !== 'created_at') {
      res.status(400).json({
        success: false,
        error: "sort must be 'updated_at' or 'created_at'",
        code: 'INVALID_SORT',
      });
      return;
    }

    const order = req.query.order as string | undefined;
    if (order !== undefined && order !== 'asc' && order !== 'desc') {
      res.status(400).json({
        success: false,
        error: "order must be 'asc' or 'desc'",
        code: 'INVALID_ORDER',
      });
      return;
    }

    const include_deleted = req.query.include_deleted === 'true';

    const result = await reportManager.list({
      q, tags, project_id, pinned, limit, offset,
      updated_since,
      sort: sort as 'updated_at' | 'created_at' | undefined,
      order: order as 'asc' | 'desc' | undefined,
      include_deleted,
    });

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
  if (rejectInvalidReportIdParam(req.params.id, res)) return;
  try {
    const report = await reportManager.getById(req.params.id, {
      includeDeleted: req.query.include_deleted === 'true',
    });
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
 * author is a free-form display label (recorded unverified); author_actor_id is
 * always taken from the authenticated identity and rejected if supplied.
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  if (rejectBodyActorId(req, res)) return;
  if (rejectBadVisibility(req, res)) return;
  const origin = resolveOrigin(req, res);
  if (origin === null) return;
  try {
    const { title, content, summary, tags, project_id, task_ids, author, visibility, pinned } = req.body;

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
      author_actor_id: (req as AuthedRequest).userId ?? null,
      origin,
      visibility,
      pinned,
    });

    webhookService.emitEvent('report.created', reportSummary(report));
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
  if (rejectInvalidReportIdParam(req.params.id, res)) return;
  if (rejectBodyActorId(req, res)) return;
  if (rejectBadVisibility(req, res)) return;
  try {
    const updates = { ...req.body };
    delete updates.id;
    delete updates.created_at;
    delete updates.author_unverified; // response-only alias of author

    const report = await reportManager.update(req.params.id, updates);
    if (!report) {
      res.status(404).json({ success: false, error: 'Report not found' });
      return;
    }

    webhookService.emitEvent('report.updated', reportSummary(report));
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
 * Soft delete (tombstone) by default. ?hard=true destroys the row and is
 * restricted to the dashboard_user identity.
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  if (rejectInvalidReportIdParam(req.params.id, res)) return;
  try {
    const hard = req.query.hard === 'true';
    if (hard && (req as AuthedRequest).userId !== 'dashboard_user') {
      res.status(403).json({
        success: false,
        error: 'hard delete is restricted to the dashboard user; omit ?hard=true for a soft delete',
        code: 'HARD_DELETE_FORBIDDEN',
      });
      return;
    }

    const deleted = hard
      ? await reportManager.hardDelete(req.params.id)
      : await reportManager.softDelete(req.params.id);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Report not found' });
      return;
    }
    webhookService.emitEvent('report.deleted', { id: req.params.id, mode: hard ? 'hard' : 'soft' });
    res.json({ success: true, mode: hard ? 'hard' : 'soft' });
  } catch (err) {
    console.error('[Reports API] Error deleting report:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

export default router;
