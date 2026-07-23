import { authenticatedFetch } from '../utils/auth';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useModelSwitch } from '../contexts/ModelSwitchContext';
import { useToast } from '../contexts/ToastContext';
import './ModelStatusCard.css';

interface ProfileInfo {
  provider: string;
  lastUsed: number | null;
  errorCount: number;
  status: 'active' | 'cooldown' | 'error' | 'idle';
  cooldownUntil: number | null;
  failureCounts?: Record<string, number>;
  lastFailureAt?: number | null;
}

interface ModelAvailable {
  id: string;
  provider: string;
  alias?: string;
}

interface RuntimeSystemStatus {
  id: 'openclaw' | 'hermes';
  label: string;
  available: boolean;
  configured: boolean;
  version: string | null;
  model: string | null;
  modelAlias?: string | null;
  authProfile?: string | null;
  authState?: string | null;
  provider?: string | null;
  gatewayStatus?: string | null;
  activeSessions?: number | null;
  scheduledJobs?: number | null;
  sessionAge?: string | null;
  status?: string | null;
  notes?: string | null;
  source?: string | null;
}

interface ModelsStatus {
  activeModel: string;
  activeProfile: string | null;
  profiles: Record<string, ProfileInfo>;
  models: {
    primary: string;
    fallbacks: string[];
    available: ModelAvailable[];
  };
  authOrder: Record<string, string[]>;
  systems?: {
    openclaw?: RuntimeSystemStatus;
    hermes?: RuntimeSystemStatus;
  };
}

interface LiteLLMHealthCheck {
  id: string;
  model: string;
  status: 'healthy' | 'unhealthy';
}

interface LiteLLMHealth {
  status: 'healthy' | 'degraded';
  healthyCount: number;
  unhealthyCount: number;
  checks: LiteLLMHealthCheck[];
  checkedAt: string;
}

interface SpendDimension {
  id: string;
  spend: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

interface LiteLLMSpend {
  startDate: string;
  endDate: string;
  totalSpend: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  byKey: SpendDimension[];
  byUser: SpendDimension[];
  byModel: SpendDimension[];
  truncated: boolean;
}

function shortModelName(modelId: string, alias?: string): string {
  if (alias) return alias;
  const parts = modelId.split('/');
  return parts[parts.length - 1] || modelId;
}

function profileDisplayName(profileKey: string): string {
  // "anthropic:user-claude-max" -> "user-claude-max"
  const parts = profileKey.split(':');
  return parts.slice(1).join(':') || profileKey;
}

function providerFromModel(modelId: string): string {
  return modelId.split('/')[0] || 'unknown';
}

function getProfileForModel(modelId: string, status: ModelsStatus): string | null {
  const provider = providerFromModel(modelId);

  // For anthropic models, use auth order / lastGood
  if (provider === 'anthropic') {
    // Find active profile for this provider
    const order = status.authOrder[provider] || [];
    for (const profileKey of order) {
      const profile = status.profiles[profileKey];
      if (profile && profile.status !== 'cooldown') return profileKey;
    }
    // Fallback to any non-cooldown profile
    for (const [key, profile] of Object.entries(status.profiles)) {
      if (profile.provider === provider && profile.status !== 'cooldown') return key;
    }
    // If all in cooldown, return first
    return order[0] || null;
  }

  // For litellm models, just show provider
  return null;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'expired';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

function formatTimeAgo(ts: number | null): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatSpend(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function compactIdentifier(value: string): string {
  return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

export function ModelStatusCard() {
  const [status, setStatus] = useState<ModelsStatus | null>(null);
  const [liteLLMHealth, setLiteLLMHealth] = useState<LiteLLMHealth | null>(null);
  const [liteLLMSpend, setLiteLLMSpend] = useState<LiteLLMSpend | null>(null);
  const [liteLLMError, setLiteLLMError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [showOther, setShowOther] = useState(false);
  const [now, setNow] = useState(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  const { startSwitch, completeSwitch } = useModelSwitch();
  const { showSuccess, showError } = useToast();

  const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

  const fetchStatus = useCallback(async () => {
    try {
      const [statusResult, healthResult, spendResult] = await Promise.allSettled([
        authenticatedFetch(`${API_BASE}/models/status`),
        authenticatedFetch(`${API_BASE}/litellm/health`),
        authenticatedFetch(`${API_BASE}/litellm/spend`),
      ]);

      if (statusResult.status === 'fulfilled' && statusResult.value.ok) {
        const data = await statusResult.value.json();
        if (data.success) setStatus(data);
      }

      let insightError: string | null = null;
      if (healthResult.status === 'fulfilled' && healthResult.value.ok) {
        const data = await healthResult.value.json();
        if (data.success) setLiteLLMHealth(data);
        else insightError = data.error || 'LiteLLM health unavailable';
      } else {
        insightError = healthResult.status === 'rejected'
          ? 'LiteLLM health unavailable'
          : `LiteLLM health unavailable (HTTP ${healthResult.value.status})`;
      }

      if (spendResult.status === 'fulfilled' && spendResult.value.ok) {
        const data = await spendResult.value.json();
        if (data.success) setLiteLLMSpend(data);
        else insightError = insightError || data.error || 'LiteLLM spend unavailable';
      } else {
        insightError = insightError || (spendResult.status === 'rejected'
          ? 'LiteLLM spend unavailable'
          : `LiteLLM spend unavailable (HTTP ${spendResult.value.status})`);
      }
      setLiteLLMError(insightError);
    } catch {
      // Preserve the last good status during transient polling failures.
    } finally {
      setLoading(false);
    }
  }, [API_BASE]);

  const switchModel = useCallback(async (modelId: string) => {
    setSwitching(modelId);
    startSwitch(modelId); // Notify sidebar/badge
    
    try {
      const res = await authenticatedFetch(`${API_BASE}/models/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      });
      if (res.ok) {
        // Refresh status after switch
        await fetchStatus();
        completeSwitch(true);
        
        // Get friendly model name for toast
        const model = status?.models.available.find(m => m.id === modelId);
        const displayName = model?.alias || modelId.split('/').pop() || modelId;
        showSuccess(`✨ Switched to ${displayName}`);
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        console.error('Model switch failed:', err);
        const errorMsg = err.error || err.message || 'Unknown error';
        completeSwitch(false, errorMsg);
        showError(`Failed to switch model: ${errorMsg}`);
      }
    } catch (err) {
      console.error('Model switch error:', err);
      const errorMsg = err instanceof Error ? err.message : 'Network error';
      completeSwitch(false, errorMsg);
      showError(`Failed to switch model: ${errorMsg}`);
    } finally {
      setSwitching(null);
    }
  }, [API_BASE, fetchStatus, startSwitch, completeSwitch, showSuccess, showError, status?.models.available]);

  // Fetch on mount and poll every 30s
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Tick timer every second for cooldown countdowns
  useEffect(() => {
    const hasCooldown = status && Object.values(status.profiles).some(
      p => p.cooldownUntil && p.cooldownUntil > Date.now()
    );
    if (hasCooldown) {
      timerRef.current = setInterval(() => setNow(Date.now()), 1000);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }
    return undefined;
  }, [status]);

  if (loading) {
    return (
      <div className="model-status-card">
        <div className="msc-header"><h3>🧠 Model Status</h3></div>
        <div className="msc-loading">Loading...</div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="model-status-card">
        <div className="msc-header"><h3>🧠 Model Status</h3></div>
        <div className="msc-loading">Status unavailable</div>
      </div>
    );
  }

  const { models, profiles, activeProfile } = status;
  const primaryId = models.primary;
  const fallbackIds = models.fallbacks;
  const primaryAndFallbackIds = new Set([primaryId, ...fallbackIds]);
  const otherModels = models.available.filter(m => !primaryAndFallbackIds.has(m.id));

  const renderProfileBadge = (modelId: string) => {
    const profileKey = getProfileForModel(modelId, status);
    if (!profileKey) {
      // LiteLLM or unknown provider
      const provider = providerFromModel(modelId);
      return <span className="msc-profile-badge msc-profile-litellm">{provider}</span>;
    }
    const profile = profiles[profileKey];
    const displayName = profileDisplayName(profileKey);
    const isActive = profileKey === activeProfile;
    const isCooldown = profile?.status === 'cooldown';
    const badgeClass = isCooldown ? 'msc-profile-cooldown' : isActive ? 'msc-profile-active' : 'msc-profile-idle';
    return (
      <span className={`msc-profile-badge ${badgeClass}`} title={`Errors: ${profile?.errorCount || 0} · Last used: ${formatTimeAgo(profile?.lastUsed || null)}`}>
        {displayName}
      </span>
    );
  };

  const renderCooldownTimer = (modelId: string) => {
    const profileKey = getProfileForModel(modelId, status);
    if (!profileKey) return null;
    const profile = profiles[profileKey];
    if (!profile?.cooldownUntil) return null;
    const remaining = profile.cooldownUntil - now;
    if (remaining <= 0) return null;
    return <span className="msc-cooldown-timer">⏱ {formatCountdown(remaining)}</span>;
  };

  const getModelDotClass = (modelId: string): string => {
    const profileKey = getProfileForModel(modelId, status);
    if (!profileKey) return 'msc-dot-available'; // litellm = always available
    const profile = profiles[profileKey];
    if (!profile) return 'msc-dot-inactive';
    if (profile.status === 'cooldown' && profile.cooldownUntil && profile.cooldownUntil > now) return 'msc-dot-cooldown';
    if (profile.status === 'error') return 'msc-dot-error';
    if (profile.status === 'active') return 'msc-dot-available';
    return 'msc-dot-inactive';
  };

  const renderModelRow = (modelId: string, alias?: string, isPrimary = false) => {
    const isSwitching = switching === modelId;
    const dotClass = getModelDotClass(modelId);
    return (
      <div key={modelId} className={`msc-model-row ${isPrimary ? 'msc-model-primary' : ''}`}>
        <span className={`msc-dot ${dotClass}`} />
        <span className="msc-model-name" title={modelId}>
          {shortModelName(modelId, alias)}
        </span>
        {renderProfileBadge(modelId)}
        {renderCooldownTimer(modelId)}
        {!isPrimary && (
          <button
            className="msc-use-btn"
            disabled={isSwitching || modelId === primaryId}
            onClick={() => switchModel(modelId)}
          >
            {isSwitching ? '...' : 'Use'}
          </button>
        )}
      </div>
    );
  };

  // Find alias for primary model
  const primaryAlias = models.available.find(m => m.id === primaryId)?.alias;
  const runtimeSystems = Object.values(status.systems || {}).filter(Boolean) as RuntimeSystemStatus[];

  const renderSpendDimensions = (label: string, dimensions: SpendDimension[]) => (
    <div className="msc-spend-group">
      <span className="msc-spend-group-label">{label}</span>
      {dimensions.slice(0, 3).map((dimension) => (
        <div className="msc-spend-row" key={`${label}-${dimension.id}`}>
          <span className="msc-spend-id" title={dimension.id}>{compactIdentifier(dimension.id)}</span>
          <span className="msc-spend-requests">{dimension.requests} req</span>
          <span className="msc-spend-value">{formatSpend(dimension.spend)}</span>
        </div>
      ))}
      {dimensions.length === 0 && <div className="msc-insight-empty">No usage</div>}
    </div>
  );

  return (
    <div className="model-status-card">
      <div className="msc-header">
        <h3>🧠 Model Status</h3>
      </div>

      {runtimeSystems.length > 0 && (
        <div className="msc-profiles-section">
          <div className="msc-section-label">Execution Systems</div>
          {runtimeSystems.map((system) => (
            <div key={system.id} className="msc-profile-row">
              <span className={`msc-dot ${system.available ? 'msc-dot-available' : 'msc-dot-error'}`} />
              <span className="msc-profile-name">{system.label}</span>
              <span className="msc-error-count">{system.modelAlias || system.model || system.version || 'unavailable'}</span>
              <span className="msc-last-used">{system.authProfile || system.provider || system.status || '—'}</span>
            </div>
          ))}
        </div>
      )}

      {(liteLLMHealth || liteLLMSpend || liteLLMError) && (
        <div className="msc-insights-section" data-testid="litellm-insights">
          <div className="msc-section-label">LiteLLM Health &amp; Spend</div>
          {liteLLMHealth && (
            <div className="msc-health-summary" title={`Checked ${liteLLMHealth.checkedAt}`}>
              <span className={`msc-dot ${liteLLMHealth.status === 'healthy' ? 'msc-dot-available' : 'msc-dot-error'}`} />
              <span>{liteLLMHealth.status === 'healthy' ? 'Healthy' : 'Degraded'}</span>
              <span className="msc-health-counts">
                {liteLLMHealth.healthyCount} healthy · {liteLLMHealth.unhealthyCount} unhealthy
              </span>
            </div>
          )}
          {liteLLMHealth && liteLLMHealth.checks.length > 0 && (
            <div className="msc-health-models">
              {liteLLMHealth.checks.map((check) => (
                <span className={`msc-health-chip ${check.status}`} key={check.id} title={check.model}>
                  {compactIdentifier(check.id)}
                </span>
              ))}
            </div>
          )}
          {liteLLMSpend && (
            <div className="msc-spend-summary">
              <div className="msc-spend-total">
                <strong>{formatSpend(liteLLMSpend.totalSpend)}</strong>
                <span>{liteLLMSpend.requests} requests · {liteLLMSpend.startDate}–{liteLLMSpend.endDate}</span>
              </div>
              {liteLLMSpend.truncated && <div className="msc-insight-warning">Partial result: query limit reached</div>}
              {renderSpendDimensions('Models', liteLLMSpend.byModel)}
              {renderSpendDimensions('Keys', liteLLMSpend.byKey)}
              {renderSpendDimensions('Users', liteLLMSpend.byUser)}
            </div>
          )}
          {liteLLMError && <div className="msc-insight-warning">{liteLLMError}</div>}
        </div>
      )}

      {/* Active Model */}
      <div className="msc-active-section">
        <div className="msc-section-label">Active Model</div>
        <div className="msc-active-row">
          <span className={`msc-dot ${getModelDotClass(primaryId)}`} />
          <span className="msc-active-name">{shortModelName(primaryId, primaryAlias)}</span>
          <span className="msc-active-full">({primaryId})</span>
        </div>
        <div className="msc-active-profile">
          via {renderProfileBadge(primaryId)}
          {renderCooldownTimer(primaryId)}
        </div>
      </div>

      {/* Auth Profiles Summary */}
      {Object.keys(profiles).length > 0 && (
        <div className="msc-profiles-section">
          <div className="msc-section-label">Auth Profiles</div>
          {Object.entries(profiles).map(([key, profile]) => {
            const isCooldown = profile.cooldownUntil && profile.cooldownUntil > now;
            const remaining = isCooldown ? profile.cooldownUntil! - now : 0;
            return (
              <div key={key} className="msc-profile-row">
                <span className={`msc-dot ${isCooldown ? 'msc-dot-cooldown' : profile.status === 'active' ? 'msc-dot-available' : profile.status === 'error' ? 'msc-dot-error' : 'msc-dot-inactive'}`} />
                <span className="msc-profile-name">{profileDisplayName(key)}</span>
                {profile.errorCount > 0 && (
                  <span className="msc-error-count" title={profile.failureCounts ? Object.entries(profile.failureCounts).map(([k, v]) => `${k}: ${v}`).join(', ') : ''}>
                    {profile.errorCount} err
                  </span>
                )}
                {isCooldown && (
                  <span className="msc-cooldown-timer">⏱ {formatCountdown(remaining)}</span>
                )}
                <span className="msc-last-used">{formatTimeAgo(profile.lastUsed)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Fallbacks */}
      {fallbackIds.length > 0 && (
        <div className="msc-fallbacks-section">
          <div className="msc-section-label">Fallbacks</div>
          {fallbackIds.map(fId => {
            const model = models.available.find(m => m.id === fId);
            return renderModelRow(fId, model?.alias);
          })}
        </div>
      )}

      {/* Other Models */}
      {otherModels.length > 0 && (
        <div className="msc-other-section">
          <div className="msc-section-label msc-clickable" onClick={() => setShowOther(!showOther)}>
            Other Models ({otherModels.length})
            <span className="msc-toggle">{showOther ? '▼' : '▶'}</span>
          </div>
          {showOther && otherModels.map(m => renderModelRow(m.id, m.alias))}
        </div>
      )}
    </div>
  );
}
