import { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Menu, X, LogOut, ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react';
import { getSidebarNavItems } from '../config/navigation';
import './Sidebar.css';
import { ModelStatusBadge } from './ModelStatusBadge';
import { StopButton } from './StopButton';
import { WorkspaceFiles } from './WorkspaceFiles';
import { AgentDetailCard } from './AgentDetailCard';
import { useBotStatus } from '../hooks/useBotStatus';
import { auth, authenticatedFetch } from '../utils/auth';
import { StatusOrb } from './StatusOrb';
// NotificationBadge removed — not needed

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
  const [collapsed, setCollapsed] = useState(() => {
    // Persist collapse state in localStorage
    const saved = localStorage.getItem('sidebar-collapsed');
    return saved === 'true';
  });
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [openclawVersion, setOpenclawVersion] = useState<string | null>(null);
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const { status: botStatus } = useBotStatus();
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
  const [navExpanded, setNavExpanded] = useState(false); // Navigation menu collapsed by default

  // Persist collapse state and notify other components
  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', String(collapsed));
    // Dispatch custom event for same-tab listeners
    window.dispatchEvent(new Event('sidebar-collapse-change'));
  }, [collapsed]);

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

      <div className={`sidebar ${mobileOpen ? 'sidebar-open' : ''} ${collapsed ? 'sidebar-collapsed' : ''}`}>
        {/* Collapse Toggle Button */}
        <button 
          className="sidebar-collapse-toggle"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>

        {/* 1. Status Orb Section - Always at top */}
        <div className="sidebar-avatar-section">
          <div className="avatar-container">
            <StatusOrb
              state={status?.main.state || 'idle'}
              size={collapsed ? 56 : 120}
            />
          </div>
        </div>

        {/* 2. Model name + context window bar */}
        <div className="sidebar-model-section">
          <ModelStatusBadge compact={collapsed} />
        </div>

        {/* 2b. Usage bars - only shown when fresh data available (hide when stale >20min) */}
        {!collapsed && usageStats && !usageStats.stale && (
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

        {/* 5. Navigation Menu - Collapsible */}
        <div className="sidebar-nav-section">
          <button 
            className="sidebar-nav-toggle"
            onClick={() => setNavExpanded(!navExpanded)}
            aria-expanded={navExpanded}
            aria-label={navExpanded ? 'Collapse menu' : 'Expand menu'}
          >
            <span className="nav-toggle-icon">🧭</span>
            <span className="nav-toggle-label">Menu</span>
            <span className="nav-toggle-chevron">
              {navExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </span>
          </button>
          <nav className={`sidebar-nav ${navExpanded ? 'nav-expanded' : 'nav-collapsed'}`} aria-label="Main navigation">
            {getSidebarNavItems().map((item) => (
              <SidebarNavLink 
                key={item.id}
                to={item.path} 
                icon={<item.icon size={18} />} 
                label={item.label} 
                collapsed={collapsed} 
              />
            ))}
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
                  title={collapsed ? agent.label : undefined}
                >
                  <span className={`agent-status ${agent.state}`}></span>
                  <span className="agent-label">{agent.label}</span>
                  {agent.state === 'running' && !collapsed && (
                    <StopButton variant="agent" agentKey={agent.key} />
                  )}
                </div>
                {expandedAgent === agent.key && !collapsed && (
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

        {/* 10. Workspace Files - Only when expanded */}
        {!collapsed && <WorkspaceFiles />}

        {/* 11. Session Stats */}
        <div className="sidebar-section stats-section">
          <div className="stats-grid">
            <div className="stat-item" title="Messages this session">
              <span className="stat-value">{status?.stats?.messageCount ?? '-'}</span>
              <span className="stat-label">Msgs</span>
            </div>
            <div className="stat-item" title="Tools used this session">
              <span className="stat-value">{status?.stats?.toolsUsed ?? '-'}</span>
              <span className="stat-label">Tools</span>
            </div>
          </div>
        </div>

        {/* Logout Button */}
        <div className="sidebar-section logout-section">
          <button 
            className="sidebar-logout-button" 
            onClick={() => auth.logout()}
            title={collapsed ? 'Logout' : undefined}
          >
            <LogOut size={18} />
            <span className="logout-text">Logout</span>
          </button>
        </div>

        {/* Footer */}
        <div className="sidebar-footer">
          <p className="sidebar-version">
            v1.2.0{openclawVersion ? ` · OC ${openclawVersion}` : ''}
          </p>
          <p className="sidebar-tagline">🌀 Always curious</p>
        </div>
      </div>
    </>
  );
}

interface SidebarNavLinkProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
}

function SidebarNavLink({ to, icon, label, collapsed }: SidebarNavLinkProps) {
  const location = useLocation();
  const isActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
  return (
    <Link 
      to={to} 
      className={`sidebar-nav-link ${isActive ? 'active' : ''}`}
      title={collapsed ? label : undefined}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
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
