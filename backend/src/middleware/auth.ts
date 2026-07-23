import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is required (no insecure fallback).');
}
const API_KEY = process.env.CLAWBOARD_API_KEY || '';
const JOURNAL_PUBLISH_KEY = process.env.CLAWBOARD_JOURNAL_PUBLISH_API_KEY || '';
const MEDIA_COOKIE = 'nim_content_engine_media';
const REPORTS_READ_KEY = process.env.CLAWBOARD_REPORTS_READ_API_KEY || '';
const equalSecret = (a: string, b: string): boolean => !!a && !!b && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieValue = (header: string | undefined, name: string): string => {
  for (const part of (header || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
};

interface AuthRequest extends Request {
  userId?: string;
}

export const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction): void => {
  try {
    const journalKey = req.headers['x-journal-publish-key'] as string;
    if (journalKey) {
      const mountedPath = `${req.baseUrl || ''}${req.path}`;
      const scopedPath = /^\/journal\/hermes-runs\/[0-9a-f]{32}(?:\/(?:publish|rollback))?$/.test(mountedPath);
      const scopedMethod = req.method === 'GET' || req.method === 'POST';
      if (!scopedPath || !scopedMethod || !equalSecret(journalKey, JOURNAL_PUBLISH_KEY)) {
        res.status(403).json({ error: 'Forbidden', message: 'Journal publisher key is invalid or out of scope' });
        return;
      }
      req.userId = 'journal_publisher';
      next();
      return;
    }
    // Scoped read-only key: GET-only access to reports + journal (knowledge-fabric connector)
    const reportsReadKey = req.headers['x-reports-read-key'] as string;
    if (reportsReadKey) {
      const mountedPath = `${req.baseUrl || ''}${req.path}`;
      const scopedPath = /^\/(reports(\/[0-9a-f-]{36})?\/?|journal(\/(latest|[0-9a-f-]{36}(\/navigation)?))?\/?)$/.test(mountedPath);
      const scopedMethod = req.method === 'GET';
      if (!scopedPath || !scopedMethod || !equalSecret(reportsReadKey, REPORTS_READ_KEY)) {
        res.status(403).json({ error: 'Forbidden', message: 'Reports read key is invalid or out of scope' });
        return;
      }
      req.userId = 'reports_reader';
      next();
      return;
    }
    // 1. Check for API key (non-expiring, for service accounts / automation)
    const apiKey = req.headers['x-api-key'] as string;
    if (apiKey && API_KEY && apiKey === API_KEY) {
      req.userId = 'service_account';
      next();
      return;
    }

    // 2. Check for Bearer JWT token (standard auth)
    const authHeader = req.headers.authorization;
    const mountedPath = `${req.baseUrl || ''}${req.path}`;
    const mediaCookieAllowed = req.method === 'GET'
      && /^\/content-engine\/v1\/daily-reports\/[^/?#\s]+\/artifacts\/[^/?#\s]+$/.test(mountedPath);
    const mediaToken = mediaCookieAllowed ? cookieValue(req.headers.cookie, MEDIA_COOKIE) : '';
    
    if ((!authHeader || !authHeader.startsWith('Bearer ')) && !mediaToken) {
      res.status(401).json({ error: 'Unauthorized', message: 'No token provided' });
      return;
    }

    const token = mediaToken || authHeader!.substring(7); // Remove 'Bearer ' prefix

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    
    // Attach userId to request (for future use if needed)
    req.userId = decoded.userId;
    
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Unauthorized', message: 'Token expired' });
      return;
    }
    
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
      return;
    }
    
    res.status(500).json({ error: 'Internal Server Error', message: 'Authentication failed' });
  }
};
