import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  findDeletedTranscript,
  resolveRuntimeAvailability,
  resolveTranscriptAvailability,
} from '../utils/sessionAvailability';

describe('sessionAvailability', () => {
  test('marks active sessions without heartbeat as runtime missing after grace period', () => {
    const now = new Date('2026-04-22T05:00:00.000Z').getTime();
    const runtime = resolveRuntimeAvailability({
      status: 'active',
      started_at: '2026-04-22T04:00:00.000Z',
      updated_at: '2026-04-22T04:10:00.000Z',
    }, null, now);

    expect(runtime.state).toBe('missing');
    expect(runtime.reason).toMatch(/no current runtime heartbeat/i);
  });

  test('treats fresh active sessions as starting while heartbeat has not arrived yet', () => {
    const now = new Date('2026-04-22T05:00:10.000Z').getTime();
    const runtime = resolveRuntimeAvailability({
      status: 'active',
      started_at: '2026-04-22T05:00:00.000Z',
    }, null, now);

    expect(runtime.state).toBe('starting');
  });

  test('marks transcript as missing when metadata claims messages but file is gone', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-availability-'));
    try {
      const transcript = resolveTranscriptAvailability({
        session_id: 'sess-1',
        message_count: 4,
        tool_call_count: 0,
      }, tmpDir);

      expect(transcript.state).toBe('missing');
      expect(transcript.reason).toMatch(/no transcript file/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('finds deleted transcript variants and marks transcript as available', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-availability-'));
    try {
      const deletedPath = path.join(tmpDir, 'sess-1.jsonl.deleted.123456');
      fs.writeFileSync(deletedPath, '{"type":"message"}\n', 'utf8');

      expect(findDeletedTranscript(tmpDir, 'sess-1')).toBe(deletedPath);

      const transcript = resolveTranscriptAvailability({
        session_id: 'sess-1',
        message_count: 2,
      }, tmpDir);

      expect(transcript.state).toBe('available');
      expect(transcript.transcriptPath).toBe(deletedPath);
      expect(transcript.fileSize).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});