// agentTypes.ts - REST API for agent persona types
import { Router, Request, Response } from 'express';
import { agentTypeService } from '../services/AgentTypeService';

const router = Router();

/**
 * GET /agent-types — list live personas.
 *   ?category=<cat>       filter by category
 *   ?includeRetired=true  also include soft-deleted (retired duplicate) rows
 *
 * Each row carries provenance: `source` ('git' | 'legacy-db') and `retired_at`.
 * Retired rows are excluded by default so integrity tooling (clawboard doctor)
 * sees exactly one live persona per name/slug.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const category = req.query.category as string | undefined;
    const includeRetired = req.query.includeRetired === 'true' || req.query.includeRetired === '1';
    const types = await agentTypeService.list(category, includeRetired);
    const categories = await agentTypeService.categories();
    res.json({ success: true, agentTypes: types, categories });
  } catch (err) {
    console.error('[agentTypes] list error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch agent types' });
  }
});

/** GET /agent-types/:id — full detail including content */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // Support lookup by UUID or slug
    const isUUID = /^[0-9a-f-]{36}$/.test(id);
    const type = isUUID
      ? await agentTypeService.getById(id)
      : await agentTypeService.getBySlug(id);

    if (!type) {
      res.status(404).json({ success: false, error: 'Agent type not found' });
      return;
    }

    const [sessions, tasks] = await Promise.all([
      agentTypeService.getLinkedSessions(type.id),
      agentTypeService.getLinkedTasks(type.id),
    ]);

    res.json({ success: true, agentType: type, linkedSessions: sessions, linkedTasks: tasks });
  } catch (err) {
    console.error('[agentTypes] get error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch agent type' });
  }
});

/** POST /agent-types/sync — re-sync from local repo clone */
router.post('/sync', async (_req: Request, res: Response) => {
  try {
    const result = await agentTypeService.syncFromRepo();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[agentTypes] sync error:', err);
    res.status(500).json({ success: false, error: 'Sync failed' });
  }
});

export default router;
