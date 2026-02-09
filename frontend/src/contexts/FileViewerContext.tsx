import { authenticatedFetch } from '../utils/auth';
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './FileViewerContext.css';

interface FileMeta {
  name: string;
  size: number;
  modified: string;
  lines: number;
}

interface ViewerState {
  name: string;
  content: string;
  meta: FileMeta;
}

interface FileViewerContextType {
  openFile: (name: string) => Promise<void>;
  openFileByPath: (filePath: string) => Promise<void>;
}

const FileViewerContext = createContext<FileViewerContextType | null>(null);

export function useFileViewer() {
  const ctx = useContext(FileViewerContext);
  if (!ctx) throw new Error('useFileViewer must be used within FileViewerProvider');
  return ctx;
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

export function FileViewerProvider({ children }: { children: ReactNode }) {
  const [viewerFile, setViewerFile] = useState<ViewerState | null>(null);
  const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

  const openFile = useCallback(async (name: string) => {
    try {
      const res = await authenticatedFetch(`${API_BASE}/workspace/files/${encodeURIComponent(name)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setViewerFile({ name, content: data.content, meta: data.file });
        }
      }
    } catch {
      // Fail silently
    }
  }, [API_BASE]);

  const openFileByPath = useCallback(async (filePath: string) => {
    // If it's an external URL, open in new tab
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      window.open(filePath, '_blank', 'noopener,noreferrer');
      return;
    }

    // Try multiple path strategies to find the file in workspace API
    const basename = filePath.split('/').pop() || filePath;
    const attempts = [filePath, basename];

    // First, try the tracked workspace files API
    for (const attempt of attempts) {
      try {
        const res = await authenticatedFetch(`${API_BASE}/workspace/files/${encodeURIComponent(attempt)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            setViewerFile({ name: attempt, content: data.content, meta: data.file });
            return;
          }
        }
      } catch {
        // Try next
      }
    }

    // If not found in tracked files, try reading from project directory
    // Prepend project path if the file path doesn't already include it
    let projectPath = filePath;
    if (!filePath.startsWith('projects/clawboard/')) {
      projectPath = `projects/clawboard/${filePath}`;
    }
    
    try {
      const res = await authenticatedFetch(`${API_BASE}/workspace/read?path=${encodeURIComponent(projectPath)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setViewerFile({ 
            name: data.file.name, 
            content: data.content, 
            meta: data.file 
          });
          return;
        }
      }
    } catch {
      // Fall through to error message
    }

    // File not found anywhere — show a helpful message in the viewer
    const displayName = basename;
    setViewerFile({
      name: displayName,
      content: `File not available for preview.\n\nPath: ${filePath}\n\nThis file could not be found or is not accessible.\n\nPossible reasons:\n- File does not exist\n- File type is not supported\n- Path is outside the project directory`,
      meta: { name: displayName, size: 0, modified: new Date().toISOString(), lines: 0 },
    });
  }, [API_BASE]);

  return (
    <FileViewerContext.Provider value={{ openFile, openFileByPath }}>
      {children}
      {viewerFile && createPortal(
        <div className="file-viewer-overlay" onClick={() => setViewerFile(null)}>
          <div className="file-viewer-modal" onClick={(e) => e.stopPropagation()}>
            <div className="file-viewer-header">
              <div>
                <div className="file-viewer-title">
                  {getFileIcon(viewerFile.name)} {viewerFile.name}
                </div>
                <div className="file-viewer-meta">
                  <span>{viewerFile.meta.lines} lines</span>
                  <span>{formatSize(viewerFile.meta.size)}</span>
                  <span>Modified {formatRelativeTime(viewerFile.meta.modified)}</span>
                </div>
              </div>
              <button className="file-viewer-close" onClick={() => setViewerFile(null)}>
                ✕
              </button>
            </div>
            <div className="file-viewer-content">
              <pre>{viewerFile.content}</pre>
            </div>
          </div>
        </div>,
        document.body
      )}
    </FileViewerContext.Provider>
  );
}
