import { authenticatedFetch } from '../utils/auth';
import { useState, useEffect, useCallback } from 'react';
import { useFileViewer } from '../contexts/FileViewerContext';
import './WorkspaceFiles.css';

interface WorkspaceFile {
  name: string;
  path: string;
  size: number;
  modified: string;
  lines: number;
  category: 'core' | 'memory' | 'skills' | 'other';
  description: string;
  system?: 'openclaw' | 'hermes';
  systemLabel?: string;
  viewerKey?: string;
  displayName?: string;
}

interface WorkspaceSystem {
  id: 'openclaw' | 'hermes';
  label: string;
  rootPath: string;
  available: boolean;
  reason?: string;
  files: WorkspaceFile[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function getFileIcon(name: string): string {
  if (name === 'AGENTS.md') return '📋';
  if (name === 'HEARTBEAT.md') return '💓';
  if (name === 'IDENTITY.md') return '🌀';
  if (name === 'SOUL.md') return '✨';
  if (name === 'TOOLS.md') return '🔧';
  if (name === 'USER.md') return '👤';
  if (name === 'MEMORY.md') return '🧠';
  if (name === 'BOOT.md') return '🚀';
  if (name === 'SKILLS.md') return '🎯';
  if (name.startsWith('memory/')) return '📝';
  if (name.startsWith('skills/')) return '🎯';
  if (name.startsWith('docs/')) return '📚';
  if (name.endsWith('.py')) return '🐍';
  if (name.endsWith('.toml') || name.endsWith('.yaml') || name.endsWith('.yml')) return '⚙️';
  return '📄';
}

export function WorkspaceFiles() {
  const [systems, setSystems] = useState<WorkspaceSystem[]>([]);
  const [loading, setLoading] = useState(false);
  const [sectionExpanded, setSectionExpanded] = useState(false);
  const [expandedSystems, setExpandedSystems] = useState<Record<string, boolean>>({
    openclaw: true,
    hermes: false,
  });
  const [memoryExpanded, setMemoryExpanded] = useState<Record<string, boolean>>({});
  const [skillsExpanded, setSkillsExpanded] = useState<Record<string, boolean>>({});
  const { openFile } = useFileViewer();

  const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authenticatedFetch(`${API_BASE}/workspace/files`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.systems)) {
          setSystems(data.systems);
        } else if (data.success && Array.isArray(data.files)) {
          setSystems([
            {
              id: 'openclaw',
              label: 'OpenClaw Files',
              rootPath: '',
              available: true,
              files: data.files,
            },
          ]);
        }
      }
    } catch {
      // Silent fail
    } finally {
      setLoading(false);
    }
  }, [API_BASE]);

  useEffect(() => {
    if (!sectionExpanded) return;
    fetchFiles();
    const interval = setInterval(fetchFiles, 30000);
    return () => clearInterval(interval);
  }, [fetchFiles, sectionExpanded]);

  useEffect(() => {
    const handler = () => {
      fetchFiles();
    };
    window.addEventListener('workspace:files-updated' as never, handler);
    return () => window.removeEventListener('workspace:files-updated' as never, handler);
  }, [fetchFiles]);

  const totalFiles = systems.reduce((sum, system) => sum + system.files.length, 0);

  const toggleSystem = (id: string) => {
    setExpandedSystems((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleNested = (setter: React.Dispatch<React.SetStateAction<Record<string, boolean>>>, key: string) => {
    setter((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const renderFileRow = (file: WorkspaceFile, indent = false) => {
    const key = file.viewerKey || `${file.system || 'openclaw'}:${file.name}`;
    const displayName = file.displayName || file.name;
    return (
      <div
        key={key}
        className="workspace-file-item"
        onClick={() => openFile(key)}
        title={`${file.description}\n${file.lines} lines · ${formatSize(file.size)}`}
        style={indent ? { paddingLeft: '24px' } : undefined}
      >
        <span className="workspace-file-icon">{getFileIcon(displayName)}</span>
        <span className="workspace-file-name">{displayName.replace(/^memory\//, '').replace(/^skills\//, '')}</span>
        <span className="workspace-file-meta">{formatRelativeTime(file.modified)}</span>
      </div>
    );
  };

  const renderSystem = (system: WorkspaceSystem) => {
    const coreFiles = system.files.filter((f) => f.category === 'core' || f.category === 'other');
    const memoryFiles = system.files.filter((f) => f.category === 'memory');
    const skillsFiles = system.files.filter((f) => f.category === 'skills');
    const isExpanded = expandedSystems[system.id] ?? system.id === 'openclaw';
    const memoryKey = `${system.id}:memory`;
    const skillsKey = `${system.id}:skills`;

    return (
      <div key={system.id} className="workspace-system-block">
        <div
          className="workspace-system-header"
          onClick={() => toggleSystem(system.id)}
        >
          <span className={`workspace-memory-chevron ${isExpanded ? 'open' : ''}`}>▶</span>
          <span className="workspace-system-title">{system.id === 'hermes' ? '🧿' : '🌀'} {system.label}</span>
          <span className="workspace-files-count">{system.files.length}</span>
        </div>

        {isExpanded && (
          <div className="workspace-system-content">
            {system.available ? (
              system.files.length > 0 ? (
                <div className="workspace-files-list">
                  {coreFiles.map((file) => renderFileRow(file))}

                  {skillsFiles.length > 0 && (
                    <>
                      <div
                        className="workspace-memory-header"
                        onClick={() => toggleNested(setSkillsExpanded, skillsKey)}
                      >
                        <span className={`workspace-memory-chevron ${(skillsExpanded[skillsKey] ?? false) ? 'open' : ''}`}>▶</span>
                        <span>📁 skills/ ({skillsFiles.length} files)</span>
                      </div>
                      {(skillsExpanded[skillsKey] ?? false) && skillsFiles.map((file) => renderFileRow(file, true))}
                    </>
                  )}

                  {memoryFiles.length > 0 && (
                    <>
                      <div
                        className="workspace-memory-header"
                        onClick={() => toggleNested(setMemoryExpanded, memoryKey)}
                      >
                        <span className={`workspace-memory-chevron ${(memoryExpanded[memoryKey] ?? false) ? 'open' : ''}`}>▶</span>
                        <span>📁 memory/ ({memoryFiles.length} files)</span>
                      </div>
                      {(memoryExpanded[memoryKey] ?? false) && memoryFiles.map((file) => renderFileRow(file, true))}
                    </>
                  )}
                </div>
              ) : (
                <div className="workspace-files-loading">No tracked files exposed for this system yet.</div>
              )
            ) : (
              <div className="workspace-files-unavailable">
                <div>{system.reason || 'This workspace is unavailable.'}</div>
                {system.rootPath && <code>{system.rootPath}</code>}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="workspace-files sidebar-section">
      <div
        className="workspace-files-header"
        onClick={() => setSectionExpanded(!sectionExpanded)}
      >
        <span className={`workspace-files-chevron ${sectionExpanded ? 'open' : ''}`}>▶</span>
        <h3 className="sidebar-section-title" style={{ margin: 0 }}>📂 Workspace Files</h3>
        <span className="workspace-files-count">{totalFiles}</span>
      </div>

      {sectionExpanded && (
        loading ? (
          <div className="workspace-files-loading">Loading files...</div>
        ) : (
          <div className="workspace-systems-list">
            {systems.map(renderSystem)}
          </div>
        )
      )}
    </div>
  );
}
