import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Task } from '../../types/task';
import { Cpu, Folder, Tag, Brain, Lock, Link, Radio, Flag, AlertTriangle } from 'lucide-react';
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
  sessionActivityState?: 'active' | 'stale' | null;
}

export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  onDragStart,
  onDragEnd,
  onUpdate,
  onDelete,
  disableDrag = false,
  onTagClick,
  sessionActivityState,
}) => {
  const navigate = useNavigate();
  const [isDragging, setIsDragging] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  // Check if any subtask is blocked
  const hasBlockedSubtask = task.subtasks?.some(s => s.status === 'blocked') || false;

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
        className={`task-card task-card-compact ${isDragging ? 'dragging' : ''} ${task.blocked ? 'task-blocked' : ''} ${hasBlockedSubtask ? 'subtask-blocked' : ''} ${task.activeAgent && task.status === 'in-progress' ? 'agent-active' : ''} ${sessionActivityState === 'active' ? 'session-active' : ''} ${sessionActivityState === 'stale' ? 'session-stale' : ''}`}
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
          {/* Title (1 line, truncated) */}
          <h3 className="task-card-title-compact">
            {task.title}
          </h3>
          
          {/* Header Icons: Auto-start, Blocked/NeedsReview, Session Link */}
          {task.autoStart && (
            <span className="task-card-icon-flag" title="Auto-start enabled">
              <Flag size={13} />
            </span>
          )}
          {(task.blocked || task.needsReview) && (
            <span className={`task-card-icon-alert ${task.needsReview ? 'needs-review' : 'is-blocked'}`} title={task.needsReview ? 'Needs human review' : 'Blocked'}>
              <AlertTriangle size={13} />
            </span>
          )}
          
          {/* Active Agent Session Link */}
          {task.activeAgent && typeof task.activeAgent === 'object' && task.activeAgent.sessionKey && task.activeAgent.sessionKey !== 'pending' && (
            <button
              className="task-card-session-link"
              onClick={(e) => {
                e.stopPropagation();
                const sessionKey = typeof task.activeAgent === 'object' && task.activeAgent ? task.activeAgent.sessionKey : '';
                navigate(`/sessions?session=${sessionKey}`);
              }}
              title={`View agent session: ${typeof task.activeAgent === 'object' ? task.activeAgent.sessionKey : ''}`}
              aria-label="View active agent session"
            >
              <Radio size={14} />
            </button>
          )}
        </div>
        
        {/* Project Badge — before tags */}
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
        
        {/* Tags — after project */}
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

        {/* Subtask Progress Bar */}
        {task.subtasks && task.subtasks.length > 0 && (() => {
          const counts = task.subtasks.reduce(
            (acc, s) => {
              if (s.status === 'completed' || s.completed) acc.completed++;
              else if (s.status === 'in_progress') acc.inProgress++;
              else if (s.status === 'review') acc.review++;
              else if (s.status === 'blocked') acc.blocked++;
              else if (s.status === 'skipped') acc.skipped++;
              else acc.empty++;
              return acc;
            },
            { completed: 0, inProgress: 0, review: 0, blocked: 0, skipped: 0, empty: 0 }
          );
          const total = task.subtasks.length;
          const pct = (n: number) => `${(n / total) * 100}%`;
          return (
            <div className="task-card-subtask-progress" title={`✅${counts.completed} 🔄${counts.inProgress} 👀${counts.review} 🚫${counts.blocked} ⏭${counts.skipped} ⬜${counts.empty}`}>
              <div className="subtask-bar">
                {counts.completed > 0 && <div className="subtask-bar-segment bar-completed" style={{ width: pct(counts.completed) }} />}
                {counts.inProgress > 0 && <div className="subtask-bar-segment bar-in-progress" style={{ width: pct(counts.inProgress) }} />}
                {counts.review > 0 && <div className="subtask-bar-segment bar-review" style={{ width: pct(counts.review) }} />}
                {counts.blocked > 0 && <div className="subtask-bar-segment bar-blocked" style={{ width: pct(counts.blocked) }} />}
                {counts.skipped > 0 && <div className="subtask-bar-segment bar-skipped" style={{ width: pct(counts.skipped) }} />}
              </div>
              <span className="subtask-counts">
                {counts.completed > 0 && <span>✅{counts.completed}</span>}
                {counts.inProgress > 0 && <span>🔄{counts.inProgress}</span>}
                {counts.review > 0 && <span>👀{counts.review}</span>}
                {counts.blocked > 0 && <span>🚫{counts.blocked}</span>}
                {counts.empty > 0 && <span>⬜{counts.empty}</span>}
              </span>
            </div>
          );
        })()}

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

        {/* Card Footer: Priority + Thinking (moved to bottom) */}
        <div className="task-card-footer">
          <span className={`task-card-priority-compact ${getPriorityClass()}`}>
            {task.priority.charAt(0).toUpperCase()}
          </span>
          
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
        </div>
      </div>
    </>
  );
};
