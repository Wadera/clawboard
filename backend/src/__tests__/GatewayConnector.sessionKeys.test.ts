import { buildCronSessionKey, canonicalizeSessionKey, getSessionKeyAliases } from '../services/GatewayConnector';

describe('GatewayConnector session key helpers', () => {
  it('builds canonical cron session keys', () => {
    expect(buildCronSessionKey('abc-123')).toBe('agent:main:cron:abc-123');
  });

  it('canonicalizes legacy cron aliases', () => {
    expect(canonicalizeSessionKey('cron:abc-123')).toBe('agent:main:cron:abc-123');
    expect(canonicalizeSessionKey('agent:main:cron:abc-123')).toBe('agent:main:cron:abc-123');
  });

  it('returns both canonical and legacy aliases for cron sessions', () => {
    expect(getSessionKeyAliases('cron:abc-123')).toEqual([
      'agent:main:cron:abc-123',
      'cron:abc-123',
    ]);
  });
});
