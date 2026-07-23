/**
 * reportsAuthorActor.test.ts — reports hardening item 4 (task c655d243):
 * author_actor_id is recorded from the authenticated identity (req.userId)
 * on POST; the client `author` field stays but is exposed as
 * author_unverified; body attempts to set author_actor_id are rejected.
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
      delete: jest.fn(),
    },
  };
});

import reportsRoutes from '../routes/reports';
import { reportManager } from '../services/ReportManager';

const manager = reportManager as jest.Mocked<typeof reportManager>;
const { ReportManager } = jest.requireActual('../services/ReportManager');

const RID = '11111111-1111-4111-8111-111111111111';

async function withServer(userId: string | undefined, run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => { (req as Request & { userId?: string }).userId = userId; next(); });
  app.use('/reports', reportsRoutes);
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

describe('author_actor_id provenance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    manager.create.mockResolvedValue({ id: RID } as never);
    manager.update.mockResolvedValue({ id: RID } as never);
  });

  it('POST records the authenticated identity as author_actor_id', async () => {
    await withServer('service_account', async base => {
      const res = await fetch(`${base}/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T', content: 'C', author: 'friendly-label' }),
      });
      expect(res.status).toBe(201);
      expect(manager.create).toHaveBeenCalledWith(expect.objectContaining({
        author: 'friendly-label',
        author_actor_id: 'service_account',
      }));
    });
  });

  it('POST rejects author_actor_id supplied in the body with 400', async () => {
    await withServer('service_account', async base => {
      const res = await fetch(`${base}/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T', content: 'C', author_actor_id: 'dashboard_user' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('AUTHOR_ACTOR_ID_FORBIDDEN');
      expect(manager.create).not.toHaveBeenCalled();
    });
  });

  it('PATCH rejects author_actor_id supplied in the body with 400', async () => {
    await withServer('dashboard_user', async base => {
      const res = await fetch(`${base}/reports/${RID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author_actor_id: 'service_account' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('AUTHOR_ACTOR_ID_FORBIDDEN');
      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  it('PATCH strips the response-only author_unverified alias but keeps author editable', async () => {
    await withServer('dashboard_user', async base => {
      const res = await fetch(`${base}/reports/${RID}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: 'new-label', author_unverified: 'sneaky' }),
      });
      expect(res.status).toBe(200);
      const call = manager.update.mock.calls[0][1] as Record<string, unknown>;
      expect(call.author).toBe('new-label');
      expect('author_unverified' in call).toBe(false);
    });
  });
});

describe('ReportManager author_actor_id persistence', () => {
  function fakePool() {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    return {
      queries,
      query: jest.fn(async (text: string, params?: unknown[]) => {
        queries.push({ text, params: params ?? [] });
        if (/INSERT INTO reports/i.test(text)) return { rows: [{ id: RID }], rowCount: 1 };
        if (/FROM reports r/i.test(text)) {
          return {
            rows: [{ id: RID, title: 't', content: 'c', author: 'label', author_actor_id: 'service_account' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
  }

  it('INSERT persists author (unverified) and author_actor_id as separate columns', async () => {
    const pool = fakePool();
    await new ReportManager(pool as never).create({
      title: 'T', content: 'C', author: 'label', author_actor_id: 'service_account',
    });
    const insert = pool.queries.find(q => /INSERT INTO reports/i.test(q.text))!;
    expect(insert.text).toContain('author_actor_id');
    expect(insert.params).toEqual(expect.arrayContaining(['label', 'service_account']));
  });

  it('mapped rows expose author, author_unverified alias, and author_actor_id', async () => {
    const pool = fakePool();
    const report = await new ReportManager(pool as never).getById(RID);
    expect(report!.author).toBe('label');
    expect(report!.author_unverified).toBe('label');
    expect(report!.author_actor_id).toBe('service_account');
  });

  it('ReportManager.update has no author_actor_id pathway', async () => {
    const pool = fakePool();
    pool.query.mockImplementation(async (text: string, params?: unknown[]) => {
      pool.queries.push({ text, params: params ?? [] });
      if (/FROM reports r/i.test(text)) return { rows: [{ id: RID, author: 'label' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    await new ReportManager(pool as never).update(RID, { author_actor_id: 'evil' } as never);
    const update = pool.queries.find(q => /UPDATE reports SET/i.test(q.text))!;
    expect(update.text).not.toContain('author_actor_id');
  });
});
