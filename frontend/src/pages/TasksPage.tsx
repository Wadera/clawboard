import { authenticatedFetch } from '../utils/auth';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Plus, Archive, Search } from 'lucide-react';
import { Task } from '../types/task';
import { TaskColumn } from '../components/tasks/TaskColumn';
import { CreateTaskModal } from '../components/tasks/CreateTaskModal';
import { FilterBar, TaskFilters } from '../components/tasks/FilterBar';
import { Button } from '../components/Button';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import './TasksPage.css';

type ColumnKey = 'ideas' | 'todo' | 'in-progress' | 'stuck' | 'completed' | 'archived';

const COLUMNS: ColumnKey[] = ['ideas', 'todo', 'in-progress', 'stuck', 'completed', 'archived'];
const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = ['ideas', 'todo', 'in-progress', 'stuck', 'completed'];
const PER_COLUMN_INITIAL = 6;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
const FILTERS_STORAGE_KEY = 'clawboard-task-filters';

const COLUMN_LABELS: Record<ColumnKey, string> = {
  ideas: 'Ideas / Plans',
  todo: 'To Do',
  'in-progress': 'In Progress',
  stuck: 'Stuck / Review',
  completed: 'Completed',
  archived: 'Archived'
};

interface ColumnData {
  items: Task[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  loading: boolean;
}

interface FilterOptions {
  tags: string[];
  projects: string[];
}

const createEmptyColumn = (): ColumnData => ({
  items: [],
  total: 0,
  offset: 0,
  limit: PER_COLUMN_INITIAL,
  hasMore: false,
  loading: false,
});

export const resolveTaskDeepLinkId = (
  routeTaskId: string | undefined,
  searchParams: URLSearchParams,
): string | null => {
  const focusParam = searchParams.get('focus');
  const focusedTaskId = focusParam && !COLUMNS.includes(focusParam as ColumnKey)
    ? focusParam
    : null;

  return routeTaskId
    || searchParams.get('id')
    || searchParams.get('open')
    || searchParams.get('task')
    || focusedTaskId;
};

const loadFiltersFromStorage = (urlTag?: string | null): TaskFilters => {
  if (urlTag) {
    return { searchQuery: '', priorities: [], tags: [urlTag], projects: [] };
  }

  try {
    const stored = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch (error) {
    console.error('Failed to load filters from localStorage:', error);
  }

  return { searchQuery: '', priorities: [], tags: [], projects: [] };
};

const createInitialBoardState = (): Record<ColumnKey, ColumnData> => ({
  ideas: createEmptyColumn(),
  todo: createEmptyColumn(),
  'in-progress': createEmptyColumn(),
  stuck: createEmptyColumn(),
  completed: createEmptyColumn(),
  archived: createEmptyColumn(),
});

export const TasksPage: React.FC = () => {
  const { taskId: routeTaskId } = useParams<{ taskId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [boardData, setBoardData] = useState<Record<ColumnKey, ColumnData>>(createInitialBoardState);
  const [initialLoading, setInitialLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<ColumnKey>>(new Set(['ideas', 'archived']));
  const [mobileActiveTab, setMobileActiveTab] = useState<ColumnKey>('todo');
  const [isMobile, setIsMobile] = useState(false);
  const [filters, setFilters] = useState<TaskFilters>(() => loadFiltersFromStorage(searchParams.get('tag')));
  const [deepLinkTaskId, setDeepLinkTaskId] = useState<string | null>(null);
  const [searchPanelOpen, setSearchPanelOpen] = useState(() => {
    const initial = loadFiltersFromStorage(searchParams.get('tag'));
    return !!(initial.searchQuery || initial.priorities.length || initial.tags.length || initial.projects.length);
  });
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ tags: [], projects: [] });
  const [showArchived, setShowArchived] = useState(() => searchParams.get('focus') === 'archived');
  const autoCollapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevFilterCountRef = useRef<number>(0);
  const boardInnerRef = useRef<HTMLDivElement>(null);
  const scrollPositionRef = useRef<number>(0);
  const touchStartX = useRef<number>(0);
  const touchEndX = useRef<number>(0);
  const swipeFromEdge = useRef(false);
  const [sessionActivityMap, setSessionActivityMap] = useState<Map<string, number>>(new Map());
  const { subscribe } = useWebSocket();
  const { toasts, success, warning } = useToast();

  const visibleColumns = useMemo(
    () => (showArchived ? COLUMNS : DEFAULT_VISIBLE_COLUMNS),
    [showArchived]
  );

  const fetchedColumns = useMemo<ColumnKey[]>(
    () => (showArchived ? COLUMNS : [...DEFAULT_VISIBLE_COLUMNS, 'archived'] as ColumnKey[]),
    [showArchived]
  );

  const allLoadedTasks = useMemo(
    () => COLUMNS.flatMap(column => boardData[column].items),
    [boardData]
  );

  const activeFilterCount =
    (filters.searchQuery ? 1 : 0) +
    filters.priorities.length +
    filters.tags.length +
    filters.projects.length;

  const boardQueryKey = useMemo(() => JSON.stringify({
    showArchived,
    searchQuery: filters.searchQuery,
    priorities: filters.priorities,
    tags: filters.tags,
    projects: filters.projects,
  }), [showArchived, filters.searchQuery, filters.priorities, filters.tags, filters.projects]);

  const fetchBoardRef = useRef<((offsetOverrides?: Partial<Record<ColumnKey, number>>) => Promise<void>) | null>(null);

  const fetchFilterOptions = useCallback(async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/filter-options?includeArchived=true`);
      const data = await response.json();
      if (data.success) {
        setFilterOptions({ tags: data.tags || [], projects: data.projects || [] });
      }
    } catch (error) {
      console.error('Failed to fetch task filter options:', error);
    }
  }, []);

  const fetchBoard = useCallback(async (offsetOverrides?: Partial<Record<ColumnKey, number>>) => {
    const statuses: ColumnKey[] = fetchedColumns;
    const params = new URLSearchParams();
    params.set('statuses', statuses.join(','));
    params.set('perColumn', String(PER_COLUMN_INITIAL));
    params.set('includeArchived', showArchived ? 'true' : 'false');
    if (filters.searchQuery) params.set('q', filters.searchQuery);
    if (filters.priorities.length) params.set('priorities', filters.priorities.join(','));
    if (filters.tags.length) params.set('tags', filters.tags.join(','));
    if (filters.projects.length) params.set('projects', filters.projects.join(','));

    statuses.forEach((status) => {
      const offset = offsetOverrides?.[status] ?? 0;
      params.set(`offset_${status}`, String(offset));
    });

    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/board?${params.toString()}`);
      const data = await response.json();
      if (data.success) {
        setBoardData(prev => {
          const next = { ...prev };
          statuses.forEach((status: ColumnKey) => {
            const column = data.columns?.[status];
            next[status] = {
              items: column?.items || [],
              total: column?.total || 0,
              offset: column?.offset || 0,
              limit: column?.limit || PER_COLUMN_INITIAL,
              hasMore: column?.hasMore || false,
              loading: false,
            };
          });
          return next;
        });
      }
    } catch (error) {
      console.error('Failed to fetch board:', error);
    } finally {
      setInitialLoading(false);
    }
  }, [fetchedColumns, filters, showArchived]);

  const loadMoreColumn = useCallback(async (column: ColumnKey) => {
    const current = boardData[column];
    if (current.loading || !current.hasMore) return;

    setBoardData(prev => ({
      ...prev,
      [column]: { ...prev[column], loading: true },
    }));

    const params = new URLSearchParams();
    params.set('statuses', column);
    params.set('perColumn', String(PER_COLUMN_INITIAL));
    params.set('includeArchived', column === 'archived' ? 'true' : String(showArchived));
    params.set(`offset_${column}`, String(current.items.length));
    if (filters.searchQuery) params.set('q', filters.searchQuery);
    if (filters.priorities.length) params.set('priorities', filters.priorities.join(','));
    if (filters.tags.length) params.set('tags', filters.tags.join(','));
    if (filters.projects.length) params.set('projects', filters.projects.join(','));

    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/board?${params.toString()}`);
      const data = await response.json();
      if (data.success) {
        const incoming = data.columns?.[column];
        setBoardData(prev => ({
          ...prev,
          [column]: {
            items: [...prev[column].items, ...(incoming?.items || [])],
            total: incoming?.total || prev[column].total,
            offset: incoming?.offset || prev[column].offset,
            limit: incoming?.limit || prev[column].limit,
            hasMore: incoming?.hasMore || false,
            loading: false,
          },
        }));
      }
    } catch (error) {
      console.error(`Failed to load more tasks for ${column}:`, error);
      setBoardData(prev => ({
        ...prev,
        [column]: { ...prev[column], loading: false },
      }));
    }
  }, [boardData, filters, showArchived]);

  const refreshBoard = useCallback(async (showInitialLoader = false) => {
    if (showInitialLoader) setInitialLoading(true);
    await fetchBoard();
  }, [fetchBoard]);

  const handleBoardScroll = useCallback(() => {
    if (boardInnerRef.current) {
      scrollPositionRef.current = boardInnerRef.current.scrollLeft;
    }
  }, []);

  useEffect(() => {
    if (boardInnerRef.current && scrollPositionRef.current > 0) {
      boardInnerRef.current.scrollLeft = scrollPositionRef.current;
    }
  });

  useEffect(() => {
    fetchBoardRef.current = fetchBoard;
  }, [fetchBoard]);

  useEffect(() => {
    fetchFilterOptions();
  }, [fetchFilterOptions]);

  useEffect(() => {
    setInitialLoading(true);
    fetchBoardRef.current?.();
  }, [boardQueryKey]);

  const handleTaskCreated = useCallback((_msg: { task: Task }) => {
    refreshBoard();
  }, [refreshBoard]);

  const handleTaskUpdated = useCallback((msg: { task: Task }) => {
    const task = msg.task;
    if (task.needsReview && task.completedBy) {
      if (task.status === 'completed') success(`✅ Agent completed: ${task.title}`, 7000);
      else if (task.status === 'stuck') warning(`⚠️ Agent encountered issues: ${task.title}`, 7000);
    }
    refreshBoard();
  }, [refreshBoard, success, warning]);

  const handleTaskRemoved = useCallback(() => {
    refreshBoard();
  }, [refreshBoard]);

  const handleTasksUpdated = useCallback(() => {
    refreshBoard();
  }, [refreshBoard]);

  const handleGatewayQueueUpdate = useCallback((msg: { data: { sessions: Array<{ sessionKey: string; lastActivity: number }> } }) => {
    const map = new Map<string, number>();
    for (const s of msg.data?.sessions || []) {
      if (s.sessionKey && s.lastActivity) map.set(s.sessionKey, s.lastActivity);
    }
    setSessionActivityMap(map);
  }, []);

  useEffect(() => {
    const unsubs = [
      subscribe('task:created', handleTaskCreated),
      subscribe('task:updated', handleTaskUpdated),
      subscribe('task:deleted', handleTaskRemoved),
      subscribe('task:archived', handleTaskRemoved),
      subscribe('tasks:updated', handleTasksUpdated),
      subscribe('gateway:queue-update', handleGatewayQueueUpdate),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [subscribe, handleTaskCreated, handleTaskUpdated, handleTaskRemoved, handleTasksUpdated, handleGatewayQueueUpdate]);

  useEffect(() => {
    (async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE_URL}/gateway/queue`);
        const data = await response.json();
        if (data.sessions) {
          const map = new Map<string, number>();
          for (const s of data.sessions) {
            if (s.sessionKey && s.lastActivity) map.set(s.sessionKey, s.lastActivity);
          }
          setSessionActivityMap(map);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
      const currentTag = searchParams.get('tag');
      if (filters.tags.length === 1) {
        if (currentTag !== filters.tags[0]) {
          setSearchParams(prev => {
            prev.set('tag', filters.tags[0]);
            return prev;
          }, { replace: true });
        }
      } else if (filters.tags.length === 0 && currentTag) {
        setSearchParams(prev => {
          prev.delete('tag');
          return prev;
        }, { replace: true });
      }
    } catch (error) {
      console.error('Failed to save filters to localStorage:', error);
    }
  }, [filters, searchParams, setSearchParams]);

  const handleDeepLinkHandled = useCallback(() => {
    setDeepLinkTaskId(null);
  }, []);

  const handleTagClick = useCallback((tag: string) => {
    setFilters(prev => ({ ...prev, tags: [tag] }));
  }, []);

  const handleFiltersChange = useCallback((newFilters: TaskFilters) => {
    setFilters(newFilters);
  }, []);

  useEffect(() => {
    if (autoCollapseTimerRef.current) {
      clearTimeout(autoCollapseTimerRef.current);
      autoCollapseTimerRef.current = null;
    }
    const wasFiltered = prevFilterCountRef.current > 0;
    prevFilterCountRef.current = activeFilterCount;
    if (searchPanelOpen && activeFilterCount === 0 && wasFiltered) {
      autoCollapseTimerRef.current = setTimeout(() => {
        setSearchPanelOpen(false);
      }, 1500);
    }
    return () => {
      if (autoCollapseTimerRef.current) clearTimeout(autoCollapseTimerRef.current);
    };
  }, [searchPanelOpen, activeFilterCount]);

  const handleTagClickWithPanel = useCallback((tag: string) => {
    setSearchPanelOpen(true);
    handleTagClick(tag);
  }, [handleTagClick]);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 767);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    const focusColumn = searchParams.get('focus') as ColumnKey | null;
    if (focusColumn === 'archived') {
      setShowArchived(true);
      setCollapsedColumns(prev => {
        const next = new Set(prev);
        next.delete('archived');
        return next;
      });
    } else if (focusColumn && COLUMNS.includes(focusColumn)) {
      const columnsToCollapse = visibleColumns.filter(col => col !== focusColumn);
      setCollapsedColumns(new Set(columnsToCollapse));
      setTimeout(() => {
        const el = document.querySelector(`[data-status="${focusColumn}"]`);
        el?.scrollIntoView({ behavior: 'smooth', inline: 'center' });
      }, 200);
    }
  }, [searchParams, visibleColumns]);

  useEffect(() => {
    const idParam = resolveTaskDeepLinkId(routeTaskId, searchParams);
    if (!idParam || initialLoading) return;

    let cancelled = false;

    const focusTask = (target: Task) => {
      const taskColumn = (target.status === 'review' ? 'stuck' : target.status) as ColumnKey;
      if (taskColumn === 'archived') setShowArchived(true);
      setCollapsedColumns(prev => {
        const next = new Set(prev);
        next.delete(taskColumn);
        return next;
      });
      setMobileActiveTab(taskColumn);
      setDeepLinkTaskId(target.id);
    };

    const existing = allLoadedTasks.find(t => t.id === idParam || t.id.startsWith(idParam));
    if (existing) {
      focusTask(existing);
      if (!routeTaskId) {
        setSearchParams(prev => {
          prev.delete('id');
          prev.delete('open');
          prev.delete('task');
          return prev;
        }, { replace: true });
      }
      return;
    }

    (async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(idParam)}`);
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled || !data.success || !data.task) return;
        const target = data.task as Task;
        const taskColumn = (target.status === 'review' ? 'stuck' : target.status) as ColumnKey;
        setBoardData(prev => {
          const current = prev[taskColumn] || createEmptyColumn();
          if (current.items.some(t => t.id === target.id)) return prev;
          return {
            ...prev,
            [taskColumn]: {
              ...current,
              items: [target, ...current.items],
              total: Math.max(current.total, current.items.length + 1),
            },
          };
        });
        focusTask(target);
        if (!routeTaskId) {
          setSearchParams(prev => {
            prev.delete('id');
            prev.delete('open');
            prev.delete('task');
            return prev;
          }, { replace: true });
        }
      } catch (error) {
        console.error('Failed to resolve task deep link:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [routeTaskId, searchParams, allLoadedTasks, initialLoading, setSearchParams]);

  useEffect(() => {
    const handleKeyboard = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case 'n':
          e.preventDefault();
          setShowCreateModal(true);
          break;
        case 'arrowdown':
        case 'arrowup': {
          e.preventDefault();
          const cards = Array.from(document.querySelectorAll('.task-card')) as HTMLElement[];
          if (cards.length === 0) break;
          const currentIdx = cards.indexOf(document.activeElement as HTMLElement);
          const next = e.key === 'arrowdown'
            ? Math.min(currentIdx + 1, cards.length - 1)
            : Math.max(currentIdx - 1, 0);
          cards[next]?.focus();
          break;
        }
      }
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, []);

  const handleQuickAdd = async (status: string) => {
    const title = prompt('Task title:');
    if (!title?.trim()) return;
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), status, priority: 'normal' })
      });
      const data = await response.json();
      if (data.success) {
        await refreshBoard();
      }
    } catch (error) {
      console.error('Failed to quick-add task:', error);
    }
  };

  const handleCreateTask = async (taskData: Partial<Task>) => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskData)
      });
      const data = await response.json();
      if (data.success) {
        await refreshBoard();
        setShowCreateModal(false);
      }
    } catch (error) {
      console.error('Failed to create task:', error);
    }
  };

  const handleUpdateTask = async (taskId: string, updates: Partial<Task>) => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      const data = await response.json();
      if (data.success) {
        await refreshBoard();
      }
    } catch (error) {
      console.error('Failed to update task:', error);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm('Are you sure you want to delete this task?')) return;
    try {
      await authenticatedFetch(`${API_BASE_URL}/tasks/${taskId}`, { method: 'DELETE' });
      await refreshBoard();
    } catch (error) {
      console.error('Failed to delete task:', error);
    }
  };

  const handleSpawnTask = async (taskId: string) => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${taskId}/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      if (data.success) {
        await refreshBoard();
      } else {
        console.error('Failed to spawn task:', data.error);
        alert(`Failed to spawn: ${data.error}`);
      }
    } catch (error) {
      console.error('Failed to spawn task:', error);
      alert('Failed to spawn task');
    }
  };

  const handleDragStart = (task: Task) => setDraggedTask(task);
  const handleDragEnd = () => setDraggedTask(null);

  const handleDrop = (column: ColumnKey) => {
    if (!draggedTask) return;
    let updates: Partial<Task> = { status: column };
    // Drag between columns never changes autoStart - arming is explicit only.
    handleUpdateTask(draggedTask.id, updates);
    setDraggedTask(null);
  };

  const swipeEdgeZone = 40;
  const handleTouchStart = (e: React.TouchEvent) => {
    const x = e.touches[0].clientX;
    const screenW = window.innerWidth;
    swipeFromEdge.current = x < swipeEdgeZone || x > screenW - swipeEdgeZone;
    touchStartX.current = x;
    touchEndX.current = x;
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = () => {
    if (!swipeFromEdge.current) return;
    const diff = touchStartX.current - touchEndX.current;
    if (Math.abs(diff) < 50) return;
    const currentIdx = visibleColumns.indexOf(mobileActiveTab);
    if (diff > 0 && currentIdx < visibleColumns.length - 1) {
      setMobileActiveTab(visibleColumns[currentIdx + 1]);
    } else if (diff < 0 && currentIdx > 0) {
      setMobileActiveTab(visibleColumns[currentIdx - 1]);
    }
  };

  const handleMoveTask = async (taskId: string, targetStatus: string) => {
    await handleUpdateTask(taskId, { status: targetStatus as ColumnKey });
  };

  const handleToggleCollapse = (column: ColumnKey) => {
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      const wasCollapsed = next.has(column);
      if (wasCollapsed) {
        next.delete(column);
        setTimeout(() => {
          const el = document.querySelector(`[data-status="${column}"]`);
          el?.scrollIntoView({ behavior: 'smooth', inline: 'nearest' });
        }, 100);
      } else {
        next.add(column);
      }
      return next;
    });
  };

  const isColumnCollapsed = (column: ColumnKey): boolean => {
    if (isMobile && column === mobileActiveTab) return false;
    return collapsedColumns.has(column);
  };

  const visibleTaskCount = visibleColumns.reduce((sum, col) => sum + boardData[col].total, 0);
  const hiddenArchivedCount = showArchived ? 0 : boardData.archived.total;

  const handleRestoreArchived = async (taskId: string) => {
    await handleUpdateTask(taskId, { status: 'completed' as ColumnKey });
  };

  const revealArchivedColumn = () => {
    setShowArchived(true);
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      next.delete('archived');
      return next;
    });
    if (isMobile) setMobileActiveTab('archived');
    setTimeout(() => {
      const el = document.querySelector('[data-status="archived"]');
      el?.scrollIntoView({ behavior: 'smooth', inline: 'nearest' });
    }, 120);
  };

  const handleArchiveCompleted = async () => {
    const completedTasks = boardData.completed.items;
    if (completedTasks.length === 0) {
      alert('No completed tasks to archive');
      return;
    }
    if (!confirm(`Archive ${completedTasks.length} completed task(s)?`)) return;

    try {
      for (const t of completedTasks) {
        await authenticatedFetch(`${API_BASE_URL}/tasks/${t.id}/archive`, { method: 'POST' });
      }
      revealArchivedColumn();
      await refreshBoard();
    } catch (error) {
      console.error('Failed to archive tasks:', error);
    }
  };

  if (initialLoading) {
    return (
      <div className="page-loading">
        <div className="loading-spinner" />
        <span>Loading tasks...</span>
      </div>
    );
  }

  return (
    <div className="tasks-page-container fade-in">
      <ToastContainer toasts={toasts} />
      <div className="tasks-page-main">
        <div className="tasks-page-header">
          <div className="tasks-page-header-title">
            <h1>🧠 On My Mind</h1>
            <p>
              {visibleTaskCount} thing{visibleTaskCount !== 1 && 's'} in view{hiddenArchivedCount > 0 ? `, plus ${hiddenArchivedCount} archived` : ''}
            </p>
          </div>
          <div className="tasks-page-header-actions">
            <button
              className={`search-toggle-btn ${activeFilterCount > 0 ? 'has-filters' : ''} ${searchPanelOpen ? 'active' : ''}`}
              onClick={() => setSearchPanelOpen(!searchPanelOpen)}
              title={activeFilterCount > 0 ? `${activeFilterCount} filter(s) active` : 'Search & Filter'}
            >
              <Search size={18} />
              <span className="search-toggle-label">Search</span>
              {activeFilterCount > 0 && (
                <span className="search-toggle-badge">{activeFilterCount}</span>
              )}
            </button>

            <Button
              onClick={() => {
                if (showArchived) setShowArchived(false);
                else revealArchivedColumn();
              }}
              variant={showArchived ? 'primary' : 'secondary'}
              icon={<Archive size={18} />}
            >
              {showArchived ? 'Hide Archived' : hiddenArchivedCount > 0 ? `Show Archived (${hiddenArchivedCount})` : 'Show Archived'}
            </Button>

            <Button
              onClick={handleArchiveCompleted}
              variant="secondary"
              icon={<Archive size={18} />}
            >
              Archive Completed
            </Button>

            <Button
              onClick={() => setShowCreateModal(true)}
              variant="primary"
              icon={<Plus size={18} />}
            >
              New Task
            </Button>
          </div>
        </div>

        <div className={`search-filter-panel ${searchPanelOpen ? 'search-filter-panel-open' : ''}`}>
          <div className="search-filter-panel-inner">
            <FilterBar
              tasks={allLoadedTasks}
              filters={filters}
              onFiltersChange={handleFiltersChange}
              availableTags={filterOptions.tags}
              availableProjects={filterOptions.projects}
            />
          </div>
        </div>

        {isMobile && (
          <div className="tasks-mobile-tabs">
            {visibleColumns.map(column => {
              const count = boardData[column].total;
              return (
                <button
                  key={column}
                  className={`tasks-mobile-tab ${mobileActiveTab === column ? 'active' : ''}`}
                  onClick={() => setMobileActiveTab(column)}
                >
                  <span className="tasks-mobile-tab-label">{COLUMN_LABELS[column].split(' ')[0]}</span>
                  {count > 0 && <span className="tasks-mobile-tab-count">{count}</span>}
                </button>
              );
            })}
          </div>
        )}

        <div
          className="tasks-page-board"
          onTouchStart={isMobile ? handleTouchStart : undefined}
          onTouchMove={isMobile ? handleTouchMove : undefined}
          onTouchEnd={isMobile ? handleTouchEnd : undefined}
        >
          <div className="tasks-page-board-inner" ref={boardInnerRef} onScroll={handleBoardScroll}>
            {(isMobile ? [mobileActiveTab] : visibleColumns).map(column => (
              <TaskColumn
                key={column}
                status={column as any}
                title={COLUMN_LABELS[column]}
                tasks={boardData[column].items}
                total={boardData[column].total}
                hasMore={boardData[column].hasMore}
                loadingMore={boardData[column].loading}
                onLoadMore={() => loadMoreColumn(column)}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDrop={() => handleDrop(column)}
                onUpdateTask={handleUpdateTask}
                onDeleteTask={handleDeleteTask}
                onSpawnTask={handleSpawnTask}
                onQuickAdd={handleQuickAdd}
                collapsed={isColumnCollapsed(column)}
                onToggleCollapse={() => handleToggleCollapse(column)}
                isMobile={isMobile}
                onMoveTask={isMobile ? handleMoveTask : undefined}
                allColumns={visibleColumns}
                columnLabels={COLUMN_LABELS}
                onTagClick={handleTagClickWithPanel}
                sessionActivityMap={sessionActivityMap}
                deepLinkTaskId={deepLinkTaskId}
                onDeepLinkHandled={handleDeepLinkHandled}
                onRestoreArchived={column === 'archived' ? handleRestoreArchived : undefined}
              />
            ))}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <CreateTaskModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateTask}
          existingProjects={filterOptions.projects}
          existingTags={filterOptions.tags}
        />
      )}
    </div>
  );
};
