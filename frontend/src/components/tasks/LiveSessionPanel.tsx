import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Task } from '../../types/task';
import { useWebSocket } from '../../hooks/useWebSocket';
import { authenticatedFetch } from '../../utils/auth';
import { Terminal, Send, Pause, Play, XCircle, MessageCircle, ChevronDown, ChevronUp } from 'lucide-react';
import './LiveSessionPanel.css';
import { buildDiscordThreadUrl } from '../../utils/discordLinks';

const API_BASE_URL = (import.meta as any).env?.VITE_API_BASE_URL || '/api';

interface SessionMessage {
  id: string;
  type: 'agent' | 'user' | 'system' | 'tool';
  text: string;
  timestamp: number;
  toolName?: string;
}

interface SessionLiveState {
  state: 'idle' | 'busy' | 'thinking' | 'tool-use' | 'typing';
  recentTools?: any[];
  lastActivity?: number;
  isGenerating?: boolean;
}

export interface LiveSessionTaskRef extends Pick<
  Task,
  'id' | 'title' | 'status' | 'executionMode' | 'acpSessionKey' | 'discordThreadId' | 'discordThreadUrl' | 'activeAgent'
> {}

interface LiveSessionPanelProps {
  task: LiveSessionTaskRef;
  onTaskUpdate?: (updates: Partial<Task>) => void;
  variant?: 'full' | 'inline-controls';
  title?: string;
  description?: string;
  inputPlaceholder?: string;
}

export const LiveSessionPanel: React.FC<LiveSessionPanelProps> = ({
  task,
  onTaskUpdate,
  variant = 'full',
  title,
  description,
  inputPlaceholder,
}) => {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [steerInput, setSteerInput] = useState('');
  const [sending, setSending] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [paused, setPaused] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [inlineNotice, setInlineNotice] = useState<string | null>(null);
  const [sessionLiveState, setSessionLiveState] = useState<SessionLiveState | null>(null);
  const [sessionStateLoaded, setSessionStateLoaded] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { subscribe } = useWebSocket();
  const messageIdRef = useRef(0);
  const liveStreamRef = useRef<{ type: SessionMessage['type']; text: string } | null>(null);
  const isInlineControls = variant === 'inline-controls';
  const panelTitle = title || (isInlineControls ? 'Task steering' : 'Live Session');

  const sessionKey = task.acpSessionKey ||
    (typeof task.activeAgent === 'object' && task.activeAgent?.sessionKey) || null;

  const canControl = task.status === 'in-progress' && !!sessionKey;
  const isLive = canControl && !!sessionLiveState && sessionLiveState.state !== 'idle';
  const sessionStateLabel = sessionLiveState?.state === 'tool-use'
    ? 'Using tool'
    : sessionLiveState?.state
      ? sessionLiveState.state.replace('-', ' ')
      : null;

  useEffect(() => {
    if (!sessionKey) {
      setSessionLiveState(null);
      setSessionStateLoaded(true);
      return;
    }

    let cancelled = false;
    setSessionStateLoaded(false);

    authenticatedFetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionKey)}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Session lookup failed (${response.status})`);
        }
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        setSessionLiveState(data?.session?.liveState ?? null);
        setSessionStateLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[LiveSessionPanel] session state fetch failed:', err);
        setSessionLiveState(null);
        setSessionStateLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, []);

  // Subscribe to session output events
  useEffect(() => {
    if (!sessionKey) return;

    const handleSessionOutput = (msg: any) => {
      if (msg.sessionKey !== sessionKey) return;

      const newMsg: SessionMessage = {
        id: `msg-${++messageIdRef.current}`,
        type: msg.stream === 'tool_call' ? 'tool' : 'agent',
        text: msg.text || '',
        timestamp: msg.timestamp || Date.now(),
        toolName: msg.toolName,
      };

      if (!newMsg.text) return;

      setMessages(prev => {
        const activeStream = liveStreamRef.current;

        if (
          activeStream &&
          activeStream.type === newMsg.type &&
          newMsg.text.startsWith(activeStream.text) &&
          prev.length > 0
        ) {
          const next = [...prev];
          next[next.length - 1] = {
            ...next[next.length - 1],
            text: newMsg.text,
            timestamp: newMsg.timestamp,
            toolName: newMsg.toolName,
          };
          liveStreamRef.current = { type: newMsg.type, text: newMsg.text };
          return next;
        }

        liveStreamRef.current = { type: newMsg.type, text: newMsg.text };
        return [...prev, newMsg];
      });
    };

    const handleTaskUpdated = (msg: any) => {
      if (msg.task?.id === task.id) {
        onTaskUpdate?.(msg.task);
      }
    };

    const handleSessionLiveState = (msg: any) => {
      if (msg.sessionKey !== sessionKey) return;
      setSessionLiveState(msg.liveState ?? null);
      setSessionStateLoaded(true);
    };

    const handleSessionCompleted = (msg: any) => {
      if (msg.sessionKey !== sessionKey) return;
      setSessionLiveState(null);
      setSessionStateLoaded(true);
    };

    const unsubs = [
      subscribe('session:output', handleSessionOutput),
      subscribe('task:updated', handleTaskUpdated),
      subscribe('sessions:live-state', handleSessionLiveState),
      subscribe('sessions:completed', handleSessionCompleted),
    ];

    return () => unsubs.forEach(fn => fn());
  }, [sessionKey, task.id, subscribe, onTaskUpdate]);

  // Auto-scroll on new messages
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Send steer message
  const handleSend = async () => {
    const text = steerInput.trim();
    if (!text || !sessionKey || sending) return;

    setSending(true);
    setSteerInput('');

    // Add user message immediately
    setMessages(prev => [...prev, {
      id: `msg-${++messageIdRef.current}`,
      type: 'user',
      text,
      timestamp: Date.now(),
    }]);

    try {
      await authenticatedFetch(`${API_BASE_URL}/tasks/${task.id}/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      setInlineNotice('Steering sent. Transcript below will update automatically.');
    } catch (err) {
      setMessages(prev => [...prev, {
        id: `msg-${++messageIdRef.current}`,
        type: 'system',
        text: `Failed to send: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: Date.now(),
      }]);
      setInlineNotice(`Failed to send: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  // Handle keyboard in input
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Pause/Resume
  const handlePauseToggle = async () => {
    const action = paused ? 'resume' : 'pause';
    try {
      await authenticatedFetch(`${API_BASE_URL}/tasks/${task.id}/${action}`, {
        method: 'POST',
      });
      setPaused(!paused);
      setInlineNotice(paused ? 'Session resumed.' : 'Session paused.');
    } catch (err) {
      console.error(`Failed to ${action}:`, err);
      setInlineNotice(`Failed to ${action}.`);
    }
  };

  // Cancel session
  const handleCancel = async () => {
    if (!cancelConfirm) {
      setCancelConfirm(true);
      setTimeout(() => setCancelConfirm(false), 3000);
      return;
    }

    try {
      await authenticatedFetch(`${API_BASE_URL}/tasks/${task.id}/cancel`, {
        method: 'POST',
      });
      setMessages(prev => [...prev, {
        id: `msg-${++messageIdRef.current}`,
        type: 'system',
        text: 'Session cancelled.',
        timestamp: Date.now(),
      }]);
      setCancelConfirm(false);
      setInlineNotice('Session cancelled.');
    } catch (err) {
      console.error('Failed to cancel:', err);
      setInlineNotice('Failed to cancel session.');
    }
  };

  // Discord thread link
  const discordThreadUrl = buildDiscordThreadUrl(task.discordThreadId, task.discordThreadUrl);

  if (!sessionKey && task.executionMode !== 'interactive') return null;

  return (
    <div className={`live-session-panel ${isInlineControls ? 'live-session-panel-inline' : ''}`}>
      {/* Panel Header */}
      <div
        className={`live-session-header ${isInlineControls ? 'live-session-header-static' : ''}`}
        onClick={isInlineControls ? undefined : () => setCollapsed(!collapsed)}
      >
        <div className="live-session-header-left">
          <Terminal size={14} />
          <span className="live-session-title">{panelTitle}</span>
          {isLive && <span className="live-session-active-dot" />}
          {canControl && sessionStateLoaded && !isLive && (
            <span className="live-session-state-pill">{sessionStateLabel || 'Idle'}</span>
          )}
        </div>
        <div className="live-session-header-right">
          {/* Control Buttons */}
          {canControl && !collapsed && (
            <div className="live-session-controls" onClick={e => e.stopPropagation()}>
              <button
                className={`live-session-ctrl-btn ${paused ? 'ctrl-resume' : 'ctrl-pause'}`}
                onClick={handlePauseToggle}
                title={paused ? 'Resume session' : 'Pause session'}
              >
                {paused ? <Play size={13} /> : <Pause size={13} />}
              </button>
              <button
                className={`live-session-ctrl-btn ctrl-cancel ${cancelConfirm ? 'ctrl-confirm' : ''}`}
                onClick={handleCancel}
                title={cancelConfirm ? 'Click again to confirm' : 'Cancel session'}
              >
                <XCircle size={13} />
                {cancelConfirm && <span>Confirm?</span>}
              </button>
              {discordThreadUrl && (
                <a
                  href={discordThreadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="live-session-ctrl-btn ctrl-discord"
                  title="Open Discord thread"
                  onClick={e => e.stopPropagation()}
                >
                  <MessageCircle size={13} />
                </a>
              )}
            </div>
          )}
          {!isInlineControls && (
            <button className="live-session-collapse-btn">
              {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          )}
        </div>
      </div>

      {(description || inlineNotice || isInlineControls) && !collapsed && (
        <div className="live-session-meta">
          {description && <div className="live-session-description">{description}</div>}
          {inlineNotice && <div className="live-session-notice">{inlineNotice}</div>}
          {isInlineControls && !description && !inlineNotice && task.title && (
            <div className="live-session-description">Linked task: {task.title}</div>
          )}
        </div>
      )}

      {/* Terminal Output */}
      {!collapsed && !isInlineControls && (
        <>
          <div className="live-session-output" ref={outputRef}>
            {messages.length === 0 ? (
              <div className="live-session-empty">
                {isLive
                  ? 'Waiting for session output...'
                  : canControl
                    ? 'Session is currently idle. You can still send a steer message if the task should resume.'
                    : 'No active session. Session output will appear here when running.'}
              </div>
            ) : (
              messages.map(msg => (
                <div key={msg.id} className={`live-session-msg msg-${msg.type}`}>
                  {msg.type === 'user' && <span className="msg-prefix">you &gt;</span>}
                  {msg.type === 'tool' && <span className="msg-prefix">[{msg.toolName || 'tool'}]</span>}
                  {msg.type === 'system' && <span className="msg-prefix">[system]</span>}
                  <span className="msg-text">{msg.text}</span>
                </div>
              ))
            )}
          </div>

          {/* Steer Input */}
          {canControl && (
            <div className="live-session-input-row">
              <textarea
                ref={inputRef}
                className="live-session-input"
                value={steerInput}
                onChange={e => setSteerInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={inputPlaceholder || 'Send a message to the agent... (Enter to send, Shift+Enter for newline)'}
                rows={1}
                disabled={sending}
              />
              <button
                className="live-session-send-btn"
                onClick={handleSend}
                disabled={!steerInput.trim() || sending}
                title="Send message (Enter)"
              >
                <Send size={14} />
              </button>
            </div>
          )}
        </>
      )}

      {!collapsed && isInlineControls && canControl && (
        <div className="live-session-input-row">
          <textarea
            ref={inputRef}
            className="live-session-input"
            value={steerInput}
            onChange={e => setSteerInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={inputPlaceholder || 'Steer this task from the Sessions page...'}
            rows={1}
            disabled={sending}
          />
          <button
            className="live-session-send-btn"
            onClick={handleSend}
            disabled={!steerInput.trim() || sending}
            title="Send message (Enter)"
          >
            <Send size={14} />
          </button>
        </div>
      )}
    </div>
  );
};
