export interface HardenedOrchestrationConfig {
  reviewerHeartbeatEnabled: boolean;
  reviewerHeartbeatIntervalMs: number;
  reviewTimeoutMs: number;
  reviewerHeartbeatStateFile: string;
  hardenedOrchestrationEnabled: boolean;
  maxActiveGlobal: number;
  maxActivePerProject: number;
  leaseTtlMs: number;
  notificationBaseBackoffMs: number;
  notificationMaxBackoffMs: number;
  hermesQaRepo?: string;
}

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

function parseBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be exactly true or false`);
}

function parseInteger(env: Env, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function loadHardenedOrchestrationConfig(env: Env = process.env): HardenedOrchestrationConfig {
  const reviewerHeartbeatEnabled = parseBoolean(env, 'TASK_REVIEWER_HEARTBEAT_ENABLED', false);
  const hardenedOrchestrationEnabled = parseBoolean(env, 'CLAWBEAT_HARDENED_ORCHESTRATION_ENABLED', false);
  // The reviewer switch remains fail-closed until the DB-backed review
  // controller is complete. The scheduling switch now gates the transactional
  // lease/claim API and the matching ClawBeat client path.
  if (reviewerHeartbeatEnabled) {
    throw new Error('TASK_REVIEWER_HEARTBEAT_ENABLED=true is unavailable until the DB-backed reviewer controller is implemented');
  }


  const baseBackoff = parseInteger(env, 'CLAWBEAT_NOTIFICATION_BASE_BACKOFF_MS', 60_000, 1_000, 3_600_000);
  const maxBackoff = parseInteger(env, 'CLAWBEAT_NOTIFICATION_MAX_BACKOFF_MS', 900_000, 1_000, 86_400_000);
  if (maxBackoff < baseBackoff) {
    throw new Error('CLAWBEAT_NOTIFICATION_MAX_BACKOFF_MS must be greater than or equal to CLAWBEAT_NOTIFICATION_BASE_BACKOFF_MS');
  }

  const maxActiveGlobal = parseInteger(env, 'CLAWBEAT_MAX_ACTIVE_GLOBAL', 1, 1, 64);
  const maxActivePerProject = parseInteger(env, 'CLAWBEAT_MAX_ACTIVE_PER_PROJECT', 1, 1, 64);
  if (maxActivePerProject > maxActiveGlobal) {
    throw new Error('CLAWBEAT_MAX_ACTIVE_PER_PROJECT cannot exceed CLAWBEAT_MAX_ACTIVE_GLOBAL');
  }

  const hermesQaRepo = env.CLAWBEAT_HERMES_QA_REPO?.trim() || env.DEPLOYED_REPO_PATH?.trim() || undefined;
  if (hermesQaRepo && !hermesQaRepo.startsWith('/')) {
    throw new Error('CLAWBEAT_HERMES_QA_REPO/DEPLOYED_REPO_PATH must be an absolute path');
  }

  return {
    reviewerHeartbeatEnabled,
    reviewerHeartbeatIntervalMs: parseInteger(env, 'REVIEWER_HEARTBEAT_INTERVAL_MS', 15_000, 1_000, 3_600_000),
    reviewTimeoutMs: parseInteger(env, 'TASK_REVIEW_TIMEOUT_MS', 300_000, 1_000, 3_600_000),
    reviewerHeartbeatStateFile: env.REVIEWER_HEARTBEAT_STATE_FILE?.trim() || '/data/reviewer-heartbeat-state.json',
    hardenedOrchestrationEnabled,
    maxActiveGlobal,
    maxActivePerProject,
    leaseTtlMs: parseInteger(env, 'CLAWBEAT_LEASE_TTL_MS', 900_000, 30_000, 3_600_000),
    notificationBaseBackoffMs: baseBackoff,
    notificationMaxBackoffMs: maxBackoff,
    hermesQaRepo,
  };
}
