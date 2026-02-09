import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Search, X, Filter, ChevronDown, ChevronUp } from 'lucide-react';
import { Task, TaskPriority } from '../../types/task';
import './FilterBar.css';

export interface TaskFilters {
  searchQuery: string;
  priorities: TaskPriority[];
  tags: string[];
  projects: string[];
}

interface FilterBarProps {
  tasks: Task[];
  filters: TaskFilters;
  onFiltersChange: (filters: TaskFilters) => void;
}

export const FilterBar: React.FC<FilterBarProps> = ({ tasks, filters, onFiltersChange }) => {
  const [searchInput, setSearchInput] = useState(filters.searchQuery);
  const [showPriorityDropdown, setShowPriorityDropdown] = useState(false);
  const [showTagsDropdown, setShowTagsDropdown] = useState(false);
  const [showProjectsDropdown, setShowProjectsDropdown] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [tagSearchQuery, setTagSearchQuery] = useState('');
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const tagSearchInputRef = useRef<HTMLInputElement>(null);
  const projectSearchInputRef = useRef<HTMLInputElement>(null);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      onFiltersChange({ ...filters, searchQuery: searchInput });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Auto-focus tag search input when dropdown opens, clear when it closes
  useEffect(() => {
    if (showTagsDropdown) {
      // Small delay to ensure the input is rendered
      setTimeout(() => {
        tagSearchInputRef.current?.focus();
      }, 10);
    } else {
      // Clear search when dropdown closes
      setTagSearchQuery('');
    }
  }, [showTagsDropdown]);

  // Auto-focus project search input when dropdown opens, clear when it closes
  useEffect(() => {
    if (showProjectsDropdown) {
      setTimeout(() => {
        projectSearchInputRef.current?.focus();
      }, 10);
    } else {
      setProjectSearchQuery('');
    }
  }, [showProjectsDropdown]);

  // Extract unique values from all tasks
  const availableTags = useMemo(() => {
    const tagSet = new Set<string>();
    tasks.forEach(task => {
      task.tags?.forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }, [tasks]);

  // Filter tags based on search query
  const filteredTags = useMemo(() => {
    if (!tagSearchQuery.trim()) {
      return availableTags;
    }
    const query = tagSearchQuery.toLowerCase().trim();
    return availableTags.filter(tag => tag.toLowerCase().includes(query));
  }, [availableTags, tagSearchQuery]);

  const availableProjects = useMemo(() => {
    const projectSet = new Set<string>();
    tasks.forEach(task => {
      if (task.project) projectSet.add(task.project);
    });
    return Array.from(projectSet).sort();
  }, [tasks]);

  const filteredProjects = useMemo(() => {
    if (!projectSearchQuery.trim()) {
      return availableProjects;
    }
    const query = projectSearchQuery.toLowerCase().trim();
    return availableProjects.filter(project => project.toLowerCase().includes(query));
  }, [availableProjects, projectSearchQuery]);

  const priorities: TaskPriority[] = ['urgent', 'high', 'normal', 'low', 'someday'];

  const activeFilterCount = 
    (filters.searchQuery ? 1 : 0) +
    filters.priorities.length +
    filters.tags.length +
    filters.projects.length;

  const clearAllFilters = () => {
    setSearchInput('');
    onFiltersChange({
      searchQuery: '',
      priorities: [],
      tags: [],
      projects: []
    });
  };

  const togglePriority = (priority: TaskPriority) => {
    const newPriorities = filters.priorities.includes(priority)
      ? filters.priorities.filter(p => p !== priority)
      : [...filters.priorities, priority];
    onFiltersChange({ ...filters, priorities: newPriorities });
  };

  const toggleTag = (tag: string) => {
    const newTags = filters.tags.includes(tag)
      ? filters.tags.filter(t => t !== tag)
      : [...filters.tags, tag];
    onFiltersChange({ ...filters, tags: newTags });
  };

  const toggleProject = (project: string) => {
    const newProjects = filters.projects.includes(project)
      ? filters.projects.filter(p => p !== project)
      : [...filters.projects, project];
    onFiltersChange({ ...filters, projects: newProjects });
  };

  const hasActiveTagFilter = filters.tags.length > 0;

  return (
    <div className={`filter-bar ${hasActiveTagFilter ? 'filter-bar-tag-active' : ''}`}>
      {/* Active Tag Filters Display */}
      {hasActiveTagFilter && (
        <div className="filter-bar-active-tags">
          <span className="filter-bar-active-tags-label">Filtering by:</span>
          {filters.tags.map(tag => (
            <span key={tag} className="filter-bar-active-tag">
              {tag}
              <button
                onClick={() => toggleTag(tag)}
                className="filter-bar-active-tag-remove"
                aria-label={`Remove ${tag} filter`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <button
            onClick={() => onFiltersChange({ ...filters, tags: [] })}
            className="filter-bar-clear-tags"
          >
            Clear tag filter
          </button>
        </div>
      )}

      <div className="filter-bar-search">
        <Search size={18} className="filter-bar-search-icon" />
        <input
          type="text"
          placeholder="Search tasks by title or description..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="filter-bar-search-input"
        />
        {searchInput && (
          <button
            onClick={() => setSearchInput('')}
            className="filter-bar-clear-search"
            aria-label="Clear search"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <button
        className="filter-bar-toggle-mobile"
        onClick={() => setFiltersExpanded(!filtersExpanded)}
      >
        <Filter size={14} />
        Filters {activeFilterCount > 0 && `(${activeFilterCount})`}
        {filtersExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      <div className={`filter-bar-filters ${filtersExpanded ? 'filter-bar-filters-expanded' : ''}`}>
        {/* Priority Filter */}
        <div className="filter-dropdown">
          <button
            onClick={() => {
              setShowPriorityDropdown(!showPriorityDropdown);
              setShowTagsDropdown(false);
              setShowProjectsDropdown(false);
            }}
            className={`filter-dropdown-button ${filters.priorities.length > 0 ? 'active' : ''}`}
          >
            <Filter size={14} />
            Priority
            {filters.priorities.length > 0 && (
              <span className="filter-badge">{filters.priorities.length}</span>
            )}
          </button>
          {showPriorityDropdown && (
            <div className="filter-dropdown-menu">
              {priorities.map(priority => (
                <label key={priority} className="filter-dropdown-item">
                  <input
                    type="checkbox"
                    checked={filters.priorities.includes(priority)}
                    onChange={() => togglePriority(priority)}
                  />
                  <span className={`filter-priority-dot priority-dot-${priority}`}></span>
                  <span>{priority}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Tags Filter */}
        <div className="filter-dropdown">
          <button
            onClick={() => {
              setShowTagsDropdown(!showTagsDropdown);
              setShowPriorityDropdown(false);
              setShowProjectsDropdown(false);
            }}
            className={`filter-dropdown-button ${filters.tags.length > 0 ? 'active' : ''}`}
            disabled={availableTags.length === 0}
          >
            <Filter size={14} />
            Tags
            {filters.tags.length > 0 && (
              <span className="filter-badge">{filters.tags.length}</span>
            )}
          </button>
          {showTagsDropdown && availableTags.length > 0 && (
            <div className="filter-dropdown-menu filter-dropdown-menu-with-search">
              <div className="filter-dropdown-search">
                <Search size={14} className="filter-dropdown-search-icon" />
                <input
                  ref={tagSearchInputRef}
                  type="text"
                  placeholder="Search tags..."
                  value={tagSearchQuery}
                  onChange={(e) => setTagSearchQuery(e.target.value)}
                  className="filter-dropdown-search-input"
                  onClick={(e) => e.stopPropagation()}
                />
                {tagSearchQuery && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setTagSearchQuery('');
                      tagSearchInputRef.current?.focus();
                    }}
                    className="filter-dropdown-search-clear"
                    aria-label="Clear search"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <div className="filter-dropdown-items">
                {filteredTags.length > 0 ? (
                  filteredTags.map(tag => (
                    <label key={tag} className="filter-dropdown-item">
                      <input
                        type="checkbox"
                        checked={filters.tags.includes(tag)}
                        onChange={() => toggleTag(tag)}
                      />
                      <span>{tag}</span>
                    </label>
                  ))
                ) : (
                  <div className="filter-dropdown-empty">
                    No tags found
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Projects Filter */}
        <div className="filter-dropdown">
          <button
            onClick={() => {
              setShowProjectsDropdown(!showProjectsDropdown);
              setShowPriorityDropdown(false);
              setShowTagsDropdown(false);
            }}
            className={`filter-dropdown-button ${filters.projects.length > 0 ? 'active' : ''}`}
            disabled={availableProjects.length === 0}
          >
            <Filter size={14} />
            Project
            {filters.projects.length > 0 && (
              <span className="filter-badge">{filters.projects.length}</span>
            )}
          </button>
          {showProjectsDropdown && availableProjects.length > 0 && (
            <div className="filter-dropdown-menu filter-dropdown-menu-with-search">
              <div className="filter-dropdown-search">
                <Search size={14} className="filter-dropdown-search-icon" />
                <input
                  ref={projectSearchInputRef}
                  type="text"
                  placeholder="Search projects..."
                  value={projectSearchQuery}
                  onChange={(e) => setProjectSearchQuery(e.target.value)}
                  className="filter-dropdown-search-input"
                  onClick={(e) => e.stopPropagation()}
                />
                {projectSearchQuery && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setProjectSearchQuery('');
                      projectSearchInputRef.current?.focus();
                    }}
                    className="filter-dropdown-search-clear"
                    aria-label="Clear search"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <div className="filter-dropdown-items">
                {filteredProjects.length > 0 ? (
                  filteredProjects.map(project => (
                    <label key={project} className="filter-dropdown-item">
                      <input
                        type="checkbox"
                        checked={filters.projects.includes(project)}
                        onChange={() => toggleProject(project)}
                      />
                      <span>#{project}</span>
                    </label>
                  ))
                ) : (
                  <div className="filter-dropdown-empty">
                    No projects found
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Clear All Button */}
        {activeFilterCount > 0 && (
          <button
            onClick={clearAllFilters}
            className="filter-clear-all"
            aria-label="Clear all filters"
          >
            <X size={14} />
            Clear All ({activeFilterCount})
          </button>
        )}
      </div>
    </div>
  );
};
