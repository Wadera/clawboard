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
  category: 'core' | 'memory' | 'other';
  description: string;
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
  if (name.startsWith('memory/')) return '📝';
  return '📄';
}

export function WorkspaceFiles() {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [sectionExpanded, setSectionExpanded] = useState(false);
  const [memoryExpanded, setMemoryExpanded] = useState(false);
  const { openFile } = useFileViewer();

  const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

  const fetchFiles = useCallback(async () => {
    try {
      const res = await authenticatedFetch(`${API_BASE}/workspace/files`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.files) {
          setFiles(data.files);
        }
      }
    } catch {
      // Silent fail
    } finally {
      setLoading(false);
    }
  }, [API_BASE]);

  useEffect(() => {
    fetchFiles();
    const interval = setInterval(fetchFiles, 30000);
    return () => clearInterval(interval);
  }, [fetchFiles]);

  useEffect(() => {
    const handler = (event: CustomEvent<{ files: WorkspaceFile[] }>) => {
      setFiles(event.detail.files);
    };
    window.addEventListener('workspace:files-updated' as never, handler);
    return () => window.removeEventListener('workspace:files-updated' as never, handler);
  }, []);

  const coreFiles = files.filter(f => f.category === 'core');
  const memoryFiles = files.filter(f => f.category === 'memory');

  return (
    <div className="workspace-files sidebar-section">
      <div
        className="workspace-files-header"
        onClick={() => setSectionExpanded(!sectionExpanded)}
      >
        <span className={`workspace-files-chevron ${sectionExpanded ? 'open' : ''}`}>▶</span>
        <h3 className="sidebar-section-title" style={{ margin: 0 }}>📂 Workspace Files</h3>
        <span className="workspace-files-count">{files.length}</span>
      </div>

      {sectionExpanded && (
        loading ? (
          <div className="workspace-files-loading">Loading files...</div>
        ) : (
          <div className="workspace-files-list">
            {coreFiles.map(file => (
              <div
                key={file.name}
                className="workspace-file-item"
                onClick={() => openFile(file.name)}
                title={`${file.description}\n${file.lines} lines · ${formatSize(file.size)}`}
              >
                <span className="workspace-file-icon">{getFileIcon(file.name)}</span>
                <span className="workspace-file-name">{file.name}</span>
                <span className="workspace-file-meta">{formatRelativeTime(file.modified)}</span>
              </div>
            ))}

            {memoryFiles.length > 0 && (
              <>
                <div
                  className="workspace-memory-header"
                  onClick={() => setMemoryExpanded(!memoryExpanded)}
                >
                  <span className={`workspace-memory-chevron ${memoryExpanded ? 'open' : ''}`}>▶</span>
                  <span>📁 memory/ ({memoryFiles.length} files)</span>
                </div>
                {memoryExpanded && memoryFiles.map(file => (
                  <div
                    key={file.name}
                    className="workspace-file-item"
                    onClick={() => openFile(file.name)}
                    title={`${file.lines} lines · ${formatSize(file.size)}`}
                    style={{ paddingLeft: '24px' }}
                  >
                    <span className="workspace-file-icon">📝</span>
                    <span className="workspace-file-name">{file.name.replace('memory/', '')}</span>
                    <span className="workspace-file-meta">{formatRelativeTime(file.modified)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}
