import React, { useState } from 'react';
import { 
  GitBranch, 
  Globe, 
  FolderOpen, 
  BookOpen, 
  ExternalLink, 
  ChevronDown, 
  ChevronRight,
  Server,
  HardDrive,
  FileCode,
  Lightbulb,
  Copy,
  Check
} from 'lucide-react';
import { ProjectResources as ProjectResourcesType, NotebookConfig } from '../../types/project';
import './ProjectResources.css';

interface ProjectResourcesProps {
  resources: ProjectResourcesType;
  compact?: boolean;
}

export const ProjectResources: React.FC<ProjectResourcesProps> = ({ resources, compact = false }) => {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    repositories: true,
    environments: true,
    localPaths: false,
    notebooks: true,
  });
  const [copiedItem, setCopiedItem] = useState<string | null>(null);

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedItem(id);
      setTimeout(() => setCopiedItem(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const hasContent = (obj: any): boolean => {
    if (!obj) return false;
    return Object.values(obj).some(v => v !== undefined && v !== null && v !== '');
  };

  const renderCopyButton = (text: string, id: string) => (
    <button
      className="resource-copy-btn"
      onClick={(e) => { e.stopPropagation(); copyToClipboard(text, id); }}
      title="Copy to clipboard"
    >
      {copiedItem === id ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );

  const renderSection = (
    title: string,
    icon: React.ReactNode,
    sectionKey: string,
    content: React.ReactNode
  ) => {
    const isExpanded = expandedSections[sectionKey];
    
    return (
      <div className={`resource-section ${isExpanded ? 'expanded' : ''}`}>
        <button
          className="resource-section-header"
          onClick={() => toggleSection(sectionKey)}
        >
          <span className="resource-section-icon">{icon}</span>
          <span className="resource-section-title">{title}</span>
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        {isExpanded && (
          <div className="resource-section-content">
            {content}
          </div>
        )}
      </div>
    );
  };

  const renderNotebook = (notebook: NotebookConfig, label: string) => (
    <div className="notebook-item">
      <div className="notebook-header">
        <BookOpen size={14} />
        <span className="notebook-label">{label}</span>
        <a 
          href={notebook.url} 
          target="_blank" 
          rel="noopener noreferrer"
          className="notebook-link"
        >
          <ExternalLink size={12} />
        </a>
      </div>
      {notebook.description && (
        <p className="notebook-description">{notebook.description}</p>
      )}
      {notebook.queryTips && notebook.queryTips.length > 0 && (
        <div className="notebook-tips">
          <div className="tips-header">
            <Lightbulb size={12} />
            <span>Query Tips</span>
          </div>
          <ul className="tips-list">
            {notebook.queryTips.map((tip, i) => (
              <li key={i} className="tip-item">{tip}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  if (!resources || !hasContent(resources)) {
    return (
      <div className="project-resources empty">
        <p className="no-resources">No resources configured</p>
      </div>
    );
  }

  return (
    <div className={`project-resources ${compact ? 'compact' : ''}`}>
      {/* Repositories */}
      {hasContent(resources.repositories) && renderSection(
        'Repositories',
        <GitBranch size={16} />,
        'repositories',
        <div className="resource-items">
          {resources.repositories?.main && (
            <div className="resource-item">
              <span className="resource-label">Main</span>
              <a 
                href={resources.repositories.main} 
                target="_blank" 
                rel="noopener noreferrer"
                className="resource-value link"
              >
                {resources.repositories.main}
              </a>
              {renderCopyButton(resources.repositories.main, 'repo-main')}
            </div>
          )}
          {resources.repositories?.additional?.map((repo, i) => (
            <div key={i} className="resource-item">
              <span className="resource-label">Additional</span>
              <a 
                href={repo} 
                target="_blank" 
                rel="noopener noreferrer"
                className="resource-value link"
              >
                {repo}
              </a>
              {renderCopyButton(repo, `repo-add-${i}`)}
            </div>
          ))}
        </div>
      )}

      {/* Environments */}
      {hasContent(resources.environments) && renderSection(
        'Environments',
        <Globe size={16} />,
        'environments',
        <div className="resource-items">
          {resources.environments?.production && (
            <div className="resource-item">
              <span className="resource-label env-prod">Production</span>
              <a 
                href={resources.environments.production} 
                target="_blank" 
                rel="noopener noreferrer"
                className="resource-value link"
              >
                {resources.environments.production}
              </a>
              {renderCopyButton(resources.environments.production, 'env-prod')}
            </div>
          )}
          {resources.environments?.development && (
            <div className="resource-item">
              <span className="resource-label env-dev">Development</span>
              <a 
                href={resources.environments.development} 
                target="_blank" 
                rel="noopener noreferrer"
                className="resource-value link"
              >
                {resources.environments.development}
              </a>
              {renderCopyButton(resources.environments.development, 'env-dev')}
            </div>
          )}
          {resources.environments?.staging && (
            <div className="resource-item">
              <span className="resource-label env-staging">Staging</span>
              <a 
                href={resources.environments.staging} 
                target="_blank" 
                rel="noopener noreferrer"
                className="resource-value link"
              >
                {resources.environments.staging}
              </a>
              {renderCopyButton(resources.environments.staging, 'env-staging')}
            </div>
          )}
        </div>
      )}

      {/* Local Paths */}
      {hasContent(resources.localPaths) && renderSection(
        'Local Paths',
        <FolderOpen size={16} />,
        'localPaths',
        <div className="resource-items">
          {resources.localPaths?.nfsRoot && (
            <div className="resource-item">
              <span className="resource-label"><HardDrive size={12} /> NFS Root</span>
              <code className="resource-value path">{resources.localPaths.nfsRoot}</code>
              {renderCopyButton(resources.localPaths.nfsRoot, 'path-nfs')}
            </div>
          )}
          {resources.localPaths?.ssdBuild && (
            <div className="resource-item">
              <span className="resource-label"><Server size={12} /> SSD Build</span>
              <code className="resource-value path">{resources.localPaths.ssdBuild}</code>
              {renderCopyButton(resources.localPaths.ssdBuild, 'path-ssd')}
            </div>
          )}
          {resources.localPaths?.dockerCompose && (
            <div className="resource-item">
              <span className="resource-label"><FileCode size={12} /> Docker Compose</span>
              <code className="resource-value path">{resources.localPaths.dockerCompose}</code>
              {renderCopyButton(resources.localPaths.dockerCompose, 'path-docker')}
            </div>
          )}
        </div>
      )}

      {/* Notebooks */}
      {hasContent(resources.notebooks) && renderSection(
        'NotebookLM',
        <BookOpen size={16} />,
        'notebooks',
        <div className="notebooks-container">
          {resources.notebooks?.documentation && 
            renderNotebook(resources.notebooks.documentation, 'Documentation')}
          {resources.notebooks?.research && 
            renderNotebook(resources.notebooks.research, 'Research')}
          {resources.notebooks?.additional?.map((nb, i) => 
            renderNotebook(nb, nb.name || `Notebook ${i + 1}`)
          )}
        </div>
      )}
    </div>
  );
};
