import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { aggregatePipelineHealth, MessageQueueCard } from './MessageQueueCard';
import { authenticatedFetch } from '../../utils/auth';

const navigate = vi.fn();
const subscribe = vi.fn(() => vi.fn());

vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('../../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe }) }));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function textContent(node: ReactTestInstance): string {
  return node.children.map((child: ReactTestInstance | string | number) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return textContent(child);
  }).join('');
}

const adapter = (overrides: Record<string, unknown> = {}) => ({
  source: 'hermes_sqlite',
  source_instance: 'runtime/default',
  status: 'healthy',
  reason_code: null,
  last_source_at: '2026-07-16T14:00:00.000Z',
  last_success_at: '2026-07-16T14:00:01.000Z',
  checked_at: '2026-07-16T14:00:02.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  subscribe.mockReturnValue(vi.fn());
});

describe('MessageQueueCard pipeline health', () => {
  test('aggregates mixed adapter outcomes without reporting the whole pipeline unavailable', () => {
    expect(aggregatePipelineHealth([])).toBe('unknown');
    expect(aggregatePipelineHealth([adapter(), adapter({ source: 'openclaw_jsonl' })])).toBe('healthy');
    expect(aggregatePipelineHealth([
      adapter(),
      adapter({ source: 'openclaw_jsonl', status: 'unavailable' }),
    ])).toBe('degraded');
    expect(aggregatePipelineHealth([
      adapter({ status: 'unauthorized' }),
      adapter({ source: 'openclaw_jsonl', status: 'unavailable' }),
    ])).toBe('unavailable');
  });

  test('renders actionable per-adapter reason and timestamps from the canonical endpoint', async () => {
    const fetchMock = vi.mocked(authenticatedFetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        sessions: [],
        activeSessions: 0,
        totalSessions: 0,
        connected: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        adapters: [
          adapter(),
          adapter({
            source: 'openclaw_jsonl',
            source_instance: 'gateway/default',
            status: 'degraded',
            reason_code: 'source_stale',
            last_source_at: null,
            last_success_at: null,
          }),
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<MessageQueueCard />);
      await settle();
      await settle();
    });

    const card = renderer!.root.findByProps({ 'data-pipeline-health': 'degraded' });
    const text = textContent(card);
    expect(text).toContain('Pipeline Degraded');
    expect(text).toContain('Hermes sqliteHealthy');
    expect(text).toContain('Openclaw jsonlDegraded');
    expect(text).toContain('source stale');
    expect(text).toContain('Last success: Never');
    expect(text).toContain('Source seen: Never');
    expect(renderer!.root.findAll(node => (
      typeof node.props.title === 'string' && /^Checked /.test(node.props.title)
    ))).toHaveLength(2);

    act(() => renderer!.unmount());
  });

  test('renders a stable explicit health error instead of the legacy gateway binary', async () => {
    const fetchMock = vi.mocked(authenticatedFetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        sessions: [],
        activeSessions: 0,
        totalSessions: 0,
        connected: true,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        error: 'pipeline_health_unavailable',
      }), { status: 503, headers: { 'content-type': 'application/json' } }));

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<MessageQueueCard />);
      await settle();
      await settle();
    });

    const text = textContent(renderer!.root);
    expect(text).toContain('Pipeline Unavailable');
    expect(text).toContain('Health details unavailable · pipeline health unavailable');
    expect(text).not.toContain('Gateway connected');
    expect(text).not.toContain('Gateway disconnected');

    act(() => renderer!.unmount());
  });
});
