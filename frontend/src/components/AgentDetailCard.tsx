import { authenticatedFetch } from '../utils/auth';
import { useState, useEffect } from 'react';
import './AgentDetailCard.css';

interface AgentDetail {
  key: string;
  label: string;
  model: string;
  modelAlias: string;
  status: 'running' | 'idle' | 'completed';
  contextUsage: {
    used: number;
    max: number;
    percent: number;
  };
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  currentTask: string;
  updatedAt: number;
  ageFormatted: string;
}

interface AgentDetailCardProps {
  agentKey: string;
  onClose: () => void;
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function getLevel(percent: number): 'low' | 'medium' | 'high' {
  if (percent >= 80) return 'high';
  if (percent >= 50) return 'medium';
  return 'low';
}

export function AgentDetailCard({ agentKey, onClose }: AgentDetailCardProps) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

  const fetchDetail = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await authenticatedFetch(`${API_BASE}/agents/${encodeURIComponent(agentKey)}`);
      
      if (!res.ok) {
        throw new Error(`Failed to fetch agent details: ${res.statusText}`);
      }
      
      const data = await res.json();
      setDetail(data);
    } catch (err) {
      console.error('Failed to fetch agent detail:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetail();
    
    // Refresh every 5 seconds while card is open
    const interval = setInterval(fetchDetail, 5000);
    
    return () => clearInterval(interval);
  }, [agentKey]);

  if (loading && !detail) {
    return (
      <div className="agent-detail-card">
        <div className="agent-detail-loading">Loading...</div>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="agent-detail-card">
        <div className="agent-detail-error">
          {error || 'Failed to load agent details'}
        </div>
      </div>
    );
  }

  const level = getLevel(detail.contextUsage.percent);

  return (
    <div className="agent-detail-card">
      <div className="agent-detail-header">
        <div className="agent-detail-title">
          <span className={`agent-detail-status ${detail.status}`}></span>
          <span className="agent-detail-label">{detail.label}</span>
        </div>
        <button 
          className="agent-detail-close" 
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="agent-detail-body">
        {/* Model */}
        <div className="agent-detail-section">
          <div className="agent-detail-row">
            <span className="agent-detail-key">Model</span>
            <span className="agent-detail-value agent-detail-model">
              {detail.modelAlias}
            </span>
          </div>
        </div>

        {/* Status */}
        <div className="agent-detail-section">
          <div className="agent-detail-row">
            <span className="agent-detail-key">Status</span>
            <span className={`agent-detail-value agent-detail-state ${detail.status}`}>
              {detail.status === 'running' ? '🏃 Working' : 
               detail.status === 'idle' ? '💤 Idle' : 
               '✅ Completed'}
            </span>
          </div>
          <div className="agent-detail-row">
            <span className="agent-detail-key">Age</span>
            <span className="agent-detail-value">{detail.ageFormatted}</span>
          </div>
        </div>

        {/* Context Usage */}
        <div className="agent-detail-section">
          <div className="agent-detail-row">
            <span className="agent-detail-key">Context</span>
            <span className={`agent-detail-value ${level}`}>
              {detail.contextUsage.percent}%
            </span>
          </div>
          <div className="agent-detail-context-bar">
            <div 
              className={`agent-detail-context-fill ${level}`}
              style={{ width: `${Math.min(detail.contextUsage.percent, 100)}%` }}
            />
          </div>
          <div className="agent-detail-row agent-detail-subtext">
            <span className="agent-detail-key">Used</span>
            <span className="agent-detail-value">
              {formatTokens(detail.contextUsage.used)} / {formatTokens(detail.contextUsage.max)}
            </span>
          </div>
        </div>

        {/* Tokens */}
        <div className="agent-detail-section">
          <div className="agent-detail-row">
            <span className="agent-detail-key">Input tokens</span>
            <span className="agent-detail-value">{formatTokens(detail.tokens.input)}</span>
          </div>
          <div className="agent-detail-row">
            <span className="agent-detail-key">Output tokens</span>
            <span className="agent-detail-value">{formatTokens(detail.tokens.output)}</span>
          </div>
          <div className="agent-detail-row">
            <span className="agent-detail-key">Total tokens</span>
            <span className="agent-detail-value">{formatTokens(detail.tokens.total)}</span>
          </div>
        </div>

        {/* Current Task */}
        <div className="agent-detail-section">
          <div className="agent-detail-task-label">Current Task</div>
          <div className="agent-detail-task">{detail.currentTask}</div>
        </div>
      </div>
    </div>
  );
}
