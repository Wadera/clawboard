import { readFile, readdir, stat, access } from 'fs/promises';
import { watch, FSWatcher } from 'fs';
import path from 'path';
import { WebSocketService } from './websocket';

export interface WorkspaceFile {
  name: string;
  path: string;
  size: number;
  modified: string;
  lines: number;
  category: 'core' | 'memory' | 'other';
  description: string;
}

/**
 * Watches the agent workspace for file changes and broadcasts updates.
 * Tracks: AGENTS.md, HEARTBEAT.md, IDENTITY.md, SOUL.md, TOOLS.md, USER.md, memory/
 */
export class WorkspaceWatcher {
  private workspacePath: string;
  private wsService: WebSocketService;
  private watchers: FSWatcher[] = [];
  private fileCache: Map<string, WorkspaceFile> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;

  // Core workspace files to track
  private static readonly CORE_FILES: Record<string, string> = {
    'AGENTS.md': 'Agent operating instructions',
    'HEARTBEAT.md': 'Heartbeat checklist',
    'IDENTITY.md': 'Agent identity & persona',
    'SOUL.md': 'Personality & tone',
    'TOOLS.md': 'Local tool notes',
    'USER.md': 'User information',
    'MEMORY.md': 'Long-term curated memory',
    'BOOT.md': 'Startup checklist',
  };

  constructor(workspacePath: string, wsService: WebSocketService) {
    this.workspacePath = workspacePath;
    this.wsService = wsService;
  }

  /**
   * Start watching workspace files
   */
  public async start() {
    console.log(`📂 Starting workspace watcher: ${this.workspacePath}`);

    // Initial scan
    await this.scanAll();

    // Watch workspace root for core file changes
    try {
      const rootWatcher = watch(this.workspacePath, { persistent: true }, (_event, filename) => {
        if (filename && (filename.endsWith('.md') || filename === 'memory')) {
          this.handleFileChange(filename);
        }
      });
      this.watchers.push(rootWatcher);
    } catch (err) {
      console.error('❌ Failed to watch workspace root:', err);
    }

    // Watch memory directory
    const memoryDir = path.join(this.workspacePath, 'memory');
    try {
      await access(memoryDir);
      const memWatcher = watch(memoryDir, { persistent: true }, (_event, filename) => {
        if (filename && filename.endsWith('.md')) {
          this.handleFileChange(`memory/${filename}`);
        }
      });
      this.watchers.push(memWatcher);
    } catch {
      console.log('⚠️  memory/ directory not found, will check periodically');
    }

    // Poll every 30s for changes fs.watch might miss
    this.pollInterval = setInterval(() => this.scanAll(), 30000);
  }

  /**
   * Stop watching
   */
  public stop() {
    console.log('📂 Stopping workspace watcher');
    this.watchers.forEach(w => w.close());
    this.watchers = [];
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Get all tracked files
   */
  public getFiles(): WorkspaceFile[] {
    return Array.from(this.fileCache.values()).sort((a, b) => {
      // Core files first, then memory files by date desc
      if (a.category !== b.category) {
        return a.category === 'core' ? -1 : 1;
      }
      return b.modified.localeCompare(a.modified);
    });
  }

  /**
   * Get a single file's content
   */
  public async getFileContent(name: string): Promise<{ content: string; meta: WorkspaceFile } | null> {
    // Security: prevent traversal
    if (name.includes('..')) return null;

    const filePath = path.join(this.workspacePath, name);
    try {
      const content = await readFile(filePath, 'utf-8');
      const stats = await stat(filePath);
      const lines = content.split('\n').length;

      const meta: WorkspaceFile = {
        name,
        path: filePath,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        lines,
        category: this.getCategory(name),
        description: WorkspaceWatcher.CORE_FILES[name] || (name.startsWith('memory/') ? 'Daily memory log' : 'Workspace file'),
      };

      return { content, meta };
    } catch {
      return null;
    }
  }

  /**
   * Scan all workspace files and update cache
   */
  private async scanAll() {
    const newCache = new Map<string, WorkspaceFile>();

    // Scan core files
    for (const [filename, description] of Object.entries(WorkspaceWatcher.CORE_FILES)) {
      const filePath = path.join(this.workspacePath, filename);
      try {
        const stats = await stat(filePath);
        const content = await readFile(filePath, 'utf-8');
        newCache.set(filename, {
          name: filename,
          path: filePath,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          lines: content.split('\n').length,
          category: 'core',
          description,
        });
      } catch {
        // File doesn't exist — skip
      }
    }

    // Scan memory directory
    const memoryDir = path.join(this.workspacePath, 'memory');
    try {
      const files = await readdir(memoryDir);
      for (const filename of files) {
        if (!filename.endsWith('.md')) continue;
        const filePath = path.join(memoryDir, filename);
        try {
          const stats = await stat(filePath);
          const content = await readFile(filePath, 'utf-8');
          const name = `memory/${filename}`;
          newCache.set(name, {
            name,
            path: filePath,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            lines: content.split('\n').length,
            category: 'memory',
            description: 'Daily memory log',
          });
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // memory/ doesn't exist
    }

    // Check for changes and broadcast
    let changed = false;
    for (const [key, file] of newCache) {
      const cached = this.fileCache.get(key);
      if (!cached || cached.modified !== file.modified || cached.size !== file.size) {
        changed = true;
        break;
      }
    }
    if (newCache.size !== this.fileCache.size) changed = true;

    if (changed) {
      this.fileCache = newCache;
      this.broadcastUpdate();
    }
  }

  /**
   * Handle a single file change event
   */
  private async handleFileChange(filename: string) {
    // Debounce — wait 200ms for write to complete
    setTimeout(async () => {
      try {
        await this.scanAll();
      } catch (err) {
        console.error(`❌ Error handling file change for ${filename}:`, err);
      }
    }, 200);
  }

  /**
   * Broadcast current file list to all WebSocket clients
   */
  private broadcastUpdate() {
    const files = this.getFiles();
    this.wsService.broadcast({
      type: 'workspace:files-updated',
      data: { files, timestamp: Date.now() },
    });
  }

  private getCategory(name: string): 'core' | 'memory' | 'other' {
    if (WorkspaceWatcher.CORE_FILES[name]) return 'core';
    if (name.startsWith('memory/')) return 'memory';
    return 'other';
  }
}
