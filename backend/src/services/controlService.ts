import { readFile } from 'fs/promises';
import WebSocket from 'ws';

export interface StopResult {
  success: boolean;
  target: string;
  message: string;
  timestamp: string;
}

/**
 * Provides control actions for Clawdbot sessions.
 * Uses the Clawdbot gateway WebSocket RPC (chat.abort) to stop sessions.
 */
export class ControlService {
  private sessionsPath: string;
  private configPath: string;

  constructor(sessionsPath: string, configPath?: string) {
    this.sessionsPath = sessionsPath;
    this.configPath = configPath || process.env.OPENCLAW_CONFIG_PATH || '/clawdbot/clawdbot.json';
  }

  /**
   * Read gateway auth from clawdbot.json
   */
  private async getGatewayAuth(): Promise<{ password?: string; token?: string }> {
    try {
      const data = await readFile(this.configPath, 'utf-8');
      const config = JSON.parse(data);
      const auth = config?.gateway?.auth || {};
      return { password: auth.password, token: auth.token };
    } catch {
      return {};
    }
  }

  /**
   * Stop the main bot session by sending chat.abort
   */
  async stopMain(): Promise<StopResult> {
    try {
      const data = await readFile(this.sessionsPath, 'utf-8');
      const sessions: Record<string, unknown> = JSON.parse(data);

      const mainEntry = Object.entries(sessions).find(
        ([key]) => key.includes('main:main') && !key.includes('subagent')
      );

      if (!mainEntry) {
        return {
          success: false,
          target: 'main',
          message: 'Main session not found',
          timestamp: new Date().toISOString(),
        };
      }

      const [sessionKey] = mainEntry;
      const result = await this.abortSession(sessionKey);
      return {
        success: result,
        target: 'main',
        message: result ? 'Stop signal sent to main session' : 'Failed to send stop signal',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      console.error('❌ Failed to stop main session:', err);
      return {
        success: false,
        target: 'main',
        message: err instanceof Error ? err.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Stop a specific sub-agent session
   */
  async stopAgent(agentKey: string): Promise<StopResult> {
    try {
      const result = await this.abortSession(agentKey);
      return {
        success: result,
        target: agentKey,
        message: result ? `Stop signal sent to agent ${agentKey}` : 'Failed to send stop signal',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      console.error(`❌ Failed to stop agent ${agentKey}:`, err);
      return {
        success: false,
        target: agentKey,
        message: err instanceof Error ? err.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Stop all sessions (main + all sub-agents)
   */
  async stopAll(): Promise<StopResult[]> {
    const results: StopResult[] = [];

    try {
      const data = await readFile(this.sessionsPath, 'utf-8');
      const sessions: Record<string, Record<string, unknown>> = JSON.parse(data);

      for (const [key, session] of Object.entries(sessions)) {
        const updatedAt = (session.updatedAt as number) || 0;
        const timeSinceUpdate = Date.now() - updatedAt;
        if (timeSinceUpdate < 5 * 60 * 1000) {
          const result = await this.abortSession(key);
          results.push({
            success: result,
            target: key,
            message: result ? `Stopped ${key}` : `Failed to stop ${key}`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      console.error('❌ Failed to stop all sessions:', err);
      results.push({
        success: false,
        target: 'all',
        message: err instanceof Error ? err.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }

    return results;
  }

  /**
   * Get list of active sub-agents
   */
  async getActiveAgents(): Promise<Array<{ key: string; label: string; updatedAt: number }>> {
    try {
      const data = await readFile(this.sessionsPath, 'utf-8');
      const sessions: Record<string, Record<string, unknown>> = JSON.parse(data);
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;

      return Object.entries(sessions)
        .filter(([key, session]) => {
          return key.includes('subagent') && (session.updatedAt as number) > fiveMinAgo;
        })
        .map(([key, session]) => ({
          key,
          label: (session.label as string) || key.split(':').pop() || 'unknown',
          updatedAt: session.updatedAt as number,
        }));
    } catch {
      return [];
    }
  }

  /**
   * Abort a session via the Clawdbot gateway WebSocket RPC.
   * Connects, authenticates, sends chat.abort, then disconnects.
   */
  private async abortSession(sessionKey: string): Promise<boolean> {
    const gatewayUrl = process.env.OPENCLAW_GATEWAY_WS_URL || 'ws://host.docker.internal:18789';
    const auth = await this.getGatewayAuth();

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        console.error(`⏰ Timeout aborting session ${sessionKey}`);
        try { ws.close(); } catch { /* ignore */ }
        resolve(false);
      }, 10000);

      let ws: WebSocket;
      try {
        ws = new WebSocket(gatewayUrl);
      } catch (err) {
        console.error(`❌ Failed to create WebSocket to ${gatewayUrl}:`, err);
        clearTimeout(timeout);
        resolve(false);
        return;
      }

      ws.on('error', (err) => {
        console.error(`❌ WebSocket error for ${sessionKey}:`, err);
        clearTimeout(timeout);
        resolve(false);
      });

      ws.on('open', () => {
        // Send connect handshake
        const authPayload: Record<string, string> = {};
        if (auth.password) authPayload.password = auth.password;
        else if (auth.token) authPayload.token = auth.token;

        ws.send(JSON.stringify({
          type: 'req',
          id: 'connect-1',
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: 'clawdbot-control-ui', version: '1.0.0', platform: 'linux', mode: 'ui' },
            role: 'operator',
            scopes: ['operator.read', 'operator.write'],
            caps: [],
            commands: [],
            permissions: {},
            auth: authPayload,
          },
        }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // After successful connect, send chat.abort
          if (msg.type === 'res' && msg.id === 'connect-1') {
            if (!msg.ok) {
              console.error(`❌ Gateway connect failed for abort ${sessionKey}:`, msg.error);
              clearTimeout(timeout);
              ws.close();
              resolve(false);
              return;
            }

            // Send chat.abort with sessionKey
            ws.send(JSON.stringify({
              type: 'req',
              id: 'abort-1',
              method: 'chat.abort',
              params: { sessionKey },
            }));
          }

          // Handle abort response
          if (msg.type === 'res' && msg.id === 'abort-1') {
            clearTimeout(timeout);
            ws.close();
            if (msg.ok) {
              console.log(`🛑 Successfully aborted session ${sessionKey}`);
              resolve(true);
            } else {
              console.warn(`⚠️ chat.abort failed for ${sessionKey}:`, msg.error);
              // Even if "no active run", consider it a success (session is already stopped)
              const isAlreadyStopped = msg.error?.message?.includes('no active') ||
                msg.error?.code === 'NOT_FOUND';
              resolve(isAlreadyStopped);
            }
          }
        } catch {
          // ignore parse errors for non-JSON frames
        }
      });
    });
  }
}
