import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { Server as SocketIOServer } from 'socket.io';
import http from 'http';
import dotenv from 'dotenv';
import { pool } from './db/connection';
import { WebSocketService } from './services/websocket';
import { SessionMonitor } from './services/sessionMonitor';
import { taskManager } from './services/TaskManager';
import { WorkspaceWatcher } from './services/workspaceWatcher';
import { ModelStatusService } from './services/modelStatus';
import { ControlService } from './services/controlService';
import { WorkMonitor } from './services/workMonitor';
import { taskAnalyzer } from './services/taskAnalyzer';
import { autoArchive } from './services/autoArchive';
import { subAgentTaskUpdater } from './services/SubAgentTaskUpdater';
import { GatewayConnector } from './services/GatewayConnector';
import { PluginLoader } from './services/PluginLoader';

// Load environment variables
dotenv.config();

// Global error handlers - safety nets to prevent crashes
process.on('uncaughtException', (err: Error) => {
  console.error('╔═══════════════════════════════════════════════════════════╗');
  console.error('║ UNCAUGHT EXCEPTION - Server stability compromised        ║');
  console.error('╚═══════════════════════════════════════════════════════════╝');
  console.error('Error:', err);
  console.error('Stack:', err.stack);
  console.error('⚠️  Server continuing, but this should be investigated!');
  // Don't exit - keep server running
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('╔═══════════════════════════════════════════════════════════╗');
  console.error('║ UNHANDLED PROMISE REJECTION - Check async error handling ║');
  console.error('╚═══════════════════════════════════════════════════════════╝');
  console.error('Reason:', reason);
  console.error('Promise:', promise);
  console.error('⚠️  Server continuing, but this should be investigated!');
  // Don't exit - keep server running
});

const app: Express = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Initialize WebSocket service for real-time status updates
const wsService = new WebSocketService(server, '/ws');

// Initialize Session Monitor
// In Docker: /clawdbot/sessions is mounted from host ~/.clawdbot/agents/main/sessions
const SESSIONS_PATH = process.env.OPENCLAW_SESSIONS_PATH || '/clawdbot/sessions/sessions.json';
const TRANSCRIPTS_DIR = process.env.OPENCLAW_TRANSCRIPTS_DIR || '/clawdbot/sessions';
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || '/workspace';
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || '/clawdbot/clawdbot.json';
const sessionMonitor = new SessionMonitor(SESSIONS_PATH, TRANSCRIPTS_DIR, wsService);

// Initialize new Phase 3 services
const workspaceWatcher = new WorkspaceWatcher(WORKSPACE_PATH, wsService);
const modelStatusService = new ModelStatusService(SESSIONS_PATH, CONFIG_PATH, wsService);
const controlService = new ControlService(SESSIONS_PATH, CONFIG_PATH);

// Initialize Gateway Connector for message queue monitoring
const gatewayConnector = new GatewayConnector(wsService);

// Initialize Plugin Loader
const PLUGINS_CONFIG = process.env.CLAWBOARD_PLUGINS_CONFIG || './clawboard.plugins.json';
const pluginLoader = new PluginLoader(PLUGINS_CONFIG);

// Initialize Phase 4 Work Monitor
const workMonitor = new WorkMonitor({
  transcriptsDir: TRANSCRIPTS_DIR,
  sessionsPath: SESSIONS_PATH,
  wsService,
  pollIntervalMs: 5000,
  matchThreshold: 0.4,
  autoCreateTasks: false,
});

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(morgan(NODE_ENV === 'development' ? 'dev' : 'combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve media files (screenshots, etc.)
const mediaPath = process.env.NODE_ENV === 'production' ? '/clawdbot/media' : '/home/clawd/.clawdbot/media';
app.use('/media', express.static(mediaPath, {
  maxAge: '1d',
  etag: true
}));

// Serve clawd workspace media (journal images, generated art)
const clawdMediaPath = process.env.NODE_ENV === 'production' ? '/clawd-media' : '/home/clawd/clawd/media';
app.use('/clawd-media', express.static(clawdMediaPath, {
  maxAge: '1d',
  etag: true
}));

// Health check endpoint
app.get('/health', async (_req: Request, res: Response) => {
  try {
    // Check database connection
    const result = await pool.query('SELECT NOW()');
    
    res.json({
      status: 'healthy',
      environment: NODE_ENV,
      timestamp: new Date().toISOString(),
      database: 'connected',
      db_time: result.rows[0].now
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      environment: NODE_ENV,
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// API root
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'ClawBoard API',
    version: '2.0.0',
    environment: NODE_ENV,
    status: 'running'
  });
});

// Routes
import authRoutes from './routes/auth';
import configRoutes from './routes/config';
import statusRoutes from './routes/status';
import tasksRoutes from './routes/tasks';
import memoryRoutes from './routes/memory';
import workspaceRoutes, { setWorkspaceWatcher } from './routes/workspace';
import controlRoutes, { setControlService } from './routes/control';
import modelStatusRoutes, { setModelStatusService } from './routes/modelStatus';
import agentsRoutes from './routes/agents';
import auditRoutes from './routes/audit';
import rateLimitsRoutes from './routes/rateLimits';
import projectsRoutes from './routes/projects';
import botStatusRoutes from './routes/botStatus';
import journalRoutes from './routes/journal';
import filesRoutes from './routes/files';
import toolsRoutes from './routes/tools';
import gatewayRoutes, { setGatewayConnector } from './routes/gateway';
import dashboardRoutes from './routes/dashboard';
import modelsRoutes, { setModelsGatewayConnector } from './routes/models';
import pluginsRoutes, { setPluginLoader } from './routes/plugins';
import { authMiddleware } from './middleware/auth';
import { createPluginProxy } from './middleware/pluginProxy';

// Wire up Phase 3 route dependencies
setWorkspaceWatcher(workspaceWatcher);
setControlService(controlService);
setModelStatusService(modelStatusService);
setGatewayConnector(gatewayConnector);
setModelsGatewayConnector(gatewayConnector);
setPluginLoader(pluginLoader);

// Public routes (no auth required)
app.use('/auth', authRoutes);
app.use('/config', configRoutes);

// Plugin routes (auth required) — registry + theme
app.use('/plugins', authMiddleware, pluginsRoutes);

// Plugin proxy middleware — routes /api/plugins/{name}/* to plugin containers
app.use(authMiddleware, createPluginProxy(pluginLoader));

// Public static file routes (no auth - for <img> tags that can't send headers)
// These serve the actual image files without requiring authentication
const SCREENSHOT_DIR = '/clawdbot/media/browser';
const GENERATED_DIR = '/clawd-media/generated';

app.use('/media/screenshots', express.static(SCREENSHOT_DIR, {
  maxAge: '1d',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}));

app.use('/media/generated', express.static(GENERATED_DIR, {
  maxAge: '7d',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800');
  }
}));

// Protected routes (auth required)
app.use('/status', authMiddleware, statusRoutes);
app.use('/tasks', authMiddleware, tasksRoutes);
app.use('/memory', authMiddleware, memoryRoutes);
app.use('/workspace', authMiddleware, workspaceRoutes);
app.use('/control', authMiddleware, controlRoutes);
app.use('/model-status', authMiddleware, modelStatusRoutes);
app.use('/agents', authMiddleware, agentsRoutes);
app.use('/audit', authMiddleware, auditRoutes);
app.use('/rate-limits', authMiddleware, rateLimitsRoutes);
app.use('/projects', authMiddleware, projectsRoutes);
app.use('/bot-status', authMiddleware, botStatusRoutes);
app.use('/journal', authMiddleware, journalRoutes);
app.use('/projects', authMiddleware, filesRoutes);
app.use('/tools', authMiddleware, toolsRoutes);
app.use('/gateway', authMiddleware, gatewayRoutes);
app.use('/dashboard', authMiddleware, dashboardRoutes);
app.use('/models', authMiddleware, modelsRoutes);
// Note: nginx strips /api/ prefix, so routes are registered without it
// app.use('/approvals', approvalsRoutes);
// app.use('/thoughts', thoughtsRoutes);

// WebSocket connection
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });

  // Real-time updates (will be implemented later)
  socket.on('subscribe', (channel: string) => {
    socket.join(channel);
    console.log(`Client ${socket.id} subscribed to ${channel}`);
  });

  socket.on('unsubscribe', (channel: string) => {
    socket.leave(channel);
    console.log(`Client ${socket.id} unsubscribed from ${channel}`);
  });
});

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: any) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path
  });
});

// Start server
server.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════╗
║   ClawBoard API                   ║
║   Environment: ${NODE_ENV.padEnd(22)}║
║   Port: ${String(PORT).padEnd(30)}║
║   URL: http://localhost:${PORT}       ║
║   WebSocket: ws://localhost:${PORT}/ws    ║
╚═══════════════════════════════════════╝
  `);
  
  // Start session monitoring
  try {
    sessionMonitor.start();
    console.log('✅ Session monitor started');
  } catch (err) {
    console.warn('⚠️  Session monitor failed to start:', (err as Error).message);
    console.warn('   Dashboard will work but session tracking unavailable');
  }
  
  // Start Phase 3 services
  await workspaceWatcher.start();
  console.log('✅ Workspace watcher started');
  
  modelStatusService.start();
  console.log('✅ Model status service started');
  
  // Initialize task manager
  await taskManager.initialize();
  console.log('✅ Task manager initialized');
  
  // Start Phase 4 services
  workMonitor.start();
  console.log('✅ Work monitor started (Phase 4 Step 3)');
  
  taskAnalyzer.initialize();
  console.log('✅ Task analyzer started (Phase 4 Step 4)');
  
  autoArchive.start();
  console.log('✅ Auto-archive started (Phase 4 Step 7)');
  
  subAgentTaskUpdater.start();
  console.log('✅ Sub-agent task updater started (auto-update on session completion)');
  
  gatewayConnector.start();
  console.log('✅ Gateway connector started (message queue monitoring)');
  
  // Initialize plugin system
  await pluginLoader.initialize();
  const pluginCount = pluginLoader.getAllPlugins().length;
  if (pluginCount > 0) {
    console.log(`✅ Plugin system initialized (${pluginCount} plugins loaded)`);
  } else {
    console.log('ℹ️  Plugin system initialized (no plugins configured — core-only mode)');
  }
  
  // Wire up task manager events to WebSocket
  taskManager.on('tasks:updated', (tasks) => {
    wsService.broadcast({ type: 'tasks:updated', tasks });
  });
  
  taskManager.on('task:created', (task) => {
    wsService.broadcast({ type: 'task:created', task });
  });
  
  taskManager.on('task:updated', (task) => {
    wsService.broadcast({ type: 'task:updated', task });
  });
  
  taskManager.on('task:deleted', (id) => {
    wsService.broadcast({ type: 'task:deleted', id });
  });
  
  taskManager.on('task:archived', (id) => {
    wsService.broadcast({ type: 'task:archived', id });
  });
  
  console.log('✅ Task WebSocket events configured');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  
  // Stop session monitor
  sessionMonitor.stop();
  
  // Stop Phase 3 services
  workspaceWatcher.stop();
  modelStatusService.stop();
  
  // Stop Phase 4 services
  workMonitor.stop();
  autoArchive.stop();
  subAgentTaskUpdater.stop();
  gatewayConnector.stop();
  
  // Stop plugin loader
  pluginLoader.stop();
  
  // Stop task manager
  await taskManager.shutdown();
  
  // Shutdown WebSocket
  wsService.shutdown();
  
  // Close HTTP server
  server.close(() => {
    console.log('Server closed');
    pool.end();
    process.exit(0);
  });
});

export { app, server, io };
