import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2, Clock, Check, Circle } from 'lucide-react';
import { Task, TaskPriority, TaskStatus, Subtask, SubtaskStatus, TaskLink, TaskLinkType } from '../../types/task';
import { TASK_LINK_TYPES, getLinkTypeLabel } from '../../constants/linkTypes';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import './CreateTaskModal.css'; // Reuse same styles
import './EditTaskModal.css';   // Extra edit-specific styles

// Phase 3: Helper to get effective status
const getSubtaskStatus = (subtask: Subtask): SubtaskStatus => {
  if (subtask.status) return subtask.status;
  if (subtask.completed) return 'completed';
  return 'new';
};

interface EditTaskModalProps {
  task: Task;
  onClose: () => void;
  onSave: (taskId: string, updates: Partial<Task>) => void;
  onDelete: (taskId: string) => void;
}

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

// Icon mapping for task link types (emojis for select options)
const LINK_TYPE_ICONS: Record<TaskLinkType, string> = {
  project: '📁',
  doc: '📄',
  git: '🔀',
  memory: '🧠',
  session: '💬',
  tool: '🔧'
};

// Generate link type options from shared constants
const LINK_TYPE_OPTIONS: { value: TaskLinkType; label: string; icon: string }[] = 
  TASK_LINK_TYPES.map(type => ({
    value: type,
    label: getLinkTypeLabel(type),
    icon: LINK_TYPE_ICONS[type]
  }));

export const EditTaskModal: React.FC<EditTaskModalProps> = ({
  task,
  onClose,
  onSave,
  onDelete
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

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
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    
    // Fetch available tasks for dependency picker
    const fetchTasks = async () => {
      try {
        const response = await fetch('/api/tasks');
        if (response.ok) {
          const data = await response.json();
          // Filter out current task and archived tasks
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
  }, [task.id]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('Title is required');
      titleRef.current?.focus();
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
      thinkingAutoEstimated: thinking ? false : undefined,  // Manual override clears auto flag
      subtasks,
      links,
      dependsOn,
      blockedReason: status === 'stuck' ? blockedReason.trim() : undefined,
    });
    onClose();
  };

  const handleAddSubtask = () => {
    if (!newSubtask.trim()) return;
    setSubtasks([...subtasks, {
      id: generateId(),
      text: newSubtask.trim(),
      status: 'new' as SubtaskStatus,  // Phase 3: Use new status field
      completed: false,  // Legacy support
    }]);
    setNewSubtask('');
  };

  const handleRemoveSubtask = (id: string) => {
    setSubtasks(subtasks.filter(s => s.id !== id));
  };

  // Phase 3: Cycle through tri-state: new -> in_review -> completed -> new
  const handleToggleSubtask = (id: string) => {
    setSubtasks(subtasks.map(s => {
      if (s.id !== id) return s;
      const currentStatus = getSubtaskStatus(s);
      const nextStatus: SubtaskStatus = 
        currentStatus === 'new' ? 'in_review' :
        currentStatus === 'in_review' ? 'completed' : 'new';
      return { 
        ...s, 
        status: nextStatus,
        completed: nextStatus === 'completed', // Legacy support
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

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return createPortal(
    <div className="create-task-overlay edit-task-overlay" onClick={handleBackdropClick}>
      <div className="create-task-modal edit-task-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Task modal">
        {/* Header */}
        <div className="create-task-modal-header">
          <h2>Edit Task</h2>
          <button onClick={onClose} className="create-task-close-btn" aria-label="Close modal">
            <X size={22} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="create-task-form edit-task-form">
          {/* Title */}
          <div className="create-task-field">
            <label className="create-task-label">Title *</label>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); setError(''); }}
              className="create-task-input"
            />
            {error && <span className="edit-task-error">{error}</span>}
          </div>

          {/* Agent Instructions */}
          <div className="create-task-field">
            <label className="create-task-label">
              Agent Instructions (Markdown)
              <span style={{ fontSize: '0.75rem', opacity: 0.7, marginLeft: 8, fontWeight: 'normal' }}>
                Sent to agents as part of their task prompt
              </span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="create-task-textarea edit-task-textarea-large"
              placeholder="Instructions for the agent (supports markdown)..."
            />
          </div>

          {/* Operational Notes */}
          <div className="create-task-field">
            <label className="create-task-label">
              Notes
              <span style={{ fontSize: '0.75rem', opacity: 0.7, marginLeft: 8, fontWeight: 'normal' }}>
                Operational log — visible to orchestrator and agents
              </span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="create-task-textarea"
              placeholder="Working notes, findings, blockers, etc..."
              rows={4}
            />
          </div>

          {/* Row: Status + Priority */}
          <div className="edit-task-row">
            <div className="create-task-field" style={{ flex: 1 }}>
              <label className="create-task-label">Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
                className="create-task-select"
              >
                <option value="ideas">💡 Ideas / Plans</option>
                <option value="todo">📋 To Do</option>
                <option value="in-progress">⚡ In Progress</option>
                <option value="stuck">🤔 Stuck / Review</option>
                <option value="completed">✅ Completed</option>
                <option value="archived">📦 Archived</option>
              </select>
            </div>

            <div className="create-task-field" style={{ flex: 1 }}>
              <label className="create-task-label">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className="create-task-select"
              >
                <option value="urgent">🔴 Urgent</option>
                <option value="high">🟠 High</option>
                <option value="normal">🔵 Normal</option>
                <option value="low">⚪ Low</option>
                <option value="someday">🟣 Someday</option>
              </select>
            </div>
          </div>

          {/* Row: Project + Tags */}
          <div className="edit-task-row">
            <div className="create-task-field" style={{ flex: 1 }}>
              <label className="create-task-label">Project</label>
              <input
                type="text"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className="create-task-input"
                placeholder="e.g., clawboard"
              />
            </div>

            <div className="create-task-field" style={{ flex: 1 }}>
              <label className="create-task-label">Tags (comma-separated)</label>
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                className="create-task-input"
                placeholder="phase-4, frontend, ux"
              />
            </div>
          </div>

          {/* Row: Model + Execution Mode */}
          <div className="edit-task-row">
            <div className="create-task-field" style={{ flex: 1 }}>
              <label className="create-task-label">AI Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="create-task-select"
              >
                {MODEL_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <div className="create-task-field" style={{ flex: 1 }}>
              <label className="create-task-label">Execution Mode</label>
              <select
                value={executionMode}
                onChange={(e) => setExecutionMode(e.target.value as 'main' | 'subagent')}
                className="create-task-select"
              >
                {EXECUTION_MODE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Thinking Level */}
          <div className="edit-task-row">
            <div className="create-task-field" style={{ flex: 1 }}>
              <label className="create-task-label">
                Thinking Level
                {task.thinkingAutoEstimated && task.thinking === thinking && (
                  <span style={{ fontSize: '0.7rem', opacity: 0.6, marginLeft: 6 }}>⚙ auto-estimated</span>
                )}
                {thinking && !task.thinkingAutoEstimated && task.thinking === thinking && (
                  <span style={{ fontSize: '0.7rem', opacity: 0.6, marginLeft: 6 }}>✋ manually set</span>
                )}
              </label>
              <select
                value={thinking}
                onChange={(e) => setThinking(e.target.value as 'low' | 'medium' | 'high' | '')}
                className="create-task-select"
              >
                <option value="">Not set</option>
                <option value="low">🟢 Low — simple, routine task</option>
                <option value="medium">🟡 Medium — moderate complexity</option>
                <option value="high">🔴 High — complex, needs deep reasoning</option>
              </select>
            </div>
            {(task.attemptCount ?? 0) > 0 && (
              <div className="create-task-field" style={{ flex: 1 }}>
                <label className="create-task-label">Attempt Count</label>
                <div style={{ padding: '8px 0', fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)' }}>
                  🔁 Attempt #{task.attemptCount} {task.attemptCount! > 1 ? '(previously rejected)' : ''}
                </div>
              </div>
            )}
          </div>

          {/* Auto-start toggle */}
          <div className="edit-task-toggle">
            <label className="edit-task-toggle-label">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => setAutoStart(e.target.checked)}
                className="edit-task-checkbox"
              />
              <span className="edit-task-toggle-text">
                ⚡ Auto-pickup enabled
                <span className="edit-task-toggle-hint">bot can pick this up during heartbeats</span>
              </span>
            </label>
          </div>

          {/* Blocked reason (shown when status is stuck) */}
          {status === 'stuck' && (
            <div className="create-task-field">
              <label className="create-task-label">Blocked Reason</label>
              <input
                type="text"
                value={blockedReason}
                onChange={(e) => setBlockedReason(e.target.value)}
                className="create-task-input"
                placeholder="Why is this stuck?"
              />
            </div>
          )}

          {/* Subtasks Section - Phase 3: Tri-state support */}
          <div className="edit-task-section">
            <label className="create-task-label">
              Subtasks ({(() => {
                const counts = subtasks.reduce((acc, s) => {
                  const status = getSubtaskStatus(s);
                  acc[status] = (acc[status] || 0) + 1;
                  return acc;
                }, {} as Record<SubtaskStatus, number>);
                return (
                  <>
                    {counts.completed > 0 && <span className="status-count completed">✅{counts.completed}</span>}
                    {counts.in_review > 0 && <span className="status-count review">🔄{counts.in_review}</span>}
                    {counts.new > 0 && <span className="status-count new">⬜{counts.new}</span>}
                  </>
                );
              })()})
            </label>
            <div className="edit-task-subtasks">
              {subtasks.map((subtask, idx) => {
                const status = getSubtaskStatus(subtask);
                const statusIcon = status === 'completed' ? <Check size={12} /> 
                  : status === 'in_review' ? <Clock size={12} /> 
                  : <Circle size={10} />;
                const statusClass = `status-${status}`;
                
                return (
                <div key={subtask.id} className={`edit-task-subtask-item ${statusClass}`}>
                  <span className="edit-task-subtask-index">{idx}</span>
                  <button
                    type="button"
                    className={`edit-task-subtask-check ${statusClass}`}
                    onClick={() => handleToggleSubtask(subtask.id)}
                    title={`Status: ${status} (click to cycle)`}
                  >
                    {statusIcon}
                  </button>
                  <span className={`edit-task-subtask-text ${statusClass}`}>
                    {subtask.text}
                  </span>
                  {subtask.reviewNote && (
                    <span className="edit-task-review-note" title={subtask.reviewNote}>💬</span>
                  )}
                  <button
                    type="button"
                    className="edit-task-subtask-remove"
                    onClick={() => handleRemoveSubtask(subtask.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
              })}
              <div className="edit-task-subtask-add">
                <input
                  type="text"
                  value={newSubtask}
                  onChange={(e) => setNewSubtask(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddSubtask(); } }}
                  className="create-task-input"
                  placeholder="Add subtask... (Enter to add)"
                />
                <button type="button" className="edit-task-add-btn" onClick={handleAddSubtask}>
                  <Plus size={16} />
                </button>
              </div>
            </div>
          </div>

          {/* Links Section */}
          <div className="edit-task-section">
            <label className="create-task-label">Links ({links.length})</label>
            <div className="edit-task-links">
              {links.map((link, i) => (
                <div key={i} className="edit-task-link-item">
                  <span className="edit-task-link-icon">
                    {LINK_TYPE_OPTIONS.find(o => o.value === link.type)?.icon || '📄'}
                  </span>
                  <span className="edit-task-link-title">{link.title}</span>
                  <span className="edit-task-link-url" title={link.url}>
                    {link.url.length > 40 ? link.url.substring(0, 40) + '...' : link.url}
                  </span>
                  <button
                    type="button"
                    className="edit-task-subtask-remove"
                    onClick={() => handleRemoveLink(i)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <div className="edit-task-link-add">
                <select
                  value={newLinkType}
                  onChange={(e) => setNewLinkType(e.target.value as TaskLinkType)}
                  className="create-task-select edit-task-link-type-select"
                >
                  {LINK_TYPE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.icon} {opt.label}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={newLinkTitle}
                  onChange={(e) => setNewLinkTitle(e.target.value)}
                  className="create-task-input"
                  placeholder="Link title"
                />
                <input
                  type="text"
                  value={newLinkUrl}
                  onChange={(e) => setNewLinkUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddLink(); } }}
                  className="create-task-input"
                  placeholder="URL or path"
                />
                <button type="button" className="edit-task-add-btn" onClick={handleAddLink}>
                  <Plus size={16} />
                </button>
              </div>
            </div>
          </div>

          {/* Dependencies Section */}
          <div className="edit-task-section">
            <label className="create-task-label">
              🔗 Dependencies ({dependsOn.length})
              <span style={{ fontSize: '0.75rem', opacity: 0.7, marginLeft: 8, fontWeight: 'normal' }}>
                This task depends on (must complete these first)
              </span>
            </label>
            <div className="edit-task-dependencies">
              {/* Show current dependencies */}
              {dependsOn.map((depId) => {
                const depTask = availableTasks.find(t => t.id === depId);
                return (
                  <div key={depId} className="edit-task-dependency-item">
                    <span className="edit-task-dependency-title">
                      {depTask ? `${depTask.title} (${depTask.status})` : `Task ${depId.substring(0, 8)}`}
                    </span>
                    <button
                      type="button"
                      className="edit-task-subtask-remove"
                      onClick={() => handleRemoveDependency(depId)}
                      title="Remove dependency"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
              
              {/* Add new dependency */}
              <div className="edit-task-dependency-add">
                <input
                  type="text"
                  value={dependencySearch}
                  onChange={(e) => setDependencySearch(e.target.value)}
                  className="create-task-input"
                  placeholder="Search tasks to add as dependency..."
                />
                {dependencySearch.trim() && (
                  <div className="edit-task-dependency-dropdown">
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
                          className="edit-task-dependency-option"
                          onClick={() => handleAddDependency(t.id)}
                        >
                          <span className="edit-task-dependency-option-title">{t.title}</span>
                          <span className="edit-task-dependency-option-meta">
                            {t.status} • {t.project || 'No project'} • {t.id.substring(0, 8)}
                          </span>
                        </button>
                      ))}
                    {availableTasks.filter(t => 
                      !dependsOn.includes(t.id) &&
                      (t.title.toLowerCase().includes(dependencySearch.toLowerCase()) ||
                       t.id.toLowerCase().includes(dependencySearch.toLowerCase()))
                    ).length === 0 && (
                      <div className="edit-task-dependency-empty">No matching tasks found</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Session References (read-only) */}
          {task.sessionRefs && task.sessionRefs.length > 0 && (
            <div className="edit-task-section">
              <label className="create-task-label">Session History ({task.sessionRefs.length})</label>
              <div className="edit-task-sessions">
                {task.sessionRefs.map((ref, i) => (
                  <div key={i} className="edit-task-session-ref">
                    💬 {ref}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="create-task-actions edit-task-actions">
            <button
              type="button"
              onClick={() => { if (confirm('Delete this task?')) { onDelete(task.id); onClose(); } }}
              className="create-task-btn edit-task-btn-delete"
            >
              <Trash2 size={16} /> Delete
            </button>
            <div style={{ flex: 1 }} />
            <button type="button" onClick={onClose} className="create-task-btn create-task-btn-cancel">
              Cancel
            </button>
            <button type="submit" className="create-task-btn create-task-btn-submit">
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
};
