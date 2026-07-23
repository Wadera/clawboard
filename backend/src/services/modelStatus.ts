import { readFile, stat } from 'fs/promises';
import { pool } from '../db/connection';
import { join, resolve } from 'path';
import { homedir } from 'os';
import chokidar, { FSWatcher } from 'chokidar';
import { WebSocketService } from './websocket';
import { findMainSessionEntry, resolveContextUsage, resolveSessionModel } from './openclawState';

export type AgentStatus = 'working' | 'idle' | 'unknown';

export interface SubagentInfo {
  key: string;
  label: string;
  model: string;
  modelAlias: string;
  totalTokens: number;
  status: AgentStatus;
  updatedAt: number;
}

export interface ModelStatusData {
  model: string;
  modelAlias: string;
  isOverride: boolean;
  defaultModel: string;
  agentStatus: AgentStatus;
  compactionCount: number | null;
  contextUsage: {
    used: number;
    max: number;
    percent: number;
  };
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  session: {
    key: string;
    ageMs: number;
    ageFormatted: string;
  };
  authProfile: {
    name: string;
    provider: string;
    isAutoSelected: boolean;
  } | null;
  subagents: SubagentInfo[];
  activeSubagentCount: number;
  usageStats: {
    session?: { percentLeft: number; timeLeft: string; label?: string; resetAt?: string | number };
    weekly?: { percentLeft: number; timeLeft: string; label?: string; resetAt?: string | number };
    updatedAt: string;
    checkedAt: string;
    dataAge: number;
    stale: boolean;
    source?: string;
    provider?: string;
    plan?: string | null;
    failureClass?: string | null;
    statusReason?: string;
  } | null;
  openclawVersion: string | null;
  updatedAt: string;
}

// Model alias mapping - human-readable short names for sidebar display
const MODEL_ALIASES: Record<string, string> = {
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-5': 'Opus 4.5',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-haiku-3-5': 'Haiku 3.5',
  'claude-3-opus': 'Opus 3',
  'claude-3-sonnet': 'Sonnet 3',
  'claude-3-haiku': 'Haiku 3',
  'gpt-5.5': 'gpt-5.5',
  'gpt-5.4': 'gpt-5.4',
  'gpt-4o': 'GPT-4o',
  'gpt-4-turbo': 'GPT-4 Turbo',
  'gemini-2.0-flash': 'Gemini Flash',
  'gemini-2.5-pro': 'Gemini Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-3-flash-preview': 'Gemini 3 Flash',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
};

function getAlias(model: string): string {
  // Check exact match
  if (MODEL_ALIASES[model]) return MODEL_ALIASES[model];
  // Check partial match
  for (const [key, alias] of Object.entries(MODEL_ALIASES)) {
    if (model.includes(key)) return alias;
  }
  // Shorten the model name
  return model
    .replace('litellm/', '')
    .replace('anthropic/', '')
    .replace('openai/', '')
    .replace('google/', '');
}

function normalizeModelName(model: string): string {
  // Remove common provider prefixes for comparison
  return model
    .replace('anthropic/', '')
    .replace('openai/', '')
    .replace('openai-codex/', '')
    .replace('codex-cli/', '')
    .replace('google/', '')
    .replace('gemini/', '')
    .replace('litellm/', '')
    .toLowerCase();
}

function formatAge(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/** Threshold in ms — if updatedAt is within this window, consider the agent "working" */
const WORKING_RECENCY_MS = 30_000;

/** Subagent is considered "active" if updated within this window */
const SUBAGENT_ACTIVE_MS = 5 * 60_000;

/**
 * Determine if a session is actively working.
 * Strategy:
 * 1. Check if a .jsonl.lock file exists for the session's transcript (indicates active write)
 * 2. Check if the transcript .jsonl file was modified very recently (< 15s)
 * 3. Check if updatedAt in sessions.json is within WORKING_RECENCY_MS
 */
async function detectWorkingStatus(
  sessionId: string,
  updatedAt: number,
  transcriptsDir: string
): Promise<AgentStatus> {
  const now = Date.now();

  // Method 1: Check for .jsonl.lock file (most reliable — indicates OpenClaw is actively writing)
  try {
    const lockPath = join(transcriptsDir, `${sessionId}.jsonl.lock`);
    const lockStat = await stat(lockPath);
    // Lock file exists — check if it's recent (within 2 minutes)
    const lockAgeMs = now - lockStat.mtimeMs;
    if (lockAgeMs < 120_000) {
      return 'working';
    }
  } catch {
    // Lock file doesn't exist — not necessarily idle, check other methods
  }

  // Method 2: Check transcript file mtime (actively being written to)
  try {
    const transcriptPath = join(transcriptsDir, `${sessionId}.jsonl`);
    const transcriptStat = await stat(transcriptPath);
    const transcriptAgeMs = now - transcriptStat.mtimeMs;
    if (transcriptAgeMs < 15_000) {
      return 'working';
    }
  } catch {
    // Transcript doesn't exist yet
  }

  // Method 3: Check updatedAt from sessions.json
  if (updatedAt > 0) {
    const recency = now - updatedAt;
    if (recency < WORKING_RECENCY_MS) {
      return 'working';
    }
  }

  return 'idle';
}

/**
 * Reads Clawdbot session data to provide model + context usage info.
 * Watches sessions.json with chokidar for real-time updates,
 * with a fallback polling interval.
 */
export class ModelStatusService {
  private sessionsPath: string;
  private transcriptsDir: string;
  private usageStatsPath: string;
  private configPath: string;
  private wsService: WebSocketService;
  private fallbackInterval: NodeJS.Timeout | null = null;
  private fileWatcher: FSWatcher | null = null;
  private notificationWatcher: FSWatcher | null = null;
  private lastStatus: ModelStatusData | null = null;
  private defaultModel: string | null = null;
  private openclawVersion: string | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private notificationDebounceTimer: NodeJS.Timeout | null = null;
  private configDirty = false;
  private configMtimeMs: number | null = null;

  constructor(sessionsPath: string, configPath: string, wsService: WebSocketService) {
    this.sessionsPath = sessionsPath;
    // Derive transcripts dir from sessions path (same directory)
    this.transcriptsDir = join(sessionsPath, '..');
    this.usageStatsPath = resolve(process.env.USAGE_STATS_PATH || join(this.transcriptsDir, 'usage-stats.json'));
    this.configPath = configPath;
    this.wsService = wsService;
  }

  public async start() {
    console.log('📊 Starting model status service (file watcher + 10s fallback)');
    // Load default model from config
    await this.loadDefaultModel();
    // Load OpenClaw version from version.json (same dir as sessions)
    await this.loadOpenClawVersion();

    // Set up chokidar file watcher on sessions.json + usage-stats.json for real-time updates
    try {
      // Verify file is readable before watching (avoids chokidar crash on EACCES)
      await readFile(this.sessionsPath, 'utf-8');

      this.fileWatcher = chokidar.watch([this.sessionsPath, this.usageStatsPath, this.configPath], {
        persistent: true,
        usePolling: true,        // NFS/Docker mounts need polling
        interval: 2000,          // Poll every 2s for file changes
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 200,
        },
      });

      // Config changes invalidate the cached default model. Compare resolved
      // paths — chokidar may report a normalized/realpath'd path that is not
      // strictly equal to the configured one. Handle add/unlink too so a
      // replace-style write (unlink + add) is not missed.
      // NOTE: the OpenClaw config is exposed through the /clawdbot-home
      // DIRECTORY mount (docker-compose.{dev,prod}.yml), so host rename-writes
      // are visible in-container. It used to be a single-file bind mount that
      // stayed pinned to the pre-rename inode (stale config until container
      // recreate, observed 2026-07-03). The mtime fallback in
      // updateAndBroadcast still covers any watcher-missed change.
      const resolvedConfigPath = resolve(this.configPath);
      const onWatchedPathEvent = (changedPath: string) => {
        if (changedPath && resolve(changedPath) === resolvedConfigPath) this.configDirty = true;
        // Debounce rapid changes (sessions/usage files can update multiple times quickly)
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.updateAndBroadcast(), 500);
      };

      this.fileWatcher.on('change', onWatchedPathEvent);
      this.fileWatcher.on('add', onWatchedPathEvent);
      this.fileWatcher.on('unlink', onWatchedPathEvent);

      // Handle chokidar errors gracefully
      this.fileWatcher.on('error', (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('⚠️ File watcher error (will use polling):', msg);
      });

      console.log('📊 File watcher active on sessions.json, usage-stats.json and OpenClaw config');
    } catch (err: any) {
      if (err.code === 'EACCES') {
        console.warn('⚠️ Cannot read sessions file (EACCES). Set PUID/PGID to match host file owner.');
      } else {
        console.warn(`⚠️ Could not start file watcher (${err.code || err.message}). Using polling only.`);
      }
    }

    // Set up file watcher for task-notifications.json
    try {
      const notificationsPath = join(this.transcriptsDir, 'task-notifications.json');
      this.notificationWatcher = chokidar.watch(notificationsPath, {
        persistent: true,
        usePolling: true,
        interval: 2000,
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 200,
        },
      });

      this.notificationWatcher.on('change', () => {
        // Debounce rapid changes
        if (this.notificationDebounceTimer) clearTimeout(this.notificationDebounceTimer);
        this.notificationDebounceTimer = setTimeout(() => this.broadcastNotificationUpdate(), 500);
      });

      console.log('📊 File watcher active on task-notifications.json');
    } catch (err) {
      console.warn('⚠️ Could not start notification file watcher:', err);
    }

    // Fallback poll every 10s (in case file watcher misses events on NFS/Docker)
    this.fallbackInterval = setInterval(() => this.updateAndBroadcast(), 10_000);

    // Initial fetch
    this.updateAndBroadcast();
  }

  private async loadDefaultModel() {
    // First try to read preferred default from dashboard DB
    try {
      const result = await pool.query(
        "SELECT value FROM user_preferences WHERE key = 'preferred_default_model'"
      );
      if (result.rows.length > 0 && result.rows[0].value) {
        this.defaultModel = result.rows[0].value;
        console.log(`📊 Default model (from DB): ${this.defaultModel}`);
        return;
      }
    } catch {
      // Table might not exist yet, fall through to config
    }

    // Fall back to config primary (but this changes when model is switched!)
    try {
      const data = await readFile(this.configPath, 'utf-8');
      const config = JSON.parse(data);
      this.defaultModel = config?.agents?.defaults?.model?.primary || null;
      if (this.defaultModel) {
        console.log(`📊 Default model (from config fallback): ${this.defaultModel}`);
      }
    } catch (err: any) {
      if (err.code === 'EACCES') {
        console.warn('⚠️ Cannot read OpenClaw config (EACCES). Model info will be limited.');
        console.warn('   Fix: Set PUID/PGID in docker-compose to match host file owner.');
      } else if (err.code === 'ENOENT') {
        console.warn('⚠️ OpenClaw config not found. Model info will show from session data only.');
      } else {
        console.warn('⚠️ Could not read default model:', err.message || err);
      }
      // Gracefully continue — model info will come from session data instead
    }
  }

  private async loadOpenClawVersion() {
    try {
      const versionPath = join(this.sessionsPath, '..', 'version.json');
      const data = await readFile(versionPath, 'utf-8');
      const versionData = JSON.parse(data);
      this.openclawVersion = versionData?.openclaw || null;
      if (this.openclawVersion) {
        console.log(`📊 OpenClaw version: ${this.openclawVersion}`);
      }
    } catch {
      console.warn('⚠️ Could not read OpenClaw version from version.json');
    }
  }

  private async readUsageStats(): Promise<ModelStatusData['usageStats']> {
    try {
      const data = await readFile(this.usageStatsPath, 'utf-8');
      const usage = JSON.parse(data);
      const updatedAt = usage?.updatedAt || '';
      const checkedAt = usage?.checkedAt || updatedAt;
      const dataAge = usage?.dataAge || 0;
      const freshnessAnchor = checkedAt || updatedAt;
      const statusReason = typeof usage?.statusReason === 'string' ? usage.statusReason : '';
      const failureClass = typeof usage?.failureClass === 'string' ? usage.failureClass : null;
      // Consider the widget stale when either the refresh pipeline itself has
      // stopped checking in OR the underlying provider snapshot is old. The
      // previous behaviour only looked at checkedAt, so the cron job could keep
      // touching a days-old failed snapshot and the sidebar showed it as live.
      const checkStale = freshnessAnchor
        ? (Date.now() - new Date(freshnessAnchor).getTime()) > 1200000
        : true;
      const dataStale = dataAge > 1200000;
      const failedRefresh = Boolean(failureClass) || /failed|preserving previous snapshot/i.test(statusReason);
      const stale = checkStale || dataStale || failedRefresh;
      return {
        session: usage?.session,
        weekly: usage?.weekly,
        updatedAt,
        checkedAt,
        dataAge,
        stale,
        source: usage?.source,
        provider: usage?.provider,
        plan: usage?.plan,
        failureClass,
        statusReason,
      };
    } catch {
      return null;
    }
  }

  public stop() {
    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
    }
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    if (this.notificationWatcher) {
      this.notificationWatcher.close();
      this.notificationWatcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.notificationDebounceTimer) {
      clearTimeout(this.notificationDebounceTimer);
      this.notificationDebounceTimer = null;
    }
  }

  public async getStatus(): Promise<ModelStatusData | null> {
    return this.lastStatus || (await this.fetchStatus());
  }

  /**
   * Watcher-independent config freshness check: compares the config file's
   * mtime against the last observed value. Catches config rewrites even when
   * chokidar misses the event (every updateAndBroadcast runs on the 10s
   * fallback poll regardless of watcher health).
   */
  private async configFileChanged(): Promise<boolean> {
    try {
      const configStat = await stat(this.configPath);
      const changed = this.configMtimeMs !== null && configStat.mtimeMs !== this.configMtimeMs;
      this.configMtimeMs = configStat.mtimeMs;
      return changed;
    } catch {
      return false;
    }
  }

  private async updateAndBroadcast() {
    const configChanged = await this.configFileChanged();
    if (this.configDirty || configChanged) {
      this.configDirty = false;
      await this.loadDefaultModel();
    }
    const status = await this.fetchStatus();
    if (!status) return;

    // Only broadcast if changed
    const changed = JSON.stringify(status) !== JSON.stringify(this.lastStatus);
    this.lastStatus = status;

    if (changed) {
      this.wsService.broadcast({
        type: 'model:status',
        data: status,
      });
    }
  }

  private async broadcastNotificationUpdate() {
    try {
      const notificationsPath = join(this.transcriptsDir, 'task-notifications.json');
      const data = await readFile(notificationsPath, 'utf-8');
      const notificationData = JSON.parse(data);
      
      // Broadcast notification update via WebSocket
      this.wsService.broadcast({
        type: 'task:notification',
        data: notificationData,
      });
      
      console.log('📊 Broadcast task notification update');
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error('❌ Failed to read task notifications:', err.message);
      }
      // ENOENT is fine - file doesn't exist yet
    }
  }

  private async readAuthProfiles(): Promise<any | null> {
    // Env overrides first, then the /clawdbot-home directory mount (compose
    // sets AUTH_PROFILES_PATH to this), then the legacy single-file bind
    // location (kept for not-yet-recreated containers), then host path.
    const candidates = [
      process.env.OPENCLAW_AUTH_PROFILES_PATH,
      process.env.AUTH_PROFILES_PATH,
      '/clawdbot-home/agents/main/agent/auth-profiles.json',
      '/clawdbot/auth-profiles.json',
      join(homedir(), '.openclaw/agents/main/agent/auth-profiles.json'),
    ].filter((p): p is string => Boolean(p));

    for (const authPath of candidates) {
      try {
        const data = await readFile(authPath, 'utf-8');
        return JSON.parse(data);
      } catch {
        // Try next candidate
      }
    }
    return null;
  }

  private async readAuthProfile(session: any): Promise<ModelStatusData['authProfile']> {
    try {
      const authData = await this.readAuthProfiles();
      if (!authData) return null;

      // Use session's authProfileOverride if available, else lastGood
      const profileKey = session.authProfileOverride
        || authData?.lastGood?.anthropic
        || null;

      if (!profileKey) return null;

      // Parse profile key like "anthropic:user-claude-max"
      const parts = profileKey.split(':');
      const provider = parts[0] || 'unknown';
      const name = parts.slice(1).join(':') || profileKey;
      const isAutoSelected = session.authProfileOverrideSource === 'auto' || !session.authProfileOverride;

      return { name, provider, isAutoSelected };
    } catch {
      return null;
    }
  }

  /**
   * Extract a human-readable label from a session key.
   * e.g. "agent:main:subagent:6137e27b-..." → "subagent-6137e"
   */
  private getSubagentLabel(key: string): string {
    const match = key.match(/subagent:([a-f0-9-]+)/);
    if (match) {
      return `subagent-${match[1].substring(0, 5)}`;
    }
    return key.split(':').pop()?.substring(0, 8) || 'unknown';
  }

  private async fetchStatus(): Promise<ModelStatusData | null> {
    try {
      const data = await readFile(this.sessionsPath, 'utf-8');
      const sessions: Record<string, any> = JSON.parse(data);

      // Find main session — OpenClaw 2026.6.11+ uses agent:<id>:explicit:main
      // (the legacy agent:<id>:main entry is frozen after the upgrade)
      const mainEntry = findMainSessionEntry(sessions);

      if (!mainEntry) return null;
      const { key } = mainEntry;
      const session: any = mainEntry.session;

      // Use session model if set, otherwise fall back to default from config
      const model = resolveSessionModel(session) || this.defaultModel || 'unknown';
      const totalTokens = session.totalTokens || 0;
      const compactionCount = Number.isFinite(session.compactionCount)
        ? Number(session.compactionCount)
        : null;
      const inputTokens = session.inputTokens || 0;
      const outputTokens = session.outputTokens || 0;
      const sessionUpdatedAt = session.updatedAt || 0;
      const ageMs = sessionUpdatedAt ? Date.now() - sessionUpdatedAt : 0;

      // Detect working status for main session
      const agentStatus = await detectWorkingStatus(
        session.sessionId,
        sessionUpdatedAt,
        this.transcriptsDir
      );

      // Context usage: prefer the 2026.6.11+ contextBudgetStatus snapshot
      // (actual window fill); fall back to the legacy cumulative estimate.
      const contextUsage = resolveContextUsage(session);

      // Check if current model is different from default (override)
      const normalizedCurrent = normalizeModelName(model);
      const normalizedDefault = this.defaultModel ? normalizeModelName(this.defaultModel) : null;
      const isOverride = normalizedDefault !== null && normalizedCurrent !== normalizedDefault;
      const defaultModel = this.defaultModel || 'unknown';

      // Read auth profile info
      const authProfile = await this.readAuthProfile(session);

      // Collect subagent info
      const now = Date.now();
      const subagents: SubagentInfo[] = [];

      for (const [sKey, sSession] of Object.entries(sessions) as [string, any][]) {
        if (!sKey.includes('subagent')) continue;

        const sUpdatedAt = sSession.updatedAt || 0;
        const sAgeMs = now - sUpdatedAt;

        // Only include subagents active within the last 5 minutes
        if (sAgeMs > SUBAGENT_ACTIVE_MS) continue;

        const sModel = sSession.model || 'unknown';
        const sStatus = await detectWorkingStatus(
          sSession.sessionId,
          sUpdatedAt,
          this.transcriptsDir
        );

        subagents.push({
          key: sKey,
          label: this.getSubagentLabel(sKey),
          model: sModel,
          modelAlias: getAlias(sModel),
          totalTokens: sSession.totalTokens || 0,
          status: sStatus,
          updatedAt: sUpdatedAt,
        });
      }

      // Sort subagents by most recently updated
      subagents.sort((a, b) => b.updatedAt - a.updatedAt);

      const activeSubagentCount = subagents.filter(s => s.status === 'working').length;

      // Read usage stats
      const usageStats = await this.readUsageStats();

      return {
        model,
        modelAlias: getAlias(model),
        isOverride,
        defaultModel,
        agentStatus,
        compactionCount,
        contextUsage,
        tokens: {
          input: inputTokens,
          output: outputTokens,
          total: totalTokens,
        },
        session: {
          key,
          ageMs,
          ageFormatted: formatAge(ageMs),
        },
        authProfile,
        subagents,
        activeSubagentCount,
        usageStats,
        openclawVersion: this.openclawVersion,
        updatedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      if (err.code === 'EACCES') {
        console.warn('⚠️ Cannot read sessions file (EACCES). Set PUID/PGID to match host file owner.');
      } else {
        console.error('❌ Failed to read model status:', err.message || err);
      }
      return null;
    }
  }
}
