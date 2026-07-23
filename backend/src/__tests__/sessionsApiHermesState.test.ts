jest.mock('../db/connection', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('../services/GatewayConnector', () => ({
  GatewayConnector: jest.fn(),
  getSessionKeyAliases: jest.fn((key: string) => [key]),
}));

jest.mock('../services/TaskManagerDB', () => ({ taskManagerDB: {} }));
jest.mock('../services/ProjectService', () => ({ projectService: {} }));
jest.mock('../services/TaskExecutors', () => ({ createTaskExecutor: jest.fn() }));
jest.mock('../services/SteeringAttachmentService', () => ({
  buildSteeringMessage: jest.fn(),
  getSteeringAttachmentConfig: jest.fn(),
  materializeSteeringAttachments: jest.fn(),
}));
jest.mock('../services/AttachmentWriter', () => ({ cleanupAttachments: jest.fn() }));
jest.mock('../services/AgentHistoryService', () => ({ agentHistoryService: {} }));
jest.mock('../services/SessionMessageRepository', () => ({ sessionMessageRepository: {} }));

import {
  buildReadonlyHermesLiveState,
  dedupeSessions,
  deriveHermesRowStatus,
  hermesRowIsRecentlyActive,
  getPipelineHealth,
  mapHermesSessionToRow,
  rowToSession,
  toHermesEpochSeconds,
} from '../routes/sessionsApi';
import { canonicalSessionRepository } from '../services/CanonicalSessionRepository';

const MINUTE_SECONDS = 60;
const DAY_SECONDS = 24 * 60 * 60;
const STALE_SESSION_ID = '20260615_152751_64a30ca5';
const FRESH_SESSION_ID = '20260703_090000_fe12ab34';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function makeHermesStateRow(overrides: Record<string, any> = {}): any {
  return {
    id: FRESH_SESSION_ID,
    source: 'cli',
    model: 'test-model',
    title: null,
    started_at: nowSeconds() - 60 * MINUTE_SECONDS,
    ended_at: null,
    message_count: 12,
    tool_call_count: 3,
    input_tokens: 100,
    output_tokens: 50,
    last_message_at: nowSeconds() - 5 * MINUTE_SECONDS,
    ...overrides,
  };
}

describe('toHermesEpochSeconds', () => {
  test('passes epoch seconds through unchanged', () => {
    expect(toHermesEpochSeconds(1_750_000_000)).toBe(1_750_000_000);
  });

  test('normalizes epoch milliseconds down to seconds', () => {
    expect(toHermesEpochSeconds(1_750_000_000_000)).toBe(1_750_000_000);
  });

  test('normalizes Date objects to epoch seconds', () => {
    expect(toHermesEpochSeconds(new Date(1_750_000_000_000))).toBe(1_750_000_000);
  });

  test('normalizes ISO strings to epoch seconds', () => {
    expect(toHermesEpochSeconds('2026-06-15T15:27:51.000Z')).toBe(Math.floor(Date.parse('2026-06-15T15:27:51.000Z') / 1000));
  });

  test('returns null for empty or invalid values', () => {
    expect(toHermesEpochSeconds(null)).toBeNull();
    expect(toHermesEpochSeconds(undefined)).toBeNull();
    expect(toHermesEpochSeconds('')).toBeNull();
    expect(toHermesEpochSeconds('not-a-date')).toBeNull();
    expect(toHermesEpochSeconds(0)).toBeNull();
  });
});

describe('mapHermesSessionToRow status', () => {
  test('open row with activity inside the 15-minute window stays active', () => {
    const mapped = mapHermesSessionToRow(makeHermesStateRow({
      last_message_at: nowSeconds() - 2 * MINUTE_SECONDS,
    }));
    expect(mapped.status).toBe('active');
  });

  test('open row with no messages but a recent start stays active', () => {
    const mapped = mapHermesSessionToRow(makeHermesStateRow({
      started_at: nowSeconds() - 5 * MINUTE_SECONDS,
      last_message_at: null,
      message_count: 0,
      tool_call_count: 0,
    }));
    expect(mapped.status).toBe('active');
  });

  test('open row with last activity older than 15 minutes is completed, not active', () => {
    const mapped = mapHermesSessionToRow(makeHermesStateRow({
      last_message_at: nowSeconds() - 20 * MINUTE_SECONDS,
    }));
    expect(mapped.status).toBe('completed');
  });

  test('18-day-old open row is completed, not active', () => {
    const mapped = mapHermesSessionToRow(makeHermesStateRow({
      id: STALE_SESSION_ID,
      started_at: nowSeconds() - 18 * DAY_SECONDS,
      last_message_at: nowSeconds() - 18 * DAY_SECONDS,
    }));
    expect(mapped.status).toBe('completed');
  });

  test('ended row is completed regardless of recency', () => {
    const mapped = mapHermesSessionToRow(makeHermesStateRow({
      ended_at: nowSeconds() - MINUTE_SECONDS,
      last_message_at: nowSeconds() - MINUTE_SECONDS,
    }));
    expect(mapped.status).toBe('completed');
  });
});

describe('buildReadonlyHermesLiveState', () => {
  test('returns null for a stale open row (epoch seconds, 18 days old)', () => {
    const mapped = mapHermesSessionToRow(makeHermesStateRow({
      id: STALE_SESSION_ID,
      started_at: nowSeconds() - 18 * DAY_SECONDS,
      last_message_at: nowSeconds() - 18 * DAY_SECONDS,
    }));
    expect(buildReadonlyHermesLiveState(mapped)).toBeNull();
  });

  test('returns idle live state with ms lastActivity for a recently active open row', () => {
    const lastMessageAt = nowSeconds() - 5 * MINUTE_SECONDS;
    const mapped = mapHermesSessionToRow(makeHermesStateRow({
      last_message_at: lastMessageAt,
    }));
    const live = buildReadonlyHermesLiveState(mapped);
    expect(live).not.toBeNull();
    expect(live!.state).toBe('idle');
    expect(live!.isGenerating).toBe(false);
    expect(live!.lastActivity).toBe(lastMessageAt * 1000);
  });

  test('returns busy live state for a session that wrote a message seconds ago', () => {
    const lastMessageAt = nowSeconds() - 20;
    const mapped = mapHermesSessionToRow(makeHermesStateRow({
      started_at: nowSeconds() - 60 * MINUTE_SECONDS,
      last_message_at: lastMessageAt,
    }));
    const live = buildReadonlyHermesLiveState(mapped);
    expect(live).not.toBeNull();
    expect(live!.state).toBe('busy');
    expect(live!.isGenerating).toBe(true);
    expect(live!.lastActivity).toBe(lastMessageAt * 1000);
  });

  test('returns busy live state for a session inside the startup grace window', () => {
    const mapped = mapHermesSessionToRow(makeHermesStateRow({
      started_at: nowSeconds() - 30,
      last_message_at: null,
      message_count: 0,
      tool_call_count: 0,
    }));
    const live = buildReadonlyHermesLiveState(mapped);
    expect(live).not.toBeNull();
    expect(live!.state).toBe('busy');
    expect(live!.isGenerating).toBe(true);
  });

  test('returns null for a stale pg-sourced row with Date timestamps', () => {
    const staleDate = new Date(Date.now() - 18 * DAY_SECONDS * 1000);
    const live = buildReadonlyHermesLiveState({
      session_key: `agent:main:local:dm:${STALE_SESSION_ID}`,
      started_at: staleDate,
      ended_at: null,
      last_activity_at: staleDate,
    });
    expect(live).toBeNull();
  });

  test('returns null for a stale row with a Date-like epoch-milliseconds started_at', () => {
    const live = buildReadonlyHermesLiveState({
      session_key: `agent:main:local:dm:${STALE_SESSION_ID}`,
      started_at: Date.now() - 18 * DAY_SECONDS * 1000,
      ended_at: null,
    });
    expect(live).toBeNull();
  });

  test('returns null for a stale row with an ISO string started_at', () => {
    const live = buildReadonlyHermesLiveState({
      session_key: `agent:main:local:dm:${STALE_SESSION_ID}`,
      started_at: new Date(Date.now() - 18 * DAY_SECONDS * 1000).toISOString(),
      ended_at: null,
    });
    expect(live).toBeNull();
  });

  test('emits ms lastActivity for a recent pg-sourced row with Date timestamps', () => {
    const lastActivity = new Date(Date.now() - 5 * MINUTE_SECONDS * 1000);
    const live = buildReadonlyHermesLiveState({
      session_key: `agent:main:local:dm:${FRESH_SESSION_ID}`,
      started_at: new Date(Date.now() - 60 * MINUTE_SECONDS * 1000),
      ended_at: null,
      last_activity_at: lastActivity,
    });
    expect(live).not.toBeNull();
    expect(live!.lastActivity).toBe(Math.floor(lastActivity.getTime() / 1000) * 1000);
    // Guard against the old microseconds bug: value must be a plausible epoch-ms.
    expect(live!.lastActivity).toBeLessThanOrEqual(Date.now());
  });

  test('returns null for an ended row', () => {
    const mapped = mapHermesSessionToRow(makeHermesStateRow({
      ended_at: nowSeconds() - MINUTE_SECONDS,
    }));
    expect(buildReadonlyHermesLiveState(mapped)).toBeNull();
  });
});

describe('deriveHermesRowStatus (shared by live mapping and pg archive upsert)', () => {
  const NOW = 1_750_000_000;

  test('open row with recent activity is active', () => {
    expect(deriveHermesRowStatus(makeHermesStateRow({
      started_at: NOW - 3600,
      last_message_at: NOW - 5 * MINUTE_SECONDS,
    }), NOW)).toBe('active');
  });

  test('open row past the window is completed — same rule the archive copy persists', () => {
    expect(deriveHermesRowStatus(makeHermesStateRow({
      started_at: NOW - 3600,
      last_message_at: NOW - 20 * MINUTE_SECONDS,
    }), NOW)).toBe('completed');
  });

  test('ended row is completed regardless of recency', () => {
    expect(deriveHermesRowStatus(makeHermesStateRow({
      started_at: NOW - 3600,
      last_message_at: NOW - 10,
      ended_at: NOW - 10,
    }), NOW)).toBe('completed');
  });
});

describe('15-minute window boundary', () => {
  const NOW = 1_750_000_000;
  const WINDOW = 15 * MINUTE_SECONDS;

  test('hermesRowIsRecentlyActive is inclusive at exactly the cutoff', () => {
    expect(hermesRowIsRecentlyActive(makeHermesStateRow({
      started_at: NOW - 3600,
      last_message_at: NOW - WINDOW,
    }), NOW)).toBe(true);
    expect(hermesRowIsRecentlyActive(makeHermesStateRow({
      started_at: NOW - 3600,
      last_message_at: NOW - WINDOW - 1,
    }), NOW)).toBe(false);
  });

  test('status flips active→completed one second past the cutoff', () => {
    expect(deriveHermesRowStatus(makeHermesStateRow({
      started_at: NOW - 3600,
      last_message_at: NOW - WINDOW,
    }), NOW)).toBe('active');
    expect(deriveHermesRowStatus(makeHermesStateRow({
      started_at: NOW - 3600,
      last_message_at: NOW - WINDOW - 1,
    }), NOW)).toBe('completed');
  });

  describe('with frozen clock', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(NOW * 1000);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('idle liveState survives at exactly the cutoff and dies one second past it', () => {
      const atCutoff = buildReadonlyHermesLiveState(mapHermesSessionToRow(makeHermesStateRow({
        started_at: NOW - 3600,
        last_message_at: NOW - WINDOW,
      })));
      expect(atCutoff).not.toBeNull();
      expect(atCutoff!.state).toBe('idle');
      expect(atCutoff!.lastActivity).toBe((NOW - WINDOW) * 1000);

      const pastCutoff = buildReadonlyHermesLiveState(mapHermesSessionToRow(makeHermesStateRow({
        started_at: NOW - 3600,
        last_message_at: NOW - WINDOW - 1,
      })));
      expect(pastCutoff).toBeNull();
    });
  });
});

describe('rowToSession for hermes rows', () => {
  test('stale open row surfaces as completed/ended with no live state', () => {
    const mapped = mapHermesSessionToRow(makeHermesStateRow({
      id: STALE_SESSION_ID,
      started_at: nowSeconds() - 18 * DAY_SECONDS,
      last_message_at: nowSeconds() - 18 * DAY_SECONDS,
    }));
    const session = rowToSession(mapped);
    expect(session.status).toBe('completed');
    expect(session.liveState).toBeNull();
    expect(session.runtimeState).toBe('ended');
  });

  test('recently active open row surfaces as active/live', () => {
    const mapped = mapHermesSessionToRow(makeHermesStateRow({
      last_message_at: nowSeconds() - 2 * MINUTE_SECONDS,
    }));
    const session = rowToSession(mapped);
    expect(session.status).toBe('active');
    expect(session.liveState).not.toBeNull();
    expect(session.runtimeState).toBe('live');
  });
});

// pg archive copies written by ensureHermesSessionArchive: 'active' snapshots
// taken while the session was alive must not survive as fabricated liveness,
// either directly (rowToSession) or through dedupe against the live hermes row.
describe('archived hermes pg copies', () => {
  function makeArchivedPgRow(overrides: Record<string, any> = {}): any {
    const started = new Date(Date.now() - 60 * MINUTE_SECONDS * 1000);
    const lastActivity = new Date(Date.now() - 2 * MINUTE_SECONDS * 1000);
    return {
      session_key: `agent:main:local:dm:${FRESH_SESSION_ID}`,
      session_id: '7f0d3c58-92be-5f5f-b7cf-0a1a4a1a2b3c',
      kind: 'unknown',
      label: `Hermes ${FRESH_SESSION_ID.slice(0, 8)}`,
      model: 'test-model',
      channel: null,
      status: 'active',
      spawn_info: {
        harness: 'hermes',
        hermes: true,
        hermesSessionId: FRESH_SESSION_ID,
        source: 'cli',
        messageSource: 'hermes-sqlite',
        archivedToDb: true,
      },
      message_count: '12',
      tool_call_count: '3',
      input_tokens: '100',
      output_tokens: '50',
      thinking_tokens: '0',
      total_cost_usd: '0',
      started_at: started,
      ended_at: null,
      last_activity_at: lastActivity,
      transcript_path: null,
      file_size: null,
      ...overrides,
    };
  }

  test('stale archived copy still marked active surfaces as completed/ended', () => {
    const staleDate = new Date(Date.now() - 18 * DAY_SECONDS * 1000);
    const session = rowToSession(makeArchivedPgRow({
      started_at: staleDate,
      last_activity_at: staleDate,
    }));
    expect(session.status).toBe('completed');
    expect(session.liveState).toBeNull();
    expect(session.runtimeState).toBe('ended');
  });

  test('recently active archived copy stays active/live', () => {
    const session = rowToSession(makeArchivedPgRow());
    expect(session.status).toBe('active');
    expect(session.liveState).not.toBeNull();
  });

  test('dedupe lets the live hermes row overrule a stale archived active copy', () => {
    // pg archive copy: still 'active' with recent-looking activity (upserted
    // just before the process ended), so it survives rowToSession as active.
    const pgSession = rowToSession(makeArchivedPgRow());
    expect(pgSession.status).toBe('active');

    // Live hermes state-db row for the same session: ended.
    const hermesSession = rowToSession(mapHermesSessionToRow(makeHermesStateRow({
      ended_at: nowSeconds() - MINUTE_SECONDS,
      last_message_at: nowSeconds() - MINUTE_SECONDS,
    })));
    expect(hermesSession.sessionKey).toBe(pgSession.sessionKey);
    expect(hermesSession.status).toBe('completed');

    // pg rows come first in the merged array, so the archive copy is the
    // dedupe "preferred" record — the live row must still win on status.
    const [merged] = dedupeSessions([pgSession, hermesSession]);
    expect(merged.status).toBe('completed');
    expect(merged.liveState).toBeNull();
    expect(merged.runtimeState).toBe('ended');
  });

  test('dedupe keeps an active session active when the live hermes row agrees', () => {
    const pgSession = rowToSession(makeArchivedPgRow());
    const hermesSession = rowToSession(mapHermesSessionToRow(makeHermesStateRow({
      last_message_at: nowSeconds() - 2 * MINUTE_SECONDS,
    })));
    const [merged] = dedupeSessions([pgSession, hermesSession]);
    expect(merged.status).toBe('active');
    expect(merged.liveState).not.toBeNull();
  });
});

describe('GET /sessions/pipeline-health', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function responseMock() {
    const response: any = {
      statusCode: 200,
      body: null,
      status: jest.fn((statusCode: number) => {
        response.statusCode = statusCode;
        return response;
      }),
      json: jest.fn((body: unknown) => {
        response.body = body;
        return response;
      }),
    };
    return response;
  }

  test('returns adapter timestamps and a degraded aggregate for mixed paths', async () => {
    const adapters = [
      {
        source: 'hermes_sqlite', source_instance: 'runtime/default', adapter_version: '1.0.0',
        status: 'healthy', reason_code: null, last_source_at: new Date('2026-07-16T14:00:00Z'),
        last_success_at: new Date('2026-07-16T14:00:01Z'), last_error_at: null,
        checked_at: new Date('2026-07-16T14:00:02Z'), safe_details: {},
      },
      {
        source: 'openclaw_jsonl', source_instance: 'gateway/default', adapter_version: '1.0.0',
        status: 'degraded', reason_code: 'source_stale', last_source_at: new Date('2026-07-16T13:00:00Z'),
        last_success_at: new Date('2026-07-16T13:00:01Z'), last_error_at: null,
        checked_at: new Date('2026-07-16T14:00:02Z'), safe_details: {},
      },
    ];
    jest.spyOn(canonicalSessionRepository, 'listAdapterHealth').mockResolvedValue(adapters as any);
    const response = responseMock();

    await getPipelineHealth({} as any, response);

    expect(response.body).toEqual({ success: true, status: 'degraded', adapters });
  });

  test('fails with a stable sanitized unavailable response', async () => {
    jest.spyOn(canonicalSessionRepository, 'listAdapterHealth').mockRejectedValue(new Error('db secret detail'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = responseMock();

    await getPipelineHealth({} as any, response);

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      success: false,
      status: 'unavailable',
      error: 'pipeline_health_unavailable',
    });
    expect(JSON.stringify(response.body)).not.toContain('db secret detail');
  });
});
