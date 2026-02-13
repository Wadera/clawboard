import { authenticatedFetch } from '../utils/auth';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Archive } from 'lucide-react';
import { Task } from '../types/task';
import { TaskColumn } from '../components/tasks/TaskColumn';
import { CreateTaskModal } from '../components/tasks/CreateTaskModal';
import { FilterBar, TaskFilters } from '../components/tasks/FilterBar';
import { Button } from '../components/Button';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import './TasksPage.css';

// Phase 4: 6-Column Kanban
type ColumnKey = 'ideas' | 'todo' | 'in-progress' | 'stuck' | 'completed' | 'archived';

const COLUMNS: ColumnKey[] = ['ideas', 'todo', 'in-progress', 'stuck', 'completed', 'archived'];

const COLUMN_LABELS: Record<ColumnKey, string> = {
  'ideas': 'Ideas / Plans',
  'todo': 'To Do',
  'in-progress': 'In Progress',
  'stuck': 'Stuck / Review',
  'completed': 'Completed',
  'archived': 'Archived'
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
const FILTERS_STORAGE_KEY = 'clawboard-task-filters';

const loadFiltersFromStorage = (urlTag?: string | null): TaskFilters => {
  // If URL has tag param, use it and ignore storage
  if (urlTag) {
    return {
      searchQuery: '',
      priorities: [],
      tags: [urlTag],
      projects: []
    };
  }
  
  try {
    const stored = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error('Failed to load filters from localStorage:', error);
  }
  return {
    searchQuery: '',
    priorities: [],
    tags: [],
    projects: []
  };
};

export const TasksPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<ColumnKey>>(new Set(['ideas', 'archived']));
  const [mobileActiveTab, setMobileActiveTab] = useState<ColumnKey>('todo');
  const [isMobile, setIsMobile] = useState(false);
  const [_quickAddStatus, _setQuickAddStatus] = useState<ColumnKey | null>(null);
  const [_selectedCardIndex, _setSelectedCardIndex] = useState(-1);
  const [filters, setFilters] = useState<TaskFilters>(() => loadFiltersFromStorage(searchParams.get('tag')));
  const boardRef = useRef<HTMLDivElement>(null);
  const boardInnerRef = useRef<HTMLDivElement>(null);
  const scrollPositionRef = useRef<number>(0);
  const touchStartX = useRef<number>(0);
  const touchEndX = useRef<number>(0);
  const { subscribe } = useWebSocket();
  const { toasts, success, warning } = useToast();

  // Save scroll position continuously
  const handleBoardScroll = useCallback(() => {
    if (boardInnerRef.current) {
      scrollPositionRef.current = boardInnerRef.current.scrollLeft;
    }
  }, []);

  // Restore scroll position after every re-render
  useEffect(() => {
    if (boardInnerRef.current && scrollPositionRef.current > 0) {
      boardInnerRef.current.scrollLeft = scrollPositionRef.current;
    }
  });

  // Real-time task updates via WebSocket
  const handleTaskCreated = useCallback((msg: { task: Task }) => {
    setTasks(prev => {
      if (prev.some(t => t.id === msg.task.id)) return prev;
      return [...prev, msg.task];
    });
  }, []);

  const handleTaskUpdated = useCallback((msg: { task: Task }) => {
    setTasks(prev => {
      const oldTask = prev.find(t => t.id === msg.task.id);
      
      // Check if this task was just completed by an agent
      if (msg.task.needsReview && 
          msg.task.completedBy && 
          !oldTask?.completedBy) {
        // Agent just completed this task!
        if (msg.task.status === 'completed') {
          success(`✅ Agent completed: ${msg.task.title}`, 7000);
        } else if (msg.task.status === 'stuck') {
          warning(`⚠️ Agent encountered issues: ${msg.task.title}`, 7000);
        }
      }
      
      return prev.map(t => t.id === msg.task.id ? msg.task : t);
    });
  }, [success, warning]);

  const handleTaskRemoved = useCallback((msg: { id: string }) => {
    setTasks(prev => prev.filter(t => t.id !== msg.id));
  }, []);

  const handleTasksUpdated = useCallback((msg: { tasks: Task[] }) => {
    setTasks(msg.tasks);
  }, []);

  useEffect(() => {
    const unsubs = [
      subscribe('task:created', handleTaskCreated),
      subscribe('task:updated', handleTaskUpdated),
      subscribe('task:deleted', handleTaskRemoved),
      subscribe('task:archived', handleTaskRemoved),
      subscribe('tasks:updated', handleTasksUpdated),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [subscribe, handleTaskCreated, handleTaskUpdated, handleTaskRemoved, handleTasksUpdated]);

  // Persist filters to localStorage and sync URL params
  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
      
      // Sync tag filter to URL params
      const currentTag = searchParams.get('tag');
      if (filters.tags.length === 1) {
        // Single tag filter - update URL
        if (currentTag !== filters.tags[0]) {
          setSearchParams(prev => {
            prev.set('tag', filters.tags[0]);
            return prev;
          }, { replace: true });
        }
      } else if (filters.tags.length === 0 && currentTag) {
        // No tags - remove from URL
        setSearchParams(prev => {
          prev.delete('tag');
          return prev;
        }, { replace: true });
      }
      // Multiple tags - don't update URL (too complex)
    } catch (error) {
      console.error('Failed to save filters to localStorage:', error);
    }
  }, [filters, searchParams, setSearchParams]);

  // Handle tag click from task cards
  const handleTagClick = useCallback((tag: string) => {
    setFilters(prev => ({
      ...prev,
      tags: [tag] // Set single tag filter (replaces any existing)
    }));
  }, []);

  // Detect mobile
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 767);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyboard = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case 'n':
          e.preventDefault();
          setShowCreateModal(true);
          break;
        case 'e': {
          // Focus the edit button of the currently focused card
          const focused = document.activeElement;
          if (focused?.classList.contains('task-card')) {
            const editBtn = focused.querySelector('.task-card-edit') as HTMLButtonElement;
            editBtn?.click();
          }
          break;
        }
        case 'delete':
        case 'backspace': {
          const focused = document.activeElement;
          if (focused?.classList.contains('task-card')) {
            const deleteBtn = focused.querySelector('.task-card-delete') as HTMLButtonElement;
            deleteBtn?.click();
          }
          break;
        }
        case 'arrowdown':
        case 'arrowup': {
          e.preventDefault();
          const cards = Array.from(document.querySelectorAll('.task-card')) as HTMLElement[];
          if (cards.length === 0) break;
          const currentIdx = cards.indexOf(document.activeElement as HTMLElement);
          const next = e.key === 'ArrowDown'
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

  // Quick add handler
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
        setTasks(prev => [...prev, data.task]);
      }
    } catch (error) {
      console.error('Failed to quick-add task:', error);
    }
  };

  // Load tasks from API
  useEffect(() => {
    fetchTasks();
  }, []);

  const fetchTasks = async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks`);
      const data = await response.json();
      if (data.success) {
        setTasks(data.tasks);
      }
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
    } finally {
      setLoading(false);
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
        setTasks([...tasks, data.task]);
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
        setTasks(tasks.map(t => t.id === taskId ? data.task : t));
      }
    } catch (error) {
      console.error('Failed to update task:', error);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm('Are you sure you want to delete this task?')) return;
    
    try {
      await authenticatedFetch(`${API_BASE_URL}/tasks/${taskId}`, { method: 'DELETE' });
      setTasks(tasks.filter(t => t.id !== taskId));
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
        // Update local state - task moved to in-progress with activeAgent
        setTasks(tasks.map(t => t.id === taskId ? {
          ...t,
          status: 'in-progress' as const,
          startedAt: new Date().toISOString(),
          activeAgent: { name: 'sub-agent', sessionKey: 'pending' },
          executionMode: 'subagent' as const
        } : t));
        console.log('[Spawn] Prompt generated for task:', taskId, '\n', data.prompt.substring(0, 200) + '...');
      } else {
        console.error('Failed to spawn task:', data.error);
        alert(`Failed to spawn: ${data.error}`);
      }
    } catch (error) {
      console.error('Failed to spawn task:', error);
      alert('Failed to spawn task');
    }
  };

  const handleDragStart = (task: Task) => {
    setDraggedTask(task);
  };

  const handleDragEnd = () => {
    setDraggedTask(null);
  };

  const handleDrop = (column: ColumnKey) => {
    if (!draggedTask) return;
    
    // Phase 4: Map column to status updates
    let updates: Partial<Task> = { status: column };
    
    // Special handling for ideas column
    if (column === 'ideas') {
      updates.autoStart = false;  // Don't auto-pickup from ideas
    } else if (column === 'todo') {
      updates.autoStart = true;   // Enable auto-pickup for todo
    }
    
    handleUpdateTask(draggedTask.id, updates);
    setDraggedTask(null);
  };

  // Filter tasks based on active filters
  const matchesFilters = (task: Task): boolean => {
    // Search query
    if (filters.searchQuery) {
      const query = filters.searchQuery.toLowerCase();
      const titleMatch = task.title.toLowerCase().includes(query);
      const descMatch = task.description?.toLowerCase().includes(query);
      if (!titleMatch && !descMatch) return false;
    }

    // Priority filter
    if (filters.priorities.length > 0 && !filters.priorities.includes(task.priority)) {
      return false;
    }

    // Tags filter
    if (filters.tags.length > 0) {
      const hasMatchingTag = task.tags?.some(tag => filters.tags.includes(tag));
      if (!hasMatchingTag) return false;
    }

    // Project filter
    if (filters.projects.length > 0) {
      if (!task.project || !filters.projects.includes(task.project)) {
        return false;
      }
    }

    return true;
  };

  // Phase 4: Filter tasks by column and sort by priority
  const PRIORITY_ORDER: Record<string, number> = {
    urgent: 0, high: 1, normal: 2, low: 3, someday: 4
  };

  const getTasksForColumn = (column: ColumnKey): Task[] => {
    return tasks
      .filter(t => t.status === column && matchesFilters(t))
      .sort((a, b) => {
        // Blocked tasks sink to bottom
        if (a.blocked && !b.blocked) return 1;
        if (!a.blocked && b.blocked) return -1;
        // Within same blocked group: sort by priority then date
        const pa = PRIORITY_ORDER[a.priority] ?? 99;
        const pb = PRIORITY_ORDER[b.priority] ?? 99;
        if (pa !== pb) return pa - pb;
        // Same priority: newest first
        return new Date(b.updated).getTime() - new Date(a.updated).getTime();
      });
  };

  // Mobile swipe gesture support — only triggers from screen edges (40px)
  // so tapping task cards in the middle of the screen works normally
  const swipeEdgeZone = 40; // px from screen edge to start a swipe
  const swipeFromEdge = useRef(false);

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
    const threshold = 50;
    if (Math.abs(diff) < threshold) return;
    
    const currentIdx = COLUMNS.indexOf(mobileActiveTab);
    if (diff > 0 && currentIdx < COLUMNS.length - 1) {
      // Swipe left → next column
      setMobileActiveTab(COLUMNS[currentIdx + 1]);
    } else if (diff < 0 && currentIdx > 0) {
      // Swipe right → previous column
      setMobileActiveTab(COLUMNS[currentIdx - 1]);
    }
  };

  // Mobile: move task to different column
  const handleMoveTask = async (taskId: string, targetStatus: string) => {
    await handleUpdateTask(taskId, { status: targetStatus as ColumnKey });
  };

  const handleToggleCollapse = (column: ColumnKey) => {
    setCollapsedColumns(prev => {
      const next = new Set(prev);
      const wasCollapsed = next.has(column);
      if (wasCollapsed) {
        next.delete(column);
        // After expanding, scroll the column into view
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
    // On mobile, the active tab should always be expanded
    if (isMobile && column === mobileActiveTab) return false;
    return collapsedColumns.has(column);
  };

  const handleArchiveCompleted = async () => {
    const completedTasks = tasks.filter(t => t.status === 'completed');
    if (completedTasks.length === 0) {
      alert('No completed tasks to archive');
      return;
    }

    if (!confirm(`Archive ${completedTasks.length} completed task(s)?`)) return;

    try {
      // Archive sequentially to avoid race conditions
      for (const t of completedTasks) {
        await authenticatedFetch(`${API_BASE_URL}/tasks/${t.id}/archive`, { method: 'POST' });
      }
      // Refresh tasks from server to get updated statuses
      await fetchTasks();
    } catch (error) {
      console.error('Failed to archive tasks:', error);
    }
  };

  if (loading) {
    return (
      <div className="tasks-page-loading">
        <div>Loading tasks...</div>
      </div>
    );
  }

  return (
    <div className="tasks-page-container">
      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} />
      
      {/* Main Content Area */}
      <div className="tasks-page-main">
        {/* Header */}
        <div className="tasks-page-header">
          <div className="tasks-page-header-title">
            <h1>🧠 On My Mind</h1>
            <p>
              {tasks.length} thing{tasks.length !== 1 && 's'} I'm tracking
            </p>
          </div>
          
          <div className="tasks-page-header-actions">
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

        {/* Filter Bar */}
        <FilterBar
          tasks={tasks}
          filters={filters}
          onFiltersChange={setFilters}
        />

        {/* Mobile Tab Bar */}
        {isMobile && (
          <div className="tasks-mobile-tabs">
            {COLUMNS.map(column => {
              const count = getTasksForColumn(column).length;
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

        {/* Kanban Board (Main Focus) */}
        <div 
          className="tasks-page-board" 
          ref={boardRef}
          onTouchStart={isMobile ? handleTouchStart : undefined}
          onTouchMove={isMobile ? handleTouchMove : undefined}
          onTouchEnd={isMobile ? handleTouchEnd : undefined}
        >
          <div className="tasks-page-board-inner" ref={boardInnerRef} onScroll={handleBoardScroll}>
            {(isMobile ? [mobileActiveTab] : COLUMNS).map(column => (
              <TaskColumn
                key={column}
                status={column as any}
                title={COLUMN_LABELS[column]}
                tasks={getTasksForColumn(column)}
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
                allColumns={COLUMNS}
                columnLabels={COLUMN_LABELS}
                onTagClick={handleTagClick}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Create Task Modal */}
      {showCreateModal && (
        <CreateTaskModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateTask}
          existingProjects={[...new Set(tasks.map(t => t.project).filter(Boolean) as string[])]}
          existingTags={[...new Set(tasks.flatMap(t => t.tags || []))]}
        />
      )}
    </div>
  );
};
