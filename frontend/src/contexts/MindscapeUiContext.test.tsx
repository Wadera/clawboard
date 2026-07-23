import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { MindscapeUiProvider, useMindscapeUi } from './MindscapeUiContext';
import { authenticatedFetch } from '../utils/auth';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const byLabel = (root: ReactTestInstance, label: string) => root.findAllByType('button').find(button => button.props['aria-label'] === label);

function JournalHarness() {
  const { openMindscape } = useMindscapeUi();
  const navigate = useNavigate();
  return <><span data-route="journal"/><button onClick={openMindscape}>Open player</button><button onClick={() => navigate('/dashboard')}>Go dashboard</button></>;
}

function DashboardHarness() {
  return <span data-route="dashboard"/>;
}

function audioNode() {
  const node = {
    paused: true, src: '', currentTime: 12, duration: 120, playbackRate: 1, muted: false,
    play: vi.fn(async () => { node.paused = false; }),
    pause: vi.fn(() => { node.paused = true; }),
    load: vi.fn(),
  };
  return node;
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    activeElement: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaSession: {
    metadata: null,
    playbackState: 'none',
    setActionHandler: vi.fn(),
    setPositionState: vi.fn(),
  } } });
  Object.defineProperty(globalThis, 'MediaMetadata', { configurable: true, value: class { constructor(public init: MediaMetadataInit) {} } });
});

describe('MindscapeUiProvider route ownership', () => {
  test('actual route transition preserves the same playing audio node/source until provider unmount', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async (input: string) => String(input).endsWith('/audio')
      ? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
      : new Response(JSON.stringify({ tracks: [{ entry_id:'entry-1',run_key:'run-1',date:'2026-07-15',title:'Persistent route track',visibility:'private' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const revokeUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:route-persistent') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
    const node = audioNode();
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <MemoryRouter initialEntries={['/journal']}>
          <MindscapeUiProvider>
            <Routes>
              <Route path="/journal" element={<JournalHarness/>}/>
              <Route path="/dashboard" element={<DashboardHarness/>}/>
            </Routes>
          </MindscapeUiProvider>
        </MemoryRouter>,
        { createNodeMock: (element: { type: unknown }) => element.type === 'audio' ? node : { focus: vi.fn(), closest: vi.fn(() => null) } },
      );
      await settle();
    });
    await act(async () => { renderer!.root.findByType(JournalHarness).findAllByType('button')[0].props.onClick(); await settle(); });
    await act(async () => { byLabel(renderer!.root, 'Play Daily Mindscape')!.props.onClick(); await settle(); await settle(); });
    const liveElement = renderer!.root.findByType('audio');
    const pausesBeforeRoute = node.pause.mock.calls.length;
    await act(async () => { renderer!.root.findByType(JournalHarness).findAllByType('button')[1].props.onClick(); await settle(); });
    expect(renderer!.root.findByProps({ 'data-route': 'dashboard' })).toBeTruthy();
    expect(renderer!.root.findByType('audio')).toBe(liveElement);
    expect(node.src).toBe('blob:route-persistent');
    expect(node.paused).toBe(false);
    expect(node.pause).toHaveBeenCalledTimes(pausesBeforeRoute);
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(revokeUrl).not.toHaveBeenCalled();
    act(() => renderer!.unmount());
    expect(revokeUrl).toHaveBeenCalledWith('blob:route-persistent');
  });
});
