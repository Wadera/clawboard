import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, MoveRight } from 'lucide-react';
import { Task, TaskStatus } from '../../types/task';
import { TaskCard } from './TaskCard';
import './TaskColumn.css';

const EMPTY_STATES: Record<string, { icon: string; message: string; hint: string }> = {
  'ideas': { icon: '💡', message: 'No ideas yet', hint: 'Drag tasks here to save for later' },
  'todo': { icon: '📋', message: 'All caught up!', hint: 'Drag tasks here for bot to pick up' },
  'in-progress': { icon: '⚡', message: 'Nothing active', hint: 'Pick a task to start working' },
  'stuck': { icon: '🤝', message: 'All clear!', hint: 'Blocked tasks will appear here' },
  'completed': { icon: '🎉', message: 'Nothing completed yet', hint: 'Finished tasks land here' },
  'archived': { icon: '📦', message: 'No archived tasks', hint: 'Auto-archives after 7 days' },
};

interface TaskColumnProps {
  status: TaskStatus | string;
  title: string;
  tasks: Task[];
  onDragStart: (task: Task) => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void;
  onDeleteTask: (taskId: string) => void;
  onSpawnTask?: (taskId: string) => void;
  onQuickAdd?: (status: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isMobile?: boolean;
  onMoveTask?: (taskId: string, targetStatus: string) => void;
  allColumns?: string[];
  columnLabels?: Record<string, string>;
  onTagClick?: (tag: string) => void;
}

export const TaskColumn: React.FC<TaskColumnProps> = ({
  status,
  title,
  tasks,
  onDragStart,
  onDragEnd,
  onDrop,
  onUpdateTask,
  onDeleteTask,
  onSpawnTask,
  onQuickAdd,
  collapsed = false,
  onToggleCollapse,
  isMobile = false,
  onMoveTask,
  allColumns = [],
  columnLabels = {},
  onTagClick,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [moveTaskId, setMoveTaskId] = useState<string | null>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    onDrop();
  };

  const columnClass = [
    'task-column',
    collapsed ? 'task-column-collapsed' : 'task-column-expanded',
    isDragOver ? 'task-column-drag-over' : ''
  ].filter(Boolean).join(' ');

  return (
    <div 
      className={columnClass}
      data-status={status}
      role="list"
      aria-label={`${title} column, ${tasks.length} tasks`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="task-column-header">
        <div className="task-column-title">
          <span>{title}</span>
        </div>
        <div className="task-column-header-right">
          {onQuickAdd && !collapsed && (
            <button
              className="task-column-quick-add"
              onClick={(e) => { e.stopPropagation(); onQuickAdd(status); }}
              aria-label={`Add task to ${title}`}
              title={`Add task to ${title}`}
            >
              <Plus size={14} />
            </button>
          )}
          <div className="task-column-count">{tasks.length}</div>
          {onToggleCollapse && (
            <button 
              className="task-column-collapse-btn"
              onClick={(e) => {
                e.stopPropagation();
                onToggleCollapse();
              }}
              aria-label={collapsed ? 'Expand column' : 'Collapse column'}
              title={collapsed ? 'Expand column' : 'Collapse column'}
            >
              {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="task-column-content">
          {tasks.length === 0 ? (
            <div className="task-column-empty">
              <div className="task-column-empty-icon">{EMPTY_STATES[status]?.icon || '📭'}</div>
              <div className="task-column-empty-message">{EMPTY_STATES[status]?.message || 'No tasks'}</div>
              <div className="task-column-empty-hint">{EMPTY_STATES[status]?.hint || ''}</div>
            </div>
          ) : (
            tasks.map(task => (
              <div key={task.id} className="task-card-wrapper">
                <TaskCard
                  task={task}
                  onDragStart={() => onDragStart(task)}
                  onDragEnd={onDragEnd}
                  onUpdate={(updates) => onUpdateTask(task.id, updates)}
                  onDelete={() => onDeleteTask(task.id)}
                  onSpawn={onSpawnTask ? () => onSpawnTask(task.id) : undefined}
                  disableDrag={isMobile}
                  onTagClick={onTagClick}
                />
                {isMobile && onMoveTask && (
                  <div className="task-card-mobile-actions">
                    <button
                      className="task-card-move-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMoveTaskId(moveTaskId === task.id ? null : task.id);
                      }}
                      aria-label="Move task"
                    >
                      <MoveRight size={14} />
                      <span>Move</span>
                    </button>
                    {moveTaskId === task.id && (
                      <div className="task-card-move-targets">
                        {allColumns.filter(c => c !== status).map(col => (
                          <button
                            key={col}
                            className="task-card-move-target"
                            onClick={(e) => {
                              e.stopPropagation();
                              onMoveTask(task.id, col);
                              setMoveTaskId(null);
                            }}
                          >
                            {columnLabels[col] || col}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
