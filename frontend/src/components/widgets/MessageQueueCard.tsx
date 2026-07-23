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

type PipelineHealthStatus = 'healthy' | 'degraded' | 'unknown' | 'unavailable';

interface PipelineAdapterHealth {
  source: string;
  source_instance: string;
  status: string;
  reason_code: string | null;
  last_source_at: string | null;
  last_success_at: string | null;
  checked_at: string;
}

interface PipelineHealthSnapshot {
  status: PipelineHealthStatus;
  adapters: PipelineAdapterHealth[];
  error?: string;
}

/**
 * Summarise all configured ingestion paths without letting one optional harness
 * misrepresent the whole pipeline. Mixed health is degraded; it is never fully
 * healthy or fully unavailable. A pipeline is unavailable only when every
 * reported adapter is unavailable/unauthorised.
 */
export function aggregatePipelineHealth(adapters: PipelineAdapterHealth[]): PipelineHealthStatus {
  if (adapters.length === 0) return 'unknown';

  const statuses = adapters.map(adapter => adapter.status);
  const healthyCount = statuses.filter(status => status === 'healthy').length;
  const unavailableCount = statuses.filter(
    status => status === 'unavailable' || status === 'unauthorized',
  ).length;

  if (healthyCount === adapters.length) return 'healthy';
  if (unavailableCount === adapters.length) return 'unavailable';
  return 'degraded';
}

function formatHealthLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
}

function formatReason(reason: string | null): string | null {
  if (!reason) return null;
  return reason.replace(/_/g, ' ');
}

function formatAdapterTime(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const MessageQueueCard: React.FC = () => {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [pipelineHealth, setPipelineHealth] = useState<PipelineHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { subscribe } = useWebSocket();

  // Fetch the legacy activity snapshot and canonical pipeline health independently.
  // The activity feed may be unavailable while one or both canonical adapters remain healthy.
  const fetchQueue = useCallback(async () => {
    try {
      const [queueResult, healthResult] = await Promise.allSettled([
        authenticatedFetch(`${API_BASE_URL}/gateway/queue`),
        authenticatedFetch(`${API_BASE_URL}/sessions/pipeline-health`),
      ]);

      if (queueResult.status === 'fulfilled' && queueResult.value.ok) {
        const data = await queueResult.value.json();
        if (data.success) {
          setSnapshot({
            sessions: data.sessions,
            activeSessions: data.activeSessions,
            totalSessions: data.totalSessions,
            connected: data.connected,
          });
        }
      }

      if (healthResult.status === 'fulfilled') {
        const response = healthResult.value;
        const data = await response.json().catch(() => null);
        if (response.ok && data?.success) {
          const adapters = Array.isArray(data.adapters) ? data.adapters : [];
          setPipelineHealth({
            status: aggregatePipelineHealth(adapters),
            adapters,
          });
        } else {
          setPipelineHealth({
            status: 'unavailable',
            adapters: [],
            error: data?.error || `pipeline_health_http_${response.status}`,
          });
        }
      } else {
        setPipelineHealth({
          status: 'unavailable',
          adapters: [],
          error: 'pipeline_health_request_failed',
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
      data-pipeline-health={pipelineHealth?.status ?? 'loading'}
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
        <div className={`mq-card-dot ${pipelineHealth?.status ?? 'unknown'}`} />
        <span>
          Pipeline {formatHealthLabel(pipelineHealth?.status ?? 'unknown')}
          {recentSessionCount > 0 && ` · ${recentSessionCount} session${recentSessionCount !== 1 ? 's' : ''}`}
        </span>
      </div>

      {pipelineHealth?.error && (
        <div className="mq-card-health-error" role="status">
          Health details unavailable · {formatReason(pipelineHealth.error)}
        </div>
      )}

      {pipelineHealth && pipelineHealth.adapters.length > 0 && (
        <div className="mq-card-adapters" aria-label="Message pipeline adapter health">
          {pipelineHealth.adapters.map(adapter => {
            const reason = formatReason(adapter.reason_code);
            return (
              <div
                className="mq-card-adapter"
                key={`${adapter.source}:${adapter.source_instance}`}
                title={`Checked ${formatAdapterTime(adapter.checked_at)}`}
              >
                <div className="mq-card-adapter-heading">
                  <span>{formatHealthLabel(adapter.source)}</span>
                  <strong className={`mq-card-adapter-state ${adapter.status}`}>
                    {formatHealthLabel(adapter.status)}
                  </strong>
                </div>
                {reason && <div className="mq-card-adapter-reason">{reason}</div>}
                <div className="mq-card-adapter-times">
                  <span>Last success: {formatAdapterTime(adapter.last_success_at)}</span>
                  <span>Source seen: {formatAdapterTime(adapter.last_source_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
