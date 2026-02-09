import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Clock,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Zap,
  Brain,
  Wrench,
  PenTool,
  Radio,
  Loader,
  Terminal,
  Globe,
  FileText,
  Search,
  AlertCircle,
  CheckCircle2,
  FolderOpen,
  Square,
} from 'lucide-react';
import { authenticatedFetch } from '../../utils/auth';
import { useWebSocket } from '../../hooks/useWebSocket';
import './MessageQueueWidget.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
const TOOLS_COMPACT_LIMIT = 3;

/* Error Boundary for catching render errors */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  { hasError: boolean; error: Error | null; errorInfo: React.ErrorInfo | null }
> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(_error: Error) {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    this.setState({ error, errorInfo });
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      
      return (
        <div className="mq-error-fallback">
          <AlertCircle size={16} style={{ color: '#e74c3c' }} />
          <span>⚠️ Failed to render component</span>
          {this.state.error && (
            <details style={{ marginTop: '8px', fontSize: '11px', opacity: 0.7 }}>
              <summary style={{ cursor: 'pointer' }}>Show error</summary>
              <pre style={{ marginTop: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {this.state.error.toString()}
                {this.state.errorInfo?.componentStack}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

interface ToolCall {
  name: string;
  input?: string;
  output?: string;
  timestamp: number;
  status: 'running' | 'done';
}

interface SessionQueueState {
  sessionKey: string;
  sessionId: string;
  displayName: string;
  label: string;
  channel: string;
  state: 'idle' | 'busy' | 'thinking' | 'tool-use' | 'typing';
  lastActivity: number;
  lastMessage?: {
    role: string;
    preview: string;
    timestamp: number;
  };
  recentTools?: ToolCall[];
  model: string;
  tokenUsage: {
    total: number;
    context: number;
    percentUsed: number;
  };
  kind: string;
  runId?: string;
}

interface QueueSnapshot {
  sessions: SessionQueueState[];
  activeSessions: number;
  totalSessions: number;
  timestamp: number;
  connected: boolean;
  historicalSessions?: HistoricalSessionInfo[];
}

interface HistoricalSessionInfo {
  sessionId: string;
  label: string;
  channel: string;
  completedAt: number;
  startedAt: number;
  durationMs: number;
  model: string;
  tokenUsage: {
    total: number;
    context: number;
    percentUsed: number;
  };
  kind: string;
}

interface ArchivedSession {
  sessionId: string;
  fileName: string;
  lastModified: string;
  fileSize: number;
  firstActivity: string | null;
  lastActivity: string | null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1000000).toFixed(2)}M`;
}

function getStateIcon(state: SessionQueueState['state']): React.ReactNode {
  switch (state) {
    case 'thinking': return <Brain size={12} />;
    case 'typing': return <PenTool size={12} />;
    case 'tool-use': return <Wrench size={12} />;
    case 'busy': return <Zap size={12} />;
    default: return null;
  }
}

function getStateText(state: SessionQueueState['state']): string {
  switch (state) {
    case 'thinking': return 'Thinking';
    case 'typing': return 'Typing';
    case 'tool-use': return 'Tool Use';
    case 'busy': return 'Busy';
    case 'idle': return 'Idle';
  }
}

function isAgentSession(_channel: string, sessionKey: string, label?: string, kind?: string): boolean {
  if (kind === 'subagent') return true;
  if (sessionKey.includes(':subagent:')) return true;
  if (sessionKey.includes(':g-agent-')) return true;
  if (label && /\bagent\b/i.test(label) && !label.toLowerCase().includes('cron')) return true;
  return false;
}

function getChannelInfo(channel: string, sessionKey: string, label?: string, kind?: string): { emoji: string; label: string } {
  // Agent sessions
  if (isAgentSession(channel, sessionKey, label, kind)) {
    return { emoji: '🤖', label: 'agent' };
  }

  // Map unknown channels to friendly labels based on session key
  if (channel === 'unknown' || channel === 'internal') {
    if (sessionKey.includes(':heartbeat')) {
      return { emoji: '🔄', label: 'system' };
    }
    if (sessionKey.includes(':cron:')) {
      return { emoji: '⏰', label: 'cron' };
    }
    return { emoji: '🔧', label: 'internal' };
  }

  switch (channel.toLowerCase()) {
    case 'discord': return { emoji: '💬', label: 'discord' };
    case 'heartbeat': return { emoji: '💓', label: 'heartbeat' };
    case 'telegram': return { emoji: '✈️', label: 'telegram' };
    default: return { emoji: '📡', label: channel };
  }
}

function getTokenBarClass(percent: number): string {
  if (percent < 30) return 'low';
  if (percent < 60) return 'medium';
  if (percent < 85) return 'high';
  return 'critical';
}

export const MessageQueueWidget: React.FC = () => {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [expandedHistorical, setExpandedHistorical] = useState<string | null>(null);
  const [archiveExpanded, setArchiveExpanded] = useState(false);
  const [archiveSessions, setArchiveSessions] = useState<ArchivedSession[]>([]);
  const [archiveTotal, setArchiveTotal] = useState(0);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [expandedArchived, setExpandedArchived] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const flashRef = useRef<Set<string>>(new Set());
  const prevActiveRef = useRef<Set<string>>(new Set());
  const { subscribe } = useWebSocket();

  // Fetch initial data
  const fetchQueue = useCallback(async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/gateway/queue`);
      if (!response.ok) return;
      const data = await response.json();
      if (data.success) {
        setSnapshot({
          sessions: data.sessions,
          activeSessions: data.activeSessions,
          totalSessions: data.totalSessions,
          timestamp: data.timestamp,
          connected: data.connected,
        });
      }
    } catch (err) {
      console.error('Failed to fetch queue:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  // Poll fallback every 30s
  useEffect(() => {
    const interval = setInterval(fetchQueue, 30000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  // WebSocket real-time updates — merge into existing state to preserve object references
  useEffect(() => {
    const unsub = subscribe('gateway:queue-update', (msg: { data: QueueSnapshot }) => {
      const newSnapshot = msg.data;

      // Detect newly active sessions for flash effect
      const newActive = new Set(
        newSnapshot.sessions.filter(s => s.state !== 'idle').map(s => s.sessionKey)
      );
      for (const key of newActive) {
        if (!prevActiveRef.current.has(key)) {
          flashRef.current.add(key);
          setTimeout(() => {
            flashRef.current.delete(key);
          }, 600);
        }
      }
      prevActiveRef.current = newActive;

      // Merge sessions: reuse existing objects when nothing changed to prevent re-renders
      setSnapshot(prev => {
        if (!prev) return newSnapshot;
        const prevMap = new Map(prev.sessions.map(s => [s.sessionKey, s]));
        const mergedSessions = newSnapshot.sessions.map(newS => {
          const oldS = prevMap.get(newS.sessionKey);
          if (!oldS) return newS;
          // Shallow compare — reuse old object if nothing changed
          const same = oldS.state === newS.state
            && oldS.lastActivity === newS.lastActivity
            && oldS.tokenUsage.total === newS.tokenUsage.total
            && oldS.tokenUsage.percentUsed === newS.tokenUsage.percentUsed
            && oldS.runId === newS.runId
            && oldS.lastMessage?.preview === newS.lastMessage?.preview
            && oldS.lastMessage?.timestamp === newS.lastMessage?.timestamp;
          return same ? oldS : newS;
        });
        return {
          ...newSnapshot,
          sessions: mergedSessions,
          // Preserve historical sessions references if unchanged
          historicalSessions: newSnapshot.historicalSessions ?? prev.historicalSessions,
        };
      });
      setLoading(false);
    });
    return unsub;
  }, [subscribe]);

  // Fetch archive sessions when expanded
  useEffect(() => {
    if (!archiveExpanded) return;
    let cancelled = false;
    const fetchArchive = async () => {
      setArchiveLoading(true);
      try {
        const response = await authenticatedFetch(
          `${API_BASE_URL}/gateway/sessions/archive?limit=20&offset=0`
        );
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data.success) {
          setArchiveSessions(data.sessions || []);
          setArchiveTotal(data.total ?? 0);
        }
      } catch (err) {
        console.error('Failed to fetch archive:', err);
      } finally {
        if (!cancelled) setArchiveLoading(false);
      }
    };
    fetchArchive();
    return () => { cancelled = true; };
  }, [archiveExpanded]);

  const loadMoreArchive = useCallback(async () => {
    try {
      const response = await authenticatedFetch(
        `${API_BASE_URL}/gateway/sessions/archive?limit=20&offset=${archiveSessions.length}`
      );
      if (!response.ok) return;
      const data = await response.json();
      if (data.success) {
        setArchiveSessions(prev => [...prev, ...(data.sessions || [])]);
        setArchiveTotal(data.total ?? 0);
      }
    } catch (err) {
      console.error('Failed to load more archive:', err);
    }
  }, [archiveSessions.length]);

  // Update time-ago display every 10s
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 10000);
    return () => clearInterval(interval);
  }, []);

  // Sort sessions: active first, then by lastActivity
  // Stable session order: track the order sessions first appeared to prevent
  // DOM reordering (which causes scroll jumps). Only add new sessions to end.
  const sessionOrderRef = useRef<string[]>([]);

  const recentSessions = React.useMemo(() => {
    if (!snapshot) return [];

    const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
    const visible = snapshot.sessions.filter(s =>
      s.state !== 'idle' || s.lastActivity > thirtyMinAgo
    );

    // Update stable order: add new keys, remove gone ones
    const visibleKeys = new Set(visible.map(s => s.sessionKey));
    // Remove sessions no longer visible
    sessionOrderRef.current = sessionOrderRef.current.filter(k => visibleKeys.has(k));
    // Append new sessions at the top (active first, then by recency)
    const newSessions = visible
      .filter(s => !sessionOrderRef.current.includes(s.sessionKey))
      .sort((a, b) => {
        const aActive = a.state !== 'idle' ? 1 : 0;
        const bActive = b.state !== 'idle' ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return b.lastActivity - a.lastActivity;
      });
    sessionOrderRef.current = [
      ...newSessions.map(s => s.sessionKey),
      ...sessionOrderRef.current,
    ];

    // Return in stable order
    const sessionMap = new Map(visible.map(s => [s.sessionKey, s]));
    return sessionOrderRef.current
      .map(k => sessionMap.get(k))
      .filter((s): s is SessionQueueState => s != null);
  }, [snapshot]);

  // Stable toggle callback for session expansion
  const toggleSession = useCallback((sessionKey: string) => {
    setExpandedSession(prev => prev === sessionKey ? null : sessionKey);
  }, []);

  const activeSessions = snapshot?.activeSessions ?? 0;
  const hasActive = activeSessions > 0;

  if (loading) {
    return (
      <div className="mq-widget">
        <div className="mq-loading">
          <Loader size={18} />
          <span>Connecting to gateway...</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`mq-widget ${hasActive ? 'has-active' : ''}`}>
      <div className="mq-header" onClick={() => setExpanded(!expanded)}>
        <div className="mq-title-section">
          <div className="mq-title-content">
            <h3>💬 Message Queue</h3>
            <div className="mq-subtitle">
              <div className={`mq-connection-dot ${snapshot?.connected ? 'connected' : 'disconnected'}`} />
              <span>
                {snapshot?.connected ? 'Gateway connected' : 'Gateway disconnected'}
                {recentSessions.length > 0 && ` · ${recentSessions.length} session${recentSessions.length !== 1 ? 's' : ''}`}
              </span>
            </div>
          </div>
        </div>

        <div className="mq-header-right">
          <span className={`mq-badge ${hasActive ? 'active' : 'idle'}`}>
            {activeSessions}
          </span>
          <button
            className="mq-collapse-btn"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mq-content">
          {recentSessions.length === 0 ? (
            <div className="mq-empty">
              <div className="mq-empty-icon">💤</div>
              <div className="mq-empty-text">
                No recent session activity
              </div>
            </div>
          ) : (
            <>
              <div className="mq-sessions">
                {recentSessions.map((session) => (
                  <SessionEntry
                    key={session.sessionKey}
                    session={session}
                    isExpanded={expandedSession === session.sessionKey}
                    isFlashing={flashRef.current.has(session.sessionKey)}
                    onToggle={() => toggleSession(session.sessionKey)}
                  />
                ))}
              </div>

              {/* Historical Sessions */}
              {snapshot?.historicalSessions && snapshot.historicalSessions.length > 0 && (
                <div className="mq-history-section">
                  <div
                    className="mq-history-header"
                    onClick={() => setHistoryExpanded(!historyExpanded)}
                  >
                    <span className="mq-history-title">
                      📜 Session History
                      <span className="mq-tools-count">{snapshot.historicalSessions.length}</span>
                    </span>
                    {historyExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </div>
                  {historyExpanded && (
                    <div className="mq-history-list">
                      {snapshot.historicalSessions.map((hs) => (
                        <HistoricalSessionEntry
                          key={hs.sessionId}
                          session={hs}
                          isExpanded={expandedHistorical === hs.sessionId}
                          onToggle={() =>
                            setExpandedHistorical(
                              expandedHistorical === hs.sessionId ? null : hs.sessionId
                            )
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Session Archive — all past sessions from transcript files */}
              <div className="mq-history-section mq-archive-section">
                <div
                  className="mq-history-header"
                  onClick={() => setArchiveExpanded(!archiveExpanded)}
                >
                  <span className="mq-history-title">
                    <FolderOpen size={14} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle' }} />
                    Session Archive
                    {archiveTotal > 0 && <span className="mq-tools-count">{archiveTotal}</span>}
                  </span>
                  {archiveExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </div>
                {archiveExpanded && (
                  <div className="mq-history-list">
                    {archiveLoading ? (
                      <div className="mq-tools-loading">
                        <Loader size={14} className="mq-tool-spinner" />
                        <span>Loading archive...</span>
                      </div>
                    ) : archiveSessions.length === 0 ? (
                      <div className="mq-empty-text" style={{ padding: '8px 12px', opacity: 0.6, fontSize: '12px' }}>
                        No archived sessions found
                      </div>
                    ) : (
                      <>
                        {archiveSessions.map((as) => (
                          <ArchivedSessionEntry
                            key={as.sessionId}
                            session={as}
                            isExpanded={expandedArchived === as.sessionId}
                            onToggle={() =>
                              setExpandedArchived(
                                expandedArchived === as.sessionId ? null : as.sessionId
                              )
                            }
                          />
                        ))}
                        {archiveSessions.length < archiveTotal && (
                          <button
                            className="mq-expand-message-btn"
                            onClick={(e) => { e.stopPropagation(); loadMoreArchive(); }}
                          >
                            Load more ({archiveTotal - archiveSessions.length} remaining) ▾
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

/* Session Entry Component */
interface SessionEntryProps {
  session: SessionQueueState;
  isExpanded: boolean;
  isFlashing: boolean;
  onToggle: () => void;
}

const SessionEntry: React.FC<SessionEntryProps> = React.memo(({
  session,
  isExpanded,
  isFlashing,
  onToggle,
}) => {
  const isActive = session.state !== 'idle';
  const canAbort = session.state !== 'idle';
  const [aborting, setAborting] = useState(false);
  const [abortError, setAbortError] = useState<string | null>(null);

  const handleAbort = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (aborting) return;
    
    console.log('[Abort] Clicking abort for session:', session.sessionId, session.label, session.state);
    setAborting(true);
    setAbortError(null);
    
    try {
      const url = `${API_BASE_URL}/gateway/session/${session.sessionId}/abort`;
      console.log('[Abort] POST', url);
      const response = await authenticatedFetch(url, { method: 'POST' });
      console.log('[Abort] Response status:', response.status);
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to abort session');
      }
      
      console.log('[Abort] Success!');
      // Success - button will disappear when session goes idle
    } catch (err: any) {
      console.error('[Abort] Failed:', err);
      setAbortError(err.message || 'Failed to stop agent');
      setTimeout(() => setAbortError(null), 3000);
    } finally {
      setAborting(false);
    }
  }, [aborting, session.sessionId, session.label, session.state]);

  return (
    <>
      <div
        className={`mq-session ${isActive ? 'active' : ''} ${isExpanded ? 'expanded' : ''} ${isFlashing ? 'flash' : ''}`}
        onClick={onToggle}
      >
        <div className={`mq-state-dot ${session.state}`} />

        <div className="mq-session-info">
          <div className="mq-session-name">{session.label}</div>
          <div className="mq-session-meta">
            <span className="mq-channel-badge">
              {(() => { const ch = getChannelInfo(session.channel, session.sessionKey, session.label, session.kind); return `${ch.emoji} ${ch.label}`; })()}
            </span>
            {session.lastMessage && (
              <>
                <span>·</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' }}>
                  {session.lastMessage.preview.substring(0, 50)}
                  {session.lastMessage.preview.length > 50 ? '…' : ''}
                </span>
              </>
            )}
          </div>
        </div>

        {isActive && (
          <span className={`mq-state-label ${session.state}`}>
            {getStateIcon(session.state)} {getStateText(session.state)}
          </span>
        )}

        {canAbort && (
          <button
            className={`mq-abort-btn ${aborting ? 'aborting' : ''}`}
            onClick={handleAbort}
            disabled={aborting}
            title="Stop agent"
            aria-label="Stop agent"
          >
            {aborting ? <Loader size={14} /> : <Square size={14} />}
          </button>
        )}

        {abortError && (
          <span className="mq-abort-error" title={abortError}>
            <AlertCircle size={12} />
          </span>
        )}

        <span className="mq-time">
          <Clock size={10} style={{ display: 'inline', marginRight: '3px', verticalAlign: 'middle' }} />
          {formatTimeAgo(session.lastActivity)}
        </span>
      </div>

      {isExpanded && (
        <ErrorBoundary
          fallback={
            <div className="mq-detail" style={{ padding: '12px' }}>
              <AlertCircle size={16} style={{ color: '#e74c3c', marginRight: '8px' }} />
              <span>⚠️ Failed to render session detail</span>
            </div>
          }
        >
          <SessionDetail session={session} />
        </ErrorBoundary>
      )}
    </>
  );
});

/* Message role icon + color mapping */
function getRoleInfo(role: string): { icon: string; label: string; className: string } {
  switch (role.toLowerCase()) {
    case 'assistant': return { icon: '🤖', label: 'Assistant', className: 'role-assistant' };
    case 'user': return { icon: '👤', label: 'User', className: 'role-user' };
    case 'system': return { icon: '⚙️', label: 'System', className: 'role-system' };
    case 'tool': return { icon: '🔧', label: 'Tool Result', className: 'role-tool' };
    case 'tool_use': return { icon: '⚡', label: 'Tool Call', className: 'role-tool-use' };
    default: return { icon: '💬', label: role, className: 'role-default' };
  }
}

/* Tool type classification for rendering */
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
  switch (type) {
    case 'exec': return <Terminal size={13} />;
    case 'browser': return <Globe size={13} />;
    case 'file': return <FileText size={13} />;
    case 'search': return <Search size={13} />;
    default: return <Zap size={13} />;
  }
}

function getToolDisplayName(name: string): string {
  const map: Record<string, string> = {
    exec: 'Terminal', process: 'Process', browser: 'Browser', web_fetch: 'Web Fetch',
    read: 'Read File', write: 'Write File', edit: 'Edit File',
    memory_search: 'Memory Search', memory_get: 'Memory Get',
    message: 'Message', sessions_spawn: 'Spawn Agent', sessions_send: 'Send to Session',
    tts: 'Text to Speech', cron: 'Cron', image: 'Image Analysis',
    session_status: 'Session Status', gateway: 'Gateway',
  };
  return map[name.toLowerCase()] || name;
}

/* Performance Metrics component */
const PerformanceMetrics: React.FC<{
  totalTokens: number;
  durationMs?: number;
  tools: ApiToolCall[];
}> = ({ totalTokens, durationMs, tools }) => {
  const toolsWithDuration = tools.filter(t => t.durationMs != null && t.durationMs > 0);
  const totalToolTime = toolsWithDuration.reduce((sum, t) => sum + (t.durationMs || 0), 0);
  const avgToolDuration = toolsWithDuration.length > 0 ? totalToolTime / toolsWithDuration.length : 0;
  const tokensPerSec = (durationMs && durationMs > 0 && totalTokens > 0) ? (totalTokens / (durationMs / 1000)) : 0;

  // Don't render if no meaningful data
  if (totalTokens === 0 && toolsWithDuration.length === 0 && !durationMs) return null;

  return (
    <div className="mq-perf-section">
      <div className="mq-perf-label">⚡ Performance</div>
      <div className="mq-perf-grid">
        {tokensPerSec > 0 && (
          <div className="mq-perf-stat">
            <div className="mq-perf-value">{tokensPerSec < 10 ? tokensPerSec.toFixed(1) : Math.round(tokensPerSec)} tok/s</div>
            <div className="mq-perf-sublabel">throughput</div>
          </div>
        )}
        {avgToolDuration > 0 && (
          <div className="mq-perf-stat">
            <div className="mq-perf-value">{formatDuration(Math.round(avgToolDuration))}</div>
            <div className="mq-perf-sublabel">avg per tool</div>
          </div>
        )}
        {totalToolTime > 0 && (
          <div className="mq-perf-stat">
            <div className="mq-perf-value">{formatDuration(totalToolTime)}</div>
            <div className="mq-perf-sublabel">tool time</div>
          </div>
        )}
        {durationMs != null && durationMs > 0 && (
          <div className="mq-perf-stat">
            <div className="mq-perf-value">{formatDuration(durationMs)}</div>
            <div className="mq-perf-sublabel">session</div>
          </div>
        )}
      </div>
    </div>
  );
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/* API tool call record */
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
  hasImage?: boolean;
}

/* Message from transcript API */
interface TranscriptMessage {
  role: string;
  text: string;
  fullText?: string;
  truncated?: boolean;
  timestamp: string;
}

/* Session Detail Component (expanded view) */
const SessionDetail: React.FC<{ session: SessionQueueState }> = React.memo(({ session }) => {
  const [apiTools, setApiTools] = useState<ApiToolCall[]>([]);
  const [toolsTotal, setToolsTotal] = useState(0);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [messagesExpanded, setMessagesExpanded] = useState(false);
  const [expandedMsgIndices, setExpandedMsgIndices] = useState<Set<number>>(new Set());
  const tokenPercent = session.tokenUsage.percentUsed;

  // Fetch tool calls from transcript API
  useEffect(() => {
    let cancelled = false;
    const fetchTools = async (all = false) => {
      try {
        const url = all
          ? `${API_BASE_URL}/gateway/session/${session.sessionId}/tools?all=true`
          : `${API_BASE_URL}/gateway/session/${session.sessionId}/tools?limit=${TOOLS_COMPACT_LIMIT}`;
        const response = await authenticatedFetch(url);
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data.success) {
          setApiTools(data.tools || []);
          setToolsTotal(data.total ?? data.tools?.length ?? 0);
          // all tools loaded
        }
      } catch (err) {
        console.error('Failed to fetch tools:', err);
      } finally {
        if (!cancelled) setToolsLoading(false);
      }
    };
    fetchTools(toolsExpanded);
    const interval = session.state !== 'idle' ? setInterval(() => fetchTools(toolsExpanded), 5000) : undefined;
    return () => { cancelled = true; if (interval) clearInterval(interval); };
  }, [session.sessionId, session.state, toolsExpanded]);

  // Fetch message history from transcript API
  useEffect(() => {
    let cancelled = false;
    const msgLimit = messagesExpanded ? 20 : 5;
    const fetchMessages = async () => {
      try {
        const response = await authenticatedFetch(
          `${API_BASE_URL}/gateway/session/${session.sessionId}/messages?limit=${msgLimit}`
        );
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data.success) {
          setMessages(data.messages || []);
        }
      } catch (err) {
        console.error('Failed to fetch messages:', err);
      } finally {
        if (!cancelled) setMessagesLoading(false);
      }
    };
    fetchMessages();
    const interval = session.state !== 'idle' ? setInterval(fetchMessages, 5000) : undefined;
    return () => { cancelled = true; if (interval) clearInterval(interval); };
  }, [session.sessionId, session.state, messagesExpanded]);

  // TOOLS_COMPACT_LIMIT defined at top
  const showToolsToggle = toolsTotal > TOOLS_COMPACT_LIMIT;
  const visibleTools = apiTools;

  return (
    <div className="mq-detail">
      <div className="mq-detail-header">
        <div className="mq-detail-title">
          <Radio size={14} style={{ display: 'inline', marginRight: '6px', verticalAlign: 'middle' }} />
          {session.displayName}
        </div>
        <span className="mq-detail-model">{session.model}</span>
      </div>

      <div className="mq-detail-stats">
        <div className="mq-detail-stat">
          <div className="mq-detail-stat-value">{formatTokens(session.tokenUsage.total)}</div>
          <div className="mq-detail-stat-label">Tokens</div>
        </div>
        <div className="mq-detail-stat">
          <div className="mq-detail-stat-value">{formatTokens(session.tokenUsage.context)}</div>
          <div className="mq-detail-stat-label">Context</div>
        </div>
        <div className="mq-detail-stat">
          <div className="mq-detail-stat-value">{tokenPercent}%</div>
          <div className="mq-detail-stat-label">Used</div>
        </div>
        <div className="mq-detail-stat">
          <div className="mq-detail-stat-value">{
            session.kind === 'subagent' ? 'sub-agent'
            : isAgentSession(session.channel, session.sessionKey, session.label, session.kind) ? 'agent'
            : session.kind || '—'
          }</div>
          <div className="mq-detail-stat-label">Type</div>
        </div>
      </div>

      <div className="mq-token-bar">
        <div
          className={`mq-token-bar-fill ${getTokenBarClass(tokenPercent)}`}
          style={{ width: `${Math.min(tokenPercent, 100)}%` }}
        />
      </div>

      {!toolsLoading && (
        <PerformanceMetrics totalTokens={session.tokenUsage.total} tools={apiTools} />
      )}

      {/* Message history section */}
      {messagesLoading ? (
        <div className="mq-tools-loading">
          <Loader size={14} className="mq-tool-spinner" />
          <span>Loading messages...</span>
        </div>
      ) : messages.length > 0 ? (
        <div className="mq-message-history">
          <div className="mq-message-history-list">
            {messages.map((msg, idx) => {
              try {
                if (!msg || !msg.role) {
                  return (
                    <div key={`error-msg-${idx}`} className="mq-history-message error">
                      <AlertCircle size={12} style={{ color: '#e74c3c', marginRight: '4px' }} />
                      <span style={{ fontSize: '11px' }}>⚠️ Failed to render message</span>
                    </div>
                  );
                }
                
                const roleInfo = getRoleInfo(msg.role);
                const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
                const messageText = msg.text || '';
                const fullText = msg.fullText || messageText;
                
                return (
                  <div key={`${msg.role}-${msg.timestamp}-${idx}`} className={`mq-history-message ${roleInfo.className}`}>
                    <div className="mq-history-message-header">
                      <span className="mq-history-message-role">
                        <span className="mq-role-icon">{roleInfo.icon}</span>
                        {roleInfo.label}
                      </span>
                      <span className="mq-history-message-time">{formatTimeAgo(ts)}</span>
                    </div>
                    <div className={`mq-history-message-text${msg.truncated && expandedMsgIndices.has(idx) ? ' mq-message-text-expanded' : ''}`}>
                      {msg.truncated && expandedMsgIndices.has(idx) ? fullText : messageText}{msg.truncated && !expandedMsgIndices.has(idx) ? '…' : ''}
                    </div>
                    {msg.truncated && (
                      <button className="mq-msg-expand-toggle" onClick={(e) => {
                        e.stopPropagation();
                        setExpandedMsgIndices(prev => {
                          const next = new Set(prev);
                          if (next.has(idx)) next.delete(idx); else next.add(idx);
                          return next;
                        });
                      }}>
                        {expandedMsgIndices.has(idx) ? 'Show less ▲' : 'Show more ▾'}
                      </button>
                    )}
                  </div>
                );
              } catch (err) {
                console.error('Error rendering message:', msg, err);
                return (
                  <div key={`error-msg-${idx}`} className="mq-history-message error">
                    <AlertCircle size={12} style={{ color: '#e74c3c', marginRight: '4px' }} />
                    <span style={{ fontSize: '11px' }}>⚠️ Failed to render message</span>
                  </div>
                );
              }
            })}
          </div>
          <button
            className="mq-expand-message-btn"
            onClick={(e) => { e.stopPropagation(); setMessagesExpanded(!messagesExpanded); }}
          >
            {messagesExpanded ? 'Show less ▲' : 'View full history ▾'}
          </button>
        </div>
      ) : null}

      {/* Tool calls section */}
      {toolsLoading ? (
        <div className="mq-tools-loading">
          <Loader size={14} className="mq-tool-spinner" />
          <span>Loading tool calls...</span>
        </div>
      ) : apiTools.length > 0 ? (
        <div className="mq-tools-section">
          <div className="mq-tools-header">
            <Wrench size={12} />
            <span>Tool Calls</span>
            <span className="mq-tools-count">{apiTools.length}</span>
          </div>
          <div className={`mq-tools-list ${toolsExpanded ? "expanded" : ""}`}>
            {visibleTools.map((tool, idx) => (
              <ToolCallEntry key={`${tool.name}-${tool.timestamp}-${idx}`} tool={tool} />
            ))}
          </div>
          {showToolsToggle && (
            <button
              className="mq-expand-message-btn"
              onClick={(e) => { e.stopPropagation(); setToolsExpanded(!toolsExpanded); }}
            >
              {toolsExpanded ? 'Show less ▲' : `Show all ${toolsTotal} tool calls ▾`}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
});

/* Extract MEDIA: image references from tool output */
function extractMediaImages(text: string): { beforeText: string; images: { filename: string; relativePath: string }[]; afterText: string } {
  const mediaRegex = /MEDIA:([^\s]+\.(?:jpg|jpeg|png|gif|webp))/gi;
  const images: { filename: string; relativePath: string }[] = [];
  let afterText = text;

  let match;
  while ((match = mediaRegex.exec(text)) !== null) {
    const fullPath = match[1];
    // Extract relative path after /media/ or after .openclaw/media/
    const mediaIdx = fullPath.indexOf('/media/');
    const relativePath = mediaIdx !== -1 ? fullPath.substring(mediaIdx + 7) : fullPath.split('/').slice(-2).join('/');
    const filename = fullPath.split('/').pop() || 'screenshot';
    images.push({ filename, relativePath });
    afterText = afterText.replace(match[0], '').trim();
  }

  return { beforeText: afterText, images, afterText };
}

/* Screenshot image with lightbox */
const ScreenshotImage: React.FC<{ relativePath: string; filename: string }> = ({ relativePath, filename }) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE_URL}/gateway/media/${relativePath}`);
        if (!response.ok) { setError(true); return; }
        const blob = await response.blob();
        if (!cancelled) setBlobUrl(URL.createObjectURL(blob));
      } catch { if (!cancelled) setError(true); }
    })();
    return () => { cancelled = true; };
  }, [relativePath]);

  if (error || !blobUrl) return error ? <span className="mq-screenshot-error">⚠️ {filename}</span> : null;

  return (
    <>
      <img
        src={blobUrl}
        alt={filename}
        className="mq-screenshot-thumb"
        onClick={(e) => { e.stopPropagation(); setLightbox(true); }}
      />
      {lightbox && (
        <div className="mq-lightbox" onClick={() => setLightbox(false)}>
          <img src={blobUrl} alt={filename} />
        </div>
      )}
    </>
  );
};

/* Tool Call Entry — rich display per tool type with error handling */
const ToolCallEntry: React.FC<{ tool: ApiToolCall }> = ({ tool }) => {
  const [expanded, setExpanded] = useState(false);
  
  // Defensive checks for required fields
  if (!tool || !tool.name) {
    return (
      <div className="mq-tool-entry error">
        <AlertCircle size={14} style={{ color: '#e74c3c', marginRight: '6px' }} />
        <span>⚠️ Failed to render tool: missing required data</span>
      </div>
    );
  }

  try {
    const toolType = getToolType(tool.name);
    const hasOutput = !!tool.output;
    const ts = tool.timestamp ? new Date(tool.timestamp).getTime() : Date.now();
    
    // Ensure tool.input is a string if it exists
    const toolInput = tool.input != null ? String(tool.input) : '';
    const toolOutput = tool.output != null ? String(tool.output) : '';

    return (
      <div
        className={`mq-tool-entry ${tool.status || 'done'} ${toolType}`}
        onClick={(e) => { e.stopPropagation(); if (hasOutput) setExpanded(!expanded); }}
      >
        <div className="mq-tool-header">
          <div className="mq-tool-name-row">
            <span className={`mq-tool-icon-badge ${toolType}`}>
              {getToolIcon(tool.name)}
            </span>
            <span className="mq-tool-display-name">{getToolDisplayName(tool.name)}</span>
            {tool.status === 'running' && <Loader size={11} className="mq-tool-spinner" />}
            {tool.status === 'error' && <AlertCircle size={11} className="mq-tool-error-icon" />}
            {tool.status === 'done' && <CheckCircle2 size={11} className="mq-tool-done-icon" />}
          </div>
          <div className="mq-tool-meta">
            {tool.durationMs != null && (
              <span className="mq-tool-duration">{formatDuration(tool.durationMs)}</span>
            )}
            <span className="mq-tool-time">{formatTimeAgo(ts)}</span>
            {hasOutput && (
              <span className="mq-tool-expand-hint">
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
            )}
          </div>
        </div>

        {/* Input display — varies by tool type */}
        {toolInput && (
          <div className={`mq-tool-input-block ${toolType}`}>
            {toolType === 'exec' ? (
              <div className="mq-terminal-input">
                <span className="mq-terminal-prompt">$</span>
                <code>{toolInput.startsWith('$ ') ? toolInput.slice(2) : toolInput}</code>
              </div>
            ) : toolType === 'browser' ? (
              <div className="mq-browser-input">
                <Globe size={11} className="mq-browser-url-icon" />
                <span className="mq-browser-url">{toolInput}</span>
              </div>
            ) : toolType === 'file' ? (
              <div className="mq-file-input">
                <FileText size={11} />
                <code>{toolInput}</code>
              </div>
            ) : (
              <div className="mq-generic-input">
                <code>{toolInput}</code>
              </div>
            )}
          </div>
        )}

        {/* Output display */}
        {expanded && toolOutput && (() => {
          try {
            const { beforeText, images } = extractMediaImages(toolOutput);
            return (
              <div className={`mq-tool-output-block ${toolType}`}>
                {images.length > 0 && images.map((img, i) => (
                  <ScreenshotImage key={i} relativePath={img.relativePath} filename={img.filename} />
                ))}
                {beforeText && (
                  toolType === 'exec' ? (
                    <div className="mq-terminal-output">
                      <pre>{beforeText}</pre>
                    </div>
                  ) : (
                    <div className="mq-generic-output">
                      <pre>{beforeText}</pre>
                    </div>
                  )
                )}
              </div>
            );
          } catch (err) {
            console.error('Error rendering tool output:', err);
            return (
              <div className="mq-tool-output-block error">
                <AlertCircle size={12} style={{ color: '#e74c3c', marginRight: '4px' }} />
                <span style={{ fontSize: '11px' }}>Failed to render output</span>
              </div>
            );
          }
        })()}
      </div>
    );
  } catch (err) {
    console.error('Error rendering tool:', tool, err);
    return (
      <div className="mq-tool-entry error">
        <AlertCircle size={14} style={{ color: '#e74c3c', marginRight: '6px' }} />
        <span>⚠️ Failed to render tool: {tool.name || 'unknown'}</span>
      </div>
    );
  }
};

/* Historical Session Entry */
const HistoricalSessionEntry: React.FC<{
  session: HistoricalSessionInfo;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ session, isExpanded, onToggle }) => {
  const channelInfo = getChannelInfo(session.channel, '', session.label, session.kind);

  return (
    <>
      <div className={`mq-session mq-historical ${isExpanded ? 'expanded' : ''}`} onClick={onToggle}>
        <div className="mq-state-dot idle" />
        <div className="mq-session-info">
          <div className="mq-session-name">
            <Clock size={11} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle', opacity: 0.5 }} />
            {session.label}
          </div>
          <div className="mq-session-meta">
            <span className="mq-channel-badge">{channelInfo.emoji} {channelInfo.label}</span>
            <span>·</span>
            <span>{formatDuration(session.durationMs)}</span>
            <span>·</span>
            <span>{formatTokens(session.tokenUsage.total)} tokens</span>
          </div>
        </div>
        <span className="mq-time">
          <Clock size={10} style={{ display: 'inline', marginRight: '3px', verticalAlign: 'middle' }} />
          {formatTimeAgo(session.completedAt)}
        </span>
      </div>
      {isExpanded && (
        <ErrorBoundary
          fallback={
            <div className="mq-detail" style={{ padding: '12px' }}>
              <AlertCircle size={16} style={{ color: '#e74c3c', marginRight: '8px' }} />
              <span>⚠️ Failed to render session detail</span>
            </div>
          }
        >
          <HistoricalSessionDetail session={session} />
        </ErrorBoundary>
      )}
    </>
  );
};

/* Archived Session Entry — from transcript files on disk */
const ArchivedSessionEntry: React.FC<{
  session: ArchivedSession;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ session, isExpanded, onToggle }) => {
  const lastMod = new Date(session.lastModified).getTime();
  const truncatedId = session.sessionId.substring(0, 8);

  return (
    <>
      <div className={`mq-session mq-historical mq-archived ${isExpanded ? 'expanded' : ''}`} onClick={onToggle}>
        <div className="mq-state-dot idle" />
        <div className="mq-session-info">
          <div className="mq-session-name">
            <FolderOpen size={11} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle', opacity: 0.5 }} />
            {truncatedId}…
          </div>
          <div className="mq-session-meta">
            <span>{formatFileSize(session.fileSize)}</span>
          </div>
        </div>
        <span className="mq-time">
          <Clock size={10} style={{ display: 'inline', marginRight: '3px', verticalAlign: 'middle' }} />
          {formatTimeAgo(lastMod)}
        </span>
      </div>
      {isExpanded && (
        <ErrorBoundary
          fallback={
            <div className="mq-detail" style={{ padding: '12px' }}>
              <AlertCircle size={16} style={{ color: '#e74c3c', marginRight: '8px' }} />
              <span>⚠️ Failed to render session detail</span>
            </div>
          }
        >
          <ArchivedSessionDetail session={session} />
        </ErrorBoundary>
      )}
    </>
  );
};

/* Archived Session Detail — loads tools and messages from transcript */
const ArchivedSessionDetail: React.FC<{ session: ArchivedSession }> = ({ session }) => {
  const [apiTools, setApiTools] = useState<ApiToolCall[]>([]);
  const [toolsTotal, setToolsTotal] = useState(0);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [messagesExpanded, setMessagesExpanded] = useState(false);
  const [expandedMsgIndices, setExpandedMsgIndices] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const fetchTools = async () => {
      try {
        const url = toolsExpanded
          ? `${API_BASE_URL}/gateway/session/${session.sessionId}/tools?all=true`
          : `${API_BASE_URL}/gateway/session/${session.sessionId}/tools?limit=${TOOLS_COMPACT_LIMIT}`;
        const response = await authenticatedFetch(url);
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data.success) {
          setApiTools(data.tools || []);
          setToolsTotal(data.total ?? data.tools?.length ?? 0);
        }
      } catch (err) { console.error('Failed to fetch tools:', err); }
      finally { if (!cancelled) setToolsLoading(false); }
    };
    fetchTools();
    return () => { cancelled = true; };
  }, [session.sessionId, toolsExpanded]);

  useEffect(() => {
    let cancelled = false;
    const msgLimit = messagesExpanded ? 20 : 5;
    const fetchMessages = async () => {
      try {
        const response = await authenticatedFetch(
          `${API_BASE_URL}/gateway/session/${session.sessionId}/messages?limit=${msgLimit}`
        );
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data.success) setMessages(data.messages || []);
      } catch (err) { console.error('Failed to fetch messages:', err); }
      finally { if (!cancelled) setMessagesLoading(false); }
    };
    fetchMessages();
    return () => { cancelled = true; };
  }, [session.sessionId, messagesExpanded]);

  const showToolsToggle = toolsTotal > TOOLS_COMPACT_LIMIT;

  return (
    <div className="mq-detail mq-detail-historical mq-detail-archived">
      <div className="mq-detail-header">
        <div className="mq-detail-title">
          <FolderOpen size={14} style={{ display: 'inline', marginRight: '6px', verticalAlign: 'middle' }} />
          {session.sessionId}
        </div>
        <span className="mq-detail-model">{formatFileSize(session.fileSize)}</span>
      </div>

      <div className="mq-detail-stats">
        {session.firstActivity && (
          <div className="mq-detail-stat">
            <div className="mq-detail-stat-value">{new Date(session.firstActivity).toLocaleString()}</div>
            <div className="mq-detail-stat-label">Started</div>
          </div>
        )}
        {session.lastActivity && (
          <div className="mq-detail-stat">
            <div className="mq-detail-stat-value">{new Date(session.lastActivity).toLocaleString()}</div>
            <div className="mq-detail-stat-label">Last Activity</div>
          </div>
        )}
      </div>

      {/* Message history */}
      {messagesLoading ? (
        <div className="mq-tools-loading"><Loader size={14} className="mq-tool-spinner" /><span>Loading messages...</span></div>
      ) : messages.length > 0 ? (
        <div className="mq-message-history">
          <div className="mq-message-history-list">
            {messages.map((msg, idx) => {
              const roleInfo = getRoleInfo(msg.role);
              const ts = new Date(msg.timestamp).getTime();
              return (
                <div key={`${msg.role}-${msg.timestamp}-${idx}`} className={`mq-history-message ${roleInfo.className}`}>
                  <div className="mq-history-message-header">
                    <span className="mq-history-message-role"><span className="mq-role-icon">{roleInfo.icon}</span>{roleInfo.label}</span>
                    <span className="mq-history-message-time">{formatTimeAgo(ts)}</span>
                  </div>
                  <div className={`mq-history-message-text${msg.truncated && expandedMsgIndices.has(idx) ? ' mq-message-text-expanded' : ''}`}>
                    {msg.truncated && expandedMsgIndices.has(idx) ? msg.fullText : msg.text}{msg.truncated && !expandedMsgIndices.has(idx) ? '…' : ''}
                  </div>
                  {msg.truncated && (
                    <button className="mq-msg-expand-toggle" onClick={(e) => {
                      e.stopPropagation();
                      setExpandedMsgIndices(prev => {
                        const next = new Set(prev);
                        if (next.has(idx)) next.delete(idx); else next.add(idx);
                        return next;
                      });
                    }}>
                      {expandedMsgIndices.has(idx) ? 'Show less ▲' : 'Show more ▾'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button className="mq-expand-message-btn" onClick={(e) => { e.stopPropagation(); setMessagesExpanded(!messagesExpanded); }}>
            {messagesExpanded ? 'Show less ▲' : 'View full history ▾'}
          </button>
        </div>
      ) : null}

      {/* Tool calls */}
      {toolsLoading ? (
        <div className="mq-tools-loading"><Loader size={14} className="mq-tool-spinner" /><span>Loading tool calls...</span></div>
      ) : apiTools.length > 0 ? (
        <div className="mq-tools-section">
          <div className="mq-tools-header"><Wrench size={12} /><span>Tool Calls</span><span className="mq-tools-count">{apiTools.length}</span></div>
          <div className={`mq-tools-list ${toolsExpanded ? "expanded" : ""}`}>
            {apiTools.map((tool, idx) => (
              <ToolCallEntry key={`${tool.name}-${tool.timestamp}-${idx}`} tool={tool} />
            ))}
          </div>
          {showToolsToggle && (
            <button className="mq-expand-message-btn" onClick={(e) => { e.stopPropagation(); setToolsExpanded(!toolsExpanded); }}>
              {toolsExpanded ? 'Show less ▲' : `Show all ${toolsTotal} tool calls ▾`}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
};

/* Historical Session Detail — reuses the same detail pattern */
const HistoricalSessionDetail: React.FC<{ session: HistoricalSessionInfo }> = ({ session }) => {
  const [apiTools, setApiTools] = useState<ApiToolCall[]>([]);
  const [toolsTotal, setToolsTotal] = useState(0);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [messagesExpanded, setMessagesExpanded] = useState(false);
  const [expandedMsgIndices, setExpandedMsgIndices] = useState<Set<number>>(new Set());
  const tokenPercent = session.tokenUsage.percentUsed;

  useEffect(() => {
    let cancelled = false;
    const fetchTools = async () => {
      try {
        const url = toolsExpanded
          ? `${API_BASE_URL}/gateway/session/${session.sessionId}/tools?all=true`
          : `${API_BASE_URL}/gateway/session/${session.sessionId}/tools?limit=${TOOLS_COMPACT_LIMIT}`;
        const response = await authenticatedFetch(url);
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data.success) {
          setApiTools(data.tools || []);
          setToolsTotal(data.total ?? data.tools?.length ?? 0);
        }
      } catch (err) { console.error('Failed to fetch tools:', err); }
      finally { if (!cancelled) setToolsLoading(false); }
    };
    fetchTools();
    return () => { cancelled = true; };
  }, [session.sessionId, toolsExpanded]);

  useEffect(() => {
    let cancelled = false;
    const msgLimit = messagesExpanded ? 20 : 5;
    const fetchMessages = async () => {
      try {
        const response = await authenticatedFetch(
          `${API_BASE_URL}/gateway/session/${session.sessionId}/messages?limit=${msgLimit}`
        );
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data.success) setMessages(data.messages || []);
      } catch (err) { console.error('Failed to fetch messages:', err); }
      finally { if (!cancelled) setMessagesLoading(false); }
    };
    fetchMessages();
    return () => { cancelled = true; };
  }, [session.sessionId, messagesExpanded]);

  // TOOLS_COMPACT_LIMIT defined at top
  const showToolsToggle = toolsTotal > TOOLS_COMPACT_LIMIT;
  const visibleTools = apiTools;

  return (
    <div className="mq-detail mq-detail-historical">
      <div className="mq-detail-header">
        <div className="mq-detail-title">
          <Clock size={14} style={{ display: 'inline', marginRight: '6px', verticalAlign: 'middle' }} />
          {session.label}
        </div>
        <span className="mq-detail-model">{session.model}</span>
      </div>

      <div className="mq-detail-stats">
        <div className="mq-detail-stat">
          <div className="mq-detail-stat-value">{formatTokens(session.tokenUsage.total)}</div>
          <div className="mq-detail-stat-label">Tokens</div>
        </div>
        <div className="mq-detail-stat">
          <div className="mq-detail-stat-value">{formatDuration(session.durationMs)}</div>
          <div className="mq-detail-stat-label">Duration</div>
        </div>
        <div className="mq-detail-stat">
          <div className="mq-detail-stat-value">{tokenPercent}%</div>
          <div className="mq-detail-stat-label">Context Used</div>
        </div>
      </div>

      <div className="mq-token-bar">
        <div className={`mq-token-bar-fill ${getTokenBarClass(tokenPercent)}`} style={{ width: `${Math.min(tokenPercent, 100)}%` }} />
      </div>

      {!toolsLoading && (
        <PerformanceMetrics totalTokens={session.tokenUsage.total} durationMs={session.durationMs} tools={apiTools} />
      )}

      {/* Message history */}
      {messagesLoading ? (
        <div className="mq-tools-loading"><Loader size={14} className="mq-tool-spinner" /><span>Loading messages...</span></div>
      ) : messages.length > 0 ? (
        <div className="mq-message-history">
          <div className="mq-message-history-list">
            {messages.map((msg, idx) => {
              const roleInfo = getRoleInfo(msg.role);
              const ts = new Date(msg.timestamp).getTime();
              return (
                <div key={`${msg.role}-${msg.timestamp}-${idx}`} className={`mq-history-message ${roleInfo.className}`}>
                  <div className="mq-history-message-header">
                    <span className="mq-history-message-role"><span className="mq-role-icon">{roleInfo.icon}</span>{roleInfo.label}</span>
                    <span className="mq-history-message-time">{formatTimeAgo(ts)}</span>
                  </div>
                  <div className={`mq-history-message-text${msg.truncated && expandedMsgIndices.has(idx) ? ' mq-message-text-expanded' : ''}`}>
                    {msg.truncated && expandedMsgIndices.has(idx) ? msg.fullText : msg.text}{msg.truncated && !expandedMsgIndices.has(idx) ? '…' : ''}
                  </div>
                  {msg.truncated && (
                    <button className="mq-msg-expand-toggle" onClick={(e) => {
                      e.stopPropagation();
                      setExpandedMsgIndices(prev => {
                        const next = new Set(prev);
                        if (next.has(idx)) next.delete(idx); else next.add(idx);
                        return next;
                      });
                    }}>
                      {expandedMsgIndices.has(idx) ? 'Show less ▲' : 'Show more ▾'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button className="mq-expand-message-btn" onClick={(e) => { e.stopPropagation(); setMessagesExpanded(!messagesExpanded); }}>
            {messagesExpanded ? 'Show less ▲' : 'View full history ▾'}
          </button>
        </div>
      ) : null}

      {/* Tool calls */}
      {toolsLoading ? (
        <div className="mq-tools-loading"><Loader size={14} className="mq-tool-spinner" /><span>Loading tool calls...</span></div>
      ) : apiTools.length > 0 ? (
        <div className="mq-tools-section">
          <div className="mq-tools-header"><Wrench size={12} /><span>Tool Calls</span><span className="mq-tools-count">{apiTools.length}</span></div>
          <div className={`mq-tools-list ${toolsExpanded ? "expanded" : ""}`}>
            {visibleTools.map((tool, idx) => (
              <ToolCallEntry key={`${tool.name}-${tool.timestamp}-${idx}`} tool={tool} />
            ))}
          </div>
          {showToolsToggle && (
            <button className="mq-expand-message-btn" onClick={(e) => { e.stopPropagation(); setToolsExpanded(!toolsExpanded); }}>
              {toolsExpanded ? 'Show less ▲' : `Show all ${toolsTotal} tool calls ▾`}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
};
