/**
 * SessionIngester.test.ts
 *
 * Unit tests for the pure logic functions in SessionIngester:
 *   - deriveKind()              — deterministic kind from session_key pattern
 *   - extractLabelFromContent() — human-readable label from first user message
 *   - parseJSONLStats()         — aggregate stats from JSONL transcript file
 *
 * No database or file-system access required for the first two tests.
 * parseJSONLStats tests use tmp files written in-test.
 */

jest.mock('../db/connection', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('../services/OpenClawCanonicalAdapter', () => ({
  openClawCanonicalAdapter: {
    ingestSessionFile: jest.fn().mockResolvedValue({ attemptId: 'attempt-openclaw-1' }),
  },
}));

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  SessionIngester,
  deriveKind,
  extractLabelFromContent,
  parseJSONLStats,
} from '../services/SessionIngester';
import { pool } from '../db/connection';
import { openClawCanonicalAdapter } from '../services/OpenClawCanonicalAdapter';

// ─────────────────────────────────────────────────────────────────
// deriveKind
// ─────────────────────────────────────────────────────────────────

describe('deriveKind', () => {
  it('returns main for agent:main:main', () => {
    expect(deriveKind('agent:main:main')).toBe('main');
  });

  it('returns heartbeat for agent:main:heartbeat', () => {
    expect(deriveKind('agent:main:heartbeat')).toBe('heartbeat');
  });

  it('returns cron for cron session keys', () => {
    expect(
      deriveKind('agent:main:cron:3a419d09-48eb-4621-b7c9-a5b1ab78446f')
    ).toBe('cron');
  });

  it('returns cron for cron:run keys as well', () => {
    expect(
      deriveKind(
        'agent:main:cron:3a419d09-48eb-4621-b7c9-a5b1ab78446f:run:001'
      )
    ).toBe('cron');
  });

  it('returns cron for legacy cron:<jobId> aliases', () => {
    expect(deriveKind('cron:3a419d09-48eb-4621-b7c9-a5b1ab78446f')).toBe('cron');
  });

  it('returns subagent for subagent session keys', () => {
    expect(
      deriveKind('agent:main:subagent:26ff5830-b41e-4b73-8cae-9c2136869216')
    ).toBe('subagent');
  });

  it('returns discord for discord session keys', () => {
    expect(
      deriveKind('agent:main:discord:channel:1465806566350651484')
    ).toBe('discord');
  });

  it('returns acp for ACP session keys', () => {
    expect(
      deriveKind('agent:main:acp:session:abc123')
    ).toBe('acp');
  });

  it('returns acp when :acp: appears anywhere in the key', () => {
    expect(deriveKind('some:acp:whatever')).toBe('acp');
  });

  it('returns unknown for unrecognised patterns', () => {
    expect(deriveKind('some:random:key')).toBe('unknown');
  });

  it('returns unknown for bare UUID-like keys (orphan sessions)', () => {
    expect(deriveKind('d3ccf672-613f-4a51-b06d-2e5ec1de7e49')).toBe('unknown');
  });

  it('heartbeat takes priority over other matches', () => {
    // A key that contains both :heartbeat and :cron: — heartbeat wins
    expect(deriveKind('agent:main:heartbeat:cron:something')).toBe('heartbeat');
  });

  it('cron takes priority over subagent', () => {
    expect(deriveKind('agent:main:cron:uuid:subagent:something')).toBe('cron');
  });
});

// ─────────────────────────────────────────────────────────────────
// extractLabelFromContent
// ─────────────────────────────────────────────────────────────────

describe('extractLabelFromContent', () => {
  it('returns null for empty string', () => {
    expect(extractLabelFromContent('')).toBeNull();
  });

  it('returns null for heartbeat content', () => {
    expect(
      extractLabelFromContent(
        'Read HEARTBEAT.md if it exists (workspace context).'
      )
    ).toBeNull();
  });

  it('returns null for system messages starting with System:', () => {
    expect(extractLabelFromContent('System: initialise context')).toBeNull();
  });

  it('returns null for Read SOUL.md messages', () => {
    expect(extractLabelFromContent('Read SOUL.md — this is who you are')).toBeNull();
  });

  it('returns null for cron spawn prefix messages', () => {
    expect(
      extractLabelFromContent(
        '[cron:9fdfa60b-9e35-4eaa-a8f6-95e354e3d7d1 spawn-task-87c0281d] # Phase 2'
      )
    ).toBeNull();
  });

  it('returns null for spawn-task prefix messages', () => {
    expect(extractLabelFromContent('[spawn-task-abc123] do something')).toBeNull();
  });

  it('extracts ## Task: heading as the label', () => {
    const content = `## Task: Build the unified SessionIngester service

Some additional context below.`;
    expect(extractLabelFromContent(content)).toBe(
      'Build the unified SessionIngester service'
    );
  });

  it('extracts # Task: heading (single hash)', () => {
    const content = `# Task: Fix the login bug\n\nDetails here.`;
    expect(extractLabelFromContent(content)).toBe('Fix the login bug');
  });

  it('extracts **Task:** bold heading', () => {
    const content = `**Task:** Refactor the auth module`;
    expect(extractLabelFromContent(content)).toBe('Refactor the auth module');
  });

  it('extracts first meaningful plain-text line', () => {
    const content = `Can you help me write a poem about TypeScript?`;
    expect(extractLabelFromContent(content)).toBe(
      'Can you help me write a poem about TypeScript?'
    );
  });

  it('skips short (<5 char) lines', () => {
    const content = `OK\nHello there, what is your name?`;
    expect(extractLabelFromContent(content)).toBe(
      'Hello there, what is your name?'
    );
  });

  it('skips lines starting with [', () => {
    const content = `[media attached: photo.jpg]\nPlease describe this image.`;
    expect(extractLabelFromContent(content)).toBe('Please describe this image.');
  });

  it('skips markdown headings (#)', () => {
    const content = `## Some heading\nThis is the actual request.`;
    expect(extractLabelFromContent(content)).toBe('This is the actual request.');
  });

  it('skips --- dividers', () => {
    const content = `---\nHere is my question about databases.`;
    expect(extractLabelFromContent(content)).toBe(
      'Here is my question about databases.'
    );
  });

  it('truncates long labels to 255 chars', () => {
    const long = 'A'.repeat(300);
    const content = `${long}`;
    const result = extractLabelFromContent(content);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(255);
  });

  it('skips OpenClaw conversation envelope lines', () => {
    const content = [
      'Conversation info (untrusted metadata)',
      '{"channel":"discord"}',
      '<<HUMAN_CONVERSATION_START>>',
      'What is the weather like today?',
    ].join('\n');
    expect(extractLabelFromContent(content)).toBe(
      'What is the weather like today?'
    );
  });

  it('returns null if no meaningful line found', () => {
    const content = `---\n# Title\n## Sub\n[media attached: x]\n  `;
    expect(extractLabelFromContent(content)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// parseJSONLStats — file-based integration tests (no DB)
// ─────────────────────────────────────────────────────────────────

describe('parseJSONLStats', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ingester-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTmp(name: string, lines: object[]): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    return p;
  }

  it('returns null for empty file', () => {
    const p = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(p, '');
    return expect(parseJSONLStats(p)).resolves.toBeNull();
  });

  it('counts messages correctly', async () => {
    const p = writeTmp('messages.jsonl', [
      { type: 'message', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: 'Hello' } },
      { type: 'message', timestamp: '2026-03-01T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] } },
      { type: 'message', timestamp: '2026-03-01T10:00:02Z', message: { role: 'toolResult', content: 'result', toolCallId: 'tc1' } },
    ]);
    const stats = await parseJSONLStats(p);
    expect(stats).not.toBeNull();
    expect(stats!.messageCount).toBe(3);
  });

  it('counts tool calls in assistant messages', async () => {
    const p = writeTmp('toolcalls.jsonl', [
      {
        type: 'message',
        timestamp: '2026-03-01T10:00:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', name: 'exec', id: 'tc1', arguments: {} },
            { type: 'toolCall', name: 'Read', id: 'tc2', arguments: {} },
          ],
        },
      },
    ]);
    const stats = await parseJSONLStats(p);
    expect(stats!.toolCallCount).toBe(2);
  });

  it('aggregates token counts from usage blocks', async () => {
    const p = writeTmp('tokens.jsonl', [
      {
        type: 'message',
        timestamp: '2026-03-01T10:00:00Z',
        message: {
          role: 'assistant',
          usage: { input: 100, output: 50, cacheRead: 20 },
        },
      },
      {
        type: 'message',
        timestamp: '2026-03-01T10:00:01Z',
        message: {
          role: 'assistant',
          usage: { input: 200, output: 80, thinking_tokens: 30 },
        },
      },
    ]);
    const stats = await parseJSONLStats(p);
    expect(stats!.inputTokens).toBe(300);
    expect(stats!.outputTokens).toBe(130);
    expect(stats!.thinkingTokens).toBe(30);
    expect(stats!.cacheReadTokens).toBe(20);
  });

  it('captures started_at and last_activity_at from timestamps', async () => {
    const p = writeTmp('timestamps.jsonl', [
      {
        type: 'message',
        timestamp: '2026-03-01T10:00:00.000Z',
        message: { role: 'user', content: 'First' },
      },
      {
        type: 'message',
        timestamp: '2026-03-01T10:05:30.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Reply' }] },
      },
    ]);
    const stats = await parseJSONLStats(p);
    expect(stats!.startedAt).toBe('2026-03-01T10:00:00.000Z');
    expect(stats!.lastActivityAt).toBe('2026-03-01T10:05:30.000Z');
    expect(stats!.endedAt).toBe('2026-03-01T10:05:30.000Z');
  });

  it('prefers gateway-provided label over first user message', async () => {
    const p = writeTmp('label.jsonl', [
      {
        type: 'session',
        label: 'Gateway Provided Label',
        timestamp: '2026-03-01T10:00:00Z',
      },
      {
        type: 'message',
        timestamp: '2026-03-01T10:00:01Z',
        message: { role: 'user', content: 'This is the user message' },
      },
    ]);
    const stats = await parseJSONLStats(p);
    expect(stats!.label).toBe('Gateway Provided Label');
  });

  it('falls back to first user message label when no gateway label', async () => {
    const p = writeTmp('label_fallback.jsonl', [
      {
        type: 'message',
        timestamp: '2026-03-01T10:00:00Z',
        message: { role: 'user', content: 'Help me debug this TypeScript error' },
      },
    ]);
    const stats = await parseJSONLStats(p);
    expect(stats!.label).toBe('Help me debug this TypeScript error');
  });

  it('uses ## Task: heading as label when present in first user message', async () => {
    const taskContent = `## Task: Implement the session ingester\n\nDetails: build unified service`;
    const p = writeTmp('label_task.jsonl', [
      {
        type: 'message',
        timestamp: '2026-03-01T10:00:00Z',
        message: { role: 'user', content: taskContent },
      },
    ]);
    const stats = await parseJSONLStats(p);
    expect(stats!.label).toBe('Implement the session ingester');
  });

  it('sums cost from entry.cost fields', async () => {
    const p = writeTmp('cost.jsonl', [
      { type: 'message', timestamp: '2026-03-01T10:00:00Z', cost: 0.0012, message: { role: 'assistant', content: [] } },
      { type: 'message', timestamp: '2026-03-01T10:00:01Z', cost: 0.0034, message: { role: 'assistant', content: [] } },
    ]);
    const stats = await parseJSONLStats(p);
    expect(stats!.totalCostUsd).toBeCloseTo(0.0046, 6);
  });

  it('skips malformed JSON lines without crashing', async () => {
    const p = path.join(tmpDir, 'malformed.jsonl');
    fs.writeFileSync(
      p,
      [
        '{"type":"message","timestamp":"2026-03-01T10:00:00Z","message":{"role":"user","content":"Hi"}}',
        'THIS IS NOT JSON',
        '{"type":"message","timestamp":"2026-03-01T10:00:01Z","message":{"role":"assistant","content":[]}}',
      ].join('\n') + '\n'
    );
    const stats = await parseJSONLStats(p);
    expect(stats).not.toBeNull();
    expect(stats!.messageCount).toBe(2);
  });

  it('returns fileSize matching the actual file', async () => {
    const p = writeTmp('filesize.jsonl', [
      { type: 'message', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: 'hello' } },
    ]);
    const diskSize = fs.statSync(p).size;
    const stats = await parseJSONLStats(p);
    expect(stats!.fileSize).toBe(diskSize);
  });
});

describe('task-owned canonical OpenClaw bridge', () => {
  beforeEach(() => jest.clearAllMocks());

  it('invokes canonical ingestion only after a persisted task ownership match', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-canonical-bridge-'));
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const transcript = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcript, '{"type":"message","id":"m1","timestamp":"2026-07-16T00:00:00Z","message":{"role":"user","content":"hello"}}\n');
    const stats = await parseJSONLStats(transcript);
    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ linked: 1 }] });

    const ingester = new SessionIngester(path.join(dir, 'sessions.json'), dir);
    await (ingester as any)._upsertSession(
      'agent:main:cron:22222222-2222-4222-8222-222222222222',
      { sessionId, sessionFile: transcript, updatedAt: Date.now() },
      transcript,
      stats,
      'active',
    );

    expect(openClawCanonicalAdapter.ingestSessionFile).toHaveBeenCalledWith(
      'agent:main:cron:22222222-2222-4222-8222-222222222222',
      expect.objectContaining({ sessionId }),
      dir,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
