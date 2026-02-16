import { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom';
import './App.css';
import { Sidebar } from './components/Sidebar';
import { useRealtimeStatus } from './hooks/useRealtimeStatus';
import { DashboardPage } from './pages/DashboardPage';
import { TasksPage } from './pages/TasksPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { AuditPage } from './pages/AuditPage';
import { SessionsPage } from './pages/SessionsPage';
import { StatsPage } from './pages/StatsPage';
import { ImageGenerationPage } from './pages/ImageGenerationPage';
import { JournalPage } from './pages/JournalPage';
import { JournalPostPage } from './pages/JournalPostPage';
import { ToolsPage } from './pages/ToolsPage';
import { LoginPage } from './pages/LoginPage';
import { FileViewerProvider } from './contexts/FileViewerContext';
import { ModelSwitchProvider } from './contexts/ModelSwitchContext';
import { ToastProvider } from './contexts/ToastContext';
import { ClawBoardConfigProvider, useClawBoardConfig } from './contexts/ClawBoardConfigContext';
import { PluginProvider, usePlugins } from './contexts/PluginContext';
import { PluginFrame } from './components/PluginFrame';
import { auth, authenticatedFetch } from './utils/auth';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(auth.isAuthenticated());

  const handleLoginSuccess = () => {
    setIsAuthenticated(true);
  };

  // Wrap everything with ClawBoardConfigProvider
  return (
    <ClawBoardConfigProvider>
      {!isAuthenticated ? (
        <LoginPage onLoginSuccess={handleLoginSuccess} />
      ) : (
        <AuthenticatedApp />
      )}
    </ClawBoardConfigProvider>
  );
}

function AuthenticatedApp() {
  const { config } = useClawBoardConfig();
  const { status: realtimeStatus, connected: wsConnected } = useRealtimeStatus();

  // Global keyboard shortcut: Ctrl+Shift+X to stop
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'X') {
        e.preventDefault();
        // Trigger stop via API directly
        const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
        authenticatedFetch(`${API_BASE}/control/stop-main`, { method: 'POST' });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const basename = import.meta.env.BASE_URL || '/dashboard/';
  
  return (
    <Router basename={basename}>
      <PluginProvider>
      <ToastProvider>
      <ModelSwitchProvider>
      <FileViewerProvider>
      <div className="app-container">
        <Sidebar status={realtimeStatus} connected={wsConnected} />

        <div className="app">
          <main className="main-content">
            <RouteTransition>
              <AppRoutes config={config} />
            </RouteTransition>
          </main>

        </div>
      </div>
    </FileViewerProvider>
      </ModelSwitchProvider>
      </ToastProvider>
      </PluginProvider>
    </Router>
  );
}

/**
 * CSS-only route transition — re-triggers fadeIn on path change
 */
function RouteTransition({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <div className="route-transition" key={location.pathname}>
      {children}
    </div>
  );
}

/**
 * App routes component that includes both static and plugin routes
 */
function AppRoutes({ config }: { config: ReturnType<typeof useClawBoardConfig>['config'] }) {
  const { pluginRoutes, loading: pluginsLoading } = usePlugins();
  const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

  return (
    <Routes>
      {/* Core routes */}
      <Route path="/" element={<DashboardPage />} />
      {config.features.taskBoard && <Route path="/tasks" element={<TasksPage />} />}
      {config.features.projects && <Route path="/projects" element={<ProjectsPage />} />}
      {config.features.imageGeneration && <Route path="/images" element={<ImageGenerationPage />} />}
      {config.features.sessions && <Route path="/sessions" element={<SessionsPage />} />}
      {config.features.auditLog && <Route path="/audit" element={<AuditPage />} />}
      {config.features.journal && <Route path="/journal" element={<JournalPage />} />}
      {config.features.journal && <Route path="/journal/:id" element={<JournalPostPage />} />}
      {config.features.tools && <Route path="/tools" element={<ToolsPage />} />}
      {config.features.stats && <Route path="/stats" element={<StatsPage />} />}
      
      {/* Plugin routes - dynamically registered */}
      {!pluginsLoading && pluginRoutes.map(route => (
        <Route
          key={`${route.pluginName}-${route.path}`}
          path={`${route.path}/*`}
          element={
            <PluginFrame
              pluginName={route.pluginName}
              proxyPath={route.proxy_to}
              apiBase={API_BASE}
            />
          }
        />
      ))}
    </Routes>
  );
}

export default App;
