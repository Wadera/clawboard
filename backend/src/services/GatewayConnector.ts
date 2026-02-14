import WebSocket from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { WebSocketService } from './websocket';

const HISTORY_FILE = join(process.env.DATA_DIR || '/app/data', 'session-history.json');
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface GatewaySession {
  key: string;
  sessionId: string;
  displayName?: string;
  label?: string;
  channel?: string;
  updatedAt: number;
  totalTokens: number;
  model: string;
  contextTokens: number;
  kind: string;
  chatType?: string;
  origin?: {
    label?: string;
    provider?: string;
    surface?: string;
    from?: string;
    to?: string;
  };
}

interface SessionQueueState {
  sessionKey: string;
  sessionId: string;
  displayName: string;
  label: string;
  channel: string;
  state: 'idle' | 'busy' | 'thinking' | 'tool-use' | 'typing';
  lastActivity: number;
  lastMessage?: {
    role: string;
    preview: string;
    timestamp: number;
  };
  recentTools: Array<{
    name: string;
    input?: string;
    output?: string;
    timestamp: number;
    status: 'running' | 'done';
  }>;
  model: string;
  tokenUsage: {
    total: number;
    context: number;
    percentUsed: number;
  };
  kind: string;
  runId?: string;
}

interface QueueSnapshot {
  sessions: SessionQueueState[];
  activeSessions: number;
  totalSessions: number;
  timestamp: number;
  connected: boolean;
}

export class GatewayConnector {
  private ws: WebSocket | null = null;
  private wsService: WebSocketService;
  private gatewayUrl: string;
  private gatewayPassword: string;
  private connected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private requestId: number = 0;
  private sessionStates: Map<string, SessionQueueState> = new Map();
  private historicalSessions: Array<{
    sessionId: string;
    label: string;
    channel: string;
    completedAt: number;
    startedAt: number;
    durationMs: number;
    model: string;
    tokenUsage: { total: number; context: number; percentUsed: number };
    kind: string;
  }> = [];
  private pendingRequests: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = new Map();
  private requestQueue: Array<{ method: string; params: any; resolve: (data: any) => void; reject: (err: Error) => void; retries: number }> = [];

  constructor(wsService: WebSocketService) {
    this.wsService = wsService;

    // Read gateway config
    this.gatewayUrl = process.env.OPENCLAW_GATEWAY_WS_URL || 'ws://127.0.0.1:18789';
    this.gatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD || '';

    // Try to read password from config file if not in env
    if (!this.gatewayPassword) {
      try {
        const configPath = process.env.OPENCLAW_CONFIG_PATH || '/clawdbot/clawdbot.json';
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        this.gatewayPassword = config?.gateway?.auth?.password || config?.gateway?.auth?.token || '';
        if (this.gatewayPassword) {
          console.log('🔑 GatewayConnector: Read gateway auth from config');
        }
      } catch (err) {
        console.warn('⚠️  GatewayConnector: Could not read gateway password from config');
      }
    }

    // Load persisted session history
    this.loadHistory();
  }

  /**
   * Start the gateway connector
   */
  public start(): void {
    console.log('🔌 GatewayConnector: Starting...');
    console.log(`   Gateway URL: ${this.gatewayUrl}`);
    this.connect();
  }

  /**
   * Stop the gateway connector
   */
  public stop(): void {
    console.log('🔌 GatewayConnector: Stopping...');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * Get current queue snapshot
   */
  public getQueueSnapshot(): QueueSnapshot & { historicalSessions: any[] } {
    const sessions = Array.from(this.sessionStates.values());
    const activeSessions = sessions.filter(s => s.state !== 'idle').length;

    return {
      sessions,
      activeSessions,
      totalSessions: sessions.length,
      timestamp: Date.now(),
      connected: this.connected,
      historicalSessions: this.historicalSessions,
    };
  }

  public getHistoricalSessions() {
    return this.historicalSessions;
  }

  /**
   * Load persisted session history from disk
   */
  private loadHistory(): void {
    try {
      if (!existsSync(HISTORY_FILE)) {
        console.log('📝 GatewayConnector: No history file found, starting fresh');
        return;
      }

      const data = readFileSync(HISTORY_FILE, 'utf-8');
      const loaded = JSON.parse(data);

      if (Array.isArray(loaded)) {
        // Filter out entries older than 24h
        const cutoff = Date.now() - HISTORY_TTL_MS;
        this.historicalSessions = loaded.filter(h => h.completedAt > cutoff);
        console.log(`📝 GatewayConnector: Loaded ${this.historicalSessions.length} historical sessions (${loaded.length - this.historicalSessions.length} expired)`);
      }
    } catch (err) {
      console.error('⚠️  GatewayConnector: Failed to load history, starting fresh:', err);
      this.historicalSessions = [];
    }
  }

  /**
   * Persist session history to disk
   */
  private saveHistory(): void {
    try {
      const data = JSON.stringify(this.historicalSessions, null, 2);
      writeFileSync(HISTORY_FILE, data, 'utf-8');
    } catch (err) {
      console.error('⚠️  GatewayConnector: Failed to save history:', err);
    }
  }

  /**
   * Connect to the gateway WebSocket
   */
  private connect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    try {
      this.ws = new WebSocket(this.gatewayUrl);

      this.ws.on('open', () => {
        console.log('🔌 GatewayConnector: WebSocket connected');
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          console.error('GatewayConnector: Failed to parse message:', err);
        }
      });

      this.ws.on('close', () => {
        console.log('🔌 GatewayConnector: WebSocket disconnected');
        this.connected = false;
        
        // Reject all pending requests since connection is lost
        for (const pending of this.pendingRequests.values()) {
          clearTimeout(pending.timer);
          // We don't have method/params info for pending requests, so we just reject them
          // The caller should retry if needed
          pending.reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();
        
        this.scheduleReconnect();
      });

      this.ws.on('error', (err: Error) => {
        console.error('GatewayConnector: WebSocket error:', err.message);
        this.connected = false;
      });
    } catch (err) {
      console.error('GatewayConnector: Connection failed:', err);
      this.scheduleReconnect();
    }
  }

  /**
   * Handle incoming gateway messages
   */
  private handleMessage(msg: any): void {
    // Handle challenge-response auth
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      this.authenticate();
      return;
    }

    // Handle responses to our requests
    if (msg.type === 'res') {
      const pending = this.pendingRequests.get(String(msg.id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(String(msg.id));
        if (msg.ok) {
          pending.resolve(msg.payload);
        } else {
          pending.reject(new Error(msg.error?.message || 'Request failed'));
        }
        return;
      }

      // Auth response (id: 'auth')
      if (msg.id === 'auth') {
        if (msg.ok) {
          console.log('✅ GatewayConnector: Authenticated with gateway');
          this.connected = true;
          this.onConnected();
        } else {
          console.error('❌ GatewayConnector: Auth failed:', msg.error?.message);
          this.connected = false;
        }
        return;
      }
    }

    // Handle streaming events
    if (msg.type === 'event') {
      this.handleEvent(msg);
    }
  }

  /**
   * Authenticate with the gateway
   */
  private authenticate(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      type: 'req',
      id: 'auth',
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: 'cli', version: '1.0.0', platform: 'linux', mode: 'backend' },
        role: 'operator',
        scopes: ['operator.read', 'operator.admin'],
        caps: [],
        commands: [],
        permissions: {},
        auth: { password: this.gatewayPassword, token: this.gatewayPassword },
        locale: 'en-US',
        userAgent: 'clawboard-backend/1.0.0',
      },
    }));
  }

  /**
   * Called after successful auth
   */
  private onConnected(): void {
    // Fetch initial session list
    this.fetchSessions();

    // Poll sessions periodically (every 15s) for state updates
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      this.fetchSessions();
    }, 15000);

    // Process queued requests
    this.processRequestQueue();
  }

  /**
   * Process any queued requests after reconnection
   */
  private processRequestQueue(): void {
    const queue = [...this.requestQueue];
    this.requestQueue = [];
    
    for (const queuedRequest of queue) {
      console.log(`🔄 GatewayConnector: Processing queued request: ${queuedRequest.method}`);
      this.sendRequestInternal(queuedRequest.method, queuedRequest.params, queuedRequest.retries)
        .then(queuedRequest.resolve)
        .catch(queuedRequest.reject);
    }
  }

  /**
   * Send a request to the gateway and get a promise for the response
   */
  public sendGatewayRequest(method: string, params?: any): Promise<any> {
    return this.sendRequestInternal(method, params, 0);
  }

  private sendRequest(method: string, params?: any): Promise<any> {
    return this.sendRequestInternal(method, params, 0);
  }

  private sendRequestInternal(method: string, params?: any, retries: number = 0): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        // Queue request if disconnected and we haven't exceeded retry limit
        if (retries < 3) {
          console.log(`⏳ GatewayConnector: Queueing request (${method}) - not connected (attempt ${retries + 1})`);
          this.requestQueue.push({ method, params, resolve, reject, retries: retries + 1 });
          
          // Trigger reconnect if not already scheduled
          if (!this.reconnectTimer && !this.connected) {
            this.scheduleReconnect();
          }
        } else {
          reject(new Error('Not connected and retry limit exceeded'));
        }
        return;
      }

      const id = String(++this.requestId);
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        
        // Retry on timeout if we haven't exceeded retry limit
        if (retries < 3) {
          console.log(`⏳ GatewayConnector: Retrying request (${method}) after timeout (attempt ${retries + 2})`);
          this.sendRequestInternal(method, params, retries + 1)
            .then(resolve)
            .catch(reject);
        } else {
          reject(new Error('Request timeout'));
        }
      }, 10000);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const req: any = { type: 'req', id, method };
      if (params) req.params = params;
      this.ws.send(JSON.stringify(req));
    });
  }

  /**
   * Abort a running session
   */
  public async abortSession(sessionKey: string): Promise<any> {
    try {
      const result = await this.sendRequest('chat.abort', { sessionKey });
      console.log(`✅ GatewayConnector: Aborted session ${sessionKey}`);
      return result;
    } catch (err) {
      console.error(`❌ GatewayConnector: Failed to abort session ${sessionKey}:`, err);
      throw err;
    }
  }

  /**
   * Fetch sessions list from gateway
   */
  private async fetchSessions(): Promise<void> {
    try {
      const payload = await this.sendRequest('sessions.list');
      const sessions: GatewaySession[] = payload.sessions || [];

      // Update session states
      const now = Date.now();
      const updatedKeys = new Set<string>();

      for (const session of sessions) {
        updatedKeys.add(session.key);
        const existing = this.sessionStates.get(session.key);
        const timeSinceUpdate = now - session.updatedAt;

        // Determine state based on activity
        let state: SessionQueueState['state'] = 'idle';
        if (existing?.state && existing.state !== 'idle' && timeSinceUpdate < 30000) {
          // Keep the streaming-detected state if recent
          state = existing.state;
        } else if (timeSinceUpdate < 5000) {
          state = 'busy';
        }

        const displayName = session.label || session.displayName || session.key;
        const channel = session.origin?.provider || session.channel || 'unknown';

        // Override model for heartbeat sessions (gateway reports agent default, not per-session model)
        // Both the heartbeat poller and the heartbeat-refresh cron use phi4
        let model = session.model || 'unknown';
        if (session.key.includes(':heartbeat')) {
          model = 'phi4';
        } else if (session.key.includes(':cron:') && displayName.toLowerCase().includes('heartbeat')) {
          model = 'phi4';
        }

        this.sessionStates.set(session.key, {
          sessionKey: session.key,
          sessionId: session.sessionId,
          displayName,
          label: session.label || this.extractLabel(session.key),
          channel,
          state,
          lastActivity: session.updatedAt,
          lastMessage: existing?.lastMessage,
          recentTools: existing?.recentTools || [],
          model,
          tokenUsage: {
            total: session.totalTokens || 0,
            context: session.contextTokens || 200000,
            percentUsed: session.contextTokens
              ? Math.round((session.totalTokens / session.contextTokens) * 100)
              : 0,
          },
          kind: session.kind || 'direct',
          runId: existing?.runId,
        });
      }

      // Remove sessions that no longer exist — move to historical
      for (const [key, session] of this.sessionStates.entries()) {
        if (!updatedKeys.has(key)) {
          // Move to historical
          this.historicalSessions.unshift({
            sessionId: session.sessionId,
            label: session.label,
            channel: session.channel,
            completedAt: Date.now(),
            startedAt: session.lastActivity,
            durationMs: Date.now() - session.lastActivity,
            model: session.model,
            tokenUsage: session.tokenUsage,
            kind: session.kind,
          });
          // Keep only last 24h / max 50
          const cutoff = Date.now() - 24 * 60 * 60 * 1000;
          this.historicalSessions = this.historicalSessions
            .filter(h => h.completedAt > cutoff)
            .slice(0, 50);
          this.saveHistory();
          this.sessionStates.delete(key);
        }
      }

      // Broadcast update
      this.broadcastQueueUpdate();
    } catch (err) {
      console.error('GatewayConnector: Failed to fetch sessions:', err);
    }
  }

  /**
   * Handle gateway events (streaming agent activity)
   */
  private handleEvent(msg: any): void {
    const { event, payload } = msg;

    if (event === 'agent' && payload?.sessionKey) {
      const session = this.sessionStates.get(payload.sessionKey);
      if (session) {
        const stream = payload.stream;
        let newState: SessionQueueState['state'] = 'busy';

        if (stream === 'thinking') {
          newState = 'thinking';
        } else if (stream === 'assistant') {
          newState = 'typing';
        } else if (stream === 'tool_call' || stream === 'tool_result') {
          newState = 'tool-use';
        }

        session.state = newState;
        session.lastActivity = payload.ts || Date.now();
        session.runId = payload.runId;

        if (payload.data?.text && stream === 'assistant') {
          session.lastMessage = {
            role: 'assistant',
            preview: (payload.data.text as string).substring(0, 200),
            timestamp: payload.ts || Date.now(),
          };
        }

        // Capture tool calls
        if (stream === 'tool_call' && payload.data) {
          const toolName = payload.data.name || payload.data.tool || 'unknown';
          const toolInput = payload.data.input || payload.data.command || payload.data.url || '';
          // Summarize input for display
          let inputPreview = '';
          if (typeof toolInput === 'string') {
            inputPreview = toolInput.substring(0, 300);
          } else if (typeof toolInput === 'object') {
            // Extract key fields for common tools
            const inp = toolInput as Record<string, any>;
            if (inp.command) inputPreview = `$ ${inp.command}`.substring(0, 300);
            else if (inp.url || inp.targetUrl) inputPreview = inp.url || inp.targetUrl;
            else if (inp.file_path || inp.path) inputPreview = inp.file_path || inp.path;
            else if (inp.query) inputPreview = inp.query;
            else if (inp.action) inputPreview = inp.action;
            else inputPreview = JSON.stringify(inp).substring(0, 200);
          }
          session.recentTools = session.recentTools || [];
          session.recentTools.push({
            name: toolName,
            input: inputPreview,
            timestamp: payload.ts || Date.now(),
            status: 'running',
          });
          // Keep only last 10 tools
          if (session.recentTools.length > 10) {
            session.recentTools = session.recentTools.slice(-10);
          }
          // Update lastMessage to show tool activity
          session.lastMessage = {
            role: 'tool_use',
            preview: `${toolName}: ${inputPreview}`.substring(0, 200),
            timestamp: payload.ts || Date.now(),
          };
        }

        // Capture tool results
        if (stream === 'tool_result' && payload.data) {
          const tools = session.recentTools || [];
          const lastTool = [...tools].reverse().find((t: any) => t.status === 'running');
          if (lastTool) {
            lastTool.status = 'done';
            const resultText = payload.data.text || payload.data.output || '';
            if (typeof resultText === 'string') {
              lastTool.output = resultText.substring(0, 500);
            }
          }
        }

        this.broadcastQueueUpdate();
      }
    }

    if (event === 'chat' && payload?.sessionKey) {
      const session = this.sessionStates.get(payload.sessionKey);
      if (session && payload.state === 'done') {
        session.state = 'idle';
        session.runId = undefined;
        this.broadcastQueueUpdate();
      }
    }

    // Session state transitions
    if (event === 'session.state.change' && payload?.sessionKey) {
      const session = this.sessionStates.get(payload.sessionKey);
      if (session) {
        session.state = payload.state === 'idle' ? 'idle' : 'busy';
        this.broadcastQueueUpdate();
      }
    }
  }

  /**
   * Broadcast queue state update to dashboard clients
   */
  private broadcastQueueUpdate(): void {
    const snapshot = this.getQueueSnapshot();
    this.wsService.broadcast({
      type: 'gateway:queue-update',
      data: snapshot,
      timestamp: Date.now(),
    });
  }

  /**
   * Extract a human-readable label from session key
   */
  private extractLabel(key: string): string {
    // agent:main:main -> Main Session
    // agent:main:subagent:xxx -> Sub-agent
    // agent:main:heartbeat -> Heartbeat
    const parts = key.split(':');
    if (parts.includes('heartbeat')) return 'Heartbeat';
    if (parts.includes('subagent')) return 'Sub-agent';
    if (parts[parts.length - 1] === 'main') return 'Main Session';
    return parts[parts.length - 1] || key;
  }

  /**
   * Schedule a reconnect attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = 5000;
    console.log(`🔌 GatewayConnector: Reconnecting in ${delay / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
