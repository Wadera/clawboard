/**
 * VoicePage — Real-time full-duplex voice chat with Nim via PersonaPlex
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  Thermometer,
  Cpu,
  Power,
  Loader,
  PhoneOff,
} from 'lucide-react';
import { auth } from '../utils/auth';
import './VoicePage.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

type PersonaPlexState =
  | 'unknown'
  | 'offline'
  | 'waking'
  | 'booting'
  | 'warming_up'
  | 'ready'
  | 'active'
  | 'idle';

interface TranscriptEntry {
  id: string;
  speaker: 'user' | 'nim';
  text: string;
  timestamp: number;
  partial?: boolean;
}

interface PersonaPlexStatus {
  state: PersonaPlexState;
  gpuTemp?: number;
  vramUsed?: number;
  vramTotal?: number;
}

function getVoiceWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const token = auth.getToken();
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${protocol}//${host}${API_BASE}/voice${tokenParam}`;
}

// ─── NimOrb Canvas Animation ──────────────────────────────────────────────────

interface NimOrbProps {
  state: 'idle' | 'listening' | 'speaking' | 'thinking' | 'disconnected';
  size?: number;
}

function NimOrb({ state, size = 220 }: NimOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const phaseRef = useRef(0);
  const pulseRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const animate = () => {
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const r = (size / 2) * 0.68;

      ctx.clearRect(0, 0, w, h);
      phaseRef.current += state === 'speaking' ? 0.07 : state === 'listening' ? 0.03 : 0.015;
      pulseRef.current += 0.05;

      const colors: Record<string, [string, string, string]> = {
        idle:         ['#0891b2', '#06b6d4', '#22d3ee'],
        listening:    ['#059669', '#10b981', '#34d399'],
        speaking:     ['#7c3aed', '#8b5cf6', '#a78bfa'],
        thinking:     ['#d97706', '#f59e0b', '#fbbf24'],
        disconnected: ['#374151', '#4b5563', '#6b7280'],
      };
      const [c1, c2, c3] = colors[state] ?? colors.idle;

      // Outer glow
      const gi = state === 'speaking'
        ? 0.5 + 0.5 * Math.sin(pulseRef.current * 2)
        : state === 'listening' ? 0.3 + 0.2 * Math.sin(pulseRef.current) : 0.15;
      const glow = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 1.6);
      glow.addColorStop(0, c2 + Math.round(gi * 80).toString(16).padStart(2, '0'));
      glow.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.6, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();

      // Blob
      const pts = 8;
      ctx.beginPath();
      for (let i = 0; i <= pts; i++) {
        const angle = (i / pts) * Math.PI * 2;
        const wobble = state !== 'disconnected'
          ? 1 + 0.09 * Math.sin(angle * 3 + phaseRef.current) * (state === 'speaking' ? 2.2 : 1)
          : 1;
        const px = cx + Math.cos(angle) * r * wobble;
        const py = cy + Math.sin(angle) * r * wobble;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      const grad = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, 0, cx, cy, r);
      grad.addColorStop(0, c3); grad.addColorStop(0.5, c2); grad.addColorStop(1, c1);
      ctx.fillStyle = grad;
      ctx.fill();

      // Shine
      const shine = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, 0, cx, cy, r);
      shine.addColorStop(0, 'rgba(255,255,255,0.35)');
      shine.addColorStop(0.4, 'rgba(255,255,255,0.08)');
      shine.addColorStop(1, 'transparent');
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = shine; ctx.fill();

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [state, size]);

  return (
    <canvas ref={canvasRef} width={size} height={size}
      className="nim-orb-canvas" style={{ width: size, height: size }} />
  );
}

// ─── PersonaPlex Status Badge ─────────────────────────────────────────────────

function PersonaPlexBadge({ status, onWoL }: { status: PersonaPlexStatus; onWoL: () => void }) {
  const map: Record<PersonaPlexState, { label: string; color: string }> = {
    unknown:    { label: 'Unknown',    color: '#6b7280' },
    offline:    { label: 'Offline',    color: '#ef4444' },
    waking:     { label: 'Waking…',   color: '#f59e0b' },
    booting:    { label: 'Booting…',  color: '#f59e0b' },
    warming_up: { label: 'Warming Up', color: '#f59e0b' },
    ready:      { label: 'Ready',      color: '#10b981' },
    active:     { label: 'Active',     color: '#8b5cf6' },
    idle:       { label: 'Idle',       color: '#6b7280' },
  };
  const info = map[status.state] ?? map.unknown;
  const spinning = ['waking', 'booting', 'warming_up'].includes(status.state);

  return (
    <div className="pplex-badge">
      <div className="pplex-row">
        <span className="pplex-dot" style={{ background: info.color }} />
        <span className="pplex-name">PersonaPlex</span>
        <span className="pplex-state-label" style={{ color: info.color }}>
          {spinning && <Loader size={12} className="spin-icon" />}
          {info.label}
        </span>
        {status.state === 'offline' && (
          <button className="wol-btn" onClick={onWoL}><Power size={12} /> Wake</button>
        )}
      </div>
      {(status.gpuTemp !== undefined || status.vramUsed !== undefined) && (
        <div className="pplex-stats">
          {status.gpuTemp !== undefined && (
            <span><Thermometer size={11} /> {status.gpuTemp}°C</span>
          )}
          {status.vramUsed !== undefined && status.vramTotal !== undefined && (
            <span><Cpu size={11} /> {status.vramUsed}/{status.vramTotal} GB</span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Transcript ───────────────────────────────────────────────────────────────

function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [entries]);
  if (entries.length === 0) return null;
  return (
    <div className="voice-transcript">
      {entries.map(e => (
        <div key={e.id} className={`tx-entry tx-${e.speaker}${e.partial ? ' tx-partial' : ''}`}>
          <span className="tx-who">{e.speaker === 'nim' ? '🌀 Nim' : '👤 You'}</span>
          <span className="tx-text">{e.text}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

// ─── Main VoicePage ───────────────────────────────────────────────────────────

export function VoicePage() {
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const [ppStatus, setPPStatus] = useState<PersonaPlexStatus>({ state: 'unknown' });
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [statusText, setStatusText] = useState('Press Connect to start');
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  const [volume, setVolume] = useState(0.8);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [orbState, setOrbState] = useState<NimOrbProps['state']>('disconnected');

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  // Playback handled by ring-buffer AudioWorklet

  // ── Playback via ring-buffer AudioWorklet ──────────────────────────────────

  const playbackWorkletRef = useRef<AudioWorkletNode | null>(null);
  const playbackReadyRef = useRef(false);

  const initPlayback = useCallback(async () => {
    const ctx = audioCtxRef.current;
    if (!ctx || playbackReadyRef.current) return;
    const src = `
      class PlaybackProc extends AudioWorkletProcessor {
        constructor() {
          super();
          this.ring = new Float32Array(96000);
          this.writePos = 0;
          this.readPos = 0;
          this.port.onmessage = (e) => {
            const i16 = new Int16Array(e.data);
            for (let i = 0; i < i16.length; i++) {
              this.ring[this.writePos % this.ring.length] = i16[i] / 32768;
              this.writePos++;
            }
          };
        }
        process(inputs, outputs) {
          const out = outputs[0][0];
          if (!out) return true;
          for (let i = 0; i < out.length; i++) {
            if (this.readPos < this.writePos) {
              out[i] = this.ring[this.readPos % this.ring.length];
              this.readPos++;
            } else {
              out[i] = 0;
            }
          }
          return true;
        }
      }
      registerProcessor('playback-proc', PlaybackProc);
    `;
    const blobUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    try { await ctx.audioWorklet.addModule(blobUrl); } catch (_) { /* already registered */ }
    URL.revokeObjectURL(blobUrl);
    const worklet = new AudioWorkletNode(ctx, 'playback-proc', { outputChannelCount: [1] });
    worklet.connect(gainRef.current ?? ctx.destination);
    playbackWorkletRef.current = worklet;
    playbackReadyRef.current = true;
  }, []);

  const enqueue = useCallback((ab: ArrayBuffer) => {
    const worklet = playbackWorkletRef.current;
    if (worklet) {
      worklet.port.postMessage(ab, [ab]);
      setOrbState('speaking');
    }
  }, []);

  // ── WS message handler ───────────────────────────────────────────────────────

  const onMsg = useCallback((ev: MessageEvent) => {
    if (ev.data instanceof ArrayBuffer) { enqueue(ev.data); return; }
    if (ev.data instanceof Blob) { ev.data.arrayBuffer().then(enqueue); return; }
    try {
      const m = JSON.parse(ev.data);
      switch (m.type) {
        case 'connected':
          setConnState('connected');
          setStatusText('Connected — just start talking');
          setOrbState('listening');
          break;
        case 'personaplex_status':
          setPPStatus(m.status);
          if (['waking','booting','warming_up'].includes(m.status.state)) {
            setStatusText(`PersonaPlex ${m.status.state.replace('_',' ')}…`);
            setOrbState('thinking');
          } else if (['ready','active'].includes(m.status.state)) {
            setStatusText('Listening…');
            setOrbState('listening');
          } else if (m.status.state === 'offline') {
            setStatusText('PersonaPlex offline — click Wake to start it');
          }
          break;
        case 'transcript':
          setTranscript(prev => {
            const base = m.partial ? prev.filter(e => !(e.speaker === m.speaker && e.partial)) : prev;
            return [...base, { id: `${m.speaker}-${Date.now()}`, speaker: m.speaker, text: m.text, timestamp: Date.now(), partial: m.partial }];
          });
          break;
        case 'nim_thinking': setStatusText('Nim is thinking…'); setOrbState('thinking'); break;
        case 'nim_speaking': setStatusText('Nim is speaking…'); setOrbState('speaking'); break;
        case 'user_speaking': setStatusText('Listening…'); setOrbState('listening'); break;
        case 'error': setStatusText(`Error: ${m.message}`); setOrbState('disconnected'); break;
      }
    } catch {}
  }, [enqueue]);

  // ── Disconnect ───────────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    workletRef.current?.disconnect();
    workletRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setConnState('disconnected');
    setOrbState('disconnected');
    setStatusText('Disconnected');
  }, []);

  // ── Connect ──────────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    if (connState === 'connecting' || connState === 'connected') return;
    setConnState('connecting');
    setStatusText('Connecting…');
    setOrbState('thinking');

    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AudioContext({ sampleRate: 24000 });
        const g = audioCtxRef.current.createGain();
        g.gain.value = volume;
        g.connect(audioCtxRef.current.destination);
        gainRef.current = g;
      }
      if (audioCtxRef.current.state === 'suspended') await audioCtxRef.current.resume();
    } catch (e) { console.error('AudioContext:', e); }

    await initPlayback();

    const ws = new WebSocket(getVoiceWsUrl());
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    ws.onopen = () => {
      setStatusText('WebSocket open — waiting for PersonaPlex…');
      // App-level keepalive ping every 20s
      const pingId = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 20_000);
      (ws as any)._pingId = pingId;
    };
    ws.onmessage = onMsg;
    ws.onerror = () => { setConnState('error'); setOrbState('disconnected'); setStatusText('Connection error'); };
    ws.onclose = () => { if ((ws as any)._pingId) clearInterval((ws as any)._pingId); setConnState('disconnected'); setOrbState('disconnected'); wsRef.current = null; };
  }, [connState, onMsg, volume, initPlayback]);

  // ── Microphone ───────────────────────────────────────────────────────────────

  const startMic = useCallback(async () => {
    const ctx = audioCtxRef.current;
    if (!ctx || connState !== 'connected') return;
    // Prevent duplicate mic streams
    if (streamRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 24000, channelCount: 1 }
      });
      streamRef.current = stream;
      const processorSrc = `
        class PCMProc extends AudioWorkletProcessor {
          process(inputs) {
            const ch = inputs[0]?.[0];
            if (ch) {
              const i16 = new Int16Array(ch.length);
              for (let i = 0; i < ch.length; i++) i16[i] = Math.max(-32768, Math.min(32767, ch[i] * 32768));
              this.port.postMessage(i16.buffer, [i16.buffer]);
            }
            return true;
          }
        }
        registerProcessor('pcm-proc', PCMProc);
      `;
      const blobUrl = URL.createObjectURL(new Blob([processorSrc], { type: 'application/javascript' }));
      if (!workletRef.current) {
        try { await ctx.audioWorklet.addModule(blobUrl); } catch (_) { /* already registered */ }
      }
      URL.revokeObjectURL(blobUrl);
      const src = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, 'pcm-proc');
      workletRef.current = worklet;
      worklet.port.onmessage = (e: MessageEvent) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN && !mutedRef.current) ws.send(e.data);
      };
      src.connect(worklet);
    } catch (e) {
      console.error('Mic:', e);
      setStatusText('Microphone access denied');
    }
  }, [connState]);

  useEffect(() => { if (connState === 'connected') startMic(); }, [connState, startMic]);

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = speakerMuted ? 0 : volume;
  }, [volume, speakerMuted]);

  useEffect(() => () => { disconnect(); audioCtxRef.current?.close(); }, [disconnect]);

  // ── WoL ─────────────────────────────────────────────────────────────────────

  const sendWoL = useCallback(async () => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'wake_on_lan' }));
    } else {
      try {
        const res = await fetch(`${API_BASE}/voice/wol`, {
          method: 'POST', headers: { Authorization: `Bearer ${auth.getToken()}` }
        });
        setStatusText(res.ok ? 'Wake-on-LAN sent…' : 'WoL failed');
      } catch { setStatusText('WoL failed — connect first'); }
    }
  }, []);

  const isConnected = connState === 'connected';
  const isConnecting = connState === 'connecting';

  return (
    <div className="voice-page">
      {/* Header */}
      <div className="voice-header">
        <h1 className="voice-title"><span>🌀</span> Voice Chat</h1>
        <div className={`voice-conn-pill conn-${connState}`}>
          {isConnected ? <Wifi size={14} /> : isConnecting ? <Loader size={14} className="spin-icon" /> : <WifiOff size={14} />}
          <span>{isConnected ? 'Live' : isConnecting ? 'Connecting' : connState === 'error' ? 'Error' : 'Offline'}</span>
        </div>
      </div>

      {/* Stage */}
      <div className="voice-stage">
        <div className="voice-orb-area">
          <NimOrb state={orbState} size={220} />
          <p className="voice-status-txt">{statusText}</p>
        </div>
        <PersonaPlexBadge status={ppStatus} onWoL={sendWoL} />
      </div>

      {/* Transcript */}
      <Transcript entries={transcript} />

      {/* Controls */}
      <div className="voice-controls">
        <button className={`vctrl-btn mic-btn${muted ? ' muted' : ''}`}
          onClick={() => setMuted(m => !m)} disabled={!isConnected} title={muted ? 'Unmute' : 'Mute mic'}>
          {muted ? <MicOff size={20} /> : <Mic size={20} />}
          <span>{muted ? 'Muted' : 'Live'}</span>
        </button>

        {isConnected ? (
          <button className="vctrl-btn hangup-btn" onClick={disconnect}>
            <PhoneOff size={20} /><span>End</span>
          </button>
        ) : (
          <button className="vctrl-btn connect-btn" onClick={connect} disabled={isConnecting}>
            {isConnecting ? <Loader size={20} className="spin-icon" /> : <Mic size={20} />}
            <span>{isConnecting ? 'Connecting…' : 'Connect'}</span>
          </button>
        )}

        <button className={`vctrl-btn spkr-btn${speakerMuted ? ' muted' : ''}`}
          onClick={() => setSpeakerMuted(m => !m)} title="Toggle speaker">
          {speakerMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
          <span>{speakerMuted ? 'Muted' : 'Speaker'}</span>
        </button>

        <div className="vol-wrap">
          <Volume2 size={13} />
          <input type="range" min={0} max={1} step={0.05} value={volume}
            onChange={e => setVolume(parseFloat(e.target.value))}
            className="vol-slider" title="Volume" />
        </div>
      </div>
    </div>
  );
}
