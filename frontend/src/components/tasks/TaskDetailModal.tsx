import React from 'react';
import { createPortal } from 'react-dom';
import { X, Pencil, Clock, Tag, Cpu, Calendar, Zap, AlertTriangle, FileText, Bot, Play, CheckCircle } from 'lucide-react';
import { Task, SubtaskStatus } from '../../types/task';
import { SubtaskList } from './SubtaskList';
import { TaskLinks } from './TaskLinks';
import { TaskResourcesSection } from './TaskResourcesSection';
import './TaskDetailModal.css';

// Helper to get effective status (handles legacy boolean completed field)
const getSubtaskStatus = (subtask: { status?: SubtaskStatus; completed?: boolean }): SubtaskStatus => {
  if (subtask.status) return subtask.status;
  if (subtask.completed) return 'completed';
  return 'new';
};

interface TaskDetailModalProps {
  task: Task;
  onClose: () => void;
  onEdit: () => void;
  onSubtaskToggle: (subtaskId: string) => void;
  onSubtaskStatusChange?: (subtaskId: string, status: SubtaskStatus) => void;
  onSubtaskEdit?: (subtaskId: string, newText: string) => void;
  onSubtaskReorder?: (subtaskId: string, direction: 'up' | 'down') => void;
}

export const TaskDetailModal: React.FC<TaskDetailModalProps> = ({
  task,
  onClose,
  onEdit,
  onSubtaskToggle,
  onSubtaskStatusChange,
  onSubtaskEdit,
  onSubtaskReorder,
}) => {
  const getPriorityLabel = (): string => {
    switch (task.priority) {
      case 'urgent': return '🔴 Urgent';
      case 'high': return '🟠 High';
      case 'normal': return '🔵 Normal';
      case 'low': return '⚪ Low';
      case 'someday': return '🟣 Someday';
      default: return 'Normal';
    }
  };

  const getStatusLabel = (): string => {
    switch (task.status) {
      case 'ideas': return '💡 Ideas / Plans';
      case 'todo': return '📋 To Do';
      case 'in-progress': return '⚡ In Progress';
      case 'stuck': return '🤔 Stuck / Review';
      case 'completed': return '✅ Completed';
      case 'archived': return '📦 Archived';
      default: return task.status;
    }
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const hasSubtasks = task.subtasks && task.subtasks.length > 0;
  const hasLinks = task.links && task.links.length > 0;
  const hasTags = task.tags && task.tags.length > 0;
  
  // Phase 3: Count by status
  const subtaskCounts = hasSubtasks ? task.subtasks.reduce((acc, s) => {
    const status = getSubtaskStatus(s);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {} as Record<SubtaskStatus, number>) : {} as Record<SubtaskStatus, number>;
  const completedSubtasks = subtaskCounts.completed || 0;
  const inReviewSubtasks = subtaskCounts.in_review || 0;

  return createPortal(
    <div className="task-detail-overlay" onClick={handleBackdropClick}>
      <div className="task-detail-modal" role="dialog" aria-modal="true" aria-label="Task details">
        {/* Header */}
        <div className="task-detail-header">
          <h2 className="task-detail-title">{task.title}</h2>
          <div className="task-detail-header-actions">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="task-detail-btn task-detail-btn-edit"
              aria-label="Edit task"
            >
              <Pencil size={16} />
              Edit
            </button>
            <button onClick={onClose} className="task-detail-close-btn" aria-label="Close">
              <X size={22} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="task-detail-content">
          {/* Metadata Row */}
          <div className="task-detail-metadata">
            <div className="task-detail-meta-item">
              <span className="task-detail-meta-label">Priority:</span>
              <span className={`task-detail-priority priority-${task.priority}`}>
                {getPriorityLabel()}
              </span>
            </div>
            <div className="task-detail-meta-item">
              <span className="task-detail-meta-label">Status:</span>
              <span className="task-detail-status">{getStatusLabel()}</span>
            </div>
          </div>

          {/* Project and Tags */}
          {(task.project || hasTags) && (
            <div className="task-detail-section">
              {task.project && (
                <div className="task-detail-project">
                  <strong>Project:</strong> #{task.project}
                </div>
              )}
              {hasTags && (
                <div className="task-detail-tags">
                  <Tag size={14} />
                  <strong>Tags:</strong>
                  {task.tags.map((tag, i) => (
                    <span key={i} className="task-detail-tag">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Agent Instructions */}
          {task.description && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Agent Instructions</h3>
              <div className="task-detail-description">
                {task.description}
              </div>
            </div>
          )}

          {/* Subtasks - Phase 3: Show tri-state counts */}
          {hasSubtasks && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">
                Subtasks (
                  {completedSubtasks > 0 && <span className="subtask-count-completed">✅{completedSubtasks}</span>}
                  {inReviewSubtasks > 0 && <span className="subtask-count-review">🔄{inReviewSubtasks}</span>}
                  {(subtaskCounts.new || 0) > 0 && <span className="subtask-count-new">⬜{subtaskCounts.new}</span>}
                )
              </h3>
              <SubtaskList
                subtasks={task.subtasks}
                onToggle={onSubtaskToggle}
                onStatusChange={onSubtaskStatusChange}
                onEditText={onSubtaskEdit}
                onReorder={onSubtaskReorder}
              />
            </div>
          )}

          {/* Links */}
          {hasLinks && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Links</h3>
              <TaskLinks links={task.links} />
            </div>
          )}

          {/* Task Resources (Phase 3) */}
          {task.taskResources && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Task Resources</h3>
              <TaskResourcesSection resources={task.taskResources} />
            </div>
          )}

          {/* AI Execution Info */}
          {(task.model || task.executionMode || task.activeAgent || task.completedBy) && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">AI Execution</h3>
              <div className="task-detail-ai-info">
                {task.model && (
                  <div className="task-detail-ai-row">
                    <Bot size={14} />
                    <span className="task-detail-ai-label">Model:</span>
                    <span className="task-detail-ai-value task-detail-model-badge">{task.model}</span>
                  </div>
                )}
                {task.executionMode && (
                  <div className="task-detail-ai-row">
                    <Play size={14} />
                    <span className="task-detail-ai-label">Mode:</span>
                    <span className="task-detail-ai-value">{task.executionMode}</span>
                  </div>
                )}
                {task.activeAgent && (
                  <div className="task-detail-ai-row">
                    <Cpu size={14} />
                    <span className="task-detail-ai-label">Active Agent:</span>
                    <span className="task-detail-ai-value task-detail-agent-badge">
                      {typeof task.activeAgent === 'string' 
                        ? task.activeAgent 
                        : <><span className="task-detail-agent-name">{task.activeAgent.name}</span> <span className="task-detail-agent-session">{task.activeAgent.sessionKey}</span></>
                      }
                    </span>
                  </div>
                )}
                {task.completedBy && (
                  <div className="task-detail-ai-row">
                    <CheckCircle size={14} />
                    <span className="task-detail-ai-label">Completed By:</span>
                    <span className="task-detail-ai-value">
                      {typeof task.completedBy === 'string'
                        ? task.completedBy
                        : <><span className="task-detail-agent-name">{task.completedBy.name}</span> <span className="task-detail-agent-session">{task.completedBy.sessionKey}</span></>
                      }
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Flags */}
          {(task.autoStart || task.autoCreated || task.needsReview) && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Flags</h3>
              <div className="task-detail-flags">
                {task.autoStart && (
                  <span className="task-detail-flag task-detail-flag-autostart">
                    <Zap size={12} /> Auto-start
                  </span>
                )}
                {task.autoCreated && (
                  <span className="task-detail-flag task-detail-flag-autocreated">
                    <Bot size={12} /> Auto-created
                  </span>
                )}
                {task.needsReview && (
                  <span className="task-detail-flag task-detail-flag-review">
                    <AlertTriangle size={12} /> Needs Review
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Blocked By */}
          {task.blockedBy && task.blockedBy.length > 0 && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Blocked By</h3>
              <div className="task-detail-blocked-by">
                {task.blockedBy.map((id, i) => (
                  <span key={i} className="task-detail-blocked-id">{id}</span>
                ))}
              </div>
            </div>
          )}

          {/* Blocked Reason */}
          {task.blockedReason && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Blocked Reason</h3>
              <div className="task-detail-blocked">
                {task.blockedReason}
              </div>
            </div>
          )}

          {/* Notes */}
          {task.notes && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Notes</h3>
              <div className="task-detail-notes">
                <FileText size={14} />
                <span>{task.notes}</span>
              </div>
            </div>
          )}

          {/* Timestamps */}
          <div className="task-detail-section">
            <h3 className="task-detail-section-title">Timeline</h3>
            <div className="task-detail-timestamps">
              <div className="task-detail-timestamp">
                <Calendar size={14} />
                <span className="task-detail-timestamp-label">Created:</span>
                <span className="task-detail-timestamp-value">{formatDate(task.created)}</span>
              </div>
              <div className="task-detail-timestamp">
                <Clock size={14} />
                <span className="task-detail-timestamp-label">Updated:</span>
                <span className="task-detail-timestamp-value">{formatDate(task.updated)}</span>
              </div>
              {task.startedAt && (
                <div className="task-detail-timestamp">
                  <Clock size={14} />
                  <span className="task-detail-timestamp-label">Started:</span>
                  <span className="task-detail-timestamp-value">{formatDate(task.startedAt)}</span>
                </div>
              )}
              {task.completedAt && (
                <div className="task-detail-timestamp">
                  <Clock size={14} />
                  <span className="task-detail-timestamp-label">Completed:</span>
                  <span className="task-detail-timestamp-value">{formatDate(task.completedAt)}</span>
                </div>
              )}
              {task.archivedAt && (
                <div className="task-detail-timestamp">
                  <Clock size={14} />
                  <span className="task-detail-timestamp-label">Archived:</span>
                  <span className="task-detail-timestamp-value">{formatDate(task.archivedAt)}</span>
                </div>
              )}
              {task.lastChecked && (
                <div className="task-detail-timestamp">
                  <Clock size={14} />
                  <span className="task-detail-timestamp-label">Last Checked:</span>
                  <span className="task-detail-timestamp-value">{formatDate(task.lastChecked)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Session References */}
          {task.sessionRefs && task.sessionRefs.length > 0 && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Session History ({task.sessionRefs.length})</h3>
              <div className="task-detail-sessions">
                {task.sessionRefs.map((ref, i) => (
                  <div key={i} className="task-detail-session-ref">
                    💬 {ref}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
