import { Request, Response, Router } from 'express';

const router = Router();
const ALLOWED_PATH = /^\/v1\/daily-reports(?:\/[^/?#\s]+)*\/?$/;
const PRIVATE_FIELD = /^(?:authorization|credential|filesystem_path|local_path|private_path|provider_url|relative_path|secret|source_path|storage_path|token)$/i;
const PRIVATE_VALUE = /(?:file:\/\/|\/(?:home|mnt|srv|var\/lib)\/|https?:\/\/(?:content-engine-report-api|localhost|127\.0\.0\.1)(?=[:/]|$)|[?&](?:access_token|api_key|token)=)/i;

export function sanitizeContentEngineJson(value: unknown, depth = 0): unknown {
  if (depth > 30) throw new Error('Content Engine JSON nesting limit exceeded');
  if (Array.isArray(value)) return value.map(item => sanitizeContentEngineJson(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && PRIVATE_VALUE.test(value)) throw new Error('private locator in Content Engine response');
    return value;
  }
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_FIELD.test(key)) continue;
    safe[key] = sanitizeContentEngineJson(child, depth + 1);
  }
  return safe;
}

function upstreamBase(): string {
  return (process.env.CONTENT_ENGINE_REPORT_API_URL || 'http://content-engine-report-api:8765').replace(/\/$/, '');
}

export async function proxyContentEngineRequest(req: Request, res: Response): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const token = process.env.CONTENT_ENGINE_REPORT_API_TOKEN;
  if (!token) {
    res.status(503).json({ error: 'Content Engine report service is not configured' });
    return;
  }

  const path = req.url;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(path, 'http://content-engine.internal').pathname);
  } catch {
    res.status(400).json({ error: 'Invalid Content Engine report path' });
    return;
  }
  if (!ALLOWED_PATH.test(pathname) || pathname.includes('..')) {
    res.status(400).json({ error: 'Invalid Content Engine report path' });
    return;
  }

  try {
    const upstream = await fetch(`${upstreamBase()}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    let body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || '';
    const artifactResponse = /^\/v1\/daily-reports\/[^/?#\s]+\/artifacts\/[^/?#\s]+$/.test(pathname);
    if (contentType.toLowerCase().includes('application/json')) {
      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'));
        body = Buffer.from(JSON.stringify(sanitizeContentEngineJson(parsed)));
      } catch {
        res.status(502).json({ error: 'Content Engine report service returned an unsafe response' });
        return;
      }
    }
    for (const header of ['content-type', 'cache-control', 'content-disposition', 'x-content-type-options']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (artifactResponse) {
      res.setHeader('Accept-Ranges', 'bytes');
      const range = req.headers.range;
      if (range && upstream.status === 200) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        const size = body.length;
        if (!match || (!match[1] && !match[2])) {
          res.setHeader('Content-Range', `bytes */${size}`);
          res.status(416).send(Buffer.alloc(0));
          return;
        }
        let start: number;
        let end: number;
        if (!match[1]) {
          const suffix = Number(match[2]);
          start = Math.max(0, size - suffix);
          end = size - 1;
        } else {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
          res.setHeader('Content-Range', `bytes */${size}`);
          res.status(416).send(Buffer.alloc(0));
          return;
        }
        body = body.subarray(start, end + 1);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', String(body.length));
        res.status(206).send(body);
        return;
      }
      res.setHeader('Content-Length', String(body.length));
    }
    res.status(upstream.status).send(body);
  } catch (error) {
    console.warn('Content Engine report upstream unavailable:', error instanceof Error ? error.message : 'unknown error');
    res.status(503).json({ error: 'Content Engine report service unavailable' });
  }
}

router.use(proxyContentEngineRequest);
export default router;
