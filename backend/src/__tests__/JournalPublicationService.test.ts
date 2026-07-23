import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { JournalPublicationService, PublishRequest } from '../services/JournalPublicationService';
import { pool } from '../db/connection';

jest.mock('../db/connection', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
const mockedPool = pool as jest.Mocked<typeof pool>;

function sha(file: string): string { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function request(root: string): PublishRequest {
  return {
    run_id: '11111111-1111-4111-8111-111111111111', entry_id: '22222222-2222-4222-8222-222222222222',
    operation: 'historical_media_repair', executor: 'Hermes', content_author: 'Nim',
    approval_fingerprint: 'a'.repeat(64), source_contract_sha256: 'b'.repeat(64), reflection_sha256: 'c'.repeat(64),
    media: {
      image: { path: 'generated/image.png', sha256: sha(path.join(root, 'generated/image.png')) },
      audio: { path: 'generated/audio.mp3', sha256: sha(path.join(root, 'generated/audio.mp3')) },
      song: { path: 'generated/song.mp3', sha256: sha(path.join(root, 'generated/song.mp3')), url: 'https://suno.com/song/11111111-1111-4111-8111-111111111111', title: 'Daily Mindscape' },
    },
  };
}

describe('JournalPublicationService fail-closed validation', () => {
  let root: string;
  beforeEach(() => {
    jest.clearAllMocks(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-publication-'));
    fs.mkdirSync(path.join(root, 'generated'));
    for (const name of ['image.png', 'audio.mp3', 'song.mp3']) fs.writeFileSync(path.join(root, 'generated', name), `bytes:${name}`);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('rejects traversal before opening a database transaction', () => {
    const body = request(root); body.media.audio!.path = '../outside.mp3';
    expect(() => (new JournalPublicationService(root, root) as any).validate('1'.repeat(32), body)).toThrow('audio path is unsafe');
    expect(mockedPool.connect).not.toHaveBeenCalled();
  });

  it('rejects a symlink receipt before opening a database transaction', () => {
    fs.symlinkSync(path.join(root, 'generated/audio.mp3'), path.join(root, 'generated/link.mp3'));
    const body = request(root); body.media.audio = { path: 'generated/link.mp3', sha256: sha(path.join(root, 'generated/audio.mp3')) };
    expect(() => (new JournalPublicationService(root, root) as any).validate('2'.repeat(32), body)).toThrow('symlink is forbidden');
    expect(mockedPool.connect).not.toHaveBeenCalled();
  });

  it('rejects checksum drift and credential-bearing URLs', () => {
    const checksumBody = request(root); checksumBody.media.song!.sha256 = 'f'.repeat(64);
    expect(() => (new JournalPublicationService(root, root) as any).validate('3'.repeat(32), checksumBody)).toThrow('song checksum mismatch');
    const urlBody = request(root); urlBody.media.song!.url = 'https://user:pass@suno.com/song/x';
    expect(() => (new JournalPublicationService(root, root) as any).validate('4'.repeat(32), urlBody)).toThrow('credential-free');
    expect(mockedPool.connect).not.toHaveBeenCalled();
  });

  it('preserves historical authorship and canonical run identity', () => {
    const body = request(root); body.content_author = 'Hermes';
    expect(() => (new JournalPublicationService(root, root) as any).validate('5'.repeat(32), body)).toThrow('publication authorship mismatch');
    expect(() => (new JournalPublicationService(root, root) as any).validate('../bad', request(root))).toThrow('invalid idempotency key');
    expect(mockedPool.connect).not.toHaveBeenCalled();
  });
});
