import { existsSync } from 'fs';
import { extname } from 'path';
import type { Attachment } from './AttachmentCollector';
import { writeAttachments, type AttachmentManifest } from './AttachmentWriter';

export const STEERING_ATTACHMENT_LIMITS = {
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 6 * 1024 * 1024,
  maxFiles: 6,
} as const;

const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'text/yaml',
  'text/x-log',
  'application/json',
  'application/x-ndjson',
]);

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const EXTENSION_TO_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.log': 'text/x-log',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.ndjson': 'application/x-ndjson',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function normalizeMimeType(name: string, mimeType?: string): string | null {
  const normalized = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (normalized && (TEXT_MIME_TYPES.has(normalized) || IMAGE_MIME_TYPES.has(normalized))) {
    return normalized;
  }

  const fromExtension = EXTENSION_TO_MIME[extname(name).toLowerCase()] || null;
  return fromExtension;
}

function getAttachmentBytes(attachment: Attachment): number {
  return attachment.encoding === 'base64'
    ? Buffer.from(attachment.content, 'base64').byteLength
    : Buffer.from(attachment.content, 'utf8').byteLength;
}

export function getSteeringAttachmentConfig() {
  return {
    ...STEERING_ATTACHMENT_LIMITS,
    supportedMimeTypes: [...TEXT_MIME_TYPES, ...IMAGE_MIME_TYPES].sort(),
    supportedExtensions: Object.keys(EXTENSION_TO_MIME).sort(),
    description: 'Steering accepts screenshots and plain-text/text-like files only. Other binary files are rejected.',
  };
}

export function validateSteeringAttachments(input: unknown): Attachment[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new Error('attachments must be an array');
  }
  if (input.length > STEERING_ATTACHMENT_LIMITS.maxFiles) {
    throw new Error(`Too many attachments. Max ${STEERING_ATTACHMENT_LIMITS.maxFiles} files per steering message.`);
  }

  let totalBytes = 0;
  const seenNames = new Set<string>();

  return input.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new Error(`Attachment ${index + 1} is invalid.`);
    }

    const candidate = value as Partial<Attachment>;
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    if (!name) {
      throw new Error(`Attachment ${index + 1} is missing a name.`);
    }

    if (seenNames.has(name)) {
      throw new Error(`Attachment "${name}" was added more than once.`);
    }
    seenNames.add(name);

    const encoding = candidate.encoding;
    if (encoding !== 'utf8' && encoding !== 'base64') {
      throw new Error(`Attachment "${name}" uses unsupported encoding.`);
    }

    if (typeof candidate.content !== 'string' || candidate.content.length === 0) {
      throw new Error(`Attachment "${name}" is empty.`);
    }

    const mimeType = normalizeMimeType(name, candidate.mimeType);
    if (!mimeType) {
      throw new Error(`Attachment "${name}" is not supported for steering. Use screenshots or plain-text files.`);
    }

    const attachment: Attachment = {
      name,
      content: candidate.content,
      encoding,
      mimeType,
    };

    const bytes = getAttachmentBytes(attachment);
    if (bytes > STEERING_ATTACHMENT_LIMITS.maxFileBytes) {
      throw new Error(`Attachment "${name}" exceeds the ${STEERING_ATTACHMENT_LIMITS.maxFileBytes} byte per-file limit.`);
    }

    totalBytes += bytes;
    if (totalBytes > STEERING_ATTACHMENT_LIMITS.maxTotalBytes) {
      throw new Error(`Attachments exceed the ${STEERING_ATTACHMENT_LIMITS.maxTotalBytes} byte total limit.`);
    }

    return attachment;
  });
}

export function resolveAgentWorkspaceDir(): string {
  return process.env.AGENT_WORKSPACE_DIR
    || (existsSync('/workspace') ? '/workspace' : '/home/clawd/clawd');
}

export async function materializeSteeringAttachments(input: unknown): Promise<AttachmentManifest | null> {
  const attachments = validateSteeringAttachments(input);
  if (attachments.length === 0) return null;
  return writeAttachments(resolveAgentWorkspaceDir(), attachments);
}

export function buildSteeringMessage(message: string | null | undefined, manifest: AttachmentManifest | null): string {
  const trimmedMessage = typeof message === 'string' ? message.trim() : '';
  if (!manifest) return trimmedMessage;

  const fileLines = manifest.files.map(file => {
    const size = file.bytes >= 1024 ? `${(file.bytes / 1024).toFixed(1)} KB` : `${file.bytes} B`;
    return `- ${file.name} (${size}${file.mimeType ? `, ${file.mimeType}` : ''})`;
  });

  const intro = [
    '## Steering attachments',
    '',
    `Files for this steering message are available in your workspace at \`${manifest.relDir}/\`.`,
    'Read them directly from that path before acting. Image attachments should be inspected with the read tool.',
    '',
    ...fileLines,
  ].join('\n');

  if (!trimmedMessage) {
    return `${intro}\n\nPlease inspect the attached files and continue from the current state.`;
  }

  return `${intro}\n\n## Steering request\n${trimmedMessage}`;
}
