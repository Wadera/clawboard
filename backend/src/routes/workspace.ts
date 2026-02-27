import express from 'express';
import type { Request, Response } from 'express';
import { WorkspaceWatcher } from '../services/workspaceWatcher';
import * as fs from 'fs/promises';
import * as path from 'path';

let watcher: WorkspaceWatcher | null = null;

export function setWorkspaceWatcher(w: WorkspaceWatcher) {
  watcher = w;
}

const router = express.Router();

// Workspace root (mounted at /workspace in container)
const WORKSPACE_ROOT = process.env.WORKSPACE_PATH || '/workspace';

// Supported file extensions for arbitrary file reading
const ALLOWED_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', 
  '.css', '.html', '.yml', '.yaml', '.txt', '.sh',
  '.env', '.gitignore', '.dockerignore'
];

/**
 * Sanitize and validate file path to prevent directory traversal
 */
function sanitizePath(filePath: string): string | null {
  // Normalize the path and remove any directory traversal attempts
  const normalized = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  
  // Resolve the full path
  const fullPath = path.resolve(WORKSPACE_ROOT, normalized);
  
  // Ensure the resolved path is still within WORKSPACE_ROOT
  if (!fullPath.startsWith(path.resolve(WORKSPACE_ROOT))) {
    return null;
  }
  
  // Check if extension is allowed
  const ext = path.extname(fullPath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return null;
  }
  
  return fullPath;
}

/**
 * GET /workspace/files - List all tracked workspace files
 */
router.get('/files', async (_req: Request, res: Response) => {
  if (!watcher) {
    res.status(503).json({ success: false, error: 'Workspace watcher not initialized' });
    return;
  }

  const files = watcher.getFiles();
  res.json({
    success: true,
    count: files.length,
    files,
  });
});

/**
 * GET /workspace/read?path=... - Read arbitrary project files
 * Security: Only allows files within WORKSPACE_ROOT with allowed extensions
 */
router.get('/read', async (req: Request, res: Response) => {
  const filePath = req.query.path as string;
  
  if (!filePath) {
    res.status(400).json({ success: false, error: 'Missing path parameter' });
    return;
  }
  
  // Sanitize and validate the path
  const sanitizedPath = sanitizePath(filePath);
  
  if (!sanitizedPath) {
    res.status(400).json({ 
      success: false, 
      error: 'Invalid file path or unsupported file type' 
    });
    return;
  }
  
  try {
    // Check if file exists
    const stats = await fs.stat(sanitizedPath);
    
    if (!stats.isFile()) {
      res.status(400).json({ success: false, error: 'Path is not a file' });
      return;
    }
    
    // Read the file
    const content = await fs.readFile(sanitizedPath, 'utf-8');
    const lines = content.split('\n').length;
    
    // Return file content with metadata
    res.json({
      success: true,
      file: {
        name: path.basename(sanitizedPath),
        path: filePath,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        lines: lines
      },
      content: content
    });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'File not found' });
    } else if (error.code === 'EACCES') {
      res.status(403).json({ success: false, error: 'Permission denied' });
    } else {
      console.error('Error reading file:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to read file' 
      });
    }
  }
});

/**
 * GET /workspace/files/:name - Get file content + metadata
 * Supports nested paths like memory/2026-01-30.md via query param
 */
router.get('/files/*', async (req: Request, res: Response) => {
  if (!watcher) {
    res.status(503).json({ success: false, error: 'Workspace watcher not initialized' });
    return;
  }

  // Extract full path from wildcard
  const name = (req.params as any)[0];
  if (!name) {
    res.status(400).json({ success: false, error: 'File name required' });
    return;
  }

  // Security: prevent directory traversal
  if (name.includes('..')) {
    res.status(400).json({ success: false, error: 'Invalid file path' });
    return;
  }

  const result = await watcher.getFileContent(name);
  if (!result) {
    res.status(404).json({ success: false, error: 'File not found' });
    return;
  }

  res.json({
    success: true,
    file: result.meta,
    content: result.content,
  });
});

export default router;
