import express from 'express';
import type { Request, Response } from 'express';
import { readFile } from 'fs/promises';

const router = express.Router();

interface ModelInfo {
  name: string;
  provider: string;
  available: boolean;
  isDefault: boolean;
  isFallback: boolean;
  isActive: boolean;
  rateLimited: boolean;
  alias?: string;
}

interface RateLimitStatus {
  models: ModelInfo[];
  defaultModel: string;
  fallbacks: string[];
  aliases: Record<string, string>;
  activeModel: string;
  fallbackActive: boolean;
  statusAvailable: boolean;
  cachedAt: string;
}

let cachedResult: RateLimitStatus | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000;

const CLAWDBOT_CONFIG = process.env.OPENCLAW_CONFIG_PATH || '/clawdbot/clawdbot.json';
const MODELS_CONFIG = process.env.OPENCLAW_MODELS_PATH || '/clawdbot/models.json';

async function readJsonFile(path: string): Promise<any> {
  const data = await readFile(path, 'utf-8');
  return JSON.parse(data);
}

async function fetchRateLimitStatus(): Promise<RateLimitStatus> {
  try {
    const config = await readJsonFile(CLAWDBOT_CONFIG);
    
    // Extract model configuration from agents.defaults
    const agentDefaults = config.agents?.defaults || {};
    const modelConfig = agentDefaults.model || {};
    const modelsMap = agentDefaults.models || {};
    const defaultModel = modelConfig.primary || '';
    const fallbacks: string[] = modelConfig.fallbacks || [];
    
    // Build aliases from per-model config
    const aliases: Record<string, string> = {};
    for (const [modelId, mConf] of Object.entries(modelsMap)) {
      const mc = mConf as any;
      if (mc.alias) {
        aliases[modelId] = mc.alias;
      }
    }
    
    // Collect models from agent defaults first
    const allModels: string[] = [];
    for (const modelId of Object.keys(modelsMap)) {
      if (!allModels.includes(modelId)) allModels.push(modelId);
    }
    
    // Also collect from providers
    const providers = config.models?.providers || {};
    for (const [, providerConfig] of Object.entries(providers)) {
      const pConfig = providerConfig as any;
      if (pConfig.models && Array.isArray(pConfig.models)) {
        for (const m of pConfig.models) {
          if (typeof m === 'string') {
            allModels.push(m);
          } else if (m.id) {
            allModels.push(m.id);
          }
        }
      }
    }
    
    // Also try reading models.json for additional provider models
    try {
      const modelsJson = await readJsonFile(MODELS_CONFIG);
      const mProviders = modelsJson.providers || {};
      for (const [, pConfig] of Object.entries(mProviders)) {
        const pc = pConfig as any;
        if (pc.models && Array.isArray(pc.models)) {
          for (const m of pc.models) {
            const id = typeof m === 'string' ? m : m.id;
            if (id && !allModels.includes(id)) {
              allModels.push(id);
            }
          }
        }
      }
    } catch {
      // models.json may not exist
    }
    
    // If we didn't find models from config, try to infer from default/fallbacks
    if (allModels.length === 0) {
      if (defaultModel) allModels.push(defaultModel);
      allModels.push(...fallbacks.filter(f => !allModels.includes(f)));
    }
    
    // Deduplicate
    const uniqueModels = [...new Set(allModels)];
    
    const models: ModelInfo[] = uniqueModels.map(name => {
      const provider = name.split('/')[0] || 'unknown';
      return {
        name,
        provider,
        available: true,
        isDefault: name === defaultModel,
        isFallback: fallbacks.includes(name),
        isActive: name === defaultModel,
        rateLimited: false,
        alias: aliases[name],
      };
    });
    
    return {
      models,
      defaultModel,
      fallbacks,
      aliases,
      activeModel: defaultModel,
      fallbackActive: false,
      statusAvailable: true,
      cachedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('❌ Failed to read rate limit status:', err);
    return {
      models: [],
      defaultModel: '',
      fallbacks: [],
      aliases: {},
      activeModel: '',
      fallbackActive: false,
      statusAvailable: false,
      cachedAt: new Date().toISOString(),
    };
  }
}

/**
 * GET /rate-limits - Get model availability and rate limit status
 */
router.get('/', async (_req: Request, res: Response) => {
  const now = Date.now();
  
  if (cachedResult && (now - cacheTime) < CACHE_TTL_MS) {
    res.json({ success: true, ...cachedResult });
    return;
  }
  
  const result = await fetchRateLimitStatus();
  cachedResult = result;
  cacheTime = now;
  
  res.json({ success: true, ...result });
});

export default router;
