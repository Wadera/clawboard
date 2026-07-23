import { Router, Request, Response } from 'express';
import { AuditService } from '../services/AuditService';

const router = Router();
const auditService = new AuditService();

// GET /audit/events — paginated, filterable
router.get('/events', async (req: Request, res: Response) => {
  try {
    const { eventType, toolName, search, startDate, endDate, page, limit, hoursBack } = req.query;
    const result = await auditService.getEvents({
      eventType: eventType as string,
      toolName: toolName as string,
      search: search as string,
      startDate: startDate as string,
      endDate: endDate as string,
      page: page ? parseInt(page as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      hoursBack: hoursBack ? parseInt(hoursBack as string) : undefined,
    });
    res.json(result);
  } catch (err) {
    console.error('Audit events error:', err);
    res.status(500).json({ error: 'Failed to fetch audit events' });
  }
});

// GET /audit/stats — aggregate stats
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const hoursBack = req.query.hoursBack ? parseInt(req.query.hoursBack as string) : undefined;
    const stats = await auditService.getStats(hoursBack);
    res.json(stats);
  } catch (err) {
    console.error('Audit stats error:', err);
    res.status(500).json({ error: 'Failed to fetch audit stats' });
  }
});

// GET /audit/timeline — events grouped by time buckets
router.get('/timeline', async (req: Request, res: Response) => {
  try {
    const hoursBack = req.query.hoursBack ? parseInt(req.query.hoursBack as string) : undefined;
    const bucketMinutes = req.query.bucketMinutes ? parseInt(req.query.bucketMinutes as string) : undefined;
    const timeline = await auditService.getTimeline(hoursBack, bucketMinutes);
    res.json(timeline);
  } catch (err) {
    console.error('Audit timeline error:', err);
    res.status(500).json({ error: 'Failed to fetch audit timeline' });
  }
});

// GET /audit/model-stats — model usage statistics
router.get('/model-stats', async (req: Request, res: Response) => {
  try {
    const hoursBack = req.query.hoursBack ? parseInt(req.query.hoursBack as string) : undefined;
    const bucketMinutes = req.query.bucketMinutes ? parseInt(req.query.bucketMinutes as string) : undefined;
    const stats = await auditService.getModelStats(hoursBack, bucketMinutes);
    res.json(stats);
  } catch (err) {
    console.error('Audit model stats error:', err);
    res.status(500).json({ error: 'Failed to fetch model usage statistics' });
  }
});

// GET /audit/:entryId/screenshots — get screenshots for a specific event
router.get('/:entryId/screenshots', async (req: Request, res: Response): Promise<void> => {
  try {
    const entryId = req.params.entryId;
    
    // Parse entryId format: sessionId-timestamp-index
    // Timestamp is ISO format (e.g., 2026-01-31T15:30:00.000Z)
    // SessionId is UUID with dashes
    // Index is a number
    const parts = entryId.split('-');
    
    if (parts.length < 3) {
      res.status(400).json({ error: 'Invalid entryId format' });
      return;
    }
    
    // Last part is the index (we parse it to validate format but don't use it)
    const eventIndex = parseInt(parts[parts.length - 1]);
    if (isNaN(eventIndex)) {
      res.status(400).json({ error: 'Invalid event index' });
      return;
    }
    
    // Find where the timestamp starts (look for 4-digit year)
    let timestampStartIdx = -1;
    for (let i = 0; i < parts.length - 1; i++) {
      if (/^\d{4}$/.test(parts[i])) {
        timestampStartIdx = i;
        break;
      }
    }
    
    if (timestampStartIdx === -1) {
      res.status(400).json({ error: 'Could not parse timestamp from entryId' });
      return;
    }
    
    // SessionId is everything before the timestamp
    const sessionId = parts.slice(0, timestampStartIdx).join('-');
    
    // Timestamp is from the year to the second-to-last part
    const timestamp = parts.slice(timestampStartIdx, parts.length - 1).join('-');
    
    const screenshots = await auditService.getScreenshots(sessionId, timestamp);
    res.json({ screenshots });
  } catch (err) {
    console.error('Audit screenshots error:', err);
    res.status(500).json({ error: 'Failed to fetch screenshots' });
  }
});

export default router;
