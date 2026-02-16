import React, { useState, useRef, useEffect } from 'react';
import { Subtask, SubtaskStatus } from '../../types/task';
import { Check, ChevronUp, ChevronDown, Pencil, Clock, AlertCircle, SkipForward, Loader2 } from 'lucide-react';
import './SubtaskList.css';

interface SubtaskListProps {
  subtasks: Subtask[];
  onToggle: (subtaskId: string) => void;
  onStatusChange?: (subtaskId: string, status: SubtaskStatus) => void;
  onEditText?: (subtaskId: string, newText: string) => void;
  onReorder?: (subtaskId: string, direction: 'up' | 'down') => void;
  compact?: boolean;
  readOnly?: boolean;
}

// Helper to get effective status (handles legacy field and old status names)
const getSubtaskStatus = (subtask: Subtask): SubtaskStatus => {
  let status = subtask.status;
  // Legacy fallback
  if (!status) {
    return subtask.completed ? 'completed' : 'empty';
  }
  // Normalize old status names
  if (status === 'new' as any) return 'empty';
  if (status === 'in_review' as any) return 'review';
  return status;
};

// Statuses that count as "done"
const DONE_STATUSES: SubtaskStatus[] = ['completed', 'skipped'];

export const SubtaskList: React.FC<SubtaskListProps> = ({ 
  subtasks, 
  onToggle,
  onStatusChange,
  onEditText,
  onReorder,
  compact = false,
  readOnly = false
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  if (!subtasks || subtasks.length === 0) return null;

  // Phase 4: Count by status (6-state)
  const statusCounts = subtasks.reduce((acc, s) => {
    const status = getSubtaskStatus(s);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {} as Record<SubtaskStatus, number>);
  
  const completed = statusCounts.completed || 0;
  const skipped = statusCounts.skipped || 0;
  const review = statusCounts.review || 0;
  const inProgress = statusCounts.in_progress || 0;
  const blocked = statusCounts.blocked || 0;
  const empty = statusCounts.empty || 0;
  const total = subtasks.length;
  const done = completed + skipped;
  // Progress bar widths calculated from done/review/inProgress/blocked/total

  const handleStartEdit = (subtask: Subtask) => {
    if (readOnly || !onEditText) return;
    setEditingId(subtask.id);
    setEditText(subtask.text);
  };

  const handleSaveEdit = () => {
    if (editingId && editText.trim() && onEditText) {
      onEditText(editingId, editText.trim());
    }
    setEditingId(null);
    setEditText('');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelEdit();
    }
  };

  const canMoveUp = (index: number) => index > 0;
  const canMoveDown = (index: number) => index < subtasks.length - 1;

  // Get status display info (6-state)
  const getStatusInfo = (status: SubtaskStatus) => {
    switch (status) {
      case 'completed':
        return { icon: <Check size={12} />, className: 'subtask-status-completed', tooltip: 'Completed' };
      case 'skipped':
        return { icon: <SkipForward size={12} />, className: 'subtask-status-skipped', tooltip: 'Skipped' };
      case 'review':
        return { icon: <Clock size={12} />, className: 'subtask-status-review', tooltip: 'Awaiting Review' };
      case 'in_progress':
        return { icon: <Loader2 size={12} />, className: 'subtask-status-in-progress', tooltip: 'In Progress' };
      case 'blocked':
        return { icon: <AlertCircle size={12} />, className: 'subtask-status-blocked', tooltip: 'Blocked' };
      case 'empty':
      default:
        return { icon: null, className: 'subtask-status-empty', tooltip: 'Not started' };
    }
  };

  return (
    <div className={`subtask-list ${compact ? 'subtask-list-compact' : ''} ${blocked > 0 ? 'has-blocked' : ''}`}>
      {/* Progress summary */}
      <div className="subtask-progress">
        <div className="subtask-progress-bar">
          {/* Completed segment (green) */}
          <div
            className="subtask-progress-fill subtask-progress-completed"
            style={{ width: `${(completed / total) * 100}%` }}
          />
          {/* Skipped segment (gray) */}
          <div
            className="subtask-progress-fill subtask-progress-skipped"
            style={{ width: `${(skipped / total) * 100}%`, left: `${(completed / total) * 100}%` }}
          />
          {/* Review segment (yellow) */}
          <div
            className="subtask-progress-fill subtask-progress-review"
            style={{ width: `${(review / total) * 100}%`, left: `${((completed + skipped) / total) * 100}%` }}
          />
          {/* In-progress segment (blue) */}
          <div
            className="subtask-progress-fill subtask-progress-in-progress"
            style={{ width: `${(inProgress / total) * 100}%`, left: `${((completed + skipped + review) / total) * 100}%` }}
          />
          {/* Blocked segment (red) */}
          <div
            className="subtask-progress-fill subtask-progress-blocked"
            style={{ width: `${(blocked / total) * 100}%`, left: `${((completed + skipped + review + inProgress) / total) * 100}%` }}
          />
        </div>
        <span className="subtask-progress-text">
          {compact ? (
            `${done}/${total}`
          ) : (
            <>
              {completed > 0 && <span className="progress-completed">✅{completed}</span>}
              {skipped > 0 && <span className="progress-skipped">⏭️{skipped}</span>}
              {review > 0 && <span className="progress-review">🟡{review}</span>}
              {inProgress > 0 && <span className="progress-in-progress">🔄{inProgress}</span>}
              {blocked > 0 && <span className="progress-blocked">🔴{blocked}</span>}
              {empty > 0 && <span className="progress-empty">⬜{empty}</span>}
            </>
          )}
        </span>
      </div>

      {/* Subtask checkboxes */}
      <ul className="subtask-items">
        {subtasks.map((subtask, index) => {
          const status = getSubtaskStatus(subtask);
          const statusInfo = getStatusInfo(status);
          
          return (
          <li
            key={subtask.id || `subtask-${index}`}
            className={`subtask-item ${statusInfo.className} ${editingId === subtask.id ? 'subtask-editing' : ''}`}
          >
            <button
              className={`subtask-checkbox ${statusInfo.className}`}
              onClick={(e) => {
                e.stopPropagation();
                if (subtask.id) {
                  // Cycle through primary states: empty -> in_progress -> review -> completed -> empty
                  // (blocked and skipped are set via actions, not cycling)
                  if (onStatusChange) {
                    const nextStatus: SubtaskStatus = 
                      status === 'empty' ? 'in_progress' :
                      status === 'in_progress' ? 'review' :
                      status === 'review' ? 'completed' :
                      status === 'completed' ? 'empty' :
                      status === 'skipped' ? 'empty' :
                      status === 'blocked' ? 'empty' : 'empty';
                    onStatusChange(subtask.id, nextStatus);
                  } else {
                    onToggle(subtask.id);
                  }
                }
              }}
              aria-label={`${statusInfo.tooltip}: ${subtask.text}`}
              title={statusInfo.tooltip}
            >
              {statusInfo.icon}
            </button>
            
            {editingId === subtask.id ? (
              <input
                ref={inputRef}
                type="text"
                className="subtask-edit-input"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleSaveEdit}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span 
                className={`subtask-text ${!readOnly && onEditText ? 'subtask-text-editable' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleStartEdit(subtask);
                }}
                title={!readOnly && onEditText ? 'Click to edit' : undefined}
              >
                {subtask.text}
                {status === 'review' && subtask.reviewNote && (
                  <span className="subtask-review-note" title={subtask.reviewNote}>
                    💬
                  </span>
                )}
                {status === 'blocked' && subtask.blockedReason && (
                  <span className="subtask-blocked-reason" title={subtask.blockedReason}>
                    ⚠️
                  </span>
                )}
              </span>
            )}

            {/* Action buttons (only show when not editing and not compact/readonly) */}
            {!compact && !readOnly && editingId !== subtask.id && (
              <div className="subtask-actions">
                {onEditText && (
                  <button
                    className="subtask-action-btn subtask-edit-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleStartEdit(subtask);
                    }}
                    aria-label="Edit subtask"
                    title="Edit"
                  >
                    <Pencil size={12} />
                  </button>
                )}
                {onReorder && (
                  <>
                    <button
                      className="subtask-action-btn subtask-move-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (subtask.id && canMoveUp(index)) {
                          onReorder(subtask.id, 'up');
                        }
                      }}
                      disabled={!canMoveUp(index)}
                      aria-label="Move up"
                      title="Move up"
                    >
                      <ChevronUp size={14} />
                    </button>
                    <button
                      className="subtask-action-btn subtask-move-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (subtask.id && canMoveDown(index)) {
                          onReorder(subtask.id, 'down');
                        }
                      }}
                      disabled={!canMoveDown(index)}
                      aria-label="Move down"
                      title="Move down"
                    >
                      <ChevronDown size={14} />
                    </button>
                  </>
                )}
              </div>
            )}
          </li>
        )})}
      </ul>
    </div>
  );
};
