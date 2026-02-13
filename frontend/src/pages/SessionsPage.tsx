import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Clock,
  Radio,
  Wrench,
  Zap,
  Loader,
  AlertCircle,
  CheckCircle2,
  Terminal,
  Globe,
  FileText,
  Search,
  ChevronDown,
  ChevronRight,
  Archive,
  Menu,
  X,
} from 'lucide-react';
import { authenticatedFetch } from '../utils/auth';
import { useWebSocket } from '../hooks/useWebSocket';
import './SessionsPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

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
  connected: boolean;
}

interface ArchivedSession {
  sessionId: string;
  fileName: string;
  lastModified: string;
  fileSize: number;
  firstActivity: string | null;
  lastActivity: string | null;
  label?: string;
}

interface TranscriptMessage {
  role: string;
  text: string;
  fullText?: string;
  truncated?: boolean;
  timestamp: string;
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
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1000000).toFixed(2)}M`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function getChannelInfo(channel: string, sessionKey: string, label?: string, kind?: string): { emoji: string; label: string } {
  // Agent sessions
  if (kind === 'subagent' || sessionKey.includes(':subagent:') || sessionKey.includes(':g-agent-')) {
    return { emoji: '🤖', label: 'agent' };
  }
  if (label && /\bagent\b/i.test(label) && !label.toLowerCase().includes('cron')) {
    return { emoji: '🤖', label: 'agent' };
  }

  // System channels
  if (channel === 'unknown' || channel === 'internal') {
    if (sessionKey.includes(':heartbeat')) return { emoji: '🔄', label: 'system' };
    if (sessionKey.includes(':cron:')) return { emoji: '⏰', label: 'cron' };
    return { emoji: '🔧', label: 'internal' };
  }

  switch (channel.toLowerCase()) {
    case 'discord': return { emoji: '💬', label: 'discord' };
    case 'heartbeat': return { emoji: '💓', label: 'heartbeat' };
    case 'telegram': return { emoji: '✈️', label: 'telegram' };
    default: return { emoji: '📡', label: channel };
  }
}

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
    tts: 'Text to Speech',
  };
  return map[name.toLowerCase()] || name;
}

export const SessionsPage: React.FC = () => {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const { subscribe } = useWebSocket();

  // Mobile sidebar toggle
  const [sidebarVisible, setSidebarVisible] = useState(false);

  // Archive sessions state
  const [archiveExpanded, setArchiveExpanded] = useState(false);
  const [archiveSessions, setArchiveSessions] = useState<ArchivedSession[]>([]);
  const [archiveTotal, setArchiveTotal] = useState(0);
  const [archiveLoading, setArchiveLoading] = useState(false);

  // Fetch archive sessions when expanded
  useEffect(() => {
    if (!archiveExpanded) return;
    let cancelled = false;
    const fetchArchive = async () => {
      setArchiveLoading(true);
      try {
        const res = await authenticatedFetch(
          `${API_BASE_URL}/gateway/sessions/archive?limit=20&offset=0`
        );
        const data = await res.json();
        if (!cancelled) {
          setArchiveSessions(data.sessions || []);
          setArchiveTotal(data.total ?? 0);
        }
      } catch (err) {
        console.error('Failed to fetch archive:', err);
      }
      if (!cancelled) setArchiveLoading(false);
    };
    fetchArchive();
    return () => { cancelled = true; };
  }, [archiveExpanded]);

  const loadMoreArchive = useCallback(async () => {
    try {
      const res = await authenticatedFetch(
        `${API_BASE_URL}/gateway/sessions/archive?limit=20&offset=${archiveSessions.length}`
      );
      const data = await res.json();
      setArchiveSessions(prev => [...prev, ...(data.sessions || [])]);
    } catch (err) {
      console.error('Failed to load more archive:', err);
    }
  }, [archiveSessions.length]);

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
          connected: data.connected,
        });
        // Auto-select first session if none selected
        if (!selectedSessionKey && data.sessions.length > 0) {
          setSelectedSessionKey(data.sessions[0].sessionKey);
        }
      }
    } catch (err) {
      console.error('Failed to fetch queue:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedSessionKey]);

  // Initial load
  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  // WebSocket real-time updates
  useEffect(() => {
    const unsub = subscribe('gateway:queue-update', (msg: { data: QueueSnapshot }) => {
      setSnapshot(msg.data);
      setLoading(false);
      // Auto-select first session if none selected
      if (!selectedSessionKey && msg.data.sessions.length > 0) {
        setSelectedSessionKey(msg.data.sessions[0].sessionKey);
      }
    });
    return unsub;
  }, [subscribe, selectedSessionKey]);

  // Update time-ago display every 10s
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 10000);
    return () => clearInterval(interval);
  }, []);

  // Sort sessions: Main first, Heartbeat second, rest by recency
  const sortedSessions = React.useMemo(() => {
    if (!snapshot) return [];

    const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
    const visible = snapshot.sessions.filter(s =>
      s.state !== 'idle' || s.lastActivity > thirtyMinAgo
    );

    const main = visible.find(s => s.sessionKey.endsWith(':main') || s.label === 'Main Session');
    const heartbeat = visible.find(s => s.sessionKey.includes(':heartbeat') && !s.sessionKey.includes(':cron:'));
    const others = visible
      .filter(s => s !== main && s !== heartbeat)
      .sort((a, b) => b.lastActivity - a.lastActivity);

    const result: SessionQueueState[] = [];
    if (main) result.push(main);
    if (heartbeat) result.push(heartbeat);
    result.push(...others);

    return result;
  }, [snapshot]);

  const selectedSession = React.useMemo(() => {
    // Live session match
    const live = sortedSessions.find(s => s.sessionKey === selectedSessionKey);
    if (live) return live;

    // Archived session match (selectedSessionKey = 'archive:${sessionId}')
    if (selectedSessionKey?.startsWith('archive:')) {
      const archiveId = selectedSessionKey.replace('archive:', '');
      const archived = archiveSessions.find(s => s.sessionId === archiveId);
      if (archived) {
        return {
          sessionKey: selectedSessionKey,
          sessionId: archived.sessionId,
          displayName: `📦 ${archived.label || archived.sessionId.slice(0, 8)}`,
          label: archived.label || archived.sessionId.slice(0, 8),
          channel: 'archive',
          state: 'idle' as const,
          lastActivity: new Date(archived.lastModified).getTime(),
          model: '',
          tokenUsage: { total: 0, context: 0, percentUsed: 0 },
          kind: 'archived',
        } satisfies SessionQueueState;
      }
    }
    return undefined;
  }, [sortedSessions, selectedSessionKey, archiveSessions]);

  if (loading) {
    return (
      <div className="sessions-page">
        <div className="sessions-loading">
          <Loader size={32} className="sessions-spinner" />
          <span>Loading sessions...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="sessions-page">
      {/* Mobile backdrop */}
      {sidebarVisible && (
        <div className="sessions-backdrop" onClick={() => setSidebarVisible(false)} />
      )}

      {/* Left Panel - Session List */}
      <div className={`sessions-sidebar ${sidebarVisible ? 'mobile-visible' : ''}`}>
        <div className="sessions-sidebar-header">
          <div className="sessions-sidebar-header-top">
            <h2>📋 Sessions</h2>
            <button
              className="sessions-sidebar-close"
              onClick={() => setSidebarVisible(false)}
              aria-label="Close sidebar"
            >
              <X size={20} />
            </button>
          </div>
          <div className="sessions-connection-status">
            <div className={`sessions-connection-dot ${snapshot?.connected ? 'connected' : 'disconnected'}`} />
            <span>{snapshot?.connected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>

        <div className="sessions-list">
          {sortedSessions.length === 0 ? (
            <div className="sessions-empty">
              <div className="sessions-empty-icon">💤</div>
              <div className="sessions-empty-text">No active sessions</div>
            </div>
          ) : (
            sortedSessions.map((session) => (
              <SessionListItem
                key={session.sessionKey}
                session={session}
                isSelected={selectedSessionKey === session.sessionKey}
                onClick={() => {
                  setSelectedSessionKey(session.sessionKey);
                  setSidebarVisible(false); // Auto-hide on mobile
                }}
              />
            ))
          )}
        </div>

        {/* Archived Sessions */}
        <div className="sessions-archive-section">
          <button
            className="sessions-archive-toggle"
            onClick={() => setArchiveExpanded(!archiveExpanded)}
          >
            <Archive size={14} />
            <span>Archived Sessions</span>
            {archiveTotal > 0 && <span className="sessions-archive-count">{archiveTotal}</span>}
            {archiveExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>

          {archiveExpanded && (
            <div className="sessions-archive-list">
              {archiveLoading ? (
                <div className="sessions-archive-loading">
                  <Loader size={16} className="sessions-spinner" />
                  <span>Loading archives...</span>
                </div>
              ) : archiveSessions.length === 0 ? (
                <div className="sessions-archive-empty">No archived sessions</div>
              ) : (
                <>
                  {archiveSessions.map((session) => (
                    <div
                      key={session.sessionId}
                      className={`sessions-archive-item ${selectedSessionKey === `archive:${session.sessionId}` ? 'selected' : ''}`}
                      onClick={() => {
                        setSelectedSessionKey(`archive:${session.sessionId}`);
                        setSidebarVisible(false); // Auto-hide on mobile
                      }}
                    >
                      <div className="sessions-archive-item-name" title={session.sessionId}>
                        {session.label || session.sessionId.slice(0, 8)}
                      </div>
                      <div className="sessions-archive-item-meta">
                        {session.lastActivity && (
                          <span className="sessions-archive-item-time">
                            {formatTimeAgo(new Date(session.lastActivity).getTime())}
                          </span>
                        )}
                        <span className="sessions-archive-item-size">
                          {formatFileSize(session.fileSize)}
                        </span>
                      </div>
                    </div>
                  ))}
                  {archiveSessions.length < archiveTotal && (
                    <button className="sessions-archive-load-more" onClick={loadMoreArchive}>
                      Load more ({archiveTotal - archiveSessions.length} remaining)
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Panel - Session Details */}
      <div className="sessions-main">
        {/* Mobile toggle button */}
        <button
          className="sessions-mobile-toggle"
          onClick={() => setSidebarVisible(true)}
          aria-label="Open sessions sidebar"
        >
          <Menu size={20} />
          <span>Sessions</span>
        </button>

        {selectedSession ? (
          <SessionDetail session={selectedSession} />
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

/* Session List Item */
interface SessionListItemProps {
  session: SessionQueueState;
  isSelected: boolean;
  onClick: () => void;
}

const SessionListItem: React.FC<SessionListItemProps> = ({ session, isSelected, onClick }) => {
  const isActive = session.state !== 'idle';
  const channelInfo = getChannelInfo(session.channel, session.sessionKey, session.label, session.kind);

  return (
    <div
      className={`session-list-item ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
      onClick={onClick}
    >
      <div className={`session-state-dot ${session.state}`} />
      <div className="session-list-item-content">
        <div className="session-list-item-name">{session.label}</div>
        <div className="session-list-item-meta">
          <span className="session-list-item-badge">
            {channelInfo.emoji} {channelInfo.label}
          </span>
          <span className="session-list-item-time">
            <Clock size={10} />
            {formatTimeAgo(session.lastActivity)}
          </span>
        </div>
      </div>
    </div>
  );
};

/* Session Detail View */
interface SessionDetailProps {
  session: SessionQueueState;
}

const SessionDetail: React.FC<SessionDetailProps> = ({ session }) => {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [messagesAll, setMessagesAll] = useState(false);
  const [tools, setTools] = useState<ApiToolCall[]>([]);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsAll, setToolsAll] = useState(false);
  const [expandedMsgIndices, setExpandedMsgIndices] = useState<Set<number>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Vertical panel split state
  const [splitRatio, setSplitRatio] = useState(() => {
    const saved = localStorage.getItem('sessionsPanelSplitV');
    return saved ? parseFloat(saved) : 60;
  });
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const toolsEndRef = useRef<HTMLDivElement>(null);
  const messagesListRef = useRef<HTMLDivElement>(null);
  const toolsListRef = useRef<HTMLDivElement>(null);
  const messagesAtBottom = useRef(true);
  const toolsAtBottom = useRef(true);

  useEffect(() => {
    if (!isDragging) return;
    const updateSplit = (clientY: number) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const offsetY = clientY - rect.top;
      const newRatio = (offsetY / rect.height) * 100;
      const clamped = Math.max(20, Math.min(80, newRatio));
      setSplitRatio(clamped);
      localStorage.setItem('sessionsPanelSplitV', clamped.toString());
    };
    const handleMouseMove = (e: MouseEvent) => updateSplit(e.clientY);
    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      updateSplit(e.touches[0].clientY);
    };
    const handleEnd = () => setIsDragging(false);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleEnd);
    };
  }, [isDragging]);

  const tokenPercent = session.tokenUsage.percentUsed;

  // Fetch messages
  useEffect(() => {
    let cancelled = false;
    const fetchMessages = async () => {
      try {
        const url = messagesAll
          ? `${API_BASE_URL}/gateway/session/${session.sessionId}/messages?all=true`
          : `${API_BASE_URL}/gateway/session/${session.sessionId}/messages?limit=20`;
        const response = await authenticatedFetch(url);
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
  }, [session.sessionId, session.state, messagesAll]);

  // Fetch tools
  useEffect(() => {
    let cancelled = false;
    const fetchTools = async () => {
      try {
        const url = toolsAll
          ? `${API_BASE_URL}/gateway/session/${session.sessionId}/tools?all=true`
          : `${API_BASE_URL}/gateway/session/${session.sessionId}/tools?limit=10`;
        const response = await authenticatedFetch(url);
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data.success) {
          setTools(data.tools || []);
        }
      } catch (err) {
        console.error('Failed to fetch tools:', err);
      } finally {
        if (!cancelled) setToolsLoading(false);
      }
    };
    fetchTools();
    const interval = session.state !== 'idle' ? setInterval(fetchTools, 5000) : undefined;
    return () => { cancelled = true; if (interval) clearInterval(interval); };
  }, [session.sessionId, session.state, toolsAll]);

  // Track if user is near bottom of messages list
  const handleMessagesScroll = useCallback(() => {
    const el = messagesListRef.current;
    if (!el) return;
    const threshold = 80;
    messagesAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Track if user is near bottom of tools list
  const handleToolsScroll = useCallback(() => {
    const el = toolsListRef.current;
    if (!el) return;
    const threshold = 80;
    toolsAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Sticky scroll: only auto-scroll if user is at bottom
  useEffect(() => {
    if (messagesAtBottom.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  useEffect(() => {
    if (toolsAtBottom.current) {
      toolsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [tools]);

  const getTokenBarClass = (percent: number): string => {
    if (percent < 30) return 'low';
    if (percent < 60) return 'medium';
    if (percent < 85) return 'high';
    return 'critical';
  };

  // Abbreviate model name for mobile display
  const getAbbreviatedModel = (model: string): string => {
    // Examples:
    // "claude-opus-4-6" → "Opus 4"
    // "claude-sonnet-3-5" → "Sonnet 3.5"
    // "gpt-4" → "GPT-4"
    const lower = model.toLowerCase();
    
    if (lower.includes('opus')) {
      const match = model.match(/opus[- ]?(\d+(?:[.-]\d+)?)/i);
      return match ? `Opus ${match[1].replace('-', '.')}` : 'Opus';
    }
    if (lower.includes('sonnet')) {
      const match = model.match(/sonnet[- ]?(\d+(?:[.-]\d+)?)/i);
      return match ? `Sonnet ${match[1].replace('-', '.')}` : 'Sonnet';
    }
    if (lower.includes('haiku')) {
      const match = model.match(/haiku[- ]?(\d+(?:[.-]\d+)?)/i);
      return match ? `Haiku ${match[1].replace('-', '.')}` : 'Haiku';
    }
    if (lower.includes('gpt')) {
      const match = model.match(/gpt[- ]?(\d+(?:[.-]\d+)?)/i);
      return match ? `GPT-${match[1]}` : 'GPT';
    }
    
    // Fallback: take first word or first 10 chars
    return model.split(/[-_\s]/)[0].substring(0, 10);
  };

  return (
    <div className="session-detail">
      {/* Header - Session Stats */}
      <div className="session-detail-header">
        <div className="session-detail-title">
          <Radio size={16} />
          <h2>{session.displayName}</h2>
        </div>
        <div className="session-detail-stats">
          <div className="session-stat">
            <span className="session-stat-label">Tokens</span>
            <span className="session-stat-value">{formatTokens(session.tokenUsage.total)}</span>
          </div>
          <div className="session-stat">
            <span className="session-stat-label">Context</span>
            <span className="session-stat-value">{formatTokens(session.tokenUsage.context)}</span>
          </div>
          <div className="session-stat">
            <span className="session-stat-label">Used</span>
            <span className="session-stat-value">{tokenPercent}%</span>
          </div>
          <div className="session-stat">
            <span className="session-stat-label">Type</span>
            <span className="session-stat-value">{session.kind || 'direct'}</span>
          </div>
          <div className="session-stat">
            <span className="session-stat-label">Model</span>
            <span className="session-stat-value session-stat-model">
              <span className="model-full">{session.model}</span>
              <span className="model-abbrev">{getAbbreviatedModel(session.model)}</span>
            </span>
          </div>
        </div>
        <div className="session-token-bar">
          <div
            className={`session-token-bar-fill ${getTokenBarClass(tokenPercent)}`}
            style={{ width: `${Math.min(tokenPercent, 100)}%` }}
          />
        </div>
      </div>

      {/* Content Area - Vertical Stack with Draggable Divider */}
      <div className="session-detail-content" ref={containerRef}>
        {/* Messages Panel */}
        <div className="session-messages-panel" style={{ height: `${splitRatio}%` }}>
          <div className="session-panel-header">
            <h3>💬 Messages</h3>
            {!messagesAll && messages.length >= 20 && (
              <button
                className="session-load-all-btn"
                onClick={() => setMessagesAll(true)}
              >
                Load all ↑
              </button>
            )}
          </div>
          <div className="session-messages-list" ref={messagesListRef} onScroll={handleMessagesScroll}>
            {messagesLoading ? (
              <div className="session-panel-loading">
                <Loader size={16} className="session-spinner" />
                <span>Loading messages...</span>
              </div>
            ) : messages.length === 0 ? (
              <div className="session-panel-empty">No messages yet</div>
            ) : (
              <>
                {messages.map((msg, idx) => (
                  <MessageEntry
                    key={`${msg.role}-${msg.timestamp}-${idx}`}
                    message={msg}
                    index={idx}
                    expanded={expandedMsgIndices.has(idx)}
                    onToggle={() => {
                      setExpandedMsgIndices(prev => {
                        const next = new Set(prev);
                        if (next.has(idx)) next.delete(idx); else next.add(idx);
                        return next;
                      });
                    }}
                  />
                ))}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>
        </div>

        {/* Draggable Divider */}
        <div
          className={`panel-divider ${isDragging ? 'dragging' : ''}`}
          onMouseDown={() => setIsDragging(true)}
          onTouchStart={() => setIsDragging(true)}
        />

        {/* Tool Calls Panel */}
        <div className="session-tools-panel" style={{ height: `${100 - splitRatio}%` }}>
          <div className="session-panel-header">
            <h3>
              <Wrench size={14} />
              Tool Calls
              {tools.length > 0 && <span className="session-tools-count">{tools.length}</span>}
            </h3>
            {!toolsAll && tools.length >= 10 && (
              <button
                className="session-load-all-btn"
                onClick={() => setToolsAll(true)}
              >
                Load all ↑
              </button>
            )}
          </div>
          <div className="session-tools-list" ref={toolsListRef} onScroll={handleToolsScroll}>
            {toolsLoading ? (
              <div className="session-panel-loading">
                <Loader size={16} className="session-spinner" />
                <span>Loading tools...</span>
              </div>
            ) : tools.length === 0 ? (
              <div className="session-panel-empty">No tool calls yet</div>
            ) : (
              tools.map((tool, idx) => (
                <ToolCallEntry key={`${tool.name}-${tool.timestamp}-${idx}`} tool={tool} />
              ))
            )}
            <div ref={toolsEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
};

/* Message Entry */
interface MessageEntryProps {
  message: TranscriptMessage;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}

const MessageEntry: React.FC<MessageEntryProps> = ({ message, expanded, onToggle }) => {
  const roleInfo = getRoleInfo(message.role);
  const ts = message.timestamp ? new Date(message.timestamp).getTime() : Date.now();
  const messageText = message.text || '';
  const fullText = message.fullText || messageText;

  return (
    <div className={`session-message ${roleInfo.className}`}>
      <div className="session-message-header">
        <span className="session-message-role">
          <span className="session-role-icon">{roleInfo.icon}</span>
          {roleInfo.label}
        </span>
        <span className="session-message-time">{formatTimeAgo(ts)}</span>
      </div>
      <div className={`session-message-text${message.truncated && expanded ? ' expanded' : ''}`}>
        {message.truncated && expanded ? fullText : messageText}
        {message.truncated && !expanded ? '…' : ''}
      </div>
      {message.truncated && (
        <button className="session-message-toggle" onClick={(e) => { e.stopPropagation(); onToggle(); }}>
          {expanded ? 'Show less ▲' : 'Show more ▾'}
        </button>
      )}
    </div>
  );
};

/* Extract MEDIA: image references from tool output */
function extractMediaImages(text: string): { cleanText: string; images: { filename: string; relativePath: string }[] } {
  const mediaRegex = /MEDIA:([^\s]+\.(?:jpg|jpeg|png|gif|webp))/gi;
  const images: { filename: string; relativePath: string }[] = [];
  let cleanText = text;

  let match;
  while ((match = mediaRegex.exec(text)) !== null) {
    const fullPath = match[1];
    const mediaIdx = fullPath.indexOf('/media/');
    const relativePath = mediaIdx !== -1 ? fullPath.substring(mediaIdx + 7) : fullPath.split('/').slice(-2).join('/');
    const filename = fullPath.split('/').pop() || 'screenshot';
    images.push({ filename, relativePath });
    cleanText = cleanText.replace(match[0], '').trim();
  }

  return { cleanText, images };
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

  if (error) return <span style={{ color: '#e74c3c', fontSize: '12px' }}>⚠️ {filename}</span>;
  if (!blobUrl) return null;

  return (
    <>
      <img
        src={blobUrl}
        alt={filename}
        style={{ maxWidth: '100%', maxHeight: '300px', borderRadius: '8px', cursor: 'pointer', marginBottom: '8px' }}
        onClick={(e) => { e.stopPropagation(); setLightbox(true); }}
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

/* Tool Call Entry */
interface ToolCallEntryProps {
  tool: ApiToolCall;
}

const ToolCallEntry: React.FC<ToolCallEntryProps> = ({ tool }) => {
  const [expanded, setExpanded] = useState(false);
  const toolType = getToolType(tool.name);
  const hasOutput = !!tool.output;
  const ts = tool.timestamp ? new Date(tool.timestamp).getTime() : Date.now();

  return (
    <div
      className={`session-tool-entry ${tool.status || 'done'} ${toolType}`}
      onClick={(e) => { e.stopPropagation(); if (hasOutput) setExpanded(!expanded); }}
    >
      <div className="session-tool-header">
        <div className="session-tool-name-row">
          <span className={`session-tool-icon-badge ${toolType}`}>
            {getToolIcon(tool.name)}
          </span>
          <span className="session-tool-display-name">{getToolDisplayName(tool.name)}</span>
          {tool.status === 'running' && <Loader size={11} className="session-tool-spinner" />}
          {tool.status === 'error' && <AlertCircle size={11} className="session-tool-error-icon" />}
          {tool.status === 'done' && <CheckCircle2 size={11} className="session-tool-done-icon" />}
        </div>
        <div className="session-tool-meta">
          {tool.durationMs != null && (
            <span className="session-tool-duration">{formatDuration(tool.durationMs)}</span>
          )}
          <span className="session-tool-time">{formatTimeAgo(ts)}</span>
          {hasOutput && (
            <span className="session-tool-expand-hint">
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
        </div>
      </div>

      {/* Input display */}
      {tool.input && (
        <div className={`session-tool-input-block ${toolType}`}>
          {toolType === 'exec' ? (
            <div className="session-terminal-input">
              <span className="session-terminal-prompt">$</span>
              <code>{tool.input.startsWith('$ ') ? tool.input.slice(2) : tool.input}</code>
            </div>
          ) : toolType === 'browser' ? (
            <div className="session-browser-input">
              <Globe size={11} className="session-browser-url-icon" />
              <span className="session-browser-url">{tool.input}</span>
            </div>
          ) : toolType === 'file' ? (
            <div className="session-file-input">
              <FileText size={11} />
              <code>{tool.input}</code>
            </div>
          ) : (
            <div className="session-generic-input">
              <code>{tool.input}</code>
            </div>
          )}
        </div>
      )}

      {/* Output display */}
      {expanded && tool.output && (() => {
        const { cleanText, images } = extractMediaImages(String(tool.output));
        return (
          <div className={`session-tool-output-block ${toolType}`}>
            {images.length > 0 && images.map((img, i) => (
              <ScreenshotImage key={i} relativePath={img.relativePath} filename={img.filename} />
            ))}
            {cleanText && (
              toolType === 'exec' ? (
                <div className="session-terminal-output">
                  <pre>{cleanText}</pre>
                </div>
              ) : (
                <div className="session-generic-output">
                  <pre>{cleanText}</pre>
                </div>
              )
            )}
          </div>
        );
      })()}
    </div>
  );
};
