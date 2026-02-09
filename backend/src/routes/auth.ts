import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';
const PASSWORD_HASH = process.env.DASHBOARD_PASSWORD_HASH || '';
const TOKEN_EXPIRY = '7d'; // 7 days

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

    // Generate JWT token (7-day expiry)
    const token = jwt.sign(
      { userId: 'dashboard_user' }, // Payload - can add more data if needed
      JWT_SECRET,
      { 
        expiresIn: TOKEN_EXPIRY,
        algorithm: 'HS256'
      }
    );

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

export default router;
