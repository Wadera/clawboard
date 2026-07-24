import { OpenClawCanonicalAdapter } from '../services/OpenClawCanonicalAdapter';

const attemptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function repository() {
  return {
    resolveOrCreateAttempt: jest.fn(async (_input: any) => ({ attempt_id: attemptId })),
    linkAttemptContextForSessionKeys: jest.fn(async () => []),
    appendEvent: jest.fn(async (input: any) => ({ event: input, inserted: true })),
  };
}

const session = {
  sessionId: 'runtime-123',
  updatedAt: Date.parse('2026-07-16T12:00:00Z'),
};

const timestamp = '2026-07-16T12:00:00Z';

describe('OpenClawCanonicalAdapter', () => {
  it('binds authoritative registry aliases and maps messages, tools and usage', async () => {
    const repo = repository();
    const adapter = new OpenClawCanonicalAdapter(repo as any, 'gateway/test');
    const result = await adapter.ingestSnapshot('agent:main:subagent:runtime-123', session, [
      { id: 'entry-1', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      { id: 'entry-2', timestamp, message: { role: 'assistant', content: [
        { type: 'text', text: 'working' },
        { type: 'toolCall', id: 'call-1', name: 'terminal', arguments: { password: 'must-not-survive' } },
      ], usage: { input: 10, output: 5 } } },
      { id: 'entry-3', timestamp, message: { role: 'toolResult', content: [{ type: 'text', text: 'secret result' }], toolCallId: 'call-1', toolName: 'terminal' } },
    ], true);

    expect(result).toMatchObject({ lifecycle: 'running', availability: 'available', freshness: 'fresh', insertedEvents: 6 });
    const identity = repo.resolveOrCreateAttempt.mock.calls[0][0];
    expect(identity.harness).toBe('openclaw');
    expect(identity.aliases.map((alias: any) => alias.kind)).toEqual(['session_key', 'runtime_session_id']);
    expect(repo.linkAttemptContextForSessionKeys).toHaveBeenCalledWith(
      attemptId,
      ['agent:main:subagent:runtime-123', session.sessionId],
      new Date(session.updatedAt),
    );
    const events = repo.appendEvent.mock.calls.map(([event]) => event);
    expect(events.map(event => event.eventKind)).toEqual([
      'lifecycle', 'message', 'message', 'tool_call', 'usage', 'tool_result',
    ]);
    expect(events.find(event => event.eventKind === 'tool_call').payload.arguments).toEqual({ redacted: true });
    expect(events.find(event => event.eventKind === 'tool_result').payload.result).toEqual({ redacted: true });
    expect(JSON.stringify(events)).not.toContain('must-not-survive');
    expect(JSON.stringify(events)).not.toContain('secret result');
  });

  it('does not infer running state from a recent registry timestamp without lock evidence', async () => {
    const repo = repository();
    const adapter = new OpenClawCanonicalAdapter(repo as any, 'gateway/test');
    const result = await adapter.ingestSnapshot('agent:main:main', session, [], false, new Date('2026-07-16T12:00:01Z'));
    expect(result).toMatchObject({ lifecycle: 'unknown', availability: 'unavailable', freshness: 'expired' });
    expect(repo.appendEvent.mock.calls[0][0].payload.reason).toBe('openclaw_no_live_or_terminal_evidence');
  });

  it('uses durable terminal status without requiring a transcript lock', async () => {
    const repo = repository();
    const adapter = new OpenClawCanonicalAdapter(repo as any, 'gateway/test');
    const result = await adapter.ingestSnapshot('agent:main:cron:done', { ...session, status: 'completed' }, [], false);
    expect(result).toMatchObject({ lifecycle: 'completed', availability: 'available', freshness: 'not_applicable' });
  });

  it('requires native transcript entry identity and retains only quarantine metadata', async () => {
    const repo = repository();
    const adapter = new OpenClawCanonicalAdapter(repo as any, 'gateway/test');
    await adapter.ingestSnapshot('agent:main:main', session, [
      { timestamp, message: { role: 'user', content: 'no native id secret=do-not-retain' } },
    ], false);
    const events = repo.appendEvent.mock.calls.map(([event]) => event);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ eventKind: 'error', payload: { reason: 'openclaw_entry_identity_quarantined', rawPayloadRetained: false } });
    expect(JSON.stringify(events)).not.toContain('do-not-retain');
  });

  it('quarantines unsafe tool-call and tool-result metadata before construction', async () => {
    const repo = repository();
    const adapter = new OpenClawCanonicalAdapter(repo as any, 'gateway/test');
    await adapter.ingestSnapshot('agent:main:main', session, [
      { id: 'entry-1', timestamp, message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'credential leakedCallSecret123456789', name: 'client_secret leakedName123456789' },
      ] } },
      { id: 'entry-2', timestamp, message: { role: 'toolResult', toolCallId: 'credential leakedResultSecret123456789', toolName: 'client_secret leakedResultName123456789' } },
    ], true);
    const events = repo.appendEvent.mock.calls.map(([event]) => event);
    expect(events.filter(event => event.eventKind === 'error')).toHaveLength(2);
    expect(events.some(event => event.eventKind === 'tool_call' || event.eventKind === 'tool_result')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('leakedCallSecret');
    expect(JSON.stringify(events)).not.toContain('leakedResultSecret');
  });

  it('fails closed for residual unsupported credential-bearing message text', async () => {
    const repo = repository();
    const adapter = new OpenClawCanonicalAdapter(repo as any, 'gateway/test');
    await adapter.ingestSnapshot('agent:main:main', session, [
      { id: 'entry-1', timestamp, message: { role: 'user', content: 'client_secret opaqueValue123456789' } },
    ], true);
    const events = repo.appendEvent.mock.calls.map(([event]) => event);
    expect(events.find(event => event.sourceEventId === 'entry:entry-1:content-quarantine')).toMatchObject({
      eventKind: 'error', payload: { reason: 'openclaw_message_content_quarantined', rawPayloadRetained: false },
    });
    expect(JSON.stringify(events)).not.toContain('opaqueValue');
  });

  it('quarantines credential-bearing message role metadata', async () => {
    const repo = repository();
    const adapter = new OpenClawCanonicalAdapter(repo as any, 'gateway/test');
    await adapter.ingestSnapshot('agent:main:main', session, [
      { id: 'entry-1', timestamp, message: { role: 'password=leakedRoleSecret123456789', content: 'ordinary message' } },
    ], true);
    const events = repo.appendEvent.mock.calls.map(([event]) => event);
    expect(events.find(event => event.sourceEventId === 'entry:entry-1:role-quarantine')).toMatchObject({
      eventKind: 'error', payload: { reason: 'openclaw_message_role_quarantined', rawPayloadRetained: false },
    });
    expect(JSON.stringify(events)).not.toContain('leakedRoleSecret123456789');
  });

  it('uses stable source identities so repository replay can deduplicate events', async () => {
    const repo = repository();
    repo.appendEvent.mockImplementation(async (input: any) => ({ event: input, inserted: repo.appendEvent.mock.calls.length <= 2 }));
    const adapter = new OpenClawCanonicalAdapter(repo as any, 'gateway/test');
    const entries = [{ id: 'entry-1', timestamp, message: { role: 'user', content: 'hello' } }];
    const first = await adapter.ingestSnapshot('agent:main:main', session, entries, true);
    const second = await adapter.ingestSnapshot('agent:main:main', session, entries, true);
    expect(first.insertedEvents).toBe(2);
    expect(second.replayedEvents).toBe(2);
    const keys = repo.appendEvent.mock.calls.map(([event]) => event.idempotencyKey);
    expect(keys.slice(0, 2)).toEqual(keys.slice(2, 4));
  });

  it('persists malformed-line gap evidence and advances an atomic line cursor', async () => {
    const repo = repository() as any;
    repo.commitIngestionBatch = jest.fn(async (batch: any) => ({
      insertedEvents: batch.events.length, replayedEvents: 0, cursorAdvanced: true, cursorRevision: 1,
    }));
    const adapter = new OpenClawCanonicalAdapter(repo, 'gateway/test');
    await adapter.ingestSnapshot('agent:main:main', session, [
      { id: 'malformed-line-2', type: '__parse_error' },
    ], true, new Date(timestamp), 3);
    const batch = repo.commitIngestionBatch.mock.calls[0][0];
    expect(batch.cursorPosition).toBe('3');
    expect(batch.cursorValue).toBe('line:3');
    expect(batch.gaps).toEqual([{ attemptId, gapKind: 'malformed_jsonl_line', expectedFrom: '2', expectedTo: '2' }]);
    expect(batch.events.find((event: any) => event.sourceEventId === 'entry:malformed-line-2:parse-gap'))
      .toMatchObject({ eventKind: 'error', payload: { reason: 'openclaw_jsonl_parse_gap', rawPayloadRetained: false } });
    expect(batch.events.every((event: any) => event.source === 'openclaw_jsonl')).toBe(true);
    expect(repo.appendEvent).toHaveBeenCalledTimes(1);
    expect(repo.appendEvent.mock.calls[0][0]).toMatchObject({
      source: 'openclaw_registry',
      eventKind: 'lifecycle',
    });
  });
});
