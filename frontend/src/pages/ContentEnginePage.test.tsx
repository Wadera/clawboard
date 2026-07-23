import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ContentEnginePage } from './ContentEnginePage';
import { authenticatedFetch } from '../utils/auth';
import { PrivateMediaLifecycle } from '../utils/privateMediaLifecycle';
import { PrivateAudioPlayerProvider } from '../contexts/PrivateAudioPlayer';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));

const report = (reportId: string, title = 'Morning report') => ({
  report_id: reportId,
  run_id: `run-${reportId}`,
  report_date: '2026-07-14',
  title,
  state: 'complete',
  generated_at: '2026-07-14T06:00:00Z',
  items: [],
  artifacts: [{
    artifact_id: 'local-audio',
    kind: 'audio',
    media_type: 'audio/ogg',
    provider: 'qwen-serena',
    status: 'available',
  }],
});

const listResponse = (data: unknown[]) => new Response(JSON.stringify({ data, page: {} }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});
const audioResponse = (bytes: number[]) => new Response(new Uint8Array(bytes), {
  status: 200,
  headers: { 'content-type': 'audio/ogg' },
});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const buttonWithText = (root: ReactTestInstance, text: string) => root.findAllByType('button').find(button => button.children.includes(text));
const page = () => <PrivateAudioPlayerProvider><ContentEnginePage /></PrivateAudioPlayerProvider>;

beforeEach(() => {
  vi.resetAllMocks();
});

describe('PrivateMediaLifecycle', () => {
  test('newer loads win and explicit replacement revokes the previous URL', () => {
    const revoked: string[] = [];
    let count = 0;
    const lifecycle = new PrivateMediaLifecycle({
      create: () => `blob:test-${++count}`,
      revoke: url => revoked.push(url),
    });
    const stale = lifecycle.begin('audio');
    const current = lifecycle.begin('audio');
    expect(lifecycle.install(stale, new Blob(['old']))).toBeNull();
    expect(lifecycle.install(current, new Blob(['current']))).toBe('blob:test-1');
    expect(lifecycle.install(lifecycle.begin('audio'), new Blob(['replacement']))).toBe('blob:test-2');
    expect(revoked).toEqual(['blob:test-1']);
  });

  test('clear cancels requests and revokes every installed URL', () => {
    const revoked: string[] = [];
    const lifecycle = new PrivateMediaLifecycle({
      create: () => 'blob:current',
      revoke: url => revoked.push(url),
    });
    lifecycle.install(lifecycle.begin('audio'), new Blob(['current']));
    const pending = lifecycle.begin('image');
    lifecycle.clear();
    expect(lifecycle.install(pending, new Blob(['late']))).toBeNull();
    expect(revoked).toEqual(['blob:current']);
  });
});

describe('ContentEnginePage private player lifecycle', () => {
  test('recognises the stable NotebookLM artifact id when legacy provider metadata is absent', async () => {
    const withoutProviders = {
      ...report('report-1'),
      article: { headline: 'Morning report', sections: [] },
      notebooklm: { notebook_url: 'https://notebooklm.google.com/notebook/example', private: true as const },
      artifacts: [
        { artifact_id: 'local-narration', kind: 'audio', media_type: 'audio/mpeg', status: 'available' },
        { artifact_id: 'notebooklm-deep-dive', kind: 'audio', media_type: 'audio/mpeg', status: 'available' },
      ],
    };
    vi.mocked(authenticatedFetch).mockResolvedValue(listResponse([withoutProviders]));

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(page());
      await settle();
    });

    const cards = renderer!.root.findAllByProps({ className: 'ce-audio-card' });
    expect(cards).toHaveLength(2);
    expect(cards[0].findByType('strong').children).toContain('Article narration');
    expect(cards[1].findByType('strong').children).toContain('NotebookLM deep dive');
    expect(cards[0].findAllByType('button')).toHaveLength(1);
    expect(cards[1].findAllByType('button')).toHaveLength(1);
    expect(cards[1].findAllByType('span')).toHaveLength(0);

    act(() => renderer!.unmount());
  });

  test('keeps the direct audio stream across harmless refresh, then clears it on edition switch', async () => {
    const fetchMock = vi.mocked(authenticatedFetch);
    let listCall = 0;
    fetchMock.mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/auth/media-session')) return new Response(null, { status: 204 });
      listCall += 1;
      if (listCall === 1) return listResponse([report('report-1')]);
      if (listCall === 2) return listResponse([report('report-1', 'Refreshed metadata')]);
      return listResponse([report('report-2')]);
    });
    const createUrl = vi.fn()
      .mockReturnValueOnce('blob:article-1')
      .mockReturnValueOnce('blob:article-2');
    const revokeUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(page());
      await settle();
    });
    const load = buttonWithText(renderer!.root, 'Load private audio');
    expect(load).toBeDefined();
    await act(async () => {
      load!.props.onClick();
      await settle();
    });
    const before = renderer!.root.findByType('audio');
    expect(before.props.src).toBe('/api/content-engine/v1/daily-reports/report-1/artifacts/local-audio');

    const refresh = renderer!.root.findByProps({ className: 'ce-refresh' });
    await act(async () => {
      refresh.props.onClick();
      await settle();
    });
    const after = renderer!.root.findByType('audio');
    expect(after).toBe(before);
    expect(after.props.src).toBe('/api/content-engine/v1/daily-reports/report-1/artifacts/local-audio');
    expect(revokeUrl).not.toHaveBeenCalled();

    const reload = buttonWithText(renderer!.root, 'Reload private audio');
    await act(async () => {
      reload!.props.onClick();
      await settle();
    });
    expect(renderer!.root.findByType('audio').props.src).toBe('/api/content-engine/v1/daily-reports/report-1/artifacts/local-audio');
    expect(revokeUrl).not.toHaveBeenCalled();

    await act(async () => {
      refresh.props.onClick();
      await settle();
    });
    expect(renderer!.root.findByType('audio')).toBe(before);
    expect(renderer!.root.findByType('audio').props.src).toBeUndefined();

    act(() => renderer!.unmount());
    expect(revokeUrl).not.toHaveBeenCalled();
  });

  test('unmount leaves no browser object URL because playback uses a direct stream', async () => {
    const fetchMock = vi.mocked(authenticatedFetch);
    fetchMock.mockImplementation(async input => String(input).includes('/auth/media-session')
      ? new Response(null, { status: 204 })
      : listResponse([report('report-1')])
    );
    const revokeUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:unmount' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(page());
      await settle();
    });
    await act(async () => {
      buttonWithText(renderer!.root, 'Load private audio')!.props.onClick();
      await settle();
    });
    expect(renderer!.root.findByType('audio').props.src).toBe('/api/content-engine/v1/daily-reports/report-1/artifacts/local-audio');

    act(() => renderer!.unmount());
    expect(revokeUrl).not.toHaveBeenCalled();
  });

  test('a pending mounted-page load cannot install media after a report switch', async () => {
    const fetchMock = vi.mocked(authenticatedFetch);
    let resolveArtifact!: (response: Response) => void;
    const pendingArtifact = new Promise<Response>(resolve => { resolveArtifact = resolve; });
    fetchMock.mockImplementation(async input => String(input).includes('/auth/media-session')
      ? pendingArtifact
      : listResponse([report('report-1'), report('report-2')])
    );
    const createUrl = vi.fn(() => 'blob:late');
    const revokeUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(page());
      await settle();
    });
    act(() => {
      buttonWithText(renderer!.root, 'Load private audio')!.props.onClick();
    });
    await act(async () => {
      renderer!.root.findAllByProps({ role: 'listitem' })[1].props.onClick();
      resolveArtifact(audioResponse([9, 9, 9]));
      await settle();
      await settle();
    });

    expect(renderer!.root.findAllByType('audio')).toHaveLength(1);
    expect(renderer!.root.findByType('audio').props.src).toBeUndefined();
    expect(createUrl).not.toHaveBeenCalled();
    expect(revokeUrl).not.toHaveBeenCalled();
    act(() => renderer!.unmount());
  });
});
