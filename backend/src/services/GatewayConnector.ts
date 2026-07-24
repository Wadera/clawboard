import WebSocket from 'ws';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash, generateKeyPairSync } from 'crypto';
import { EventEmitter } from 'events';
import { WebSocketService } from './websocket';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

/** Minimal live state tracked per session from streaming events only. */
export interface LiveState {
  state: 'idle' | 'busy' | 'thinking' | 'tool-use' | 'typing';
  /** Recent tool names (last 10 tool_call events). */
  tools: string[];
  lastActivity: number;
  /** Interactive tracked sessions stay persistent between turns. */
  persistent?: boolean;
}

/** Session ended event payload emitted when gateway confirms a session is done. */
export interface SessionEndedEvent {
  sessionKey: string;
  sessionId?: string;
  reason: 'cron-finished' | 'chat-final' | 'aborted' | 'cleanup';
  /** Cron-specific metadata. */
  cronJobId?: string;
  status?: string;
  durationMs?: number;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

const LEGACY_CRON_SESSION_KEY_RE = /^cron:([0-9a-f-]+)$/i;
const CANONICAL_CRON_SESSION_KEY_RE = /^agent:main:cron:([0-9a-f-]+)$/i;

export function buildCronSessionKey(jobId: string): string {
  return `agent:main:cron:${jobId}`;
}

export function canonicalizeSessionKey(sessionKey: string): string {
  const match = sessionKey.match(LEGACY_CRON_SESSION_KEY_RE);
  if (match) {
    return buildCronSessionKey(match[1]);
  }
  return sessionKey;
}

export function getSessionKeyAliases(sessionKey: string): string[] {
  const canonical = canonicalizeSessionKey(sessionKey);
  const aliases = new Set<string>([canonical]);
  const match = canonical.match(CANONICAL_CRON_SESSION_KEY_RE);
  if (match) {
    aliases.add(`cron:${match[1]}`);
  }
  return Array.from(aliases);
}

export class GatewayConnector extends EventEmitter {
  private ws: WebSocket | null = null;
  private wsService: WebSocketService;
  private gatewayUrl: string;
  private gatewayPassword: string;
  private connected: boolean = false;
  private lastConnectionError: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private requestId: number = 0;
  private deviceId: string = '';
  private publicKeyPem: string = '';
  private privateKeyPem: string = '';
  private challengeNonce: string = '';

  /** Live state per session key — populated from streaming events only. */
  private liveStates: Map<string, LiveState> = new Map();

  /** Tracks session keys for which session:live has been emitted (dedup). */
  private announcedLiveSessions: Set<string> = new Set();

  private pendingRequests: Map<string, { resolve: (data: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = new Map();
  private requestQueue: Array<{ method: string; params: any; resolve: (data: any) => void; reject: (err: Error) => void; retries: number }> = [];

  constructor(wsService: WebSocketService) {
    super();
    this.wsService = wsService;

    // Read gateway config
    this.gatewayUrl = process.env.OPENCLAW_GATEWAY_WS_URL || process.env.CLAWDBOT_GATEWAY_WS_URL || 'ws://127.0.0.1:18789';
    this.gatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD || process.env.CLAWDBOT_GATEWAY_PASSWORD || '';

    // Try to read password from config file if not in env
    if (!this.gatewayPassword) {
      try {
        const configPath = process.env.OPENCLAW_CONFIG_PATH || process.env.CLAWDBOT_CONFIG_PATH || '/clawdbot/clawdbot.json';
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        this.gatewayPassword = config?.gateway?.auth?.password || config?.gateway?.auth?.token || '';
        if (this.gatewayPassword) {
          console.log('🔑 GatewayConnector: Read gateway auth from config');
        }
      } catch (err) {
        console.warn('⚠️  GatewayConnector: Could not read gateway password from config');
      }
    }

    // Initialize device identity (keypair for gateway auth)
    this.initDeviceIdentity();
  }

  /**
   * Initialize or load device identity keypair (ed25519, matching OpenClaw protocol)
   */
  private initDeviceIdentity(): void {
    // Use persistent volume (/data is bind-mounted), fall back to /app/data
    const dataDir = process.env.DEVICE_IDENTITY_DIR || process.env.DATA_DIR || '/data';
    const identityPath = join(dataDir, 'device-identity.json');

    try {
      if (existsSync(identityPath)) {
        const parsed = JSON.parse(readFileSync(identityPath, 'utf-8'));
        if (parsed?.version === 1 && parsed.publicKeyPem && parsed.privateKeyPem) {
          this.publicKeyPem = parsed.publicKeyPem;
          this.privateKeyPem = parsed.privateKeyPem;
          this.deviceId = this.fingerprintPublicKey(this.publicKeyPem);
          console.log(`🔑 GatewayConnector: Loaded device identity: ${this.deviceId.substring(0, 8)}...`);
          return;
        }
      }

      console.log('🔑 GatewayConnector: Generating new ed25519 device keypair...');
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      this.publicKeyPem = (publicKey as any).export({ type: 'spki', format: 'pem' }).toString();
      this.privateKeyPem = (privateKey as any).export({ type: 'pkcs8', format: 'pem' }).toString();
      this.deviceId = this.fingerprintPublicKey(this.publicKeyPem);

      mkdirSync(dataDir, { recursive: true });
      writeFileSync(identityPath, JSON.stringify({
        version: 1,
        deviceId: this.deviceId,
        publicKeyPem: this.publicKeyPem,
        privateKeyPem: this.privateKeyPem,
        createdAt: new Date().toISOString(),
      }, null, 2), { mode: 0o600 });
      console.log(`🔑 GatewayConnector: Device keypair generated: ${this.deviceId.substring(0, 8)}...`);
    } catch (err) {
      console.error('⚠️  GatewayConnector: Failed to init device identity:', err);
    }
  }

  /**
   * Fingerprint a public key PEM: sha256 of raw SPKI DER bytes
   */
  private fingerprintPublicKey(pem: string): string {
    const { createPublicKey } = require('crypto');
    const spki = createPublicKey(pem).export({ type: 'spki', format: 'der' });
    // For ed25519, strip the SPKI prefix (12 bytes) to get raw 32-byte key
    const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
    let raw = spki;
    if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
        spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
      raw = spki.subarray(ED25519_SPKI_PREFIX.length);
    }
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Get raw public key bytes as base64url
   */
  private publicKeyBase64Url(): string {
    const { createPublicKey } = require('crypto');
    const spki = createPublicKey(this.publicKeyPem).export({ type: 'spki', format: 'der' });
    const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
    let raw = spki;
    if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
        spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
      raw = spki.subarray(ED25519_SPKI_PREFIX.length);
    }
    return raw.toString('base64url');
  }

  /**
   * Start the gateway connector
   */
  public start(): void {
    console.log('🔌 GatewayConnector: Starting...');
    console.log(`   Gateway URL: ${this.gatewayUrl}`);
    this.connect();

    // Periodic cleanup: remove sessions idle for >2h from liveStates
    this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), 5 * 60 * 1000);
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
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * Get all current live states (sessions with recent streaming activity).
   * Keys are session keys; values are minimal live state objects.
   */
  public getLiveStates(): Map<string, LiveState> {
    const liveStates = new Map(this.liveStates);
    for (const [sessionKey, state] of this.liveStates.entries()) {
      for (const alias of getSessionKeyAliases(sessionKey)) {
        liveStates.set(alias, state);
      }
    }
    return liveStates;
  }

  /**
   * Get live state for a single session key.
   */
  public getSessionState(sessionKey: string): LiveState | undefined {
    for (const alias of getSessionKeyAliases(sessionKey)) {
      const state = this.liveStates.get(alias);
      if (state) return state;
    }
    return undefined;
  }

  /**
   * Get the HTTP base URL of the OpenClaw gateway (derived from WS URL).
   * Used by DiscordThreadService to call /tools/invoke.
   */
  public getGatewayHttpUrl(): string {
    return this.gatewayUrl.replace(/^ws/, 'http').replace(/\/ws\/?$/, '');
  }

  /**
   * Get the gateway password/token (for HTTP Bearer auth).
   */
  public getGatewayPassword(): string {
    return this.gatewayPassword;
  }

  /**
   * Lightweight connection status for routes that need to fail fast instead of hanging.
   */
  public getConnectionStatus(): { connected: boolean; lastError: string | null } {
    return {
      connected: this.connected,
      lastError: this.lastConnectionError,
    };
  }

  /**
   * Remove sessions that have been idle for >2h to prevent unbounded memory growth.
   * For ephemeral sessions (cron, subagent, acp), also emit session:ended to update the DB.
   */
  private cleanupStaleSessions(): void {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    let removed = 0;
    for (const [key, state] of this.liveStates.entries()) {
      if (state.state === 'idle' && state.lastActivity < cutoff) {
        // For ephemeral sessions, mark as ended so DB gets updated
        if (this.isEphemeralSession(key)) {
          this.markSessionEnded(key, 'cleanup');
        } else {
          this.liveStates.delete(key);
          this.announcedLiveSessions.delete(key);
        }
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`🧹 GatewayConnector: Cleaned up ${removed} stale idle sessions from liveStates`);
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
      // Set origin to match gateway host so Control UI origin check passes
      const gatewayOrigin = this.gatewayUrl.replace(/^ws/, 'http').replace(/\/ws\/?$/, '');
      this.ws = new WebSocket(this.gatewayUrl, { headers: { origin: gatewayOrigin } });

      this.ws.on('open', () => {
        console.log('🔌 GatewayConnector: WebSocket connected');
        this.lastConnectionError = null;
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
        this.lastConnectionError = this.lastConnectionError || 'Gateway disconnected';

        // Reject all pending requests since connection is lost
        for (const pending of this.pendingRequests.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();

        this.scheduleReconnect();
      });

      this.ws.on('error', (err: Error) => {
        console.error('GatewayConnector: WebSocket error:', err.message);
        this.connected = false;
        this.lastConnectionError = err.message || 'Gateway WebSocket error';
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
      this.challengeNonce = msg.payload?.nonce || '';
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
          this.lastConnectionError = null;
          this.onConnected();
        } else {
          const authMessage = msg.error?.message || 'Gateway auth failed';
          console.error('❌ GatewayConnector: Auth failed:', authMessage);
          this.connected = false;
          this.lastConnectionError = authMessage;
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

    // Sign the challenge nonce with our ed25519 private key
    let signature = '';
    const signedAt = Date.now();
    const role = 'operator';
    const scopes = ['operator.read', 'operator.admin'];
    if (this.privateKeyPem && this.challengeNonce) {
      try {
        const { createPrivateKey, sign } = require('crypto');
        const key = createPrivateKey(this.privateKeyPem);
        const payload = [
          'v2',
          this.deviceId,
          'openclaw-control-ui',
          'backend',
          role,
          scopes.join(','),
          String(signedAt),
          this.gatewayPassword || '',
          this.challengeNonce,
        ].join('|');
        const sigBuf = sign(null, Buffer.from(payload, 'utf8'), key);
        signature = sigBuf.toString('base64url');
      } catch (err) {
        console.error('⚠️  GatewayConnector: Failed to sign challenge:', err);
      }
    }

    const params: any = {
      minProtocol: 3,
      maxProtocol: 4,
      client: { id: 'openclaw-control-ui', version: '1.0.0', platform: 'linux', mode: 'backend', displayName: 'ClawBoard Backend' },
      role: 'operator',
      scopes: ['operator.read', 'operator.admin'],
      caps: [],
      commands: [],
      permissions: {},
      auth: { password: this.gatewayPassword, token: this.gatewayPassword },
      locale: 'en-US',
      userAgent: 'clawboard-backend/1.0.0',
    };

    // Include device identity if we have a keypair
    if (this.deviceId && this.publicKeyPem && signature) {
      params.device = {
        id: this.deviceId,
        publicKey: this.publicKeyBase64Url(),
        signature,
        signedAt,
        nonce: this.challengeNonce,
      };
    }

    this.ws.send(JSON.stringify({
      type: 'req',
      id: 'auth',
      method: 'connect',
      params,
    }));
  }

  /**
   * Called after successful auth — process any queued requests.
   * No session polling: SessionIngester owns metadata via file watchers.
   *
   * On reconnect, flush stale ephemeral sessions from liveStates.
   * During the disconnect window, we missed events — any ephemeral session
   * that was in liveStates and is still idle is likely done.
   */
  private onConnected(): void {
    // Flush stale ephemeral sessions from liveStates on reconnect.
    // During disconnect, we missed lifecycle events — be conservative:
    // only keep sessions that were actively generating when we disconnected.
    const staleKeys: string[] = [];
    for (const [key, state] of this.liveStates.entries()) {
      if (this.isEphemeralSession(key) && state.state === 'idle') {
        staleKeys.push(key);
      }
    }
    for (const key of staleKeys) {
      this.markSessionEnded(key, 'cleanup');
    }
    if (staleKeys.length > 0) {
      console.log(`🔄 GatewayConnector: Reconnect cleanup — flushed ${staleKeys.length} stale ephemeral sessions`);
    }

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
      if (!this.connected) {
        const reason = this.lastConnectionError || 'Gateway connector unavailable';
        reject(new Error(reason));
        return;
      }

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        if (retries < 3) {
          console.log(`⏳ GatewayConnector: Queueing request (${method}) - socket not open (attempt ${retries + 1})`);
          this.requestQueue.push({ method, params, resolve, reject, retries: retries + 1 });

          if (!this.reconnectTimer) {
            this.scheduleReconnect();
          }
        } else {
          reject(new Error(this.lastConnectionError || 'Not connected and retry limit exceeded'));
        }
        return;
      }

      const id = String(++this.requestId);
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);

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
      // Mark as idle in live state
      const existing = this.liveStates.get(sessionKey);
      if (existing) {
        const oldState = existing.state;
        existing.state = 'idle';
        existing.lastActivity = Date.now();
        this.emit('state-change', { sessionKey, oldState, newState: 'idle', tools: existing.tools });
        this.broadcastLiveUpdate(sessionKey);
      }
      return result;
    } catch (err) {
      console.error(`❌ GatewayConnector: Failed to abort session ${sessionKey}:`, err);
      throw err;
    }
  }

  /**
   * Send a steering message to a running session (interactive mode).
   */
  public async steerSession(sessionKey: string, message: string): Promise<any> {
    try {
      const idempotencyKey = `steer-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const resolvedSessionKey = canonicalizeSessionKey(sessionKey);
      const result = await this.sendRequest('chat.send', { sessionKey: resolvedSessionKey, message, idempotencyKey });
      console.log(`🎯 GatewayConnector: Steered session ${resolvedSessionKey}`);
      return result;
    } catch (err) {
      console.error(`❌ GatewayConnector: Failed to steer session ${sessionKey}:`, err);
      throw err;
    }
  }

  /**
   * Spawn an interactive (persistent) agent session for a task.
   * Uses cron.add with deleteAfterRun=false to create a named persistent session.
   */
  public async spawnInteractiveSession(params: {
    name: string;
    prompt: string;
    model: string;
    thinking: string;
    announceTo: string;
    announceChannel: string;
    label?: string;
    taskName?: string;
  }): Promise<{ sessionKey: string; runId: string; cronJob: any }> {
    // Schedule 1 second in the future
    const at = new Date(Date.now() + 1000).toISOString();

    const cronJob = await this.sendGatewayRequest('cron.add', {
      name: params.name,
      sessionTarget: 'isolated',
      schedule: { kind: 'at', at },
      payload: {
        kind: 'agentTurn',
        message: params.prompt,
        model: params.model,
        thinking: params.thinking,
      },
      deleteAfterRun: false,  // Keep session alive for interactive steering
      delivery: { mode: 'none' },
    });

    const runId = cronJob.id as string;
    const sessionKey = buildCronSessionKey(runId);

    // Force-run immediately to avoid scheduler tick delays when spawning multiple agents
    try {
      await this.sendGatewayRequest('cron.run', { jobId: runId });
      console.log(`⚡ GatewayConnector: Force-started job ${runId}`);
    } catch (forceRunErr) {
      // Non-fatal: job still exists and will fire on next scheduler tick
      console.warn(`⚠️ GatewayConnector: cron.run failed for ${runId}, will rely on scheduler:`, forceRunErr);
    }

    // Seed live state immediately so the Sessions page can show the tracked
    // interactive session before the first stream event arrives.
    const canonicalSessionKey = canonicalizeSessionKey(sessionKey);
    this.liveStates.set(canonicalSessionKey, {
      state: 'idle',
      tools: [],
      lastActivity: Date.now(),
      persistent: true,
    });

    console.log(`🔗 GatewayConnector: Spawned interactive session ${sessionKey} (job: ${runId})`);
    return { sessionKey, runId, cronJob };
  }

  /**
   * Handle gateway events (streaming agent activity).
   * Updates liveStates and emits state-change events.
   *
   * Key event types from the gateway:
   *   - 'agent'  — streaming events (assistant, tool_call, tool_result, thinking, lifecycle)
   *   - 'chat'   — chat lifecycle (state: 'delta' | 'final' | 'done')
   *   - 'cron'   — cron job events (action: 'finished' — the definitive "session ended" signal)
   *   - 'session.state.change' — explicit session state transitions
   */
  private handleEvent(msg: any): void {
    const { event, payload } = msg;

    if (event === 'agent' && payload?.sessionKey) {
      const sessionKey: string = payload.sessionKey;

      // Emit agent:stream for subscribers (e.g. DiscordThreadService)
      if (payload.stream === 'assistant' || payload.stream === 'tool_call') {
        const streamPayload = {
          sessionKey,
          stream: payload.stream,
          text: payload.data?.text,
          toolName: payload.data?.name || payload.data?.tool,
          toolInput: (() => {
            const inp = payload.data?.input || payload.data?.command || payload.data?.url || '';
            return typeof inp === 'string' ? inp : JSON.stringify(inp);
          })(),
        };
        this.emit('agent:stream', streamPayload);

        // Broadcast session:output to dashboard for live session panels
        this.wsService.broadcast({
          type: 'session:output',
          sessionKey,
          stream: streamPayload.stream,
          text: streamPayload.text || '',
          toolName: streamPayload.toolName,
          timestamp: Date.now(),
        });
      }

      // Determine new state from stream type
      const stream = payload.stream;
      let newState: LiveState['state'] = 'busy';
      if (stream === 'thinking') {
        newState = 'thinking';
      } else if (stream === 'assistant') {
        newState = 'typing';
      } else if (stream === 'tool_call' || stream === 'tool_result') {
        newState = 'tool-use';
      }

      const existing = this.liveStates.get(sessionKey);
      const oldState = existing?.state ?? 'idle';
      const tools = existing?.tools ? [...existing.tools] : [];

      // Track recent tool names
      if (stream === 'tool_call' && payload.data) {
        const toolName = payload.data.name || payload.data.tool || 'unknown';
        tools.push(toolName);
        if (tools.length > 10) tools.splice(0, tools.length - 10);
      }

      this.liveStates.set(sessionKey, {
        state: newState,
        tools,
        lastActivity: payload.ts || Date.now(),
        persistent: existing?.persistent === true,
      });

      // Emit session:live on first sighting
      if (!this.announcedLiveSessions.has(sessionKey)) {
        this.announcedLiveSessions.add(sessionKey);
        this.emit('session:live', { sessionKey });
      }

      // Emit state-change only when state actually transitions
      if (oldState !== newState) {
        this.emit('state-change', { sessionKey, oldState, newState, tools });
        this.broadcastLiveUpdate(sessionKey);
      }
    }

    // chat:final → session finished its current run
    if (event === 'chat' && payload?.sessionKey) {
      const sessionKey: string = payload.sessionKey;

      if (payload.state === 'final' || payload.state === 'done') {
        const existing = this.liveStates.get(sessionKey);
        const oldState = existing?.state ?? 'idle';

        if (oldState !== 'idle') {
          this.liveStates.set(sessionKey, {
            state: 'idle',
            tools: existing?.tools ?? [],
            lastActivity: Date.now(),
            persistent: existing?.persistent === true,
          });
          this.emit('state-change', { sessionKey, oldState, newState: 'idle', tools: existing?.tools ?? [] });
          this.broadcastLiveUpdate(sessionKey);
        }

        // For 'final' state on non-persistent sessions (cron runs, subagents),
        // emit session:ended so the DB can be updated to 'completed'.
        // Persistent sessions (main, discord) just go idle between turns.
        if (payload.state === 'final' && this.isEphemeralSession(sessionKey)) {
          this.markSessionEnded(sessionKey, 'chat-final');
        }
      }
    }

    // cron:finished → definitive signal that a cron session has completed.
    // This is the most reliable indicator — the gateway knows the cron run is done.
    if (event === 'cron' && payload?.action === 'finished') {
      const sessionKey: string | undefined = payload.sessionKey;
      const cronJobId: string | undefined = payload.jobId;

      if (sessionKey) {
        console.log(`📦 GatewayConnector: Cron session finished: ${sessionKey} (job: ${cronJobId})`);
        this.markSessionEnded(sessionKey, 'cron-finished', {
          cronJobId,
          status: payload.status,
          durationMs: payload.durationMs,
          model: payload.model,
          usage: payload.usage,
          sessionId: payload.sessionId,
        });
      }

      // Also handle the parent cron session key (without :run: suffix)
      // The parent key is: agent:main:cron:<jobId>
      if (cronJobId) {
        const parentKey = sessionKey?.replace(/:run:.*$/, '');
        if (parentKey && parentKey !== sessionKey) {
          this.markSessionEnded(parentKey, 'cron-finished', { cronJobId });
        }
      }
    }

    // Session state transitions from gateway
    if (event === 'session.state.change' && payload?.sessionKey) {
      const sessionKey: string = payload.sessionKey;
      const existing = this.liveStates.get(sessionKey);
      const oldState = existing?.state ?? 'idle';
      const newState: LiveState['state'] = payload.state === 'idle' ? 'idle' : 'busy';
      if (oldState !== newState) {
        this.liveStates.set(sessionKey, {
          state: newState,
          tools: existing?.tools ?? [],
          lastActivity: Date.now(),
          persistent: existing?.persistent === true,
        });
        this.emit('state-change', { sessionKey, oldState, newState, tools: existing?.tools ?? [] });
        this.broadcastLiveUpdate(sessionKey);
      }
    }
  }

  /**
   * Determine if a session is ephemeral (cron run, subagent, acp) vs persistent (main, discord).
   * Ephemeral sessions should be marked completed when they finish.
   * Persistent sessions just go idle between turns.
   */
  private isEphemeralSession(sessionKey: string): boolean {
    const live = this.liveStates.get(sessionKey);
    if (live?.persistent === true) {
      return false;
    }

    return (
      sessionKey.includes(':cron:') ||
      sessionKey.startsWith('cron:') ||
      sessionKey.includes(':subagent:') ||
      sessionKey.includes(':acp:')
    );
  }

  /**
   * Mark a session as ended: remove from liveStates, emit session:ended event,
   * and broadcast completion to dashboard clients.
   */
  private markSessionEnded(sessionKey: string, reason: SessionEndedEvent['reason'], extra?: Partial<SessionEndedEvent>): void {
    const existing = this.liveStates.get(sessionKey);

    // Transition to idle first if still active
    if (existing && existing.state !== 'idle') {
      const oldState = existing.state;
      existing.state = 'idle';
      existing.lastActivity = Date.now();
      this.emit('state-change', { sessionKey, oldState, newState: 'idle', tools: existing.tools });
    }

    // Remove from live tracking — session is done, not just idle
    this.liveStates.delete(sessionKey);
    this.announcedLiveSessions.delete(sessionKey);

    // Emit session:ended event for SessionIngester to update DB
    const endedEvent: SessionEndedEvent = {
      sessionKey,
      reason,
      ...extra,
    };
    this.emit('session:ended', endedEvent);

    // Broadcast to dashboard clients
    this.wsService.broadcast({
      type: 'sessions:completed',
      sessionKey,
      reason,
      timestamp: Date.now(),
    });

    // Also broadcast a live-state removal (null liveState)
    this.wsService.broadcast({
      type: 'sessions:live-state',
      sessionKey,
      liveState: null,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast live state update to dashboard WebSocket clients.
   *
   * Phase 4 events (new clean API):
   *   sessions:live-state  — live state changed for a single session
   *   sessions:updated     — single session metadata updated
   *
   * Note: sessions:completed is now emitted only from markSessionEnded()
   * when we have definitive proof the session is done (cron:finished, chat:final).
   * Previously it fired on every idle transition, which was misleading.
   *
   * Legacy compat:
   *   gateway:queue-update — kept so old frontend panels still work during transition
   */
  private broadcastLiveUpdate(changedSessionKey?: string): void {
    const now = Date.now();

    // ── Phase 4: targeted single-session events ────────────────────
    if (changedSessionKey) {
      const live = this.liveStates.get(changedSessionKey);
      if (live) {
        const livePayload = {
          state: live.state,
          recentTools: live.tools,
          lastActivity: live.lastActivity,
          isGenerating: live.state !== 'idle',
        };

        // sessions:live-state — lightweight state change notification
        this.wsService.broadcast({
          type: 'sessions:live-state',
          sessionKey: changedSessionKey,
          liveState: livePayload,
          timestamp: now,
        });

        // sessions:updated — broader session changed event (triggers list refresh)
        this.wsService.broadcast({
          type: 'sessions:updated',
          sessionKey: changedSessionKey,
          liveState: livePayload,
          timestamp: now,
        });
      }
      // If live is null (session was removed from liveStates), the
      // sessions:completed + sessions:live-state(null) events are emitted
      // by markSessionEnded() which handles the full cleanup path.
    }

    // ── Legacy: gateway:queue-update (kept for backward compat) ───
    const sessions = Array.from(this.liveStates.entries()).map(([sessionKey, s]) => ({
      sessionKey,
      sessionId: sessionKey,
      displayName: sessionKey,
      label: sessionKey,
      channel: 'unknown',
      state: s.state,
      lastActivity: s.lastActivity,
      recentTools: s.tools.map(t => ({ name: t, timestamp: s.lastActivity, status: 'done' as const })),
      model: 'unknown',
      tokenUsage: { total: 0, context: 200000, percentUsed: 0 },
      kind: 'unknown',
      isGenerating: s.state !== 'idle',
    }));

    this.wsService.broadcast({
      type: 'gateway:queue-update',
      data: {
        sessions,
        activeSessions: sessions.filter(s => s.state !== 'idle').length,
        totalSessions: sessions.length,
        timestamp: now,
        connected: this.connected,
      },
      timestamp: now,
    });
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
