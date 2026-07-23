/**
 * VoiceService — WebSocket proxy between ClawBoard browser clients and Claude Bridge
 *
 * Architecture:
 *   Browser ↔ VoiceService (/api/voice WS) ↔ Claude Bridge (ws://192.168.1.215:8998)
 *
 * - Auth via JWT token in URL query param (same pattern as main /ws endpoint)
 * - Full-duplex binary audio relay (PCM int16 24kHz frames)
 * - JSON control messages forwarded/filtered appropriately
 * - PersonaPlex lifecycle: health polling, WoL trigger
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';
// ── STT Transcription ─────────────────────────────────────────────────────────
import http from 'http';
import { URL } from 'url';

const WHISPER_URL = process.env.WHISPER_URL || 'http://localhost:8300';
const SILENCE_THRESHOLD = 500;   // int16 amplitude
const SILENCE_FRAMES = 15;      // ~1.2s = end of utterance
const MIN_SPEECH_FRAMES = 5;    // ~400ms minimum

const WHISPER_HALLUCINATIONS = new Set([
  'thanks for watching', 'thank you for watching', 'please subscribe',
  'like and subscribe', 'see you next time', 'bye bye', 'goodbye',
  'you', 'the end', 'thanks for listening', 'thank you for listening',
  'subscribe', '', '...', 'thank you', 'bye',
]);

class STTAccumulator {
  private frames: Buffer[] = [];
  private silenceCount = 0;
  private speechDetected = false;
  private onTranscript: (text: string, speaker: string) => void;
  private speaker: string;
  private processing = false;

  constructor(speaker: string, onTranscript: (text: string, speaker: string) => void) {
    this.speaker = speaker;
    this.onTranscript = onTranscript;
  }

  feed(data: Buffer) {
    // Calculate peak amplitude
    let peak = 0;
    for (let i = 0; i < data.length - 1; i += 2) {
      const sample = Math.abs(data.readInt16LE(i));
      if (sample > peak) peak = sample;
    }

    if (peak > SILENCE_THRESHOLD) {
      this.silenceCount = 0;
      this.frames.push(Buffer.from(data));
      if (!this.speechDetected) {
        this.speechDetected = true;
      }
    } else if (this.speechDetected) {
      this.silenceCount++;
      this.frames.push(Buffer.from(data));

      if (this.silenceCount >= SILENCE_FRAMES) {
        if (this.frames.length >= MIN_SPEECH_FRAMES && !this.processing) {
          const captured = this.frames.slice();
          this.frames = [];
          this.speechDetected = false;
          this.silenceCount = 0;
          this.transcribe(captured);
        } else {
          this.frames = [];
          this.speechDetected = false;
          this.silenceCount = 0;
        }
      }
    }
  }

  private async transcribe(frames: Buffer[]) {
    this.processing = true;
    try {
      const pcm = Buffer.concat(frames);
      // Build WAV
      const wavHeader = Buffer.alloc(44);
      const dataSize = pcm.length;
      const fileSize = 36 + dataSize;
      wavHeader.write('RIFF', 0);
      wavHeader.writeUInt32LE(fileSize, 4);
      wavHeader.write('WAVE', 8);
      wavHeader.write('fmt ', 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20);  // PCM
      wavHeader.writeUInt16LE(1, 22);  // mono
      wavHeader.writeUInt32LE(24000, 24);
      wavHeader.writeUInt32LE(48000, 28);
      wavHeader.writeUInt16LE(2, 32);
      wavHeader.writeUInt16LE(16, 34);
      wavHeader.write('data', 36);
      wavHeader.writeUInt32LE(dataSize, 40);
      const wav = Buffer.concat([wavHeader, pcm]);

      // Multipart form data
      const boundary = '----WhisperBoundary' + Date.now();
      const pre = Buffer.from(
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n' +
        'Content-Type: audio/wav\r\n\r\n'
      );
      const mid = Buffer.from(
        '\r\n--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="model"\r\n\r\n' +
        'Systran/faster-whisper-small\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="language"\r\n\r\n' +
        'en\r\n' +
        '--' + boundary + '--\r\n'
      );
      const body = Buffer.concat([pre, wav, mid]);

      const url = new URL(WHISPER_URL + '/v1/audio/transcriptions');
      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': body.length,
        },
        timeout: 10000,
      };

      const text = await new Promise<string>((resolve, reject) => {
        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data).text?.trim() || '');
            } catch { resolve(''); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
      });

      if (text && text.length >= 2 && !WHISPER_HALLUCINATIONS.has(text.toLowerCase().replace(/[!.,]/g, ''))) {
        console.log(`🎙️  STT [${this.speaker}]: "${text}"`);
        this.onTranscript(text, this.speaker);
      }
    } catch (err: any) {
      console.error(`🎙️  STT error [${this.speaker}]:`, err.message);
    } finally {
      this.processing = false;
    }
  }
}


// Claude Bridge endpoint (runs on AI VM, connects forward to PersonaPlex on turbo PC)
const CLAUDE_BRIDGE_URL = process.env.VOICE_BRIDGE_URL || 'ws://192.168.1.215:8998';

// Turbo PC health check endpoint
const VOICE_PROXY_URL = process.env.VOICE_PROXY_URL || 'http://172.28.0.1:8401';

// WoL command — called via the power management script

// Health poll interval (ms)
const HEALTH_POLL_INTERVAL = 10_000;

type PersonaPlexState = 'unknown' | 'offline' | 'waking' | 'booting' | 'warming_up' | 'ready' | 'active' | 'idle';

interface PersonaPlexStatus {
  state: PersonaPlexState;
  gpuTemp?: number;
  vramUsed?: number;
  vramTotal?: number;
}

export class VoiceService {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private userSTT!: STTAccumulator;
  private nimSTT!: STTAccumulator;
  private bridgeWs: WebSocket | null = null;
  private healthPollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private clientPingTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatus: PersonaPlexStatus = { state: 'unknown' };
  private wolInProgress = false;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade manually to avoid Socket.IO collision
    server.on('upgrade', (request, socket, head) => {
      console.log('🎙️  Upgrade request:', request.url);
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      if (url.pathname !== '/voice') return;

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

    this.wss.on('connection', (ws: WebSocket) => this.handleClientConnect(ws));
    this.startHealthPolling();

    // Dead client detection: each client must send a JSON ping within 45s
    // (frontend sends every 20s). If not, terminate.
    this.clientPingTimer = setInterval(() => {
      const now = Date.now();
      for (const client of this.clients) {
        const lastPing = (client as any).lastAppPing || 0;
        if (lastPing > 0 && now - lastPing > 300_000) {
          console.log('🎙️  Voice client dead (no app ping for 45s) — terminating');
          this.clients.delete(client);
          client.terminate();
          if (this.clients.size === 0) {
            this.disconnectBridge();
            this.stopHeartbeat();
          }
        }
      }
    }, 15_000);

    console.log('🎙️  VoiceService initialized on /voice');
  }

  // ── Client connection ─────────────────────────────────────────────────────

  private handleClientConnect(ws: WebSocket) {
    console.log('🎙️  Voice client connected');
    this.clients.add(ws);

    // Track last app-level ping for dead client detection
    (ws as any).lastAppPing = Date.now();

    // Start heartbeat pings to voice-proxy (keeps PersonaPlex alive)
    if (this.clients.size === 1) {
      this.startHeartbeat();
    }

    // Send current PersonaPlex status immediately
    this.sendToClient(ws, { type: 'personaplex_status', status: this.lastStatus });

    // Auto-wake turbo PC if offline
    if (this.lastStatus.state === 'offline' || this.lastStatus.state === 'unknown') {
      this.triggerWoL();
    }

    // Ensure bridge is connected
    this.ensureBridgeConnected();

    // If bridge already connected, tell this client immediately
    if (this.bridgeWs && this.bridgeWs.readyState === 1) { // WebSocket.OPEN = 1
      this.sendToClient(ws, { type: 'connected' });
    }

    ws.on('message', (data: Buffer) => {
      if (data[0] !== 0x7B) { // Not JSON, treat as binary audio
        // Audio frame from browser — relay to bridge + STT
        this.sendToBridge(data);
        this.userSTT.feed(data);
      } else {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'ping') {
            (ws as any).lastAppPing = Date.now();
            this.sendToClient(ws, { type: 'pong' });
          } else {
            this.handleClientControl(ws, msg);
          }
        } catch {
          // ignore parse errors
        }
      }
    });

    ws.on('close', () => {
      console.log('🎙️  Voice client disconnected');
      this.clients.delete(ws);
      if (this.clients.size === 0) {
        this.disconnectBridge();
        this.stopHeartbeat();
      }
    });

    ws.on('error', (err) => {
      console.error('🎙️  Voice client WS error:', err.message);
      this.clients.delete(ws);
    });
  }

  private handleClientControl(_ws: WebSocket, msg: Record<string, any>) {
    switch (msg.type) {
      case 'wake_on_lan':
        this.triggerWoL();
        break;
      default:
        // Forward JSON control messages to bridge
        this.sendToBridgeJson(msg);
        break;
    }
  }

  // ── Bridge connection ─────────────────────────────────────────────────────

  private ensureBridgeConnected() {
    if (this.bridgeWs && (
      this.bridgeWs.readyState === WebSocket.OPEN ||
      this.bridgeWs.readyState === WebSocket.CONNECTING
    )) {
      return;
    }
    this.connectBridge();
  }

  private connectBridge() {
    console.log(`🎙️  Connecting to Claude Bridge at ${CLAUDE_BRIDGE_URL}`);
    this.sendToAllClients({ type: 'personaplex_status', status: { state: 'waking' } });

    let bridge: WebSocket;
    try {
      bridge = new WebSocket(CLAUDE_BRIDGE_URL);
    } catch (err) {
      console.error('🎙️  Bridge WebSocket creation failed:', err);
      this.sendToAllClients({ type: 'error', message: 'Bridge unreachable' });
      return;
    }

    bridge.binaryType = 'nodebuffer';
    this.bridgeWs = bridge;

    bridge.on('open', () => {
      console.log('🎙️  Bridge connected');
      this.sendToAllClients({ type: 'connected' });
    });

    bridge.on('message', (data: Buffer) => {
      if (data[0] !== 0x7B) { // Not JSON, treat as binary audio
        // Audio from PersonaPlex — broadcast + STT
        this.nimSTT.feed(data as Buffer);
        for (const client of this.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(data, { binary: true });
          }
        }
      } else {
        try {
          const msg = JSON.parse(data.toString());
          this.handleBridgeMessage(msg);
        } catch {}
      }
    });

    bridge.on('close', () => {
      console.log('🎙️  Bridge disconnected');
      this.bridgeWs = null;
      if (this.clients.size > 0) {
        this.sendToAllClients({ type: 'error', message: 'Bridge connection lost' });
      }
    });

    bridge.on('error', (err) => {
      console.error('🎙️  Bridge WS error:', err.message);
      this.sendToAllClients({ type: 'error', message: `Bridge error: ${err.message}` });
    });
  }

  private disconnectBridge() {
    if (this.bridgeWs) {
      this.bridgeWs.close();
      this.bridgeWs = null;
    }
  }

  private handleBridgeMessage(msg: Record<string, any>) {
    // Translate bridge messages to frontend-friendly events
    switch (msg.type) {
      case 'transcript':
        this.sendToAllClients({
          type: 'transcript',
          speaker: msg.speaker === 'user' ? 'user' : 'nim',
          text: msg.text,
          partial: msg.partial ?? false,
        });
        break;
      case 'turn_start':
        this.sendToAllClients({ type: 'nim_thinking' });
        break;
      case 'turn_end':
        this.sendToAllClients({ type: 'user_speaking' });
        break;
      case 'vad_end':
        this.sendToAllClients({ type: 'user_speaking' });
        break;
      case 'interrupt':
        this.sendToAllClients({ type: 'user_speaking' });
        break;
      default:
        // Forward other events as-is
        this.sendToAllClients(msg);
        break;
    }
  }

  // ── Heartbeat (keeps PersonaPlex alive while clients connected) ─────────

  private startHeartbeat() {
    this.stopHeartbeat();
    console.log('🎙️  Starting voice-proxy heartbeat (10s interval)');
    // Immediate ping
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 10_000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      console.log('🎙️  Stopped voice-proxy heartbeat (no clients)');
    }
  }

  private async sendHeartbeat() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      await fetch(VOICE_PROXY_URL + '/heartbeat', { method: 'POST', signal: controller.signal });
      clearTimeout(timer);
    } catch {
      // Voice proxy unreachable — heartbeat lost, PP will auto-stop
    }
  }

  // ── Health polling ────────────────────────────────────────────────────────

  private startHealthPolling() {
    this.pollHealth();
    this.healthPollTimer = setInterval(() => this.pollHealth(), HEALTH_POLL_INTERVAL);
  }

  private autoStartAttempted = false;

  private async pollHealth() {
    const health = await this.fetchProxyHealth();
    if (!health) {
      // Voice proxy unreachable
      this.updateStatus({ state: 'offline' });
      return;
    }

    if (health.personaplex) {
      this.autoStartAttempted = false;
      const state: PersonaPlexState = this.bridgeWs?.readyState === WebSocket.OPEN ? 'active' : 'ready';
      this.updateStatus({ state });
      return;
    }

    if (health.turbo && !this.autoStartAttempted && this.clients.size > 0) {
      this.autoStartAttempted = true;
      this.updateStatus({ state: 'booting' });
      console.log('🎙️  Turbo is up but PersonaPlex not running — auto-starting...');
      this.startPersonaPlexSSH();
      return;
    }

    if (health.turbo) {
      this.updateStatus({ state: this.autoStartAttempted ? 'warming_up' : 'booting' });
    } else {
      this.updateStatus({ state: this.wolInProgress ? 'waking' : 'offline' });
    }
  }

  private async fetchProxyHealth(): Promise<{ state: string; personaplex: boolean; turbo: boolean } | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(VOICE_PROXY_URL + '/health', { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json() as { state: string; personaplex: boolean; turbo: boolean };
    } catch { return null; }
  }

  private async startPersonaPlexSSH(): Promise<void> {
    try {
      console.log('🎙️  Requesting PersonaPlex start via voice-proxy...');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(VOICE_PROXY_URL + '/start', { method: 'POST', signal: controller.signal });
      clearTimeout(timer);
      const data = await res.json() as { ok: boolean; error?: string };
      if (data.ok) {
        console.log('🎙️  PersonaPlex start command sent');
      } else {
        console.error('🎙️  PersonaPlex start failed:', data.error);
        this.autoStartAttempted = false;
      }
    } catch (e) {
      console.error('🎙️  Voice proxy /start error:', e);
      this.autoStartAttempted = false;
    }
  }

  private updateStatus(status: PersonaPlexStatus) {
    if (JSON.stringify(status) !== JSON.stringify(this.lastStatus)) {
      this.lastStatus = status;
      this.sendToAllClients({ type: 'personaplex_status', status });
    }
  }

  // ── Wake on LAN ───────────────────────────────────────────────────────────

  async triggerWoL(): Promise<void> {
    if (this.wolInProgress) return;
    this.wolInProgress = true;
    console.log('🎙️  Triggering WoL...');
    this.lastStatus = { state: 'waking' };
    this.sendToAllClients({ type: 'personaplex_status', status: { state: 'waking' } });

    try {
      const res = await fetch(VOICE_PROXY_URL + '/wol', { method: 'POST' });
      const data = await res.json() as { ok: boolean };
      if (data.ok) console.log('🎙️  WoL sent via voice-proxy');
      else console.error('🎙️  WoL failed');
      setTimeout(() => { this.wolInProgress = false; }, 30_000);
    } catch (e) {
      console.error('WoL proxy error:', e);
      this.wolInProgress = false;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private sendToClient(ws: WebSocket, msg: object) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private sendToAllClients(msg: object) {
    const payload = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  private sendToBridge(data: Buffer) {
    if (this.bridgeWs?.readyState === WebSocket.OPEN) {
      this.bridgeWs.send(data, { binary: true });
    }
  }

  private sendToBridgeJson(msg: object) {
    if (this.bridgeWs?.readyState === WebSocket.OPEN) {
      this.bridgeWs.send(JSON.stringify(msg));
    }
  }


  getStatus(): PersonaPlexStatus {
    return { ...this.lastStatus };
  }

  destroy() {
    if (this.healthPollTimer) clearInterval(this.healthPollTimer);
    if (this.clientPingTimer) clearInterval(this.clientPingTimer);
    this.stopHeartbeat();
    this.disconnectBridge();
    this.wss.close();
  }
}
