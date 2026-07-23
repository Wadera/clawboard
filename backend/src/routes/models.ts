import express from 'express';
import type { Request, Response } from 'express';
import { access, readFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GatewayConnector } from '../services/GatewayConnector';
import type { ModelStatusService } from '../services/modelStatus';
import { isExplicitMainSessionKey } from '../services/openclawState';
import { getModelCatalog, normalizeModelId } from '../services/modelCatalog';
import { pool } from '../db/connection';

const router = express.Router();

let gatewayConnector: GatewayConnector | null = null;
let modelStatusService: ModelStatusService | null = null;

export function setModelsGatewayConnector(connector: GatewayConnector): void {
  gatewayConnector = connector;
}

export function setModelStatusService(service: ModelStatusService): void {
  modelStatusService = service;
}

const CLAWDBOT_CONFIG = process.env.OPENCLAW_CONFIG_PATH || process.env.CLAWDBOT_CONFIG_PATH || '/clawdbot/clawdbot.json';
const AUTH_PROFILES_PATH = process.env.AUTH_PROFILES_PATH || '/clawdbot/auth-profiles.json';
const HERMES_BINARY_PATH = process.env.HERMES_BINARY_PATH || '/home/hermes/hermes-agent/venv/bin/hermes';
const HERMES_PROJECT_PATH = process.env.HERMES_PROJECT_PATH || '/home/hermes/hermes-agent';
const HERMES_HOME_PATH = process.env.HERMES_HOME_PATH || '/home/hermes';
const HERMES_READ_HOME_PATH = process.env.HERMES_READ_HOME_PATH || HERMES_HOME_PATH;
const HERMES_READ_STATE_DB_PATH = process.env.HERMES_READ_STATE_DB_PATH || process.env.HERMES_STATE_DB_PATH || '/home/hermes/.hermes/state.db';
const execFileAsync = promisify(execFile);
const MODELS_STATUS_CACHE_TTL_MS = 10000;
let modelsStatusCache: { expiresAt: number; payload: any } | null = null;

// ClawBoard-owned selectable agent models. These augment the runtime config so
// newly approved ACP/Hermes models are immediately selectable for task authoring
// even before the mounted OpenClaw config has been refreshed.
const CLAWBOARD_SUPPORTED_AGENT_MODELS: Array<{ id: string; provider: string; alias?: string }> = [
  { id: 'openai-codex/gpt-5.5', provider: 'openai-codex', alias: 'gpt-5.5' },
];

interface AuthProfileUsage {
  lastUsed?: number;
  errorCount?: number;
  lastFailureAt?: number;
  failureCounts?: Record<string, number>;
  cooldownUntil?: number;
}

async function readJsonFile(path: string): Promise<any> {
  const data = await readFile(path, 'utf-8');
  return JSON.parse(data);
}

async function pathReadable(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

interface RuntimeSystemSummary {
  id: 'openclaw' | 'hermes';
  label: string;
  available: boolean;
  configured: boolean;
  version: string | null;
  model: string | null;
  modelAlias?: string | null;
  authProfile?: string | null;
  authState?: string | null;
  provider?: string | null;
  gatewayStatus?: string | null;
  activeSessions?: number | null;
  scheduledJobs?: number | null;
  sessionAge?: string | null;
  status?: string | null;
  mainState?: string | null;
  activityLabel?: string | null;
  notes?: string | null;
  source?: string | null;
}

function parseHermesStatusField(output: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(`${escaped}\\s*:\\s*([^\\n]+)`));
  return match ? match[1].trim() : null;
}

function parseHermesAuthSummary(output: string): string | null {
  const lines = output.split('\n').map((line) => line.trim());
  const authLines = lines.filter((line) => /logged in|configured|not configured|not logged in/i.test(line));
  const configured = authLines.filter((line) => /✓|configured|logged in/i.test(line) && !/not configured|not logged in/i.test(line)).length;
  const missing = authLines.filter((line) => /✗|not configured|not logged in/i.test(line)).length;
  if (authLines.length === 0) return null;
  return `${configured} ready, ${missing} missing`;
}

interface HermesActivitySummary {
  state: 'busy' | 'idle';
  label: string | null;
  model: string | null;
  count: number;
}

async function getHermesActivitySummary(): Promise<HermesActivitySummary> {
  const stateDbPath = HERMES_READ_STATE_DB_PATH;
  if (!(await pathReadable(stateDbPath))) {
    return { state: 'idle', label: null, model: null, count: 0 };
  }
  const script = [
    'import json, sqlite3, sys',
    'from pathlib import Path',
    '',
    'db_path = Path(sys.argv[1])',
    'if not db_path.exists():',
    "    print('[]')",
    '    raise SystemExit(0)',
    "conn = sqlite3.connect(f'file:{db_path}?mode=ro&immutable=1', uri=True)",
    'conn.row_factory = sqlite3.Row',
    'cur = conn.cursor()',
    'rows = cur.execute("""',
    '    SELECT s.id, s.source, s.title, s.model, s.started_at, s.ended_at,',
    '           (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_message_at',
    '    FROM sessions s',
    '    WHERE s.ended_at IS NULL',
    '    ORDER BY CASE',
    "      WHEN LOWER(COALESCE(s.source, '')) = 'discord' THEN 0",
    "      WHEN LOWER(COALESCE(s.source, '')) = 'cli' THEN 1",
    '      ELSE 2',
    '    END,',
    '    COALESCE(last_message_at, s.started_at) DESC',
    '    LIMIT 20',
    '""").fetchall()',
    'print(json.dumps([dict(r) for r in rows]))',
  ].join('\n');
  try {
    const { stdout } = await execFileAsync('python3', ['-c', script, stateDbPath], { timeout: 2500, maxBuffer: 256 * 1024 });
    const rows = JSON.parse(stdout || '[]') as Array<{ title?: string | null; source?: string | null; model?: string | null; last_message_at?: number | null; started_at?: number | null }>;
    const cutoffSeconds = (Date.now() / 1000) - (15 * 60);
    const recentRows = rows.filter((row) => Math.max(row.last_message_at || 0, row.started_at || 0) >= cutoffSeconds);
    const primary = recentRows[0] || rows[0] || null;
    if (!primary) return { state: 'idle', label: null, model: null, count: 0 };
    const label = (primary.title || '').trim() || (String(primary.source || '').toLowerCase() === 'cli' ? 'Main Hermes' : 'Hermes');
    return { state: recentRows.length > 0 ? 'busy' : 'idle', label, model: primary.model || null, count: recentRows.length };
  } catch {
    return { state: 'idle', label: null, model: null, count: 0 };
  }
}
async function getHermesStatusSummary(): Promise<RuntimeSystemSummary> {
  const binaryAvailable = await pathReadable(HERMES_BINARY_PATH);
  const projectAvailable = await pathReadable(HERMES_PROJECT_PATH);

  if (!binaryAvailable) {
    return {
      id: 'hermes',
      label: 'Hermes',
      available: false,
      configured: false,
      version: null,
      model: null,
      notes: `Hermes binary not found at ${HERMES_BINARY_PATH}`,
      source: 'filesystem',
    };
  }

  let version: string | null = null;
  try {
    const { stdout } = await execFileAsync(HERMES_BINARY_PATH, ['version'], {
      cwd: projectAvailable ? HERMES_PROJECT_PATH : undefined,
      env: { ...process.env, HOME: '/tmp' },
      timeout: 2500,
      maxBuffer: 256 * 1024,
    });
    version = stdout.split('\n')[0]?.trim() || null;
  } catch (error: any) {
    version = error?.stdout?.split('\n')?.[0]?.trim?.() || null;
  }

  const attempts = [
    { home: HERMES_READ_HOME_PATH, source: 'configured-home' },
    ...(HERMES_READ_HOME_PATH !== HERMES_HOME_PATH ? [{ home: HERMES_HOME_PATH, source: 'runtime-home' as const }] : []),
    { home: '/tmp', source: 'sandbox-home' },
  ];

  for (const attempt of attempts) {
    try {
      const { stdout } = await execFileAsync(HERMES_BINARY_PATH, ['status'], {
        cwd: projectAvailable ? HERMES_PROJECT_PATH : undefined,
        env: { ...process.env, HOME: attempt.home },
        timeout: 3500,
        maxBuffer: 512 * 1024,
      });

      return {
        id: 'hermes',
        label: 'Hermes',
        available: true,
        configured: attempt.home !== '/tmp',
        version,
        model: parseHermesStatusField(stdout, 'Model'),
        provider: parseHermesStatusField(stdout, 'Provider'),
        authState: parseHermesAuthSummary(stdout),
        gatewayStatus: parseHermesStatusField(stdout, 'Status'),
        activeSessions: Number(parseHermesStatusField(stdout, 'Active') || 0),
        scheduledJobs: Number(parseHermesStatusField(stdout, 'Jobs') || 0),
        status: 'ok',
        notes: attempt.home === '/tmp' ? 'Hermes status loaded without the real home directory, auth/config may be incomplete.' : null,
        source: attempt.source,
      };
    } catch (error: any) {
      if (attempt.home === '/tmp') {
        return {
          id: 'hermes',
          label: 'Hermes',
          available: true,
          configured: false,
          version,
          model: null,
          authState: null,
          status: 'degraded',
          notes: error?.stderr?.trim?.() || error?.message || 'Hermes status command failed',
          source: attempt.source,
        };
      }
    }
  }

  return {
    id: 'hermes',
    label: 'Hermes',
    available: true,
    configured: false,
    version,
    model: null,
    status: 'unknown',
    notes: 'Hermes status is unavailable',
    source: 'filesystem',
  };
}

function getProfileStatus(usage: AuthProfileUsage | undefined, lastGoodProfile: string | null, profileKey: string): 'active' | 'cooldown' | 'error' | 'idle' {
  if (!usage) return 'idle';
  const now = Date.now();
  if (usage.cooldownUntil && usage.cooldownUntil > now) return 'cooldown';
  if (lastGoodProfile === profileKey) return 'active';
  if (usage.errorCount && usage.errorCount > 0) return 'error';
  return 'idle';
}

function shortModelName(modelId: string): string {
  const name = modelId.split('/').pop() || modelId;
  // claude-opus-4-6 -> Opus 4.6, claude-sonnet-4-5 -> Sonnet 4.5
  const match = name.match(/claude-(\w+)-(\d+)-(\d+)/);
  if (match) return `${match[1].charAt(0).toUpperCase() + match[1].slice(1)} ${match[2]}.${match[3]}`;
  return name;
}

/**
 * Get preferred default model from dashboard DB, or fall back to config primary
 */
async function getPreferredDefault(configPrimary: string): Promise<string> {
  try {
    const result = await pool.query(
      "SELECT value FROM user_preferences WHERE key = 'preferred_default_model'"
    );
    if (result.rows.length > 0 && result.rows[0].value) {
      return result.rows[0].value;
    }
  } catch {
    // Table might not exist yet, that's fine
  }
  return configPrimary;
}

/**
 * Set preferred default model in dashboard DB
 */
async function setPreferredDefault(model: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO user_preferences (key, value, updated_at) VALUES ('preferred_default_model', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [model]
    );
  } catch {
    // Table might not exist yet
  }
}

/**
 * GET /models/status - SINGLE SOURCE OF TRUTH for all model-related data
 * Returns: model config, auth profiles, session context, preferred default
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    if (modelsStatusCache && modelsStatusCache.expiresAt > Date.now()) {
      res.json(modelsStatusCache.payload);
      return;
    }
    const [config, authData] = await Promise.all([
      readJsonFile(CLAWDBOT_CONFIG).catch((err: any) => {
        if (err.code === 'EACCES') {
          console.warn('⚠️ Cannot read OpenClaw config (EACCES). Model info will be limited.');
        } else if (err.code !== 'ENOENT') {
          console.warn('⚠️ Cannot read OpenClaw config:', err.message);
        }
        return null;
      }),
      readJsonFile(AUTH_PROFILES_PATH).catch(() => null),
    ]);

    // If config is unreadable, return minimal status from gateway/session data
    if (!config) {
      let sessionContext = { totalTokens: 0, contextTokens: 200000, used: 0, max: 200000, percent: 0 };
      let activeModel = 'unknown';
      let sessionAge = 'unknown';
      const hermesStatus = await getHermesStatusSummary();

      if (gatewayConnector) {
        // Use live state for activity timing; model/tokens come from DB
        const liveStates = gatewayConnector.getLiveStates();
        // Prefer the 2026.6.11+ agent:<id>:explicit:main key; fall back to the
        // legacy main:main forms for older gateways.
        const liveEntries = Array.from(liveStates.entries());
        const mainLive = liveEntries.find(([key]) => isExplicitMainSessionKey(key))
          || liveEntries.find(([key]) => key === 'agent:main:main' || key.includes(':main:main'));
        if (mainLive) {
          const [, live] = mainLive;
          if (live.lastActivity) {
            const ageSecs = Math.floor((Date.now() - live.lastActivity) / 1000);
            if (ageSecs < 60) sessionAge = `${ageSecs}s`;
            else if (ageSecs < 3600) sessionAge = `${Math.floor(ageSecs / 60)}m`;
            else sessionAge = `${Math.floor(ageSecs / 3600)}h`;
          }
        }
      }

      const openclawSystem: RuntimeSystemSummary = {
        id: 'openclaw',
        label: 'OpenClaw',
        available: true,
        configured: false,
        version: null,
        model: activeModel,
        modelAlias: shortModelName(activeModel),
        sessionAge,
        status: 'degraded',
        notes: 'OpenClaw config is unreadable, showing limited live-state data only.',
        source: 'gateway',
      };

      const payload = {
        success: true,
        activeModel,
        modelAlias: shortModelName(activeModel),
        defaultModel: activeModel,
        defaultModelAlias: shortModelName(activeModel),
        isOverride: false,
        activeProfile: null,
        contextUsage: sessionContext,
        session: { ageFormatted: sessionAge },
        profiles: {},
        models: { primary: activeModel, fallbacks: [], available: [] },
        authOrder: {},
        systems: {
          openclaw: openclawSystem,
          hermes: hermesStatus,
        },
        configUnavailable: true,
      };
      modelsStatusCache = { expiresAt: Date.now() + MODELS_STATUS_CACHE_TTL_MS, payload };
      res.json(payload);
      return;
    }

    const agentDefaults = config.agents?.defaults || {};
    const modelConfig = agentDefaults.model || {};
    const modelsMap = agentDefaults.models || {};
    const primaryModel: string = modelConfig.primary || '';
    const fallbacks: string[] = modelConfig.fallbacks || [];

    // Build aliases
    const aliases: Record<string, string> = {};
    for (const [modelId, mConf] of Object.entries(modelsMap)) {
      const mc = mConf as any;
      if (mc.alias) aliases[modelId] = mc.alias;
    }

    // Collect all available models
    const available: Array<{ id: string; provider: string; alias?: string }> = [];
    const seen = new Set<string>();

    for (const modelId of Object.keys(modelsMap)) {
      if (!seen.has(modelId)) {
        seen.add(modelId);
        available.push({ id: modelId, provider: modelId.split('/')[0] || 'unknown', alias: aliases[modelId] });
      }
    }

    const providers = config.models?.providers || {};
    for (const [providerName, providerConfig] of Object.entries(providers)) {
      const pConfig = providerConfig as any;
      if (pConfig.models && Array.isArray(pConfig.models)) {
        for (const m of pConfig.models) {
          const id = typeof m === 'string' ? m : m.id;
          const fullId = id.includes('/') ? id : `litellm/${id}`;
          if (id && !seen.has(fullId)) {
            seen.add(fullId);
            available.push({ id: fullId, provider: providerName, alias: aliases[fullId] });
          }
        }
      }
    }

    for (const mid of [primaryModel, ...fallbacks]) {
      if (mid && !seen.has(mid)) {
        seen.add(mid);
        available.push({ id: mid, provider: mid.split('/')[0] || 'unknown', alias: aliases[mid] });
      }
    }

    for (const model of CLAWBOARD_SUPPORTED_AGENT_MODELS) {
      if (!seen.has(model.id)) {
        seen.add(model.id);
        available.push(model);
      }
    }

    // Merge in the live resolved catalog (LiteLLM /v1/models + configured
    // defaults/fallbacks + static floor). This is what makes task model pins
    // validate against the LIVE set instead of a stale config-only list — it is
    // the source the doctor's model-pin check consumes. Best-effort: a catalog
    // resolution failure must not break /models/status.
    try {
      const catalog = await getModelCatalog();
      for (const id of catalog.ids) {
        if (!seen.has(id)) {
          seen.add(id);
          available.push({ id, provider: id.split('/')[0] || 'unknown', alias: aliases[id] });
        }
      }
    } catch (err) {
      console.warn('⚠️ Model catalog merge skipped:', err instanceof Error ? err.message : err);
    }

    // Auth profiles
    const profiles: Record<string, any> = {};
    const authOrder: Record<string, string[]> = config.auth?.order || {};

    if (authData) {
      const authProfiles = authData.profiles || {};
      const usageStats = authData.usageStats || {};
      const lastGood = authData.lastGood || {};

      for (const [key, profileInfo] of Object.entries(authProfiles)) {
        const pInfo = profileInfo as any;
        const provider = pInfo.provider || key.split(':')[0] || 'unknown';
        const usage: AuthProfileUsage | undefined = usageStats[key];
        const lastGoodForProvider = lastGood[provider] || null;

        profiles[key] = {
          provider,
          lastUsed: usage?.lastUsed || null,
          errorCount: usage?.errorCount || 0,
          status: getProfileStatus(usage, lastGoodForProvider, key),
          cooldownUntil: usage?.cooldownUntil || null,
          failureCounts: usage?.failureCounts,
          lastFailureAt: usage?.lastFailureAt || null,
        };
      }
    }

    const primaryProvider = primaryModel.split('/')[0] || '';
    const lastGoodProfile = authData?.lastGood?.[primaryProvider] || null;

    // Get session context from ModelStatusService (reads sessions.json — same source as WS)
    // This ensures HTTP and WS return consistent data, preventing flickering
    let sessionContext = { totalTokens: 0, contextTokens: 200000, used: 0, max: 200000, percent: 0 };
    let sessionAge = 'unknown';
    let liveAgentStatus: string | undefined;
    let liveTokens: { input: number; output: number; total: number } | undefined;
    let liveAuthProfile: any;
    let liveSubagents: any[] | undefined;
    let liveUsageStats: any = null;
    let liveCompactionCount: number | null = null;
    let openclawVersion: string | null = null;
    try {
      const cachedStatus = modelStatusService ? await modelStatusService.getStatus() : null;
      if (cachedStatus) {
        sessionContext = {
          totalTokens: cachedStatus.tokens.total,
          contextTokens: cachedStatus.contextUsage.max,
          used: cachedStatus.contextUsage.used,
          max: cachedStatus.contextUsage.max,
          percent: cachedStatus.contextUsage.percent,
        };
        sessionAge = cachedStatus.session.ageFormatted;
        liveAgentStatus = cachedStatus.agentStatus;
        liveTokens = cachedStatus.tokens;
        liveAuthProfile = cachedStatus.authProfile;
        liveSubagents = cachedStatus.subagents;
        liveUsageStats = cachedStatus.usageStats;
        liveCompactionCount = cachedStatus.compactionCount ?? null;
        openclawVersion = cachedStatus.openclawVersion;
      }
    } catch {
      // Non-fatal: session context unavailable
    }

    // Get preferred default model from DB (sourced from user preference, not hardcoded)
    const configuredDefaultModel = await getPreferredDefault(primaryModel);
    const activeModel = primaryModel;
    const defaultModel = activeModel;
    const preferredDefaultModel = configuredDefaultModel;
    const isOverride = activeModel !== defaultModel;
    const [hermesStatus, hermesActivity] = await Promise.all([
      getHermesStatusSummary(),
      getHermesActivitySummary(),
    ]);
    const openclawSystem: RuntimeSystemSummary = {
      id: 'openclaw',
      label: 'OpenClaw',
      available: true,
      configured: true,
      version: openclawVersion,
      model: activeModel,
      modelAlias: shortModelName(activeModel),
      authProfile: liveAuthProfile?.name || lastGoodProfile,
      authState: liveAuthProfile?.name ? 'active' : null,
      sessionAge,
      status: liveAgentStatus || 'idle',
      mainState: liveAgentStatus === 'idle' ? 'idle' : 'busy',
      activityLabel: liveAgentStatus === 'idle' ? null : 'Main OpenClaw',
      source: 'openclaw',
    };

    const hermesHasLiveRuntime = Boolean(hermesActivity.model || hermesActivity.count > 0 || hermesActivity.label);
    const normalizedHermesStatus: RuntimeSystemSummary = {
      ...hermesStatus,
      configured: hermesStatus.configured || hermesHasLiveRuntime,
      status: hermesStatus.status === 'degraded' && hermesHasLiveRuntime ? 'ok' : hermesStatus.status,
      notes: hermesStatus.status === 'degraded' && hermesHasLiveRuntime
        ? 'Hermes CLI status probe could not read the mounted profile, but live Hermes runtime state is readable.'
        : hermesStatus.notes,
      source: hermesStatus.status === 'degraded' && hermesHasLiveRuntime ? 'live-runtime' : hermesStatus.source,
    };

    const payload = {
      success: true,
      // Model info
      activeModel,
      modelAlias: shortModelName(activeModel),
      defaultModel,
      defaultModelAlias: shortModelName(defaultModel),
      preferredDefaultModel,
      preferredDefaultModelAlias: shortModelName(preferredDefaultModel),
      isOverride,
      activeProfile: lastGoodProfile,
      // Session context (from sessions.json — consistent with WS)
      contextUsage: sessionContext,
      session: { ageFormatted: sessionAge },
      tokens: liveTokens,
      agentStatus: liveAgentStatus || 'idle',
      authProfile: liveAuthProfile,
      subagents: liveSubagents || [],
      usageStats: liveUsageStats,
      compactionCount: liveCompactionCount,
      openclawVersion,
      systems: {
        openclaw: openclawSystem,
        hermes: {
          ...normalizedHermesStatus,
          model: hermesActivity.model || normalizedHermesStatus.model,
          activeSessions: hermesActivity.count || normalizedHermesStatus.activeSessions,
          mainState: hermesActivity.state,
          activityLabel: hermesActivity.label,
        },
      },
      // Auth profiles
      profiles,
      // Model lists
      models: { primary: primaryModel, fallbacks, available },
      authOrder,
    };
    modelsStatusCache = { expiresAt: Date.now() + MODELS_STATUS_CACHE_TTL_MS, payload };
    res.json(payload);
  } catch (err: any) {
    if (err.code === 'EACCES') {
      console.warn('⚠️ Models status: permission denied reading config files. Set PUID/PGID to match host file owner.');
      res.status(503).json({ success: false, error: 'Config files not readable (permission denied). Set PUID/PGID in docker-compose.' });
    } else {
      console.error('❌ Failed to read models status:', err);
      res.status(500).json({ success: false, error: 'Failed to read models status' });
    }
  }
});

/**
 * POST /models/set-default - Set preferred default model
 */
router.post('/set-default', async (req: Request, res: Response) => {
  try {
    const { model } = req.body;
    if (!model || typeof model !== 'string') {
      res.status(400).json({ success: false, error: 'Missing or invalid "model" field' });
      return;
    }
    await setPreferredDefault(model);
    res.json({ success: true, defaultModel: model });
  } catch (err) {
    console.error('❌ Failed to set default model:', err);
    res.status(500).json({ success: false, error: 'Failed to set default model' });
  }
});

/**
 * POST /models/switch - Switch the active model
 */
router.post('/switch', async (req: Request, res: Response) => {
  try {
    const { model } = req.body;
    if (!model || typeof model !== 'string') {
      res.status(400).json({ success: false, error: 'Missing or invalid "model" field' });
      return;
    }

    const config = await readJsonFile(CLAWDBOT_CONFIG);
    const agentDefaults = config.agents?.defaults || {};
    const modelsMap = agentDefaults.models || {};

    // Collect all known model IDs
    const knownModels = new Set<string>(Object.keys(modelsMap));
    const providers = config.models?.providers || {};
    for (const [, providerConfig] of Object.entries(providers)) {
      const pConfig = providerConfig as any;
      if (pConfig.models && Array.isArray(pConfig.models)) {
        for (const m of pConfig.models) {
          const id = typeof m === 'string' ? m : m.id;
          if (id) { knownModels.add(id); if (!id.includes('/')) knownModels.add(`litellm/${id}`); }
        }
      }
    }
    const modelCfg = agentDefaults.model || {};
    if (modelCfg.primary) knownModels.add(modelCfg.primary);
    for (const fb of (modelCfg.fallbacks || [])) knownModels.add(fb);

    if (!knownModels.has(model)) {
      res.status(400).json({ success: false, error: `Unknown model: ${model}` });
      return;
    }

    if (!gatewayConnector) {
      res.status(503).json({ success: false, error: 'Gateway connector not initialized' });
      return;
    }

    const previousModel = modelCfg.primary || 'unknown';

    // Get config hash and patch
    const configResult = await gatewayConnector.sendGatewayRequest('config.get', {});
    const baseHash = configResult?.baseHash || configResult?.hash;
    if (!baseHash) throw new Error('Could not get config hash from gateway');

    await gatewayConnector.sendGatewayRequest('config.patch', {
      raw: JSON.stringify({ agents: { defaults: { model: { primary: model } } } }),
      baseHash,
    });

    // Note: gateway restarts after config.patch. Don't wait for reconnect here —
    // the frontend should poll /models/status to detect when the switch is complete.

    res.json({
      success: true,
      previousModel,
      newModel: model,
      message: `Switched primary model from ${previousModel} to ${model}`,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('❌ Failed to switch model:', errMsg);
    res.status(500).json({ success: false, error: `Failed to switch model: ${errMsg}` });
  }
});

/**
 * GET /models/available - Live resolved model catalog.
 *
 * Aggregates model ids reachable to the backend (LiteLLM /v1/models, the
 * OpenClaw configured default/fallbacks + provider models, and a static floor of
 * hermes codex + anthropic ids), cached with a ~10min TTL. Feeds the model
 * selector and the doctor's model-pin validation so pins are checked against the
 * LIVE catalog instead of a stale hardcoded list.
 *
 * `?refresh=1` forces a re-resolution (bypasses the TTL cache).
 */
router.get('/available', async (req: Request, res: Response) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const catalog = await getModelCatalog(force);
    res.json({
      success: true,
      models: catalog.ids.map((id) => ({ id, normalized: normalizeModelId(id) })),
      ids: catalog.ids,
      count: catalog.ids.length,
      sources: catalog.sources,
      resolvedAt: new Date(catalog.resolvedAt).toISOString(),
      ttlMs: 10 * 60_000,
    });
  } catch (err) {
    console.error('❌ Failed to resolve model catalog:', err);
    res.status(500).json({ success: false, error: 'Failed to resolve model catalog' });
  }
});

export default router;

/**
 * GET /models/session-tools/:sessionId - Get recent tool calls from a session transcript
 */
router.get('/session-tools/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 20);
    const transcriptPath = process.env.OPENCLAW_TRANSCRIPTS_DIR || process.env.CLAWDBOT_TRANSCRIPTS_DIR || '/clawdbot/sessions';
    const filePath = require('path').join(transcriptPath, `${sessionId}.jsonl`);
    
    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
      res.json({ success: true, tools: [] });
      return;
    }

    // Read last portion of file (tool calls are at the end)
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    
    // Parse from the end, looking for tool calls
    const tools: any[] = [];
    const toolResults = new Map<string, string>();
    
    // First pass: collect tool results
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 100); i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const msg = entry.message || {};
        if (msg.role === 'toolResult' && msg.toolCallId) {
          const content = msg.content;
          let text = '';
          if (typeof content === 'string') text = content;
          else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') text += block.text || '';
            }
          }
          toolResults.set(msg.toolCallId, text.substring(0, 500));
        }
      } catch {}
    }
    
    // Second pass: collect tool calls
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 100); i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const msg = entry.message || {};
        if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
        
        for (const block of msg.content) {
          if (block.type !== 'toolCall') continue;
          
          let inputPreview = '';
          const args = block.arguments || block.input || '';
          if (typeof args === 'string') {
            // Parse the string representation
            try {
              const parsed = JSON.parse(args.replace(/'/g, '"'));
              if (parsed.command) inputPreview = `$ ${parsed.command}`;
              else if (parsed.url || parsed.targetUrl) inputPreview = parsed.url || parsed.targetUrl;
              else if (parsed.file_path || parsed.path) inputPreview = parsed.file_path || parsed.path;
              else if (parsed.action) inputPreview = parsed.action;
              else inputPreview = JSON.stringify(parsed).substring(0, 200);
            } catch {
              inputPreview = args.substring(0, 200);
            }
          } else if (typeof args === 'object') {
            if (args.command) inputPreview = `$ ${args.command}`;
            else if (args.url || args.targetUrl) inputPreview = args.url || args.targetUrl;
            else if (args.file_path || args.path) inputPreview = args.file_path || args.path;
            else inputPreview = JSON.stringify(args).substring(0, 200);
          }
          
          tools.push({
            id: block.id,
            name: block.name,
            input: inputPreview.substring(0, 300),
            output: toolResults.get(block.id) || null,
            timestamp: entry.timestamp,
          });
          
          if (tools.length >= limit) break;
        }
        if (tools.length >= limit) break;
      } catch {}
    }
    
    res.json({ success: true, tools: tools.reverse() });
  } catch (err) {
    console.error('Failed to read session tools:', err);
    res.json({ success: true, tools: [] });
  }
});
