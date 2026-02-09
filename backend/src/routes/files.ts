// files.ts - File management API for projects
import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { projectService } from '../services/ProjectService';

const router = Router();

const BASE_PATH = process.env.PROJECT_FILES_PATH || '/clawd-media/projects';
const NFS_BASE_PATH = fs.existsSync('/nfs-projects') ? '/nfs-projects' : '/clawd-media/nfs-projects';
const SOURCE_BASE_PATH = fs.existsSync('/project-sources') ? '/project-sources' : '/clawd-media/project-sources';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.pdf', '.md', '.txt', '.csv', '.json', '.xml', '.yaml', '.yml', '.toml',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.html', '.css', '.scss', '.less', '.sql', '.sh', '.bash', '.zsh',
  '.env', '.gitignore', '.dockerfile',
  '.zip', '.tar', '.gz',
  '.ini', '.conf', '.cfg', '.log'
]);

// Legacy path for projects without nfsDir
function getLegacyProjectDir(projectId: string): string {
  return path.join(BASE_PATH, projectId, 'files');
}

// NFS path for projects with nfsDir set
function getNfsProjectDir(nfsDir: string): string {
  return path.join(NFS_BASE_PATH, nfsDir);
}

// Resolve the correct base directory for a project
async function resolveProjectDir(projectId: string): Promise<string> {
  try {
    const project = await projectService.getById(projectId);
    if (project.nfs_dir) {
      return getNfsProjectDir(project.nfs_dir);
    }
  } catch {
    // Project not found, fall back to legacy
  }
  return getLegacyProjectDir(projectId);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 255);
}

function sanitizePath(p: string): string {
  return p.split('/').filter(s => s && s !== '.' && s !== '..').join('/');
}

function getSubDir(baseDir: string, subPath: string): string {
  if (!subPath) return baseDir;
  const safe = sanitizePath(subPath);
  const full = path.resolve(baseDir, safe);
  if (!full.startsWith(baseDir)) return baseDir;
  return full;
}

const storage = multer.diskStorage({
  destination: (_req: any, _file: any, cb: any) => {
    // Use a temp dir; we'll move after resolving project dir
    const tmpDir = path.join(BASE_PATH, '_tmp_uploads');
    ensureDir(tmpDir);
    cb(null, tmpDir);
  },
  filename: (_req: any, file: any, cb: any) => {
    const sanitized = sanitizeFilename(file.originalname);
    // Add timestamp to avoid collisions in temp dir
    cb(null, `${Date.now()}_${sanitized}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req: any, file: any, cb: any) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext) || ext === '') {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not allowed`));
    }
  }
});

// GET /api/projects/:id/files - list files and directories
router.get('/:id/files', async (req: Request, res: Response): Promise<void> => {
  try {
    const baseDir = await resolveProjectDir(req.params.id);
    const subPath = (req.query.path as string) || '';
    const dir = getSubDir(baseDir, subPath);
    if (!fs.existsSync(dir)) {
      res.json({ success: true, files: [], directories: [], currentPath: subPath });
      return;
    }
    const entries = fs.readdirSync(dir);
    const files: Array<{ name: string; size: number; modified: string; type: string }> = [];
    const directories: string[] = [];
    
    for (const name of entries) {
      const filePath = path.join(dir, name);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          directories.push(name);
        } else {
          files.push({
            name,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            type: path.extname(name).toLowerCase().slice(1) || 'file'
          });
        }
      } catch { /* skip inaccessible */ }
    }
    
    directories.sort();
    files.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    
    res.json({ success: true, files, directories, currentPath: subPath });
  } catch (err) {
    console.error('[Files API] Error listing files:', err);
    res.status(500).json({ success: false, error: 'Failed to list files' });
  }
});

// POST /api/projects/:id/files/mkdir - create directory
router.post('/:id/files/mkdir', async (req: Request, res: Response): Promise<void> => {
  try {
    const { path: dirPath } = req.body;
    if (!dirPath || typeof dirPath !== 'string') {
      res.status(400).json({ success: false, error: 'path is required' });
      return;
    }
    const safePath = sanitizePath(dirPath);
    if (!safePath) {
      res.status(400).json({ success: false, error: 'Invalid path' });
      return;
    }
    const baseDir = await resolveProjectDir(req.params.id);
    const fullDir = getSubDir(baseDir, safePath);
    ensureDir(fullDir);
    res.json({ success: true, path: safePath });
  } catch (err) {
    console.error('[Files API] Error creating directory:', err);
    res.status(500).json({ success: false, error: 'Failed to create directory' });
  }
});

// POST /api/projects/:id/files - upload file
router.post('/:id/files', (req: Request, res: Response): void => {
  upload.single('file')(req, res, async (err: any) => {
    if (err) {
      const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? 'File too large (max 10MB)'
        : err.message || 'Upload failed';
      res.status(400).json({ success: false, error: message });
      return;
    }
    const file = (req as any).file;
    if (!file) {
      res.status(400).json({ success: false, error: 'No file provided' });
      return;
    }
    
    try {
      const baseDir = await resolveProjectDir(req.params.id);
      const directory = req.body?.directory;
      const targetDir = directory ? getSubDir(baseDir, directory) : baseDir;
      ensureDir(targetDir);
      
      // Move from temp to final destination with original sanitized name
      const originalName = sanitizeFilename(file.originalname);
      const finalPath = path.join(targetDir, originalName);
      // Use copyFile+unlink instead of rename (works across filesystems/mounts)
      fs.copyFileSync(file.path, finalPath);
      fs.unlinkSync(file.path);
      
      const stat = fs.statSync(finalPath);
      res.json({
        success: true,
        file: {
          name: originalName,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          type: path.extname(originalName).toLowerCase().slice(1) || 'file'
        }
      });
    } catch (moveErr) {
      // Clean up temp file
      try { fs.unlinkSync(file.path); } catch {}
      console.error('[Files API] Error moving uploaded file:', moveErr);
      res.status(500).json({ success: false, error: 'Failed to save file' });
    }
  });
});

// GET /api/projects/:id/files/:filename - serve file
router.get('/:id/files/:filename', async (req: Request, res: Response): Promise<void> => {
  try {
    const baseDir = await resolveProjectDir(req.params.id);
    const subPath = (req.query.path as string) || '';
    const dir = getSubDir(baseDir, subPath);
    const filePath = path.join(dir, sanitizeFilename(req.params.filename));
    if (!filePath.startsWith(baseDir) || !fs.existsSync(filePath)) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }
    res.sendFile(filePath);
  } catch (err) {
    console.error('[Files API] Error serving file:', err);
    res.status(500).json({ success: false, error: 'Failed to serve file' });
  }
});

// DELETE /api/projects/:id/files/:filename - delete file or directory
router.delete('/:id/files/:filename', async (req: Request, res: Response): Promise<void> => {
  try {
    const baseDir = await resolveProjectDir(req.params.id);
    const subPath = (req.query.path as string) || '';
    const dir = getSubDir(baseDir, subPath);
    const targetPath = path.join(dir, sanitizeFilename(req.params.filename));
    
    if (!targetPath.startsWith(baseDir) || !fs.existsSync(targetPath)) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }
    
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true });
    } else {
      fs.unlinkSync(targetPath);
    }
    res.json({ success: true, message: 'Deleted successfully' });
  } catch (err) {
    console.error('[Files API] Error deleting file:', err);
    res.status(500).json({ success: false, error: 'Failed to delete file' });
  }
});

// GET /api/projects/:id/source-files - list source files for a project
router.get('/:id/source-files', async (req: Request, res: Response): Promise<void> => {
  try {
    const projectName = req.query.projectName as string;
    if (!projectName) {
      res.status(400).json({ success: false, error: 'projectName query parameter required' });
      return;
    }
    
    const subPath = (req.query.path as string) || '';
    const safeName = projectName.replace(/[^a-zA-Z0-9._-]/g, '');
    const baseDir = path.join(SOURCE_BASE_PATH, safeName);
    const targetDir = path.resolve(baseDir, subPath);
    
    if (!targetDir.startsWith(baseDir)) {
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }
    
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      res.json({ success: true, files: [], directories: [] });
      return;
    }
    
    const entries = fs.readdirSync(targetDir);
    const files: Array<{ name: string; size: number; modified: string; type: string }> = [];
    const directories: string[] = [];
    
    for (const name of entries) {
      if (['node_modules', '.git', 'dist', '.next', '__pycache__', '.turbo'].includes(name)) continue;
      
      const fullPath = path.join(targetDir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          directories.push(name);
        } else {
          files.push({
            name,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            type: path.extname(name).toLowerCase().slice(1) || 'file'
          });
        }
      } catch {}
    }
    
    directories.sort();
    files.sort((a, b) => a.name.localeCompare(b.name));
    
    res.json({ success: true, files, directories, currentPath: subPath });
  } catch (err) {
    console.error('[Files API] Error listing source files:', err);
    res.status(500).json({ success: false, error: 'Failed to list source files' });
  }
});

// GET /api/projects/:id/source-files/content - read a source file
router.get('/:id/source-files/content', (req: Request, res: Response): void => {
  try {
    const projectName = req.query.projectName as string;
    const filePath = req.query.path as string;
    if (!projectName || !filePath) {
      res.status(400).json({ success: false, error: 'projectName and path required' });
      return;
    }
    
    const safeName = projectName.replace(/[^a-zA-Z0-9._-]/g, '');
    const baseDir = path.join(SOURCE_BASE_PATH, safeName);
    const fullPath = path.resolve(baseDir, filePath);
    
    if (!fullPath.startsWith(baseDir)) {
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }
    
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      res.status(404).json({ success: false, error: 'File not found' });
      return;
    }
    
    res.sendFile(fullPath);
  } catch (err) {
    console.error('[Files API] Error serving source file:', err);
    res.status(500).json({ success: false, error: 'Failed to serve file' });
  }
});

export default router;
