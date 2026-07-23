import {
  deriveSessionHarness,
  deriveSessionType,
  getHarnessBadgeLabel,
  getSessionDisplayLabel,
  getSessionTypeBadgeLabel,
} from '../utils/sessionTaxonomy';

describe('session taxonomy', () => {
  it('classifies OpenClaw main sessions', () => {
    expect(deriveSessionHarness({ sessionKey: 'agent:main:main', kind: 'main' })).toBe('openclaw');
    expect(deriveSessionType({ sessionKey: 'agent:main:main', kind: 'main', harness: 'openclaw' })).toBe('main');
    expect(getSessionDisplayLabel({
      sessionKey: 'agent:main:main',
      label: 'Main Session',
      harness: 'openclaw',
      sessionType: 'main',
    })).toBe('Main OpenClaw');
  });

  it('classifies OpenClaw cron and subagent sessions', () => {
    expect(deriveSessionHarness({ sessionKey: 'agent:main:cron:1234', kind: 'cron' })).toBe('openclaw');
    expect(deriveSessionType({ sessionKey: 'agent:main:cron:1234', kind: 'cron', harness: 'openclaw' })).toBe('cron');
    expect(deriveSessionType({ sessionKey: 'agent:main:subagent:1234', kind: 'subagent', harness: 'openclaw' })).toBe('subagent');
  });

  it('classifies Hermes local cli sessions', () => {
    expect(deriveSessionHarness({ sessionKey: 'agent:main:local:dm' })).toBe('hermes');
    expect(deriveSessionType({ sessionKey: 'agent:main:local:dm', harness: 'hermes' })).toBe('cli');
    expect(getSessionDisplayLabel({
      sessionKey: 'agent:main:local:dm',
      label: 'Main Session',
      harness: 'hermes',
      sessionType: 'cli',
    })).toBe('Main Hermes');
  });

  it('classifies OpenClaw discord channel sessions by default', () => {
    expect(deriveSessionHarness({
      sessionKey: 'agent:main:discord:channel:222222222222222222',
      kind: 'discord',
    })).toBe('openclaw');
    expect(deriveSessionType({
      sessionKey: 'agent:main:discord:channel:222222222222222222',
      kind: 'discord',
      harness: 'openclaw',
    })).toBe('channel');
  });

  it('classifies Hermes threaded chat sessions', () => {
    expect(deriveSessionHarness({ sessionKey: 'agent:main:discord:thread:chan123:thread456' })).toBe('hermes');
    expect(deriveSessionType({
      sessionKey: 'agent:main:discord:thread:chan123:thread456',
      harness: 'hermes',
    })).toBe('thread');
  });

  it('prefers explicit spawnInfo harness when provided', () => {
    expect(deriveSessionHarness({
      sessionKey: 'agent:main:discord:channel:123',
      kind: 'discord',
      spawnInfo: { harness: 'hermes' },
    })).toBe('hermes');
  });

  it('returns friendly badge labels', () => {
    expect(getHarnessBadgeLabel('openclaw')).toBe('OpenClaw');
    expect(getHarnessBadgeLabel('hermes')).toBe('Hermes');
    expect(getSessionTypeBadgeLabel('cron')).toBe('cron');
    expect(getSessionTypeBadgeLabel('subagent')).toBe('sub agent');
  });
});
