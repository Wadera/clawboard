/**
 * PluginLoader - Discovers, validates, and manages ClawBoard plugins
 * 
 * Reads clawboard.plugins.json on startup, validates plugin manifests,
 * builds an in-memory registry, and performs health checks.
 */
import fs from 'fs';
import path from 'path';

// ============================================
// Types
// ============================================

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  docker: {
    image: string;
    build?: string;
    ports: Record<string, string>;
    volumes?: string[];
    environment?: Record<string, string>;
    networks?: string[];
    depends_on?: string[];
    runtime?: string | null;
    network_mode?: string | null;
  };
  api: {
    base_path: string;
    internal_port: number;
    health: string;
    endpoints?: Array<{
      method: string;
      path: string;
      description: string;
    }>;
  };
  ui?: {
    enabled: boolean;
    sidebar?: Array<{
      label: string;
      icon: string;
      path: string;
      badge?: string | null;
    }>;
    routes?: Array<{
      path: string;
      proxy_to: string;
    }>;
    embedding?: 'proxy' | 'none';
  };
  config?: {
    schema?: Record<string, any>;
    defaults?: Record<string, any>;
  };
  agent?: {
    tool_name?: string;
    capabilities?: string[];
  };
  author?: string;
  license?: string;
  repository?: string;
  clawboard?: {
    min_version?: string;
    category?: string;
  };
}

export interface PluginConfig {
  name: string;
  source: string;
  enabled: boolean;
  config_override?: Record<string, any>;
}

export interface PluginsFileConfig {
  plugins: PluginConfig[];
}

export interface LoadedPlugin {
  name: string;
  config: PluginConfig;
  manifest: PluginManifest;
  healthy: boolean;
  lastHealthCheck: number | null;
  error?: string;
}

export interface PluginRegistryEntry {
  name: string;
  version: string;
  description: string;
  healthy: boolean;
  sidebar: Array<{
    label: string;
    icon: string;
    path: string;
    badge?: string | null;
  }>;
  api_base: string;
  internal_port: number;
  category?: string;
}

// ============================================
// Plugin Loader
// ============================================

export class PluginLoader {
  private configPath: string;
  private plugins: Map<string, LoadedPlugin> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckIntervalMs: number;

  constructor(configPath?: string, healthCheckIntervalMs = 60000) {
    this.configPath = configPath || process.env.CLAWBOARD_PLUGINS_CONFIG || './clawboard.plugins.json';
    this.healthCheckIntervalMs = healthCheckIntervalMs;
  }

  /**
   * Initialize: read config, load manifests, run initial health checks
   */
  async initialize(): Promise<void> {
    console.log('🔌 Plugin Loader: Initializing...');

    // Read plugins config
    const pluginsConfig = this.readPluginsConfig();
    if (!pluginsConfig || pluginsConfig.plugins.length === 0) {
      console.log('🔌 Plugin Loader: No plugins configured — running in core-only mode');
      return;
    }

    const enabledPlugins = pluginsConfig.plugins.filter(p => p.enabled);
    console.log(`🔌 Plugin Loader: Found ${pluginsConfig.plugins.length} plugins (${enabledPlugins.length} enabled)`);

    // Load each enabled plugin
    for (const pluginConfig of enabledPlugins) {
      try {
        const manifest = this.loadManifest(pluginConfig);
        if (manifest) {
          this.validateManifest(manifest);
          this.plugins.set(pluginConfig.name, {
            name: pluginConfig.name,
            config: pluginConfig,
            manifest,
            healthy: false,
            lastHealthCheck: null,
          });
          console.log(`  ✅ Loaded plugin: ${pluginConfig.name} v${manifest.version}`);
        }
      } catch (err) {
        console.error(`  ❌ Failed to load plugin ${pluginConfig.name}:`, err instanceof Error ? err.message : err);
        this.plugins.set(pluginConfig.name, {
          name: pluginConfig.name,
          config: pluginConfig,
          manifest: null as any,
          healthy: false,
          lastHealthCheck: null,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    // Run initial health checks
    await this.checkAllHealth();

    // Start periodic health checks
    this.healthCheckInterval = setInterval(() => {
      this.checkAllHealth().catch(err => {
        console.error('🔌 Plugin health check error:', err);
      });
    }, this.healthCheckIntervalMs);

    console.log(`🔌 Plugin Loader: ${this.plugins.size} plugins registered`);
  }

  /**
   * Read the plugins configuration file
   */
  private readPluginsConfig(): PluginsFileConfig | null {
    try {
      const resolvedPath = path.resolve(process.cwd(), this.configPath);
      
      if (!fs.existsSync(resolvedPath)) {
        console.log(`🔌 Plugin config not found at ${resolvedPath} — no plugins loaded`);
        return null;
      }

      const content = fs.readFileSync(resolvedPath, 'utf-8');
      const config = JSON.parse(content) as PluginsFileConfig;

      if (!config.plugins || !Array.isArray(config.plugins)) {
        console.warn('🔌 Invalid plugins config: missing "plugins" array');
        return null;
      }

      return config;
    } catch (err) {
      console.error('🔌 Error reading plugins config:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Load a plugin's manifest (plugin.json) from its source directory
   */
  private loadManifest(pluginConfig: PluginConfig): PluginManifest | null {
    const sourcePath = path.resolve(process.cwd(), pluginConfig.source);
    const manifestPath = path.join(sourcePath, 'plugin.json');

    if (!fs.existsSync(manifestPath)) {
      console.warn(`🔌 No plugin.json found at ${manifestPath} for ${pluginConfig.name}`);
      return null;
    }

    const content = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content) as PluginManifest;

    // Apply config overrides
    if (pluginConfig.config_override) {
      this.applyOverrides(manifest, pluginConfig.config_override);
    }

    return manifest;
  }

  /**
   * Apply deployment-specific overrides to a manifest
   */
  private applyOverrides(manifest: PluginManifest, overrides: Record<string, any>): void {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const target = (manifest as any)[key];
        if (typeof target === 'object' && target !== null) {
          Object.assign(target, value);
        } else {
          (manifest as any)[key] = value;
        }
      } else {
        (manifest as any)[key] = value;
      }
    }
  }

  /**
   * Validate a plugin manifest has all required fields
   */
  private validateManifest(manifest: PluginManifest): void {
    const required = ['name', 'version', 'description'];
    for (const field of required) {
      if (!(manifest as any)[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    if (!manifest.docker?.image) {
      throw new Error('Missing required field: docker.image');
    }

    if (!manifest.api?.health) {
      throw new Error('Missing required field: api.health');
    }

    // Check for port conflicts
    const usedPorts = new Set<string>();
    for (const [, plugin] of this.plugins) {
      if (plugin.manifest?.docker?.ports) {
        for (const hostPort of Object.values(plugin.manifest.docker.ports)) {
          if (manifest.docker.ports && Object.values(manifest.docker.ports).includes(hostPort)) {
            if (usedPorts.has(hostPort)) {
              throw new Error(`Port conflict: ${hostPort} already used by another plugin`);
            }
          }
          usedPorts.add(hostPort);
        }
      }
    }
  }

  /**
   * Check health of all registered plugins
   */
  async checkAllHealth(): Promise<void> {
    const promises = Array.from(this.plugins.entries()).map(async ([_name, plugin]) => {
      if (!plugin.manifest) return;

      try {
        const port = plugin.manifest.api.internal_port;
        const healthPath = plugin.manifest.api.health;
        
        // If plugin uses host network mode, use localhost
        const host = plugin.manifest.docker.network_mode === 'host' 
          ? 'localhost' 
          : plugin.manifest.name;
        
        const url = `http://${host}:${port}${healthPath}`;
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(url, { 
          signal: controller.signal,
          headers: { 'User-Agent': 'clawboard-plugin-loader/2.0.0' }
        });
        clearTimeout(timeout);

        plugin.healthy = response.ok;
        plugin.lastHealthCheck = Date.now();
        plugin.error = response.ok ? undefined : `Health check returned ${response.status}`;
      } catch (err) {
        plugin.healthy = false;
        plugin.lastHealthCheck = Date.now();
        plugin.error = err instanceof Error ? err.message : 'Health check failed';
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Get the plugin registry for the API response
   */
  getRegistry(): PluginRegistryEntry[] {
    const entries: PluginRegistryEntry[] = [];

    for (const [, plugin] of this.plugins) {
      if (!plugin.manifest) continue;

      entries.push({
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        description: plugin.manifest.description,
        healthy: plugin.healthy,
        sidebar: plugin.manifest.ui?.enabled && plugin.manifest.ui?.sidebar 
          ? plugin.manifest.ui.sidebar 
          : [],
        api_base: plugin.manifest.api.base_path,
        internal_port: plugin.manifest.api.internal_port,
        category: plugin.manifest.clawboard?.category,
      });
    }

    return entries;
  }

  /**
   * Get proxy routes for all plugins (used by middleware)
   */
  getProxyRoutes(): Array<{
    pathPrefix: string;
    target: string;
    pluginName: string;
  }> {
    const routes: Array<{ pathPrefix: string; target: string; pluginName: string }> = [];

    for (const [, plugin] of this.plugins) {
      if (!plugin.manifest || !plugin.healthy) continue;

      const port = plugin.manifest.api.internal_port;
      const host = plugin.manifest.docker.network_mode === 'host'
        ? 'localhost'
        : plugin.manifest.name;

      // API routes
      routes.push({
        pathPrefix: plugin.manifest.api.base_path,
        target: `http://${host}:${port}`,
        pluginName: plugin.manifest.name,
      });

      // UI routes (if plugin has UI)
      if (plugin.manifest.ui?.enabled && plugin.manifest.ui?.routes) {
        for (const route of plugin.manifest.ui.routes) {
          routes.push({
            pathPrefix: `/plugins/${plugin.manifest.name.replace('claw-', '')}${route.path}`,
            target: `http://${host}:${port}${route.proxy_to}`,
            pluginName: plugin.manifest.name,
          });
        }
      }
    }

    return routes;
  }

  /**
   * Get a specific plugin by name
   */
  getPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all loaded plugins
   */
  getAllPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get the CSS theme variables for plugins
   */
  getThemeCSS(): string {
    return `:root {
  --cb-bg-primary: #0a0a0a;
  --cb-bg-secondary: #1a1a2e;
  --cb-text-primary: #e0e0e0;
  --cb-accent: #7c3aed;
  --cb-border: #2a2a3e;
  --cb-font-family: 'Inter', sans-serif;
}`;
  }

  /**
   * Stop the plugin loader (cleanup)
   */
  stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    console.log('🔌 Plugin Loader: Stopped');
  }
}
