import express from 'express';
import type { Request, Response } from 'express';
import { ModelStatusService } from '../services/modelStatus';

let modelStatusService: ModelStatusService | null = null;

export function setModelStatusService(svc: ModelStatusService) {
  modelStatusService = svc;
}

const router = express.Router();

/**
 * GET /model-status - Get current model and context usage
 */
router.get('/', async (_req: Request, res: Response) => {
  if (!modelStatusService) {
    res.status(503).json({ success: false, error: 'Model status service not initialized' });
    return;
  }

  const status = await modelStatusService.getStatus();
  if (!status) {
    res.status(404).json({ success: false, error: 'No active session found' });
    return;
  }

  res.json({ success: true, ...status });
});

export default router;
