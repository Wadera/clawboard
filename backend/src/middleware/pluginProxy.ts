/**
 * Plugin Proxy Middleware
 * 
 * Routes requests to /api/plugins/{name}/* and /plugins/{name}/* 
 * to the appropriate plugin container.
 */
import { Request, Response, NextFunction } from 'express';
import http from 'http';
import { PluginLoader } from '../services/PluginLoader';

export function createPluginProxy(pluginLoader: PluginLoader) {
  return (req: Request, res: Response, next: NextFunction) => {
    const routes = pluginLoader.getProxyRoutes();

    // Find a matching route
    for (const route of routes) {
      if (req.path.startsWith(route.pathPrefix)) {
        // Strip the prefix and proxy to the plugin
        const targetPath = req.path.slice(route.pathPrefix.length) || '/';
        const targetUrl = new URL(targetPath, route.target);
        
        // Preserve query string
        targetUrl.search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

        // Proxy the request
        const proxyReq = http.request(
          {
            hostname: targetUrl.hostname,
            port: targetUrl.port,
            path: targetUrl.pathname + targetUrl.search,
            method: req.method,
            headers: {
              ...req.headers,
              host: `${targetUrl.hostname}:${targetUrl.port}`,
              'x-plugin-name': route.pluginName,
              'x-forwarded-for': req.ip || req.socket.remoteAddress || '',
              'x-forwarded-proto': req.protocol,
            },
          },
          (proxyRes) => {
            // Forward status and headers
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
            proxyRes.pipe(res);
          }
        );

        proxyReq.on('error', (err) => {
          console.error(`🔌 Proxy error for ${route.pluginName}:`, err.message);
          if (!res.headersSent) {
            res.status(502).json({
              error: 'Plugin unavailable',
              plugin: route.pluginName,
              message: err.message,
            });
          }
        });

        // Pipe request body
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          req.pipe(proxyReq);
        } else {
          proxyReq.end();
        }

        return; // Request handled by proxy
      }
    }

    // No matching plugin route — continue to next middleware
    next();
  };
}
