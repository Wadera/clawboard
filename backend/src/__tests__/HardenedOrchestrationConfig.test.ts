import { loadHardenedOrchestrationConfig } from '../config/HardenedOrchestrationConfig';

describe('loadHardenedOrchestrationConfig', () => {
  it('defaults all new controllers off and applies bounded defaults', () => {
    expect(loadHardenedOrchestrationConfig({})).toEqual({
      reviewerHeartbeatEnabled: false,
      reviewerHeartbeatIntervalMs: 15_000,
      reviewTimeoutMs: 300_000,
      reviewerHeartbeatStateFile: '/data/reviewer-heartbeat-state.json',
      hardenedOrchestrationEnabled: false,
      maxActiveGlobal: 1,
      maxActivePerProject: 1,
      leaseTtlMs: 900_000,
      notificationBaseBackoffMs: 60_000,
      notificationMaxBackoffMs: 900_000,
      hermesQaRepo: undefined,
    });
  });

  it('parses bounded tuning values while controllers remain disabled', () => {
    const config = loadHardenedOrchestrationConfig({
      TASK_REVIEWER_HEARTBEAT_ENABLED: 'false',
      REVIEWER_HEARTBEAT_INTERVAL_MS: '2000',
      TASK_REVIEW_TIMEOUT_MS: '45000',
      CLAWBEAT_HARDENED_ORCHESTRATION_ENABLED: 'false',
      CLAWBEAT_MAX_ACTIVE_GLOBAL: '4',
      CLAWBEAT_MAX_ACTIVE_PER_PROJECT: '2',
      CLAWBEAT_LEASE_TTL_MS: '60000',
      CLAWBEAT_NOTIFICATION_BASE_BACKOFF_MS: '2000',
      CLAWBEAT_NOTIFICATION_MAX_BACKOFF_MS: '4000',
      DEPLOYED_REPO_PATH: '/deployed-repo',
    });
    expect(config.reviewerHeartbeatEnabled).toBe(false);
    expect(config.hardenedOrchestrationEnabled).toBe(false);
    expect(config.maxActiveGlobal).toBe(4);
    expect(config.hermesQaRepo).toBe('/deployed-repo');
  });

  it('accepts explicit activation of the implemented transactional scheduler', () => {
    const config = loadHardenedOrchestrationConfig({
      CLAWBEAT_HARDENED_ORCHESTRATION_ENABLED: 'true',
    });
    expect(config.hardenedOrchestrationEnabled).toBe(true);
  });

  it.each([
    [{ TASK_REVIEWER_HEARTBEAT_ENABLED: 'yes' }, /exactly true or false/],
    [{ REVIEWER_HEARTBEAT_INTERVAL_MS: '999' }, /between 1000/],
    [{ CLAWBEAT_MAX_ACTIVE_GLOBAL: '0' }, /between 1/],
    [{ CLAWBEAT_MAX_ACTIVE_GLOBAL: '1', CLAWBEAT_MAX_ACTIVE_PER_PROJECT: '2' }, /cannot exceed/],
    [{ CLAWBEAT_NOTIFICATION_BASE_BACKOFF_MS: '5000', CLAWBEAT_NOTIFICATION_MAX_BACKOFF_MS: '4000' }, /greater than or equal/],
    [{ CLAWBEAT_HERMES_QA_REPO: 'relative/path' }, /absolute path/],
  ])('fails closed for invalid configuration %#', (env, expected) => {
    expect(() => loadHardenedOrchestrationConfig(env)).toThrow(expected);
  });

  it.each([
    [{ TASK_REVIEWER_HEARTBEAT_ENABLED: 'true' }, /DB-backed reviewer controller is implemented/],
  ])('rejects opt-in to an unavailable controller %#', (env, expected) => {
    expect(() => loadHardenedOrchestrationConfig(env)).toThrow(expected);
  });
});
