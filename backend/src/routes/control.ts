import express from 'express';
import type { Request, Response } from 'express';
import { ControlService } from '../services/controlService';

let controlService: ControlService | null = null;

export function setControlService(svc: ControlService) {
  controlService = svc;
}

const router = express.Router();

/**
 * POST /control/stop-main - Stop the main bot session
 */
router.post('/stop-main', async (_req: Request, res: Response) => {
  if (!controlService) {
    res.status(503).json({ success: false, error: 'Control service not initialized' });
    return;
  }

  console.log('🛑 Stop main session requested');
  const result = await controlService.stopMain();
  res.json(result);
});

/**
 * POST /control/stop-agent/:key - Stop a specific sub-agent
 */
router.post('/stop-agent/:key', async (req: Request, res: Response) => {
  if (!controlService) {
    res.status(503).json({ success: false, error: 'Control service not initialized' });
    return;
  }

  const { key } = req.params;
  console.log(`🛑 Stop agent requested: ${key}`);
  const result = await controlService.stopAgent(decodeURIComponent(key));
  res.json(result);
});

/**
 * POST /control/stop-all - Emergency stop all sessions
 */
router.post('/stop-all', async (_req: Request, res: Response) => {
  if (!controlService) {
    res.status(503).json({ success: false, error: 'Control service not initialized' });
    return;
  }

  console.log('🛑🛑🛑 EMERGENCY STOP ALL requested');
  const results = await controlService.stopAll();
  res.json({
    success: results.every(r => r.success),
    results,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /control/agents - List active sub-agents
 */
router.get('/agents', async (_req: Request, res: Response) => {
  if (!controlService) {
    res.status(503).json({ success: false, error: 'Control service not initialized' });
    return;
  }

  const agents = await controlService.getActiveAgents();
  res.json({ success: true, agents });
});

export default router;
