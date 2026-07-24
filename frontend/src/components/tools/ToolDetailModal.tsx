import React, { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Save, Trash2, Pencil, Globe, Tag, Wrench, Plus, AlertTriangle } from 'lucide-react';
import { Tool, CreateToolInput, UpdateToolInput } from '../../types/tool';
import { authenticatedFetch } from '../../utils/auth';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import './ToolDetailModal.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface ToolDetailModalProps {
  tool: Tool | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}

export const ToolDetailModal: React.FC<ToolDetailModalProps> = ({ tool, onClose, onSaved, onDeleted }) => {
  const isCreate = tool === null;
  const [editing, setEditing] = useState(isCreate);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  // Form state
  const [name, setName] = useState(tool?.name || '');
  const [category, setCategory] = useState(tool?.category || '');
  const [description, setDescription] = useState(tool?.description || '');
  const [usageInstructions, setUsageInstructions] = useState(tool?.usage_instructions || '');
  const [configText, setConfigText] = useState(tool ? JSON.stringify(tool.config, null, 2) : '{}');
  const [tags, setTags] = useState<string[]>(tool?.tags || []);
  const [tagInput, setTagInput] = useState('');
  const [isGlobal, setIsGlobal] = useState(tool?.is_global || false);

  const handleAddTag = useCallback(() => {
    const trimmed = tagInput.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
    }
    setTagInput('');
  }, [tagInput, tags]);

  const handleRemoveTag = useCallback((tag: string) => {
    setTags(tags.filter(t => t !== tag));
  }, [tags]);

  const handleTagKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    }
  }, [handleAddTag]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      setError('Tool name is required');
      return;
    }

    // Validate JSON config
    let config: Record<string, any>;
    try {
      config = JSON.parse(configText);
    } catch {
      setError('Invalid JSON in config');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const body: CreateToolInput | UpdateToolInput = {
        name: name.trim(),
        category: category.trim() || undefined,
        description: description.trim() || undefined,
        usage_instructions: usageInstructions.trim() || undefined,
        config,
        tags,
        is_global: isGlobal,
      };

      const url = isCreate
        ? `${API_BASE_URL}/tools`
        : `${API_BASE_URL}/tools/${tool!.id}`;

      const response = await authenticatedFetch(url, {
        method: isCreate ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json();
      if (data.success) {
        onSaved();
      } else {
        setError(data.error || 'Failed to save tool');
      }
    } catch {
      setError('Failed to save tool');
    } finally {
      setSaving(false);
    }
  }, [name, category, description, usageInstructions, configText, tags, isGlobal, isCreate, tool, onSaved]);

  const handleDelete = useCallback(async () => {
    if (!tool) return;
    setDeleting(true);
    setError(null);

    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tools/${tool.id}`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (data.success) {
        onDeleted();
      } else {
        setError(data.error || 'Failed to delete tool');
      }
    } catch {
      setError('Failed to delete tool');
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [tool, onDeleted]);

  const handleCancelEdit = useCallback(() => {
    if (isCreate) {
      onClose();
    } else {
      setName(tool!.name);
      setCategory(tool!.category || '');
      setDescription(tool!.description || '');
      setUsageInstructions(tool!.usage_instructions || '');
      setConfigText(JSON.stringify(tool!.config, null, 2));
      setTags(tool!.tags || []);
      setIsGlobal(tool!.is_global);
      setEditing(false);
      setError(null);
    }
  }, [isCreate, tool, onClose]);

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="tool-detail-modal" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="tool-detail-header">
          <div className="tool-detail-title">
            <Wrench size={20} />
            <h2>{isCreate ? 'Create New Tool' : (editing ? 'Edit Tool' : tool!.name)}</h2>
            {!isCreate && !editing && (
              <div className="tool-detail-badges">
                {tool!.is_global && (
                  <span className="tool-badge tool-badge-global"><Globe size={12} /> Global</span>
                )}
                <span className="tool-badge tool-badge-version">v{tool!.version}</span>
              </div>
            )}
          </div>
          <div className="tool-detail-actions">
            {!isCreate && !editing && (
              <button className="btn-edit-tool" onClick={() => setEditing(true)}>
                <Pencil size={14} /> Edit
              </button>
            )}
            {!isCreate && (
              <button
                className="btn-delete-tool"
                onClick={() => setShowDeleteConfirm(true)}
                title="Delete tool"
              >
                <Trash2 size={14} />
              </button>
            )}
            <button className="modal-close" onClick={onClose}>
              <X size={24} />
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="tool-detail-error">
            <AlertTriangle size={14} /> {error}
          </div>
        )}

        {/* Content */}
        <div className="tool-detail-content">
          {editing ? (
            /* Edit/Create Form */
            <div className="tool-form">
              <div className="form-group">
                <label htmlFor="tool-name">Name *</label>
                <input
                  id="tool-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Tool name"
                  className="form-input"
                  autoFocus
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="tool-category">Category</label>
                  <input
                    id="tool-category"
                    type="text"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="e.g., development, deployment"
                    className="form-input"
                  />
                </div>

                <div className="form-group form-group-toggle">
                  <label>Global Tool</label>
                  <button
                    type="button"
                    className={`toggle-btn ${isGlobal ? 'toggle-on' : 'toggle-off'}`}
                    onClick={() => setIsGlobal(!isGlobal)}
                    title={isGlobal ? 'Available to all projects' : 'Must be linked to projects'}
                  >
                    <Globe size={14} />
                    {isGlobal ? 'Global' : 'Project-specific'}
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="tool-description">Description</label>
                <textarea
                  id="tool-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description of what this tool does"
                  className="form-textarea"
                  rows={2}
                />
              </div>

              <div className="form-group">
                <label htmlFor="tool-instructions">Usage Instructions</label>
                <textarea
                  id="tool-instructions"
                  value={usageInstructions}
                  onChange={(e) => setUsageInstructions(e.target.value)}
                  placeholder="Detailed instructions for how agents should use this tool..."
                  className="form-textarea form-textarea-lg"
                  rows={6}
                />
              </div>

              <div className="form-group">
                <label htmlFor="tool-config">Config (JSON)</label>
                <textarea
                  id="tool-config"
                  value={configText}
                  onChange={(e) => setConfigText(e.target.value)}
                  placeholder="{}"
                  className="form-textarea form-textarea-mono"
                  rows={4}
                />
              </div>

              <div className="form-group">
                <label>Tags</label>
                <div className="tag-input-container">
                  <div className="tag-list">
                    {tags.map(tag => (
                      <span key={tag} className="tag-item">
                        {tag}
                        <button onClick={() => handleRemoveTag(tag)} className="tag-remove">
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="tag-add-row">
                    <input
                      type="text"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={handleTagKeyDown}
                      placeholder="Add tag..."
                      className="form-input tag-add-input"
                    />
                    <button
                      type="button"
                      onClick={handleAddTag}
                      className="btn-add-tag"
                      disabled={!tagInput.trim()}
                    >
                      <Plus size={14} /> Add
                    </button>
                  </div>
                </div>
              </div>

              {/* Form Actions */}
              <div className="form-actions">
                <button className="btn-cancel" onClick={handleCancelEdit}>Cancel</button>
                <button className="btn-save" onClick={handleSave} disabled={saving}>
                  <Save size={14} />
                  {saving ? 'Saving...' : (isCreate ? 'Create Tool' : 'Save Changes')}
                </button>
              </div>
            </div>
          ) : (
            /* View Mode */
            <div className="tool-view">
              {tool!.category && (
                <div className="tool-view-category">
                  <span className="view-label">Category</span>
                  <span className="view-value">{tool!.category}</span>
                </div>
              )}

              {tool!.description && (
                <div className="tool-view-section">
                  <span className="view-label">Description</span>
                  <p className="view-text">{tool!.description}</p>
                </div>
              )}

              {tool!.usage_instructions && (
                <div className="tool-view-section">
                  <span className="view-label">Usage Instructions</span>
                  <pre className="view-instructions">{tool!.usage_instructions}</pre>
                </div>
              )}

              {tool!.config && Object.keys(tool!.config).length > 0 && (
                <div className="tool-view-section">
                  <span className="view-label">Config</span>
                  <pre className="view-config">{JSON.stringify(tool!.config, null, 2)}</pre>
                </div>
              )}

              {tool!.tags && tool!.tags.length > 0 && (
                <div className="tool-view-section">
                  <span className="view-label">Tags</span>
                  <div className="tool-view-tags">
                    {tool!.tags.map(tag => (
                      <span key={tag} className="tool-tag"><Tag size={12} /> {tag}</span>
                    ))}
                  </div>
                </div>
              )}

              <div className="tool-view-meta">
                <div className="meta-item">
                  <span className="meta-label">Created</span>
                  <span className="meta-value">{formatDate(tool!.created_at)}</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Updated</span>
                  <span className="meta-value">{formatDate(tool!.updated_at)}</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Version</span>
                  <span className="meta-value">v{tool!.version}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Delete Confirmation */}
        {showDeleteConfirm && (
          <div className="delete-confirm-overlay" onClick={() => setShowDeleteConfirm(false)}>
            <div className="delete-confirm-dialog" onClick={e => e.stopPropagation()}>
              <h3><AlertTriangle size={18} /> Delete Tool</h3>
              <p>Are you sure you want to delete <strong>{tool!.name}</strong>? This will also unlink it from all projects.</p>
              <div className="delete-confirm-actions">
                <button className="btn-cancel" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
                <button className="btn-delete-confirm" onClick={handleDelete} disabled={deleting}>
                  <Trash2 size={14} />
                  {deleting ? 'Deleting...' : 'Delete Tool'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
