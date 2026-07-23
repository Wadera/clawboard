import { HermesCanonicalAdapter, redactHermesText } from '../services/HermesCanonicalAdapter';

const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function repository() {
  return {
    resolveOrCreateAttempt: jest.fn(async (_input: any) => ({ attempt_id: attemptId })),
    linkAttemptContextForSessionKeys: jest.fn(async () => []),
    appendEvent: jest.fn(async (input: any) => ({
      event: { event_id: `event-${input.idempotencyKey}`, ...input },
      inserted: true,
    })),
  };
}

const row = {
  id: '20260716_120000_abc123',
  source: 'tool-task-c5e51790',
  session_key: 'hermes:tool:20260716_120000_abc123',
  started_at: 1_752_665_000,
  ended_at: null,
  last_message_at: 1_752_665_090,
  message_count: 3,
  tool_call_count: 1,
};

describe('HermesCanonicalAdapter', () => {
  it('binds authoritative runtime aliases and ingests native message/tool identities', async () => {
    const repo = repository();
    const adapter = new HermesCanonicalAdapter(repo as any, 'hermes-live/test');
    const result = await adapter.ingestSnapshot(row, [
      { id: 10, role: 'user', content: 'hello', timestamp: 1_752_665_010 },
      {
        id: 11,
        role: 'assistant',
        content: 'working',
        timestamp: 1_752_665_020,
        tool_calls: JSON.stringify([{ id: 'call-1', function: { name: 'terminal', arguments: '{"password":"never-store"}' } }]),
      },
      { id: 12, role: 'tool', content: 'secret tool output', tool_call_id: 'call-1', tool_name: 'terminal', timestamp: 1_752_665_030 },
    ], new Date(1_752_665_100_000));

    expect(result).toMatchObject({ lifecycle: 'running', availability: 'available', freshness: 'fresh', insertedEvents: 5 });
    const identity = repo.resolveOrCreateAttempt.mock.calls[0][0];
    expect(identity.aliases.map((item: any) => item.kind)).toEqual(['runtime_session_id', 'session_key']);
    expect(identity.aliases[0].value).toBe(row.id);
    expect(repo.linkAttemptContextForSessionKeys).toHaveBeenCalledWith(
      attemptId,
      [row.id, row.session_key, `hermes:tool:${row.id}`],
      new Date(row.last_message_at * 1000),
    );

    const events = repo.appendEvent.mock.calls.map(([event]) => event);
    expect(events.map(event => event.eventKind)).toEqual(['lifecycle', 'message', 'tool_call', 'message', 'tool_result']);
    expect(events.find(event => event.eventKind === 'tool_call').payload.arguments).toEqual({ redacted: true });
    expect(events.find(event => event.eventKind === 'tool_result').payload.result).toEqual({ redacted: true });
    expect(JSON.stringify(events)).not.toContain('never-store');
    expect(JSON.stringify(events)).not.toContain('secret tool output');
    expect(events.map(event => event.sourceEventId)).toContain('message:10:content');
  });

  it('does not fabricate liveness from an unended stale row', async () => {
    const repo = repository();
    const adapter = new HermesCanonicalAdapter(repo as any, 'hermes-live/test');
    const result = await adapter.ingestSnapshot(
      { ...row, last_message_at: 1_752_664_000 },
      [],
      new Date(1_752_665_100_000),
    );
    expect(result).toMatchObject({ lifecycle: 'unknown', availability: 'unavailable', freshness: 'expired' });
    expect(repo.appendEvent.mock.calls[0][0].payload.reason).toBe('hermes_liveness_evidence_expired');
  });

  it('uses a new decision receipt when a source row later gains a session-key alias', async () => {
    const repo = repository();
    const adapter = new HermesCanonicalAdapter(repo as any, 'hermes-live/test');
    await adapter.ingestSnapshot({ ...row, session_key: null }, [], new Date(1_752_665_100_000));
    await adapter.ingestSnapshot(row, [], new Date(1_752_665_100_000));
    const keys = repo.resolveOrCreateAttempt.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('uses durable terminal evidence without freshness expiry', async () => {
    const repo = repository();
    const adapter = new HermesCanonicalAdapter(repo as any, 'hermes-live/test');
    const result = await adapter.ingestSnapshot(
      { ...row, ended_at: 1_752_665_050, end_reason: 'success' },
      [],
      new Date(1_752_999_999_000),
    );
    expect(result).toMatchObject({ lifecycle: 'completed', availability: 'available', freshness: 'not_applicable' });
  });

  it('requires native SQLite message ids instead of list-position fallback identity', async () => {
    const repo = repository();
    const adapter = new HermesCanonicalAdapter(repo as any, 'hermes-live/test');
    const result = await adapter.ingestSnapshot(row, [
      { role: 'user', content: 'no native id', timestamp: 1_752_665_010 },
    ], new Date(1_752_665_100_000));
    expect(result.insertedEvents).toBe(1);
    expect(repo.appendEvent).toHaveBeenCalledTimes(1);
  });

  it('redacts common bearer, assignment, JWT and URL credential forms', () => {
    const value = redactHermesText('Bearer abc.def_123 password=hunter2 https://alice:pw@example.test eyJabc.def.sig');
    expect(value).not.toContain('abc.def_123');
    expect(value).not.toContain('hunter2');
    expect(value).not.toContain('alice:pw');
    expect(value).not.toContain('eyJabc.def.sig');
  });

  it('removes AWS, opaque credential, cookie, URL-query and private-key values', () => {
    const value = redactHermesText([
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'credential=opaqueCredentialValue123456789',
      'cookie="sid=top-secret"',
      'https://example.test/path?access_token=query-secret',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabcDEF123+/=\n-----END OPENSSH PRIVATE KEY-----',
    ].join('\n'));
    expect(value).not.toContain('wJalr');
    expect(value).not.toContain('opaqueCredentialValue');
    expect(value).not.toContain('top-secret');
    expect(value).not.toContain('query-secret');
    expect(value).not.toContain('abcDEF123');
  });

  it('fails closed with metadata-only evidence for malformed tool-call payloads', async () => {
    const repo = repository();
    const adapter = new HermesCanonicalAdapter(repo as any, 'hermes-live/test');
    await adapter.ingestSnapshot(row, [{
      id: 20,
      role: 'assistant',
      content: null,
      timestamp: 1_752_665_020,
      tool_calls: '{"password":"must-not-survive"',
    }], new Date(1_752_665_100_000));
    const event = repo.appendEvent.mock.calls.map(([item]) => item)
      .find(item => item.sourceEventId === 'message:20:tool-call-quarantine');
    expect(event).toMatchObject({
      eventKind: 'error',
      payload: { reason: 'hermes_tool_call_quarantined', errorClass: 'malformed_json', rawPayloadRetained: false },
    });
    expect(JSON.stringify(event)).not.toContain('must-not-survive');
  });

  it('quarantines unsafe tool-call identifiers and names before event construction', async () => {
    const repo = repository();
    const adapter = new HermesCanonicalAdapter(repo as any, 'hermes-live/test');
    await adapter.ingestSnapshot(row, [{
      id: 22,
      role: 'assistant',
      content: null,
      timestamp: 1_752_665_022,
      tool_calls: JSON.stringify([{
        id: 'credential leakedToolCallSecret123456789',
        name: 'client_secret leakedToolNameSecret123456789',
      }]),
    }], new Date(1_752_665_100_000));
    const events = repo.appendEvent.mock.calls.map(([item]) => item);
    const event = events.find(item => item.sourceEventId === 'message:22:tool-call-quarantine');
    expect(event).toMatchObject({
      eventKind: 'error',
      payload: { reason: 'hermes_tool_call_quarantined', errorClass: 'unsafe_metadata', rawPayloadRetained: false },
    });
    expect(events.some(item => item.eventKind === 'tool_call')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('leakedToolCallSecret');
    expect(JSON.stringify(events)).not.toContain('leakedToolNameSecret');
  });

  it('quarantines unsafe tool-result correlation identifiers and names before event construction', async () => {
    const repo = repository();
    const adapter = new HermesCanonicalAdapter(repo as any, 'hermes-live/test');
    await adapter.ingestSnapshot(row, [{
      id: 23,
      role: 'tool',
      content: 'sensitive result omitted',
      timestamp: 1_752_665_023,
      tool_call_id: 'credential leakedToolResultSecret123456789',
      tool_name: 'client_secret leakedToolResultName123456789',
    }], new Date(1_752_665_100_000));
    const events = repo.appendEvent.mock.calls.map(([item]) => item);
    const event = events.find(item => item.sourceEventId === 'message:23:tool-result-quarantine');
    expect(event).toMatchObject({
      eventKind: 'error',
      payload: { reason: 'hermes_tool_result_quarantined', errorClass: 'unsafe_metadata', rawPayloadRetained: false },
    });
    expect(events.some(item => item.eventKind === 'tool_result')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('leakedToolResultSecret');
    expect(JSON.stringify(events)).not.toContain('leakedToolResultName');
  });

  it('fails closed rather than persisting residual unsupported credential text', async () => {
    const repo = repository();
    const adapter = new HermesCanonicalAdapter(repo as any, 'hermes-live/test');
    await adapter.ingestSnapshot(row, [{
      id: 21,
      role: 'user',
      content: 'client_secret verySecretValue123456789',
      timestamp: 1_752_665_021,
    }], new Date(1_752_665_100_000));
    const events = repo.appendEvent.mock.calls.map(([item]) => item);
    const event = events.find(item => item.sourceEventId === 'message:21:content-quarantine');
    expect(event).toMatchObject({
      eventKind: 'error',
      payload: { reason: 'hermes_message_content_quarantined', rawPayloadRetained: false },
    });
    expect(JSON.stringify(events)).not.toContain('verySecretValue');
  });

  it('orders SQLite rows, emits explicit sequence gaps, and submits one cursor batch', async () => {
    const repo = repository() as any;
    repo.commitIngestionBatch = jest.fn(async (batch: any) => ({
      insertedEvents: batch.events.length, replayedEvents: 0, cursorAdvanced: true, cursorRevision: 1,
    }));
    const adapter = new HermesCanonicalAdapter(repo, 'hermes-live/test');
    await adapter.ingestSnapshot(row, [
      { id: 14, role: 'assistant', content: 'later', timestamp: 1_752_665_014 },
      { id: 10, role: 'user', content: 'earlier', timestamp: 1_752_665_010 },
    ], new Date(1_752_665_100_000));
    const batch = repo.commitIngestionBatch.mock.calls[0][0];
    expect(batch.cursorPosition).toBe('14');
    expect(batch.cursorValue).toBe('message:14');
    expect(batch.sourceChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(batch.gaps).toEqual([{ attemptId, gapKind: 'missing_message_sequence', expectedFrom: '11', expectedTo: '13' }]);
    expect(batch.events.map((event: any) => event.sourceEventId)).toEqual([
      expect.stringMatching(/^state:/), 'message:10:content', 'message-gap:11:13', 'message:14:content',
    ]);
    expect(repo.appendEvent).not.toHaveBeenCalled();
  });
});
