import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { JournalPublicationService, PublishRequest } from '../services/JournalPublicationService';
import { pool } from '../db/connection';

jest.mock('../db/connection', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));

const ENTRY_ID = 'd9393d06-d378-5363-91b5-4177930c91bb';
const reflection = 'A truthful same-day reflection.';

function request(): PublishRequest {
  return {
    run_id: '29edd4ab-7741-4aab-9008-2750225114cf', entry_id: ENTRY_ID,
    operation: 'new_entry', executor: 'Hermes', content_author: 'Hermes',
    approval_fingerprint: 'a'.repeat(64), source_contract_sha256: 'b'.repeat(64),
    reflection_sha256: crypto.createHash('sha256').update(reflection).digest('hex'),
    source_entry: { date: '2026-07-12', entry_type: 'narrative', mood: 'orange', reflection_text: reflection, highlights: ['Visible outcomes matter'], content_author: 'Hermes' },
    media: {},
  };
}

describe('approval-bound Hermes new-entry contract', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-new-entry-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('accepts trusted Hermes narrative fields with no optional media', () => {
    const result = (new JournalPublicationService(root, root) as any).validate('b544a621e59447726925cfda78aebfb4', request());
    expect(result.normalized.source_entry).toMatchObject({ date: '2026-07-12', content_author: 'Hermes' });
    expect(result.normalized.media).toEqual({});
  });

  it.each([
    ['Nim authorship', (body: PublishRequest) => { body.content_author = 'Nim'; }],
    ['operational entry', (body: PublishRequest) => { body.source_entry!.entry_type = 'operational' as any; }],
    ['reflection drift', (body: PublishRequest) => { body.source_entry!.reflection_text = 'changed'; }],
    ['impossible calendar date', (body: PublishRequest) => { body.source_entry!.date = '2026-02-30'; }],
  ])('rejects %s before database access', (_name, mutate) => {
    const body = request(); mutate(body);
    expect(() => (new JournalPublicationService(root, root) as any).validate('b544a621e59447726925cfda78aebfb4', body)).toThrow();
  });
});

describe('new-entry forward migration and transactional source guards', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../migrations/050_journal_new_entry_publication.sql'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '../services/JournalPublicationService.ts'), 'utf8');

  it('adds fail-closed one-published-new-entry-per-source-date uniqueness', () => {
    expect(migration).toMatch(/UNIQUE INDEX[\s\S]*source_date[\s\S]*operation='new_entry'/i);
    expect(migration).not.toMatch(/DELETE FROM journal_run_publications/i);
  });

  it('authors same-key replay, different-date-key conflict, complete response persistence, and exact CAS delete paths', () => {
    expect(service).toContain("new-entry:${body.source_entry!.date}");
    expect(service).toContain('source date already has a journal entry');
    expect(service).toContain('response_snapshot');
    expect(service).toContain('rollback compare-and-swap failed; entry changed');
    expect(service).toContain('DELETE FROM journal_entries WHERE id=$1');
  });

  it('uses operation-aware deferred integrity instead of broad FK removal', () => {
    expect(migration).toContain('enforce_journal_publication_entry_integrity');
    expect(migration).toMatch(/DEFERRABLE INITIALLY DEFERRED/g);
    expect(migration).toContain("publication.operation = 'new_entry' AND publication.state = 'rolled_back'");
    expect(migration).toContain("COALESCE(approval.approved_request->>'operation', '') <> 'new_entry'");
    expect(migration).not.toMatch(/DROP CONSTRAINT IF EXISTS journal_.*entry_id_fkey/);
  });

  it('backfills legacy response snapshots with only stable identity fields before enforcing not-null', () => {
    expect(migration).toMatch(/UPDATE journal_run_publications[\s\S]*WHERE response_snapshot IS NULL/i);
    for (const field of ['publication_id', 'idempotency_key', 'entry_id', 'operation', 'state', 'source_date']) {
      expect(migration).toContain(`'${field}'`);
    }
    expect(migration).toMatch(/ALTER COLUMN response_snapshot SET NOT NULL/i);
    for (const forbidden of ["'published_media'", "'reflection_text'", "'approval_fingerprint'", "'song_path'"]) {
      expect(migration).not.toContain(forbidden);
    }
  });

  it('takes the source-date advisory lock before approval absence/date checks', () => {
    const approve = service.slice(service.indexOf('async approve'), service.indexOf('async get'));
    expect(approve.indexOf('pg_advisory_xact_lock')).toBeGreaterThan(approve.indexOf("client.query('BEGIN')"));
    expect(approve.indexOf('pg_advisory_xact_lock')).toBeLessThan(approve.indexOf('SELECT * FROM journal_entries'));
    expect(approve.indexOf('pg_advisory_xact_lock')).toBeLessThan(approve.indexOf('SELECT id FROM journal_entries WHERE date'));
  });
});

describe('redacted stable publication DTO', () => {
  it('GET returns only response_snapshot identity plus replay', async () => {
    const key = 'b544a621e59447726925cfda78aebfb4';
    const response_snapshot = { publication_id: key, idempotency_key: key, entry_id: ENTRY_ID, operation: 'new_entry', state: 'published', source_date: '2026-07-12' };
    (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ response_snapshot, request_fingerprint: 'secret', published_media: { song: { path: '/private' } }, published_entry: { reflection_text: reflection } }] });
    await expect(new JournalPublicationService('/tmp', '/tmp').get(key)).resolves.toEqual({ ...response_snapshot, replay: false });
  });

  it('replays a committed key before rereading a manifest whose local state has advanced', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/JournalPublicationService.ts'), 'utf8');
    const publish = source.slice(source.indexOf('async publish'), source.indexOf('async listMindscape'));
    expect(publish.indexOf('SELECT * FROM journal_run_publications')).toBeGreaterThanOrEqual(0);
    expect(publish.indexOf('SELECT * FROM journal_run_publications')).toBeLessThan(publish.indexOf('canonicalApprovalRequest'));
    expect(publish).toContain('publication-key:${key}');
  });

  it('uses one lock order for publish and rollback to avoid publication-row/date-lock cycles', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/JournalPublicationService.ts'), 'utf8');
    const rollback = source.slice(source.indexOf('async rollback'));
    const keyLock = rollback.indexOf('publication-key:${key}');
    const identityRead = rollback.indexOf('SELECT idempotency_key,operation,source_date,entry_id');
    const identityLock = rollback.indexOf("pg_advisory_xact_lock", keyLock + 1);
    const rowLock = rollback.indexOf('SELECT * FROM journal_run_publications WHERE idempotency_key=$1 FOR UPDATE');
    expect(keyLock).toBeGreaterThanOrEqual(0);
    expect(identityRead).toBeGreaterThan(keyLock);
    expect(identityLock).toBeGreaterThan(identityRead);
    expect(rowLock).toBeGreaterThan(identityLock);
  });

  it('first, replay, GET and rollback paths all construct the response DTO', () => {
    const service = fs.readFileSync(path.join(__dirname, '../services/JournalPublicationService.ts'), 'utf8');
    // get, publish replay, first publish, rollback replay, completed rollback.
    expect((service.match(/responseDto\(/g) || []).length).toBeGreaterThanOrEqual(5);
    expect(service).toContain('SELECT response_snapshot FROM journal_run_publications');
    expect(service).toContain("response_snapshot=$2");
  });
});