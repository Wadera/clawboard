import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { authenticatedFetch } from '../utils/auth';

const API = import.meta.env.VITE_API_BASE_URL || '/api';
const BASE = `${API}/content-engine/v1/daily-reports`;

export type PrivateAudioTrack = {
  artifactId: string;
  reportId: string;
  title: string;
  subtitle: string;
};

type ActiveTrack = PrivateAudioTrack & { src: string };

type PrivateAudioPlayerValue = {
  active: ActiveTrack | null;
  busy: boolean;
  error: string;
  load: (track: PrivateAudioTrack) => Promise<void>;
  clear: () => void;
};

const PrivateAudioPlayerContext = createContext<PrivateAudioPlayerValue | null>(null);

export function PrivateAudioPlayerProvider({ children }: { children: ReactNode }) {
  const sequence = useRef(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [active, setActive] = useState<ActiveTrack | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const clear = useCallback(() => {
    sequence.current += 1;
    setActive(null);
    setBusy(false);
    setError('');
  }, []);

  const load = useCallback(async (track: PrivateAudioTrack) => {
    const requestSequence = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const response = await authenticatedFetch(`${API}/auth/media-session`, { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (requestSequence !== sequence.current) return;
      const src = `${BASE}/${encodeURIComponent(track.reportId)}/artifacts/${encodeURIComponent(track.artifactId)}`;
      setActive({ ...track, src });
    } catch {
      if (requestSequence === sequence.current) {
        setError('Private audio is temporarily unavailable.');
      }
    } finally {
      if (requestSequence === sequence.current) setBusy(false);
    }
  }, []);

  useEffect(() => () => {
    sequence.current += 1;
  }, []);

  useEffect(() => {
    if (!active || !audioRef.current || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const audio = audioRef.current;
    const session = navigator.mediaSession;
    const actions: MediaSessionAction[] = ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'];
    const setAction = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Browsers expose different subsets of Media Session actions.
      }
    };
    const seek = (delta: number) => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
      audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + delta));
    };
    const updateSessionState = () => {
      session.playbackState = audio.paused ? 'paused' : 'playing';
      if (!Number.isFinite(audio.duration) || audio.duration <= 0 || !Number.isFinite(audio.currentTime)) return;
      try {
        session.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate || 1,
          position: Math.min(audio.duration, Math.max(0, audio.currentTime)),
        });
      } catch {
        // Position state is optional and rejected by some partial implementations.
      }
    };

    session.metadata = new MediaMetadata({
      title: active.title,
      artist: active.subtitle,
      album: 'NimSpace Content Engine',
      artwork: [
        { src: `${import.meta.env.BASE_URL || '/dashboard/'}nim-favicon.png`, sizes: '64x64', type: 'image/png' },
      ],
    });
    setAction('play', () => { void audio.play().catch(() => undefined); });
    setAction('pause', () => audio.pause());
    setAction('seekbackward', details => seek(-(details.seekOffset || 10)));
    setAction('seekforward', details => seek(details.seekOffset || 10));
    setAction('seekto', details => {
      if (details.seekTime === undefined) return;
      const target = Math.max(0, Math.min(Number.isFinite(audio.duration) ? audio.duration : details.seekTime, details.seekTime));
      const seekableAudio = audio as HTMLAudioElement & { fastSeek?: (time: number) => void };
      if (details.fastSeek && seekableAudio.fastSeek) seekableAudio.fastSeek(target);
      else audio.currentTime = target;
    });
    audio.addEventListener('play', updateSessionState);
    audio.addEventListener('pause', updateSessionState);
    audio.addEventListener('timeupdate', updateSessionState);
    audio.addEventListener('durationchange', updateSessionState);
    updateSessionState();

    return () => {
      audio.removeEventListener('play', updateSessionState);
      audio.removeEventListener('pause', updateSessionState);
      audio.removeEventListener('timeupdate', updateSessionState);
      audio.removeEventListener('durationchange', updateSessionState);
      for (const action of actions) setAction(action, null);
      session.metadata = null;
      session.playbackState = 'none';
    };
  }, [active]);

  return (
    <PrivateAudioPlayerContext.Provider value={{ active, busy, error, load, clear }}>
      {children}
      <aside className="private-audio-player" hidden={!active} aria-label="Private audio player">
        <div>
          <strong>{active?.title}</strong>
          <span>{active?.subtitle}</span>
        </div>
        <audio ref={audioRef} controls preload="metadata" src={active?.src} />
        <button type="button" onClick={clear} aria-label="Close private audio player">Close</button>
        {error && <small role="alert">{error}</small>}
      </aside>
    </PrivateAudioPlayerContext.Provider>
  );
}

export function usePrivateAudioPlayer(): PrivateAudioPlayerValue {
  const value = useContext(PrivateAudioPlayerContext);
  if (!value) throw new Error('usePrivateAudioPlayer must be used inside PrivateAudioPlayerProvider');
  return value;
}
