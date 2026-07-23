/**
 * reportsWebhooks.test.ts — reports hardening item 8 (task c655d243):
 * report.created / report.updated / report.deleted webhook events, emitted
 * from the reports routes through the existing WebhookService delivery
 * machinery, and registrable via the /webhooks CRUD.
 */
import express, { Request } from 'express';

jest.mock('../services/ReportManager', () => {
  const actual = jest.requireActual('../services/ReportManager');
  return {
    ...actual,
    reportManager: {
      list: jest.fn(),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
      hardDelete: jest.fn(),
    },
  };
});
jest.mock('../services/WebhookService', () => ({
  webhookService: { emitEvent: jest.fn(), start: jest.fn() },
}));
jest.mock('../db/connection', () => ({ pool: { query: jest.fn() } }));

import reportsRoutes from '../routes/reports';
import webhooksRoutes from '../routes/webhooks';
import { reportManager } from '../services/ReportManager';
import { webhookService } from '../services/WebhookService';
import { pool } from '../db/connection';

const manager = reportManager as jest.Mocked<typeof reportManager>;
const hooks = webhookService as jest.Mocked<typeof webhookService>;
const db = pool as jest.Mocked<typeof pool>;
const RID = '11111111-1111-4111-8111-111111111111';

const fullReport = {
  id: RID, title: 'T', content: 'C', content_hash: 'abc', summary: null,
  tags: ['x'], project_id: null, task_ids: [], author: 'nim',
  author_unverified: 'nim', author_actor_id: 'service_account',
  origin: 'api', visibility: 'default', pinned: false,
  created_at: '2026-07-21T00:00:00Z', updated_at: '2026-07-21T00:00:00Z',
  deleted_at: null,
};

async function withServer(userId: string, run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => { (req as Request & { userId?: string }).userId = userId; next(); });
  app.use('/reports', reportsRoutes);
  app.use('/webhooks', webhooksRoutes);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
}

describe('report.* webhook emission from reports routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    manager.create.mockResolvedValue(fullReport as never);
    manager.update.mockResolvedValue(fullReport as never);
    manager.softDelete.mockResolvedValue(true);
    manager.hardDelete.mockResolvedValue(true);
  });

  it('POST emits report.created with a compact summary payload', async () => {
    await withServer('service_account', async base => {
      const res = await fetch(`${base}/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T', content: 'C' }),
      });
      expect(res.status).toBe(201);
      expect(hooks.emitEvent).toHaveBeenCalledTimes(1);
      const [event, payload] = hooks.emitEvent.mock.calls[0];
      expect(event).toBe('report.created');
      expect(payload).toMatchObject({
        id: RID, title: 'T', content_hash: 'abc',
        author_actor_id: 'service_account', origin: 'api', visibility: 'default',
      });
      expect('content' in payload).toBe(false); // summary payload, not the document
    });
  });

  it('PATCH emits report.updated; DELETE emits report.deleted with mode', async () => {
    await withServer('dashboard_user', async base => {
      await fetch(`${base}/reports/${RID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T2' }),
      });
      expect(hooks.emitEvent).toHaveBeenCalledWith('report.updated', expect.objectContaining({ id: RID }));

      await fetch(`${base}/reports/${RID}`, { method: 'DELETE' });
      expect(hooks.emitEvent).toHaveBeenCalledWith('report.deleted', { id: RID, mode: 'soft' });

      await fetch(`${base}/reports/${RID}?hard=true`, { method: 'DELETE' });
      expect(hooks.emitEvent).toHaveBeenCalledWith('report.deleted', { id: RID, mode: 'hard' });
    });
  });

  it('does not emit on failed operations', async () => {
    manager.update.mockResolvedValue(null as never);
    manager.softDelete.mockResolvedValue(false);
    await withServer('service_account', async base => {
      const patch = await fetch(`${base}/reports/${RID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T2' }),
      });
      expect(patch.status).toBe(404);
      const del = await fetch(`${base}/reports/${RID}`, { method: 'DELETE' });
      expect(del.status).toBe(404);
      const badCreate = await fetch(`${base}/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'only-title' }),
      });
      expect(badCreate.status).toBe(400);
      expect(hooks.emitEvent).not.toHaveBeenCalled();
    });
  });
});

describe('webhook registry accepts report.* events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (db.query as jest.Mock).mockResolvedValue({ rows: [{ id: RID }], rowCount: 1 });
  });

  it('POST /webhooks registers report.created/updated/deleted subscriptions', async () => {
    await withServer('dashboard_user', async base => {
      const res = await fetch(`${base}/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.test/hook', events: ['report.created', 'report.updated', 'report.deleted'] }),
      });
      expect(res.status).toBe(201);
    });
  });

  it('still rejects unknown events', async () => {
    await withServer('dashboard_user', async base => {
      const res = await fetch(`${base}/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.test/hook', events: ['report.exploded'] }),
      });
      expect(res.status).toBe(400);
    });
  });
});
