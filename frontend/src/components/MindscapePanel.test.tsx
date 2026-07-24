import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { MindscapePanel } from './MindscapePanel';
import { authenticatedFetch } from '../utils/auth';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const playlistResponse = (tracks = [{
  entry_id: 'entry-1', run_key: 'run-1', date: '2026-07-15',
  title: 'A quiet blue morning', visibility: 'private' as const,
}]) => new Response(JSON.stringify({ tracks }), { status: 200, headers: { 'content-type': 'application/json' } });
const audioResponse = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
const buttonByLabel = (root: ReactTestInstance, label: string) => root.findAllByType('button').find(button => button.props['aria-label'] === label);
let documentListeners: Record<string, Set<(event: unknown) => void>>;
let mediaSession: { metadata: unknown; setActionHandler: ReturnType<typeof vi.fn>; setPositionState: ReturnType<typeof vi.fn>; playbackState: MediaSessionPlaybackState };

beforeEach(() => {
  vi.resetAllMocks();
  documentListeners = {};
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    activeElement: null,
    visibilityState: 'visible',
    addEventListener: vi.fn((name: string, handler: (event: unknown) => void) => (documentListeners[name] ||= new Set()).add(handler)),
    removeEventListener: vi.fn((name: string, handler: (event: unknown) => void) => documentListeners[name]?.delete(handler)),
  } });
  mediaSession = { metadata: null, setActionHandler: vi.fn(), setPositionState: vi.fn(), playbackState: 'none' };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaSession } });
  Object.defineProperty(globalThis, 'MediaMetadata', { configurable: true, value: class { constructor(public init: MediaMetadataInit) {} } });
});

function audioNode() {
  const node = {
    paused: true, src: '', currentTime: 18, duration: 120, playbackRate: 1, muted: false,
    play: vi.fn(async () => { node.paused = false; }),
    pause: vi.fn(() => { node.paused = true; }),
    load: vi.fn(),
  };
  return node;
}

function mountNode(node: ReturnType<typeof audioNode>, onClose = () => undefined) {
  return create(<MemoryRouter><MindscapePanel open onClose={onClose} /></MemoryRouter>, {
    createNodeMock: (element: { type: unknown }) => element.type === 'audio' ? node : { focus: vi.fn(), closest: vi.fn(() => null) },
  });
}

describe('MindscapePanel playback ownership', () => {
  test('polling rerenders preserve the active audio node, source, playback and fetch count', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async (input: string) => String(input).endsWith('/audio') ? audioResponse() : playlistResponse());
    const createUrl = vi.fn(() => 'blob:mindscape-1');
    const revokeUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
    const node = audioNode();
    const panel = (tick: number) => <MemoryRouter><div data-poll-tick={tick}/><MindscapePanel open onClose={() => void tick}/></MemoryRouter>;
    let renderer: ReactTestRenderer;
    await act(async () => { renderer = create(panel(0), { createNodeMock: (element: { type: unknown }) => element.type === 'audio' ? node : { focus: vi.fn(), closest: vi.fn(() => null) } }); await settle(); });
    await act(async () => { buttonByLabel(renderer!.root, 'Play Daily Mindscape')!.props.onClick(); await settle(); await settle(); });
    const liveElement = renderer!.root.findByType('audio');
    const pauses = node.pause.mock.calls.length;
    for (let tick = 1; tick <= 3; tick += 1) await act(async () => { renderer!.update(panel(tick)); await settle(); });
    expect(renderer!.root.findByType('audio')).toBe(liveElement);
    expect(node.src).toBe('blob:mindscape-1');
    expect(node.paused).toBe(false);
    expect(node.pause).toHaveBeenCalledTimes(pauses);
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(revokeUrl).not.toHaveBeenCalled();
    act(() => renderer!.unmount());
    expect(revokeUrl).toHaveBeenCalledTimes(1);
  });

  test('visibility and page lifecycle signals do not tear down lock-screen playback', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async (input: string) => String(input).endsWith('/audio') ? audioResponse() : playlistResponse());
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:background' });
    const revokeUrl = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
    const node = audioNode();
    let renderer: ReactTestRenderer;
    await act(async () => { renderer = mountNode(node); await settle(); });
    await act(async () => { buttonByLabel(renderer!.root, 'Play Daily Mindscape')!.props.onClick(); await settle(); await settle(); });
    const pauses = node.pause.mock.calls.length;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    documentListeners.visibilitychange?.forEach(handler => handler({ type: 'visibilitychange' }));
    globalThis.dispatchEvent?.(new Event('pagehide'));
    await act(async () => { renderer!.update(<MemoryRouter><MindscapePanel open onClose={() => undefined}/></MemoryRouter>); await settle(); });
    expect(node.paused).toBe(false);
    expect(node.src).toBe('blob:background');
    expect(node.pause).toHaveBeenCalledTimes(pauses);
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(revokeUrl).not.toHaveBeenCalled();
    act(() => renderer!.unmount());
  });

  test('publishes private-safe Media Session metadata/actions and cleans every handler', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async (input: string) => String(input).endsWith('/audio') ? audioResponse() : playlistResponse());
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:media-session' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const node = audioNode();
    let renderer: ReactTestRenderer;
    await act(async () => { renderer = mountNode(node); await settle(); });
    const metadata = mediaSession.metadata as { init: MediaMetadataInit };
    expect(metadata.init).toMatchObject({ title: 'A quiet blue morning', artist: 'Daily Mindscape', album: 'Private journal soundscape' });
    expect(JSON.stringify(metadata)).not.toContain('run-1');
    expect(JSON.stringify(metadata)).not.toContain('/journal/mindscape/');
    const installed = new Map<MediaSessionAction, MediaSessionActionHandler>(
      mediaSession.setActionHandler.mock.calls
        .filter((call: unknown[]) => call[1])
        .map((call: unknown[]) => [call[0] as MediaSessionAction, call[1] as MediaSessionActionHandler] as const),
    );
    for (const action of ['play','pause','previoustrack','nexttrack','seekto','seekbackward','seekforward'] as MediaSessionAction[]) expect(installed.get(action)).toBeTypeOf('function');
    await act(async () => { await installed.get('play')!({ action: 'play' }); await settle(); await settle(); });
    expect(node.src).toBe('blob:media-session');
    act(() => renderer!.root.findByType('audio').props.onPlay());
    expect(mediaSession.playbackState).toBe('playing');
    act(() => {
      renderer!.root.findByType('audio').props.onDurationChange({ currentTarget: { duration: 120 } });
      renderer!.root.findByType('audio').props.onTimeUpdate({ currentTarget: { currentTime: 42 } });
    });
    expect(mediaSession.setPositionState).toHaveBeenLastCalledWith({ duration: 120, playbackRate: 1, position: 42 });
    act(() => installed.get('pause')!({ action: 'pause' }));
    act(() => renderer!.root.findByType('audio').props.onPause());
    expect(mediaSession.playbackState).toBe('paused');
    const clearsBeforeUnmount = mediaSession.setPositionState.mock.calls.filter(call => call.length === 0).length;
    act(() => renderer!.unmount());
    expect(mediaSession.setPositionState.mock.calls.filter(call => call.length === 0).length).toBeGreaterThan(clearsBeforeUnmount);
    const cleared = new Map<MediaSessionAction, null>(
      mediaSession.setActionHandler.mock.calls
        .filter((call: unknown[]) => call[1] === null)
        .map((call: unknown[]) => [call[0] as MediaSessionAction, null] as const),
    );
    for (const action of installed.keys()) expect(cleared.get(action)).toBeNull();
    expect(mediaSession.metadata).toBeNull();
    expect(mediaSession.playbackState).toBe('none');
  });

  test('track switch revokes the old source while panel close and route UI unmount preserve playback until provider unmount', async () => {
    const tracks = [
      { entry_id:'entry-1',run_key:'run-1',date:'2026-07-15',title:'Current',visibility:'private' as const },
      { entry_id:'entry-2',run_key:'run-2',date:'2026-07-14',title:'Earlier',visibility:'private' as const },
    ];
    vi.mocked(authenticatedFetch).mockImplementation(async (input: string) => String(input).endsWith('/audio') ? audioResponse() : playlistResponse(tracks));
    const createUrl = vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
    const revokeUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
    const node = audioNode();
    const panel = (open: boolean) => <MemoryRouter><MindscapePanel open={open} onClose={() => undefined}/></MemoryRouter>;
    let renderer: ReactTestRenderer;
    await act(async () => { renderer = create(panel(true), { createNodeMock: (element: { type: unknown }) => element.type === 'audio' ? node : { focus: vi.fn(), closest: vi.fn(() => null) } }); await settle(); });
    await act(async () => { buttonByLabel(renderer!.root, 'Play Daily Mindscape')!.props.onClick(); await settle(); await settle(); });
    act(() => renderer!.root.findByType('audio').props.onDurationChange({ currentTarget: { duration: 120 } }));
    const clearsBeforeSwitch = mediaSession.setPositionState.mock.calls.filter(call => call.length === 0).length;
    act(() => renderer!.root.findByProps({ 'aria-expanded': false }).props.onClick());
    await act(async () => { renderer!.root.findAllByProps({ role: 'listitem' })[1].findByType('button').props.onClick(); await settle(); await settle(); });
    expect(node.src).toBe('blob:second');
    expect(mediaSession.setPositionState.mock.calls.filter(call => call.length === 0).length).toBeGreaterThan(clearsBeforeSwitch);
    expect(revokeUrl).toHaveBeenNthCalledWith(1, 'blob:first');
    await act(async () => { renderer!.update(panel(false)); await settle(); });
    expect(renderer!.root.findByType('audio')).toBeTruthy();
    expect(node.paused).toBe(false);
    expect(node.src).toBe('blob:second');
    expect(revokeUrl).toHaveBeenCalledTimes(1);
    act(() => renderer!.unmount());
    expect(revokeUrl).toHaveBeenNthCalledWith(2, 'blob:second');
    expect(revokeUrl).toHaveBeenCalledTimes(2);
  });
});
