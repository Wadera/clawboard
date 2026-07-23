import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { Server as SocketIOServer } from 'socket.io';
import http from 'http';
import dotenv from 'dotenv';
import { pool } from './db/connection';
import { runStartupChecks } from './db/migrate';
import { WebSocketService } from './services/websocket';
import { sessionIngester } from './services/SessionIngester';
import { taskManagerDB as taskManager } from './services/TaskManagerDB';
import { WorkspaceWatcher } from './services/workspaceWatcher';
import { ModelStatusService } from './services/modelStatus';
import { ControlService } from './services/controlService';
import { WorkMonitor } from './services/workMonitor';
import { taskAnalyzer } from './services/taskAnalyzer';
import { autoArchive } from './services/autoArchive';
import { subAgentTaskUpdater } from './services/SubAgentTaskUpdater';
import { discordThreadService } from './services/DiscordThreadService';
import { reviewerHeartbeatService } from './services/ReviewerHeartbeatService';
import { taskOrchestrationService } from './services/TaskOrchestrationService';
import { journalRunNotificationService } from './services/JournalRunNotificationService';
import { loadHardenedOrchestrationConfig } from './config/HardenedOrchestrationConfig';
// TranscriptIngester, RetentionService, BackfillService — DISABLED (Phase 1: session_messages table dropped)
// import { transcriptIngester } from './services/TranscriptIngester';
// import { retentionService } from './services/RetentionService';
// import { backfillService } from './services/BackfillService';
import { GatewayConnector } from './services/GatewayConnector';
import { PluginLoader } from './services/PluginLoader';
import { VoiceService } from './services/VoiceService';
import voiceRoutes, { setVoiceService } from './routes/voice';

// Load environment variables
dotenv.config();
const hardenedOrchestrationConfig = loadHardenedOrchestrationConfig();

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

// Path constants used across services
const SESSIONS_PATH = process.env.OPENCLAW_SESSIONS_PATH || process.env.CLAWDBOT_SESSIONS_PATH || '/clawdbot/sessions/sessions.json';
const TRANSCRIPTS_DIR = process.env.OPENCLAW_TRANSCRIPTS_DIR || process.env.CLAWDBOT_TRANSCRIPTS_DIR || '/clawdbot/sessions';
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || '/workspace';
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || process.env.CLAWDBOT_CONFIG_PATH || '/clawdbot/clawdbot.json';

// Initialize new Phase 3 services
const workspaceWatcher = new WorkspaceWatcher(WORKSPACE_PATH, wsService);
const modelStatusService = new ModelStatusService(SESSIONS_PATH, CONFIG_PATH, wsService);
const controlService = new ControlService(SESSIONS_PATH, CONFIG_PATH);

// Initialize Gateway Connector for message queue monitoring
const gatewayConnector = new GatewayConnector(wsService);

// Initialize Plugin Loader
const PLUGINS_CONFIG = process.env.CLAWBOARD_PLUGINS_CONFIG || './clawboard.plugins.json';
const pluginLoader = new PluginLoader(PLUGINS_CONFIG);

// Initialize Voice Service
const voiceService = new VoiceService(server);

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
const mediaPath = process.env.NODE_ENV === 'production' ? '/clawdbot/media' : '/tmp/clawdbot-media';
app.use('/media', express.static(mediaPath, {
  maxAge: '1d',
  etag: true
}));

// Serve clawd workspace media (journal images, generated art)
const clawdMediaPath = process.env.CLAWD_MEDIA_ROOT || (process.env.NODE_ENV === 'production' ? '/clawd-media' : '/tmp/clawd-media');
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
import tasksRoutes, { setTasksGatewayConnector } from './routes/tasks';
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
import sessionsRoutes, { listHermesSessionRows, rowToSession, setSessionsGatewayConnector } from './routes/sessionsApi';
import toolsRoutes from './routes/tools';
import agentTypesRoutes from './routes/agentTypes';
import gatewayRoutes, { setGatewayConnector } from './routes/gateway';
import dashboardRoutes from './routes/dashboard';
import modelsRoutes, { setModelsGatewayConnector, setModelStatusService as setModelsModelStatusService } from './routes/models';
import pluginsRoutes, { setPluginLoader } from './routes/plugins';
import imagesRoutes from './routes/images';
import reportsRoutes from './routes/reports';
import contentEngineRoutes from './routes/contentEngine';
import secondBrainRoutes, { qdrantForwardAuthHandler } from './routes/secondBrain';
import journalPublicationMediaRoutes from './routes/journalPublicationMedia';
import litellmAdminRoutes from './routes/litellmAdmin';
import { authMiddleware } from './middleware/auth';
import webhooksRoutes from './routes/webhooks';
import tasksBatchRoutes from './routes/tasksBatch';
import { buildOpenApiSpec } from './openapi/spec';
import { apiErrorHandler } from './utils/apiErrors';
import { webhookService } from './services/WebhookService';
import { createPluginProxy } from './middleware/pluginProxy';

// Wire up Phase 3 route dependencies
setWorkspaceWatcher(workspaceWatcher);
setControlService(controlService);
setModelStatusService(modelStatusService);
setGatewayConnector(gatewayConnector);
setModelsGatewayConnector(gatewayConnector);
setModelsModelStatusService(modelStatusService);
setTasksGatewayConnector(gatewayConnector);
setSessionsGatewayConnector(gatewayConnector);
subAgentTaskUpdater.setGatewayConnector(gatewayConnector);
discordThreadService.setGatewayConnector(gatewayConnector);
setPluginLoader(pluginLoader);

// Public static file routes (MUST be before auth middleware)
// These serve image files without authentication - <img> tags can't send JWT headers
const SCREENSHOT_DIR = '/clawdbot/media/browser';
const GENERATED_DIR = '/clawd-media/generated';

app.use('/media/screenshots', express.static(SCREENSHOT_DIR, {
  maxAge: '1d',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}));

// Hermes status portraits are private dashboard media. Their stored path is an
// opaque receipt only; bytes are served through authenticated /nim-status/:id/avatar.
app.use('/media/generated/hermes-status', (_req, res) => res.status(404).type('text').send('Not found'));

app.use('/media/generated', express.static(GENERATED_DIR, {
  maxAge: '7d',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800');
  }
}));

// Public routes (no auth required)
app.use('/auth', authRoutes);
app.use('/config', configRoutes);

// Plugin proxy middleware — public, MUST be before /plugins auth route
// Iframes can't send JWT headers, so plugin content must be unauthenticated
app.use(createPluginProxy(pluginLoader));

// Plugin routes — registry needs auth (list plugins, theme CSS)
app.use('/plugins', authMiddleware, pluginsRoutes);

// Public historical image/narration bytes are served only through a ledger
// checksum verifier. Private Mindscape audio remains authenticated elsewhere.
app.use('/journal-publication-media', journalPublicationMediaRoutes);

// Protected routes (auth required)
app.use('/status', authMiddleware, statusRoutes);
app.use('/tasks', authMiddleware, tasksBatchRoutes); // /tasks/batch must match before /tasks/:id
app.use('/tasks', authMiddleware, tasksRoutes);
app.use('/webhooks', authMiddleware, webhooksRoutes);
app.get('/openapi.json', authMiddleware, (_req, res) => res.json(buildOpenApiSpec()));
app.use('/memory', authMiddleware, memoryRoutes);
app.use('/workspace', authMiddleware, workspaceRoutes);
app.use('/control', authMiddleware, controlRoutes);
app.use('/model-status', authMiddleware, modelStatusRoutes);
app.use('/agents', authMiddleware, agentsRoutes);
app.use('/audit', authMiddleware, auditRoutes);
app.use('/rate-limits', authMiddleware, rateLimitsRoutes);
app.use('/projects', authMiddleware, projectsRoutes);
app.use('/nim-status', authMiddleware, botStatusRoutes);
app.use('/bot-status', authMiddleware, botStatusRoutes);
app.use('/journal', authMiddleware, journalRoutes);
app.use('/projects', authMiddleware, filesRoutes);
app.use('/tools', authMiddleware, toolsRoutes);
app.use('/agent-types', authMiddleware, agentTypesRoutes);
app.use('/gateway', authMiddleware, gatewayRoutes);
app.use('/dashboard', authMiddleware, dashboardRoutes);
app.use('/models', authMiddleware, modelsRoutes);
app.use('/litellm', authMiddleware, litellmAdminRoutes);
app.use('/images', authMiddleware, imagesRoutes);
app.use('/sessions', authMiddleware, sessionsRoutes);
app.use('/reports', authMiddleware, reportsRoutes);
app.use('/content-engine', authMiddleware, contentEngineRoutes);
app.use('/second-brain', authMiddleware, secondBrainRoutes);
// traefik forwardAuth for the Qdrant UI subdomain — cookie-verified, deliberately
// outside authMiddleware (see routes/secondBrain.ts qdrantForwardAuthHandler)
app.get('/second-brain-public/qdrant-auth', qdrantForwardAuthHandler);
app.use('/voice', authMiddleware, voiceRoutes);
app.use(apiErrorHandler); // must stay after all routes: normalizes uncaught errors to the API envelope
// Wire voice service
setVoiceService(voiceService);
webhookService.start();
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

// Pre-initialize plugin loader before server starts so /plugins is ready on first request
pluginLoader.initialize().then(() => {
  const pluginCount = pluginLoader.getAllPlugins().length;
  if (pluginCount > 0) {
    console.log(`✅ Plugin system pre-initialized (${pluginCount} plugins loaded)`);
  } else {
    console.log('ℹ️  Plugin system pre-initialized (no plugins configured — core-only mode)');
  }
}).catch((err: Error) => {
  console.warn('⚠️  Plugin system pre-init failed (non-fatal):', err.message);
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

  // Schema/migration consistency check (task 475a54c9) — logs a loud warning
  // on ledger-vs-directory drift or missing critical tables; never crashes.
  await runStartupChecks();

  // Start SessionIngester — unified session metadata service.
  // Replaces old SessionMonitor + SessionIndexer.
  try {
    await sessionIngester.start();
    console.log('✅ Session ingester started (Phase 2)');

    // Wire session:live-state → simplified status-update WS broadcast (legacy compat)
    // + Phase 4: sessions:updated event so the new sessions panel stays live
    sessionIngester.on('session:live-state', ({ sessionKey, isActive }: { sessionKey: string; sessionId: string; isActive: boolean }) => {
      const isMainSession = sessionKey.endsWith(':main') || sessionKey === 'agent:main:main';

      // Legacy status-update: only update main state when it's actually the main session's lock
      if (isMainSession) {
        wsService.broadcast({
          type: 'status-update',
          data: {
            main: {
              state: isActive ? 'waiting' : 'idle',
              detail: isActive ? 'Active conversation' : 'Idle',
              tools: [],
            },
            agents: [],
            agentCount: 0,
            stats: { messageCount: 0, toolsUsed: 0 },
            timestamp: Date.now(),
          },
          timestamp: Date.now(),
        });
      }
      // Phase 4: notify clients that a session's live state changed
      wsService.broadcast({
        type: 'sessions:updated',
        sessionKey,
        liveState: {
          state: isActive ? 'busy' : 'idle',
          isGenerating: isActive,
        },
        timestamp: Date.now(),
      });
    });

    // Phase 4: sessions:updated when session metadata is ingested/updated
    sessionIngester.on('session:upserted', ({ sessionKey }: { sessionKey: string }) => {
      wsService.broadcast({
        type: 'sessions:updated',
        sessionKey,
        timestamp: Date.now(),
      });
    });

    // Phase 4: sessions:completed when session is archived
    sessionIngester.on('session:completed', ({ sessionKey }: { sessionKey: string }) => {
      wsService.broadcast({
        type: 'sessions:completed',
        sessionKey,
        timestamp: Date.now(),
      });
    });
  } catch (err: any) {
    console.warn(`⚠️ Session ingester failed to start (${err.code || err.message}). Session metadata unavailable.`);
  }
  
  // Start Phase 3 services
  try {
    await workspaceWatcher.start();
    console.log('✅ Workspace watcher started');
  } catch (err: any) {
    console.warn(`⚠️ Workspace watcher failed to start: ${err.message}`);
  }
  
  try {
    await modelStatusService.start();
    console.log('✅ Model status service started');
  } catch (err: any) {
    console.warn(`⚠️ Model status service failed to start (${err.code || err.message}). Model info unavailable.`);
  }
  
  // Initialize task manager
  try {
    await taskManager.initialize();
    console.log('✅ Task manager initialized');
  } catch (err: any) {
    console.warn(`⚠️ Task manager failed to initialize (${err.code || err.message}). Task features unavailable.`);
  }
  
  // Start Phase 4 services
  workMonitor.start();
  console.log('✅ Work monitor started (Phase 4 Step 3)');
  
  taskAnalyzer.initialize();
  console.log('✅ Task analyzer started (Phase 4 Step 4)');
  
  autoArchive.start();
  console.log('✅ Auto-archive started (Phase 4 Step 7)');
  
  subAgentTaskUpdater.start();
  console.log('✅ Sub-agent task updater started (auto-update on session completion)');

  console.log('[OrchestrationConfig]', {
    reviewerHeartbeatEnabled: hardenedOrchestrationConfig.reviewerHeartbeatEnabled,
    reviewerHeartbeatIntervalMs: hardenedOrchestrationConfig.reviewerHeartbeatIntervalMs,
    reviewTimeoutMs: hardenedOrchestrationConfig.reviewTimeoutMs,
    hardenedOrchestrationEnabled: hardenedOrchestrationConfig.hardenedOrchestrationEnabled,
    maxActiveGlobal: hardenedOrchestrationConfig.maxActiveGlobal,
    maxActivePerProject: hardenedOrchestrationConfig.maxActivePerProject,
    leaseTtlMs: hardenedOrchestrationConfig.leaseTtlMs,
    hermesQaRepoConfigured: Boolean(hardenedOrchestrationConfig.hermesQaRepo),
  });
  taskOrchestrationService.configure({
    enabled: hardenedOrchestrationConfig.hardenedOrchestrationEnabled,
    maxActiveGlobal: hardenedOrchestrationConfig.maxActiveGlobal,
    maxActivePerProject: hardenedOrchestrationConfig.maxActivePerProject,
    leaseTtlSeconds: Math.floor(hardenedOrchestrationConfig.leaseTtlMs / 1000),
  });
  reviewerHeartbeatService.configure(
    hardenedOrchestrationConfig.reviewerHeartbeatIntervalMs,
    hardenedOrchestrationConfig.reviewerHeartbeatStateFile,
  );

  if (hardenedOrchestrationConfig.reviewerHeartbeatEnabled) {
    reviewerHeartbeatService.start();
    console.log('✅ Reviewer heartbeat started (bounded structured review for review tasks)');
  } else {
    console.log('⏸️ Reviewer heartbeat disabled (fail-closed rollout default)');
  }

  journalRunNotificationService.start();
  console.log('✅ Journal lifecycle notifier initialized');

  // Sync agent types from local agency-agents clone on startup
  try {
    const { agentTypeService } = await import('./services/AgentTypeService');
    const syncResult = await agentTypeService.syncFromRepo();
    console.log(`✅ Agent types synced (${syncResult.synced} types, ${syncResult.errors} errors)`);
  } catch (err) {
    console.warn('⚠️  Agent type sync skipped (non-fatal):', err instanceof Error ? err.message : err);
  }
  
  gatewayConnector.start();
  console.log('✅ Gateway connector started (message queue monitoring)');

  // Wire GatewayConnector session:ended → SessionIngester DB completion
  // When the gateway detects a session has definitively ended (cron:finished,
  // chat:final for ephemeral sessions), update the DB status to 'completed'.
  gatewayConnector.on('session:ended', async ({ sessionKey, reason }: any) => {
    try {
      const result = await pool.query(
        `UPDATE sessions
         SET status = 'completed', ended_at = COALESCE(ended_at, NOW()), updated_at = NOW()
         WHERE session_key = $1 AND status != 'completed'`,
        [sessionKey]
      );
      if ((result.rowCount ?? 0) > 0) {
        console.log(`📦 session:ended → marked completed: ${sessionKey} (reason: ${reason})`);
        // Notify dashboard clients
        wsService.broadcast({
          type: 'sessions:updated',
          sessionKey,
          timestamp: Date.now(),
        });
      }
    } catch (err: any) {
      console.error(`❌ session:ended handler failed for ${sessionKey}:`, err.message);
    }
  });

  // Phase 4: wire sessions:snapshot provider to WebSocket service.
  // On connect and every 30s, broadcast the current session list with live state overlay.
  wsService.setSnapshotProvider(async () => {
    try {
      // Always include main session + top 200 by activity (UNION deduplicates)
      const result = await pool.query(
        `(SELECT session_key, session_id, kind, label, model, channel, status,
                 spawn_info, message_count, tool_call_count,
                 input_tokens, output_tokens, thinking_tokens, total_cost_usd,
                 started_at, ended_at, last_activity_at, transcript_path, file_size
          FROM sessions
          WHERE session_key = 'agent:main:main')
         UNION ALL
         (SELECT session_key, session_id, kind, label, model, channel, status,
                 spawn_info, message_count, tool_call_count,
                 input_tokens, output_tokens, thinking_tokens, total_cost_usd,
                 started_at, ended_at, last_activity_at, transcript_path, file_size
          FROM sessions s
          WHERE session_key != 'agent:main:main'
            -- Exclude cron parent stubs that have :run: children (avoid duplicates)
            AND NOT (s.kind = 'cron' AND s.session_key NOT LIKE '%:run:%'
                     AND EXISTS (SELECT 1 FROM sessions c
                                 WHERE c.session_key LIKE s.session_key || ':run:%'))
          ORDER BY last_activity_at DESC NULLS LAST
          LIMIT 200)`
      );
      const sessions = result.rows.map((row: any) => rowToSession(row));
      const hermesSessions = (await listHermesSessionRows()).map((row: any) => rowToSession(row));
      const mergedByKey = new Map<string, any>();
      for (const session of [...sessions, ...hermesSessions]) {
        mergedByKey.set(session.sessionKey, session);
      }
      return Array.from(mergedByKey.values());
    } catch (err) {
      console.error('[snapshot] Failed to build sessions snapshot:', err);
      return [];
    }
  });
  console.log('✅ Phase 4: WebSocket sessions:snapshot provider registered');
  // TranscriptIngester DISABLED — session_messages table dropped in migration 033.
  // SessionIngester (Phase 2) now handles all session metadata from JSONL files.
  console.log('ℹ️  TranscriptIngester disabled (session_messages dropped, Phase 2 ingester active)');

  // Phase 5: Retention + Backfill + Materialized View — ALL DISABLED
  // session_messages table dropped in migration 033. No retention/backfill/matview needed.
  // SessionIngester (Phase 2) handles all session metadata from JSONL files directly.
  console.log('ℹ️  Retention, backfill, and matview refresh disabled (session_messages dropped)');


  
  // Plugin system is pre-initialized before server.listen() — no double-init needed here.

  // Helper: enrich a task with computed dependency fields for WS broadcast.
  // getTask() in TaskManagerDB always returns blockedBy: [] without computing it —
  // this function adds the real blocked/blockingTasks/dependentTasks fields so the
  // frontend can reactively update the locked/greyed visual state without a refresh.
  async function enrichTaskWithDeps(task: any): Promise<any> {
    try {
      const [blocked, blockingTasks, dependentTasks] = await Promise.all([
        taskManager.isTaskBlocked(task.id),
        taskManager.getBlockingTasks(task.id),
        taskManager.getDependentTasks(task.id),
      ]);
      return {
        ...task,
        blocked,
        blockingTasks: blockingTasks.map((t: any) => ({ id: t.id, title: t.title })),
        dependentTasks: dependentTasks.map((t: any) => ({ id: t.id, title: t.title })),
      };
    } catch (err) {
      console.error('[WS] Failed to enrich task deps for task', task.id, ':', err);
      return task;
    }
  }

  // Wire up task manager events to WebSocket
  taskManager.on('tasks:updated', (tasks) => {
    wsService.broadcast({ type: 'tasks:updated', tasks });
  });
  
  taskManager.on('task:created', async (task) => {
    const enriched = await enrichTaskWithDeps(task);
    wsService.broadcast({ type: 'task:created', task: enriched });
  });
  
  taskManager.on('task:updated', async (task) => {
    // Enrich the updated task with computed dependency state
    const enriched = await enrichTaskWithDeps(task);
    wsService.broadcast({ type: 'task:updated', task: enriched });

    // Cascade: also emit updates for tasks that depend on this task.
    // Their blocked state may have changed — e.g. this task was just completed
    // (unblocking dependents) or a new dependency was added (blocking a dependent).
    // Without this, dependent tasks only update on a full page refresh.
    try {
      const dependentTasks = await taskManager.getDependentTasks(task.id);
      for (const depTask of dependentTasks) {
        const enrichedDep = await enrichTaskWithDeps(depTask);
        wsService.broadcast({ type: 'task:updated', task: enrichedDep });
      }
    } catch (err) {
      console.error('[WS] Failed to cascade dep updates from task', task.id, ':', err);
    }

    // Cascade: also emit updates for tasks that THIS task depends on.
    // Their dependentTasks list may have changed — e.g. when B.dependsOn=[A] is updated,
    // A's "Blocks N tasks" badge should update immediately without a refresh.
    try {
      if (task.dependsOn && task.dependsOn.length > 0) {
        for (const blockerId of task.dependsOn) {
          const blockerTask = await taskManager.getTask(blockerId);
          if (blockerTask) {
            const enrichedBlocker = await enrichTaskWithDeps(blockerTask);
            wsService.broadcast({ type: 'task:updated', task: enrichedBlocker });
          }
        }
      }
    } catch (err) {
      console.error('[WS] Failed to cascade blocker updates for task', task.id, ':', err);
    }
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
  
  // Stop session ingester (replaces old SessionMonitor + SessionIndexer)
  sessionIngester.stop();
  journalRunNotificationService.stop();
  
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
  
  // Shutdown WebSocket (includes stopping snapshot timer)
  wsService.shutdown();
  
  // Close HTTP server
  server.close(() => {
    console.log('Server closed');
    pool.end();
    process.exit(0);
  });
});

export { app, server, io };
