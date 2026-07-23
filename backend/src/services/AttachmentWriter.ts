/**
 * AttachmentWriter — materialise attachment files into the agent workspace,
 * mimicking what the sessions_spawn tool does inside the OpenClaw gateway.
 *
 * Files are written to:
 *   <workspaceDir>/.openclaw/attachments/<uuid>/
 *
 * A `.manifest.json` is placed alongside the files so the agent can discover
 * what was attached without having to parse the prompt.
 *
 * The returned AttachmentManifest is embedded in the agent prompt so the agent
 * knows exactly where to find the files without any path guessing.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID, createHash } from 'crypto';
import type { Attachment } from './AttachmentCollector';

export interface AttachmentManifest {
  uuid: string;
  relDir: string;          // relative to workspace, e.g. ".openclaw/attachments/<uuid>"
  absDir: string;          // absolute path
  workspaceDir: string;
  files: Array<{
    name: string;
    sha256: string;
    bytes: number;
    mimeType?: string;
  }>;
  count: number;
  totalBytes: number;
  createdAt: string;
}

/**
 * Write attachments to the agent workspace and return the manifest.
 *
 * @param workspaceDir  Absolute path to the agent's workspace (e.g. /home/clawd/clawd)
 * @param attachments   Array of attachment objects from AttachmentCollector
 * @returns             Manifest describing where files landed
 */
export async function writeAttachments(
  workspaceDir: string,
  attachments: Attachment[],
): Promise<AttachmentManifest> {
  const uuid = randomUUID();
  const relDir = `.openclaw/attachments/${uuid}`;
  const absDir = join(workspaceDir, relDir);

  // Create directory
  await fs.mkdir(absDir, { recursive: true, mode: 0o750 });

  const files: AttachmentManifest['files'] = [];
  let totalBytes = 0;

  for (const att of attachments) {
    const buf = att.encoding === 'base64'
      ? Buffer.from(att.content, 'base64')
      : Buffer.from(att.content, 'utf8');

    const outPath = join(absDir, att.name);
    await fs.writeFile(outPath, buf, { mode: 0o640 });

    const sha256 = createHash('sha256').update(buf).digest('hex');
    const bytes = buf.byteLength;
    totalBytes += bytes;

    files.push({ name: att.name, sha256, bytes, mimeType: att.mimeType });
  }

  const manifest: AttachmentManifest = {
    uuid,
    relDir,
    absDir,
    workspaceDir,
    files,
    count: files.length,
    totalBytes,
    createdAt: new Date().toISOString(),
  };

  // Write .manifest.json so the agent can enumerate attachments programmatically
  await fs.writeFile(
    join(absDir, '.manifest.json'),
    JSON.stringify(manifest, null, 2),
    { mode: 0o640 },
  );

  return manifest;
}

/**
 * Build the prompt section that tells the agent about attached files.
 * This is inserted into the agentTurn message so the agent can read them.
 */
export function buildAttachmentPromptSection(manifest: AttachmentManifest): string {
  if (manifest.count === 0) return '';

  const lines: string[] = [
    '## Attached Context Files',
    '',
    `Files have been pre-loaded into your agent workspace at:`,
    `\`${manifest.relDir}/\``,
    '',
    'You can read them with:',
    `\`\`\`bash`,
    `ls "${manifest.relDir}/"`,
    `cat "${manifest.relDir}/AGENTS.md"   # example`,
    `\`\`\``,
    '',
    '| File | Size | SHA256 (first 12) |',
    '|------|------|-------------------|',
  ];

  for (const f of manifest.files) {
    const sizeStr = f.bytes > 1024
      ? `${(f.bytes / 1024).toFixed(1)} KB`
      : `${f.bytes} B`;
    lines.push(`| \`${f.name}\` | ${sizeStr} | \`${f.sha256.slice(0, 12)}\` |`);
  }

  lines.push('');
  lines.push(
    '> **Why attached?** These files are embedded in your workspace to avoid path ' +
    'resolution issues (sandbox, symlinks, wrong working directory). ' +
    'Prefer reading from the attachment path above rather than guessing absolute system paths.',
  );

  return lines.join('\n');
}

/**
 * Clean up attachment directory (call after agent session ends, or on failure).
 * Non-throwing — logs but does not propagate errors.
 */
export async function cleanupAttachments(absDir: string): Promise<void> {
  try {
    await fs.rm(absDir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[AttachmentWriter] cleanup failed for ${absDir}:`, err);
  }
}
