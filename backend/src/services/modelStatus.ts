import { readFile, stat } from 'fs/promises';
import { pool } from '../db/connection';
import { join } from 'path';
import { homedir } from 'os';
import chokidar, { FSWatcher } from 'chokidar';
import { WebSocketService } from './websocket';

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
    session: { percentLeft: number; timeLeft: string };
    weekly: { percentLeft: number; timeLeft: string };
    updatedAt: string;
    checkedAt: string;
    dataAge: number;
    stale: boolean;
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
  'gpt-4o': 'GPT-4o',
  'gpt-4-turbo': 'GPT-4 Turbo',
  'gemini-2.0-flash': 'Gemini Flash',
  'gemini-2.5-pro': 'Gemini Pro',
};

function getAlias(model: string): string {
  // Check exact match
  if (MODEL_ALIASES[model]) return MODEL_ALIASES[model];
  // Check partial match
  for (const [key, alias] of Object.entries(MODEL_ALIASES)) {
    if (model.includes(key)) return alias;
  }
  // Shorten the model name
  return model.replace('anthropic/', '').replace('openai/', '').replace('google/', '');
}

function normalizeModelName(model: string): string {
  // Remove provider prefix for comparison
  return model.replace('anthropic/', '').replace('openai/', '').replace('google/', '').toLowerCase();
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

  constructor(sessionsPath: string, configPath: string, wsService: WebSocketService) {
    this.sessionsPath = sessionsPath;
    // Derive transcripts dir from sessions path (same directory)
    this.transcriptsDir = join(sessionsPath, '..');
    this.configPath = configPath;
    this.wsService = wsService;
  }

  public async start() {
    console.log('📊 Starting model status service (file watcher + 10s fallback)');
    // Load default model from config
    await this.loadDefaultModel();
    // Load OpenClaw version from version.json (same dir as sessions)
    await this.loadOpenClawVersion();

    // Set up chokidar file watcher on sessions.json for real-time updates
    try {
      this.fileWatcher = chokidar.watch(this.sessionsPath, {
        persistent: true,
        usePolling: true,        // NFS/Docker mounts need polling
        interval: 2000,          // Poll every 2s for file changes
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 200,
        },
      });

      this.fileWatcher.on('change', () => {
        // Debounce rapid changes (sessions.json can update multiple times quickly)
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.updateAndBroadcast(), 500);
      });

      console.log('📊 File watcher active on sessions.json');
    } catch (err) {
      console.warn('⚠️ Could not start file watcher, using polling only:', err);
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
    } catch (err) {
      console.warn('⚠️ Could not read default model:', err);
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
      const usagePath = join(this.sessionsPath, '..', 'usage-stats.json');
      const data = await readFile(usagePath, 'utf-8');
      const usage = JSON.parse(data);
      const updatedAt = usage?.updatedAt || '';
      const checkedAt = usage?.checkedAt || updatedAt;
      const dataAge = usage?.dataAge || 0;
      // Consider stale if older than 20 minutes (heartbeats refresh every ~15 min)
      const stale = updatedAt
        ? (Date.now() - new Date(updatedAt).getTime()) > 1200000
        : true;
      return {
        session: usage?.session || { percentLeft: 0, timeLeft: 'unknown' },
        weekly: usage?.weekly || { percentLeft: 0, timeLeft: 'unknown' },
        updatedAt,
        checkedAt,
        dataAge,
        stale,
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

  private async updateAndBroadcast() {
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

  private async readAuthProfile(session: any): Promise<ModelStatusData['authProfile']> {
    try {
      const authPath = join(homedir(), '.openclaw/agents/main/agent/auth-profiles.json');
      const data = await readFile(authPath, 'utf-8');
      const authData = JSON.parse(data);

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

      // Find main session
      const mainEntry = Object.entries(sessions).find(
        ([key]) => key.includes('main:main') && !key.includes('subagent')
      );

      if (!mainEntry) return null;
      const [key, session] = mainEntry;

      // Use session model if set, otherwise fall back to default from config
      const model = session.model || this.defaultModel || 'unknown';
      const totalTokens = session.totalTokens || 0;
      const contextTokens = session.contextTokens || 200000;
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

      // Context usage: totalTokens is cumulative across the entire session,
      // NOT the current context window fill. We don't have real-time context
      // window usage from session data. Show totalTokens vs contextTokens but
      // cap meaningfully — if totalTokens exceeds contextTokens (due to
      // compaction/resets), the actual window usage is lower.
      // Use modulo to estimate post-compaction usage when totalTokens > max
      const estimatedContextUsed = totalTokens > contextTokens
        ? totalTokens % contextTokens || contextTokens  // After compaction, estimate remainder
        : totalTokens;
      const contextPercent = contextTokens > 0
        ? Math.min(Math.round((estimatedContextUsed / contextTokens) * 100), 100)
        : 0;

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
        contextUsage: {
          used: estimatedContextUsed,
          max: contextTokens,
          percent: contextPercent,
        },
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
    } catch (err) {
      console.error('❌ Failed to read model status:', err);
      return null;
    }
  }
}
