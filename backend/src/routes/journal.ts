// journal.ts - API endpoints for bot journal
import { Router, Request, Response } from 'express';
import { journalService } from '../services/JournalService';
import { journalPublicationService, JournalPublicationError } from '../services/JournalPublicationService';
import { journalRunService, JournalRunError } from '../services/JournalRunService';

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

function requireServiceAccount(req: Request, res: Response): boolean {
  if ((req as Request & { userId?: string }).userId !== 'journal_publisher') {
    res.status(403).json({ success: false, error: 'Dedicated Journal publisher authentication is required' });
    return false;
  }
  return true;
}

function journalRunFailure(res: Response, error: unknown): void {
  const status = error instanceof JournalRunError ? error.status : 500;
  res.status(status).json({ success: false, error: error instanceof JournalRunError ? error.message : 'Journal run operation failed' });
}

router.get('/runs', async (req: Request, res: Response): Promise<void> => {
  try { res.json({ success: true, runs: await journalRunService.list(Number(req.query.limit || 20)) }); }
  catch (error) { journalRunFailure(res, error); }
});
router.get('/runs/:key', async (req: Request, res: Response): Promise<void> => {
  try { res.json({ success: true, run: await journalRunService.get(req.params.key) }); }
  catch (error) { journalRunFailure(res, error); }
});
router.get('/runs/:key/history', async (req: Request, res: Response): Promise<void> => {
  try { res.json({ success: true, history: await journalRunService.history(req.params.key) }); }
  catch (error) { journalRunFailure(res, error); }
});
router.post('/runs/:key/retry', async (req: Request, res: Response): Promise<void> => {
  try { res.json({ success: true, run: await journalRunService.retry(req.params.key) }); }
  catch (error) { journalRunFailure(res, error); }
});
router.post('/runs/:key/review', async (req: Request, res: Response): Promise<void> => {
  const actor = (req as Request & { userId?: string }).userId;
  if (!actor || actor === 'service_account') { res.status(403).json({ success: false, error: 'Human dashboard authentication is required' }); return; }
  const decision = req.body?.decision;
  if (decision !== 'approve' && decision !== 'reject') { res.status(400).json({ success: false, error: 'decision must be approve or reject' }); return; }
  try { res.json({ success: true, run: await journalRunService.review(req.params.key, actor, decision, String(req.body?.note || '')) }); }
  catch (error) { journalRunFailure(res, error); }
});

function publicationError(res: Response, err: unknown): void {
  if (err instanceof JournalPublicationError) {
    res.status(err.status).json({ success: false, error: err.message });
    return;
  }
  console.error('[Journal publication] Internal error:', err);
  res.status(500).json({ success: false, error: 'Journal publication failed' });
}

router.get('/mindscape', async (req: Request, res: Response): Promise<void> => {
  try { res.json({ success: true, tracks: await journalPublicationService.listMindscape(Number(req.query.limit || 100)) }); }
  catch (err) { publicationError(res, err); }
});

router.get('/mindscape/:key/audio', async (req: Request, res: Response): Promise<void> => {
  try {
    const song = await journalPublicationService.readPrivateSong(req.params.key);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `inline; filename="${req.params.key}.mp3"`);
    res.send(song.bytes);
  } catch (err) { publicationError(res, err); }
});

router.post('/hermes-approvals/:key', async (req: Request, res: Response): Promise<void> => {
  const actor = (req as Request & { userId?: string }).userId;
  if (!actor || actor === 'service_account' || actor === 'journal_publisher') { res.status(403).json({ success: false, error: 'Human dashboard authentication is required' }); return; }
  try {
    const result = await journalPublicationService.approve(req.params.key, actor);
    res.status(result.replay ? 200 : 201).json({ success: true, ...result });
  } catch (err) { publicationError(res, err); }
});

router.get('/hermes-runs/:key', async (req: Request, res: Response): Promise<void> => {
  if (!requireServiceAccount(req, res)) return;
  try {
    const publication = await journalPublicationService.get(req.params.key);
    if (!publication) { res.status(404).json({ success: false, error: 'Publication not found' }); return; }
    res.json({ success: true, publication });
  } catch (err) { publicationError(res, err); }
});

router.post('/hermes-runs/:key/publish', async (req: Request, res: Response): Promise<void> => {
  if (!requireServiceAccount(req, res)) return;
  if (req.body && Object.keys(req.body).length) { res.status(400).json({ success: false, error: 'Publication body must be empty; the server imports the approved canonical run' }); return; }
  try {
    const result = await journalPublicationService.publish(req.params.key);
    res.status(result.replay ? 200 : 201).json({ success: true, ...result });
  } catch (err) { publicationError(res, err); }
});

router.post('/hermes-runs/:key/rollback', async (req: Request, res: Response): Promise<void> => {
  if (!requireServiceAccount(req, res)) return;
  try {
    const result = await journalPublicationService.rollback(req.params.key, req.body?.approval_fingerprint);
    res.json({ success: true, ...result });
  } catch (err) { publicationError(res, err); }
});

/**
 * GET /api/journal/:id/navigation — get previous/next entry IDs
 */
router.get('/:id/navigation', async (req: Request, res: Response): Promise<void> => {
  try {
    const navigation = await journalService.getNavigation(req.params.id);
    res.json({ success: true, navigation });
  } catch (err) {
    console.error('[Journal API] Error getting navigation:', err);
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
 * POST /api/journal — retired direct-create surface.
 *
 * Journal entries are editorial narrative artifacts, not a generic event log. The
 * old authenticated endpoint was repeatedly used by task smoke tests, monitoring,
 * and application write-backs. Keep reads and human repair operations available,
 * but fail closed until the reviewed /journal/hermes-runs contract is deployed.
 */
export function rejectDirectJournalCreate(_req: Request, res: Response): void {
  res.status(410).json({
    success: false,
    error: 'Direct journal creation is retired; use the review-gated Hermes journal pipeline'
  });
}

router.post('/', rejectDirectJournalCreate);

/**
 * PUT /api/journal/:id — update entry
 */
router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const entry = await journalService.update(req.params.id, req.body);
    res.json({ success: true, entry });
  } catch (err) {
    console.error('Failed to update journal entry:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /api/journal/:id — delete entry
 */
router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    await journalService.delete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete journal entry:', err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

export default router;
