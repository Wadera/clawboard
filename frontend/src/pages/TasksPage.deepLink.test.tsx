import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { authenticatedFetch } from '../utils/auth';
import { resolveTaskDeepLinkId, TasksPage } from './TasksPage';

const taskId = '8ede2a98-de8f-4cfb-9e74-5891d545d6d9';
const searchParams = new URLSearchParams(`focus=${taskId}`);
const setSearchParams = vi.fn();
const subscribe = vi.fn(() => vi.fn());

vi.mock('react-router-dom', () => ({
  useParams: () => ({}),
  useSearchParams: () => [searchParams, setSearchParams],
}));
vi.mock('../utils/auth', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe }) }));
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ toasts: [], success: vi.fn(), warning: vi.fn() }),
}));
vi.mock('../components/tasks/TaskColumn', () => ({
  TaskColumn: ({
    status,
    tasks,
    deepLinkTaskId,
  }: {
    status: string;
    tasks: Array<{ id: string }>;
    deepLinkTaskId: string | null;
  }) => (
    <div
      data-status={status}
      data-task-detail-open={Boolean(deepLinkTaskId && tasks.some(task => task.id === deepLinkTaskId))}
    />
  ),
}));
vi.mock('../components/tasks/CreateTaskModal', () => ({ CreateTaskModal: () => null }));
vi.mock('../components/tasks/FilterBar', () => ({ FilterBar: () => null }));
vi.mock('../components/Toast', () => ({ ToastContainer: () => null }));

const boardResponse = {
  success: true,
  columns: Object.fromEntries(
    ['ideas', 'todo', 'in-progress', 'stuck', 'completed', 'archived']
      .map(status => [status, { items: [], total: 0, offset: 0, limit: 6, hasMore: false }]),
  ),
};
const focusedTask = { id: taskId, title: 'Focused task', status: 'todo', priority: 'normal', tags: [] };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetAllMocks();
  subscribe.mockReturnValue(vi.fn());
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: 1280,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { querySelector: vi.fn(() => null) },
  });

  vi.mocked(authenticatedFetch).mockImplementation(async input => {
    const url = String(input);
    if (url.includes('/tasks/filter-options')) {
      return new Response(JSON.stringify({ success: true, tags: [], projects: [] }), { status: 200 });
    }
    if (url.includes('/tasks/board?')) {
      return new Response(JSON.stringify(boardResponse), { status: 200 });
    }
    if (url.endsWith(`/tasks/${taskId}`)) {
      return new Response(JSON.stringify({ success: true, task: focusedTask }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
});

async function renderLoadedPage(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(<TasksPage />);
    await settle();
    await settle();
    await settle();
  });
  return renderer!;
}

function openTaskDetails(renderer: ReactTestRenderer) {
  return renderer.root.findAll(node => node.props['data-task-detail-open'] === true);
}

describe('TasksPage task deep-link resolution', () => {
  test('opens the focused task after board data loads on direct navigation and a fresh remount', async () => {
    const directNavigation = await renderLoadedPage();
    expect(openTaskDetails(directNavigation)).toHaveLength(1);
    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(`/api/tasks/${taskId}`);
    act(() => directNavigation.unmount());

    vi.mocked(authenticatedFetch).mockClear();
    const refreshedNavigation = await renderLoadedPage();
    expect(openTaskDetails(refreshedNavigation)).toHaveLength(1);
    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(`/api/tasks/${taskId}`);
    act(() => refreshedNavigation.unmount());
  });

  test.each(['ideas', 'todo', 'in-progress', 'stuck', 'completed', 'archived'])(
    'keeps focus=%s reserved for board-column navigation',
    column => {
      expect(resolveTaskDeepLinkId(undefined, new URLSearchParams(`focus=${column}`))).toBeNull();
    },
  );

  test('preserves existing route and query aliases ahead of focus', () => {
    const params = new URLSearchParams(`id=id-alias&open=open-alias&task=task-alias&focus=${taskId}`);
    expect(resolveTaskDeepLinkId('route-id', params)).toBe('route-id');
    expect(resolveTaskDeepLinkId(undefined, params)).toBe('id-alias');
  });

  test('returns null when no task deep-link parameter is present', () => {
    expect(resolveTaskDeepLinkId(undefined, new URLSearchParams())).toBeNull();
  });
});
