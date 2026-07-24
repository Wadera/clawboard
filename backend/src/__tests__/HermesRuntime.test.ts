import { inferHermesSessionState, isHermesSessionLiveWork, shouldBlockHermesRespawn } from '../services/HermesRuntime';

describe('HermesRuntime', () => {
  it('does not classify a zero-message fresh Hermes row as running without a live PID', () => {
    const state = inferHermesSessionState({
      started_at: 1777133972,
      ended_at: null,
      last_message_at: null,
    }, {
      pidAlive: false,
      nowSeconds: 1777133972 + 30,
    });

    expect(state).toBe('starting');
  });

  it('classifies a zero-message stale Hermes row as idle without a live PID', () => {
    const state = inferHermesSessionState({
      started_at: 1777133972,
      ended_at: null,
      last_message_at: null,
    }, {
      pidAlive: false,
      nowSeconds: 1777133972 + 240,
    });

    expect(state).toBe('idle');
  });

  it('classifies a Hermes row with a live PID as running even before first message', () => {
    const state = inferHermesSessionState({
      started_at: 1777133972,
      ended_at: null,
      last_message_at: null,
    }, {
      pidAlive: true,
      nowSeconds: 1777133972 + 240,
    });

    expect(state).toBe('running');
  });

  it('classifies recent message activity as running without requiring the launch PID', () => {
    const state = inferHermesSessionState({
      started_at: 1777133972,
      ended_at: null,
      last_message_at: 1777134210,
      message_count: 1,
      tool_call_count: 0,
    }, {
      pidAlive: false,
      nowSeconds: 1777134210 + 30,
    });

    expect(state).toBe('running');
  });

  it('does not classify zero-message Hermes rows as running just because last_message_at moved', () => {
    const state = inferHermesSessionState({
      started_at: 1777133972,
      ended_at: null,
      last_message_at: 1777134210,
      message_count: 0,
      tool_call_count: 0,
    }, {
      pidAlive: false,
      nowSeconds: 1777134210 + 30,
    });

    expect(state).toBe('idle');
  });

  it('treats idle Hermes rows as bypassable instead of live work for deduplication', () => {
    expect(isHermesSessionLiveWork('starting')).toBe(true);
    expect(isHermesSessionLiveWork('running')).toBe(true);
    expect(isHermesSessionLiveWork('idle')).toBe(false);
    expect(isHermesSessionLiveWork('completed')).toBe(false);
    expect(isHermesSessionLiveWork('failed')).toBe(false);
    expect(isHermesSessionLiveWork('none')).toBe(false);
  });

  it('blocks a respawn while the session is live work', () => {
    expect(shouldBlockHermesRespawn({ state: 'starting', row: null })).toBe(true);
    expect(shouldBlockHermesRespawn({ state: 'running', row: null })).toBe(true);
  });

  it('blocks a respawn for an idle interactive session with real recorded work', () => {
    expect(shouldBlockHermesRespawn({ state: 'idle', row: { message_count: 3, tool_call_count: 0 } as any })).toBe(true);
    expect(shouldBlockHermesRespawn({ state: 'idle', row: { message_count: 0, tool_call_count: 2 } as any })).toBe(true);
  });

  it('allows a respawn over an idle zero-activity stale session (bypass rule)', () => {
    expect(shouldBlockHermesRespawn({ state: 'idle', row: { message_count: 0, tool_call_count: 0 } as any })).toBe(false);
    expect(shouldBlockHermesRespawn({ state: 'idle', row: null })).toBe(false);
  });

  it('never blocks a respawn for ended or missing sessions', () => {
    expect(shouldBlockHermesRespawn({ state: 'completed', row: { message_count: 9, tool_call_count: 4 } as any })).toBe(false);
    expect(shouldBlockHermesRespawn({ state: 'failed', row: null })).toBe(false);
    expect(shouldBlockHermesRespawn({ state: 'none', row: null })).toBe(false);
  });
});
