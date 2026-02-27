import { authenticatedFetch } from '../utils/auth';
import { useState, useEffect, useContext, useRef } from 'react';
import { getProfileDisplayName, isPrimaryProfile } from '../constants/authProfiles';
import { ModelSwitchContext } from '../contexts/ModelSwitchContext';
import './ModelStatusBadge.css';

type AgentStatus = 'working' | 'idle' | 'unknown';

interface SubagentInfo {
  key: string;
  label: string;
  model: string;
  modelAlias: string;
  totalTokens: number;
  status: AgentStatus;
  updatedAt: number;
}

interface ModelStatus {
  model: string;
  modelAlias: string;
  isOverride: boolean;
  defaultModel: string;
  agentStatus: AgentStatus;
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
  session: {
    key: string;
    ageMs: number;
    ageFormatted: string;
  };
  authProfile: {
    name: string;
    provider: string;
    isAutoSelected: boolean;
  } | null;
  subagents: SubagentInfo[];
  activeSubagentCount: number;
  usageStats: {
    session: { percentLeft: number; timeLeft: string };
    weekly: { percentLeft: number; timeLeft: string };
    updatedAt: string;
    checkedAt: string;
    dataAge: number;
    stale: boolean;
  } | null;
  openclawVersion: string | null;
  updatedAt: string;
}

function getLevel(percent: number): 'low' | 'medium' | 'high' {
  if (percent >= 80) return 'high';
  if (percent >= 50) return 'medium';
  return 'low';
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** Format "last updated X ago" for freshness indicator */
function formatFreshness(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 5000) return 'just now';
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  return `${Math.floor(ms / 3600000)}h ago`;
}

function getStatusIndicator(status: AgentStatus): { icon: string; label: string; className: string } {
  switch (status) {
    case 'working':
      return { icon: '⚡', label: 'Working', className: 'status-working' };
    case 'idle':
      return { icon: '💤', label: 'Idle', className: 'status-idle' };
    default:
      return { icon: '❓', label: 'Unknown', className: 'status-unknown' };
  }
}

interface ModelStatusBadgeProps {
  compact?: boolean;
}

export function ModelStatusBadge({ compact = false }: ModelStatusBadgeProps) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const [isSticky, setIsSticky] = useState(false); // Sticky state for click-to-toggle
  const badgeRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  
  // Get model switch state from context (optional - context may not be available)
  const modelSwitchContext = useContext(ModelSwitchContext);
  const isSwitching = modelSwitchContext?.state.isSwitching || false;
  const targetModel = modelSwitchContext?.state.targetModel || null;

  const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
  
  // Get model switch hook for reset functionality (safe - returns no-op if no context)
  const modelSwitchHook = modelSwitchContext ? { 
    startSwitch: modelSwitchContext.startSwitch, 
    completeSwitch: modelSwitchContext.completeSwitch 
  } : { 
    startSwitch: () => {}, 
    completeSwitch: () => {} 
  };
  const { startSwitch, completeSwitch } = modelSwitchHook;

  // Fetch model status
  const fetchStatus = async () => {
    try {
      const res = await authenticatedFetch(`${API_BASE}/models/status`);
      if (res.ok) {
        const data = await res.json();
        if (data.success !== false) {
          // Normalize API response with safe defaults for all fields the component uses
          const activeProfile = data.activeProfile || null;
          const profileData = activeProfile && data.profiles?.[activeProfile];
          setStatus({
            ...data,
            model: data.model || data.activeModel || 'unknown',
            modelAlias: data.modelAlias || data.activeModel?.split('/').pop() || 'unknown',
            contextUsage: data.contextUsage || { percent: 0, used: 0, max: 200000 },
            session: data.session || { ageFormatted: 'just now' },
            tokens: data.tokens || { total: data.contextUsage?.used || 0, input: 0, output: 0 },
            agentStatus: data.agentStatus || 'idle',
            subagents: data.subagents || [],
            authProfile: data.authProfile || (activeProfile ? { name: activeProfile, ...profileData } : null),
            usageStats: data.usageStats || null,
            updatedAt: data.updatedAt || Date.now(),
          });
        }
      }
    } catch {
      // Silently fail — not critical
    }
  };

  // Reset to default model
  const handleResetToDefault = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!status || !status.isOverride || !status.defaultModel) return;

    try {
      startSwitch(status.defaultModel);
      const res = await authenticatedFetch(`${API_BASE}/models/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: status.defaultModel }),
      });

      if (res.ok) {
        completeSwitch(true);
        // Refresh status after successful switch
        setTimeout(fetchStatus, 1000);
      } else {
        const errorData = await res.json();
        completeSwitch(false, errorData.error || 'Failed to switch model');
      }
    } catch (err) {
      completeSwitch(false, err instanceof Error ? err.message : 'Network error');
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000); // Refresh every 30s as fallback
    return () => clearInterval(interval);
  }, []);

  // Also listen for WebSocket updates (primary real-time source)
  // When WS data arrives, it becomes the source of truth (stop HTTP polling flicker)
  useEffect(() => {
    const handler = (event: CustomEvent<any>) => {
      const data = event.detail;
      if (!data) return;
      // Normalize WS data with same defaults as HTTP fetch
      const activeProfile = data.activeProfile || null;
      const profileData = activeProfile && data.profiles?.[activeProfile];
      setStatus({
        ...data,
        model: data.model || data.activeModel || 'unknown',
        modelAlias: data.modelAlias || data.activeModel?.split('/').pop() || data.model?.split('/').pop() || 'unknown',
        contextUsage: data.contextUsage || { percent: 0, used: 0, max: 200000 },
        session: data.session || { ageFormatted: 'just now' },
        tokens: data.tokens || { total: data.contextUsage?.used || 0, input: 0, output: 0 },
        agentStatus: data.agentStatus || 'idle',
        subagents: data.subagents || [],
        authProfile: data.authProfile || (activeProfile ? { name: activeProfile, ...profileData } : null),
        usageStats: data.usageStats || null,
        updatedAt: data.updatedAt || Date.now(),
      });
    };
    window.addEventListener('model:status' as any, handler);
    return () => window.removeEventListener('model:status' as any, handler);
  }, []);

  // Handle click-outside to close sticky tooltip
  useEffect(() => {
    if (!isSticky) return;

    const handleClickOutside = (e: MouseEvent) => {
      // Don't close if clicking inside badge or tooltip
      if (
        badgeRef.current?.contains(e.target as Node) ||
        tooltipRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      setIsSticky(false);
      setShowTooltip(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isSticky]);

  // Toggle sticky tooltip on click
  const handleBadgeClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isSticky) {
      // Already sticky - clicking again closes it
      setIsSticky(false);
      setShowTooltip(false);
    } else {
      // Make it sticky
      setIsSticky(true);
      setShowTooltip(true);
    }
  };

  // Handle mouse enter/leave - only affect showTooltip if not sticky
  const handleMouseEnter = () => {
    if (!isSticky) {
      setShowTooltip(true);
    }
  };

  const handleMouseLeave = () => {
    if (!isSticky) {
      setShowTooltip(false);
    }
  };

  // Close button handler
  const handleCloseTooltip = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsSticky(false);
    setShowTooltip(false);
  };

  if (!status) {
    return (
      <div className="model-status-badge">
        <span className="model-status-loading">loading...</span>
      </div>
    );
  }

  const level = getLevel(status.contextUsage.percent);
  const statusIndicator = getStatusIndicator(status.agentStatus);
  const hasSubagents = status.subagents && status.subagents.length > 0;
  
  // Auth profile display
  const profileName = status.authProfile ? getProfileDisplayName(status.authProfile.name) : null;
  const isPrimary = status.authProfile ? isPrimaryProfile(status.authProfile.name) : true;
  const showFallbackWarning = profileName && !isPrimary;

  // Get friendly name for target model during switch
  const getTargetModelName = () => {
    if (!targetModel) return '';
    // Try to find alias from model ID
    const parts = targetModel.split('/');
    return parts[parts.length - 1] || targetModel;
  };

  return (
    <div
      ref={badgeRef}
      className={`model-status-badge model-status-tooltip-wrapper ${compact ? 'model-status-compact' : ''} ${isSwitching ? 'model-switching' : ''} ${isSticky ? 'tooltip-sticky' : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleBadgeClick}
      title={compact ? (isSwitching ? `Switching to ${getTargetModelName()}...` : `${status.modelAlias} · ${status.contextUsage.percent}% · ${statusIndicator.label}`) : undefined}
    >
      {compact ? (
        // Compact mode: just context bar with color indicator (or pulsing when switching)
        <div className={`context-bar-container compact ${isSwitching ? 'switching-pulse' : ''}`}>
          <div
            className={`context-bar-fill ${isSwitching ? 'switching' : level}`}
            style={{ width: isSwitching ? '100%' : `${Math.min(status.contextUsage.percent, 100)}%` }}
          />
        </div>
      ) : (
        <>
          <div className="model-status-text">
            {isSwitching ? (
              // Switching state: show animated indicator
              <>
                <span className="model-status-indicator status-switching" title="Switching model...">
                  <span className="status-dot-pulse"></span>
                </span>
                <span className="model-name switching-text">
                  Switching to {getTargetModelName()}...
                </span>
              </>
            ) : (
              // Normal state: show current model
              <>
                {showFallbackWarning && (
                  <span className="fallback-warning-icon" title="Running on fallback auth profile">⚠️</span>
                )}
                <span className={`model-status-indicator ${statusIndicator.className}`} title={statusIndicator.label}>
                  <span className="status-dot-glow"></span>
                </span>
                <span className="model-name">
                  {status.modelAlias}
                  {status.isOverride && <span className="model-override-badge"> (override)</span>}
                </span>
                <span className="model-separator">·</span>
                <span className={`context-percent ${level}`}>
                  {status.contextUsage.percent}%
                </span>
              </>
            )}
          </div>
          <div className={`context-bar-container ${isSwitching ? 'switching-pulse' : ''}`}>
            <div
              className={`context-bar-fill ${isSwitching ? 'switching' : level}`}
              style={{ width: isSwitching ? '100%' : `${Math.min(status.contextUsage.percent, 100)}%` }}
            />
          </div>
        </>
      )}

      {showTooltip && (
        <div ref={tooltipRef} className="model-status-tooltip">
          <div className="tooltip-header">
            <span className="tooltip-model-name">
              {status.model}
              {status.isOverride && <span className="tooltip-override"> (override)</span>}
            </span>
            <div className="tooltip-header-right">
              <span className="tooltip-session-age">⏱ {status.session.ageFormatted}</span>
              {isSticky && (
                <button 
                  className="tooltip-close-button" 
                  onClick={handleCloseTooltip}
                  aria-label="Close tooltip"
                  title="Close"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Agent status */}
          <div className={`tooltip-row tooltip-agent-status ${statusIndicator.className}`}>
            <span className="tooltip-label">Status</span>
            <span className="tooltip-value tooltip-status-value">
              {statusIndicator.icon} {statusIndicator.label}
            </span>
          </div>

          {status.isOverride && (
            <>
              <div className="tooltip-row tooltip-default-model">
                <span className="tooltip-label">Default model</span>
                <span className="tooltip-value">{status.defaultModel}</span>
              </div>
              <button 
                className="tooltip-reset-button"
                onClick={handleResetToDefault}
                disabled={isSwitching}
                title="Switch back to default model"
              >
                {isSwitching ? '⏳ Switching...' : '↺ Reset to Default'}
              </button>
            </>
          )}
          {status.authProfile && (
            <div className="tooltip-row tooltip-auth-profile">
              <span className="tooltip-label">Auth</span>
              <span className="tooltip-value">
                {profileName || status.authProfile.name}
                {isPrimary ? (
                  <span className="tooltip-auth-status primary"> (primary)</span>
                ) : (
                  <span className="tooltip-auth-status fallback"> (⚠️ fallback)</span>
                )}
              </span>
            </div>
          )}

          <div className="tooltip-row">
            <span className="tooltip-label">Total tokens</span>
            <span className="tooltip-value">{formatTokens(status.tokens.total)}</span>
          </div>
          {(status.tokens.input > 10 || status.tokens.output > 10) ? (
            <>
              <div className="tooltip-row">
                <span className="tooltip-label">Input tokens</span>
                <span className="tooltip-value">{formatTokens(status.tokens.input)}</span>
              </div>
              <div className="tooltip-row">
                <span className="tooltip-label">Output tokens</span>
                <span className="tooltip-value">{formatTokens(status.tokens.output)}</span>
              </div>
            </>
          ) : (
            <div className="tooltip-row">
              <span className="tooltip-label">I/O tokens</span>
              <span className="tooltip-value tooltip-accumulating">accumulating...</span>
            </div>
          )}

          <div className="tooltip-context-section">
            <div className="tooltip-row">
              <span className="tooltip-label">Context window</span>
              <span className="tooltip-value">
                {formatTokens(status.contextUsage.used)} / {formatTokens(status.contextUsage.max)}
              </span>
            </div>
            <div className="tooltip-context-bar">
              <div
                className={`tooltip-context-fill ${level}`}
                style={{ width: `${Math.min(status.contextUsage.percent, 100)}%` }}
              />
            </div>
          </div>

          {/* Subagents section */}
          {hasSubagents && (
            <div className="tooltip-subagents-section">
              <div className="tooltip-subagents-header">
                <span className="tooltip-label">Active Agents</span>
                <span className="tooltip-value">{status.subagents.length}</span>
              </div>
              {status.subagents.map((sa) => {
                const saStatus = getStatusIndicator(sa.status);
                return (
                  <div key={sa.key} className="tooltip-subagent-row">
                    <span className={`tooltip-subagent-dot ${saStatus.className}`}></span>
                    <span className="tooltip-subagent-label">{sa.label}</span>
                    <span className="tooltip-subagent-model">{sa.modelAlias}</span>
                    <span className="tooltip-subagent-tokens">{formatTokens(sa.totalTokens)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Usage stats section (summary only — bars are in sidebar) */}
          <div className="tooltip-usage-section">
            <div className="tooltip-usage-header">
              <span className="tooltip-label">Usage</span>
              {status.usageStats?.stale && (
                <span className="tooltip-usage-stale">⚠️ stale</span>
              )}
            </div>
            {status.usageStats ? (
              <>
                <div className="tooltip-row">
                  <span className="tooltip-label">Quota</span>
                  <span className="tooltip-value">
                    Session: {status.usageStats.session.percentLeft}% · Weekly: {status.usageStats.weekly.percentLeft}%
                  </span>
                </div>
                {status.usageStats.stale && (
                  <div className="tooltip-row">
                    <span className="tooltip-label">Updated</span>
                    <span className="tooltip-value tooltip-accumulating">
                      {(() => {
                        const age = status.usageStats.dataAge;
                        if (age < 60) return `${age}s ago`;
                        if (age < 3600) return `${Math.floor(age / 60)}m ago`;
                        const hours = Math.floor(age / 3600);
                        const mins = Math.floor((age % 3600) / 60);
                        return mins > 0 ? `${hours}h ${mins}m ago` : `${hours}h ago`;
                      })()}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="tooltip-row">
                <span className="tooltip-label">Status</span>
                <span className="tooltip-value tooltip-accumulating">unavailable</span>
              </div>
            )}
          </div>

          {/* Freshness indicator */}
          <div className="tooltip-freshness">
            Updated {formatFreshness(status.updatedAt)}
          </div>
        </div>
      )}
    </div>
  );
}
