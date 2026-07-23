import express from 'express';
import journalRoutes from '../routes/journal';
import { journalService } from '../services/JournalService';

jest.mock('../services/JournalService', () => ({
  journalService: {
    list: jest.fn(),
    getLatest: jest.fn(),
    getById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}));

describe('journal narrative boundary', () => {
  it.each(['/journal', '/journal/', '/journal?source=agent'])('fails closed at POST %s without invoking create', async (path) => {
    const app = express();
    app.use(express.json());
    app.use('/journal', journalRoutes);
    const server = app.listen(0, '127.0.0.1');

    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: '2026-07-11', reflection_text: 'operational event' }),
      });
      const body = await response.json();

      expect(response.status).toBe(410);
      expect(body).toEqual({
        success: false,
        error: 'Direct journal creation is retired; use the review-gated Hermes journal pipeline',
      });
      expect(journalService.create).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
