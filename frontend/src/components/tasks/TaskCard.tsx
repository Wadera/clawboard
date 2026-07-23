import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Task } from '../../types/task';
import { Cpu, Folder, Tag, Brain, Lock, Link, Radio, Flag, AlertTriangle, Terminal, Clock } from 'lucide-react';
import { TaskDetailModal } from './TaskDetailModal';
import { AgentTypeBadge } from '../AgentTypeBadge';
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
  deepLinkTaskId?: string | null;
  onDeepLinkHandled?: () => void;
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
  deepLinkTaskId,
  onDeepLinkHandled,
}) => {
  const navigate = useNavigate();
  const [isDragging, setIsDragging] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [elapsed, setElapsed] = useState('');

  // Auto-open detail modal when this card is the deep link target
  useEffect(() => {
    if (deepLinkTaskId && task.id === deepLinkTaskId) {
      setShowDetail(true);
      onDeepLinkHandled?.();
    }
  }, [deepLinkTaskId, task.id, onDeepLinkHandled]);

  const isInteractive = task.executionMode === 'interactive';

  // Duration timer for active interactive sessions
  useEffect(() => {
    if (!isInteractive || !task.startedAt || task.status === 'completed' || task.status === 'archived') return;

    const updateElapsed = () => {
      const start = new Date(task.startedAt!).getTime();
      const diff = Math.max(0, Date.now() - start);
      const mins = Math.floor(diff / 60000);
      const hrs = Math.floor(mins / 60);
      if (hrs > 0) {
        setElapsed(`${hrs}h ${mins % 60}m`);
      } else {
        setElapsed(`${mins}m`);
      }
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 60000);
    return () => clearInterval(interval);
  }, [isInteractive, task.startedAt, task.status]);

  // Derive interactive session status
  const getSessionStatus = (): { label: string; className: string } | null => {
    if (!isInteractive) return null;
    if (task.status === 'completed' || task.status === 'archived') {
      return { label: 'Completed', className: 'session-status-completed' };
    }
    if (task.status === 'stuck') {
      return { label: 'Waiting for Input', className: 'session-status-waiting' };
    }
    if (task.activeAgent && task.status === 'in-progress') {
      if (sessionActivityState === 'stale') {
        return { label: 'Idle', className: 'session-status-idle' };
      }
      return { label: 'Running', className: 'session-status-running' };
    }
    if (task.acpSessionKey && task.status === 'in-progress') {
      return { label: 'Running', className: 'session-status-running' };
    }
    return { label: 'Idle', className: 'session-status-idle' };
  };

  const sessionStatus = getSessionStatus();

  // Check if any subtask is blocked
  const hasBlockedSubtask = task.subtasks?.some(s => s.status === 'blocked') || false;
  const dependencyIds = task.dependsOn || [];
  const blockingTasks = task.blockingTasks || [];
  const dependentTasks = task.dependentTasks || [];
  const hasDependencies = dependencyIds.length > 0;
  const dependencyTitle = hasDependencies
    ? `Depends on: ${dependencyIds.map(id => id.slice(0, 8)).join(', ')}`
    : '';
  const blockingTitle = blockingTasks.length > 0
    ? `Blocked by incomplete: ${blockingTasks.map(t => `${t.title} (${t.id.slice(0, 8)})`).join(', ')}`
    : dependencyTitle;
  const blocksTitle = dependentTasks.length > 0
    ? `Blocks: ${dependentTasks.map(t => `${t.title} (${t.id.slice(0, 8)})`).join(', ')}`
    : '';

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
          onSubtaskToggle={handleSubtaskToggle}
          onSubtaskEdit={handleSubtaskEdit}
          onSubtaskReorder={handleSubtaskReorder}
          onSave={(_taskId, updates) => onUpdate(updates)}
          onDelete={() => { onDelete(); setShowDetail(false); }}
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
          {task.autoStart === true && (
            <span className="task-card-icon-flag" title="Auto-pickup enabled (orchestrator may pick this up)">
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

        {/* Interactive Session Badge + Status */}
        {isInteractive && (
          <div className="task-card-interactive-row">
            <span className="task-card-interactive-badge">
              <Terminal size={11} />
              <span>Interactive</span>
            </span>
            {sessionStatus && (
              <span className={`task-card-session-status ${sessionStatus.className}`}>
                <span className="session-status-dot" />
                <span>{sessionStatus.label}</span>
              </span>
            )}
            {elapsed && task.status !== 'completed' && task.status !== 'archived' && (
              <span className="task-card-session-timer">
                <Clock size={10} />
                <span>{elapsed}</span>
              </span>
            )}
          </div>
        )}

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
        
        {/* Agent type badge */}
        {(task as any).agentType && (
          <AgentTypeBadge agentType={(task as any).agentType} size="sm" />
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
        {(task.blocked || hasDependencies) && (
          <div
            className={task.blocked ? "task-card-blocked" : "task-card-depends"}
            title={blockingTitle}
          >
            <Lock size={12} />
            <span>
              {task.blocked && blockingTasks.length > 0
                ? `Blocked by ${blockingTasks.length} task${blockingTasks.length > 1 ? 's' : ''}`
                : `Depends on ${dependencyIds.length} task${dependencyIds.length > 1 ? 's' : ''}`}
            </span>
          </div>
        )}
        
        {dependentTasks.length > 0 && (
          <div className="task-card-blocks" title={blocksTitle}>
            <Link size={12} />
            <span>Blocks {dependentTasks.length} task{dependentTasks.length > 1 ? 's' : ''}</span>
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
