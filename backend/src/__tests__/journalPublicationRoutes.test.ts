import express, { Request } from 'express';
import journalRoutes from '../routes/journal';
import { journalPublicationService } from '../services/JournalPublicationService';

jest.mock('../services/JournalService', () => ({ journalService: { list: jest.fn(), getLatest: jest.fn(), getById: jest.fn(), update: jest.fn(), delete: jest.fn() } }));
jest.mock('../services/JournalPublicationService', () => {
  class JournalPublicationError extends Error { constructor(message: string, public status = 400) { super(message); } }
  return {
    JournalPublicationError,
    journalPublicationService: { get: jest.fn(), publish: jest.fn(), rollback: jest.fn(), approve: jest.fn(), listMindscape: jest.fn(), readPrivateSong: jest.fn() },
  };
});

const service = journalPublicationService as jest.Mocked<typeof journalPublicationService>;
const publication = (key: string, state: string) => ({
  publication_id: key, idempotency_key: key,
  entry_id: '22222222-2222-4222-8222-222222222222',
  operation: 'historical_media_repair' as const, state, source_date: null, replay: false,
});

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => { (req as Request & { userId?: string }).userId = req.header('x-test-publisher') === 'yes' ? 'journal_publisher' : req.header('x-test-service') === 'yes' ? 'service_account' : 'human'; next(); });
  app.use('/journal', journalRoutes);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('not listening');
    await run(`http://127.0.0.1:${address.port}`);
  } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
}

describe('reviewed Hermes journal publication routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('serves the private internal Mindscape collection only through authenticated journal routes', async () => {
    service.listMindscape.mockResolvedValue([{ entry_id: 'one', visibility: 'private' }]);
    await withServer(async base => {
      const response = await fetch(`${base}/journal/mindscape`, { headers: { 'x-test-service': 'yes' } });
      expect(response.status).toBe(200);
      const body = await response.json() as { tracks: Array<{ visibility: string }> };
      expect(body.tracks[0].visibility).toBe('private');
    });
  });

  it('records approval only from a human and serves private audio as authenticated bytes', async () => {
    service.approve.mockResolvedValue({ replay: false, approval: { approved_by: 'human' } });
    service.readPrivateSong.mockResolvedValue({ title: 'Daily Mindscape', bytes: Buffer.from('private-audio') });
    await withServer(async base => {
      const key = 'e'.repeat(32);
      const denied = await fetch(`${base}/journal/hermes-approvals/${key}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-service': 'yes' }, body: '{}' });
      expect(denied.status).toBe(403);
      const approved = await fetch(`${base}/journal/hermes-approvals/${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(approved.status).toBe(201);
      const audio = await fetch(`${base}/journal/mindscape/${key}/audio`);
      expect(audio.status).toBe(200); expect(audio.headers.get('cache-control')).toBe('private, no-store');
      expect(await audio.text()).toBe('private-audio');
    });
  });

  it('rejects a human JWT-equivalent caller before invoking publication', async () => {
    await withServer(async base => {
      const response = await fetch(`${base}/journal/hermes-runs/${'a'.repeat(32)}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(403);
      expect(service.publish).not.toHaveBeenCalled();
    });
  });

  it('publishes once and reports replay status through the service-account route', async () => {
    const key = 'b'.repeat(32);
    service.publish.mockResolvedValue({ replay: false, publication: publication(key, 'published') });
    await withServer(async base => {
      const response = await fetch(`${base}/journal/hermes-runs/${key}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-publisher': 'yes' }, body: '{}' });
      expect(response.status).toBe(201);
      expect(((await response.json()) as { success: boolean }).success).toBe(true);
      expect(service.publish).toHaveBeenCalledTimes(1);
    });
  });

  it('supports authenticated lookup and rollback reconciliation', async () => {
    const key = 'c'.repeat(32);
    service.get.mockResolvedValue(publication(key, 'published'));
    service.rollback.mockResolvedValue({ replay: true, publication: { ...publication(key, 'rolled_back'), replay: true } });
    await withServer(async base => {
      const headers = { 'x-test-publisher': 'yes', 'content-type': 'application/json' };
      expect((await fetch(`${base}/journal/hermes-runs/${key}`, { headers })).status).toBe(200);
      const rollback = await fetch(`${base}/journal/hermes-runs/${key}/rollback`, { method: 'POST', headers, body: JSON.stringify({ approval_fingerprint: 'd'.repeat(64) }) });
      expect(rollback.status).toBe(200);
      expect(((await rollback.json()) as { replay: boolean }).replay).toBe(true);
    });
  });
});
