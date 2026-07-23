import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is required (no insecure fallback).');
}
const PASSWORD_HASH = process.env.DASHBOARD_PASSWORD_HASH || '';
const TOKEN_EXPIRY: string = process.env.TOKEN_EXPIRY || '30d'; // 30d dashboard session; automation should use CLAWBOARD_API_KEY
const MEDIA_COOKIE = 'nim_content_engine_media';
const MEDIA_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
  path: '/api/content-engine',
};

if (!PASSWORD_HASH) {
  console.warn('⚠️  WARNING: DASHBOARD_PASSWORD_HASH not set in environment variables!');
}

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { password } = req.body;

    if (!password) {
      res.status(400).json({ error: 'Bad Request', message: 'Password is required' });
      return;
    }

    // Verify password against bcrypt hash
    const isValid = await bcrypt.compare(password, PASSWORD_HASH);

    if (!isValid) {
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid password' });
      return;
    }

    // Generate JWT token
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = (jwt.sign as any)(
      { userId: 'dashboard_user' },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY }
    );

    res.cookie(MEDIA_COOKIE, token, MEDIA_COOKIE_OPTIONS);
    res.json({ 
      success: true,
      token,
      expiresIn: TOKEN_EXPIRY
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      error: 'Internal Server Error', 
      message: 'Login failed' 
    });
  }
});

// Refresh the scoped HttpOnly media cookie for an already-authenticated SPA session.
router.post('/media-session', (req: Request, res: Response): void => {
  try {
    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized', message: 'No token provided' });
      return;
    }
    const token = authorization.slice(7);
    jwt.verify(token, JWT_SECRET);
    res.cookie(MEDIA_COOKIE, token, MEDIA_COOKIE_OPTIONS);
    res.status(204).send();
  } catch {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
  }
});

export default router;
