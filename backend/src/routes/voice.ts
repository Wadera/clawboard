/**
 * Voice HTTP routes — companion to VoiceService WebSocket endpoint
 *
 * GET  /voice/status   — PersonaPlex current status (JSON)
 * POST /voice/wol      — Trigger Wake-on-LAN for turbo PC
 */

import { Router, Request, Response } from 'express';
import { VoiceService } from '../services/VoiceService';

let voiceService: VoiceService | null = null;

export function setVoiceService(svc: VoiceService) {
  voiceService = svc;
}

const router = Router();

// GET /voice/status
router.get('/status', (_req: Request, res: Response) => {
  if (!voiceService) {
    res.json({ state: 'unknown' });
    return;
  }
  res.json(voiceService.getStatus());
});

// POST /voice/wol — wake turbo PC
router.post('/wol', async (_req: Request, res: Response) => {
  if (!voiceService) {
    res.status(503).json({ error: 'VoiceService not initialized' });
    return;
  }
  await voiceService.triggerWoL();
  res.json({ ok: true, message: 'WoL packet sent' });
});

export default router;
