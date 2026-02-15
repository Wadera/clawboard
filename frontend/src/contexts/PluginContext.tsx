import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { authenticatedFetch } from '../utils/auth';
import { PluginInfo, PluginNavItem, PluginsResponse, PluginRoute } from '../types/plugin';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const REFRESH_INTERVAL_MS = 60000; // 60 seconds

interface PluginContextType {
  /** All loaded plugins */
  plugins: PluginInfo[];
  /** Merged sidebar items from all healthy plugins */
  pluginSidebarItems: PluginNavItem[];
  /** All routes from all healthy plugins, with plugin metadata */
  pluginRoutes: Array<PluginRoute & { pluginName: string }>;
  /** Whether plugins are currently loading */
  loading: boolean;
  /** Error if plugin loading failed */
  error: Error | null;
  /** Manually refresh plugins */
  refresh: () => Promise<void>;
}

const PluginContext = createContext<PluginContextType>({
  plugins: [],
  pluginSidebarItems: [],
  pluginRoutes: [],
  loading: true,
  error: null,
  refresh: async () => {},
});

/**
 * Hook to access plugin data
 */
export function usePlugins() {
  return useContext(PluginContext);
}

interface PluginProviderProps {
  children: ReactNode;
}

/**
 * Plugin provider that fetches and manages plugin data
 * 
 * Polls the /api/plugins endpoint every 60 seconds to detect
 * plugin health changes and new plugins.
 */
export function PluginProvider({ children }: PluginProviderProps) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Fetch plugins from API
  const fetchPlugins = useCallback(async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE}/plugins`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch plugins: ${response.status}`);
      }
      
      const data: PluginsResponse = await response.json();
      console.log('🔌 Plugins loaded:', data.plugins?.length, data.plugins?.map(p => p.name));
      setPlugins(data.plugins || []);
      setError(null);
    } catch (err) {
      console.error('Error fetching plugins:', err);
      setError(err instanceof Error ? err : new Error('Failed to fetch plugins'));
      // Don't clear existing plugins on error - keep showing what we had
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch and polling
  useEffect(() => {
    // Initial fetch
    fetchPlugins();

    // Set up polling interval
    const intervalId = setInterval(fetchPlugins, REFRESH_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [fetchPlugins]);

  // Derive sidebar items from healthy plugins
  const pluginSidebarItems: PluginNavItem[] = plugins
    .filter(plugin => plugin.sidebar.length > 0)
    .flatMap(plugin =>
      plugin.sidebar.map(item => ({
        ...item,
        pluginName: plugin.name,
        healthy: plugin.healthy,
      }))
    );

  // Derive routes from healthy plugins
  const pluginRoutes = plugins
    .filter(plugin => plugin.routes.length > 0)
    .flatMap(plugin =>
      plugin.routes.map(route => ({
        ...route,
        pluginName: plugin.name,
      }))
    );

  const value: PluginContextType = {
    plugins,
    pluginSidebarItems,
    pluginRoutes,
    loading,
    error,
    refresh: fetchPlugins,
  };

  return (
    <PluginContext.Provider value={value}>
      {children}
    </PluginContext.Provider>
  );
}
