import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Pencil, Clock, Tag, Cpu, Calendar, Zap, AlertTriangle, FileText, Bot, Play, CheckCircle, Copy, Check, Lock, Link, ArrowRight, Plus, Trash2, Circle, Eye } from 'lucide-react';
import { Task, TaskPriority, TaskStatus, Subtask, SubtaskStatus, TaskLink, TaskLinkType } from '../../types/task';
import { TASK_LINK_TYPES, getLinkTypeLabel } from '../../constants/linkTypes';
import { SubtaskList } from './SubtaskList';
import { TaskLinks } from './TaskLinks';
import { TaskResourcesSection } from './TaskResourcesSection';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import './TaskDetailModal.css';

// Helper to get effective status (handles legacy boolean completed field)
const getSubtaskStatus = (subtask: { status?: SubtaskStatus; completed?: boolean }): SubtaskStatus => {
  if (subtask.status) return subtask.status;
  if (subtask.completed) return 'completed';
  return 'empty';
};

const generateId = () => crypto.randomUUID?.() || Math.random().toString(36).substring(2, 15);

const MODEL_OPTIONS = [
  { value: '', label: 'Default (no preference)' },
  { value: 'anthropic/claude-opus-4-5', label: '🧠 Claude Opus 4.5' },
  { value: 'anthropic/claude-sonnet-4-5', label: '⚡ Claude Sonnet 4.5' },
  { value: 'google-gemini-cli/gemini-3-pro-preview', label: '💎 Gemini 3 Pro Preview' },
];

const EXECUTION_MODE_OPTIONS = [
  { value: 'main', label: '🖥️ Run in main session' },
  { value: 'subagent', label: '🤖 Spawn sub-agent' },
];

const LINK_TYPE_ICONS: Record<TaskLinkType, string> = {
  project: '📁',
  doc: '📄',
  git: '🔀',
  memory: '🧠',
  session: '💬',
  tool: '🔧'
};

const LINK_TYPE_OPTIONS: { value: TaskLinkType; label: string; icon: string }[] =
  TASK_LINK_TYPES.map(type => ({
    value: type,
    label: getLinkTypeLabel(type),
    icon: LINK_TYPE_ICONS[type]
  }));

interface TaskDetailModalProps {
  task: Task;
  onClose: () => void;
  onEdit?: () => void; // Legacy — ignored if onSave provided
  onSubtaskToggle: (subtaskId: string) => void;
  onSubtaskStatusChange?: (subtaskId: string, status: SubtaskStatus) => void;
  onSubtaskEdit?: (subtaskId: string, newText: string) => void;
  onSubtaskReorder?: (subtaskId: string, direction: 'up' | 'down') => void;
  // Edit mode props (when provided, enables inline editing)
  onSave?: (taskId: string, updates: Partial<Task>) => void;
  onDelete?: (taskId: string) => void;
  initialEditMode?: boolean;
}

export const TaskDetailModal: React.FC<TaskDetailModalProps> = ({
  task,
  onClose,
  onEdit,
  onSubtaskToggle,
  onSubtaskStatusChange,
  onSubtaskEdit,
  onSubtaskReorder,
  onSave,
  onDelete,
  initialEditMode = false,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(initialEditMode);

  // Edit state
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  const [notes, setNotes] = useState(task.notes || '');
  const [project, setProject] = useState(task.project || '');
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [tags, setTags] = useState(task.tags?.join(', ') || '');
  const [autoStart, setAutoStart] = useState(task.autoStart ?? true);
  const [model, setModel] = useState(task.model || '');
  const [executionMode, setExecutionMode] = useState<'main' | 'subagent'>(task.executionMode || 'subagent');
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.subtasks || []);
  const [links, setLinks] = useState<TaskLink[]>(task.links || []);
  const [thinking, setThinking] = useState<'low' | 'medium' | 'high' | ''>(task.thinking || '');
  const [blockedReason, setBlockedReason] = useState(task.blockedReason || '');
  const [newSubtask, setNewSubtask] = useState('');
  const [newLinkTitle, setNewLinkTitle] = useState('');
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [newLinkType, setNewLinkType] = useState<TaskLinkType>('doc');
  const [dependsOn, setDependsOn] = useState<string[]>(task.dependsOn || []);
  const [availableTasks, setAvailableTasks] = useState<Task[]>([]);
  const [dependencySearch, setDependencySearch] = useState('');
  const [error, setError] = useState('');

  const canEdit = !!onSave;
  const shortId = task.id.substring(0, 8);

  // Fetch available tasks for dependency picker when in edit mode
  useEffect(() => {
    if (!isEditing || !canEdit) return;
    const fetchTasks = async () => {
      try {
        const response = await fetch('/api/tasks');
        if (response.ok) {
          const data = await response.json();
          const tasks = (data.tasks || []).filter((t: Task) =>
            t.id !== task.id && t.status !== 'archived'
          );
          setAvailableTasks(tasks);
        }
      } catch (err) {
        console.error('Failed to fetch tasks for dependency picker:', err);
      }
    };
    fetchTasks();
  }, [isEditing, canEdit, task.id]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isEditing) {
          setIsEditing(false);
          // Reset form state
          resetEditState();
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, isEditing]);

  const resetEditState = () => {
    setTitle(task.title);
    setDescription(task.description || '');
    setNotes(task.notes || '');
    setProject(task.project || '');
    setPriority(task.priority);
    setStatus(task.status);
    setTags(task.tags?.join(', ') || '');
    setAutoStart(task.autoStart ?? true);
    setModel(task.model || '');
    setExecutionMode(task.executionMode || 'subagent');
    setSubtasks(task.subtasks || []);
    setLinks(task.links || []);
    setThinking(task.thinking || '');
    setBlockedReason(task.blockedReason || '');
    setDependsOn(task.dependsOn || []);
    setError('');
  };

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(shortId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy task ID:', err);
    }
  };

  const getPriorityLabel = (p?: TaskPriority): string => {
    const val = p || task.priority;
    switch (val) {
      case 'urgent': return '🔴 Urgent';
      case 'high': return '🟠 High';
      case 'normal': return '🔵 Normal';
      case 'low': return '⚪ Low';
      case 'someday': return '🟣 Someday';
      default: return 'Normal';
    }
  };

  const getStatusLabel = (s?: TaskStatus): string => {
    const val = s || task.status;
    switch (val) {
      case 'ideas': return '💡 Ideas / Plans';
      case 'todo': return '📋 To Do';
      case 'in-progress': return '⚡ In Progress';
      case 'stuck': return '🤔 Stuck / Review';
      case 'completed': return '✅ Completed';
      case 'archived': return '📦 Archived';
      default: return val;
    }
  };

  const getThinkingLabel = (t?: string): string => {
    switch (t) {
      case 'low': return '🟢 Low';
      case 'medium': return '🟡 Medium';
      case 'high': return '🔴 High';
      default: return 'Not set';
    }
  };

  const getExecutionModeLabel = (m?: string): string => {
    switch (m) {
      case 'main': return '🖥️ Main session';
      case 'subagent': return '🤖 Sub-agent';
      default: return m || 'Not set';
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

  const handleEditToggle = () => {
    if (canEdit) {
      setIsEditing(true);
    } else if (onEdit) {
      onEdit();
    }
  };

  const handleSave = () => {
    if (!onSave) return;
    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    const parsedTags = tags
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    onSave(task.id, {
      title: title.trim(),
      description: description.trim(),
      notes: notes.trim() || undefined,
      project: project.trim() || undefined,
      priority,
      status,
      tags: parsedTags,
      autoStart,
      model: model || undefined,
      executionMode,
      thinking: thinking || undefined,
      thinkingAutoEstimated: thinking ? false : undefined,
      subtasks,
      links,
      dependsOn,
      blockedReason: status === 'stuck' ? blockedReason.trim() : undefined,
    });
    setIsEditing(false);
  };

  // Edit mode subtask handlers
  const handleAddSubtask = () => {
    if (!newSubtask.trim()) return;
    setSubtasks([...subtasks, {
      id: generateId(),
      text: newSubtask.trim(),
      status: 'empty' as SubtaskStatus,
      completed: false,
    }]);
    setNewSubtask('');
  };

  const handleRemoveSubtask = (id: string) => {
    setSubtasks(subtasks.filter(s => s.id !== id));
  };

  const handleEditSubtaskToggle = (id: string) => {
    setSubtasks(subtasks.map(s => {
      if (s.id !== id) return s;
      const currentStatus = getSubtaskStatus(s);
      const nextStatus: SubtaskStatus =
        currentStatus === 'empty' ? 'review' :
        currentStatus === 'review' ? 'completed' : 'empty';
      return {
        ...s,
        status: nextStatus,
        completed: nextStatus === 'completed',
        completedAt: nextStatus === 'completed' ? new Date().toISOString() : undefined
      };
    }));
  };

  const handleAddLink = () => {
    if (!newLinkTitle.trim() || !newLinkUrl.trim()) return;
    setLinks([...links, {
      type: newLinkType,
      title: newLinkTitle.trim(),
      url: newLinkUrl.trim(),
    }]);
    setNewLinkTitle('');
    setNewLinkUrl('');
  };

  const handleRemoveLink = (index: number) => {
    setLinks(links.filter((_, i) => i !== index));
  };

  const handleAddDependency = (taskId: string) => {
    if (!taskId || dependsOn.includes(taskId)) return;
    setDependsOn([...dependsOn, taskId]);
    setDependencySearch('');
  };

  const handleRemoveDependency = (taskId: string) => {
    setDependsOn(dependsOn.filter(id => id !== taskId));
  };

  const hasSubtasks = isEditing ? subtasks.length > 0 : task.subtasks && task.subtasks.length > 0;
  const hasLinks = isEditing ? links.length > 0 : task.links && task.links.length > 0;
  const hasTags = isEditing ? !!tags.trim() : task.tags && task.tags.length > 0;

  // Phase 3: Count by status
  const displaySubtasks = isEditing ? subtasks : task.subtasks || [];
  const subtaskCounts = displaySubtasks.reduce((acc, s) => {
    const st = getSubtaskStatus(s);
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, {} as Record<SubtaskStatus, number>);
  const completedSubtasks = subtaskCounts.completed || 0;
  const inReviewSubtasks = subtaskCounts.review || 0;

  return createPortal(
    <div className="task-detail-overlay" onClick={handleBackdropClick}>
      <div className="task-detail-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Task details">
        {/* Header */}
        <div className="task-detail-header">
          {isEditing ? (
            <input
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); setError(''); }}
              className="task-detail-title-input"
              placeholder="Task title..."
              autoFocus
            />
          ) : (
            <h2 className="task-detail-title">{task.title}</h2>
          )}
          <div className="task-detail-header-actions">
            {isEditing ? (
              <>
                <button
                  onClick={() => { setIsEditing(false); resetEditState(); }}
                  className="task-detail-btn task-detail-btn-cancel"
                  aria-label="Cancel editing"
                >
                  <Eye size={16} />
                  View
                </button>
                <button
                  onClick={handleSave}
                  className="task-detail-btn task-detail-btn-save"
                  aria-label="Save changes"
                >
                  <Check size={16} />
                  Save
                </button>
              </>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleEditToggle();
                }}
                className="task-detail-btn task-detail-btn-edit"
                aria-label="Edit task"
              >
                <Pencil size={16} />
                Edit
              </button>
            )}
            <button onClick={onClose} className="task-detail-close-btn" aria-label="Close">
              <X size={22} />
            </button>
          </div>
        </div>

        {error && <div className="task-detail-error">{error}</div>}

        {/* Content */}
        <div className="task-detail-content">
          {/* Metadata Row: Priority + Status + ID */}
          <div className="task-detail-metadata">
            <div className="task-detail-meta-item">
              <span className="task-detail-meta-label">Priority:</span>
              {isEditing ? (
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TaskPriority)}
                  className="task-detail-inline-select"
                >
                  <option value="urgent">🔴 Urgent</option>
                  <option value="high">🟠 High</option>
                  <option value="normal">🔵 Normal</option>
                  <option value="low">⚪ Low</option>
                  <option value="someday">🟣 Someday</option>
                </select>
              ) : (
                <span className={`task-detail-priority priority-${task.priority}`}>
                  {getPriorityLabel()}
                </span>
              )}
            </div>
            <div className="task-detail-meta-item">
              <span className="task-detail-meta-label">Status:</span>
              {isEditing ? (
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as TaskStatus)}
                  className="task-detail-inline-select"
                >
                  <option value="ideas">💡 Ideas / Plans</option>
                  <option value="todo">📋 To Do</option>
                  <option value="in-progress">⚡ In Progress</option>
                  <option value="stuck">🤔 Stuck / Review</option>
                  <option value="completed">✅ Completed</option>
                  <option value="archived">📦 Archived</option>
                </select>
              ) : (
                <span className="task-detail-status">{getStatusLabel()}</span>
              )}
            </div>
            <div className="task-detail-meta-item task-detail-id-container">
              <span className="task-detail-meta-label">ID:</span>
              <code className="task-detail-id">{shortId}</code>
              <button
                onClick={handleCopyId}
                className="task-detail-copy-btn"
                aria-label={copied ? 'Copied!' : 'Copy task ID'}
                title={copied ? 'Copied!' : 'Copy task ID'}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>

          {/* Project */}
          <div className="task-detail-section">
            <div className="task-detail-field-row">
              <div className="task-detail-field-group">
                <span className="task-detail-field-label">Project:</span>
                {isEditing ? (
                  <input
                    type="text"
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                    className="task-detail-inline-input"
                    placeholder="e.g., clawboard"
                  />
                ) : (
                  <span className="task-detail-field-value">
                    {task.project ? `#${task.project}` : <span className="task-detail-field-empty">—</span>}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Tags — full width row */}
          <div className="task-detail-section">
            <div className="task-detail-field-row">
              <div className="task-detail-field-group" style={{ flex: '1 1 100%' }}>
                <span className="task-detail-field-label"><Tag size={14} /> Tags:</span>
                {isEditing ? (
                  <input
                    type="text"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    className="task-detail-inline-input"
                    style={{ flex: 1 }}
                    placeholder="phase-4, frontend, ux"
                  />
                ) : (
                  <span className="task-detail-field-value" style={{ flexWrap: 'wrap' }}>
                    {hasTags ? task.tags.map((tag, i) => (
                      <span key={i} className="task-detail-tag">{tag}</span>
                    )) : <span className="task-detail-field-empty">—</span>}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* AI Execution: Model + Execution Mode + Thinking Level */}
          <div className="task-detail-section">
            <h3 className="task-detail-section-title">AI Execution</h3>
            <div className="task-detail-field-row task-detail-field-row-3">
              <div className="task-detail-field-group">
                <span className="task-detail-field-label"><Bot size={14} /> Model:</span>
                {isEditing ? (
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="task-detail-inline-select"
                  >
                    {MODEL_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : (
                  <span className="task-detail-field-value">
                    {task.model ? (
                      <span className="task-detail-model-badge">{task.model}</span>
                    ) : <span className="task-detail-field-empty">Default</span>}
                  </span>
                )}
              </div>
              <div className="task-detail-field-group">
                <span className="task-detail-field-label"><Play size={14} /> Mode:</span>
                {isEditing ? (
                  <select
                    value={executionMode}
                    onChange={(e) => setExecutionMode(e.target.value as 'main' | 'subagent')}
                    className="task-detail-inline-select"
                  >
                    {EXECUTION_MODE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : (
                  <span className="task-detail-field-value">
                    {getExecutionModeLabel(task.executionMode)}
                  </span>
                )}
              </div>
              <div className="task-detail-field-group">
                <span className="task-detail-field-label">🧠 Thinking:</span>
                {isEditing ? (
                  <select
                    value={thinking}
                    onChange={(e) => setThinking(e.target.value as 'low' | 'medium' | 'high' | '')}
                    className="task-detail-inline-select"
                  >
                    <option value="">Not set</option>
                    <option value="low">🟢 Low</option>
                    <option value="medium">🟡 Medium</option>
                    <option value="high">🔴 High</option>
                  </select>
                ) : (
                  <span className="task-detail-field-value">
                    {getThinkingLabel(task.thinking)}
                    {task.thinkingAutoEstimated && <span className="task-detail-auto-badge">auto</span>}
                  </span>
                )}
              </div>
            </div>

            {/* Active Agent / Completed By (view only) */}
            {!isEditing && (task.activeAgent || task.completedBy) && (
              <div className="task-detail-ai-agents">
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
            )}
          </div>

          {/* Flags / Toggles */}
          <div className="task-detail-section">
            {isEditing ? (
              <label className="task-detail-toggle-label">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={(e) => setAutoStart(e.target.checked)}
                  className="task-detail-checkbox"
                />
                <span className="task-detail-toggle-text">
                  ⚡ Auto-pickup enabled
                  <span className="task-detail-toggle-hint">bot can pick this up during heartbeats</span>
                </span>
              </label>
            ) : (
              (task.autoStart || task.autoCreated || task.needsReview) && (
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
              )
            )}
          </div>

          {/* Blocked Reason (when stuck) */}
          {(isEditing ? status === 'stuck' : task.blockedReason) && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Blocked Reason</h3>
              {isEditing ? (
                <input
                  type="text"
                  value={blockedReason}
                  onChange={(e) => setBlockedReason(e.target.value)}
                  className="task-detail-inline-input task-detail-inline-input-full"
                  placeholder="Why is this stuck?"
                />
              ) : (
                <div className="task-detail-blocked">
                  {task.blockedReason}
                </div>
              )}
            </div>
          )}

          {/* Agent Instructions */}
          <div className="task-detail-section">
            <h3 className="task-detail-section-title">Agent Instructions</h3>
            {isEditing ? (
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="task-detail-textarea"
                placeholder="Instructions for the agent (supports markdown)..."
                rows={6}
              />
            ) : (
              task.description ? (
                <div className="task-detail-description">{task.description}</div>
              ) : (
                <div className="task-detail-field-empty">No instructions</div>
              )
            )}
          </div>

          {/* Notes */}
          <div className="task-detail-section">
            <h3 className="task-detail-section-title">Notes</h3>
            {isEditing ? (
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="task-detail-textarea"
                placeholder="Working notes, findings, blockers..."
                rows={4}
              />
            ) : (
              task.notes ? (
                <div className="task-detail-notes">
                  <FileText size={14} />
                  <span>{task.notes}</span>
                </div>
              ) : (
                <div className="task-detail-field-empty">No notes</div>
              )
            )}
          </div>

          {/* Subtasks */}
          {(hasSubtasks || isEditing) && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">
                Subtasks (
                  {completedSubtasks > 0 && <span className="subtask-count-completed">✅{completedSubtasks}</span>}
                  {inReviewSubtasks > 0 && <span className="subtask-count-review">🔄{inReviewSubtasks}</span>}
                  {(subtaskCounts.empty || 0) > 0 && <span className="subtask-count-new">⬜{subtaskCounts.empty}</span>}
                )
              </h3>
              {isEditing ? (
                <div className="task-detail-edit-subtasks">
                  {subtasks.map((subtask, idx) => {
                    const st = getSubtaskStatus(subtask);
                    const statusIcon = st === 'completed' ? <Check size={12} />
                      : st === 'review' ? <Clock size={12} />
                      : <Circle size={10} />;
                    return (
                      <div key={subtask.id} className={`task-detail-edit-subtask-item status-${st}`}>
                        <span className="task-detail-subtask-index">{idx}</span>
                        <button
                          type="button"
                          className={`task-detail-subtask-check status-${st}`}
                          onClick={() => handleEditSubtaskToggle(subtask.id)}
                          title={`Status: ${st} (click to cycle)`}
                        >
                          {statusIcon}
                        </button>
                        <span className={`task-detail-subtask-text status-${st}`}>
                          {subtask.text}
                        </span>
                        {subtask.reviewNote && (
                          <span className="task-detail-review-note" title={subtask.reviewNote}>💬</span>
                        )}
                        <button
                          type="button"
                          className="task-detail-subtask-remove"
                          onClick={() => handleRemoveSubtask(subtask.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                  <div className="task-detail-subtask-add">
                    <input
                      type="text"
                      value={newSubtask}
                      onChange={(e) => setNewSubtask(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddSubtask(); } }}
                      className="task-detail-inline-input"
                      placeholder="Add subtask... (Enter to add)"
                    />
                    <button type="button" className="task-detail-add-btn" onClick={handleAddSubtask}>
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <SubtaskList
                  subtasks={task.subtasks}
                  onToggle={onSubtaskToggle}
                  onStatusChange={onSubtaskStatusChange}
                  onEditText={onSubtaskEdit}
                  onReorder={onSubtaskReorder}
                />
              )}
            </div>
          )}

          {/* Links */}
          {(hasLinks || isEditing) && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Links ({(isEditing ? links : task.links || []).length})</h3>
              {isEditing ? (
                <div className="task-detail-edit-links">
                  {links.map((link, i) => (
                    <div key={i} className="task-detail-edit-link-item">
                      <span className="task-detail-link-icon">
                        {LINK_TYPE_OPTIONS.find(o => o.value === link.type)?.icon || '📄'}
                      </span>
                      <span className="task-detail-link-title-text">{link.title}</span>
                      <span className="task-detail-link-url-text" title={link.url}>
                        {link.url.length > 40 ? link.url.substring(0, 40) + '...' : link.url}
                      </span>
                      <button
                        type="button"
                        className="task-detail-subtask-remove"
                        onClick={() => handleRemoveLink(i)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <div className="task-detail-link-add">
                    <select
                      value={newLinkType}
                      onChange={(e) => setNewLinkType(e.target.value as TaskLinkType)}
                      className="task-detail-inline-select task-detail-link-type-select"
                    >
                      {LINK_TYPE_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.icon} {opt.label}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={newLinkTitle}
                      onChange={(e) => setNewLinkTitle(e.target.value)}
                      className="task-detail-inline-input"
                      placeholder="Link title"
                    />
                    <input
                      type="text"
                      value={newLinkUrl}
                      onChange={(e) => setNewLinkUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddLink(); } }}
                      className="task-detail-inline-input"
                      placeholder="URL or path"
                    />
                    <button type="button" className="task-detail-add-btn" onClick={handleAddLink}>
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <TaskLinks links={task.links} />
              )}
            </div>
          )}

          {/* Task Resources (Phase 3 — view only) */}
          {!isEditing && task.taskResources && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Task Resources</h3>
              <TaskResourcesSection resources={task.taskResources} />
            </div>
          )}

          {/* Task Dependencies */}
          {(isEditing || ((task.blockingTasks && task.blockingTasks.length > 0) || (task.dependentTasks && task.dependentTasks.length > 0) || (task.dependsOn && task.dependsOn.length > 0))) && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">
                <Link size={16} /> Dependencies
                {!isEditing && task.blocked && <span className="task-detail-dep-blocked-badge">🔒 BLOCKED</span>}
              </h3>
              {isEditing ? (
                <div className="task-detail-edit-dependencies">
                  {dependsOn.map((depId) => {
                    const depTask = availableTasks.find(t => t.id === depId);
                    return (
                      <div key={depId} className="task-detail-edit-dep-item">
                        <span className="task-detail-edit-dep-title">
                          {depTask ? `${depTask.title} (${depTask.status})` : `Task ${depId.substring(0, 8)}`}
                        </span>
                        <button
                          type="button"
                          className="task-detail-subtask-remove"
                          onClick={() => handleRemoveDependency(depId)}
                          title="Remove dependency"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                  <div className="task-detail-dep-add">
                    <input
                      type="text"
                      value={dependencySearch}
                      onChange={(e) => setDependencySearch(e.target.value)}
                      className="task-detail-inline-input task-detail-inline-input-full"
                      placeholder="Search tasks to add as dependency..."
                    />
                    {dependencySearch.trim() && (
                      <div className="task-detail-dep-dropdown">
                        {availableTasks
                          .filter(t =>
                            !dependsOn.includes(t.id) &&
                            (t.title.toLowerCase().includes(dependencySearch.toLowerCase()) ||
                             t.id.toLowerCase().includes(dependencySearch.toLowerCase()) ||
                             (t.project && t.project.toLowerCase().includes(dependencySearch.toLowerCase())))
                          )
                          .slice(0, 10)
                          .map(t => (
                            <button
                              key={t.id}
                              type="button"
                              className="task-detail-dep-option"
                              onClick={() => handleAddDependency(t.id)}
                            >
                              <span className="task-detail-dep-option-title">{t.title}</span>
                              <span className="task-detail-dep-option-meta">
                                {t.status} • {t.project || 'No project'} • {t.id.substring(0, 8)}
                              </span>
                            </button>
                          ))}
                        {availableTasks.filter(t =>
                          !dependsOn.includes(t.id) &&
                          (t.title.toLowerCase().includes(dependencySearch.toLowerCase()) ||
                           t.id.toLowerCase().includes(dependencySearch.toLowerCase()))
                        ).length === 0 && (
                          <div className="task-detail-dep-empty">No matching tasks found</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="task-detail-dependencies">
                  {task.blockingTasks && task.blockingTasks.length > 0 && (
                    <div className="task-detail-dep-group">
                      <div className="task-detail-dep-group-label">
                        <Lock size={14} /> Depends on ({task.blockingTasks.length} incomplete)
                      </div>
                      {task.blockingTasks.map((dep) => (
                        <div key={dep.id} className="task-detail-dep-item task-detail-dep-blocking">
                          <ArrowRight size={12} />
                          <span className="task-detail-dep-title">{dep.title}</span>
                          <code className="task-detail-dep-id">{dep.id.substring(0, 8)}</code>
                        </div>
                      ))}
                    </div>
                  )}
                  {task.dependsOn && task.dependsOn.length > 0 && task.blockingTasks && (
                    (() => {
                      const blockingIds = new Set(task.blockingTasks.map(t => t.id));
                      const completedDeps = task.dependsOn!.filter(id => !blockingIds.has(id));
                      if (completedDeps.length === 0) return null;
                      return (
                        <div className="task-detail-dep-group">
                          <div className="task-detail-dep-group-label task-detail-dep-completed-label">
                            <CheckCircle size={14} /> Completed dependencies ({completedDeps.length})
                          </div>
                          {completedDeps.map((depId) => (
                            <div key={depId} className="task-detail-dep-item task-detail-dep-completed">
                              <CheckCircle size={12} />
                              <code className="task-detail-dep-id">{depId.substring(0, 8)}</code>
                            </div>
                          ))}
                        </div>
                      );
                    })()
                  )}
                  {task.dependentTasks && task.dependentTasks.length > 0 && (
                    <div className="task-detail-dep-group">
                      <div className="task-detail-dep-group-label task-detail-dep-blocks-label">
                        <Link size={14} /> Blocks ({task.dependentTasks.length})
                      </div>
                      {task.dependentTasks.map((dep) => (
                        <div key={dep.id} className="task-detail-dep-item task-detail-dep-dependent">
                          <ArrowRight size={12} />
                          <span className="task-detail-dep-title">{dep.title}</span>
                          <code className="task-detail-dep-id">{dep.id.substring(0, 8)}</code>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Blocked By (legacy manual blockers — view only) */}
          {!isEditing && task.blockedBy && task.blockedBy.length > 0 && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Blocked By</h3>
              <div className="task-detail-blocked-by">
                {task.blockedBy.map((id, i) => (
                  <span key={i} className="task-detail-blocked-id">{id}</span>
                ))}
              </div>
            </div>
          )}

          {/* Timeline */}
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
              {(task.attemptCount ?? 0) > 0 && (
                <div className="task-detail-timestamp">
                  <span className="task-detail-timestamp-label">🔁 Attempt:</span>
                  <span className="task-detail-timestamp-value">
                    #{task.attemptCount} {task.attemptCount! > 1 ? '(previously rejected)' : ''}
                  </span>
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

          {/* Delete button (edit mode only) */}
          {isEditing && onDelete && (
            <div className="task-detail-section task-detail-danger-zone">
              <button
                type="button"
                onClick={() => { if (confirm('Delete this task?')) { onDelete(task.id); onClose(); } }}
                className="task-detail-btn task-detail-btn-delete"
              >
                <Trash2 size={16} /> Delete Task
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
