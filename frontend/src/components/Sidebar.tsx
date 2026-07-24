import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X, LogOut, ChevronDown, Puzzle, ExternalLink } from 'lucide-react';
import { getSidebarGroups, NavGroupMeta, NavItem } from '../config/navigation';
import './Sidebar.css';
import { StopButton } from './StopButton';
import { WorkspaceFiles } from './WorkspaceFiles';
import { AgentDetailCard } from './AgentDetailCard';
import { usePlugins } from '../contexts/PluginContext';
import { useClawBoardConfig } from '../contexts/ClawBoardConfigContext';
import { auth, authenticatedFetch } from '../utils/auth';
import { StatusOrb } from './StatusOrb';
import { DynamicIcon } from '../utils/icons';
import { PluginNavItem } from '../types/plugin';

interface UsageWindowStats {
  label?: string;
  percentLeft: number;
  timeLeft: string;
  resetAt?: string | number;
}

interface UsageStats {
  session?: UsageWindowStats;
  weekly?: UsageWindowStats;
  updatedAt?: string;
  checkedAt?: string;
  dataAge?: number;
  stale: boolean;
  source?: string;
  provider?: string;
  plan?: string | null;
  failureClass?: string | null;
  statusReason?: string;
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
  mainState?: string | null;
  activityLabel?: string | null;
  notes?: string | null;
  source?: string | null;
}

interface ModelStatusPayload {
  model?: string;
  modelAlias?: string;
  contextUsage?: {
    used: number;
    max: number;
    percent: number;
  };
  tokens?: {
    input: number;
    output: number;
    total: number;
  };
  session?: {
    key: string;
    ageMs: number;
    ageFormatted: string;
  };
  authProfile?: {
    name: string;
    provider: string;
    isAutoSelected: boolean;
  } | null;
  usageStats?: UsageStats | null;
  openclawVersion?: string | null;
  compactionCount?: number | null;
  systems?: {
    openclaw?: RuntimeSystemStatus;
    hermes?: RuntimeSystemStatus;
  };
  updatedAt?: string;
}

interface VersionInfo {
  appVersion: string | null;
  branch: string | null;
  commit: string | null;
  shortCommit: string | null;
  remoteUrl: string | null;
  repoWebUrl: string | null;
  branchUrl: string | null;
  commitUrl: string | null;
}

interface SidebarProps {
  status: {
    main: {
      state: 'idle' | 'thinking' | 'typing' | 'tool-use' | 'waiting' | 'error';
      detail: string;
      tools: string[];
    };
    agents: Array<{
      key: string;
      label: string;
      state: 'running' | 'idle' | 'completed';
      updatedAt: number;
    }>;
    agentCount: number;
    stats: {
      messageCount: number;
      toolsUsed: number;
    };
  } | null;
  connected: boolean;
}

function formatNumberCompact(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatAuthLabel(profile?: { name: string; provider: string; isAutoSelected: boolean } | null, fallback?: string | null) {
  if (profile?.name) {
    return profile.isAutoSelected ? `${profile.name} · auto` : profile.name;
  }
  return fallback || 'unknown';
}

function getUsageTone(percentLeft?: number) {
  if ((percentLeft ?? 0) > 50) return 'green';
  if ((percentLeft ?? 0) > 20) return 'yellow';
  return 'red';
}

function getRuntimeSummary(system: RuntimeSystemStatus, statusDetail?: string | null) {
  if (system.id === 'openclaw') {
    return system.mainState === 'busy'
      ? (statusDetail || system.activityLabel || 'OpenClaw is actively working')
      : 'No active OpenClaw turn';
  }

  return system.mainState === 'busy'
    ? (system.activityLabel || 'Hermes has active work')
    : (system.notes || 'No active Hermes session');
}


export function Sidebar({ status, connected }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<ModelStatusPayload | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [expandedRuntimeSystems, setExpandedRuntimeSystems] = useState<Record<string, boolean>>({});
  const { plugins, pluginSidebarItems, loading: pluginsLoading } = usePlugins();
  const { config } = useClawBoardConfig();

  const pluginItemsWithVoice = [
    ...pluginSidebarItems,
    ...((config.features as any).voice ? [{
      label: 'Voice',
      icon: 'mic',
      path: '/voice',
      pluginName: 'builtin-voice',
      healthy: true,
    }] : []),
  ];

  const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
  const usageStats = runtimeStatus?.usageStats || null;
  const runtimeSystemList = Object.values(runtimeStatus?.systems || {}).filter(Boolean) as RuntimeSystemStatus[];
  const isDevEnvironment = typeof window !== 'undefined' && window.location.pathname.startsWith('/dashboard-dev');
  const activeTools = status?.main.tools || [];

  const fetchRuntimeStatus = useCallback(async () => {
    try {
      const res = await authenticatedFetch(`${API_BASE}/models/status`);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.success !== false) {
        setRuntimeStatus(data);
      }
    } catch {
      // Keep existing UI state on transient failures.
    }
  }, [API_BASE]);

  const fetchVersionInfo = useCallback(async () => {
    try {
      const res = await authenticatedFetch(`${API_BASE}/workspace/version`);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.success) {
        setVersionInfo(data.version);
      }
    } catch {
      // Footer can stay minimal if version metadata is unavailable.
    }
  }, [API_BASE]);

  useEffect(() => {
    const handler = (event: CustomEvent<ModelStatusPayload>) => {
      if (event.detail) {
        setRuntimeStatus((previous) => ({
          ...(previous || {}),
          ...event.detail,
        }));
      }
    };

    window.addEventListener('model:status' as any, handler);

    const schedule = (fn: () => void, delay: number) => {
      const runner = () => window.setTimeout(fn, delay);
      if ('requestIdleCallback' in window) {
        return (window as any).requestIdleCallback(runner, { timeout: delay + 1000 });
      }
      return runner();
    };

    const runtimeKick = schedule(fetchRuntimeStatus, 1200);
    const versionKick = schedule(fetchVersionInfo, 2000);
    const runtimeInterval = setInterval(fetchRuntimeStatus, 30000);
    const versionInterval = setInterval(fetchVersionInfo, 120000);

    return () => {
      window.removeEventListener('model:status' as any, handler);
      if ('cancelIdleCallback' in window) {
        try { (window as any).cancelIdleCallback(runtimeKick); } catch {}
        try { (window as any).cancelIdleCallback(versionKick); } catch {}
      } else {
        clearTimeout(runtimeKick as any);
        clearTimeout(versionKick as any);
      }
      clearInterval(runtimeInterval);
      clearInterval(versionInterval);
    };
  }, [fetchRuntimeStatus, fetchVersionInfo]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'X') {
        e.preventDefault();
        authenticatedFetch(`${API_BASE}/control/stop-main`, { method: 'POST' });
        return;
      }
      if (e.key === 'Escape' && status?.main.state && status.main.state !== 'idle' && status.main.state !== 'error') {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
          return;
        }
        if (document.querySelector('.stop-confirm-overlay')) {
          return;
        }
        e.preventDefault();
        authenticatedFetch(`${API_BASE}/control/stop-main`, { method: 'POST' });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [API_BASE, status?.main.state]);

  return (
    <>
      <button
        className="sidebar-hamburger"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
      >
        {mobileOpen ? <X size={22} /> : <Menu size={22} />}
      </button>

      <div
        className={`sidebar-backdrop ${mobileOpen ? 'sidebar-backdrop-visible' : ''}`}
        onClick={() => setMobileOpen(false)}
      />

      <div className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-avatar-section">
          <div className="avatar-container">
            <OrbAvatar state={status?.main.state || 'idle'} plugins={plugins} />
          </div>
        </div>

        <div className="sidebar-section sidebar-usage-section-card">
          <div className="sidebar-section-heading-row">
            <div>
              <div className="sidebar-section-eyebrow">Usage limits</div>
              <h3 className="sidebar-section-title">OpenAI Codex quota</h3>
            </div>
            <div className="sidebar-section-heading-actions">
              {usageStats?.stale && <span className="sidebar-mini-pill warning">stale</span>}
            </div>
          </div>

          <div className="sidebar-usage-bars sidebar-usage-bars--stacked sidebar-usage-bars--compact">
            {usageStats?.session && (
              <UsageBarRow
                label={usageStats.session.label || '5h'}
                usage={usageStats.session}
                stale={usageStats.stale}
              />
            )}
            <UsageBarRow
              label={usageStats?.weekly?.label || 'Weekly'}
              usage={usageStats?.weekly}
              stale={usageStats?.stale ?? true}
            />
          </div>
          {usageStats?.stale && usageStats.statusReason && (
            <div className="sidebar-usage-status-reason" role="status" title={usageStats.statusReason}>
              {usageStats.statusReason}
            </div>
          )}
        </div>

        <div className="sidebar-runtime-systems sidebar-section">
          <div className="sidebar-section-heading-row">
            <div>
              <div className="sidebar-section-eyebrow">Execution systems</div>
              <h3 className="sidebar-section-title">Current harness state</h3>
            </div>
            <div className="sidebar-section-heading-actions">
              <span className={`sidebar-mini-pill ${connected ? 'success' : 'danger'}`}>
                {connected ? 'live' : 'offline'}
              </span>
            </div>
          </div>

          {runtimeSystemList.length > 0 ? (
            <div className="sidebar-runtime-list">
              {runtimeSystemList.map((system) => {
                const systemWorking = system.mainState === 'busy' || system.status === 'working';
                const systemStateLabel = !system.available
                  ? 'Down'
                  : systemWorking
                    ? 'Working'
                    : system.status === 'degraded'
                      ? 'Degraded'
                      : 'Idle';
                const systemStateTone = !system.available
                  ? 'danger'
                  : systemWorking
                    ? 'active'
                    : system.status === 'degraded'
                      ? 'warning'
                      : 'success';
                const modelLabel = system.id === 'openclaw'
                  ? (runtimeStatus?.modelAlias || system.modelAlias || system.model || 'Unknown model')
                  : (system.modelAlias || system.model || system.version || 'Unavailable');
                const summaryText = getRuntimeSummary(system, status?.main.detail);
                const isExpanded = expandedRuntimeSystems[system.id] === true;

                return (
                  <div key={system.id} className={`sidebar-runtime-card ${system.available ? 'available' : 'unavailable'} ${isExpanded ? 'expanded' : 'collapsed'}`}>
                    <button
                      type="button"
                      className="sidebar-runtime-toggle"
                      aria-expanded={isExpanded}
                      onClick={() => setExpandedRuntimeSystems((prev) => ({ ...prev, [system.id]: !prev[system.id] }))}
                    >
                      <div className="sidebar-runtime-topline">
                        <div className="sidebar-runtime-identity">
                          <div className="sidebar-runtime-labels">
                            <div className="sidebar-runtime-name">{system.label}</div>
                            <div className="sidebar-runtime-subtitle">{modelLabel}</div>
                          </div>
                        </div>
                        <div className="sidebar-runtime-topline-actions">
                          <span className={`sidebar-runtime-pill ${systemStateTone}`}>{systemStateLabel}</span>
                          <ChevronDown size={16} className={`sidebar-runtime-chevron ${isExpanded ? 'open' : ''}`} />
                        </div>
                      </div>
                    </button>

                    {isExpanded && (system.id === 'openclaw' ? (
                      <>
                        <div className="sidebar-runtime-grid">
                          <RuntimeMetric label="Context" value={runtimeStatus?.contextUsage ? `${runtimeStatus.contextUsage.percent}% · ${formatNumberCompact(runtimeStatus.contextUsage.used)}/${formatNumberCompact(runtimeStatus.contextUsage.max)}` : 'Unavailable'} />
                          <RuntimeMetric label="Compactions" value={runtimeStatus?.compactionCount != null ? String(runtimeStatus.compactionCount) : '0'} />
                          <RuntimeMetric label="Auth" value={formatAuthLabel(runtimeStatus?.authProfile, system.authProfile)} />
                          <RuntimeMetric label="Session age" value={runtimeStatus?.session?.ageFormatted || system.sessionAge || 'unknown'} />
                        </div>
                        <div className="sidebar-runtime-activity-block">
                          <div className="sidebar-runtime-activity-label">Main session</div>
                          <div className="sidebar-runtime-activity" title={status?.main.detail || undefined}>
                            {summaryText}
                          </div>
                          {activeTools.length > 0 && (
                            <div className="sidebar-runtime-tools">
                              {activeTools.slice(0, 4).map((tool) => (
                                <span key={tool} className="sidebar-runtime-tool-chip">{tool}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="sidebar-runtime-grid">
                          <RuntimeMetric label="Provider" value={system.provider || 'unknown'} />
                          <RuntimeMetric label="Active sessions" value={system.activeSessions != null ? String(system.activeSessions) : '0'} />
                          <RuntimeMetric label="Scheduled jobs" value={system.scheduledJobs != null ? String(system.scheduledJobs) : '0'} />
                          <RuntimeMetric label="Auth" value={system.authState || 'unknown'} />
                        </div>
                        <div className="sidebar-runtime-activity-block">
                          <div className="sidebar-runtime-activity-label">Hermes runtime</div>
                          <div className="sidebar-runtime-activity" title={system.notes || undefined}>
                            {summaryText}
                          </div>
                        </div>
                      </>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="sidebar-runtime-empty">Runtime status is still loading.</div>
          )}
        </div>

        <div className="sidebar-divider" />

        <div className="sidebar-nav-section">
          <nav aria-label="Main navigation">
            {getSidebarGroups().map(({ group, items }) => (
              <NavGroupSection key={group.id} group={group} items={items} />
            ))}

            {!pluginsLoading && pluginItemsWithVoice.length > 0 && (
              <CollapsibleGroup
                id="plugins"
                label="Plugins"
                icon={<Puzzle size={14} />}
                defaultCollapsed={false}
              >
                {pluginItemsWithVoice.map((item) => (
                  <PluginNavLink
                    key={`${item.pluginName}-${item.path}`}
                    item={item}
                  />
                ))}
              </CollapsibleGroup>
            )}
          </nav>
        </div>


        <div className={`sidebar-agents ${status && status.agentCount > 0 ? 'agents-visible' : 'agents-hidden'}`}>
          <div className="sidebar-subsection-label">Agent sessions</div>
          <div className="agents-list">
            {status?.agents.map((agent) => (
              <div key={agent.key} className="agent-item-wrapper">
                <div
                  className="agent-item"
                  onClick={() => setExpandedAgent(expandedAgent === agent.key ? null : agent.key)}
                  style={{ cursor: 'pointer' }}
                >
                  <span className={`agent-status ${agent.state}`}></span>
                  <span className="agent-label">{agent.label}</span>
                  {agent.state === 'running' && (
                    <StopButton variant="agent" agentKey={agent.key} />
                  )}
                </div>
                {expandedAgent === agent.key && (
                  <AgentDetailCard
                    agentKey={agent.key}
                    onClose={() => setExpandedAgent(null)}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        <WorkspaceFiles />

        <div className="sidebar-section sidebar-environment-section">
          <div className="sidebar-section-heading-row sidebar-section-heading-row--tight">
            <div>
              <div className="sidebar-section-eyebrow">Environment</div>
              <h3 className="sidebar-section-title">Pick the dashboard target</h3>
            </div>
          </div>
          <div className="sidebar-env-switcher" role="tablist" aria-label="Dashboard environment selector">
            <button
              type="button"
              className={`sidebar-env-option ${!isDevEnvironment ? 'active' : ''}`}
              onClick={() => { window.location.href = '/dashboard/'; }}
              aria-pressed={!isDevEnvironment}
            >
              PROD
            </button>
            <button
              type="button"
              className={`sidebar-env-option ${isDevEnvironment ? 'active' : ''}`}
              onClick={() => { window.location.href = '/dashboard-dev/'; }}
              aria-pressed={isDevEnvironment}
            >
              DEV
            </button>
          </div>
        </div>

        <div className="sidebar-section logout-section">
          <button
            className="sidebar-logout-button"
            onClick={() => auth.logout()}
            title="Logout"
          >
            <LogOut size={18} />
            <span className="logout-text">Logout</span>
          </button>
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-version-links">
            {versionInfo?.branchUrl ? (
              <a className="sidebar-version-link" href={versionInfo.branchUrl} target="_blank" rel="noreferrer">
                {versionInfo.branch || 'branch'}
                <ExternalLink size={12} />
              </a>
            ) : (
              <span className="sidebar-version-text">{versionInfo?.branch || 'branch unavailable'}</span>
            )}
            {versionInfo?.commitUrl ? (
              <a className="sidebar-version-link" href={versionInfo.commitUrl} target="_blank" rel="noreferrer">
                {versionInfo.shortCommit || versionInfo.commit || 'commit'}
                <ExternalLink size={12} />
              </a>
            ) : (
              <span className="sidebar-version-text">{versionInfo?.shortCommit || 'commit unavailable'}</span>
            )}
          </div>
          <p className="sidebar-version">
            {versionInfo?.appVersion ? `v${versionInfo.appVersion}` : 'version unavailable'}
            {runtimeStatus?.openclawVersion ? ` · OC ${runtimeStatus.openclawVersion}` : ''}
            {runtimeStatus?.systems?.hermes?.version ? ` · HX ${runtimeStatus.systems.hermes.version}` : ''}
          </p>
        </div>
      </div>
    </>
  );
}

const STORAGE_KEY_PREFIX = 'sidebar-group-';

interface CollapsibleGroupProps {
  id: string;
  label: string;
  icon: React.ReactNode;
  defaultCollapsed: boolean;
  children: React.ReactNode;
}

function CollapsibleGroup({ id, label, icon, defaultCollapsed, children }: CollapsibleGroupProps) {
  const storageKey = STORAGE_KEY_PREFIX + id;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored !== null ? stored === '1' : defaultCollapsed;
    } catch {
      return defaultCollapsed;
    }
  });
  const contentRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(storageKey, next ? '1' : '0'); } catch {}
      return next;
    });
  }, [storageKey]);

  return (
    <div className="nav-group">
      <button
        className={`nav-group-header ${collapsed ? 'collapsed' : ''}`}
        onClick={toggle}
        aria-expanded={!collapsed}
        title={label}
      >
        <span className="nav-group-icon">{icon}</span>
        <span className="nav-group-label">{label}</span>
        <ChevronDown size={14} className={`nav-group-chevron ${collapsed ? 'chevron-collapsed' : ''}`} />
      </button>
      <div
        ref={contentRef}
        className={`nav-group-content ${collapsed ? 'nav-group-content--collapsed' : 'nav-group-content--expanded'}`}
      >
        {children}
      </div>
    </div>
  );
}

function NavGroupSection({ group, items }: { group: NavGroupMeta; items: NavItem[] }) {
  if (!group.collapsible) {
    return (
      <div className="nav-group nav-group--flat">
        {items.map(item => (
          <SidebarNavLink key={item.id} to={item.path} icon={<item.icon size={18} />} label={item.label} />
        ))}
      </div>
    );
  }

  return (
    <CollapsibleGroup
      id={group.id}
      label={group.label}
      icon={<group.icon size={14} />}
      defaultCollapsed={group.defaultCollapsed}
    >
      {items.map(item => (
        <SidebarNavLink key={item.id} to={item.path} icon={<item.icon size={18} />} label={item.label} />
      ))}
    </CollapsibleGroup>
  );
}

interface SidebarNavLinkProps {
  to: string;
  icon: React.ReactNode;
  label: string;
}

function SidebarNavLink({ to, icon, label }: SidebarNavLinkProps) {
  const location = useLocation();
  const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
  return (
    <Link
      to={to}
      className={`sidebar-nav-link ${isActive ? 'active' : ''}`}
      title={label}
      aria-label={label}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
    </Link>
  );
}

function PluginNavLink({ item }: { item: PluginNavItem }) {
  const location = useLocation();
  const isActive = location.pathname.startsWith(item.path);

  return (
    <Link
      to={item.path}
      className={`sidebar-nav-link plugin-nav-link ${isActive ? 'active' : ''} ${!item.healthy ? 'unhealthy' : ''}`}
      title={!item.healthy ? `${item.label} (plugin unhealthy)` : item.label}
      aria-label={item.label}
    >
      <span className="nav-icon">
        <DynamicIcon name={item.icon} size={18} />
      </span>
      <span className="nav-label">{item.label}</span>
      {!item.healthy && <span className="plugin-health-dot" title="Plugin unhealthy" />}
    </Link>
  );
}

function OrbAvatar({ state, plugins: pluginsList }: { state: string; plugins: { name: string; healthy: boolean }[] }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const orbPlugin = pluginsList.find(p => p.name === 'nim-orb' && p.healthy);
  const initialStateRef = useRef(state);
  const [fallbackSize, setFallbackSize] = useState(() => {
    if (typeof window === 'undefined') return 120;
    return window.innerWidth >= 961 && window.innerWidth <= 1279 ? 64 : 120;
  });
  const [orbReady, setOrbReady] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const updateFallbackSize = () => {
      setFallbackSize(window.innerWidth >= 961 && window.innerWidth <= 1279 ? 64 : 120);
    };

    updateFallbackSize();
    window.addEventListener('resize', updateFallbackSize);
    return () => window.removeEventListener('resize', updateFallbackSize);
  }, []);


  useEffect(() => {
    if (!orbPlugin) {
      setOrbReady(false);
      return;
    }
    const timer = setTimeout(() => setOrbReady(true), 2000);
    return () => clearTimeout(timer);
  }, [orbPlugin]);

  useEffect(() => {
    if (!orbPlugin || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage({ type: 'orb-state', state }, '*');
  }, [state, orbPlugin]);

  if (orbPlugin && orbReady) {
    return (
      <iframe
        ref={iframeRef}
        className="sidebar-orb-frame"
        src={`${import.meta.env.VITE_API_BASE_URL || '/api'}/plugins/nim-orb/avatar?state=${initialStateRef.current}`}
        title="NimOrb Avatar"
        allow="accelerometer; autoplay"
      />
    );
  }

  return <StatusOrb state={state} size={fallbackSize} />;
}

function UsageBarRow({ label, usage, stale }: { label: string; usage?: UsageWindowStats; stale: boolean }) {
  const percentLeft = usage?.percentLeft ?? 0;
  const colorClass = getUsageTone(percentLeft);
  const prefix = stale && usage ? 'stale · ' : '';

  return (
    <div className="usage-bar-row">
      <div className="usage-bar-header">
        <span className="usage-bar-label">{label}</span>
        <span className="usage-bar-info">
          {usage ? `${percentLeft}% left` : 'unavailable'}
        </span>
      </div>
      <div className="usage-bar-track">
        <div
          className={`usage-bar-fill ${colorClass} ${stale ? 'stale' : ''}`}
          style={{ width: `${Math.min(Math.max(percentLeft, 0), 100)}%` }}
        />
      </div>
      <div className="usage-bar-subtext">
        {usage ? `${prefix}${usage.timeLeft || 'reset unknown'}` : 'Waiting for usage heartbeat'}
      </div>
    </div>
  );
}

function RuntimeMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="sidebar-runtime-metric">
      <span className="sidebar-runtime-metric-label">{label}</span>
      <span className="sidebar-runtime-metric-value">{value}</span>
    </div>
  );
}
