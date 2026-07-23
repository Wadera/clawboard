import fs from 'fs';
import path from 'path';
import { mkdir } from 'fs/promises';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import jwt from 'jsonwebtoken';

const execFileAsync = promisify(execFile);

export type HermesSource = 'cli' | 'discord' | 'telegram' | 'tool' | 'unknown';

export interface HermesSessionStateRow {
  id: string;
  source: string | null;
  user_id?: string | null;
  model?: string | null;
  title?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
  message_count?: number | null;
  tool_call_count?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_tokens?: number | null;
  estimated_cost_usd?: number | null;
  actual_cost_usd?: number | null;
  last_message_at?: number | null;
  session_key?: string | null;
  parent_session_id?: string | null;
  end_reason?: string | null;
}

export interface HermesMessageStateRow {
  id?: number | null;
  role: string;
  content: string | null;
  tool_call_id?: string | null;
  tool_calls?: string | null;
  tool_name?: string | null;
  timestamp: number;
  token_count?: number | null;
  finish_reason?: string | null;
}

export interface HermesParsedMessage {
  role: string;
  content: string;
  timestamp: string | null;
  toolName?: string;
  toolCallId?: string;
  usage?: {
    outputTokens?: number;
  };
}

export interface HermesTurnLaunchOptions {
  taskId: string;
  prompt: string;
  model?: string | null;
  resumeSessionId?: string | null;
  sourceTag?: string | null;
  cwd?: string | null;
  maxTurns?: number | null;
}

export interface HermesTurnLaunchResult {
  pid: number;
  sessionId: string | null;
  sessionKey: string;
  sourceTag: string;
  logPath: string;
  provisional: boolean;
  spawnedAtUnix: number;
}

export interface HermesSessionRuntimeState {
  sessionId: string | null;
  sessionKey: string | null;
  source: HermesSource;
  state: 'none' | 'starting' | 'running' | 'idle' | 'completed' | 'failed';
  pid: number | null;
  pidAlive: boolean;
  label: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string | null;
  row: HermesSessionStateRow | null;
  reason?: string | null;
}

const HERMES_BINARY_PATH = process.env.HERMES_BINARY_PATH || '/home/hermes/hermes-agent/venv/bin/hermes';
const HERMES_PROJECT_PATH = process.env.HERMES_PROJECT_PATH || '/home/hermes/hermes-agent';
const HERMES_HOME_PATH = process.env.HERMES_HOME_PATH || '/home/hermes';
const HERMES_STATE_DB_PATH = process.env.HERMES_STATE_DB_PATH || path.join(HERMES_HOME_PATH, '.hermes', 'state.db');
const HERMES_RUN_LOG_DIR = process.env.HERMES_RUN_LOG_DIR || '/data/hermes-task-runs';
const DEFAULT_HERMES_CWD = process.env.HERMES_TASK_CWD || '/workspace';
const DEFAULT_MAX_TURNS = Number(process.env.HERMES_TASK_MAX_TURNS || 90);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hermesStateAvailable(): boolean {
  return fs.existsSync(HERMES_STATE_DB_PATH);
}

/** State database written by ClawBoard-launched Hermes task sessions. */
export function getHermesTaskStateDbPath(): string {
  return HERMES_STATE_DB_PATH;
}

export function normalizeHermesSource(value: string | null | undefined): HermesSource {
  const source = String(value || '').trim().toLowerCase();
  if (!source) return 'unknown';
  if (source === 'cli') return 'cli';
  if (source === 'discord') return 'discord';
  if (source === 'telegram') return 'telegram';
  if (source === 'tool' || source.startsWith('tool-')) return 'tool';
  return 'unknown';
}

export function buildHermesSourceTag(taskId: string): string {
  return `tool-task-${taskId.slice(0, 8)}`;
}

export function hermesSessionKeyFor(row: Pick<HermesSessionStateRow, 'id' | 'source'>): string {
  const source = normalizeHermesSource(row.source);
  if (source === 'cli') return `agent:main:local:dm:${row.id}`;
  if (source === 'discord') return `agent:main:discord:channel:${row.id}`;
  if (source === 'telegram') return `agent:main:telegram:dm:${row.id}`;
  if (source === 'tool') return `hermes:tool:${row.id}`;
  return `hermes:${source}:${row.id}`;
}

export function extractHermesSessionId(key: string | null | undefined): string | null {
  if (!key) return null;
  if (/^\d{8}_\d{6}_[A-Za-z0-9]+$/.test(key)) return key;
  if (key.startsWith('agent:main:local:dm:')) return key.slice('agent:main:local:dm:'.length);
  if (key.startsWith('agent:main:discord:channel:')) return key.slice('agent:main:discord:channel:'.length);
  if (key.startsWith('agent:main:telegram:dm:')) return key.slice('agent:main:telegram:dm:'.length);
  if (key.startsWith('hermes:')) {
    const parts = key.split(':');
    return parts[parts.length - 1] || null;
  }
  return null;
}

export function hermesTimestampToIso(value: number | null | undefined): string | null {
  if (!value) return null;
  return new Date(value * 1000).toISOString();
}

export const HERMES_RECENT_ACTIVITY_WINDOW_SECONDS = 90;
export const HERMES_STARTUP_GRACE_SECONDS = 90;

export function inferHermesSessionState(
  row: (Pick<HermesSessionStateRow, 'started_at' | 'ended_at' | 'last_message_at'> & Partial<Pick<HermesSessionStateRow, 'message_count' | 'tool_call_count'>>) | null | undefined,
  options: { pidAlive?: boolean; nowSeconds?: number } = {},
): HermesSessionRuntimeState['state'] {
  if (!row) return options.pidAlive ? 'starting' : 'none';

  const pidAlive = options.pidAlive === true;
  const nowSeconds = options.nowSeconds ?? (Date.now() / 1000);
  const lastMessageAt = row.last_message_at || null;
  const startedAt = row.started_at || null;
  const recordedActivity = Math.max(0, Number(row.message_count || 0)) + Math.max(0, Number(row.tool_call_count || 0));

  if (row.ended_at) return 'completed';
  if (pidAlive) return 'running';
  if (recordedActivity > 0 && lastMessageAt && (nowSeconds - lastMessageAt) < HERMES_RECENT_ACTIVITY_WINDOW_SECONDS) return 'running';
  if (startedAt && (nowSeconds - startedAt) < HERMES_STARTUP_GRACE_SECONDS) return 'starting';
  return 'idle';
}

export function isHermesSessionLiveWork(state: HermesSessionRuntimeState['state']): boolean {
  return state === 'starting' || state === 'running';
}

function parseHermesToolCalls(raw: string | null | undefined): Array<{ toolCallId: string; toolName?: string; input: string }> {
  if (!raw) return [];

  try {
    const payload = JSON.parse(raw);
    if (!Array.isArray(payload)) return [];

    return payload.flatMap((entry: any) => {
      const functionCall = entry?.function;
      const toolName = typeof functionCall?.name === 'string'
        ? functionCall.name
        : (typeof entry?.name === 'string' ? entry.name : undefined);
      const toolCallId = typeof entry?.call_id === 'string'
        ? entry.call_id
        : (typeof entry?.id === 'string' ? entry.id : '');
      if (!toolCallId) return [];

      const args = functionCall?.arguments;
      const input = typeof args === 'string'
        ? args
        : (args == null ? '' : JSON.stringify(args));

      return [{ toolCallId, toolName, input }];
    });
  } catch {
    return [];
  }
}

export function parseHermesMessageRows(rows: HermesMessageStateRow[]): HermesParsedMessage[] {
  const messages: HermesParsedMessage[] = [];
  const toolNamesByCallId = new Map<string, string>();

  for (const row of rows) {
    const timestamp = hermesTimestampToIso(row.timestamp);

    if (row.role === 'assistant') {
      for (const toolCall of parseHermesToolCalls(row.tool_calls)) {
        if (toolCall.toolName) toolNamesByCallId.set(toolCall.toolCallId, toolCall.toolName);
        messages.push({
          role: 'assistant',
          content: `[Tool call: ${toolCall.toolName || 'unknown'}] ${toolCall.input}`,
          timestamp,
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
        });
      }

      const content = row.content || '';
      if (content.trim()) {
        messages.push({
          role: 'assistant',
          content,
          timestamp,
          ...(row.token_count ? { usage: { outputTokens: Number(row.token_count) || 0 } } : {}),
        });
      }
      continue;
    }

    if (row.role === 'tool') {
      const toolCallId = row.tool_call_id || undefined;
      const toolName = row.tool_name || (toolCallId ? toolNamesByCallId.get(toolCallId) : undefined);
      messages.push({
        role: 'tool',
        content: row.content || '',
        timestamp,
        toolName: toolName || undefined,
        toolCallId,
        ...(row.token_count ? { usage: { outputTokens: Number(row.token_count) || 0 } } : {}),
      });
      continue;
    }

    messages.push({
      role: row.role || 'assistant',
      content: row.content || '',
      timestamp,
      toolName: row.tool_name || undefined,
      toolCallId: row.tool_call_id || undefined,
      ...(row.token_count ? { usage: { outputTokens: Number(row.token_count) || 0 } } : {}),
    });
  }

  return messages;
}

function buildHermesEnv(extraEnv: Record<string, string> = {}, cwd?: string): NodeJS.ProcessEnv {
  const clawboardCliCandidates = [
    extraEnv.CLAWBOARD_CLI,
    process.env.CLAWBOARD_CLI,
    // Canonical: the deployed repo mount - promotions update it, agents can never
    // silently pick up the dirty shared workspace (task 7d77d4f1).
    '/deployed-repo/cli/clawboard',
    cwd ? path.join(cwd, 'cli', 'clawboard') : null,
    '/workspace/cli/clawboard',
  ].filter((value): value is string => Boolean(value));

  const resolvedClawboardCli = clawboardCliCandidates.find((candidate) => fs.existsSync(candidate))
    || clawboardCliCandidates[0]
    || '/deployed-repo/cli/clawboard';

  const jwtSecret = process.env.JWT_SECRET || 'fallback_secret_change_me';
  const resolvedClawboardToken = extraEnv.CLAWBOARD_TOKEN
    || process.env.CLAWBOARD_TOKEN
    || jwt.sign({ userId: 'hermes_task_agent' }, jwtSecret, { expiresIn: '7d' });
  const resolvedClawboardApiUrl = extraEnv.CLAWBOARD_API_URL
    || process.env.CLAWBOARD_API_URL
    || `http://127.0.0.1:${process.env.PORT || '3001'}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: HERMES_HOME_PATH,
    PYTHONUNBUFFERED: '1',
    NO_COLOR: '1',
    CLAWBOARD_CLI: resolvedClawboardCli,
    CLAWBOARD_API_URL: resolvedClawboardApiUrl,
    CLAWBOARD_TOKEN: resolvedClawboardToken,
    CLAWBOARD_AGENT: process.env.CLAWBOARD_AGENT || '1',
    ...extraEnv,
  };
  return env;
}

export async function ensureHermesRuntimeReady(): Promise<void> {
  if (!fs.existsSync(HERMES_BINARY_PATH)) {
    throw new Error(`Hermes binary not found at ${HERMES_BINARY_PATH}`);
  }

  if (!fs.existsSync(HERMES_HOME_PATH)) {
    throw new Error(`Hermes home path not found at ${HERMES_HOME_PATH}`);
  }

  const runtimeDotDir = path.join(HERMES_HOME_PATH, '.hermes');
  if (!fs.existsSync(runtimeDotDir)) {
    throw new Error(`Hermes runtime directory not found at ${runtimeDotDir}`);
  }

  await mkdir(HERMES_RUN_LOG_DIR, { recursive: true });
}

async function queryHermesState(operation: 'list' | 'get' | 'messages' | 'findBySource', arg = '', dbPath: string = HERMES_STATE_DB_PATH): Promise<any[]> {
  if (!hermesStateAvailable() && operation !== 'findBySource') return [];

  const script = `
import json, sqlite3, sys
from pathlib import Path

op = sys.argv[2]
arg = sys.argv[3] if len(sys.argv) > 3 else ''
db_path = Path(sys.argv[1])
if not db_path.exists():
    print('[]')
    raise SystemExit(0)
uri = f'file:{db_path}?mode=ro'
# Live ClawBoard-owned Hermes runtime DB must not be opened immutable: Hermes may
# write a just-launched task session while ClawBoard is polling for it. Immutable
# mode is only for true read-only live-view mounts where SQLite cannot create WAL
# or journal files.
if '/hermes-live/' in str(db_path):
    uri += '&immutable=1'
try:
    conn = sqlite3.connect(uri, uri=True)
except sqlite3.OperationalError:
    conn = sqlite3.connect(f'file:{db_path}?mode=ro&immutable=1', uri=True)
conn.row_factory = sqlite3.Row
cur = conn.cursor()
if op in {'list', 'get', 'messages', 'findBySource'}:
    existing_tables = {row[0] for row in cur.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").fetchall()}
    if 'sessions' not in existing_tables or (op == 'messages' and 'messages' not in existing_tables):
        print('[]')
        raise SystemExit(0)
if op == 'list':
    rows = cur.execute("""
        SELECT s.id, s.source, s.user_id, s.model, s.title, s.started_at, s.ended_at,
               s.session_key, s.parent_session_id, s.end_reason,
               s.message_count, s.tool_call_count, s.input_tokens, s.output_tokens,
               s.reasoning_tokens, s.estimated_cost_usd, s.actual_cost_usd,
               (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_message_at
        FROM sessions s
        ORDER BY COALESCE(last_message_at, s.ended_at, s.started_at) DESC
        LIMIT 400
    """).fetchall()
    print(json.dumps([dict(r) for r in rows]))
elif op == 'get':
    rows = cur.execute("""
        SELECT s.id, s.source, s.user_id, s.model, s.title, s.started_at, s.ended_at,
               s.session_key, s.parent_session_id, s.end_reason,
               s.message_count, s.tool_call_count, s.input_tokens, s.output_tokens,
               s.reasoning_tokens, s.estimated_cost_usd, s.actual_cost_usd,
               (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_message_at
        FROM sessions s WHERE s.id = ? LIMIT 1
    """, (arg,)).fetchall()
    print(json.dumps([dict(r) for r in rows]))
elif op == 'messages':
    rows = cur.execute("""
        SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp, token_count, finish_reason
        FROM messages WHERE session_id = ? ORDER BY timestamp ASC, id ASC
    """, (arg,)).fetchall()
    print(json.dumps([dict(r) for r in rows]))
elif op == 'findBySource':
    payload = json.loads(arg or '{}')
    source = payload.get('source') or ''
    started_after = int(payload.get('started_after') or 0)
    rows = cur.execute("""
        SELECT s.id, s.source, s.user_id, s.model, s.title, s.started_at, s.ended_at,
               s.session_key, s.parent_session_id, s.end_reason,
               s.message_count, s.tool_call_count, s.input_tokens, s.output_tokens,
               s.reasoning_tokens, s.estimated_cost_usd, s.actual_cost_usd,
               (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_message_at
        FROM sessions s
        WHERE s.source = ?
          AND COALESCE(s.started_at, 0) >= ?
        ORDER BY COALESCE(s.started_at, 0) DESC
        LIMIT 5
    """, (source, started_after)).fetchall()
    print(json.dumps([dict(r) for r in rows]))
else:
    print('[]')
`;

  const { stdout } = await execFileAsync('python3', ['-c', script, dbPath, operation, arg], {
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return JSON.parse(stdout || '[]');
}

export async function listHermesSessionStateRows(dbPath?: string): Promise<HermesSessionStateRow[]> {
  return await queryHermesState('list', '', dbPath) as HermesSessionStateRow[];
}

export async function getHermesSessionStateRow(sessionId: string, dbPath?: string): Promise<HermesSessionStateRow | null> {
  const rows = await queryHermesState('get', sessionId, dbPath) as HermesSessionStateRow[];
  return rows[0] || null;
}

export async function findHermesSessionsBySource(sourceTag: string, startedAfterUnixSeconds: number, dbPath?: string): Promise<HermesSessionStateRow[]> {
  return await queryHermesState('findBySource', JSON.stringify({ source: sourceTag, started_after: startedAfterUnixSeconds }), dbPath) as HermesSessionStateRow[];
}

export async function findRecentHermesSessions(startedAfterUnixSeconds: number): Promise<HermesSessionStateRow[]> {
  const rows = await queryHermesState('list', '', HERMES_STATE_DB_PATH) as HermesSessionStateRow[];
  return rows.filter((row) => Number(row.started_at || 0) >= startedAfterUnixSeconds);
}

export async function readHermesSessionIdFromLog(logPath: string): Promise<string | null> {
  if (!logPath) return null;
  try {
    const content = await fs.promises.readFile(logPath, 'utf8');
    const match = content.match(/session_id:\s*([A-Za-z0-9_\-]+)/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the Hermes session row for a previously launched turn whose spawn
 * returned provisionally (sessionKey 'pending'). Tries, in order:
 *   1. sessions.source = sourceTag (deterministic when Hermes honours --source)
 *   2. the 'session_id: <id>' line Hermes prints to the run log at end of turn
 *
 * There is deliberately NO unfiltered "single recent row" fallback: it can bind
 * the task to a completely unrelated session (back-to-back task spawns, user
 * CLI/Discord chats) during the registration window. An unresolvable provisional
 * task is handled by the caller (wait while the PID lives, reap when it dies).
 */
export async function resolveLaunchedHermesSession(
  sourceTag: string,
  spawnedAtUnix: number,
  logPath: string,
): Promise<HermesSessionStateRow | null> {
  try {
    const bySource = await findHermesSessionsBySource(sourceTag, spawnedAtUnix);
    if (bySource.length > 0) {
      // findBySource orders newest-first. Nested hermes runs launched by the
      // task's own agent inherit the exported HERMES_SESSION_SOURCE and always
      // register AFTER the root turn's row, so the OLDEST row at/after the
      // spawn timestamp is the root turn.
      const candidates = bySource
        .filter((row) => Number(row.started_at || 0) >= spawnedAtUnix - 2)
        .sort((a, b) => Number(a.started_at || 0) - Number(b.started_at || 0));
      if (candidates.length > 0) return candidates[0];
    }
  } catch {
    // fall through to log parsing
  }

  const sessionIdFromLog = await readHermesSessionIdFromLog(logPath);
  if (sessionIdFromLog) {
    try {
      const row = await getHermesSessionStateRow(sessionIdFromLog);
      if (row) return row;
    } catch {
      // best effort
    }
  }

  return null;
}

/**
 * Spawn-dedup rule for Hermes-backed tasks: block a respawn while the linked
 * session is live work (starting/running), or while it is idle but has real
 * recorded history (messages or tool calls) — an interactive session waiting
 * between turns must stay idempotent. Idle sessions with zero recorded
 * activity are stale registration artifacts and do NOT block (bypass rule).
 */
export function shouldBlockHermesRespawn(state: Pick<HermesSessionRuntimeState, 'state' | 'row'>): boolean {
  if (isHermesSessionLiveWork(state.state)) return true;
  if (state.state !== 'idle') return false;
  const messageCount = Math.max(0, Number(state.row?.message_count || 0));
  const toolCallCount = Math.max(0, Number(state.row?.tool_call_count || 0));
  return (messageCount + toolCallCount) > 0;
}

export async function listHermesMessages(sessionId: string, dbPath?: string): Promise<HermesMessageStateRow[]> {
  return await queryHermesState('messages', sessionId, dbPath) as HermesMessageStateRow[];
}

function buildHermesLabel(row: HermesSessionStateRow | null, sessionId: string | null): string | null {
  if (row?.title?.trim()) return row.title.trim();
  if (sessionId) return `Hermes ${sessionId.slice(0, 8)}`;
  return null;
}

function runtimePathCandidates(targetPath: string): string[] {
  const candidates = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (value) candidates.add(path.normalize(value));
  };

  add(targetPath);

  if (targetPath.startsWith('/home/agent/workspace/projects/')) {
    const suffix = targetPath.slice('/home/agent/workspace/projects/'.length);
    add(path.join('/task-projects', suffix));
    add(path.join('/workspace/projects', suffix));
  }

  if (targetPath.startsWith('/home/agent/workspace/')) {
    add(targetPath.replace('/home/agent/workspace', '/workspace'));
  }

  if (targetPath.startsWith('/opt/projects/')) {
    const suffix = targetPath.slice('/opt/projects/'.length);
    add(path.join('/task-projects', suffix));
    add(path.join('/project-sources', suffix));
  }

  if (targetPath.startsWith('/mnt/nfs/projects/')) {
    const suffix = targetPath.slice('/mnt/nfs/projects/'.length);
    add(path.join('/project-sources', suffix));
    add(path.join('/project-sources', suffix, 'repo'));
  }

  return Array.from(candidates);
}

export function translateHostPathToRuntime(targetPath: string | null | undefined): string | null {
  if (!targetPath) return null;
  for (const candidate of runtimePathCandidates(targetPath)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function isWritableDirectory(targetPath: string | null | undefined): boolean {
  if (!targetPath) return false;
  try {
    fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveWritableRuntimePath(
  preferredPaths: Array<string | null | undefined>,
  fallbackPaths: Array<string | null | undefined> = [DEFAULT_HERMES_CWD, HERMES_PROJECT_PATH, '/task-projects'],
): string {
  for (const preferredPath of preferredPaths) {
    const translated = translateHostPathToRuntime(preferredPath);
    if (translated && isWritableDirectory(translated)) return translated;
  }

  for (const fallbackPath of fallbackPaths) {
    const translated = translateHostPathToRuntime(fallbackPath);
    if (translated && isWritableDirectory(translated)) return translated;
  }

  const unresolved = preferredPaths.find((value): value is string => Boolean(value))
    || fallbackPaths.find((value): value is string => Boolean(value))
    || DEFAULT_HERMES_CWD;

  return translateHostPathToRuntime(unresolved) || unresolved;
}

function resolveHermesCwd(cwd: string | null | undefined): string {
  return resolveWritableRuntimePath([cwd]);
}

function assertWritableDirectory(targetPath: string): void {
  if (!isWritableDirectory(targetPath)) {
    throw new Error(`Hermes working directory is not writable: ${targetPath}`);
  }
}

function buildTurnLogPath(taskId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(HERMES_RUN_LOG_DIR, `${taskId.slice(0, 8)}-${stamp}.log`);
}

export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== 'ESRCH' ? false : false;
  }
}

export function killProcess(pid: number | null | undefined, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function waitForHermesSession(sourceTag: string, startedAfterUnixSeconds: number, knownSessionIds: Set<string>, timeoutMs = 20000): Promise<HermesSessionStateRow | null> {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    const rows = await findHermesSessionsBySource(sourceTag, startedAfterUnixSeconds);
    if (rows.length > 0) return rows[0];

    // Hermes currently persists tool-launched chat sessions with source='cli', even
    // when launched with `--source tool-task-…`. The previous fallback returned
    // the only recent session after the spawn timestamp, which mis-attributed
    // back-to-back task spawns to the same Hermes session. Instead, snapshot the
    // session ids before launching and only accept a genuinely new row.
    const recentRows = await findRecentHermesSessions(startedAfterUnixSeconds);
    const newRows = recentRows.filter((row) => !knownSessionIds.has(row.id));
    if (newRows.length > 0) {
      return newRows.sort((a, b) => Number(a.started_at || 0) - Number(b.started_at || 0))[0];
    }

    await sleep(350);
  }
  return null;
}

export async function launchHermesTurn(options: HermesTurnLaunchOptions): Promise<HermesTurnLaunchResult> {
  await ensureHermesRuntimeReady();

  const sourceTag = options.sourceTag || buildHermesSourceTag(options.taskId);
  const cwd = resolveHermesCwd(options.cwd);
  assertWritableDirectory(cwd);
  const logPath = buildTurnLogPath(options.taskId);
  const startedAfterUnixSeconds = Math.floor(Date.now() / 1000) - 2;
  const knownSessionIds = new Set((await listHermesSessionStateRows()).map((row) => row.id));
  const args = ['chat', '-q', options.prompt, '-Q', '--source', sourceTag, '--max-turns', String(options.maxTurns || DEFAULT_MAX_TURNS)];

  if (options.model) {
    args.push('-m', options.model);
  }
  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }

  const logFd = fs.openSync(logPath, 'a');
  try {
    const child = spawn(HERMES_BINARY_PATH, args, {
      cwd: fs.existsSync(cwd) ? cwd : HERMES_PROJECT_PATH,
      // Note: hermes exports HERMES_SESSION_SOURCE internally from --source.
      // Do NOT set it here as well: our copy would be inherited by any nested
      // hermes runs the task agent launches, tagging unrelated sessions with
      // this task's source tag.
      env: buildHermesEnv({}, cwd),
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });

    if (!child.pid) {
      throw new Error('Hermes process started without a PID');
    }

    child.unref();

    const row = await waitForHermesSession(sourceTag, startedAfterUnixSeconds, knownSessionIds, 5000);
    if (row) {
      return {
        pid: child.pid,
        sessionId: row.id,
        sessionKey: hermesSessionKeyFor(row),
        sourceTag,
        logPath,
        provisional: false,
        spawnedAtUnix: startedAfterUnixSeconds,
      };
    }

    // Hermes registers its sessions row only at the start of the first
    // conversation turn (after venv import + MCP discovery), which routinely
    // outlives the quick poll above. That is not a launch failure: return a
    // provisional result and let SubAgentTaskUpdater bind the real session id
    // via resolveLaunchedHermesSession once the row appears.
    return {
      pid: child.pid,
      sessionId: null,
      sessionKey: 'pending',
      sourceTag,
      logPath,
      provisional: true,
      spawnedAtUnix: startedAfterUnixSeconds,
    };
  } finally {
    fs.closeSync(logFd);
  }
}

export async function getHermesSessionRuntimeState(sessionKey: string | null | undefined, pid?: number | null): Promise<HermesSessionRuntimeState> {
  const sessionId = extractHermesSessionId(sessionKey);
  const pidAlive = isProcessAlive(pid);

  if (!sessionId) {
    return {
      sessionId: null,
      sessionKey: sessionKey || null,
      source: 'unknown',
      state: pidAlive ? 'starting' : 'none',
      pid: pid || null,
      pidAlive,
      label: null,
      model: null,
      startedAt: null,
      endedAt: null,
      updatedAt: null,
      row: null,
      reason: pidAlive ? 'Hermes turn launched but session metadata is not visible yet.' : null,
    };
  }

  const row = await getHermesSessionStateRow(sessionId);
  if (!row) {
    return {
      sessionId,
      sessionKey: sessionKey || null,
      source: 'unknown',
      state: pidAlive ? 'starting' : 'none',
      pid: pid || null,
      pidAlive,
      label: buildHermesLabel(null, sessionId),
      model: null,
      startedAt: null,
      endedAt: null,
      updatedAt: null,
      row: null,
      reason: pidAlive ? 'Hermes session is still starting up.' : 'Hermes session was not found in the runtime state database.',
    };
  }

  const state = inferHermesSessionState(row, { pidAlive });
  const recordedActivity = Math.max(0, Number(row.message_count || 0)) + Math.max(0, Number(row.tool_call_count || 0));
  const reason = row.ended_at
    ? 'Hermes session has ended.'
    : state === 'idle' && !pidAlive && recordedActivity === 0
      ? 'Hermes session has no live worker PID and no recorded messages or tool calls; treating it as stale/idle.'
      : state === 'idle' && !pidAlive
        ? 'Hermes session has no live worker PID and no fresh recorded activity.'
        : null;

  return {
    sessionId,
    sessionKey: sessionKey || hermesSessionKeyFor(row),
    source: normalizeHermesSource(row.source),
    state,
    pid: pid || null,
    pidAlive,
    label: buildHermesLabel(row, sessionId),
    model: row.model || null,
    startedAt: hermesTimestampToIso(row.started_at),
    endedAt: hermesTimestampToIso(row.ended_at),
    updatedAt: hermesTimestampToIso(row.last_message_at || row.started_at),
    row,
    reason,
  };
}
