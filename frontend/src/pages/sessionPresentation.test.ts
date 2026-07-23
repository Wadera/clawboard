import { describe, expect, it } from 'vitest';
import {
  getSessionOperationsBucket,
  getSessionOperationsEmptyState,
  getSessionOperationsReason,
  getSessionTokenUsage,
} from './sessionPresentation';

describe('sessions operations information architecture', () => {
  it.each([
    [{ hasLiveState: true }, 'active'],
    [{ hasLiveState: false, runtimeState: 'live' }, 'active'],
    [{ hasLiveState: false, runtimeState: 'starting' }, 'active'],
    [{ hasLiveState: false, status: 'stuck' }, 'degraded'],
    [{ hasLiveState: false, runtimeState: 'missing' }, 'degraded'],
    [{ hasLiveState: false, transcriptState: 'missing' }, 'degraded'],
    [{ hasLiveState: false, runtimeState: 'ended', transcriptState: 'available' }, 'history'],
  ] as const)('classifies backend-authored state %j as %s', (input, expected) => {
    expect(getSessionOperationsBucket(input)).toBe(expected);
  });

  it('does not let a live-state hint hide an explicit degraded runtime', () => {
    expect(getSessionOperationsBucket({ hasLiveState: true, runtimeState: 'missing' })).toBe('degraded');
  });

  it('gives filtered and operationally actionable empty-state copy', () => {
    expect(getSessionOperationsEmptyState('active', false)).toContain('Degraded');
    expect(getSessionOperationsEmptyState('all', true)).toBe('No sessions match the current filters.');
  });

  it('uses backend-authored runtime and transcript reasons without inventing freshness', () => {
    expect(getSessionOperationsReason({
      hasLiveState: false,
      runtimeState: 'missing',
      runtimeStateReason: 'Hermes runtime row is absent.',
      transcriptState: 'missing',
      transcriptStateReason: 'Archive is absent.',
    })).toBe('Hermes runtime row is absent.');
    expect(getSessionOperationsReason({
      hasLiveState: false,
      transcriptState: 'missing',
      transcriptStateReason: 'Archive is absent.',
    })).toBe('Archive is absent.');
    expect(getSessionOperationsReason({ hasLiveState: true, runtimeState: 'live' })).toBeNull();
  });

  it('derives one usage total from canonical mutually exclusive counters', () => {
    expect(getSessionTokenUsage({ inputTokens: 120, outputTokens: 30, thinkingTokens: 10 })).toEqual({
      input: 120,
      output: 30,
      thinking: 10,
      total: 160,
      source: 'canonical-session-aggregate',
    });
    expect(getSessionTokenUsage({ inputTokens: Number.NaN, outputTokens: -1 })).toMatchObject({
      input: 0,
      output: 0,
      total: 0,
    });
  });
});