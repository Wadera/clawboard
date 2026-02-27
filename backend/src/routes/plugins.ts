/**
 * Plugin API routes
 * 
 * GET /api/plugins — list all enabled plugins with sidebar items and health status
 * GET /api/plugins/theme.css — shared CSS variables for plugin theming
 */
import { Router, Request, Response } from 'express';
import { PluginLoader } from '../services/PluginLoader';

const router = Router();
let pluginLoader: PluginLoader | null = null;

export function setPluginLoader(loader: PluginLoader) {
  pluginLoader = loader;
}

/**
 * GET /plugins — list all registered plugins
 */
router.get('/', (_req: Request, res: Response) => {
  if (!pluginLoader) {
    res.json({ plugins: [] });
    return;
  }

  const registry = pluginLoader.getRegistry();
  res.json({ plugins: registry });
});

/**
 * GET /plugins/theme.css — shared CSS variables for plugin theming
 */
router.get('/theme.css', (_req: Request, res: Response) => {
  if (!pluginLoader) {
    res.type('text/css').send(':root {}');
    return;
  }

  res.type('text/css').send(pluginLoader.getThemeCSS());
});

/**
 * GET /plugins/:name — get details for a specific plugin
 */
router.get('/:name', (req: Request, res: Response) => {
  if (!pluginLoader) {
    res.status(404).json({ error: 'Plugin system not initialized' });
    return;
  }

  const plugin = pluginLoader.getPlugin(req.params.name);
  if (!plugin) {
    res.status(404).json({ error: `Plugin not found: ${req.params.name}` });
    return;
  }

  res.json({
    name: plugin.name,
    version: plugin.manifest?.version,
    description: plugin.manifest?.description,
    healthy: plugin.healthy,
    lastHealthCheck: plugin.lastHealthCheck,
    error: plugin.error,
    sidebar: plugin.manifest?.ui?.sidebar || [],
    endpoints: plugin.manifest?.api?.endpoints || [],
    category: plugin.manifest?.clawboard?.category,
  });
});

export default router;
