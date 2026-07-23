import { readFile } from 'fs/promises';

/**
 * Live model-catalog resolver.
 *
 * Aggregates the set of model ids that are actually reachable / configured for
 * the agent runtime, so downstream consumers (the /models/available endpoint and
 * the doctor's model-pin check) validate task model pins against the LIVE
 * catalog instead of a stale hardcoded list.
 *
 * Sources (all best-effort — a failure of any one source degrades gracefully to
 * the others, never throws to the caller):
 *   1. LiteLLM /v1/models          — the live provider catalog (baseUrl + apiKey
 *                                     read from the mounted OpenClaw config)
 *   2. OpenClaw configured models   — agents.defaults.model.{primary,fallbacks},
 *                                     agents.defaults.models keys, and
 *                                     models.providers.*.models entries
 *   3. Static floor                 — known hermes codex ids + anthropic ids that
 *                                     are always valid even if the live sources
 *                                     are briefly unreachable
 *
 * Results are cached with a ~10 minute TTL so we do NOT hit LiteLLM per request.
 */

const CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ||
  process.env.CLAWDBOT_CONFIG_PATH ||
  '/clawdbot/clawdbot.json';

/** Cache TTL — 10 minutes. Do not hit LiteLLM per request. */
export const MODEL_CATALOG_TTL_MS = 10 * 60_000;

/** Timeout for the LiteLLM /v1/models probe. */
const LITELLM_TIMEOUT_MS = 4_000;

/**
 * Provider prefixes stripped for equivalence comparison. Wadera's canonical
 * models `gpt-5.5`, `openai-codex/gpt-5.5` and `codex/gpt-5.5` must all
 * normalize to the same value.
 */
const STRIPPABLE_PREFIXES = [
  'litellm/',
  'anthropic/',
  'openai-codex/',
  'openai/',
  'codex-cli/',
  'codex/',
  'google/',
  'gemini/',
  'hermes/',
];

/**
 * Static floor of always-valid model ids. These are the known hermes codex ids
 * and anthropic ids that are valid regardless of live-source availability.
 * Kept intentionally small — the live sources supply the bulk of the catalog.
 */
export const STATIC_FLOOR_MODELS: string[] = [
  // Hermes codex ids (canonical + provider-prefixed forms)
  'gpt-5.5',
  'openai-codex/gpt-5.5',
  'codex/gpt-5.5',
  // Anthropic ids
  'claude-opus-4-8',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-3-5',
  'anthropic/claude-opus-4-8',
  'anthropic/claude-opus-4-6',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-haiku-3-5',
];

export interface ModelCatalog {
  /** All raw model ids collected across sources (deduped, insertion order). */
  ids: string[];
  /** Normalized set (provider prefixes stripped, lowercased) for comparison. */
  normalized: Set<string>;
  /** Which sources contributed, for diagnostics. */
  sources: {
    litellm: number;
    config: number;
    floor: number;
  };
  /** When this catalog was resolved (ms epoch). */
  resolvedAt: number;
}

/**
 * Normalize a model id for equivalence comparison: strip a single known
 * provider prefix (longest-match first so `openai-codex/` wins over `openai/`)
 * and lowercase. e.g. `openai-codex/gpt-5.5` -> `gpt-5.5`, `codex/gpt-5.5` ->
 * `gpt-5.5`, `litellm/gemini/gemini-3-flash-preview` -> `gemini/gemini-3-flash-preview`.
 *
 * Only the leading provider segment is stripped; nested provider paths inside a
 * LiteLLM route (e.g. `litellm/gemini/...`) keep their inner path so distinct
 * downstream models stay distinct.
 */
export function normalizeModelId(model: string): string {
  let id = String(model || '').trim().toLowerCase();
  if (!id) return '';
  // Longest prefix first to avoid `openai/` shadowing `openai-codex/`.
  const ordered = [...STRIPPABLE_PREFIXES].sort((a, b) => b.length - a.length);
  for (const prefix of ordered) {
    if (id.startsWith(prefix)) {
      id = id.slice(prefix.length);
      break;
    }
  }
  return id;
}

let cache: ModelCatalog | null = null;
let inflight: Promise<ModelCatalog> | null = null;

function readModelIdsFromConfig(config: any): string[] {
  const ids: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) ids.push(v.trim());
  };

  const agentDefaults = config?.agents?.defaults || {};
  const modelConfig = agentDefaults.model || {};
  push(modelConfig.primary);
  if (Array.isArray(modelConfig.fallbacks)) modelConfig.fallbacks.forEach(push);

  const modelsMap = agentDefaults.models || {};
  for (const key of Object.keys(modelsMap)) push(key);

  const providers = config?.models?.providers || {};
  for (const [providerName, providerConfig] of Object.entries(providers)) {
    const pConfig = providerConfig as any;
    if (Array.isArray(pConfig?.models)) {
      for (const m of pConfig.models) {
        const id = typeof m === 'string' ? m : m?.id;
        if (typeof id === 'string' && id.trim()) {
          const full = id.includes('/') ? id : `${providerName}/${id}`;
          push(full);
        }
      }
    }
  }
  return ids;
}

interface LiteLLMConn {
  baseUrl: string;
  apiKey: string;
}

function readLiteLLMConn(config: any): LiteLLMConn | null {
  const litellm = config?.models?.providers?.litellm;
  const baseUrl = litellm?.baseUrl || litellm?.base_url;
  const apiKey = litellm?.apiKey || litellm?.api_key;
  if (typeof baseUrl === 'string' && typeof apiKey === 'string' && baseUrl && apiKey) {
    return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
  }
  return null;
}

async function fetchLiteLLMModels(conn: LiteLLMConn): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LITELLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${conn.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${conn.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`⚠️ LiteLLM /models returned ${res.status}; skipping live catalog source`);
      return [];
    }
    const body: any = await res.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    const ids: string[] = [];
    for (const entry of data) {
      const id = typeof entry === 'string' ? entry : entry?.id;
      if (typeof id === 'string' && id.trim()) {
        const trimmed = id.trim();
        // LiteLLM ids are the raw provider routes; expose them both as-is and
        // under the `litellm/` prefix so config-style pins resolve too.
        ids.push(trimmed);
        if (!trimmed.startsWith('litellm/')) ids.push(`litellm/${trimmed}`);
      }
    }
    return ids;
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? 'timeout' : err?.message || String(err);
    console.warn(`⚠️ Could not reach LiteLLM /models (${msg}); using config + floor only`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCatalog(): Promise<ModelCatalog> {
  let config: any = null;
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.warn(`⚠️ Model catalog: could not read OpenClaw config (${err?.code || err?.message})`);
    }
  }

  const configIds = config ? readModelIdsFromConfig(config) : [];

  let litellmIds: string[] = [];
  const conn = config ? readLiteLLMConn(config) : null;
  if (conn) {
    litellmIds = await fetchLiteLLMModels(conn);
  }

  // Aggregate, dedupe preserving order: live LiteLLM, then config, then floor.
  const seen = new Set<string>();
  const ids: string[] = [];
  const add = (list: string[]) => {
    for (const id of list) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  };
  add(litellmIds);
  add(configIds);
  add(STATIC_FLOOR_MODELS);

  const normalized = new Set<string>();
  for (const id of ids) {
    const n = normalizeModelId(id);
    if (n) normalized.add(n);
  }

  return {
    ids,
    normalized,
    sources: {
      litellm: litellmIds.length,
      config: configIds.length,
      floor: STATIC_FLOOR_MODELS.length,
    },
    resolvedAt: Date.now(),
  };
}

/**
 * Return the resolved model catalog, using the cached copy while fresh
 * (~10 min TTL). Concurrent callers during a cold/expired window share a single
 * in-flight resolution so we never fan out multiple LiteLLM probes.
 *
 * @param force - bypass the cache and re-resolve (used by tests / manual refresh)
 */
export async function getModelCatalog(force = false): Promise<ModelCatalog> {
  const now = Date.now();
  if (!force && cache && now - cache.resolvedAt < MODEL_CATALOG_TTL_MS) {
    return cache;
  }
  if (!force && inflight) return inflight;

  const p = resolveCatalog()
    .then((catalog) => {
      cache = catalog;
      return catalog;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  if (!force) inflight = p;
  return p;
}

/** Test/maintenance hook: drop the cached catalog. */
export function clearModelCatalogCache(): void {
  cache = null;
  inflight = null;
}

/**
 * True if `pin` matches some entry in the catalog under normalization.
 * `gpt-5.5`, `openai-codex/gpt-5.5`, `codex/gpt-5.5` are all equivalent.
 */
export function isModelAvailable(pin: string, catalog: ModelCatalog): boolean {
  const n = normalizeModelId(pin);
  if (!n) return false;
  return catalog.normalized.has(n);
}
