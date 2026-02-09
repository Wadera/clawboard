import React, { useState, useRef, useEffect } from 'react';
import { Subtask, SubtaskStatus } from '../../types/task';
import { Check, ChevronUp, ChevronDown, Pencil, Clock } from 'lucide-react';
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

// Helper to get effective status (handles legacy boolean completed field)
const getSubtaskStatus = (subtask: Subtask): SubtaskStatus => {
  if (subtask.status) return subtask.status;
  // Legacy fallback
  if (subtask.completed) return 'completed';
  return 'new';
};

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

  // Phase 3: Count by status
  const statusCounts = subtasks.reduce((acc, s) => {
    const status = getSubtaskStatus(s);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {} as Record<SubtaskStatus, number>);
  
  const completed = statusCounts.completed || 0;
  const inReview = statusCounts.in_review || 0;
  const newCount = statusCounts.new || 0;
  const total = subtasks.length;
  // Progress bar widths calculated from completed/inReview/total directly

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

  // Get status display info
  const getStatusInfo = (status: SubtaskStatus) => {
    switch (status) {
      case 'completed':
        return { icon: <Check size={12} />, className: 'subtask-status-completed', tooltip: 'Completed' };
      case 'in_review':
        return { icon: <Clock size={12} />, className: 'subtask-status-review', tooltip: 'Awaiting Review' };
      case 'new':
      default:
        return { icon: null, className: 'subtask-status-new', tooltip: 'Not started' };
    }
  };

  return (
    <div className={`subtask-list ${compact ? 'subtask-list-compact' : ''}`}>
      {/* Progress summary */}
      <div className="subtask-progress">
        <div className="subtask-progress-bar">
          {/* Completed segment */}
          <div
            className="subtask-progress-fill subtask-progress-completed"
            style={{ width: `${(completed / total) * 100}%` }}
          />
          {/* In-review segment */}
          <div
            className="subtask-progress-fill subtask-progress-review"
            style={{ width: `${(inReview / total) * 100}%`, marginLeft: `${(completed / total) * 100}%` }}
          />
        </div>
        <span className="subtask-progress-text">
          {compact ? (
            `${completed}/${total}`
          ) : (
            <>
              {completed > 0 && <span className="progress-completed">✅{completed}</span>}
              {inReview > 0 && <span className="progress-review">🔄{inReview}</span>}
              {newCount > 0 && <span className="progress-new">⬜{newCount}</span>}
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
                  // Cycle through states: new -> in_review -> completed -> new
                  if (onStatusChange) {
                    const nextStatus: SubtaskStatus = 
                      status === 'new' ? 'in_review' :
                      status === 'in_review' ? 'completed' : 'new';
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
                {status === 'in_review' && subtask.reviewNote && (
                  <span className="subtask-review-note" title={subtask.reviewNote}>
                    💬
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
