import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2, GitBranch, Globe, FolderOpen, BookOpen, Lightbulb, Save } from 'lucide-react';
import { ProjectResources, ToolInstructions } from '../../types/project';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import './ProjectResourcesEditModal.css';

interface ProjectResourcesEditModalProps {
  projectId: string;
  projectName: string;
  initialResources?: ProjectResources;
  initialToolInstructions?: ToolInstructions;
  onClose: () => void;
  onSave: (resources: ProjectResources, toolInstructions: ToolInstructions) => Promise<void>;
}

interface NotebookFormData {
  id: string;
  url: string;
  description: string;
  queryTips: string;
  name?: string;
  type?: 'documentation' | 'research' | 'reference';
}

export const ProjectResourcesEditModal: React.FC<ProjectResourcesEditModalProps> = ({
  projectId: _projectId,
  projectName,
  initialResources,
  initialToolInstructions,
  onClose,
  onSave,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  // Repository state
  const [mainRepo, setMainRepo] = useState(initialResources?.repositories?.main || '');
  const [additionalRepos, setAdditionalRepos] = useState<string[]>(
    initialResources?.repositories?.additional || []
  );

  // Environment state
  const [envProduction, setEnvProduction] = useState(initialResources?.environments?.production || '');
  const [envDevelopment, setEnvDevelopment] = useState(initialResources?.environments?.development || '');
  const [envStaging, setEnvStaging] = useState(initialResources?.environments?.staging || '');

  // Local paths state
  const [nfsRoot, setNfsRoot] = useState(initialResources?.localPaths?.nfsRoot || '');
  const [ssdBuild, setSsdBuild] = useState(initialResources?.localPaths?.ssdBuild || '');
  const [dockerCompose, setDockerCompose] = useState(initialResources?.localPaths?.dockerCompose || '');

  // Notebooks state
  const [docNotebook, setDocNotebook] = useState<NotebookFormData>({
    id: initialResources?.notebooks?.documentation?.id || '',
    url: initialResources?.notebooks?.documentation?.url || '',
    description: initialResources?.notebooks?.documentation?.description || '',
    queryTips: initialResources?.notebooks?.documentation?.queryTips?.join('\n') || '',
  });
  const [researchNotebook, setResearchNotebook] = useState<NotebookFormData>({
    id: initialResources?.notebooks?.research?.id || '',
    url: initialResources?.notebooks?.research?.url || '',
    description: initialResources?.notebooks?.research?.description || '',
    queryTips: initialResources?.notebooks?.research?.queryTips?.join('\n') || '',
  });

  // Tool instructions state
  const [toolInstructions, setToolInstructions] = useState<ToolInstructions>({
    notebookLM: initialToolInstructions?.notebookLM || '',
    filesBrowsing: initialToolInstructions?.filesBrowsing || '',
    gitWorkflow: initialToolInstructions?.gitWorkflow || '',
    testing: initialToolInstructions?.testing || '',
    deployment: initialToolInstructions?.deployment || '',
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [activeSection, setActiveSection] = useState<'repos' | 'envs' | 'paths' | 'notebooks' | 'tools'>('repos');

  const handleAddRepo = () => {
    setAdditionalRepos([...additionalRepos, '']);
  };

  const handleUpdateRepo = (index: number, value: string) => {
    const updated = [...additionalRepos];
    updated[index] = value;
    setAdditionalRepos(updated);
  };

  const handleRemoveRepo = (index: number) => {
    setAdditionalRepos(additionalRepos.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');

    try {
      // Build resources object, only including non-empty values
      const resources: ProjectResources = {};

      // Repositories
      if (mainRepo || additionalRepos.some(r => r)) {
        resources.repositories = {};
        if (mainRepo) resources.repositories.main = mainRepo;
        const filteredAdditional = additionalRepos.filter(r => r);
        if (filteredAdditional.length > 0) resources.repositories.additional = filteredAdditional;
      }

      // Environments
      if (envProduction || envDevelopment || envStaging) {
        resources.environments = {};
        if (envProduction) resources.environments.production = envProduction;
        if (envDevelopment) resources.environments.development = envDevelopment;
        if (envStaging) resources.environments.staging = envStaging;
      }

      // Local paths
      if (nfsRoot || ssdBuild || dockerCompose) {
        resources.localPaths = {};
        if (nfsRoot) resources.localPaths.nfsRoot = nfsRoot;
        if (ssdBuild) resources.localPaths.ssdBuild = ssdBuild;
        if (dockerCompose) resources.localPaths.dockerCompose = dockerCompose;
      }

      // Notebooks
      if (docNotebook.url || researchNotebook.url) {
        resources.notebooks = {};
        if (docNotebook.url) {
          resources.notebooks.documentation = {
            id: docNotebook.id || crypto.randomUUID(),
            url: docNotebook.url,
            description: docNotebook.description,
            queryTips: docNotebook.queryTips.split('\n').filter(t => t.trim()),
          };
        }
        if (researchNotebook.url) {
          resources.notebooks.research = {
            id: researchNotebook.id || crypto.randomUUID(),
            url: researchNotebook.url,
            description: researchNotebook.description,
            queryTips: researchNotebook.queryTips.split('\n').filter(t => t.trim()),
          };
        }
      }

      // Filter out empty tool instructions
      const filteredTools: ToolInstructions = {};
      Object.entries(toolInstructions).forEach(([key, value]) => {
        if (value && value.trim()) {
          filteredTools[key as keyof ToolInstructions] = value;
        }
      });

      await onSave(resources, filteredTools);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save resources');
    } finally {
      setSaving(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      e.stopPropagation();
      onClose();
    }
  };

  const handleModalContentClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  return createPortal(
    <div className="project-resources-edit-overlay" onClick={handleBackdropClick}>
      <div className="project-resources-edit-modal" ref={modalRef} role="dialog" aria-modal="true" onClick={handleModalContentClick}>
        {/* Header */}
        <div className="project-resources-edit-header">
          <h2>Edit Resources: {projectName}</h2>
          <button onClick={onClose} className="project-resources-edit-close" aria-label="Close">
            <X size={22} />
          </button>
        </div>

        {/* Section tabs */}
        <div className="project-resources-edit-tabs">
          <button
            className={`resources-tab ${activeSection === 'repos' ? 'active' : ''}`}
            onClick={() => setActiveSection('repos')}
          >
            <GitBranch size={14} /> Repositories
          </button>
          <button
            className={`resources-tab ${activeSection === 'envs' ? 'active' : ''}`}
            onClick={() => setActiveSection('envs')}
          >
            <Globe size={14} /> Environments
          </button>
          <button
            className={`resources-tab ${activeSection === 'paths' ? 'active' : ''}`}
            onClick={() => setActiveSection('paths')}
          >
            <FolderOpen size={14} /> Paths
          </button>
          <button
            className={`resources-tab ${activeSection === 'notebooks' ? 'active' : ''}`}
            onClick={() => setActiveSection('notebooks')}
          >
            <BookOpen size={14} /> Notebooks
          </button>
          <button
            className={`resources-tab ${activeSection === 'tools' ? 'active' : ''}`}
            onClick={() => setActiveSection('tools')}
          >
            <Lightbulb size={14} /> Tool Instructions
          </button>
        </div>

        {/* Content */}
        <div className="project-resources-edit-content">
          {/* Repositories Section */}
          {activeSection === 'repos' && (
            <div className="resources-section">
              <div className="resources-field">
                <label className="resources-label">Main Repository</label>
                <input
                  type="text"
                  value={mainRepo}
                  onChange={(e) => setMainRepo(e.target.value)}
                  className="resources-input"
                  placeholder="ssh://git@example.com/org/repo.git or https://github.com/..."
                />
              </div>

              <div className="resources-field">
                <label className="resources-label">
                  Additional Repositories
                  <button type="button" className="resources-add-btn" onClick={handleAddRepo}>
                    <Plus size={14} /> Add
                  </button>
                </label>
                {additionalRepos.length === 0 ? (
                  <p className="resources-hint">No additional repositories</p>
                ) : (
                  <div className="resources-list">
                    {additionalRepos.map((repo, index) => (
                      <div key={index} className="resources-list-item">
                        <input
                          type="text"
                          value={repo}
                          onChange={(e) => handleUpdateRepo(index, e.target.value)}
                          className="resources-input"
                          placeholder="Repository URL"
                        />
                        <button
                          type="button"
                          className="resources-remove-btn"
                          onClick={() => handleRemoveRepo(index)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Environments Section */}
          {activeSection === 'envs' && (
            <div className="resources-section">
              <div className="resources-field">
                <label className="resources-label env-label-prod">Production URL</label>
                <input
                  type="text"
                  value={envProduction}
                  onChange={(e) => setEnvProduction(e.target.value)}
                  className="resources-input"
                  placeholder="https://app.example.com"
                />
              </div>

              <div className="resources-field">
                <label className="resources-label env-label-dev">Development URL</label>
                <input
                  type="text"
                  value={envDevelopment}
                  onChange={(e) => setEnvDevelopment(e.target.value)}
                  className="resources-input"
                  placeholder="https://dev.example.com"
                />
              </div>

              <div className="resources-field">
                <label className="resources-label env-label-staging">Staging URL</label>
                <input
                  type="text"
                  value={envStaging}
                  onChange={(e) => setEnvStaging(e.target.value)}
                  className="resources-input"
                  placeholder="https://staging.example.com"
                />
              </div>
            </div>
          )}

          {/* Local Paths Section */}
          {activeSection === 'paths' && (
            <div className="resources-section">
              <div className="resources-field">
                <label className="resources-label">NFS Root Path</label>
                <input
                  type="text"
                  value={nfsRoot}
                  onChange={(e) => setNfsRoot(e.target.value)}
                  className="resources-input resources-input-mono"
                  placeholder="/mnt/nfs/projects/..."
                />
              </div>

              <div className="resources-field">
                <label className="resources-label">SSD Build Path</label>
                <input
                  type="text"
                  value={ssdBuild}
                  onChange={(e) => setSsdBuild(e.target.value)}
                  className="resources-input resources-input-mono"
                  placeholder="/srv/build/..."
                />
              </div>

              <div className="resources-field">
                <label className="resources-label">Docker Compose Path</label>
                <input
                  type="text"
                  value={dockerCompose}
                  onChange={(e) => setDockerCompose(e.target.value)}
                  className="resources-input resources-input-mono"
                  placeholder="/path/to/docker-compose.yml"
                />
              </div>
            </div>
          )}

          {/* Notebooks Section */}
          {activeSection === 'notebooks' && (
            <div className="resources-section">
              <div className="notebook-form">
                <h4 className="notebook-form-title">Documentation Notebook</h4>
                <div className="resources-field">
                  <label className="resources-label">URL</label>
                  <input
                    type="text"
                    value={docNotebook.url}
                    onChange={(e) => setDocNotebook({ ...docNotebook, url: e.target.value })}
                    className="resources-input"
                    placeholder="https://notebooklm.google.com/notebook/..."
                  />
                </div>
                <div className="resources-field">
                  <label className="resources-label">Description</label>
                  <input
                    type="text"
                    value={docNotebook.description}
                    onChange={(e) => setDocNotebook({ ...docNotebook, description: e.target.value })}
                    className="resources-input"
                    placeholder="What this notebook contains..."
                  />
                </div>
                <div className="resources-field">
                  <label className="resources-label">Query Tips (one per line)</label>
                  <textarea
                    value={docNotebook.queryTips}
                    onChange={(e) => setDocNotebook({ ...docNotebook, queryTips: e.target.value })}
                    className="resources-textarea"
                    placeholder="Ask about API endpoints&#10;Query for component docs&#10;..."
                    rows={3}
                  />
                </div>
              </div>

              <div className="notebook-form">
                <h4 className="notebook-form-title">Research Notebook</h4>
                <div className="resources-field">
                  <label className="resources-label">URL</label>
                  <input
                    type="text"
                    value={researchNotebook.url}
                    onChange={(e) => setResearchNotebook({ ...researchNotebook, url: e.target.value })}
                    className="resources-input"
                    placeholder="https://notebooklm.google.com/notebook/..."
                  />
                </div>
                <div className="resources-field">
                  <label className="resources-label">Description</label>
                  <input
                    type="text"
                    value={researchNotebook.description}
                    onChange={(e) => setResearchNotebook({ ...researchNotebook, description: e.target.value })}
                    className="resources-input"
                    placeholder="What this notebook contains..."
                  />
                </div>
                <div className="resources-field">
                  <label className="resources-label">Query Tips (one per line)</label>
                  <textarea
                    value={researchNotebook.queryTips}
                    onChange={(e) => setResearchNotebook({ ...researchNotebook, queryTips: e.target.value })}
                    className="resources-textarea"
                    placeholder="Research best practices&#10;Find related approaches&#10;..."
                    rows={3}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Tool Instructions Section */}
          {activeSection === 'tools' && (
            <div className="resources-section">
              <p className="resources-section-intro">
                Provide guidance for agents using specific tools with this project.
              </p>

              <div className="resources-field">
                <label className="resources-label">NotebookLM Usage</label>
                <textarea
                  value={toolInstructions.notebookLM || ''}
                  onChange={(e) => setToolInstructions({ ...toolInstructions, notebookLM: e.target.value })}
                  className="resources-textarea"
                  placeholder="Instructions for querying notebooks..."
                  rows={3}
                />
              </div>

              <div className="resources-field">
                <label className="resources-label">Files Browsing</label>
                <textarea
                  value={toolInstructions.filesBrowsing || ''}
                  onChange={(e) => setToolInstructions({ ...toolInstructions, filesBrowsing: e.target.value })}
                  className="resources-textarea"
                  placeholder="Tips for navigating project files..."
                  rows={3}
                />
              </div>

              <div className="resources-field">
                <label className="resources-label">Git Workflow</label>
                <textarea
                  value={toolInstructions.gitWorkflow || ''}
                  onChange={(e) => setToolInstructions({ ...toolInstructions, gitWorkflow: e.target.value })}
                  className="resources-textarea"
                  placeholder="Branch naming, commit conventions..."
                  rows={3}
                />
              </div>

              <div className="resources-field">
                <label className="resources-label">Testing</label>
                <textarea
                  value={toolInstructions.testing || ''}
                  onChange={(e) => setToolInstructions({ ...toolInstructions, testing: e.target.value })}
                  className="resources-textarea"
                  placeholder="How to run tests, testing conventions..."
                  rows={3}
                />
              </div>

              <div className="resources-field">
                <label className="resources-label">Deployment</label>
                <textarea
                  value={toolInstructions.deployment || ''}
                  onChange={(e) => setToolInstructions({ ...toolInstructions, deployment: e.target.value })}
                  className="resources-textarea"
                  placeholder="Deployment process, commands..."
                  rows={3}
                />
              </div>
            </div>
          )}
        </div>

        {/* Error display */}
        {error && <div className="resources-error">{error}</div>}

        {/* Actions */}
        <div className="project-resources-edit-actions">
          <button type="button" onClick={onClose} className="resources-btn resources-btn-cancel">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="resources-btn resources-btn-save"
            disabled={saving}
          >
            <Save size={16} />
            {saving ? 'Saving...' : 'Save Resources'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
