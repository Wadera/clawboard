import { authenticatedFetch } from '../utils/auth';
import { useState, useEffect } from 'react';
import './RateLimitWidget.css';

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

function shortName(model: string, alias?: string): string {
  if (alias) return alias;
  const parts = model.split('/');
  return parts[parts.length - 1] || model;
}

function providerIcon(provider: string): string {
  if (provider.includes('anthropic')) return '🟣';
  if (provider.includes('google')) return '🔵';
  if (provider.includes('openai')) return '🟢';
  return '⚪';
}

export function RateLimitWidget() {
  const [status, setStatus] = useState<RateLimitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

  const fetchStatus = async () => {
    try {
      const res = await authenticatedFetch(`${API_BASE}/rate-limits`);
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setStatus(data);
        }
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 60000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="rate-limit-widget">
        <div className="rlw-header">
          <h3>🧠 Model Status</h3>
        </div>
        <div className="rlw-loading">Loading...</div>
      </div>
    );
  }

  if (!status || !status.statusAvailable) {
    return (
      <div className="rate-limit-widget">
        <div className="rlw-header">
          <h3>🧠 Model Status</h3>
        </div>
        <div className="rlw-unavailable">Status unavailable</div>
      </div>
    );
  }

  const activeModel = status.models.find(m => m.isDefault) || status.models[0];
  const fallbackModels = status.models.filter(m => m.isFallback);
  const otherModels = status.models.filter(m => !m.isDefault && !m.isFallback);

  return (
    <div className="rate-limit-widget">
      <div className="rlw-header" onClick={() => setExpanded(!expanded)}>
        <h3>🧠 Model Status</h3>
        <span className="rlw-toggle">{expanded ? '▼' : '▶'}</span>
      </div>

      {/* Active model - always visible */}
      <div className="rlw-active">
        <div className="rlw-active-label">Active Model</div>
        <div className="rlw-active-model">
          {activeModel && (
            <>
              {providerIcon(activeModel.provider)}
              <span className="rlw-model-name">{shortName(activeModel.name, activeModel.alias)}</span>
              <span className={`rlw-status-dot ${activeModel.rateLimited ? 'limited' : 'ok'}`} />
            </>
          )}
        </div>
        {status.fallbackActive && (
          <div className="rlw-fallback-notice">⚠️ Primary exhausted — using fallback</div>
        )}
      </div>

      {/* Summary counts */}
      <div className="rlw-summary">
        <span className="rlw-count">{status.models.filter(m => m.available).length} available</span>
        <span className="rlw-sep">·</span>
        <span className="rlw-count">{status.fallbacks.length} fallback{status.fallbacks.length !== 1 ? 's' : ''}</span>
        {status.models.some(m => m.rateLimited) && (
          <>
            <span className="rlw-sep">·</span>
            <span className="rlw-count rlw-limited">{status.models.filter(m => m.rateLimited).length} limited</span>
          </>
        )}
      </div>

      {/* Expanded model list */}
      {expanded && (
        <div className="rlw-model-list">
          {fallbackModels.length > 0 && (
            <div className="rlw-section">
              <div className="rlw-section-label">Fallbacks</div>
              {fallbackModels.map(m => (
                <div key={m.name} className="rlw-model-row">
                  {providerIcon(m.provider)}
                  <span className="rlw-model-name">{shortName(m.name, m.alias)}</span>
                  <span className={`rlw-status-dot ${m.rateLimited ? 'limited' : 'ok'}`} />
                </div>
              ))}
            </div>
          )}
          {otherModels.length > 0 && (
            <div className="rlw-section">
              <div className="rlw-section-label">Other Models</div>
              {otherModels.map(m => (
                <div key={m.name} className="rlw-model-row">
                  {providerIcon(m.provider)}
                  <span className="rlw-model-name">{shortName(m.name, m.alias)}</span>
                  <span className={`rlw-status-dot ${m.rateLimited ? 'limited' : 'ok'}`} />
                </div>
              ))}
            </div>
          )}
          <div className="rlw-cached">
            Cached: {new Date(status.cachedAt).toLocaleTimeString()}
          </div>
        </div>
      )}
    </div>
  );
}
