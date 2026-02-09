import { WebSocketServer, WebSocket } from 'ws';
import { Server, IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';

export class WebSocketService {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  constructor(server: Server, path: string = '/ws') {
    this.wss = new WebSocketServer({
      server,
      path,
      verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }, callback: (res: boolean, code?: number, message?: string) => void) => {
        try {
          const url = new URL(info.req.url || '', `http://${info.req.headers.host}`);
          const token = url.searchParams.get('token');
          
          if (!token) {
            callback(false, 401, 'No token provided');
            return;
          }

          jwt.verify(token, JWT_SECRET);
          callback(true);
        } catch (err) {
          console.log('🔒 WebSocket auth failed:', err instanceof Error ? err.message : 'Unknown error');
          callback(false, 401, 'Invalid token');
        }
      }
    });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    console.log(`🔌 WebSocket server initialized on ${path}`);
  }

  private handleConnection(ws: WebSocket) {
    console.log('📡 Client connected');
    this.clients.add(ws);

    // Send initial connection confirmation
    ws.send(JSON.stringify({
      type: 'connected',
      timestamp: Date.now()
    }));

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
    // Handle client requests (future: manual refresh, subscribe to specific updates, etc.)
    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
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
    this.clients.forEach((client) => {
      client.close();
    });
    this.wss.close();
  }
}
