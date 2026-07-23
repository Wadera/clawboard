/**
 * SessionsPage — Phase 5 Rebuild
 *
 * Unified session view. No more ACTIVE/RECENT split.
 * Consumes the new clean REST API (/api/sessions) + WebSocket events.
 *
 * Data flow:
 *   Mount → GET /api/sessions?limit=50
 *   WS:   sessions:snapshot   → replace list
 *         sessions:live-state  → patch single session's liveState (null = ended)
 *         sessions:updated     → patch + re-sort
 *         sessions:completed   → mark session done, clear liveState, remove Stop btn
 *   Click → GET /api/sessions/:key + GET /api/sessions/:key/messages (polled)
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Clock, Wrench, Zap, Loader, AlertCircle, CheckCircle2,
  Terminal, Globe, FileText, Search, ChevronDown, ChevronRight,
  Square, ExternalLink, X, Filter, RefreshCw, FileX, Copy, Check,
} from 'lucide-react';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import 'highlight.js/styles/github-dark.css';
import { authenticatedFetch } from '../utils/auth';
import { useWebSocket } from '../hooks/useWebSocket';
import { type LiveSessionTaskRef } from '../components/tasks/LiveSessionPanel';
import { SessionSteeringComposer } from '../components/sessions/SessionSteeringComposer';
import { TASK_ACCESS_PROFILE_LABELS, TASK_PROFILE_CAPABILITIES } from '../constants/taskExecution';
import type { TaskAccessProfile, TaskCapability, TaskExecutionProfile } from '../types/task';
import {
  getSessionMessagesEmptyState,
  getSessionOperationsBucket,
  getSessionOperationsEmptyState,
  getSessionOperationsReason,
  getSessionTokenUsage,
  type SessionOperationsView,
  type SessionRuntimeState,
  type SessionTranscriptState,
} from './sessionPresentation';
import { formatDateTimeLong } from '../utils/dateFormat';
import { getCancellationSuccessMessage, getSessionCancellationPlan } from './sessionControls';
import './SessionsPage.css';
import { buildDiscordThreadUrl } from '../utils/discordLinks';

// Register highlight.js languages
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('sql', sql);

// Configure marked with custom renderer for highlight.js
const markedRenderer = new marked.Renderer();
markedRenderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined;
  let highlighted: string;
  try {
    highlighted = language
      ? hljs.highlight(text, { language }).value
      : hljs.highlightAuto(text).value;
  } catch {
    highlighted = text;
  }
  const langTag = lang ? `<span class="code-lang-tag">${lang}</span>` : '';
  return `<pre class="hljs-code-block">${langTag}<code class="hljs">${highlighted}</code></pre>`;
};

marked.setOptions({
  breaks: true,
  gfm: true,
  renderer: markedRenderer,
} as any);

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

// ─── Types ────────────────────────────────────────────────────────

interface LiveState {
  state: 'idle' | 'busy' | 'thinking' | 'tool-use' | 'typing';
  recentTools: any[];
  lastActivity: number;
  isGenerating: boolean;
}

interface SessionTaskLink extends LiveSessionTaskRef {
  sessionMatch: 'acpSessionKey' | 'activeAgent';
  executionProfile?: TaskExecutionProfile | null;
  model?: string | null;
  thinking?: 'low' | 'medium' | 'high' | string | null;
  discordThreadUrl?: string | null;
  agentName?: string | null;
  agentType?: string | {
    id: string;
    slug: string | null;
    name: string | null;
    color: string | null;
    category: string | null;
  } | null;
}

interface SessionAttachmentSupport {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  supportedMimeTypes?: string[];
  supportedExtensions?: string[];
  description?: string;
}

interface SessionSteeringInfo {
  supported: boolean;
  reason: string | null;
  attachmentSupport?: SessionAttachmentSupport | null;
  targetSessionKey?: string | null;
}

type SessionHarness = 'openclaw' | 'hermes' | 'unknown';
type SessionType = 'main' | 'heartbeat' | 'cron' | 'subagent' | 'acp' | 'cli' | 'dm' | 'group' | 'channel' | 'thread' | 'unknown';

interface Session {
  sessionKey: string;
  sessionId: string | null;
  kind: string;
  harness?: SessionHarness;
  harnessLabel?: string | null;
  sessionType?: SessionType;
  sessionTypeLabel?: string | null;
  label: string | null;
  displayLabel?: string | null;
  model: string | null;
  channel: string | null;
  status: string; // 'active' | 'completed' | 'errored' | 'stuck'
  liveState: LiveState | null;
  runtimeState?: SessionRuntimeState | null;
  runtimeStateReason?: string | null;
  messageCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalCost: number;
  startedAt: string | null;
  endedAt: string | null;
  lastActivityAt: string | null;
  spawnInfo: Record<string, any>;
  contextTelemetry?: {
    mode: 'runtime' | 'runtime-stale' | 'heuristic' | 'unavailable';
    usedTokens: number;
    maxTokens: number | null;
    percent: number | null;
    fresh: boolean;
    compactionCount: number | null;
    memoryFlushAt: number | null;
    headline: string;
    detail: string;
    note: string;
    level: 'calm' | 'hint' | 'caution' | 'warning' | 'muted';
  } | null;
  transcriptPath: string | null;
  transcriptState?: SessionTranscriptState | null;
  transcriptStateReason?: string | null;
  fileSize: number | null;
  task?: SessionTaskLink | null;
  steering?: SessionSteeringInfo | null;
}

interface SessionStats {
  overall: {
    total_sessions: string;
    active_sessions: string;
    completed_sessions: string;
    total_messages: string;
    total_input_tokens: string;
    total_output_tokens: string;
    total_thinking_tokens: string;
    total_cost: string;
  };
  byKind: Array<{ kind: string; count: string }>;
  byModel: Array<{ model: string; session_count: string }>;
  byChannel: Array<{ channel: string; count: string }>;
}

interface TranscriptMessage {
  role: string;
  text: string;
  fullText?: string;
  truncated?: boolean;
  timestamp: string | null;
  toolName?: string;
  toolCallId?: string;
}

interface ApiToolCall {
  id: string;
  name: string;
  input: string;
  inputData: Record<string, any>;
  output?: string;
  timestamp: string;
  completedTimestamp?: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ─── Formatters ──────────────────────────────────────────────────

function formatTimeAgo(ts: number | string | null): string {
  if (!ts) return '—';
  const t = typeof ts === 'string' ? new Date(ts).getTime() : ts;
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatTokens(n: number): string {
  if (!n) return '0';
  if (!isFinite(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatCost(cost: number): string {
  if (!cost || cost <= 0) return '';
  if (cost < 0.001) return `$${cost.toFixed(5)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatElapsed(startTs: number): string {
  const s = Math.floor((Date.now() - startTs) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatRuntime(startIso?: string | null, endIso?: string | null): string {
  if (!startIso) return '—';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  return formatDuration(end - start);
}

function getAbbreviatedModel(model: string): string {
  if (!model) return '';
  const lower = model.toLowerCase();
  if (lower.includes('opus')) {
    const m = model.match(/opus[- ]?(\d+(?:[.-]\d+)?)/i);
    return m ? `Opus ${m[1].replace('-', '.')}` : 'Opus';
  }
  if (lower.includes('sonnet')) {
    const m = model.match(/sonnet[- ]?(\d+(?:[.-]\d+)?)/i);
    return m ? `Sonnet ${m[1].replace('-', '.')}` : 'Sonnet';
  }
  if (lower.includes('haiku')) {
    const m = model.match(/haiku[- ]?(\d+(?:[.-]\d+)?)/i);
    return m ? `Haiku ${m[1].replace('-', '.')}` : 'Haiku';
  }
  if (lower.includes('gpt')) {
    const m = model.match(/gpt[- ]?(\d+(?:[.-]\d+)?)/i);
    return m ? `GPT-${m[1]}` : 'GPT';
  }
  if (lower.includes('phi')) return 'Phi4';
  if (lower.includes('gemini')) return 'Gemini';
  return model.split(/[-_\s]/)[0].substring(0, 10);
}

const CAPABILITY_LABELS: Record<TaskCapability, string> = {
  browser: 'Browser',
  'host-browser': 'Host browser',
  elevated: 'Elevated',
  network: 'Network',
  'discord-thread': 'Discord thread',
  'long-running': 'Long running',
};

function getExecutionCapabilities(profile?: TaskExecutionProfile | null): TaskCapability[] {
  const accessProfile = profile?.accessProfile as TaskAccessProfile | undefined;
  const derived = accessProfile ? (TASK_PROFILE_CAPABILITIES[accessProfile] || []) : [];
  const explicit = Array.isArray(profile?.requiredCapabilities) ? profile!.requiredCapabilities : [];
  return Array.from(new Set([...(derived as TaskCapability[]), ...(explicit as TaskCapability[])]));
}

function formatAccessProfile(profile?: string | null): string {
  if (!profile) return 'Unavailable';
  return TASK_ACCESS_PROFILE_LABELS[profile as TaskAccessProfile] || profile;
}

function formatCapability(capability: string): string {
  return CAPABILITY_LABELS[capability as TaskCapability] || capability;
}

function getDisplayLabel(session: Session): string {
  return session.displayLabel || session.label || session.sessionKey.slice(0, 30);
}

function getHarnessLabel(session: Session): string {
  if (session.harnessLabel) return session.harnessLabel;
  switch (session.harness) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes': return 'Hermes';
    default: return 'Unknown';
  }
}

function getSessionTypeLabel(session: Session): string {
  if (session.sessionTypeLabel) return session.sessionTypeLabel;
  switch (session.sessionType) {
    case 'main': return 'main';
    case 'heartbeat': return 'heartbeat';
    case 'cron': return 'cron';
    case 'subagent': return 'sub agent';
    case 'acp': return 'acp';
    case 'cli': return 'cli';
    case 'dm': return 'dm';
    case 'group': return 'group';
    case 'channel': return 'channel';
    case 'thread': return 'thread';
    default: return session.kind || 'unknown';
  }
}

function getRuntimeLabel(session: Session, linkedTask?: SessionTaskLink | null): string {
  const executionMode = linkedTask?.executionMode;
  const harnessLabel = getHarnessLabel(session);
  const sessionType = session.sessionType || 'unknown';

  if (session.runtimeState === 'missing') return `${harnessLabel} runtime missing`;
  if (session.runtimeState === 'starting') return `${harnessLabel} starting`;
  if (sessionType === 'main') return `${harnessLabel} main`;
  if (sessionType === 'cli') return harnessLabel === 'Hermes' ? 'Hermes CLI' : 'CLI';
  if (sessionType === 'heartbeat') return `${harnessLabel} heartbeat`;
  if (sessionType === 'acp' && executionMode === 'interactive') return `${harnessLabel} ACP interactive`;
  if (sessionType === 'acp') return `${harnessLabel} ACP session`;
  if (sessionType === 'subagent') return `${harnessLabel} spawned sub agent`;
  if (sessionType === 'cron') return executionMode === 'interactive' ? `${harnessLabel} cron interactive` : `${harnessLabel} cron run`;
  if (executionMode === 'interactive') return 'Interactive task session';
  return `${harnessLabel} ${getSessionTypeLabel(session)}`;
}

// ─── Session Helpers ─────────────────────────────────────────────

function getKindIcon(kind: string, sessionKey: string, label?: string | null): string {
  const k = (kind || '').toLowerCase();
  const key = sessionKey || '';
  if (k === 'subagent' || k === 'acp' || key.includes(':g-agent-') || key.includes(':subagent:')) return '🤖';
  if (k === 'heartbeat' || key.includes(':heartbeat')) return '💓';
  if (key.includes(':run:')) return '▶️';
  if (k === 'cron' || key.includes(':cron:')) return '⏰';
  if (key.endsWith(':main') || k === 'main' || label?.toLowerCase() === 'main session') return '🏠';
  if (k === 'interactive') return '💬';
  return '💬';
}

/** True if this session is a :run: child of a cron session */
function isRunChild(sessionKey: string): boolean {
  return sessionKey.includes(':run:');
}

function getChannelBadge(channel: string | null): string {
  if (!channel) return '';
  switch (channel.toLowerCase()) {
    case 'discord': return 'discord';
    case 'telegram': return 'tg';
    case 'heartbeat': return 'heartbeat';
    case 'signal': return 'signal';
    case 'whatsapp': return 'wa';
    case 'slack': return 'slack';
    case 'internal': return 'internal';
    case 'unknown': return '';
    default: return channel.slice(0, 8);
  }
}

/** True when session is actively generating/busy */
function isSessionActive(s: Session): boolean {
  if (s.liveState && (s.liveState.isGenerating || s.liveState.state !== 'idle')) return true;
  return false;
}

/** True when session has real live runtime state (or is still in startup grace) */
function isSessionLive(s: Session): boolean {
  if (s.liveState !== null) return true;
  return s.runtimeState === 'live' || s.runtimeState === 'starting';
}

function getSessionStatus(s: Session): 'active' | 'idle' | 'completed' | 'errored' {
  if (s.status === 'errored' || s.status === 'stuck') return 'errored';
  if (isSessionActive(s)) return 'active';
  if (isSessionLive(s)) return 'idle';
  return 'completed';
}

function getSessionLastActivity(s: Session): number {
  if (s.liveState?.lastActivity) return s.liveState.lastActivity;
  if (s.lastActivityAt) return new Date(s.lastActivityAt).getTime();
  if (s.startedAt) return new Date(s.startedAt).getTime();
  return 0;
}

function isPinnedMainSession(session: Session): boolean {
  const label = getDisplayLabel(session).toLowerCase();
  return label === 'main openclaw' || label === 'main hermes' || session.sessionType === 'main';
}

/** Sort: generating first → live/idle → completed, then by activity DESC */
function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const aPinnedMain = isPinnedMainSession(a);
    const bPinnedMain = isPinnedMainSession(b);
    const aActive = isSessionActive(a);
    const bActive = isSessionActive(b);
    const aLive = isSessionLive(a);
    const bLive = isSessionLive(b);

    if (aPinnedMain && !bPinnedMain) return -1;
    if (!aPinnedMain && bPinnedMain) return 1;
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    if (aLive && !bLive) return -1;
    if (!aLive && bLive) return 1;

    return getSessionLastActivity(b) - getSessionLastActivity(a);
  });
}

/** Extract tool calls from messages for the tools panel */
function extractToolCalls(messages: TranscriptMessage[]): ApiToolCall[] {
  const calls: ApiToolCall[] = [];
  const resultsByCallId = new Map<string, TranscriptMessage>();

  // Collect tool results
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId) {
      resultsByCallId.set(msg.toolCallId, msg);
    }
  }

  // Build tool call entries from assistant messages
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolName) {
      const result = msg.toolCallId ? resultsByCallId.get(msg.toolCallId) : undefined;
      const rawInput = msg.text.replace(/^\[Tool call: [^\]]+\]\s*/, '');
      calls.push({
        id: msg.toolCallId || `${msg.toolName}-${msg.timestamp || calls.length}`,
        name: msg.toolName,
        input: rawInput,
        inputData: {},
        output: result?.text,
        timestamp: msg.timestamp || new Date().toISOString(),
        status: result ? 'done' : 'running',
      });
    }
  }

  return calls;
}

function getRoleInfo(role: string) {
  switch (role.toLowerCase()) {
    case 'assistant': return { icon: '🤖', label: 'Assistant', className: 'role-assistant' };
    case 'user': return { icon: '👤', label: 'User', className: 'role-user' };
    case 'system': return { icon: '⚙️', label: 'System', className: 'role-system' };
    case 'tool': return { icon: '🔧', label: 'Tool Result', className: 'role-tool' };
    case 'tool_use': return { icon: '⚡', label: 'Tool Call', className: 'role-tool-use' };
    default: return { icon: '💬', label: role, className: 'role-default' };
  }
}

function getToolType(name: string): 'exec' | 'browser' | 'file' | 'search' | 'message' | 'generic' {
  switch (name.toLowerCase()) {
    case 'exec': case 'process': return 'exec';
    case 'browser': case 'web_fetch': return 'browser';
    case 'read': case 'write': case 'edit': return 'file';
    case 'memory_search': case 'memory_get': return 'search';
    case 'message': case 'sessions_send': case 'sessions_spawn': case 'tts': return 'message';
    default: return 'generic';
  }
}

function getToolIcon(name: string): React.ReactNode {
  const type = getToolType(name);
  if (type === 'exec') return <Terminal size={13} />;
  if (type === 'browser') return <Globe size={13} />;
  if (type === 'file') return <FileText size={13} />;
  if (type === 'search') return <Search size={13} />;
  return <Zap size={13} />;
}

function getToolDisplayName(name: string): string {
  const map: Record<string, string> = {
    exec: 'Terminal', process: 'Process', browser: 'Browser', web_fetch: 'Web Fetch',
    read: 'Read File', write: 'Write File', edit: 'Edit File',
    memory_search: 'Memory Search', memory_get: 'Memory Get',
    message: 'Message', sessions_spawn: 'Spawn Agent', sessions_send: 'Send to Session', tts: 'TTS',
  };
  return map[name.toLowerCase()] || name;
}

// ─── StatusDot ──────────────────────────────────────────────────

interface StatusDotProps {
  sessionStatus: 'active' | 'idle' | 'completed' | 'errored';
  size?: 'sm' | 'md';
}

const StatusDot: React.FC<StatusDotProps> = ({ sessionStatus, size = 'sm' }) => {
  let cls = `status-dot${size === 'md' ? ' status-dot-md' : ''}`;
  switch (sessionStatus) {
    case 'active': cls += ' dot-green dot-pulse'; break;
    case 'idle': cls += ' dot-yellow'; break;
    case 'errored': cls += ' dot-red'; break;
    default: cls += ' dot-grey';
  }
  return <span className={cls} />;
};

// ─── StopButton ─────────────────────────────────────────────────

interface StopButtonProps { session: Session; onStopped?: () => void; compact?: boolean; }

const StopButton: React.FC<StopButtonProps> = ({ session, onStopped, compact }) => {
  const [stopping, setStopping] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const plan = useMemo(() => getSessionCancellationPlan({
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    harness: session.harness,
    taskId: session.task?.id,
  }), [session.harness, session.sessionId, session.sessionKey, session.task?.id]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!plan.enabled || !plan.endpoint) return;
    if (!confirm) {
      setFeedback(null);
      setConfirm(true);
      timerRef.current = setTimeout(() => setConfirm(false), 3000);
      return;
    }
    clearTimeout(timerRef.current);
    setConfirm(false);
    setStopping(true);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}${plan.endpoint}`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || `Cancellation failed with HTTP ${response.status}`);
      }
      const message = getCancellationSuccessMessage(plan, data);
      setFeedback({ kind: 'success', message });
      onStopped?.();
    } catch (err) {
      setFeedback({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Cancellation failed without a runtime acknowledgement.',
      });
    } finally {
      setStopping(false);
    }
  }, [confirm, onStopped, plan]);

  return (
    <div className="session-cancel-control">
      <button
        className={`stop-btn${confirm ? ' confirm' : ''}${stopping ? ' stopping' : ''}${compact ? ' compact' : ''}`}
        onClick={handleClick}
        title={plan.disabledReason || (confirm ? `Confirm cancellation of ${plan.targetLabel}` : `Cancel ${plan.targetLabel}`)}
        aria-label={plan.disabledReason || (confirm ? `Confirm cancellation of ${plan.targetLabel}` : `Cancel ${plan.targetLabel}`)}
        aria-pressed={confirm}
        disabled={!plan.enabled || stopping}
      >
        {stopping ? <Loader size={12} className="spin" /> : <Square size={12} />}
        {!compact && <span>{stopping ? 'Cancelling…' : confirm ? 'Confirm?' : 'Cancel'}</span>}
      </button>
      {feedback && (
        <span
          className={`session-control-feedback ${feedback.kind}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          title={feedback.message}
        >
          {feedback.kind === 'success' ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
          <span>{feedback.message}</span>
        </span>
      )}
    </div>
  );
};

// ─── FilterBar ───────────────────────────────────────────────────

interface FilterBarProps {
  kinds: string[];
  models: string[];
  channels: string[];
  harnessFilter: string;
  kindFilter: string;
  modelFilter: string;
  channelFilter: string;
  searchFilter: string;
  dateFrom: string;
  dateTo: string;
  onHarness: (v: string) => void;
  onKind: (v: string) => void;
  onModel: (v: string) => void;
  onChannel: (v: string) => void;
  onSearch: (v: string) => void;
  onDateFrom: (v: string) => void;
  onDateTo: (v: string) => void;
  onReset: () => void;
  hasFilters: boolean;
}

const FilterBar: React.FC<FilterBarProps> = ({
  kinds, models, channels,
  harnessFilter, kindFilter, modelFilter, channelFilter, searchFilter, dateFrom, dateTo,
  onHarness, onKind, onModel, onChannel, onSearch, onDateFrom, onDateTo,
  onReset, hasFilters,
}) => {
  const [expanded, setExpanded] = useState(false);
  const activeFilterCount = [harnessFilter, kindFilter, modelFilter, channelFilter, dateFrom, dateTo].filter(Boolean).length;

  return (
    <div className="sessions-filter-bar">
      <div className="sessions-filter-row">
        <div className="sessions-filter-search">
          <Search size={12} />
          <input
            type="text"
            placeholder="Search sessions…"
            value={searchFilter}
            onChange={e => onSearch(e.target.value)}
          />
        </div>

        <button
          className={`sessions-filter-toggle ${expanded ? 'active' : ''} ${activeFilterCount > 0 ? 'has-filters' : ''}`}
          onClick={() => setExpanded(!expanded)}
          title={expanded ? 'Hide filters' : 'Show filters'}
        >
          <Filter size={13} />
          {activeFilterCount > 0 && (
            <span className="sessions-filter-badge">{activeFilterCount}</span>
          )}
        </button>

        {hasFilters && (
          <button className="sessions-filter-reset" onClick={() => { onReset(); setExpanded(false); }} title="Clear all filters">
            <X size={13} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="sessions-filter-expanded">
          <div className="sessions-filter-selects">
            <select className="sessions-filter-select" value={harnessFilter} onChange={e => onHarness(e.target.value)}>
              <option value="">All harnesses</option>
              <option value="hermes">Hermes</option>
              <option value="openclaw">OpenClaw</option>
            </select>

            <select className="sessions-filter-select" value={kindFilter} onChange={e => onKind(e.target.value)}>
              <option value="">All kinds</option>
              {kinds.map(k => <option key={k} value={k}>{k}</option>)}
            </select>

            <select className="sessions-filter-select" value={modelFilter} onChange={e => onModel(e.target.value)}>
              <option value="">All models</option>
              {models.map(m => <option key={m} value={m}>{getAbbreviatedModel(m)}</option>)}
            </select>

            <select className="sessions-filter-select" value={channelFilter} onChange={e => onChannel(e.target.value)}>
              <option value="">All channels</option>
              {channels.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="sessions-filter-dates">
            <input
              type="date"
              className="sessions-filter-date"
              value={dateFrom}
              onChange={e => onDateFrom(e.target.value)}
              title="From date"
            />
            <span className="sessions-filter-date-sep">→</span>
            <input
              type="date"
              className="sessions-filter-date"
              value={dateTo}
              onChange={e => onDateTo(e.target.value)}
              title="To date"
            />
          </div>
        </div>
      )}
    </div>
  );
};

// ─── SessionCard ─────────────────────────────────────────────────

interface SessionCardProps {
  session: Session;
  isSelected: boolean;
  disambiguateSuffix?: string;
  onClick: () => void;
}

const SessionCard: React.FC<SessionCardProps> = ({ session, isSelected, disambiguateSuffix, onClick }) => {
  const status = getSessionStatus(session);
  const displayLabel = getDisplayLabel(session);
  const kindIcon = getKindIcon(session.kind, session.sessionKey, displayLabel);
  const abbrevModel = session.model ? getAbbreviatedModel(session.model) : null;
  const channelBadge = getChannelBadge(session.channel);
  const harnessBadge = getHarnessLabel(session);
  const runtimeBadge = getSessionTypeLabel(session);
  const uniqueBadges = new Set<string>();
  const pushBadge = (value: string | null | undefined): string | null => {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    const key = normalized.toLowerCase();
    if (uniqueBadges.has(key)) return null;
    uniqueBadges.add(key);
    return normalized;
  };
  const modelBadge = pushBadge(abbrevModel);
  const harnessBadgeValue = session.harness && session.harness !== 'unknown' ? pushBadge(harnessBadge) : null;
  const runtimeBadgeValue = session.sessionType && session.sessionType !== 'unknown' ? pushBadge(runtimeBadge) : null;
  const channelBadgeValue = pushBadge(channelBadge);
  const lastActivity = getSessionLastActivity(session);
  const tokenTotal = getSessionTokenUsage(session).total;
  const costStr = formatCost(session.totalCost || 0);
  const baseLabel = displayLabel;
  const label = disambiguateSuffix ? `${baseLabel} (${disambiguateSuffix})` : baseLabel;
  const isActive = status === 'active';
  const transcriptUnavailable = session.transcriptState === 'missing'
    || (!isActive && session.messageCount > 0 && !session.transcriptPath);
  const agentTypeMeta = session.task?.agentType && typeof session.task.agentType === 'object' ? session.task.agentType : null;
  const personaLabel = agentTypeMeta?.name || session.task?.agentName || null;
  const parentSessionKey = session.spawnInfo?.parentSessionKey || session.spawnInfo?.spawnedBy || null;
  const operationsReason = getSessionOperationsReason({
    status: session.status,
    runtimeState: session.runtimeState,
    runtimeStateReason: session.runtimeStateReason,
    transcriptState: session.transcriptState,
    transcriptStateReason: session.transcriptStateReason,
    hasLiveState: session.liveState !== null,
  });
  const activityTitle = lastActivity ? formatDateTimeLong(lastActivity) : 'No activity timestamp supplied';

  return (
    <div
      className={`session-card ${status}${isSelected ? ' selected' : ''}`}
      onClick={onClick}
    >
      <div className="session-card-left">
        <StatusDot sessionStatus={status} />
        <span className="session-card-kind-icon" title={session.kind}>{kindIcon}</span>
      </div>

      <div className="session-card-body">
        <div className="session-card-label" title={label}>{label}</div>
        <div className="session-card-meta">
          {isRunChild(session.sessionKey) && (
            <span className="session-card-badge sub-session-badge" title="Sub-session (child run)">
              sub
            </span>
          )}
          {modelBadge && (
            <span className="session-card-badge model-badge" title={session.model || ''}>
              {modelBadge}
            </span>
          )}
          {harnessBadgeValue && (
            <span className="session-card-badge harness-badge">{harnessBadgeValue}</span>
          )}
          {runtimeBadgeValue && (
            <span className="session-card-badge runtime-badge">{runtimeBadgeValue}</span>
          )}
          {channelBadgeValue && (
            <span className="session-card-badge channel-badge">{channelBadgeValue}</span>
          )}
          <span className="session-card-time">
            <Clock size={10} />
            <span title={activityTitle}>{isActive && lastActivity
              ? formatElapsed(lastActivity)
              : formatTimeAgo(lastActivity || null)}</span>
          </span>
        </div>
        {(session.task || personaLabel) && (
          <div className="session-card-context" title={session.task?.title || personaLabel || undefined}>
            {session.task ? `Task ${session.task.id.slice(0, 8)} · ${session.task.title}` : 'Unlinked session'}
            {personaLabel ? ` · ${personaLabel}` : ''}
          </div>
        )}
        {parentSessionKey && (
          <div className="session-card-context" title={String(parentSessionKey)}>
            Child of {String(parentSessionKey)}{session.spawnInfo?.spawnDepth != null ? ` · depth ${session.spawnInfo.spawnDepth}` : ''}
          </div>
        )}
        {operationsReason && (
          <div className="session-card-reason" title={operationsReason}>{operationsReason}</div>
        )}
        {tokenTotal > 0 && (
          <div className="session-card-tokens">
            {formatTokens(tokenTotal)}
            {costStr && <span className="session-card-cost">{costStr}</span>}
          </div>
        )}
      </div>

      {isActive && (
        <div className="session-card-actions" onClick={e => e.stopPropagation()}>
          <StopButton session={session} compact />
        </div>
      )}
      {transcriptUnavailable && (
        <div className="session-card-no-transcript" title="Transcript unavailable">
          <FileX size={12} />
        </div>
      )}
    </div>
  );
};

// ─── StatsBar ────────────────────────────────────────────────────

interface StatsBarProps {
  sessions: Session[];
  total: number;
  wsConnected: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}

const StatsBar: React.FC<StatsBarProps> = ({ sessions, total, wsConnected, onRefresh, refreshing }) => {
  const activeCount = sessions.filter(s => isSessionActive(s)).length;
  const liveCount = sessions.filter(s => isSessionLive(s)).length;
  const totalTokens = sessions.reduce((acc, session) =>
    acc + getSessionTokenUsage(session).total, 0);
  const totalCost = sessions.reduce((acc, s) => acc + (s.totalCost || 0), 0);

  return (
    <div className="sessions-stats-bar">
      <div className="sessions-stats-left">
        <div className="sessions-ws-indicator">
          <div className={`sessions-connection-dot ${wsConnected ? 'connected' : 'disconnected'}`} />
          <span>{wsConnected ? 'Live' : 'Offline'}</span>
        </div>

        <div className="sessions-stat-item">
          <span className="sessions-stat-label">Sessions</span>
          <span className="sessions-stat-value">{total}</span>
        </div>

        {liveCount > 0 && (
          <div className="sessions-stat-item">
            <span className="sessions-stat-label">Live</span>
            <span className="sessions-stat-value highlight">{liveCount}</span>
          </div>
        )}

        {activeCount > 0 && (
          <div className="sessions-stat-item">
            <span className="sessions-stat-label">Active</span>
            <span className="sessions-stat-value active">{activeCount}</span>
          </div>
        )}

        {totalTokens > 0 && (
          <div className="sessions-stat-item">
            <span className="sessions-stat-label">Tokens</span>
            <span className="sessions-stat-value">{formatTokens(totalTokens)}</span>
          </div>
        )}

        {totalCost > 0 && (
          <div className="sessions-stat-item">
            <span className="sessions-stat-label">Cost</span>
            <span className="sessions-stat-value">{formatCost(totalCost)}</span>
          </div>
        )}
      </div>

      <button
        className={`sessions-refresh-btn${refreshing ? ' refreshing' : ''}`}
        onClick={onRefresh}
        title="Refresh sessions"
        disabled={refreshing}
      >
        <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
      </button>
    </div>
  );
};

// ─── SessionsPage ────────────────────────────────────────────────

export const SessionsPage: React.FC = () => {
  const focusTarget = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('focus')?.trim() || params.get('session')?.trim() || null;
  }, []);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [focusedSession, setFocusedSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(false);

  // Pagination
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Filters
  const [kindFilter, setKindFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [harnessFilter, setHarnessFilter] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [operationsView, setOperationsView] = useState<SessionOperationsView>('active');
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  // Stats (for filter dropdowns)
  const [stats, setStats] = useState<SessionStats | null>(null);

  const { subscribe, connected: wsConnected } = useWebSocket();
  const initialFetchDoneRef = useRef(false);
  const focusedSessionFetchRef = useRef<Set<string>>(new Set());
  const missingFocusedSessionRef = useRef<Set<string>>(new Set());
  const defaultLiveMode = !focusTarget && !harnessFilter && !kindFilter && !modelFilter && !channelFilter && !searchFilter && !dateFrom && !dateTo;

  const matchesFocusTarget = useCallback((session: Session, normalizedFocus: string) => {
    const focusShort = normalizedFocus.slice(0, 8).toLowerCase();
    const allowLabelFuzzyMatch = !normalizedFocus.includes(':') && normalizedFocus.length <= 12;
    return (
      session.sessionKey === normalizedFocus
      || session.sessionKey.startsWith(`${normalizedFocus}:run:`)
      || session.sessionId === normalizedFocus
      || session.task?.id === normalizedFocus
      || session.task?.id?.startsWith(normalizedFocus)
      || session.task?.acpSessionKey === normalizedFocus
      || (allowLabelFuzzyMatch && getDisplayLabel(session).toLowerCase().includes(focusShort))
    );
  }, []);

  // ── Fetch sessions ─────────────────────────────────────────────

  const buildParams = useCallback((pageNum: number) => {
    const p = new URLSearchParams({ limit: '50', page: String(pageNum) });
    if (harnessFilter) p.set('harness', harnessFilter);
    if (kindFilter) p.set('kind', kindFilter);
    if (modelFilter) p.set('model', modelFilter);
    if (channelFilter) p.set('channel', channelFilter);
    if (searchFilter) p.set('search', searchFilter);
    if (dateFrom) p.set('dateFrom', dateFrom);
    if (dateTo) p.set('dateTo', dateTo);
    return p;
  }, [harnessFilter, kindFilter, modelFilter, channelFilter, searchFilter, dateFrom, dateTo]);

  const fetchSessions = useCallback(async (pageNum = 1, append = false) => {
    try {
      const r = await authenticatedFetch(`${API_BASE_URL}/sessions?${buildParams(pageNum)}`);
      if (!r.ok) {
        setSessionsError(`Sessions API returned ${r.status}.`);
        return;
      }
      const d = await r.json();
      if (d.success) {
        setSessionsError(null);
        const sorted = sortSessions(d.sessions || []);
        setSessions(prev => {
          if (append) return sortSessions([...prev, ...sorted]);

          const normalizedFocus = focusTarget?.trim();
          if (!normalizedFocus) return sorted;

          const focusedFromPrev = prev.find(session => matchesFocusTarget(session, normalizedFocus));
          if (!focusedFromPrev || sorted.some(session => session.sessionKey === focusedFromPrev.sessionKey)) {
            return sorted;
          }

          return sortSessions([focusedFromPrev, ...sorted]);
        });
        setPagination(d.pagination);
        setPage(pageNum);
      }
    } catch (err) {
      console.error('[SessionsPage] fetch error:', err);
      setSessionsError(err instanceof Error ? err.message : 'Sessions could not be loaded.');
    }
  }, [buildParams, focusTarget, matchesFocusTarget]);

  const fetchStats = useCallback(async () => {
    try {
      const r = await authenticatedFetch(`${API_BASE_URL}/sessions/stats`);
      if (!r.ok) return;
      const d = await r.json();
      if (d.success) setStats(d);
    } catch (err) {
      console.error('[SessionsPage] stats error:', err);
    }
  }, []);

  // ── Initial load ───────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    const finishInitialLoad = () => {
      if (cancelled) return;
      setLoading(false);
      initialFetchDoneRef.current = true;
    };

    const scheduleStats = () => {
      fetchStats();
    };

    setLoading(true);
    fetchSessions(1).finally(finishInitialLoad);

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      (window as any).requestIdleCallback(scheduleStats, { timeout: 1500 });
    } else {
      setTimeout(scheduleStats, 250);
    }

    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps


  useEffect(() => {
    if (!loading || !defaultLiveMode || sessions.length === 0) return;
    setLoading(false);
    initialFetchDoneRef.current = true;
  }, [loading, defaultLiveMode, sessions.length]);

  useEffect(() => {
    const normalizedFocus = focusTarget?.trim();
    if (!normalizedFocus) return;

    const existingMatch = sessions.find(session => matchesFocusTarget(session, normalizedFocus));
    if (existingMatch) {
      setFocusedSession(existingMatch);
      if (selectedKey !== existingMatch.sessionKey) setSelectedKey(existingMatch.sessionKey);
      return;
    }

    if (focusedSessionFetchRef.current.has(normalizedFocus) || missingFocusedSessionRef.current.has(normalizedFocus)) return;

    focusedSessionFetchRef.current.add(normalizedFocus);
    let cancelled = false;

    (async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE_URL}/sessions/${encodeURIComponent(normalizedFocus)}`);
        if (!response.ok) {
          if (response.status === 404 && !cancelled) missingFocusedSessionRef.current.add(normalizedFocus);
          return;
        }
        const data = await response.json();
        if (!data.success || !data.session || cancelled) return;

        setFocusedSession(data.session);
        setSessions(prev => sortSessions([
          data.session,
          ...prev.filter(session => session.sessionKey !== data.session.sessionKey),
        ]));
        setSelectedKey(data.session.sessionKey);
      } catch (err) {
        console.error('[SessionsPage] focused session fetch error:', err);
      }
    })();

    return () => {
      // Do not cancel the direct focused-session fetch on ordinary session-list
      // refreshes. The first paginated list often arrives while this request is
      // in flight; cancelling here leaves the deep link with no selected detail
      // panel even though the focused-session API succeeded.
    };
  }, [focusTarget, matchesFocusTarget, selectedKey, sessions]);

  // ── Re-fetch on filter change ──────────────────────────────────

  useEffect(() => {
    if (!initialFetchDoneRef.current) return;
    fetchSessions(1);
  }, [harnessFilter, kindFilter, modelFilter, channelFilter, searchFilter, dateFrom, dateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── WebSocket: sessions:snapshot ──────────────────────────────

  useEffect(() => {
    return subscribe('sessions:snapshot', (msg: { sessions?: Session[]; timestamp: number }) => {
      if (msg.sessions) {
        // Only replace if no filters active (snapshot is the full list)
        if (!harnessFilter && !kindFilter && !modelFilter && !channelFilter && !searchFilter && !dateFrom && !dateTo) {
          setSessions(prev => {
            const incomingByKey = new Map(
              (msg.sessions || []).map((incoming: Session) => [incoming.sessionKey, incoming]),
            );
            const existingKeys = new Set(prev.map(session => session.sessionKey));
            const refreshed = prev.map(existing => {
              const incoming = incomingByKey.get(existing.sessionKey);
              return incoming
                ? {
                    ...existing,
                    ...incoming,
                    task: incoming.task ?? existing.task ?? null,
                    steering: incoming.steering ?? existing.steering ?? null,
                  }
                : existing;
            });
            const newLive = (msg.sessions || [])
              .filter((incoming: Session) => isSessionLive(incoming) && !existingKeys.has(incoming.sessionKey));
            const merged = sortSessions([...newLive, ...refreshed]);

            const normalizedFocus = focusTarget?.trim();
            const focusedFromPrev = normalizedFocus
              ? prev.find(session => matchesFocusTarget(session, normalizedFocus))
              : null;
            return focusedFromPrev && !merged.some(session => session.sessionKey === focusedFromPrev.sessionKey)
              ? sortSessions([focusedFromPrev, ...merged])
              : merged;
          });
        }
      }
    });
  }, [subscribe, harnessFilter, kindFilter, modelFilter, channelFilter, searchFilter, dateFrom, dateTo]);

  // ── WebSocket: sessions:live-state ────────────────────────────

  useEffect(() => {
    return subscribe('sessions:live-state', (msg: { sessionKey: string; liveState: LiveState | null; timestamp: number }) => {
      setSessions(prev => {
        const updated = prev.map(s => {
          if (s.sessionKey !== msg.sessionKey) return s;
          // liveState=null means session ended (removed from gateway tracking)
          if (msg.liveState === null) {
            return {
              ...s,
              liveState: null,
              status: s.status === 'active' ? 'completed' : s.status,
              endedAt: s.endedAt || new Date().toISOString(),
            };
          }
          return {
            ...s,
            liveState: msg.liveState,
            lastActivityAt: msg.liveState?.lastActivity
              ? new Date(msg.liveState.lastActivity).toISOString()
              : s.lastActivityAt,
          };
        });
        return sortSessions(updated);
      });
    });
  }, [subscribe]);

  // ── WebSocket: sessions:updated ───────────────────────────────

  useEffect(() => {
    return subscribe('sessions:updated', (msg: { sessionKey: string; liveState?: LiveState; timestamp: number }) => {
      setSessions(prev => {
        const exists = prev.some(s => s.sessionKey === msg.sessionKey);
        if (!exists) {
          // New session appeared — trigger a refresh to get full metadata
          fetchSessions(1);
          return prev;
        }
        const updated = prev.map(s =>
          s.sessionKey === msg.sessionKey && msg.liveState
            ? {
                ...s,
                liveState: msg.liveState,
                lastActivityAt: msg.liveState.lastActivity
                  ? new Date(msg.liveState.lastActivity).toISOString()
                  : s.lastActivityAt,
              }
            : s
        );
        return sortSessions(updated);
      });
    });
  }, [subscribe, fetchSessions]);

  // ── WebSocket: sessions:completed ──────────────────────────────
  // Definitive signal that a session has ended (cron:finished, chat:final, cleanup).
  // Updates status to 'completed' and clears liveState so Stop button disappears.

  useEffect(() => {
    return subscribe('sessions:completed', (msg: { sessionKey: string; reason?: string; timestamp: number }) => {
      setSessions(prev => {
        const updated = prev.map(s =>
          s.sessionKey === msg.sessionKey
            ? {
                ...s,
                liveState: null,
                status: 'completed',
                endedAt: s.endedAt || new Date(msg.timestamp).toISOString(),
              }
            : s
        );
        return sortSessions(updated);
      });
    });
  }, [subscribe]);

  // ── Auto-select focused or first session ───────────────────────

  useEffect(() => {
    if (sessions.length === 0) return;

    const normalizedFocus = focusTarget?.trim();
    if (normalizedFocus) {
      const focused = sessions.find((session) => matchesFocusTarget(session, normalizedFocus));

      if (focused && focused.sessionKey !== selectedKey) {
        setSelectedKey(focused.sessionKey);
        return;
      }
    }

    if (selectedKey && !sessions.some(session => session.sessionKey === selectedKey)) {
      setSelectedKey(null);
    }
  }, [sessions, selectedKey, focusTarget, matchesFocusTarget]);

  // ── Handlers ──────────────────────────────────────────────────

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchSessions(1), fetchStats()]);
    setRefreshing(false);
  }, [fetchSessions, fetchStats]);

  const handleLoadMore = useCallback(async () => {
    if (!pagination || page >= pagination.totalPages) return;
    setLoadingMore(true);
    await fetchSessions(page + 1, true);
    setLoadingMore(false);
  }, [fetchSessions, page, pagination]);

  const resetFilters = useCallback(() => {
    setKindFilter('');
    setModelFilter('');
    setChannelFilter('');
    setHarnessFilter('');
    setSearchFilter('');
    setDateFrom('');
    setDateTo('');
  }, []);

  const hasFilters = !!(harnessFilter || kindFilter || modelFilter || channelFilter || searchFilter || dateFrom || dateTo);

  const selectedSession = useMemo(
    () => sessions.find(s => s.sessionKey === selectedKey)
      ?? (focusedSession?.sessionKey === selectedKey ? focusedSession : null),
    [focusedSession, sessions, selectedKey]
  );

  const operationCounts = useMemo(() => sessions.reduce((counts, session) => {
    const bucket = getSessionOperationsBucket({
      status: session.status,
      runtimeState: session.runtimeState,
      transcriptState: session.transcriptState,
      hasLiveState: session.liveState !== null,
    });
    counts[bucket] += 1;
    return counts;
  }, { active: 0, degraded: 0, history: 0 }), [sessions]);

  const visibleSessions = useMemo(() => operationsView === 'all'
    ? sessions
    : sessions.filter(session => getSessionOperationsBucket({
      status: session.status,
      runtimeState: session.runtimeState,
      transcriptState: session.transcriptState,
      hasLiveState: session.liveState !== null,
    }) === operationsView), [operationsView, sessions]);

  // ── Derive filter options from stats ──────────────────────────

  const kindOptions = useMemo(
    () => (stats?.byKind || []).map(b => b.kind).filter(Boolean),
    [stats]
  );
  const modelOptions = useMemo(
    () => (stats?.byModel || []).map(b => b.model).filter(Boolean),
    [stats]
  );
  const channelOptions = useMemo(
    () => (stats?.byChannel || []).map(b => b.channel).filter(Boolean),
    [stats]
  );

  // ── Render ────────────────────────────────────────────────────

  if (loading) return (
    <div className="page-loading">
      <div className="loading-spinner" />
      <span>Loading sessions…</span>
    </div>
  );

  const total = pagination?.total ?? sessions.length;

  return (
    <div className="sessions-page fade-in">
      {sidebarVisible && (
        <div className="sessions-backdrop" onClick={() => setSidebarVisible(false)} />
      )}

      {/* ── Left sidebar: session list ── */}
      <div className={`sessions-sidebar${sidebarVisible ? ' mobile-visible' : ''}`}>
        <div className="sessions-sidebar-header">
          <div className="sessions-sidebar-header-top">
            <h2>📋 Sessions</h2>
            <button className="sessions-sidebar-close" onClick={() => setSidebarVisible(false)}>
              <X size={20} />
            </button>
          </div>

          <StatsBar
            sessions={sessions}
            total={total}
            wsConnected={wsConnected}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          />

          <FilterBar
            kinds={kindOptions}
            models={modelOptions}
            channels={channelOptions}
            harnessFilter={harnessFilter}
            kindFilter={kindFilter}
            modelFilter={modelFilter}
            channelFilter={channelFilter}
            searchFilter={searchFilter}
            dateFrom={dateFrom}
            dateTo={dateTo}
            onHarness={setHarnessFilter}
            onKind={setKindFilter}
            onModel={setModelFilter}
            onChannel={setChannelFilter}
            onSearch={setSearchFilter}
            onDateFrom={setDateFrom}
            onDateTo={setDateTo}
            onReset={resetFilters}
            hasFilters={hasFilters}
          />
          <div className="sessions-operations-tabs" role="tablist" aria-label="Session lifecycle views">
            {([
              ['active', 'Active', operationCounts.active],
              ['degraded', 'Degraded', operationCounts.degraded],
              ['history', 'History', operationCounts.history],
              ['all', 'All', sessions.length],
            ] as const).map(([view, label, count]) => (
              <button
                key={view}
                type="button"
                role="tab"
                aria-selected={operationsView === view}
                className={`sessions-operations-tab${operationsView === view ? ' selected' : ''}`}
                onClick={() => setOperationsView(view)}
              >
                {label}<span>{count}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="sessions-list-scroll">
          {sessionsError ? (
            <div className="sessions-list-state sessions-list-error" role="alert">
              <AlertCircle size={16} />
              <div><strong>Sessions unavailable</strong><span>{sessionsError}</span></div>
              <button type="button" onClick={() => fetchSessions(1)}>Retry</button>
            </div>
          ) : visibleSessions.length === 0 ? (
            <div className="sessions-empty-small" role="status">
              {getSessionOperationsEmptyState(operationsView, hasFilters)}
            </div>
          ) : (
            (() => {
              // Build a label→count map to detect duplicates
              const labelCounts = new Map<string, number>();
              for (const s of visibleSessions) {
                const lbl = getDisplayLabel(s);
                labelCounts.set(lbl, (labelCounts.get(lbl) || 0) + 1);
              }
              // For duplicate labels, generate a short disambiguator from the session key
              const getDisambiguator = (s: Session): string | undefined => {
                const lbl = getDisplayLabel(s);
                if ((labelCounts.get(lbl) || 0) <= 1) return undefined;
                // Extract last UUID segment from session key (e.g. agent:main:cron:<uuid>)
                const parts = s.sessionKey.split(':');
                const uuidPart = parts[parts.length - 1];
                if (uuidPart && uuidPart.includes('-')) {
                  // Show last 8 chars of UUID
                  return uuidPart.slice(-8);
                }
                // Fallback: session_id short fragment
                return s.sessionId ? s.sessionId.slice(0, 8) : s.sessionKey.slice(-8);
              };
              return visibleSessions.map(s => (
                <SessionCard
                  key={s.sessionKey}
                  session={s}
                  isSelected={selectedKey === s.sessionKey}
                  disambiguateSuffix={getDisambiguator(s)}
                  onClick={() => {
                    setSelectedKey(s.sessionKey);
                    setSidebarVisible(false);
                  }}
                />
              ));
            })()
          )}

          {/* Load more */}
          {pagination && page < pagination.totalPages && (
            <button
              className="sessions-load-more"
              onClick={handleLoadMore}
              disabled={loadingMore}
            >
              {loadingMore
                ? <><Loader size={12} className="spin" /> Loading…</>
                : `Load more (${pagination.total - sessions.length} remaining)`}
            </button>
          )}
        </div>
      </div>

      {/* ── Right: session detail ── */}
      <div className="sessions-main">
        <button className="sessions-mobile-toggle" onClick={() => setSidebarVisible(true)}>
          📋 <span>Sessions</span>
        </button>

        {selectedSession ? (
          <SessionDetailPanel session={selectedSession} />
        ) : (
          <div className="sessions-no-selection">
            <div className="sessions-no-selection-icon">👈</div>
            <div className="sessions-no-selection-text">Select a session from the sidebar</div>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── SessionDetailPanel ──────────────────────────────────────────

interface SessionDetailPanelProps {
  session: Session;
}

const SessionDetailPanel: React.FC<SessionDetailPanelProps> = ({ session }) => {
  const sessionKey = session.sessionKey;
  const isActive = isSessionActive(session);
  const isLive = isSessionLive(session);
  const status = getSessionStatus(session);

  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [transcriptUnavailable, setTranscriptUnavailable] = useState(false);
  const [linkedTask, setLinkedTask] = useState<SessionTaskLink | null>(session.task || null);
  const [steeringInfo, setSteeringInfo] = useState<SessionSteeringInfo | null>(session.steering || null);
  const [advancedDetailsOpen, setAdvancedDetailsOpen] = useState(() => localStorage.getItem('sessionsAdvancedDetailsOpen') === '1');
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [msgOffset, setMsgOffset] = useState(0);
  const [olderLoading, setOlderLoading] = useState(false);
  // Track whether user loaded older messages, so polls don't wipe them
  const hasLoadedOlderRef = useRef(false);
  const tailSizeRef = useRef(0);

  // Derived tool calls from messages
  const tools = useMemo(() => extractToolCalls(messages), [messages]);

  // Tool expand state (parent-owned so it persists across re-renders)
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(new Set());
  const [newMsgsAvailable, setNewMsgsAvailable] = useState(false);
  const [newToolsAvailable, setNewToolsAvailable] = useState(false);

  // Resizable split
  const [splitRatio, setSplitRatio] = useState(() => {
    const saved = localStorage.getItem('sessionsPanelSplitV');
    return saved ? parseFloat(saved) : 60;
  });
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesListRef = useRef<HTMLDivElement>(null);
  const toolsEndRef = useRef<HTMLDivElement>(null);
  const toolsListRef = useRef<HTMLDivElement>(null);
  const msgsAtBottom = useRef(true);
  const toolsAtBottom = useRef(true);
  const initialScrollDoneRef = useRef(false);
  const toolsInitialScrollDoneRef = useRef(false);


  // ── Drag-to-resize split ───────────────────────────────────────


  useEffect(() => {
    localStorage.setItem('sessionsAdvancedDetailsOpen', advancedDetailsOpen ? '1' : '0');
  }, [advancedDetailsOpen]);

  useEffect(() => {
    if (!isDragging) return;
    const update = (y: number) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const ratio = Math.max(20, Math.min(80, ((y - rect.top) / rect.height) * 100));
      setSplitRatio(ratio);
      localStorage.setItem('sessionsPanelSplitV', ratio.toString());
    };
    const onMove = (e: MouseEvent) => update(e.clientY);
    const onTouch = (e: TouchEvent) => { e.preventDefault(); update(e.touches[0].clientY); };
    const onEnd = () => setIsDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onTouch, { passive: false });
    document.addEventListener('touchend', onEnd);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onTouch);
      document.removeEventListener('touchend', onEnd);
    };
  }, [isDragging]);

  // ── Reset state on session switch ─────────────────────────────

  useEffect(() => {
    setMessages([]);
    setMessagesLoading(true);
    setTranscriptUnavailable(false);
    setLinkedTask(session.task || null);
    setSteeringInfo(session.steering || null);
    setHasOlderMessages(false);
    setMsgOffset(0);
    setOlderLoading(false);
    setExpandedToolIds(new Set());
    setNewMsgsAvailable(false);
    setNewToolsAvailable(false);
    initialScrollDoneRef.current = false;
    toolsInitialScrollDoneRef.current = false;
    msgsAtBottom.current = true;
    toolsAtBottom.current = true;
    hasLoadedOlderRef.current = false;
    tailSizeRef.current = 0;
  }, [sessionKey]);

  useEffect(() => {
    if (session.task) {
      setLinkedTask(session.task);
    }
    if (session.steering) {
      setSteeringInfo(session.steering);
    }
  }, [session.task, session.steering]);

  // ── Fetch linked task/session metadata ─────────────────────────

  useEffect(() => {
    if (!sessionKey) return;
    let cancelled = false;

    const fetchSessionMeta = async () => {
      if (session.task && session.steering) return;
      try {
        const r = await authenticatedFetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionKey)}`);
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled && d.success) {
          setLinkedTask(d.session?.task || null);
          setSteeringInfo(d.session?.steering || null);
        }
      } catch (err) {
        console.error('[SessionDetail] session fetch:', err);
      }
    };

    fetchSessionMeta();

    return () => {
      cancelled = true;
    };
  }, [sessionKey, session.task, session.steering]);

  // ── Fetch messages (poll for live, once for completed) ────────

  useEffect(() => {
    if (!sessionKey) return;
    let cancelled = false;

    const fetchMessages = async () => {
      try {
        const url = `${API_BASE_URL}/sessions/${encodeURIComponent(sessionKey)}/messages?limit=50&offset=0`;
        const r = await authenticatedFetch(url);
        if (!r.ok) {
          if (r.status === 404 && !cancelled) setTranscriptUnavailable(true);
          return;
        }
        const d = await r.json();
        if (!cancelled && d.success) {
          const msgs = (d.messages || []).map((m: any) => ({
            role: m.role,
            text: m.content || m.text || '',
            timestamp: m.timestamp || null,
            toolName: m.toolName,
            toolCallId: m.toolCallId,
          }));
          const fetchedOffset = typeof d.offset === 'number' ? d.offset : 0;

          if (hasLoadedOlderRef.current) {
            // User loaded older messages — preserve them, only replace the tail
            setMessages(prev => {
              const olderCount = Math.max(0, prev.length - tailSizeRef.current);
              const olderMessages = prev.slice(0, olderCount);
              return [...olderMessages, ...msgs];
            });
            tailSizeRef.current = msgs.length;
            // Don't update msgOffset or hasOlderMessages — older state is authoritative
          } else {
            // No older messages loaded — safe to replace entirely
            setMessages(msgs);
            setMsgOffset(fetchedOffset);
            setHasOlderMessages(d.hasMore === true || fetchedOffset > 0);
            tailSizeRef.current = msgs.length;
          }
        }
      } catch (err) {
        console.error('[SessionDetail] messages fetch:', err);
      } finally {
        if (!cancelled) setMessagesLoading(false);
      }
    };

    fetchMessages();
    // Poll for live sessions
    const interval = isLive
      ? setInterval(fetchMessages, isActive ? 5000 : 10000)
      : undefined;

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [sessionKey, isLive, isActive]);

  // ── Load older messages ───────────────────────────────────────

  const loadOlderMessages = useCallback(async () => {
    if (!hasOlderMessages || olderLoading || msgOffset <= 0) return;
    // Load 50 messages ending just before current offset
    const olderEnd = msgOffset;
    const olderStart = Math.max(0, olderEnd - 50);
    setOlderLoading(true);
    try {
      const url = `${API_BASE_URL}/sessions/${encodeURIComponent(sessionKey)}/messages?limit=${olderEnd - olderStart}&offset=${olderStart}&tail=false`;
      const r = await authenticatedFetch(url);
      if (!r.ok) return;
      const d = await r.json();
      if (d.success) {
        const older = (d.messages || []).map((m: any) => ({
          role: m.role,
          text: m.content || m.text || '',
          timestamp: m.timestamp || null,
          toolName: m.toolName,
          toolCallId: m.toolCallId,
        }));
        setMessages(prev => [...older, ...prev]);
        setHasOlderMessages(olderStart > 0);
        setMsgOffset(olderStart);
        hasLoadedOlderRef.current = true;
      }
    } catch (err) {
      console.error('[SessionDetail] loadOlderMessages:', err);
    } finally {
      setOlderLoading(false);
    }
  }, [sessionKey, hasOlderMessages, olderLoading, msgOffset]);

  // ── Auto-scroll ───────────────────────────────────────────────

  useEffect(() => {
    if (!messagesLoading && messages.length > 0 && !initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      });
    }
  }, [messagesLoading, messages.length]);

  useEffect(() => {
    if (messages.length === 0 || !initialScrollDoneRef.current) return;
    if (msgsAtBottom.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setNewMsgsAvailable(false);
    } else {
      setNewMsgsAvailable(true);
    }
  }, [messages]);

  // Tools: initial scroll to bottom
  useEffect(() => {
    if (tools.length > 0 && !toolsInitialScrollDoneRef.current) {
      toolsInitialScrollDoneRef.current = true;
      requestAnimationFrame(() => {
        toolsEndRef.current?.scrollIntoView({ behavior: 'auto' });
      });
    }
  }, [tools.length]);

  // Tools: auto-scroll on new tools or show "new tools" popup
  useEffect(() => {
    if (tools.length === 0 || !toolsInitialScrollDoneRef.current) return;
    if (toolsAtBottom.current) {
      toolsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setNewToolsAvailable(false);
    } else {
      setNewToolsAvailable(true);
    }
  }, [tools]);

  // ── Derived display values ────────────────────────────────────

  const label = getDisplayLabel(session);
  const tokenUsage = getSessionTokenUsage(session);
  const tokenTotal = tokenUsage.total;
  const toolsByCallId = new Map(tools.filter(tool => tool.id).map(tool => [tool.id, tool]));
  // Prefer backend-linked task metadata, fallback to label parsing for older sessions
  const taskIdMatch = label.match(/spawn-task-([a-f0-9-]+)/i) || label.match(/task[- ]([a-f0-9-]{8,})/i);
  const taskId = linkedTask?.id?.slice(0, 8) || taskIdMatch?.[1]?.slice(0, 8);
  const taskHref = linkedTask?.id ? `/dashboard/tasks?task=${linkedTask.id}` : (taskId ? `/dashboard/tasks?task=${taskId}` : null);

  // Runtime
  const runtime = isLive && session.liveState
    ? (isActive ? formatElapsed(session.liveState.lastActivity) : '—')
    : formatRuntime(session.startedAt, session.endedAt);

  const runtimeLabel = getRuntimeLabel(session, linkedTask);
  const accessProfile = linkedTask?.executionProfile?.accessProfile || null;
  const capabilities = getExecutionCapabilities(linkedTask?.executionProfile);
  const recentTools = Array.from(new Set([
    ...((session.liveState?.recentTools || []).map(tool => String(tool))),
    ...tools.map(tool => tool.name).filter(Boolean),
  ])).slice(0, 8);

  // Spawn info
  const spawnInfo = session.spawnInfo || {};
  const spawnedBy = spawnInfo.spawnedBy || spawnInfo.parentSessionKey;
  const spawnDepth = spawnInfo.spawnDepth;
  const deliveryContext = spawnInfo.deliveryContext || null;

  const contextTelemetry = session.contextTelemetry || {
    mode: 'unavailable' as const,
    usedTokens: tokenTotal,
    maxTokens: null,
    percent: null,
    fresh: false,
    compactionCount: null,
    memoryFlushAt: null,
    headline: 'Context telemetry unavailable',
    detail: 'This session does not expose a current context-window reading.',
    note: 'Showing token totals only is safer here than pretending we know the current window fill.',
    level: 'muted' as const,
  };
  const advancedSummary = [
    linkedTask ? `Task ${linkedTask.id.slice(0, 8)}` : 'No linked task',
    capabilities.length > 0 ? `${capabilities.length} capabilities` : 'No capability metadata',
    deliveryContext?.channel ? `Delivery: ${deliveryContext.channel}` : 'Session and delivery IDs',
  ].join(' · ');
  const agentTypeMeta = linkedTask?.agentType && typeof linkedTask.agentType === 'object' ? linkedTask.agentType : null;
  const agentLabel = agentTypeMeta?.name || linkedTask?.agentName || session.kind || 'Unknown';
  const discordThreadUrl = buildDiscordThreadUrl(linkedTask?.discordThreadId, linkedTask?.discordThreadUrl);
  const discordThreadLabel = linkedTask?.discordThreadId ? `${linkedTask.discordThreadId.slice(0, 8)}…` : null;
  const operationsReason = getSessionOperationsReason({
    status: session.status,
    runtimeState: session.runtimeState,
    runtimeStateReason: session.runtimeStateReason,
    transcriptState: session.transcriptState,
    transcriptStateReason: session.transcriptStateReason,
    hasLiveState: session.liveState !== null,
  });
  const lastActivity = getSessionLastActivity(session);
  const showSteeringComposer = Boolean(steeringInfo?.supported || (isLive && steeringInfo?.reason));
  const steeringDescription = linkedTask
    ? `Linked task ${linkedTask.id.slice(0, 8)}. Steering stays in this session, transcript remains below.`
    : (sessionKey.endsWith(':main') || session.kind === 'main')
      ? 'Send a message directly into the live main session from here.'
      : 'Send a message directly into this live session from here.';

  return (
    <div className="session-detail">
      {/* ── Header ── */}
      <div className="session-detail-header">
        <div className="session-detail-inline-bar">
          <div className="session-detail-title session-inline-title">
            <StatusDot sessionStatus={status} size="md" />
            <h2 title={label}>{label}</h2>
            {isActive && <span className="session-status-badge busy">● Live</span>}
            {!isLive && session.status && session.status !== 'active' && (
              <span className={`session-status-badge ${session.status}`}>{session.status}</span>
            )}
          </div>

          <div className="session-advanced-details-inline">
            <button
              className={`session-advanced-toggle ${advancedDetailsOpen ? 'open' : ''}`}
              onClick={() => setAdvancedDetailsOpen(open => !open)}
              type="button"
              aria-expanded={advancedDetailsOpen}
            >
              <div className="session-advanced-toggle-copy">
                <span className="session-advanced-toggle-title">More</span>
                <span className="session-advanced-toggle-summary">{advancedSummary.replace('No linked task', 'No task').replace('No capability metadata', 'No caps').replace('Session and delivery IDs', 'IDs').replace('Delivery: ', '')}</span>
              </div>
              {advancedDetailsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          </div>

          <div className="session-detail-header-actions session-inline-actions">
            {taskHref && (
              <a
                className="session-task-link"
                href={taskHref}
                target="_blank"
                rel="noopener noreferrer"
                title={linkedTask ? `${linkedTask.title} (${taskId})` : `Task ${taskId}`}
              >
                <ExternalLink size={14} /><span>{linkedTask ? 'Task' : 'Task ref'}</span>
              </a>
            )}
            {discordThreadUrl && (
              <a
                className="session-task-link"
                href={discordThreadUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={linkedTask?.discordThreadId || 'Discord steering thread'}
              >
                <Globe size={14} /><span>Discord</span>
              </a>
            )}
            {isActive && (
              <StopButton session={session} compact />
            )}
          </div>
        </div>

        <div className={`session-operational-summary${operationsReason ? ' degraded' : ''}`}>
          <span><strong>Harness state:</strong> {session.runtimeState || session.status || 'Unavailable'}</span>
          <span title={lastActivity ? formatDateTimeLong(lastActivity) : undefined}>
            <strong>Last activity:</strong> {lastActivity ? formatTimeAgo(lastActivity) : 'Unavailable'}
          </span>
          <span><strong>Persona:</strong> {agentLabel}</span>
          {spawnedBy && <span className="session-operational-parent" title={String(spawnedBy)}><strong>Parent:</strong> {String(spawnedBy)}</span>}
          {operationsReason && <span className="session-operational-reason"><strong>Reason:</strong> {operationsReason}</span>}
        </div>

        <div className="session-usage-summary" aria-label="Canonical session token usage">
          <span><strong>Input:</strong> {formatTokens(tokenUsage.input)}</span>
          <span><strong>Output:</strong> {formatTokens(tokenUsage.output)}</span>
          <span><strong>Thinking:</strong> {formatTokens(tokenUsage.thinking)}</span>
          <span><strong>Total:</strong> {formatTokens(tokenUsage.total)}</span>
          <span className="session-usage-source" title="The total is derived once from canonical session input, output, and thinking aggregates.">
            Source: canonical session aggregate
          </span>
        </div>

        <div className="session-advanced-details">
          {advancedDetailsOpen && (
            <div className="session-detail-info-grid">
              <div className="session-info-card">
                <div className="session-info-card-title">Linked task</div>
                <div className="session-info-card-body">
                  {linkedTask ? (
                    <>
                      <div><strong>{linkedTask.title}</strong> <span className="session-info-muted">({linkedTask.id.slice(0, 8)})</span></div>
                      <div className="session-info-row"><span>Status</span><strong>{linkedTask.status}</strong></div>
                      <div className="session-info-row"><span>Thinking</span><strong>{linkedTask.thinking || 'Unavailable'}</strong></div>
                      <div className="session-info-row"><span>Access</span><strong>{formatAccessProfile(accessProfile)}</strong></div>
                      <div className="session-info-row"><span>Linkage</span><strong>{linkedTask.sessionMatch === 'acpSessionKey' ? 'Direct session key' : 'Active agent'}</strong></div>
                      {discordThreadLabel && (
                        <div className="session-info-row"><span>Discord</span><strong>{discordThreadLabel}</strong></div>
                      )}
                    </>
                  ) : (
                    <div className="session-info-muted">No linked task metadata found for this session.</div>
                  )}
                </div>
              </div>

              <div className="session-info-card">
                <div className="session-info-card-title">Capabilities and tools</div>
                <div className="session-info-card-body">
                  <div className="session-chip-row">
                    {capabilities.length > 0 ? capabilities.map(capability => (
                      <span key={capability} className="session-info-chip">{formatCapability(capability)}</span>
                    )) : <span className="session-info-muted">No explicit capabilities advertised.</span>}
                  </div>
                  <div className="session-info-subtitle">Recent tools</div>
                  <div className="session-chip-row">
                    {recentTools.length > 0 ? recentTools.map(tool => (
                      <span key={tool} className="session-info-chip session-info-chip-muted">{tool}</span>
                    )) : <span className="session-info-muted">No tool activity yet.</span>}
                  </div>
                </div>
              </div>

              <div className="session-info-card">
                <div className="session-info-card-title">Execution details</div>
                <div className="session-info-card-body">
                  <div className="session-info-row"><span>Agent</span><strong>{agentLabel}</strong></div>
                  <div className="session-info-row"><span>Harness</span><strong>{getHarnessLabel(session)}</strong></div>
                  <div className="session-info-row"><span>Type</span><strong>{getSessionTypeLabel(session)}</strong></div>
                  <div className="session-info-row"><span>Runtime</span><strong>{runtimeLabel}</strong></div>
                  {session.runtimeStateReason && <div className="session-info-row"><span>Runtime reason</span><strong>{session.runtimeStateReason}</strong></div>}
                  <div className="session-info-row"><span>Last activity</span><strong>{lastActivity ? `${formatTimeAgo(lastActivity)} · ${formatDateTimeLong(lastActivity)}` : 'Unavailable'}</strong></div>
                  <div className="session-info-row"><span>Transcript</span><strong>{session.transcriptState || 'Unavailable'}</strong></div>
                  {session.transcriptStateReason && <div className="session-info-row"><span>Transcript reason</span><strong>{session.transcriptStateReason}</strong></div>}
                  <div className="session-info-row"><span>Elapsed</span><strong>{runtime}</strong></div>
                  <div className="session-info-row"><span>Model</span><strong>{linkedTask?.model || session.model || 'Unavailable'}</strong></div>
                  <div className="session-info-row"><span>Context</span><strong className={`session-context-${contextTelemetry.level}`}>{contextTelemetry.headline}</strong></div>
                  {tokenTotal > 0 && <div className="session-info-row"><span>Tokens</span><strong>{formatTokens(tokenTotal)}</strong></div>}
                  {contextTelemetry.maxTokens != null && <div className="session-info-row"><span>Window</span><strong>{formatTokens(contextTelemetry.maxTokens)}</strong></div>}
                  {contextTelemetry.compactionCount != null && <div className="session-info-row"><span>Compactions</span><strong>{contextTelemetry.compactionCount}</strong></div>}
                  {session.totalCost > 0 && <div className="session-info-row"><span>Cost</span><strong>{formatCost(session.totalCost)}</strong></div>}
                  {session.messageCount > 0 && <div className="session-info-row"><span>Messages</span><strong>{session.messageCount}</strong></div>}
                  {session.toolCallCount > 0 && <div className="session-info-row"><span>Tool calls</span><strong>{session.toolCallCount}</strong></div>}
                  {session.channel && session.channel !== 'unknown' && <div className="session-info-row"><span>Channel</span><strong>{session.channel}</strong></div>}
                  <div className="session-info-row"><span>Session key</span><strong>{session.sessionKey}</strong></div>
                  {session.sessionId && <div className="session-info-row"><span>Session ID</span><strong>{session.sessionId}</strong></div>}
                  {spawnedBy && <div className="session-info-row"><span>Spawned by</span><strong>{String(spawnedBy)}</strong></div>}
                  {spawnDepth != null && <div className="session-info-row"><span>Depth</span><strong>{spawnDepth}</strong></div>}
                  {deliveryContext?.channel && <div className="session-info-row"><span>Delivery</span><strong>{deliveryContext.channel}</strong></div>}
                  {deliveryContext?.to && <div className="session-info-row"><span>Destination</span><strong>{deliveryContext.to}</strong></div>}
                  {session.fileSize != null && <div className="session-info-row"><span>Transcript size</span><strong>{(session.fileSize / 1024).toFixed(1)} KB</strong></div>}
                  {agentTypeMeta?.category && <div className="session-info-row"><span>Agent category</span><strong>{agentTypeMeta.category}</strong></div>}
                  <div className="session-info-subtitle">Context semantics</div>
                  <div className="session-info-muted">{contextTelemetry.detail}</div>
                  <div className="session-info-muted">{contextTelemetry.note}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Content panels ── */}
      <div className="session-detail-content" ref={containerRef}>
        {/* Messages panel */}
        <div className="session-messages-panel" style={{ height: `${splitRatio}%` }}>
          <div className="session-panel-header">
            <h3>
              💬 Activity timeline
              {messages.length > 0 && (
                <span className="session-panel-count">{messages.length}</span>
              )}
            </h3>
            {hasOlderMessages && (
              <button className="session-load-all-btn" onClick={loadOlderMessages} disabled={olderLoading}>
                {olderLoading ? <><Loader size={12} className="spin" /> Loading older…</> : '↑ Load older'}
              </button>
            )}
          </div>

          {newMsgsAvailable && (
            <div
              className="session-new-msgs-pill"
              onClick={() => {
                msgsAtBottom.current = true;
                setNewMsgsAvailable(false);
                messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              New messages ↓
            </div>
          )}

          <div
            className="session-messages-list"
            ref={messagesListRef}
            onScroll={() => {
              const el = messagesListRef.current;
              if (!el) return;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
              msgsAtBottom.current = atBottom;
              if (atBottom) setNewMsgsAvailable(false);
            }}
          >
            {messagesLoading ? (
              <div className="session-panel-loading">
                <Loader size={16} className="spin" /><span>Loading…</span>
              </div>
            ) : messages.length === 0 ? (
              <div className="session-panel-empty">
                {getSessionMessagesEmptyState({
                  runtimeState: session.runtimeState,
                  runtimeStateReason: session.runtimeStateReason,
                  transcriptState: session.transcriptState,
                  transcriptStateReason: session.transcriptStateReason,
                  messageCount: session.messageCount,
                  transcriptUnavailable,
                  isActive,
                  isLive,
                })}
              </div>
            ) : (
              <>
                {messages.map((msg, idx) => {
                  if (msg.role === 'tool') return null;
                  if (msg.role === 'assistant' && msg.toolName) {
                    const tool = (msg.toolCallId ? toolsByCallId.get(msg.toolCallId) : undefined)
                      || tools.find(candidate => candidate.name === msg.toolName && candidate.timestamp === msg.timestamp);
                    if (!tool) return <MessageEntry key={`tool-message-${msg.timestamp}-${idx}`} message={msg} />;
                    const key = tool.id || `${tool.name}-${idx}`;
                    return (
                      <ToolCallEntry
                        key={`timeline-${key}`}
                        tool={tool}
                        expanded={expandedToolIds.has(key)}
                        onToggle={() => setExpandedToolIds(prev => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key); else next.add(key);
                          return next;
                        })}
                      />
                    );
                  }
                  return <MessageEntry key={`${msg.role}-${msg.timestamp}-${idx}`} message={msg} />;
                })}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {showSteeringComposer && steeringInfo && (
            <div className="session-task-steering-wrap session-task-steering-wrap-bottom">
              <SessionSteeringComposer
                sessionKey={steeringInfo.targetSessionKey || sessionKey}
                enabled={steeringInfo.supported}
                disabledReason={steeringInfo.reason}
                attachmentSupport={steeringInfo.attachmentSupport || null}
                title={linkedTask ? 'Task and session steering' : 'Session steering'}
                description={steeringDescription}
                inputPlaceholder={linkedTask
                  ? 'Steer the linked task without leaving Sessions...'
                  : 'Steer this live session without leaving Sessions...'}
                compact
              />
            </div>
          )}
        </div>

        {/* Resizable divider */}
        <div
          className={`panel-divider${isDragging ? ' dragging' : ''}`}
          onMouseDown={() => setIsDragging(true)}
          onTouchStart={() => setIsDragging(true)}
        />

        {/* Tools panel */}
        <div className="session-tools-panel" style={{ height: `${100 - splitRatio}%` }}>
          <div className="session-panel-header">
            <h3>
              <Wrench size={14} /> Tool call index
              {tools.length > 0 && (
                <span className="session-tools-count">{tools.length}</span>
              )}
            </h3>
            {hasOlderMessages && (
              <button className="session-load-all-btn" onClick={loadOlderMessages} disabled={olderLoading}>
                {olderLoading ? <><Loader size={12} className="spin" /> Loading older…</> : '↑ Load older'}
              </button>
            )}
          </div>
          <div
            className="session-tools-list"
            ref={toolsListRef}
            onScroll={() => {
              const el = toolsListRef.current;
              if (el) toolsAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 50) {
                setNewToolsAvailable(false);
              }
            }}
          >
            {tools.length === 0 ? (
              <div className="session-panel-empty">
                {isActive ? 'No tool calls yet' : 'No tool calls recorded'}
              </div>
            ) : (
              tools.map((tool, idx) => (
                <ToolCallEntry
                  key={`${tool.name}-${tool.timestamp}-${idx}`}
                  tool={tool}
                  expanded={expandedToolIds.has(tool.id || `${tool.name}-${idx}`)}
                  onToggle={() => {
                    const key = tool.id || `${tool.name}-${idx}`;
                    setExpandedToolIds(prev => {
                      const next = new Set(prev);
                      if (next.has(key)) next.delete(key); else next.add(key);
                      return next;
                    });
                  }}
                />
              ))
            )}
            <div ref={toolsEndRef} />
          </div>
          {newToolsAvailable && (
            <button className="session-new-msgs-btn" onClick={() => {
              toolsAtBottom.current = true;
              setNewToolsAvailable(false);
              toolsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
            }}>
              ↓ New tool calls
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── MessageEntry ────────────────────────────────────────────────

const TRUNCATE_LENGTH = 200;

/** Render markdown text to sanitized HTML */
function renderMarkdown(text: string): string {
  try {
    return marked.parse(text) as string;
  } catch {
    return text;
  }
}

const MessageEntry: React.FC<{ message: TranscriptMessage }> = ({ message }) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const ri = getRoleInfo(message.role);
  const ts = message.timestamp ? new Date(message.timestamp).getTime() : 0;
  const absoluteTime = ts > 0 ? formatDateTimeLong(ts) : '';

  // Compact pill for pure tool call messages (no text, just a tool invocation)
  const isPureToolCall = message.role === 'assistant' && !message.text?.trim() && !!message.toolName;
  if (isPureToolCall) {
    return (
      <div className={`session-message ${ri.className} role-assistant-tool-compact`}>
        <div className="session-message-header">
          <span className="session-message-role">
            <span className="session-role-icon">⚡</span>Tool Call
          </span>
          {ts > 0 && <span className="session-message-time" title={absoluteTime}>{formatTimeAgo(ts)}</span>}
        </div>
        <div className="session-message-tool-compact">[{message.toolName}]</div>
      </div>
    );
  }

  const rawText = message.fullText || message.text || '';
  const needsTruncation = rawText.length > TRUNCATE_LENGTH;
  const displayText = !expanded && needsTruncation
    ? rawText.slice(0, TRUNCATE_LENGTH)
    : rawText;

  // Render markdown
  const renderedHtml = useMemo(() => renderMarkdown(displayText), [displayText]);

  // Copy raw text to clipboard
  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, [rawText]);

  return (
    <div className={`session-message ${ri.className}`}>
      <div className="session-message-header">
        <span className="session-message-role">
          <span className="session-role-icon">{ri.icon}</span>{ri.label}
        </span>
        <div className="session-message-header-right">
          <button
            className={`session-message-copy-btn${copied ? ' copied' : ''}`}
            onClick={handleCopy}
            title="Copy raw text"
          >
            {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
          </button>
          {ts > 0 && <span className="session-message-time" title={absoluteTime}>{formatTimeAgo(ts)}</span>}
        </div>
      </div>
      <div
        ref={contentRef}
        className={`session-message-text markdown-body${expanded ? ' expanded' : ''}${needsTruncation && !expanded ? ' truncated' : ''}`}
        dangerouslySetInnerHTML={{ __html: renderedHtml + (needsTruncation && !expanded ? '<span class="truncation-ellipsis">…</span>' : '') }}
      />
      {needsTruncation && (
        <button
          className="session-message-toggle"
          onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
        >
          {expanded ? 'Show less ▲' : 'Show more ▾'}
        </button>
      )}
    </div>
  );
};

// CodeHighlightedText removed — markdown rendering with highlight.js handles code blocks

// ─── ScreenshotImage ─────────────────────────────────────────────

const ScreenshotImage: React.FC<{ relativePath: string; filename: string }> = ({ relativePath, filename }) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authenticatedFetch(`${API_BASE_URL}/gateway/media/${relativePath}`);
        if (!r.ok) { setError(true); return; }
        const blob = await r.blob();
        if (!cancelled) setBlobUrl(URL.createObjectURL(blob));
      } catch { if (!cancelled) setError(true); }
    })();
    return () => { cancelled = true; };
  }, [relativePath]);

  if (error) return <span style={{ color: '#e74c3c', fontSize: '12px' }}>⚠️ {filename}</span>;
  if (!blobUrl) return null;

  return (
    <>
      <img
        src={blobUrl}
        alt={filename}
        style={{ maxWidth: '100%', maxHeight: '300px', borderRadius: '8px', cursor: 'pointer', marginBottom: '8px' }}
        onClick={e => { e.stopPropagation(); setLightbox(true); }}
      />
      {lightbox && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          onClick={() => setLightbox(false)}
        >
          <img src={blobUrl} alt={filename} style={{ maxWidth: '95vw', maxHeight: '95vh' }} />
        </div>
      )}
    </>
  );
};

// ─── ToolCallEntry ───────────────────────────────────────────────

function extractMediaImages(text: string) {
  const re = /MEDIA:([^\s]+\.(?:jpg|jpeg|png|gif|webp))/gi;
  const images: { filename: string; relativePath: string }[] = [];
  let clean = text;
  let m;
  while ((m = re.exec(text)) !== null) {
    const fp = m[1];
    const idx = fp.indexOf('/media/');
    const rp = idx !== -1 ? fp.substring(idx + 7) : fp.split('/').slice(-2).join('/');
    images.push({ filename: fp.split('/').pop() || 'img', relativePath: rp });
    clean = clean.replace(m[0], '').trim();
  }
  return { cleanText: clean, images };
}

const ToolCallEntry: React.FC<{
  tool: ApiToolCall;
  expanded: boolean;
  onToggle: () => void;
}> = ({ tool, expanded, onToggle }) => {
  const [copied, setCopied] = useState(false);
  const type = getToolType(tool.name);
  const hasOutput = !!tool.output;
  const ts = tool.timestamp ? new Date(tool.timestamp).getTime() : Date.now();

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!tool.output) return;
    try {
      await navigator.clipboard.writeText(String(tool.output));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, [tool.output]);

  return (
    <div className={`session-tool-entry ${tool.status || 'done'} ${type}`}>
      <div
        className={`session-tool-header${hasOutput ? ' session-tool-header-clickable' : ''}`}
        onClick={hasOutput ? onToggle : undefined}
      >
        <div className="session-tool-name-row">
          <span className={`session-tool-icon-badge ${type}`}>{getToolIcon(tool.name)}</span>
          <span className="session-tool-display-name">{getToolDisplayName(tool.name)}</span>
          {tool.status === 'running' && <Loader size={11} className="session-tool-spinner spin" />}
          {tool.status === 'error' && <AlertCircle size={11} className="session-tool-error-icon" />}
          {tool.status === 'done' && <CheckCircle2 size={11} className="session-tool-done-icon" />}
        </div>
        <div className="session-tool-meta">
          {tool.durationMs != null && (
            <span className="session-tool-duration">{formatDuration(tool.durationMs)}</span>
          )}
          <span className="session-tool-time">{formatTimeAgo(ts)}</span>
          {hasOutput && (
            <button
              className="session-tool-chevron-btn"
              onClick={e => { e.stopPropagation(); onToggle(); }}
              title={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          )}
        </div>
      </div>

      {tool.input && (() => {
        // Try to parse JSON input and extract meaningful display text
        let displayInput = tool.input;
        try {
          const parsed = JSON.parse(tool.input);
          if (type === 'exec' && parsed.command) {
            displayInput = parsed.command;
          } else if (type === 'file' && (parsed.file_path || parsed.path)) {
            displayInput = parsed.file_path || parsed.path;
          } else if (type === 'browser' && (parsed.url || parsed.action)) {
            displayInput = parsed.url || `${parsed.action}${parsed.ref ? ` ref=${parsed.ref}` : ''}`;
          } else if (parsed.query) {
            displayInput = parsed.query;
          } else if (parsed.url) {
            displayInput = parsed.url;
          }
        } catch { /* not JSON, use as-is */ }

        return (
          <div className={`session-tool-input-block ${type}`}>
            {type === 'exec'
              ? <div className="session-terminal-input">
                  <span className="session-terminal-prompt">$</span>
                  <code>{displayInput.startsWith('$ ') ? displayInput.slice(2) : displayInput}</code>
                </div>
              : type === 'browser'
                ? <div className="session-browser-input">
                    <Globe size={11} className="session-browser-url-icon" />
                    <span className="session-browser-url">{displayInput}</span>
                  </div>
                : type === 'file'
                  ? <div className="session-file-input"><FileText size={11} /><code>{displayInput}</code></div>
                  : <div className="session-generic-input"><code>{displayInput}</code></div>}
          </div>
        );
      })()}

      {expanded && tool.output && (() => {
        const { cleanText, images } = extractMediaImages(String(tool.output));
        return (
          <div className={`session-tool-output-block ${type}`} onClick={e => e.stopPropagation()}>
            <div className="session-tool-output-actions">
              <button className="session-tool-copy-btn" onClick={handleCopy}>
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            {images.map((img, i) => (
              <ScreenshotImage key={i} relativePath={img.relativePath} filename={img.filename} />
            ))}
            {cleanText && (
              type === 'exec'
                ? <div className="session-terminal-output"><pre>{cleanText}</pre></div>
                : <div className="session-generic-output"><pre>{cleanText}</pre></div>
            )}
          </div>
        );
      })()}
    </div>
  );
};
