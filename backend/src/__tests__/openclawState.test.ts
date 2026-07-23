import {
  findMainSessionEntry,
  resolveContextUsage,
  resolveSessionModel,
} from '../services/openclawState';

describe('findMainSessionEntry', () => {
  it('prefers the 2026.6.11 explicit main key over the frozen legacy entry', () => {
    const sessions = {
      'agent:main:main': { sessionId: 'legacy-uuid', model: 'gpt-5.4', updatedAt: 100 },
      'agent:main:explicit:main': { sessionId: 'main', model: 'gemini/gemini-3-flash-preview', updatedAt: 200 },
      'agent:main:heartbeat': { sessionId: 'hb-uuid', model: 'gemini/gemini-2.5-flash', updatedAt: 300 },
    };
    const entry = findMainSessionEntry(sessions);
    expect(entry?.key).toBe('agent:main:explicit:main');
    expect(entry?.session.sessionId).toBe('main');
  });

  it('prefers the main agent over other agents with explicit main sessions', () => {
    const sessions = {
      'agent:other:explicit:main': { sessionId: 'other-main', updatedAt: 999 },
      'agent:main:explicit:main': { sessionId: 'main', updatedAt: 100 },
    };
    expect(findMainSessionEntry(sessions)?.key).toBe('agent:main:explicit:main');
  });

  it('falls back to the legacy main:main key for older OpenClaw versions', () => {
    const sessions = {
      'agent:main:main': { sessionId: 'legacy-uuid', model: 'gpt-5.4', updatedAt: 100 },
      'agent:main:subagent:abc-main:main': { sessionId: 'sub', updatedAt: 200 },
    };
    const entry = findMainSessionEntry(sessions);
    expect(entry?.key).toBe('agent:main:main');
  });

  it('does not match explicit non-main or heartbeat sessions', () => {
    const sessions = {
      'agent:main:explicit:smoke-test-20260703': { sessionId: 'smoke' },
      'agent:main:heartbeat': { sessionId: 'hb' },
    };
    expect(findMainSessionEntry(sessions)).toBeNull();
  });

  it('returns null for an empty map', () => {
    expect(findMainSessionEntry({})).toBeNull();
  });
});

describe('resolveSessionModel', () => {
  it('prefixes the split modelProvider from 2026.6.11 entries', () => {
    expect(resolveSessionModel({
      model: 'gemini/gemini-3-flash-preview',
      modelProvider: 'litellm',
    })).toBe('litellm/gemini/gemini-3-flash-preview');
  });

  it('does not double-prefix when model already includes the provider', () => {
    expect(resolveSessionModel({
      model: 'litellm/gemini/gemini-3-flash-preview',
      modelProvider: 'litellm',
    })).toBe('litellm/gemini/gemini-3-flash-preview');
  });

  it('passes through legacy entries without a provider', () => {
    expect(resolveSessionModel({ model: 'gpt-5.4' })).toBe('gpt-5.4');
  });

  it('returns null when the entry has no model', () => {
    expect(resolveSessionModel({})).toBeNull();
    expect(resolveSessionModel({ model: null })).toBeNull();
  });
});

describe('resolveContextUsage', () => {
  it('uses the contextBudgetStatus snapshot when present', () => {
    expect(resolveContextUsage({
      contextTokens: 128000,
      contextBudgetStatus: { estimatedPromptTokens: 23369, contextTokenBudget: 128000 },
    })).toEqual({ used: 23369, max: 128000, percent: 18 });
  });

  it('falls back to contextTokens when the budget has no contextTokenBudget', () => {
    expect(resolveContextUsage({
      contextTokens: 100000,
      contextBudgetStatus: { estimatedPromptTokens: 50000 },
    })).toEqual({ used: 50000, max: 100000, percent: 50 });
  });

  it('uses the legacy cumulative estimate when no budget snapshot exists', () => {
    expect(resolveContextUsage({ totalTokens: 50000, contextTokens: 200000 }))
      .toEqual({ used: 50000, max: 200000, percent: 25 });
  });

  it('applies the legacy modulo heuristic when totalTokens exceeds the window', () => {
    expect(resolveContextUsage({ totalTokens: 411717, contextTokens: 200000 }))
      .toEqual({ used: 11717, max: 200000, percent: 6 });
  });

  it('caps percent at 100', () => {
    expect(resolveContextUsage({
      contextBudgetStatus: { estimatedPromptTokens: 300000, contextTokenBudget: 128000 },
    }).percent).toBe(100);
  });
});
