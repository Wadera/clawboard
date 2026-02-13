import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { authenticatedFetch } from '../../utils/auth';
import { useWebSocket } from '../../hooks/useWebSocket';
import './MessageQueueCard.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface SessionQueueState {
  sessionKey: string;
  state: 'idle' | 'busy' | 'thinking' | 'tool-use' | 'typing';
  lastActivity: number;
}

interface QueueSnapshot {
  sessions: SessionQueueState[];
  activeSessions: number;
  totalSessions: number;
  connected: boolean;
}

export const MessageQueueCard: React.FC = () => {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
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

  // WebSocket real-time updates
  useEffect(() => {
    const unsub = subscribe('gateway:queue-update', (msg: { data: QueueSnapshot }) => {
      setSnapshot(msg.data);
      setLoading(false);
    });
    return unsub;
  }, [subscribe]);

  // Count recent sessions (active or updated in last 30min)
  const recentSessionCount = snapshot?.sessions.filter(s => {
    const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
    return s.state !== 'idle' || s.lastActivity > thirtyMinAgo;
  }).length ?? 0;

  const activeSessions = snapshot?.activeSessions ?? 0;
  const hasActive = activeSessions > 0;

  if (loading) {
    return (
      <div className="mq-card">
        <div className="mq-card-loading">
          <div className="mq-card-spinner" />
          <span>Connecting...</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`mq-card ${hasActive ? 'has-active' : ''}`}
      onClick={() => navigate('/sessions')}
    >
      <div className="mq-card-header">
        <div className="mq-card-title">
          <h3>💬 Message Queue</h3>
        </div>
        <div className="mq-card-actions">
          {hasActive && <span className="mq-card-badge">{activeSessions}</span>}
          <ChevronRight size={18} className="mq-card-arrow" />
        </div>
      </div>

      <div className="mq-card-status">
        <div className={`mq-card-dot ${snapshot?.connected ? 'connected' : 'disconnected'}`} />
        <span>
          {snapshot?.connected ? 'Gateway connected' : 'Gateway disconnected'}
          {recentSessionCount > 0 && ` · ${recentSessionCount} session${recentSessionCount !== 1 ? 's' : ''}`}
        </span>
      </div>
    </div>
  );
};
