import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { PrivateAudioPlayerProvider, usePrivateAudioPlayer } from './PrivateAudioPlayer';
import { authenticatedFetch } from '../utils/auth';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const track = { artifactId: 'article-audio', reportId: 'report-1', title: 'Morning Briefing', subtitle: 'Article narration' };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function Loader() { const player = usePrivateAudioPlayer(); return <button onClick={() => player.load(track)}>Load</button>; }
const loadButton = (root: ReactTestInstance) => root.findAllByType('button').find(button => button.children.includes('Load'))!;

beforeEach(() => { vi.resetAllMocks(); });

describe('PrivateAudioPlayerProvider mobile lifecycle', () => {
  test('keeps one mounted audio node and direct private stream across background lifecycle events', async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:stable-private-audio' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const documentEvents = new EventTarget();
    const windowEvents = new EventTarget();
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentEvents });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: windowEvents });
    const audio = { currentTime: 42, duration: 120, playbackRate: 1, paused: false, play: vi.fn(() => Promise.resolve()), pause: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };

    let renderer: ReactTestRenderer;
    act(() => { renderer = create(<PrivateAudioPlayerProvider><Loader /></PrivateAudioPlayerProvider>, { createNodeMock: element => element.type === 'audio' ? audio : null }); });
    await act(async () => { loadButton(renderer.root).props.onClick(); await settle(); });
    const before: ReactTestInstance = renderer!.root.findByType('audio');
    act(() => {
      documentEvents.dispatchEvent(new Event('visibilitychange'));
      windowEvents.dispatchEvent(new Event('pagehide'));
      windowEvents.dispatchEvent(new Event('pageshow'));
    });
    const after = renderer!.root.findByType('audio');
    expect(after).toBe(before);
    expect(after.props.src).toBe('/api/content-engine/v1/daily-reports/report-1/artifacts/article-audio');
    expect(audio.currentTime).toBe(42);
    expect(audio.pause).not.toHaveBeenCalled();
    expect(authenticatedFetch).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    act(() => renderer!.unmount());
  });

  test('registers private-safe Media Session play pause seek and position handlers', async () => {
    type Handler = (details?: { seekOffset?: number; seekTime?: number; fastSeek?: boolean }) => void;
    const handlers = new Map<string, Handler>();
    const mediaSession = {
      metadata: null as unknown,
      playbackState: 'none',
      setActionHandler: vi.fn((action: string, handler: Handler | null) => handler ? handlers.set(action, handler) : handlers.delete(action)),
      setPositionState: vi.fn(),
    };
    class TestMediaMetadata { constructor(public readonly init: MediaMetadataInit) {} }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaSession } });
    Object.defineProperty(globalThis, 'MediaMetadata', { configurable: true, value: TestMediaMetadata });
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:private-audio' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const listeners = new Map<string, () => void>();
    const audio = { currentTime: 40, duration: 120, playbackRate: 1, paused: true, play: vi.fn(() => Promise.resolve()), pause: vi.fn(), fastSeek: vi.fn(), addEventListener: vi.fn((name: string, handler: () => void) => listeners.set(name, handler)), removeEventListener: vi.fn() };

    let renderer: ReactTestRenderer;
    act(() => { renderer = create(<PrivateAudioPlayerProvider><Loader /></PrivateAudioPlayerProvider>, { createNodeMock: element => element.type === 'audio' ? audio : null }); });
    await act(async () => { loadButton(renderer.root).props.onClick(); await settle(); });
    const metadata = mediaSession.metadata as TestMediaMetadata;
    expect(metadata.init).toMatchObject({ title: 'Morning Briefing', artist: 'Article narration', album: 'NimSpace Content Engine' });
    expect(JSON.stringify(metadata.init)).not.toMatch(/report-1|article-audio|blob:/);
    handlers.get('play')?.(); handlers.get('pause')?.(); handlers.get('seekbackward')?.({ seekOffset: 15 });
    expect(audio.currentTime).toBe(25);
    handlers.get('seekforward')?.({ seekOffset: 20 });
    expect(audio.currentTime).toBe(45);
    handlers.get('seekto')?.({ seekTime: 75, fastSeek: true });
    listeners.get('durationchange')?.();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.fastSeek).toHaveBeenCalledWith(75);
    expect(mediaSession.setPositionState).toHaveBeenCalled();
    act(() => renderer!.unmount());
  });
});
