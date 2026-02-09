import { authenticatedFetch } from '../../utils/auth';
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2 } from 'lucide-react';
import { Task, TaskPriority, TaskStatus, Subtask, TaskLink, TaskLinkType } from '../../types/task';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import './CreateTaskModal.css';
import './EditTaskModal.css';

interface CreateTaskModalProps {
  onClose: () => void;
  onCreate: (task: Partial<Task>) => void;
  existingProjects?: string[];
  existingTags?: string[];
}

const generateId = () => crypto.randomUUID?.() || Math.random().toString(36).substring(2, 15);

const LINK_TYPE_OPTIONS: { value: TaskLinkType; label: string; icon: string }[] = [
  { value: 'project', label: 'Project', icon: '📁' },
  { value: 'doc', label: 'Document', icon: '📄' },
  { value: 'git', label: 'Git Repo', icon: '🔀' },
  { value: 'memory', label: 'Memory File', icon: '🧠' },
  { value: 'session', label: 'Session', icon: '💬' },
  { value: 'tool', label: 'Tool', icon: '🔧' },
];

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

interface ProjectOption {
  id: string;
  name: string;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export const CreateTaskModal: React.FC<CreateTaskModalProps> = ({
  onClose,
  onCreate,
  existingProjects = [],
  existingTags = []
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [project, setProject] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [tags, setTags] = useState('');
  const [autoStart, setAutoStart] = useState(true);
  const [model, setModel] = useState('');
  const [executionMode, setExecutionMode] = useState<'main' | 'subagent'>('subagent');
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [links, setLinks] = useState<TaskLink[]>([]);
  const [blockedReason, setBlockedReason] = useState('');
  const [newSubtask, setNewSubtask] = useState('');
  const [newLinkTitle, setNewLinkTitle] = useState('');
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [newLinkType, setNewLinkType] = useState<TaskLinkType>('doc');
  const [error, setError] = useState('');
  const [apiProjects, setApiProjects] = useState<ProjectOption[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);

  // Fetch projects from API for the dropdown
  useEffect(() => {
    authenticatedFetch(`${API_BASE_URL}/projects`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.projects) {
          setApiProjects(data.projects.map((p: any) => ({ id: p.id, name: p.name })));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

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

    onCreate({
      title: title.trim(),
      description: description.trim(),
      project: project.trim() || undefined,
      priority,
      status,
      tags: parsedTags,
      autoStart,
      model: model || undefined,
      executionMode,
      subtasks,
      links,
      blockedReason: status === 'stuck' ? blockedReason.trim() : undefined,
    });
  };

  const handleAddSubtask = () => {
    if (!newSubtask.trim()) return;
    setSubtasks([...subtasks, {
      id: generateId(),
      text: newSubtask.trim(),
      completed: false,
      status: 'new' as const,
    }]);
    setNewSubtask('');
  };

  const handleRemoveSubtask = (id: string) => {
    setSubtasks(subtasks.filter(s => s.id !== id));
  };

  const handleToggleSubtask = (id: string) => {
    setSubtasks(subtasks.map(s =>
      s.id === id
        ? { ...s, completed: !s.completed, completedAt: !s.completed ? new Date().toISOString() : undefined }
        : s
    ));
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

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return createPortal(
    <div className="create-task-overlay" onClick={handleBackdropClick}>
      <div className="create-task-modal edit-task-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Task modal">
        {/* Header */}
        <div className="create-task-modal-header">
          <h2>Create New Task</h2>
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
              placeholder="What needs to be done?"
            />
            {error && <span className="edit-task-error">{error}</span>}
          </div>

          {/* Description */}
          <div className="create-task-field">
            <label className="create-task-label">Description (Markdown)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="create-task-textarea edit-task-textarea-large"
              placeholder="Rich description with markdown support..."
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
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className="create-task-select"
              >
                <option value="">No project</option>
                {/* Projects from API */}
                {apiProjects.map(p => (
                  <option key={p.id} value={p.name}>{p.name}</option>
                ))}
                {/* Also show any existing project strings not in API */}
                {existingProjects
                  .filter(ep => !apiProjects.some(ap => ap.name === ep))
                  .map(p => <option key={p} value={p}>{p}</option>)
                }
              </select>
            </div>

            <div className="create-task-field" style={{ flex: 1 }}>
              <label className="create-task-label">Tags (comma-separated)</label>
              <input
                type="text"
                list="tag-suggestions"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                className="create-task-input"
                placeholder="phase-4, frontend, ux"
              />
              <datalist id="tag-suggestions">
                {existingTags.map(t => <option key={t} value={t} />)}
              </datalist>
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
                <span className="edit-task-toggle-hint">Bot can pick this up during heartbeats</span>
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

          {/* Subtasks Section */}
          <div className="edit-task-section">
            <label className="create-task-label">
              Subtasks ({subtasks.filter(s => s.completed).length}/{subtasks.length})
            </label>
            <div className="edit-task-subtasks">
              {subtasks.map(subtask => (
                <div key={subtask.id} className="edit-task-subtask-item">
                  <button
                    type="button"
                    className={`edit-task-subtask-check ${subtask.completed ? 'checked' : ''}`}
                    onClick={() => handleToggleSubtask(subtask.id)}
                  >
                    {subtask.completed && '✓'}
                  </button>
                  <span className={`edit-task-subtask-text ${subtask.completed ? 'completed' : ''}`}>
                    {subtask.text}
                  </span>
                  <button
                    type="button"
                    className="edit-task-subtask-remove"
                    onClick={() => handleRemoveSubtask(subtask.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
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

          {/* Actions */}
          <div className="create-task-actions">
            <button type="button" onClick={onClose} className="create-task-btn create-task-btn-cancel">
              Cancel
            </button>
            <button type="submit" className="create-task-btn create-task-btn-submit">
              Create Task
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
};
