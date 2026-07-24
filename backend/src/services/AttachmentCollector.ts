/**
 * AttachmentCollector — collect project context files for agent spawns.
 *
 * Mimics sessions_spawn attachment behaviour: files are read from the filesystem,
 * size-checked, and returned as { name, content, encoding, mimeType } objects so
 * the backend can materialise them into the agent workspace before calling cron.add.
 *
 * Priority order for auto-collection:
 *   1. Audit reports / docs mentioned in task links (highest signal)
 *   2. AGENTS.md / README.md from project SSD path
 *   3. Key source files referenced in subtask descriptions
 *   4. Tool configs are already embedded in the prompt — skip here
 */

import { readFileSync, statSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';

/** One attachment, matching the sessions_spawn attachments schema. */
export interface Attachment {
  name: string;
  content: string;        // utf8 text or base64 string
  encoding: 'utf8' | 'base64';
  mimeType?: string;
}

/** Limits — configurable, with conservative defaults. */
export interface AttachmentLimits {
  maxFileBytes: number;   // default 100 KB
  maxTotalBytes: number;  // default 500 KB
  maxFiles: number;       // default 50
}

const DEFAULT_LIMITS: AttachmentLimits = {
  maxFileBytes: 100 * 1024,   // 100 KB
  maxTotalBytes: 500 * 1024,  // 500 KB
  maxFiles: 50,
};

/** Map of file extensions to MIME types for text files. */
const TEXT_MIME: Record<string, string> = {
  '.md':   'text/markdown',
  '.txt':  'text/plain',
  '.ts':   'text/typescript',
  '.tsx':  'text/typescript',
  '.js':   'text/javascript',
  '.py':   'text/x-python',
  '.sh':   'text/x-shellscript',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml':  'text/yaml',
  '.toml': 'text/toml',
  '.env':  'text/plain',
  '.sql':  'text/x-sql',
  '.html': 'text/html',
  '.css':  'text/css',
};

/** Result of collect() — includes per-file stats for logging. */
export interface CollectResult {
  attachments: Attachment[];
  skipped: Array<{ path: string; reason: string }>;
  totalBytes: number;
}

export class AttachmentCollector {
  private limits: AttachmentLimits;

  constructor(limits: Partial<AttachmentLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * Collect files from a list of candidate absolute paths.
   * Files are deduplicated by name, size-checked, and returned in priority order.
   */
  public collect(candidatePaths: string[]): CollectResult {
    const result: CollectResult = {
      attachments: [],
      skipped: [],
      totalBytes: 0,
    };

    const seenNames = new Set<string>();

    for (const filePath of candidatePaths) {
      if (result.attachments.length >= this.limits.maxFiles) {
        result.skipped.push({ path: filePath, reason: 'maxFiles limit reached' });
        continue;
      }

      // Deduplicate by basename
      const name = basename(filePath);
      if (seenNames.has(name)) {
        result.skipped.push({ path: filePath, reason: `duplicate name: ${name}` });
        continue;
      }

      if (!existsSync(filePath)) {
        result.skipped.push({ path: filePath, reason: 'file not found' });
        continue;
      }

      let size: number;
      try {
        size = statSync(filePath).size;
      } catch (err) {
        result.skipped.push({ path: filePath, reason: `stat error: ${err}` });
        continue;
      }

      if (size > this.limits.maxFileBytes) {
        result.skipped.push({
          path: filePath,
          reason: `file too large (${size} bytes > ${this.limits.maxFileBytes} limit)`,
        });
        continue;
      }

      if (result.totalBytes + size > this.limits.maxTotalBytes) {
        result.skipped.push({
          path: filePath,
          reason: `total budget exceeded (would be ${result.totalBytes + size} > ${this.limits.maxTotalBytes})`,
        });
        continue;
      }

      // Read the file
      let content: string;
      let encoding: 'utf8' | 'base64' = 'utf8';
      const ext = extname(filePath).toLowerCase();
      const mimeType = TEXT_MIME[ext] ?? 'application/octet-stream';

      try {
        if (TEXT_MIME[ext]) {
          // Text file — read as utf8
          content = readFileSync(filePath, 'utf8');
        } else {
          // Binary file — encode as base64
          content = readFileSync(filePath).toString('base64');
          encoding = 'base64';
        }
      } catch (err) {
        result.skipped.push({ path: filePath, reason: `read error: ${err}` });
        continue;
      }

      seenNames.add(name);
      result.totalBytes += size;
      result.attachments.push({ name, content, encoding, mimeType });
    }

    return result;
  }

  /**
   * Build a prioritised list of candidate file paths for a project task.
   *
   * @param options.projectSsdPath   - Repo / SSD path (e.g. ~/agent-workspace/projects/foo/repo)
   * @param options.taskLinkUrls     - file:// URLs from task links (audit reports, docs)
   * @param options.subtaskTexts     - Subtask description strings (scanned for file refs)
   */
  public buildCandidatePaths(options: {
    projectSsdPath?: string | null;
    taskLinkUrls?: string[];
    subtaskTexts?: string[];
  }): string[] {
    const candidates: string[] = [];

    // ── Priority 1: Explicit file:// links (audit reports, docs) ──────────────
    for (const url of options.taskLinkUrls ?? []) {
      if (url.startsWith('file://')) {
        const filePath = url.replace(/^file:\/\//, '');
        if (filePath && !candidates.includes(filePath)) {
          candidates.push(filePath);
        }
      }
    }

    // ── Priority 2: AGENTS.md / README.md from project SSD path ─────────────
    if (options.projectSsdPath) {
      const base = options.projectSsdPath;
      for (const name of ['AGENTS.md', 'README.md', 'README', '.cursorrules', 'CLAUDE.md']) {
        const full = join(base, name);
        if (!candidates.includes(full)) {
          candidates.push(full);
        }
      }
      // Also check one level up (e.g. if ssdPath is /projects/foo/repo, check /projects/foo/)
      const parent = join(base, '..');
      for (const name of ['AGENTS.md', 'README.md']) {
        const full = join(parent, name);
        if (!candidates.includes(full)) {
          candidates.push(full);
        }
      }
    }

    // ── Priority 3: File paths extracted from subtask descriptions ────────────
    for (const text of options.subtaskTexts ?? []) {
      const fileRefs = this.extractFilePaths(text);
      for (const ref of fileRefs) {
        if (!candidates.includes(ref)) {
          candidates.push(ref);
        }
      }
    }

    return candidates;
  }

  /**
   * Extract plausible absolute file paths from a text string.
   * Looks for patterns like `/home/...`, `/srv/...`, `/app/...`, `~/...`
   */
  private extractFilePaths(text: string): string[] {
    const paths: string[] = [];
    // Match absolute paths ending in a known extension or common config names
    const pathPattern = /(?:^|\s)((?:\/[^\s,;:'"()[\]]+)+\.(?:md|ts|js|py|json|yaml|yml|sh|txt))/gm;
    let match: RegExpExecArray | null;
    while ((match = pathPattern.exec(text)) !== null) {
      const p = match[1].trim();
      if (p && !paths.includes(p)) {
        paths.push(p);
      }
    }
    return paths;
  }
}

/** Singleton instance with default limits. */
export const attachmentCollector = new AttachmentCollector();
