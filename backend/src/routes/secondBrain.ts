import { Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';

// Second Brain (knowledge fabric) read-only stats proxy — SB-DASH-1.
// The kf-broker is LAN-bound on 192.168.40.150:8940 (it binds the LAN IP only, so
// host.docker.internal resolves to the wrong interface and will NOT work — keep the
// LAN IP default). The dashboard credential is stats-only on the broker side:
// even if it leaked, it can read no vault content.
const router = Router();

const PRIVATE_FIELD = /^(?:authorization|credential|secret|token|api[-_]?key)$/i;

export function sanitizeSecondBrainJson(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new Error('Second Brain JSON nesting limit exceeded');
  if (Array.isArray(value)) return value.map(item => sanitizeSecondBrainJson(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_FIELD.test(key)) continue;
    safe[key] = sanitizeSecondBrainJson(child, depth + 1);
  }
  return safe;
}

function brokerBase(): string {
  return (process.env.KF_BROKER_URL || 'http://192.168.40.150:8940').replace(/\/$/, '');
}

// upstreamPath is a fixed allowlisted constant per route — never derived from req.
async function proxyBrokerGet(res: Response, upstreamPath: string, withCredential: boolean): Promise<void> {
  const credential = process.env.KF_DASHBOARD_CREDENTIAL;
  if (withCredential && !credential) {
    res.status(503).json({ error: 'Second Brain stats are not configured' });
    return;
  }
  try {
    const upstream = await fetch(`${brokerBase()}${upstreamPath}`, {
      method: 'GET',
      headers: withCredential && credential ? { 'X-KF-Credential': credential } : {},
      signal: AbortSignal.timeout(15_000),
    });
    const text = await upstream.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      res.status(502).json({ error: 'Second Brain broker returned a non-JSON response' });
      return;
    }
    res.status(upstream.status).json(sanitizeSecondBrainJson(parsed));
  } catch (error) {
    console.warn('Second Brain broker unavailable:', error instanceof Error ? error.message : 'unknown error');
    res.status(503).json({ error: 'Second Brain broker unavailable' });
  }
}

export function secondBrainStatusHandler(_req: Request, res: Response): Promise<void> {
  return proxyBrokerGet(res, '/v0/stats', true);
}

export function secondBrainLinkgraphHandler(_req: Request, res: Response): Promise<void> {
  return proxyBrokerGet(res, '/v0/stats/linkgraph', true);
}

export function secondBrainSemanticEdgesHandler(_req: Request, res: Response): Promise<void> {
  return proxyBrokerGet(res, '/v0/stats/semantic-edges', true);
}

export function secondBrainBrokerHealthHandler(_req: Request, res: Response): Promise<void> {
  return proxyBrokerGet(res, '/health', false);
}

// --- Qdrant UI session bridge (SB-DASH-5) ---------------------------------
// The Qdrant web UI lives on qdrant.nimspace.skyday.eu behind a traefik
// forwardAuth that calls /second-brain/qdrant-auth. A logged-in dashboard user
// mints a short-lived signed cookie here (ClawBoard JWTs live in localStorage,
// so a plain browser navigation can't carry them); the cookie is parent-domain
// scoped so the subdomain receives it. The read-only Qdrant API key is injected
// by traefik server-side — it never reaches the browser.
const QDRANT_COOKIE = 'sb_qdrant';
const QDRANT_SESSION_TTL_S = 12 * 60 * 60;
const QDRANT_UI_URL = process.env.QDRANT_UI_URL || 'https://qdrant.nimspace.skyday.eu/dashboard';
const COOKIE_DOMAIN = process.env.QDRANT_COOKIE_DOMAIN || 'nimspace.skyday.eu';

export function qdrantSessionHandler(_req: Request, res: Response): void {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'Qdrant UI session signing is not configured' });
    return;
  }
  const token = jwt.sign({ scope: 'qdrant-ui' }, secret, { expiresIn: QDRANT_SESSION_TTL_S });
  res.setHeader('Set-Cookie',
    `${QDRANT_COOKIE}=${token}; Domain=${COOKIE_DOMAIN}; Path=/; Max-Age=${QDRANT_SESSION_TTL_S}; Secure; HttpOnly; SameSite=Lax`);
  res.json({ ok: true, url: QDRANT_UI_URL, expiresInS: QDRANT_SESSION_TTL_S });
}

// traefik forwardAuth target — intentionally OUTSIDE authMiddleware (the browser
// navigation to the subdomain carries only the cookie). Mounted separately in
// server.ts. Verifies the signed cookie and nothing else; no body, no side effects.
export function qdrantForwardAuthHandler(req: Request, res: Response): void {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'not configured' });
    return;
  }
  const cookies = req.headers.cookie || '';
  const match = cookies.split(/;\s*/).find(c => c.startsWith(`${QDRANT_COOKIE}=`));
  const token = match ? match.slice(QDRANT_COOKIE.length + 1) : '';
  try {
    const decoded = jwt.verify(token, secret) as { scope?: string };
    if (decoded.scope !== 'qdrant-ui') throw new Error('wrong scope');
    res.status(204).end();
  } catch {
    res.status(401).json({ error: 'Open the Second Brain page in ClawBoard and use "Open Qdrant UI" to start a session' });
  }
}

router.get('/status', secondBrainStatusHandler);
router.get('/linkgraph', secondBrainLinkgraphHandler);
router.get('/semantic-edges', secondBrainSemanticEdgesHandler);
router.get('/broker-health', secondBrainBrokerHealthHandler);
router.post('/qdrant-session', qdrantSessionHandler);

export default router;
