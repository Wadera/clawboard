import { Router, Request, Response } from 'express';
import { clawboardConfig, getPublicConfig } from '../config/clawboard';

const router = Router();

/**
 * GET /config
 * Returns public configuration (bot, branding, features)
 * Safe to expose to frontend - no sensitive paths or service URLs
 */
router.get('/', (_req: Request, res: Response) => {
  try {
    const publicConfig = getPublicConfig(clawboardConfig);
    res.json(publicConfig);
  } catch (error) {
    console.error('Error getting config:', error);
    res.status(500).json({
      error: 'Failed to get configuration',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
