import express from 'express';
import type { Request, Response } from 'express';
import { readFile } from 'fs/promises';
import type { GatewayConnector } from '../services/GatewayConnector';
import { pool } from '../db/connection';

const router = express.Router();

let gatewayConnector: GatewayConnector | null = null;

export function setModelsGatewayConnector(connector: GatewayConnector): void {
  gatewayConnector = connector;
}

const CLAWDBOT_CONFIG = process.env.CLAWDBOT_CONFIG_PATH || '/clawdbot/clawdbot.json';
const AUTH_PROFILES_PATH = process.env.AUTH_PROFILES_PATH || '/clawdbot/auth-profiles.json';

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
    const [config, authData] = await Promise.all([
      readJsonFile(CLAWDBOT_CONFIG),
      readJsonFile(AUTH_PROFILES_PATH).catch(() => null),
    ]);

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

    // Get session context from gateway (main session)
    let sessionContext = { totalTokens: 0, contextTokens: 200000, used: 0, percent: 0 };
    let sessionAge = 'unknown';
    if (gatewayConnector) {
      const snapshot = gatewayConnector.getQueueSnapshot();
      const mainSession = snapshot.sessions?.find(
        (s: any) => s.sessionKey === 'agent:main:main' || s.sessionKey?.includes(':main:main')
      );
      if (mainSession) {
        const usage = mainSession.tokenUsage || { total: 0, context: 200000, percentUsed: 0 };
        sessionContext = {
          totalTokens: usage.total,
          contextTokens: usage.context,
          used: usage.total,
          percent: usage.percentUsed,
        };
        if (mainSession.lastActivity) {
          const ageSecs = Math.floor((Date.now() - mainSession.lastActivity) / 1000);
          if (ageSecs < 60) sessionAge = `${ageSecs}s`;
          else if (ageSecs < 3600) sessionAge = `${Math.floor(ageSecs / 60)}m`;
          else sessionAge = `${Math.floor(ageSecs / 3600)}h`;
        }
      }
    }

    // Get preferred default model from DB (sourced from user preference, not hardcoded)
    const defaultModel = await getPreferredDefault(primaryModel);
    const isOverride = primaryModel !== defaultModel;

    res.json({
      success: true,
      // Model info
      activeModel: primaryModel,
      modelAlias: shortModelName(primaryModel),
      defaultModel,
      defaultModelAlias: shortModelName(defaultModel),
      isOverride,
      activeProfile: lastGoodProfile,
      // Session context (for sidebar badge)
      contextUsage: sessionContext,
      session: { ageFormatted: sessionAge },
      // Auth profiles
      profiles,
      // Model lists
      models: { primary: primaryModel, fallbacks, available },
      authOrder,
    });
  } catch (err) {
    console.error('❌ Failed to read models status:', err);
    res.status(500).json({ success: false, error: 'Failed to read models status' });
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

export default router;

/**
 * GET /models/session-tools/:sessionId - Get recent tool calls from a session transcript
 */
router.get('/session-tools/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 20);
    const transcriptPath = process.env.CLAWDBOT_TRANSCRIPTS_DIR || '/clawdbot/sessions';
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
