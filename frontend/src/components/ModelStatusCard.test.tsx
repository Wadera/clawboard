import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ModelStatusCard } from './ModelStatusCard';
import { authenticatedFetch } from '../utils/auth';

vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../contexts/ModelSwitchContext', () => ({
  useModelSwitch: () => ({ startSwitch: vi.fn(), completeSwitch: vi.fn() }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function textContent(node: ReactTestInstance): string {
  return node.children.map((child: ReactTestInstance | string | number) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return textContent(child);
  }).join('');
}

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const modelStatus = {
  success: true,
  activeModel: 'litellm/primary',
  activeProfile: null,
  profiles: {},
  authOrder: {},
  models: {
    primary: 'litellm/primary',
    fallbacks: [],
    available: [{ id: 'litellm/primary', provider: 'litellm', alias: 'Primary' }],
  },
};

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('ModelStatusCard LiteLLM insights', () => {
  test('fetches and renders health plus spend dimensions without exposing full long identifiers', async () => {
    const fetchMock = vi.mocked(authenticatedFetch);
    fetchMock
      .mockResolvedValueOnce(response(modelStatus))
      .mockResolvedValueOnce(response({
        success: true,
        status: 'degraded',
        healthyCount: 1,
        unhealthyCount: 1,
        checkedAt: '2026-07-16T21:00:00.000Z',
        checks: [
          { id: 'primary', model: 'provider/primary', status: 'healthy' },
          { id: 'fallback', model: 'provider/fallback', status: 'unhealthy' },
        ],
      }))
      .mockResolvedValueOnce(response({
        success: true,
        startDate: '2026-06-17',
        endDate: '2026-07-16',
        totalSpend: 12.345,
        requests: 42,
        inputTokens: 100,
        outputTokens: 50,
        byModel: [{ id: 'provider/primary', spend: 10, requests: 30, inputTokens: 80, outputTokens: 40 }],
        byKey: [{ id: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', spend: 2, requests: 10, inputTokens: 15, outputTokens: 8 }],
        byUser: [{ id: 'agent-one', spend: 0.345, requests: 2, inputTokens: 5, outputTokens: 2 }],
        truncated: true,
      }));

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ModelStatusCard />);
      await settle();
      await settle();
    });

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/models/status',
      '/api/litellm/health',
      '/api/litellm/spend',
    ]);
    const insights = renderer!.root.findByProps({ 'data-testid': 'litellm-insights' });
    const text = textContent(insights);
    expect(text).toContain('Degraded');
    expect(text).toContain('1 healthy · 1 unhealthy');
    expect(text).toContain('$12.35');
    expect(text).toContain('42 requests');
    expect(text).toContain('Models');
    expect(text).toContain('Keys');
    expect(text).toContain('Users');
    expect(text).toContain('0123456789…abcdef');
    expect(text).not.toContain('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    expect(text).toContain('Partial result: query limit reached');

    act(() => renderer!.unmount());
  });

  test('keeps spend visible when the independent health request fails', async () => {
    const fetchMock = vi.mocked(authenticatedFetch);
    fetchMock
      .mockResolvedValueOnce(response(modelStatus))
      .mockResolvedValueOnce(response({ success: false, error: 'health adapter disabled' }, 503))
      .mockResolvedValueOnce(response({
        success: true,
        startDate: '2026-07-01', endDate: '2026-07-16', totalSpend: 0,
        requests: 0, inputTokens: 0, outputTokens: 0,
        byModel: [], byKey: [], byUser: [], truncated: false,
      }));

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ModelStatusCard />);
      await settle();
      await settle();
    });

    const text = textContent(renderer!.root.findByProps({ 'data-testid': 'litellm-insights' }));
    expect(text).toContain('$0.0000');
    expect(text).toContain('LiteLLM health unavailable (HTTP 503)');
    expect(text).toContain('No usage');

    act(() => renderer!.unmount());
  });
});
