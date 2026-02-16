import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Menu, X, LogOut, ChevronDown, Puzzle } from 'lucide-react';
import { getSidebarGroups, NavGroupMeta, NavItem } from '../config/navigation';
import './Sidebar.css';
import { ModelStatusBadge } from './ModelStatusBadge';
import { StopButton } from './StopButton';
import { WorkspaceFiles } from './WorkspaceFiles';
import { AgentDetailCard } from './AgentDetailCard';
import { useBotStatus } from '../hooks/useBotStatus';
import { usePlugins } from '../contexts/PluginContext';
import { auth, authenticatedFetch } from '../utils/auth';
import { StatusOrb } from './StatusOrb';
import { DynamicIcon } from '../utils/icons';
import { PluginNavItem } from '../types/plugin';

interface UsageStats {
  session: { percentLeft: number; timeLeft: string };
  weekly: { percentLeft: number; timeLeft: string };
  stale: boolean;
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

export function Sidebar({ status, connected }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [openclawVersion, setOpenclawVersion] = useState<string | null>(null);
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const { status: botStatus } = useBotStatus();
  const { plugins, pluginSidebarItems, loading: pluginsLoading } = usePlugins();
  const navigate = useNavigate();

  // Listen for model:status events to get OpenClaw version + usage stats
  useEffect(() => {
    const handler = (event: CustomEvent<{ openclawVersion?: string; usageStats?: UsageStats }>) => {
      if (event.detail?.openclawVersion) {
        setOpenclawVersion(event.detail.openclawVersion);
      }
      if (event.detail?.usageStats) {
        setUsageStats(event.detail.usageStats);
      }
    };
    window.addEventListener('model:status' as any, handler);

    // Also fetch on mount via HTTP
    const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
    authenticatedFetch(`${API_BASE}/model-status`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.openclawVersion) setOpenclawVersion(data.openclawVersion);
        if (data?.usageStats) setUsageStats(data.usageStats);
      })
      .catch(() => {});

    return () => window.removeEventListener('model:status' as any, handler);
  }, []);

  // Global keyboard shortcuts: Ctrl+Shift+X and Escape (when working) to stop bot
  useEffect(() => {
    const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
    const handler = (e: KeyboardEvent) => {
      // Ctrl+Shift+X — always triggers main stop
      if (e.ctrlKey && e.shiftKey && e.key === 'X') {
        e.preventDefault();
        authenticatedFetch(`${API_BASE}/control/stop-main`, { method: 'POST' });
        return;
      }
      // Escape — stop only when bot is actively working
      if (e.key === 'Escape' && status?.main.state && status.main.state !== 'idle' && status.main.state !== 'error') {
        // Don't intercept Escape if user is in an input, dialog, or modal
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
          return;
        }
        // Don't intercept if a modal/overlay is open
        if (document.querySelector('.stop-confirm-overlay')) {
          return;
        }
        e.preventDefault();
        authenticatedFetch(`${API_BASE}/control/stop-main`, { method: 'POST' });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [status?.main.state]);

  // Get status message from database or use default
  const statusMessage = botStatus?.status_text || "Building something amazing...";
  const [statusExpanded, _setStatusExpanded] = useState(false);

  // Get state emoji and color
  const getStateDisplay = (state: string) => {
    switch (state) {
      case 'thinking':
        return { emoji: '🤔', color: '#FFD700', text: 'Thinking' };
      case 'typing':
        return { emoji: '✍️', color: '#4CAF50', text: 'Typing' };
      case 'tool-use':
        return { emoji: '🛠️', color: '#FF9800', text: 'Working' };
      case 'waiting':
        return { emoji: '⏳', color: '#2196F3', text: 'Processing' };
      case 'error':
        return { emoji: '⚠️', color: '#F44336', text: 'Error' };
      default:
        return { emoji: '😴', color: '#9E9E9E', text: 'Idle' };
    }
  };

  const stateDisplay = status ? getStateDisplay(status.main.state) : getStateDisplay('idle');

  return (
    <>
      {/* Mobile hamburger button */}
      <button 
        className="sidebar-hamburger" 
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
      >
        {mobileOpen ? <X size={22} /> : <Menu size={22} />}
      </button>

      {/* Mobile backdrop */}
      <div 
        className={`sidebar-backdrop ${mobileOpen ? 'sidebar-backdrop-visible' : ''}`}
        onClick={() => setMobileOpen(false)}
      />

      <div className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        {/* 1. Status Orb Section - Always at top */}
        <div className="sidebar-avatar-section">
          <div className="avatar-container">
            {(() => {
              const orbPlugin = plugins.find(p => p.name === 'nim-orb' && p.healthy);
              if (orbPlugin) {
                const state = status?.main.state || 'idle';
                return (
                  <iframe
                    src={`${import.meta.env.VITE_API_BASE_URL || '/api'}/plugins/nim-orb/avatar?state=${state}`}
                    style={{
                      width: 200,
                      height: 200,
                      border: 'none',
                      borderRadius: '50%',
                      overflow: 'hidden',
                      background: 'transparent',
                      marginTop: '-10px',
                    }}
                    title="NimOrb Avatar"
                    allow="accelerometer; autoplay"
                  />
                );
              }
              return (
                <StatusOrb
                  state={status?.main.state || 'idle'}
                  size={120}
                />
              );
            })()}
          </div>
        </div>

        {/* 2. Model name + context window bar */}
        <div className="sidebar-model-section">
          <ModelStatusBadge compact={false} />
        </div>

        {/* 2b. Usage bars - only shown when fresh data available (hide when stale >20min) */}
        {usageStats && !usageStats.stale && (
          <div className="sidebar-usage-bars">
            <UsageBarRow
              label="Session"
              percentLeft={usageStats.session.percentLeft}
              timeLeft={usageStats.session.timeLeft}
            />
            <UsageBarRow
              label="Weekly"
              percentLeft={usageStats.weekly.percentLeft}
              timeLeft={usageStats.weekly.timeLeft}
            />
          </div>
        )}

        {/* 3. Online status */}
        <div className={`sidebar-connection ${connected ? 'online' : 'offline'}`}>
          <span className="status-dot"></span>
          <span className="connection-text">{connected ? 'Online' : 'Offline'}</span>
        </div>

        {/* 4. Divider */}
        <div className="sidebar-divider" />

        {/* 5. Navigation Menu — grouped with collapsible sections */}
        <div className="sidebar-nav-section">
          <nav aria-label="Main navigation">
            {getSidebarGroups().map(({ group, items }) => (
              <NavGroupSection key={group.id} group={group} items={items} />
            ))}

            {/* Plugins group — dynamically populated from loaded plugins */}
            {!pluginsLoading && pluginSidebarItems.length > 0 && (
              <CollapsibleGroup
                id="plugins"
                label="Plugins"
                icon={<Puzzle size={14} />}
                defaultCollapsed={false}
              >
                {pluginSidebarItems.map((item) => (
                  <PluginNavLink
                    key={`${item.pluginName}-${item.path}`}
                    item={item}
                  />
                ))}
              </CollapsibleGroup>
            )}
          </nav>
        </div>

        {/* 6. Main Status Card (Idle/Thinking/Processing) */}
        <div className={`sidebar-status-card ${status?.main.state !== 'idle' ? 'status-active' : ''}`}>
          <div className="status-card-content">
            <span className="status-card-emoji">{stateDisplay.emoji}</span>
            <span className="status-card-text" style={{ color: stateDisplay.color }}>{stateDisplay.text}</span>
          </div>
          
          {/* Activity Details - shown when active */}
          <div className={`status-activity ${status?.main.state !== 'idle' ? 'activity-visible' : ''}`}>
            {status?.main.detail && (
              <p className="activity-detail">{status.main.detail}</p>
            )}
            {status?.main.tools && status.main.tools.length > 0 && (
              <div className="activity-tools">
                <span className="tools-label">Tools:</span>
                {status.main.tools.map((tool, i) => (
                  <span key={i} className="tool-tag">{tool}</span>
                ))}
              </div>
            )}
          </div>
          
          {/* Stop Button — visible when bot is active */}
          {status?.main.state !== 'idle' && status?.main.state !== 'error' && (
            <div className="status-card-stop">
              <StopButton
                variant="main"
                isActive={true}
              />
            </div>
          )}
        </div>

        {/* 7. Agents list (NO header - just cards) */}
        <div className={`sidebar-agents ${status && status.agentCount > 0 ? 'agents-visible' : 'agents-hidden'}`}>
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

        {/* 8. Divider */}
        <div className="sidebar-divider" />

        {/* 9. Status description */}
        <div className="sidebar-status-description">
          <p 
            className={`status-message ${statusExpanded ? 'expanded' : 'collapsed'}`}
            onClick={() => navigate('/journal')}
            title="Click to view journal"
          >
            {statusMessage}
          </p>
        </div>

        {/* 10. Workspace Files */}
        <WorkspaceFiles />

        {/* 11. Session Stats — removed (redundant with Sessions page) */}

        {/* Environment Toggle */}
        <div className="sidebar-env-toggle-wrapper">
          <div className="env-toggle" onClick={() => {
            const isDev = window.location.pathname.startsWith('/dashboard-dev');
            window.location.href = isDev ? '/dashboard/' : '/dashboard-dev/';
          }} title={`Switch to ${window.location.pathname.startsWith('/dashboard-dev') ? 'Production' : 'Development'}`}>
            <span className="env-toggle-label">{window.location.pathname.startsWith('/dashboard-dev') ? 'DEV' : 'PROD'}</span>
            <div className={`env-toggle-switch ${window.location.pathname.startsWith('/dashboard-dev') ? 'dev' : 'prod'}`}>
              <div className="env-toggle-knob" />
            </div>
          </div>
        </div>

        {/* Logout Button */}
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

        {/* Footer */}
        <div className="sidebar-footer">
          <p className="sidebar-version">
            v2.0.0{openclawVersion ? ` · OC ${openclawVersion}` : ''}
          </p>
          <p className="sidebar-tagline">Powered by ClawBoard</p>
        </div>
      </div>
    </>
  );
}

/* ============================================================
   Collapsible group — reusable animated fold/unfold wrapper
   ============================================================ */

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
    } catch { return defaultCollapsed; }
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

/* ============================================================
   NavGroupSection — renders one group from navigation config
   ============================================================ */

function NavGroupSection({ group, items }: { group: NavGroupMeta; items: NavItem[] }) {
  if (!group.collapsible) {
    // Main group — render items directly (no header)
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

/* ============================================================
   SidebarNavLink — single nav item
   ============================================================ */

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
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
    </Link>
  );
}

/**
 * Plugin navigation link with dynamic icon and health indicator
 */
function PluginNavLink({ item }: { item: PluginNavItem }) {
  const location = useLocation();
  const isActive = location.pathname.startsWith(item.path);
  
  return (
    <Link 
      to={item.path} 
      className={`sidebar-nav-link plugin-nav-link ${isActive ? 'active' : ''} ${!item.healthy ? 'unhealthy' : ''}`}
      title={!item.healthy ? `${item.label} (plugin unhealthy)` : item.label}
    >
      <span className="nav-icon">
        <DynamicIcon name={item.icon} size={18} />
      </span>
      <span className="nav-label">{item.label}</span>
      {!item.healthy && <span className="plugin-health-dot" title="Plugin unhealthy" />}
    </Link>
  );
}

function UsageBarRow({ label, percentLeft, timeLeft }: { label: string; percentLeft: number; timeLeft: string }) {
  const colorClass = percentLeft > 50 ? 'green' : percentLeft > 20 ? 'yellow' : 'red';
  return (
    <div className="usage-bar-row">
      <span className="usage-bar-label">{label}</span>
      <div className="usage-bar-track">
        <div
          className={`usage-bar-fill ${colorClass}`}
          style={{ width: `${Math.min(percentLeft, 100)}%` }}
        />
      </div>
      <span className="usage-bar-info">
        <span className="usage-bar-percent">{percentLeft}%</span>{' '}
        <span className="usage-bar-time">({timeLeft})</span>
      </span>
    </div>
  );
}
