import { authenticatedFetch } from '../utils/auth';
import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Search, SlidersHorizontal, Wrench, Globe, Tag, X } from 'lucide-react';
import { Tool } from '../types/tool';
import { ToolDetailModal } from '../components/tools/ToolDetailModal';
import { Button } from '../components/Button';
import './ToolsPage.css';

type ViewFilter = 'all' | 'global';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export const ToolsPage: React.FC = () => {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [viewFilter, setViewFilter] = useState<ViewFilter>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const fetchTools = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (searchQuery) params.set('search', searchQuery);
      if (categoryFilter) params.set('category', categoryFilter);
      if (tagFilter) params.set('tag', tagFilter);
      const query = params.toString();
      const response = await authenticatedFetch(`${API_BASE_URL}/tools${query ? `?${query}` : ''}`);
      const data = await response.json();
      if (data.success) {
        setTools(data.tools || []);
      } else {
        setError(data.error || 'Failed to fetch tools');
      }
    } catch (err) {
      setError('Failed to connect to API');
    } finally {
      setLoading(false);
    }
  }, [searchQuery, categoryFilter, tagFilter]);

  useEffect(() => {
    fetchTools();
  }, [fetchTools]);

  // Derive unique categories and tags from tools
  const categories = Array.from(new Set(tools.map(t => t.category).filter(Boolean))) as string[];
  const allTags = Array.from(new Set(tools.flatMap(t => t.tags || [])));

  // Client-side filter for view toggle (global vs all)
  const displayedTools = viewFilter === 'global' ? tools.filter(t => t.is_global) : tools;

  const handleToolSaved = useCallback(() => {
    fetchTools();
    setSelectedTool(null);
    setShowCreateModal(false);
  }, [fetchTools]);

  const handleToolDeleted = useCallback(() => {
    fetchTools();
    setSelectedTool(null);
  }, [fetchTools]);

  return (
    <div className="tools-page">
      {/* Header */}
      <div className="tools-page-header">
        <div className="tools-page-header-title">
          <h1><Wrench size={24} /> Tools Registry</h1>
          <p>Manage tools available to agents and projects</p>
        </div>
        <div className="tools-page-header-actions">
          <Button onClick={() => setShowCreateModal(true)}>
            <Plus size={16} />
            New Tool
          </Button>
        </div>
      </div>

      {/* View Toggle */}
      <div className="tools-view-toggle">
        <button
          className={`view-toggle-btn ${viewFilter === 'all' ? 'active' : ''}`}
          onClick={() => setViewFilter('all')}
        >
          All Tools ({tools.length})
        </button>
        <button
          className={`view-toggle-btn ${viewFilter === 'global' ? 'active' : ''}`}
          onClick={() => setViewFilter('global')}
        >
          <Globe size={14} />
          Global Tools ({tools.filter(t => t.is_global).length})
        </button>
      </div>

      {/* Controls */}
      <div className="tools-page-controls">
        <div className="tools-search">
          <Search size={16} className="search-icon" />
          <input
            type="text"
            placeholder="Search tools..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          {searchQuery && (
            <button className="search-clear" onClick={() => setSearchQuery('')}>
              <X size={14} />
            </button>
          )}
        </div>

        <div className="tools-category-filter">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="sort-select"
          >
            <option value="">All Categories</option>
            {categories.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>

        <button
          className={`filter-toggle ${showFilters ? 'active' : ''}`}
          onClick={() => setShowFilters(!showFilters)}
        >
          <SlidersHorizontal size={16} />
          Filters
        </button>
      </div>

      {/* Tag Filters */}
      {showFilters && (
        <div className="tools-filters">
          <div className="filter-group">
            <label><Tag size={14} /> Tags</label>
            <div className="filter-options">
              <button
                className={`filter-option ${tagFilter === '' ? 'active' : ''}`}
                onClick={() => setTagFilter('')}
              >
                All
              </button>
              {allTags.map(tag => (
                <button
                  key={tag}
                  className={`filter-option ${tagFilter === tag ? 'active' : ''}`}
                  onClick={() => setTagFilter(tagFilter === tag ? '' : tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="tools-page-loading">
          <div className="loading-spinner" />
          Loading tools...
        </div>
      ) : error ? (
        <div className="tools-empty">
          <p className="error-message">{error}</p>
          <button className="retry-btn" onClick={fetchTools}>Retry</button>
        </div>
      ) : displayedTools.length === 0 ? (
        <div className="tools-empty">
          <Wrench size={40} />
          <p>No tools found</p>
          <p className="empty-hint">
            {searchQuery || categoryFilter || tagFilter
              ? 'Try adjusting your search or filters'
              : 'Create your first tool to get started'}
          </p>
        </div>
      ) : (
        <div className="tools-grid">
          {displayedTools.map(tool => (
            <div
              key={tool.id}
              className="tool-card"
              onClick={() => setSelectedTool(tool)}
            >
              <div className="tool-card-header">
                <div className="tool-card-name">
                  <Wrench size={16} />
                  <h3>{tool.name}</h3>
                </div>
                <div className="tool-card-badges">
                  {tool.is_global && (
                    <span className="tool-badge tool-badge-global">
                      <Globe size={12} /> Global
                    </span>
                  )}
                  <span className="tool-badge tool-badge-version">v{tool.version}</span>
                </div>
              </div>

              {tool.category && (
                <div className="tool-card-category">{tool.category}</div>
              )}

              {tool.description && (
                <p className="tool-card-description">{tool.description}</p>
              )}

              {tool.tags && tool.tags.length > 0 && (
                <div className="tool-card-tags">
                  {tool.tags.map(tag => (
                    <span key={tag} className="tool-tag">{tag}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Tool Detail/Edit Modal */}
      {selectedTool && (
        <ToolDetailModal
          tool={selectedTool}
          onClose={() => setSelectedTool(null)}
          onSaved={handleToolSaved}
          onDeleted={handleToolDeleted}
        />
      )}

      {/* Create Tool Modal */}
      {showCreateModal && (
        <ToolDetailModal
          tool={null}
          onClose={() => setShowCreateModal(false)}
          onSaved={handleToolSaved}
          onDeleted={() => {}}
        />
      )}
    </div>
  );
};
