import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pool } from '../db/connection';
import { JournalPublicationError, JournalPublicationService, PublishRequest } from '../services/JournalPublicationService';
import { JournalService } from '../services/JournalService';

jest.mock('../db/connection', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
const mockedPool = pool as jest.Mocked<typeof pool>;

const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const KEY = '1'.repeat(32);
const OTHER_KEY = '2'.repeat(32);
const reflection = 'unchanged reflection';
const reflectionSha = crypto.createHash('sha256').update(reflection).digest('hex');

function body(root: string, runId = RUN_ID): PublishRequest {
  const receipt = (name: string) => ({
    path: `generated/${name}`,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'generated', name))).digest('hex'),
  });
  return {
    run_id: runId,
    entry_id: ENTRY_ID,
    operation: 'historical_media_repair',
    executor: 'Hermes',
    content_author: 'Nim',
    approval_fingerprint: 'a'.repeat(64),
    source_contract_sha256: 'b'.repeat(64),
    reflection_sha256: reflectionSha,
    media: {
      image: receipt('image.png'),
      audio: receipt('audio.mp3'),
      song: { ...receipt('song.mp3'), title: 'Daily Mindscape', url: 'https://suno.com/song/keeper' },
    },
  };
}

type Publication = Record<string, any>;
function statefulClient(approvalForKey: (key: string) => PublishRequest) {
  const entry: Record<string, any> = {
    id: ENTRY_ID, reflection_text: reflection, image_path: null, voice_path: null,
    song_path: null, song_url: null, song_title: null, entry_type: 'narrative',
    content_author: null, provenance: {},
  };
  let publication: Publication | undefined;
  const tracks: Publication[] = [];
  const expected = { image_path: null, voice_path: null, song_path: null, song_url: null, song_title: null, entry_type: 'narrative', content_author: null, provenance: {} };
  const client = {
    release: jest.fn(),
    query: jest.fn(async (sql: string, values: any[] = []) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM journal_run_publications WHERE idempotency_key')) return { rows: publication?.idempotency_key === values[0] ? [publication] : [] };
      if (sql.includes('FROM journal_publication_approvals')) {
        const approved = approvalForKey(values[0]);
        const validated = (service as any).validate(values[0], approved);
        return { rows: [{ idempotency_key: values[0], request_fingerprint: validated.requestFingerprint, approved_request: validated.normalized, expected_entry: expected, revoked_at: null }] };
      }
      if (sql.includes("FROM journal_run_publications WHERE entry_id") && sql.includes("state='published'")) return { rows: publication ? [{ idempotency_key: publication.idempotency_key }] : [] };
      if (sql.includes('SELECT * FROM journal_entries')) return { rows: [entry] };
      if (sql.startsWith('UPDATE journal_entries')) {
        [entry.image_path, entry.voice_path, entry.song_path, entry.song_url, entry.song_title, entry.entry_type, entry.content_author, entry.provenance] = values.slice(0, 8);
        entry.provenance = JSON.parse(entry.provenance);
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO journal_run_publications')) {
        publication = {
          idempotency_key: values[0],
          run_id: values[1],
          entry_id: values[2],
          request_fingerprint: values[9],
          state: 'published',
          response_snapshot: JSON.parse(values[14]),
        };
        return { rows: [publication] };
      }
      if (sql.includes('INSERT INTO journal_mindscape_tracks')) {
        tracks.push({ entry_id: values[0], run_key: values[1], title: values[2], provider_url: values[3], media_path: values[4], media_sha256: values[5], visibility: 'private', state: 'attached' });
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  let service: JournalPublicationService;
  return {
    client,
    attach(s: JournalPublicationService) { service = s; },
    tracks,
    entry,
    publication: () => publication,
  };
}

describe('Journal publication private Mindscape exactly-once contract', () => {
  let root: string;
  beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mindscape-once-'));
    fs.mkdirSync(path.join(root, 'generated'));
    for (const name of ['image.png', 'audio.mp3', 'song.mp3']) fs.writeFileSync(path.join(root, 'generated', name), `bytes:${name}`);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('same run/song/entry replay returns the original publication and creates one private track', async () => {
    const approved = body(root);
    const service = new JournalPublicationService(root, root);
    jest.spyOn(service, 'canonicalApprovalRequest').mockResolvedValue(approved);
    const db = statefulClient(() => approved); db.attach(service);
    (mockedPool.connect as jest.Mock).mockResolvedValue(db.client as any);

    const first = await service.publish(KEY);
    const replay = await service.publish(KEY);

    expect(first.replay).toBe(false);
    expect(replay).toEqual({ replay: true, publication: { ...first.publication, replay: true } });
    expect(db.tracks).toHaveLength(1);
    expect(db.tracks[0]).toMatchObject({ entry_id: ENTRY_ID, run_key: KEY, visibility: 'private', state: 'attached' });
    expect(db.client.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO journal_mindscape_tracks'))).toHaveLength(1);
  });

  it('a different run targeting an attached entry fails closed without overwriting entry or track', async () => {
    const firstBody = body(root);
    const service = new JournalPublicationService(root, root);
    const secondBody = body(root, '33333333-3333-4333-8333-333333333333');
    jest.spyOn(service, 'canonicalApprovalRequest').mockImplementation(async key => key === KEY ? firstBody : secondBody);
    const db = statefulClient(key => key === KEY ? firstBody : secondBody); db.attach(service);
    (mockedPool.connect as jest.Mock).mockResolvedValue(db.client as any);
    await service.publish(KEY);
    const attachedEntry = JSON.parse(JSON.stringify(db.entry));
    const attachedTrack = JSON.parse(JSON.stringify(db.tracks[0]));

    await expect(service.publish(OTHER_KEY)).rejects.toEqual(expect.objectContaining<Partial<JournalPublicationError>>({ status: 409, message: 'entry already has an active publication' }));
    expect(db.publication()?.idempotency_key).toBe(KEY);
    expect(db.entry).toEqual(attachedEntry);
    expect(db.tracks).toEqual([attachedTrack]);
    expect(db.client.query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE journal_entries'))).toHaveLength(1);
  });
});

describe('forward migration exactly-once guard', () => {
  it('adds the missing entry uniqueness for databases upgraded through migration 047', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/048_journal_mindscape_exactly_once.sql'), 'utf8');
    expect(sql).toMatch(/CREATE UNIQUE INDEX[\s\S]*journal_mindscape_tracks\s*\(entry_id\)/i);
  });
});

describe('public Journal DTO query redaction', () => {
  it('never selects the private song path, provider URL, or receipt hash', async () => {
    (mockedPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [{ id: ENTRY_ID, has_private_song: true, song_title: 'Daily Mindscape' }] });

    const result = await new JournalService().list(20, 0);
    const sql = String(mockedPool.query.mock.calls[1][0]);
    expect(result.entries[0]).toEqual({ id: ENTRY_ID, has_private_song: true, song_title: 'Daily Mindscape' });
    expect(sql).not.toContain('j.song_path AS');
    expect(sql).not.toContain('j.song_url');
    expect(sql).not.toContain('provider_url');
    expect(sql).not.toContain('media_path');
    expect(sql).not.toContain('media_sha256');
  });
});
