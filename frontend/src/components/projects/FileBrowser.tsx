import { authenticatedFetch } from '../../utils/auth';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Upload, Download, Trash2, X, Eye, Folder, FolderPlus, ChevronRight, ArrowLeft, Code } from 'lucide-react';
import './FileBrowser.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface ProjectFile {
  name: string;
  size: number;
  modified: string;
  type: string;
}

interface FileBrowserProps {
  projectId: string;
  projectName?: string;
}

const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);
const TEXT_TYPES = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'csv', 'xml', 'log', 'ini', 'conf', 'cfg', 'env', 'gitignore']);
const CODE_TYPES = new Set(['js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'html', 'css', 'scss', 'less', 'sql', 'sh', 'bash', 'zsh', 'dockerfile']);

function getFileIcon(type: string): string {
  if (IMAGE_TYPES.has(type)) return '🖼️';
  if (TEXT_TYPES.has(type)) return '📄';
  if (CODE_TYPES.has(type)) return '💻';
  if (type === 'pdf') return '📕';
  if (['zip', 'tar', 'gz'].includes(type)) return '📦';
  return '📎';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function canPreview(type: string): boolean {
  return IMAGE_TYPES.has(type) || TEXT_TYPES.has(type) || CODE_TYPES.has(type);
}

export const FileBrowser: React.FC<FileBrowserProps> = ({ projectId, projectName }) => {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [directories, setDirectories] = useState<string[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [previewFile, setPreviewFile] = useState<{ file: ProjectFile; isSource?: boolean } | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [deleteFile, setDeleteFile] = useState<{ name: string; isDir?: boolean } | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  
  // Source files state
  const [sourceFiles, setSourceFiles] = useState<ProjectFile[]>([]);
  const [sourceDirs, setSourceDirs] = useState<string[]>([]);
  const [sourcePath, setSourcePath] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);
  const [activeSection, setActiveSection] = useState<'uploaded' | 'source'>('uploaded');

  const fetchFiles = useCallback(async (subPath: string = '') => {
    try {
      setLoading(true);
      const params = subPath ? `?path=${encodeURIComponent(subPath)}` : '';
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/files${params}`);
      const data = await res.json();
      if (data.success) {
        setFiles(data.files || []);
        setDirectories(data.directories || []);
        setCurrentPath(subPath);
      }
    } catch {
      console.error('Failed to fetch files');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const fetchSourceFiles = useCallback(async (subPath: string = '') => {
    if (!projectName) return;
    setSourceLoading(true);
    try {
      const params = new URLSearchParams({ projectName, path: subPath });
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/source-files?${params}`);
      const data = await res.json();
      if (data.success) {
        setSourceFiles(data.files || []);
        setSourceDirs(data.directories || []);
        setSourcePath(subPath);
      }
    } catch {
      console.error('Failed to fetch source files');
    } finally {
      setSourceLoading(false);
    }
  }, [projectId, projectName]);

  useEffect(() => { fetchFiles(''); }, [fetchFiles]);
  useEffect(() => { if (projectName) fetchSourceFiles(''); }, [projectName, fetchSourceFiles]);

  const uploadFile = async (file: globalThis.File) => {
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      if (currentPath) {
        form.append('directory', currentPath);
      }
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/files`, {
        method: 'POST',
        body: form
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Upload failed');
      } else {
        fetchFiles(currentPath);
      }
    } catch {
      setError('Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDownload = (fileName: string) => {
    const pathParam = currentPath ? `?path=${encodeURIComponent(currentPath)}` : '';
    const url = `${API_BASE_URL}/projects/${projectId}/files/${encodeURIComponent(fileName)}${pathParam}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
  };

  const handleDelete = async () => {
    if (!deleteFile) return;
    try {
      const pathParam = currentPath ? `?path=${encodeURIComponent(currentPath)}` : '';
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/files/${encodeURIComponent(deleteFile.name)}${pathParam}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setDeleteFile(null);
        fetchFiles(currentPath);
      }
    } catch {
      console.error('Delete failed');
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      const folderPath = currentPath ? `${currentPath}/${newFolderName.trim()}` : newFolderName.trim();
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${projectId}/files/mkdir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folderPath })
      });
      const data = await res.json();
      if (data.success) {
        setNewFolderName('');
        setShowNewFolder(false);
        fetchFiles(currentPath);
      }
    } catch {
      console.error('Failed to create folder');
    }
  };

  const navigateToDir = (dir: string) => {
    const newPath = currentPath ? `${currentPath}/${dir}` : dir;
    fetchFiles(newPath);
  };

  const navigateUp = () => {
    const parts = currentPath.split('/');
    parts.pop();
    fetchFiles(parts.join('/'));
  };

  const navigateToBreadcrumb = (index: number) => {
    if (index < 0) {
      fetchFiles('');
    } else {
      const parts = currentPath.split('/');
      fetchFiles(parts.slice(0, index + 1).join('/'));
    }
  };

  const handlePreview = async (file: ProjectFile, isSource: boolean = false) => {
    setPreviewFile({ file, isSource });
    setPreviewContent(null);
    if (TEXT_TYPES.has(file.type) || CODE_TYPES.has(file.type)) {
      try {
        let url: string;
        if (isSource && projectName) {
          const filePath = sourcePath ? `${sourcePath}/${file.name}` : file.name;
          const params = new URLSearchParams({ projectName, path: filePath });
          url = `${API_BASE_URL}/projects/${projectId}/source-files/content?${params}`;
        } else {
          const pathParam = currentPath ? `?path=${encodeURIComponent(currentPath)}` : '';
          url = `${API_BASE_URL}/projects/${projectId}/files/${encodeURIComponent(file.name)}${pathParam}`;
        }
        const res = await authenticatedFetch(url);
        const text = await res.text();
        setPreviewContent(text.substring(0, 50000));
      } catch {
        setPreviewContent('Failed to load file content');
      }
    }
  };

  const navigateSourceDir = (dir: string) => {
    const newPath = sourcePath ? `${sourcePath}/${dir}` : dir;
    fetchSourceFiles(newPath);
  };

  const navigateSourceUp = () => {
    const parts = sourcePath.split('/');
    parts.pop();
    fetchSourceFiles(parts.join('/'));
  };

  const fileUrl = (name: string) => {
    const pathParam = currentPath ? `?path=${encodeURIComponent(currentPath)}` : '';
    return `${API_BASE_URL}/projects/${projectId}/files/${encodeURIComponent(name)}${pathParam}`;
  };

  const pathParts = currentPath ? currentPath.split('/') : [];

  return (
    <div className="files-tab">
      {/* Section Tabs */}
      {projectName && (
        <div className="files-section-tabs">
          <button
            className={`files-section-tab ${activeSection === 'uploaded' ? 'active' : ''}`}
            onClick={() => setActiveSection('uploaded')}
          >
            <Upload size={14} />
            Uploaded Files ({files.length})
          </button>
          <button
            className={`files-section-tab ${activeSection === 'source' ? 'active' : ''}`}
            onClick={() => setActiveSection('source')}
          >
            <Code size={14} />
            Source Code
          </button>
        </div>
      )}

      {/* Uploaded Files Section */}
      {activeSection === 'uploaded' && (
        <>
          {/* Breadcrumb Navigation */}
          <div className="file-breadcrumb">
            <button className="file-breadcrumb-item" onClick={() => navigateToBreadcrumb(-1)}>
              📁 Files
            </button>
            {pathParts.map((part, idx) => (
              <React.Fragment key={idx}>
                <ChevronRight size={14} className="breadcrumb-sep" />
                <button className="file-breadcrumb-item" onClick={() => navigateToBreadcrumb(idx)}>
                  {part}
                </button>
              </React.Fragment>
            ))}
          </div>

          {/* Toolbar */}
          <div className="file-toolbar">
            {currentPath && (
              <button className="file-toolbar-btn" onClick={navigateUp}>
                <ArrowLeft size={14} />
                Back
              </button>
            )}
            <button className="file-toolbar-btn" onClick={() => setShowNewFolder(!showNewFolder)}>
              <FolderPlus size={14} />
              New Folder
            </button>
          </div>

          {/* New Folder Input */}
          {showNewFolder && (
            <div className="new-folder-form">
              <input
                ref={folderInputRef}
                type="text"
                placeholder="Folder name"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setShowNewFolder(false); }}
                className="new-folder-input"
                autoFocus
              />
              <button className="btn-save-link" onClick={handleCreateFolder}>Create</button>
              <button className="btn-cancel-link" onClick={() => { setShowNewFolder(false); setNewFolderName(''); }}>Cancel</button>
            </div>
          )}

          {/* Upload Zone */}
          <div
            className={`file-upload-zone ${dragOver ? 'drag-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="upload-icon"><Upload size={28} /></div>
            <p className="upload-text">
              Drop a file here or <strong>browse</strong>
            </p>
            <p className="upload-hint">
              {currentPath ? `Uploading to: /${currentPath}/` : 'Max 10MB · Images, docs, code files'}
            </p>
            <input ref={fileInputRef} type="file" className="upload-input" onChange={handleFileSelect} />
            {uploading && <p className="upload-progress">Uploading...</p>}
          </div>

          {error && <div className="upload-error">{error}</div>}

          {loading ? (
            <div className="tab-loading">Loading files...</div>
          ) : directories.length === 0 && files.length === 0 ? (
            <div className="files-empty">
              <p>No files yet</p>
              <p>Upload files or create a folder to get started</p>
            </div>
          ) : (
            <div className="files-grid">
              {/* Directories first */}
              {directories.map(dir => (
                <div key={`dir-${dir}`} className="file-card file-card-dir" onClick={() => navigateToDir(dir)}>
                  <div className="file-card-actions">
                    <button className="file-action-btn delete" onClick={(e) => { e.stopPropagation(); setDeleteFile({ name: dir, isDir: true }); }} title="Delete folder">
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="file-card-icon"><Folder size={32} className="folder-icon" /></div>
                  <div className="file-card-name">{dir}</div>
                  <div className="file-card-meta">
                    <span>Folder</span>
                  </div>
                </div>
              ))}
              {/* Files */}
              {files.map(file => (
                <div key={file.name} className="file-card" onClick={() => canPreview(file.type) ? handlePreview(file) : handleDownload(file.name)}>
                  <div className="file-card-actions">
                    <button className="file-action-btn" onClick={(e) => { e.stopPropagation(); handleDownload(file.name); }} title="Download">
                      <Download size={14} />
                    </button>
                    {canPreview(file.type) && (
                      <button className="file-action-btn" onClick={(e) => { e.stopPropagation(); handlePreview(file); }} title="Preview">
                        <Eye size={14} />
                      </button>
                    )}
                    <button className="file-action-btn delete" onClick={(e) => { e.stopPropagation(); setDeleteFile({ name: file.name }); }} title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="file-card-icon">{getFileIcon(file.type)}</div>
                  <div className="file-card-name">{file.name}</div>
                  <div className="file-card-meta">
                    <span>{formatSize(file.size)}</span>
                    <span>{formatDate(file.modified)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Source Code Section */}
      {activeSection === 'source' && projectName && (
        <div className="source-files-section">
          {/* Breadcrumb */}
          <div className="source-breadcrumb">
            <button
              className="source-breadcrumb-item"
              onClick={() => fetchSourceFiles('')}
            >
              {projectName}
            </button>
            {sourcePath && sourcePath.split('/').map((part, idx, arr) => (
              <React.Fragment key={idx}>
                <ChevronRight size={14} className="breadcrumb-sep" />
                <button
                  className="source-breadcrumb-item"
                  onClick={() => fetchSourceFiles(arr.slice(0, idx + 1).join('/'))}
                >
                  {part}
                </button>
              </React.Fragment>
            ))}
          </div>

          {sourcePath && (
            <button className="source-back-btn" onClick={navigateSourceUp}>
              <ArrowLeft size={14} />
              Back
            </button>
          )}

          {sourceLoading ? (
            <div className="tab-loading">Loading source files...</div>
          ) : (
            <div className="source-file-list">
              {/* Directories */}
              {sourceDirs.map(dir => (
                <div key={dir} className="source-file-item source-dir-item" onClick={() => navigateSourceDir(dir)}>
                  <Folder size={16} className="source-file-icon" />
                  <span className="source-file-name">{dir}</span>
                  <ChevronRight size={14} className="source-file-arrow" />
                </div>
              ))}
              {/* Files */}
              {sourceFiles.map(file => (
                <div
                  key={file.name}
                  className={`source-file-item ${canPreview(file.type) ? 'previewable' : ''}`}
                  onClick={() => canPreview(file.type) ? handlePreview(file, true) : undefined}
                >
                  <span className="source-file-icon-emoji">{getFileIcon(file.type)}</span>
                  <span className="source-file-name">{file.name}</span>
                  <span className="source-file-size">{formatSize(file.size)}</span>
                </div>
              ))}
              {sourceDirs.length === 0 && sourceFiles.length === 0 && (
                <div className="files-empty">
                  <p>Empty directory</p>
                </div>
              )}
            </div>
          )}
          
          <div className="source-files-notice">
            Source files are read-only
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewFile && (
        <div className="file-preview-overlay" onClick={() => setPreviewFile(null)}>
          <div className="file-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="file-preview-header">
              <span className="file-preview-title">{previewFile.file.name}</span>
              <div className="file-preview-actions">
                {!previewFile.isSource && (
                  <button className="file-action-btn" onClick={() => handleDownload(previewFile.file.name)} title="Download">
                    <Download size={16} />
                  </button>
                )}
                <button className="file-action-btn" onClick={() => setPreviewFile(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="file-preview-body">
              {IMAGE_TYPES.has(previewFile.file.type) && !previewFile.isSource ? (
                <img src={fileUrl(previewFile.file.name)} alt={previewFile.file.name} className="file-preview-image" />
              ) : previewContent !== null ? (
                <pre className="file-preview-text">{previewContent}</pre>
              ) : (
                <div className="file-preview-unsupported">
                  <div className="preview-icon">{getFileIcon(previewFile.file.type)}</div>
                  <p>Loading...</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteFile && (
        <div className="delete-confirm-overlay" onClick={() => setDeleteFile(null)}>
          <div className="delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h4>Delete {deleteFile.isDir ? 'Folder' : 'File'}</h4>
            <p>Delete "{deleteFile.name}"?{deleteFile.isDir ? ' All contents will be removed.' : ' This cannot be undone.'}</p>
            <div className="delete-confirm-actions">
              <button className="btn-delete-confirm" onClick={handleDelete}>Delete</button>
              <button className="btn-delete-cancel" onClick={() => setDeleteFile(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
