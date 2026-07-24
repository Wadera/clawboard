import express from 'express';
import type { Request, Response } from 'express';
import { WorkspaceWatcher, WorkspaceFile as TrackedWorkspaceFile } from '../services/workspaceWatcher';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

let watcher: WorkspaceWatcher | null = null;

export function setWorkspaceWatcher(w: WorkspaceWatcher) {
  watcher = w;
}

const router = express.Router();

const OPENCLAW_WORKSPACE_ROOT = process.env.WORKSPACE_PATH || '/workspace';
const HERMES_WORKSPACE_ROOT = process.env.HERMES_WORKSPACE_PATH || '/home/hermes/hermes-agent';
const DEPLOYED_REPO_ROOT = process.env.DEPLOYED_REPO_PATH || null;
const VIEWER_KEY_PATTERN = /^(openclaw|hermes):(.*)$/;
const execFileAsync = promisify(execFile);

const ALLOWED_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.css', '.html', '.yml', '.yaml', '.txt', '.sh',
  '.env', '.gitignore', '.dockerignore', '.py', '.toml', '.lock', '.svg', '.example', '.nix',
];

const HERMES_SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', '.pytest_cache', '.mypy_cache',
  'venv', '.venv', '.idea', '.vscode', '.DS_Store', 'coverage', '.turbo', '.cache'
]);
const HERMES_MAX_LISTED_FILES = 400;

interface ApiWorkspaceFile extends TrackedWorkspaceFile {
  system: 'openclaw' | 'hermes';
  systemLabel: string;
  viewerKey: string;
  rootPath: string;
  displayName: string;
}

interface WorkspaceSystemPayload {
  id: 'openclaw' | 'hermes';
  label: string;
  rootPath: string;
  available: boolean;
  reason?: string;
  files: ApiWorkspaceFile[];
}

function getSystemLabel(system: 'openclaw' | 'hermes'): string {
  return system === 'hermes' ? 'Hermes Files' : 'OpenClaw Files';
}

function buildViewerKey(system: 'openclaw' | 'hermes', relativePath: string): string {
  return `${system}:${relativePath}`;
}

function parseViewerKey(input: string): { system: 'openclaw' | 'hermes'; relativePath: string } {
  const match = String(input || '').match(VIEWER_KEY_PATTERN);
  if (match) {
    return {
      system: match[1] as 'openclaw' | 'hermes',
      relativePath: match[2] || '',
    };
  }
  return {
    system: 'openclaw',
    relativePath: input,
  };
}

function sanitizePath(rootPath: string, relativePath: string): string | null {
  const normalized = path.normalize(relativePath).replace(/^([.][.][/\\])+/, '');
  const fullPath = path.resolve(rootPath, normalized);
  if (!fullPath.startsWith(path.resolve(rootPath))) {
    return null;
  }

  const ext = path.extname(fullPath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return null;
  }

  return fullPath;
}

function normalizeRepoWebUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  if (remoteUrl.startsWith('ssh://git@')) {
    const match = remoteUrl.match(/^ssh:\/\/git@([^:]+)(?::\d+)?\/(.+?)(?:\.git)?$/);
    if (match) {
      return `https://${match[1]}/${match[2]}`;
    }
  }
  if (remoteUrl.startsWith('git@')) {
    const match = remoteUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (match) {
      return `https://${match[1]}/${match[2]}`;
    }
  }
  if (remoteUrl.startsWith('http://') || remoteUrl.startsWith('https://')) {
    return remoteUrl.replace(/\.git$/, '');
  }
  return null;
}

async function readGitMetadata(rootPath: string) {
  const gitDir = path.join(rootPath, '.git');
  try {
    await fs.access(gitDir);
  } catch {
    return null;
  }

  const emptyVersion = {
    appVersion: process.env.npm_package_version || '2.0.0',
    branch: null,
    commit: null,
    shortCommit: null,
    remoteUrl: null,
    repoWebUrl: null,
    branchUrl: null,
    commitUrl: null,
  };

  try {
    const [branchResult, commitResult, remoteResult] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootPath, timeout: 2500 }),
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: rootPath, timeout: 2500 }),
      execFileAsync('git', ['config', '--get', 'remote.origin.url'], { cwd: rootPath, timeout: 2500 }).catch(() => ({ stdout: '' })),
    ]);

    const branch = branchResult.stdout.trim() || null;
    const commit = commitResult.stdout.trim() || null;
    const shortCommit = commit ? commit.slice(0, 8) : null;
    const remoteUrl = remoteResult.stdout.trim() || null;
    const repoWebUrl = normalizeRepoWebUrl(remoteUrl);

    return {
      appVersion: process.env.npm_package_version || '2.0.0',
      branch,
      commit,
      shortCommit,
      remoteUrl,
      repoWebUrl,
      branchUrl: repoWebUrl && branch ? `${repoWebUrl}/src/branch/${branch}` : null,
      commitUrl: repoWebUrl && commit ? `${repoWebUrl}/commit/${commit}` : null,
    };
  } catch {
    try {
      const headRaw = await fs.readFile(path.join(gitDir, 'HEAD'), 'utf-8');
      const head = headRaw.trim();
      let branch: string | null = null;
      let commit: string | null = null;

      if (head.startsWith('ref: ')) {
        const refPath = head.slice(5).trim();
        branch = refPath.split('/').pop() || null;
        try {
          commit = (await fs.readFile(path.join(gitDir, refPath), 'utf-8')).trim() || null;
        } catch {
          const packedRefs = await fs.readFile(path.join(gitDir, 'packed-refs'), 'utf-8').catch(() => '');
          const packedLine = packedRefs.split('\n').find((line) => line.endsWith(` ${refPath}`));
          commit = packedLine?.split(' ')[0]?.trim() || null;
        }
      } else {
        commit = head || null;
      }

      const shortCommit = commit ? commit.slice(0, 8) : null;
      const configRaw = await fs.readFile(path.join(gitDir, 'config'), 'utf-8').catch(() => '');
      const remoteMatch = configRaw.match(/\[remote "origin"\][^[]*?url = (.+)/m);
      const remoteUrl = remoteMatch?.[1]?.trim() || null;
      const repoWebUrl = normalizeRepoWebUrl(remoteUrl);

      return {
        appVersion: process.env.npm_package_version || '2.0.0',
        branch,
        commit,
        shortCommit,
        remoteUrl,
        repoWebUrl,
        branchUrl: repoWebUrl && branch ? `${repoWebUrl}/src/branch/${branch}` : null,
        commitUrl: repoWebUrl && commit ? `${repoWebUrl}/commit/${commit}` : null,
      };
    } catch {
      return emptyVersion;
    }
  }
}


function inferHermesCategory(relativePath: string): 'core' | 'memory' | 'skills' | 'other' {
  if (relativePath.startsWith('memory/')) return 'memory';
  if (relativePath.startsWith('skills/')) return 'skills';
  if (relativePath.startsWith('docs/')) return 'other';
  return 'core';
}

function describeHermesFile(relativePath: string): string {
  if (relativePath === 'README.md') return 'Hermes project overview';
  if (relativePath === '.env.example') return 'Hermes environment example';
  if (relativePath.startsWith('docs/')) return 'Hermes documentation';
  if (relativePath.startsWith('backend/')) return 'Backend source file';
  if (relativePath.startsWith('frontend/')) return 'Frontend source file';
  if (relativePath.startsWith('cli/')) return 'CLI source file';
  return 'Hermes workspace file';
}

async function listHermesWorkspaceFiles(rootPath: string): Promise<ApiWorkspaceFile[]> {
  const files: ApiWorkspaceFile[] = [];
  const rootResolved = path.resolve(rootPath);

  const walk = async (currentPath: string, depth: number): Promise<void> => {
    if (files.length >= HERMES_MAX_LISTED_FILES) return;
    let entries: Array<any> = [];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= HERMES_MAX_LISTED_FILES) return;
      if (entry.name.startsWith('.') && !['.env.example', '.gitignore', '.dockerignore'].includes(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        if (HERMES_SKIP_DIRECTORIES.has(entry.name)) continue;
        if (depth >= 4) continue;
        await walk(path.join(currentPath, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = path.relative(rootResolved, absolutePath).replace(/\\\\/g, '/');
      const sanitizedPath = sanitizePath(rootResolved, relativePath);
      if (!sanitizedPath) continue;
      try {
        const stats = await fs.stat(sanitizedPath);
        const content = await fs.readFile(sanitizedPath, 'utf-8');
        files.push({
          name: relativePath,
          path: sanitizedPath,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          lines: content.split('\n').length,
          category: inferHermesCategory(relativePath),
          description: describeHermesFile(relativePath),
          system: 'hermes',
          systemLabel: getSystemLabel('hermes'),
          viewerKey: buildViewerKey('hermes', relativePath),
          rootPath: rootResolved,
          displayName: relativePath,
        });
      } catch {
        // Skip unreadable files.
      }
    }
  };

  await walk(rootResolved, 0);
  return files;
}

async function resolveVersionRootPath(): Promise<string> {
  if (DEPLOYED_REPO_ROOT) {
    try {
      await fs.access(path.join(DEPLOYED_REPO_ROOT, '.git'));
      return DEPLOYED_REPO_ROOT;
    } catch {
      // fall through
    }
  }
  return watcher?.getWorkspaceDir() || OPENCLAW_WORKSPACE_ROOT;
}

async function buildOpenClawSystem(): Promise<WorkspaceSystemPayload> {
  if (!watcher) {
    return {
      id: 'openclaw',
      label: getSystemLabel('openclaw'),
      rootPath: OPENCLAW_WORKSPACE_ROOT,
      available: false,
      reason: 'Workspace watcher not initialized',
      files: [],
    };
  }

  const workspaceWatcher = watcher;
  const rootPath = workspaceWatcher.getWorkspaceDir();
  const files = workspaceWatcher.getFiles().map((file) => ({
    ...file,
    system: 'openclaw' as const,
    systemLabel: getSystemLabel('openclaw'),
    viewerKey: buildViewerKey('openclaw', file.name),
    rootPath,
    displayName: file.name,
  }));

  return {
    id: 'openclaw',
    label: getSystemLabel('openclaw'),
    rootPath,
    available: true,
    files,
  };
}

async function buildHermesSystem(): Promise<WorkspaceSystemPayload> {
  const rootPath = HERMES_WORKSPACE_ROOT;

  try {
    await fs.access(rootPath);
  } catch (error: any) {
    return {
      id: 'hermes',
      label: getSystemLabel('hermes'),
      rootPath,
      available: false,
      reason: error?.code === 'EACCES' ? 'Hermes workspace is not readable from the dashboard runtime' : 'Hermes workspace path is not available',
      files: [],
    };
  }

  const files = await listHermesWorkspaceFiles(rootPath);

  return {
    id: 'hermes',
    label: getSystemLabel('hermes'),
    rootPath,
    available: true,
    files,
  };
}

async function listWorkspaceSystems(): Promise<WorkspaceSystemPayload[]> {
  return Promise.all([
    buildOpenClawSystem(),
    buildHermesSystem(),
  ]);
}

async function readSystemFile(system: 'openclaw' | 'hermes', relativePath: string) {
  const rootPath = system === 'hermes'
    ? HERMES_WORKSPACE_ROOT
    : (watcher?.getWorkspaceDir() || OPENCLAW_WORKSPACE_ROOT);
  const sanitizedPath = sanitizePath(rootPath, relativePath);
  if (!sanitizedPath) return null;

  try {
    const stats = await fs.stat(sanitizedPath);
    if (!stats.isFile()) return null;
    const content = await fs.readFile(sanitizedPath, 'utf-8');
    return {
      content,
      meta: {
        name: relativePath,
        path: sanitizedPath,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        lines: content.split('\n').length,
        category: relativePath.startsWith('memory/') ? 'memory' : 'core',
        description: system === 'hermes' ? 'Hermes workspace file' : 'Workspace file',
        system,
        systemLabel: getSystemLabel(system),
        viewerKey: buildViewerKey(system, relativePath),
        rootPath,
        displayName: relativePath,
      },
    };
  } catch {
    return null;
  }
}

router.get('/files', async (_req: Request, res: Response) => {
  const systems = await listWorkspaceSystems();
  const files = systems.flatMap((system) => system.files);

  res.json({
    success: true,
    count: files.length,
    files,
    systems,
  });
});

// Baked at image build by the Dockerfiles; authoritative over mounted git
// metadata, which reflects whatever happens to be on the host filesystem
// rather than what this image was actually built from.
const RELEASE_MANIFEST_PATH = process.env.RELEASE_MANIFEST_PATH || '/release-manifest.json';

async function readReleaseManifest(): Promise<Record<string, string> | null> {
  try {
    return JSON.parse(await fs.readFile(RELEASE_MANIFEST_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

router.get('/version', async (_req: Request, res: Response) => {
  const rootPath = await resolveVersionRootPath();
  const version = await readGitMetadata(rootPath);
  const release = await readReleaseManifest();

  res.json({
    success: true,
    release,
    version: version || {
      appVersion: process.env.npm_package_version || '2.0.0',
      branch: null,
      commit: null,
      shortCommit: null,
      remoteUrl: null,
      repoWebUrl: null,
      branchUrl: null,
      commitUrl: null,
    },
  });
});

router.get('/read', async (req: Request, res: Response) => {
  const filePath = req.query.path as string;

  if (!filePath) {
    res.status(400).json({ success: false, error: 'Missing path parameter' });
    return;
  }

  const sanitizedPath = sanitizePath(OPENCLAW_WORKSPACE_ROOT, filePath);
  if (!sanitizedPath) {
    res.status(400).json({ success: false, error: 'Invalid file path or unsupported file type' });
    return;
  }

  try {
    const stats = await fs.stat(sanitizedPath);
    if (!stats.isFile()) {
      res.status(400).json({ success: false, error: 'Path is not a file' });
      return;
    }

    const content = await fs.readFile(sanitizedPath, 'utf-8');
    res.json({
      success: true,
      file: {
        name: path.basename(sanitizedPath),
        path: filePath,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        lines: content.split('\n').length,
      },
      content,
    });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ success: false, error: 'File not found' });
    } else if (error.code === 'EACCES') {
      res.status(403).json({ success: false, error: 'Permission denied' });
    } else {
      console.error('Error reading file:', error);
      res.status(500).json({ success: false, error: 'Failed to read file' });
    }
  }
});

router.get('/files/*', async (req: Request, res: Response) => {
  const key = (req.params as any)[0];
  if (!key) {
    res.status(400).json({ success: false, error: 'File name required' });
    return;
  }

  const { system, relativePath } = parseViewerKey(key);
  if (!relativePath || relativePath.includes('..')) {
    res.status(400).json({ success: false, error: 'Invalid file path' });
    return;
  }

  const result = await readSystemFile(system, relativePath);
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

router.put('/files/*', async (req: Request, res: Response) => {
  const key = (req.params as any)[0];
  if (!key) {
    res.status(400).json({ success: false, error: 'File name required' });
    return;
  }

  const { system, relativePath } = parseViewerKey(key);
  if (!relativePath || relativePath.includes('..')) {
    res.status(400).json({ success: false, error: 'Invalid file path' });
    return;
  }

  const { content } = req.body;
  if (typeof content !== 'string') {
    res.status(400).json({ success: false, error: 'Content must be a string' });
    return;
  }

  const rootPath = system === 'hermes'
    ? HERMES_WORKSPACE_ROOT
    : (watcher?.getWorkspaceDir() || OPENCLAW_WORKSPACE_ROOT);
  const filePath = sanitizePath(rootPath, relativePath);

  if (!filePath) {
    res.status(400).json({ success: false, error: 'Path escapes workspace directory or file type is unsupported' });
    return;
  }

  try {
    await fs.writeFile(filePath, content, 'utf-8');
    res.json({ success: true, message: `File ${relativePath} saved`, system });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to save file' });
  }
});

export default router;
