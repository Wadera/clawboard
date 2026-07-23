import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';

/**
 * Callback type for providing a sessions snapshot on demand.
 * Called when a new client connects or during periodic snapshots.
 */
export type SnapshotProvider = () => Promise<any[]> | any[];

export class WebSocketService {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  /** Optional provider for sessions:snapshot event data. */
  private snapshotProvider: SnapshotProvider | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;

  constructor(server: Server, path: string = '/ws') {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade manually to avoid Socket.IO collision
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      if (url.pathname !== path) return; // Let other handlers (VoiceService, Socket.IO) handle it

      const token = url.searchParams.get('token');
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      try {
        jwt.verify(token, JWT_SECRET);
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    console.log(`🔌 WebSocket server initialized on ${path}`);
  }

  // ─────────────────────────────────────────────────────────────────
  // Phase 4: Snapshot provider for sessions:snapshot events
  // ─────────────────────────────────────────────────────────────────

  /**
   * Register a snapshot provider.
   * Called when a client connects (initial snapshot) and every 30s (periodic refresh).
   */
  public setSnapshotProvider(provider: SnapshotProvider): void {
    this.snapshotProvider = provider;

    // Start periodic snapshots (every 30s)
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = setInterval(async () => {
      await this.broadcastSnapshot();
    }, 30_000);
  }

  /**
   * Broadcast sessions:snapshot to all connected clients.
   */
  public async broadcastSnapshot(): Promise<void> {
    if (!this.snapshotProvider || this.clients.size === 0) return;
    try {
      const sessions = await this.snapshotProvider();
      this.broadcast({ type: 'sessions:snapshot', sessions, timestamp: Date.now() });
    } catch (err) {
      console.error('[WS] Failed to build sessions snapshot:', err);
    }
  }

  /**
   * Send sessions:snapshot to a single newly-connected client.
   */
  private async sendSnapshotTo(ws: WebSocket): Promise<void> {
    if (!this.snapshotProvider) return;
    try {
      const sessions = await this.snapshotProvider();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'sessions:snapshot', sessions, timestamp: Date.now() }));
      }
    } catch (err) {
      console.error('[WS] Failed to send snapshot to new client:', err);
    }
  }

  /** Stop the periodic snapshot timer (called on shutdown). */
  public stopSnapshotTimer(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket) {
    console.log('📡 Client connected');
    this.clients.add(ws);

    // Send initial connection confirmation
    ws.send(JSON.stringify({
      type: 'connected',
      timestamp: Date.now()
    }));

    // Send sessions:snapshot to the new client
    this.sendSnapshotTo(ws);

    // Heartbeat to keep connection alive
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000); // Every 30 seconds

    // Handle pong responses
    ws.on('pong', () => {
      // Client is alive
    });

    // Handle messages from client
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleClientMessage(ws, message);
      } catch (error) {
        console.error('Failed to parse client message:', error);
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      console.log('📡 Client disconnected');
      this.clients.delete(ws);
      clearInterval(heartbeatInterval);
    });

    // Handle errors
    ws.on('error', (error: Error) => {
      console.error('WebSocket error:', error);
      this.clients.delete(ws);
    });
  }

  private handleClientMessage(ws: WebSocket, message: any) {
    // Handle client requests
    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
    }
    // Phase 4: client can request a fresh snapshot on demand
    if (message.type === 'sessions:request-snapshot') {
      this.sendSnapshotTo(ws);
    }
  }

  /**
   * Broadcast a message to all connected clients
   */
  public broadcast(data: any) {
    const message = JSON.stringify(data);
    let successCount = 0;
    let failCount = 0;

    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          successCount++;
        } catch (error) {
          console.error('Failed to send to client:', error);
          failCount++;
        }
      } else {
        // Remove dead clients
        this.clients.delete(client);
      }
    });

    // Log only if there are clients
    if (successCount > 0 || failCount > 0) {
      console.log(`📤 Broadcast: ${successCount} sent, ${failCount} failed, ${this.clients.size} total clients`);
    }
  }

  /**
   * Get the number of connected clients
   */
  public getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Close all connections and shut down the server
   */
  public shutdown() {
    console.log('🔌 Shutting down WebSocket server...');
    this.stopSnapshotTimer();
    this.clients.forEach((client) => {
      client.close();
    });
    this.wss.close();
  }
}
