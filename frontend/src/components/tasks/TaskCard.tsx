import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Task } from '../../types/task';
import { Cpu, Folder, Tag, Brain, Lock, Link } from 'lucide-react';
import { EditTaskModal } from './EditTaskModal';
import { TaskDetailModal } from './TaskDetailModal';
import './TaskCard.css';

interface TaskCardProps {
  task: Task;
  onDragStart: () => void;
  onDragEnd: () => void;
  onUpdate: (updates: Partial<Task>) => void;
  onDelete: () => void;
  onSpawn?: () => void;
  disableDrag?: boolean;
  onTagClick?: (tag: string) => void;
}

export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  onDragStart,
  onDragEnd,
  onUpdate,
  onDelete,
  disableDrag = false,
  onTagClick,
}) => {
  const navigate = useNavigate();
  const [isDragging, setIsDragging] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  const getPriorityClass = (): string => {
    switch (task.priority) {
      case 'urgent': return 'priority-urgent';
      case 'high': return 'priority-high';
      case 'normal': return 'priority-normal';
      case 'low': return 'priority-low';
      case 'someday': return 'priority-someday';
      default: return 'priority-normal';
    }
  };

  const getStatusClass = (): string => {
    switch (task.status) {
      case 'ideas': return 'status-ideas';
      case 'todo': return 'status-todo';
      case 'in-progress': return 'status-in-progress';
      case 'stuck': return 'status-stuck';
      case 'completed': return 'status-completed';
      case 'archived': return 'status-archived';
      default: return 'status-todo';
    }
  };

  const handleSubtaskToggle = (subtaskId: string) => {
    const updatedSubtasks = task.subtasks.map(s => {
      if (s.id === subtaskId) {
        return {
          ...s,
          completed: !s.completed,
          completedAt: !s.completed ? new Date().toISOString() : undefined,
        };
      }
      return s;
    });
    onUpdate({ subtasks: updatedSubtasks });
  };

  const handleSubtaskEdit = (subtaskId: string, newText: string) => {
    const updatedSubtasks = task.subtasks.map(s => {
      if (s.id === subtaskId) {
        return { ...s, text: newText };
      }
      return s;
    });
    onUpdate({ subtasks: updatedSubtasks });
  };

  const handleSubtaskReorder = (subtaskId: string, direction: 'up' | 'down') => {
    const currentIndex = task.subtasks.findIndex(s => s.id === subtaskId);
    if (currentIndex === -1) return;
    
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= task.subtasks.length) return;
    
    const updatedSubtasks = [...task.subtasks];
    const [movedItem] = updatedSubtasks.splice(currentIndex, 1);
    updatedSubtasks.splice(newIndex, 0, movedItem);
    
    onUpdate({ subtasks: updatedSubtasks });
  };

  const handleCardClick = () => {
    // Only open detail if not clicking on a draggable area
    // The drag events will handle dragging, click handles detail view
    if (!isDragging) {
      setShowDetail(true);
    }
  };

  return (
    <>
      {/* Modals */}
      {showDetail && (
        <TaskDetailModal
          task={task}
          onClose={() => setShowDetail(false)}
          onEdit={() => {
            setShowDetail(false);
            setShowEdit(true);
          }}
          onSubtaskToggle={handleSubtaskToggle}
          onSubtaskEdit={handleSubtaskEdit}
          onSubtaskReorder={handleSubtaskReorder}
        />
      )}
      {showEdit && (
        <EditTaskModal
          task={task}
          onClose={() => setShowEdit(false)}
          onSave={(_taskId, updates) => onUpdate(updates)}
          onDelete={() => { onDelete(); setShowEdit(false); }}
        />
      )}

      {/* Compact Card */}
      <div
        draggable={!disableDrag}
        onDragStart={disableDrag ? undefined : () => { setIsDragging(true); onDragStart(); }}
        onDragEnd={disableDrag ? undefined : () => { setIsDragging(false); onDragEnd(); }}
        onClick={handleCardClick}
        className={`task-card task-card-compact ${isDragging ? 'dragging' : ''} ${task.blocked ? 'task-blocked' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`Task: ${task.title}, Priority: ${task.priority}, Status: ${task.status}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setShowDetail(true);
          }
        }}
      >
        {/* Compact Card Content */}
        <div className="task-card-compact-header">
          {/* Status Dot */}
          <div className={`task-card-status-dot ${getStatusClass()}`} />
          
          {/* Priority Badge */}
          <span className={`task-card-priority-compact ${getPriorityClass()}`}>
            {task.priority.charAt(0).toUpperCase()}
          </span>
          
          {/* Title (1 line, truncated) */}
          <h3 className="task-card-title-compact">
            {task.title}
          </h3>
        </div>
        
        {/* Project Badge */}
        {task.project && (
          <div
            className="task-card-project-badge"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/projects?open=${encodeURIComponent(task.project!)}`);
            }}
            title={`Project: ${task.project}`}
          >
            <Folder size={11} />
            <span>{task.project}</span>
          </div>
        )}
        
        {/* Tags */}
        {task.tags && task.tags.length > 0 && (
          <div className="task-card-tags">
            {task.tags.slice(0, 3).map((tag) => (
              <button
                key={tag}
                className="task-card-tag"
                onClick={(e) => {
                  e.stopPropagation();
                  onTagClick?.(tag);
                }}
                title={`Filter by tag: ${tag}`}
              >
                <Tag size={10} />
                <span>{tag}</span>
              </button>
            ))}
            {task.tags.length > 3 && (
              <span className="task-card-tag-more">+{task.tags.length - 3}</span>
            )}
          </div>
        )}
        
        {/* Thinking Level Indicator */}
        {task.thinking && (
          <div className={`task-card-thinking thinking-${task.thinking}`}>
            <Brain size={12} />
            <span>{task.thinking === 'low' ? 'Low' : task.thinking === 'medium' ? 'Med' : 'High'}</span>
            {task.thinkingAutoEstimated && <span className="task-card-thinking-auto" title="Auto-estimated">⚙</span>}
            {(task.attemptCount ?? 0) > 0 && (
              <span className="task-card-attempt" title={`Attempt #${task.attemptCount}`}>🔁{task.attemptCount}</span>
            )}
          </div>
        )}

        {/* Dependency Badges */}
        {task.blocked && task.blockingTasks && task.blockingTasks.length > 0 && (
          <div className="task-card-blocked" title={`Blocked by: ${task.blockingTasks.map(t => t.title).join(', ')}`}>
            <Lock size={12} />
            <span>Blocked by {task.blockingTasks.length} task{task.blockingTasks.length > 1 ? 's' : ''}</span>
          </div>
        )}
        
        {task.dependentTasks && task.dependentTasks.length > 0 && (
          <div className="task-card-blocks" title={`Blocks: ${task.dependentTasks.map(t => t.title).join(', ')}`}>
            <Link size={12} />
            <span>Blocks {task.dependentTasks.length} task{task.dependentTasks.length > 1 ? 's' : ''}</span>
          </div>
        )}

        {/* Agent Indicator (if active) */}
        {task.activeAgent && (
          <div className="task-card-agent-compact">
            <Cpu size={12} />
            <span>{typeof task.activeAgent === 'string' ? task.activeAgent : task.activeAgent.name}</span>
          </div>
        )}
      </div>
    </>
  );
};
