import {
  normalizeHermesRuntime,
  normalizeOpenClawRuntime,
  TaskRuntimeAdapterService,
} from '../services/TaskRuntimeAdapterService';

describe('TaskRuntimeAdapterService', () => {
  test('normalizes Hermes runtime counters and process evidence', () => {
    const result = normalizeHermesRuntime({
      sessionId: 'session-1', sessionKey: 'hermes:tool:session-1', source: 'tool',
      state: 'running', pid: 42, pidAlive: true, label: null, model: null,
      startedAt: '2026-07-15T10:00:00.000Z', endedAt: null,
      updatedAt: '2026-07-15T10:01:00.000Z', reason: null,
      row: { id: 'session-1', source: 'tool', message_count: 4, tool_call_count: 3 },
    });
    expect(result).toMatchObject({
      harness: 'hermes', state: 'running', messageCount: 4, toolCallCount: 3,
      processEvidence: { pid: 42, alive: true },
    });
  });

  test('does not treat a provisional Hermes metadata key without runtime evidence as live', () => {
    const result = normalizeHermesRuntime({
      sessionId: null, sessionKey: 'hermes:tool:pending', source: 'tool',
      state: 'none', pid: null, pidAlive: false, label: null, model: null,
      startedAt: null, endedAt: null, updatedAt: null, row: null,
      reason: 'runtime row missing',
    });
    expect(result.state).toBe('none');
    expect(result.errorClass).toBe('runtime row missing');
  });

  test.each([
    [10_000, 'running'],
    [120_000, 'idle'],
    [600_000, 'stale'],
  ])('normalizes OpenClaw recency %pms to %s', (ageMs, expected) => {
    const now = Date.parse('2026-07-15T12:00:00.000Z');
    const result = normalizeOpenClawRuntime('agent:worker:subagent:1', {
      updatedAt: now - ageMs,
      messageCount: 8,
      toolCallCount: 2,
    }, now);
    expect(result).toMatchObject({ state: expected, messageCount: 8, toolCallCount: 2 });
  });

  test('normalizes OpenClaw terminal failure ahead of recency', () => {
    const result = normalizeOpenClawRuntime('agent:worker:subagent:1', {
      updatedAt: Date.now(), error: 'redacted', errorClass: 'MODEL_ROUTE_DENIED',
    });
    expect(result.state).toBe('failed');
    expect(result.errorClass).toBe('MODEL_ROUTE_DENIED');
  });

  test('returns a sanitized read failure rather than claiming OpenClaw liveness', async () => {
    const service = new TaskRuntimeAdapterService('/definitely/missing/sessions.json');
    await expect(service.inspect('openclaw', 'agent:worker:subagent:1')).resolves.toMatchObject({
      state: 'none', errorClass: 'ENOENT',
    });
  });
});
