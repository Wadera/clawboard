import React, { useMemo, useRef, useState } from 'react';
import { AlertCircle, FileText, Image as ImageIcon, Paperclip, Send, X } from 'lucide-react';
import { authenticatedFetch } from '../../utils/auth';
import './SessionSteeringComposer.css';

const API_BASE_URL = (import.meta as any).env?.VITE_API_BASE_URL || '/api';

interface SteeringAttachmentPayload {
  name: string;
  content: string;
  encoding: 'utf8' | 'base64';
  mimeType?: string;
}

interface AttachmentSupport {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  supportedMimeTypes?: string[];
  supportedExtensions?: string[];
  description?: string;
}

interface PendingAttachment {
  id: string;
  file: File;
  mimeType: string;
}

interface SessionSteeringComposerProps {
  sessionKey: string;
  title?: string;
  description?: string;
  enabled?: boolean;
  disabledReason?: string | null;
  attachmentSupport?: AttachmentSupport | null;
  inputPlaceholder?: string;
  compact?: boolean;
}

const FALLBACK_ATTACHMENT_SUPPORT: AttachmentSupport = {
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 6 * 1024 * 1024,
  maxFiles: 6,
  supportedExtensions: ['.txt', '.md', '.log', '.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.csv', '.png', '.jpg', '.jpeg', '.webp', '.gif'],
  supportedMimeTypes: ['text/plain', 'text/markdown', 'text/x-markdown', 'text/csv', 'text/yaml', 'text/x-log', 'application/json', 'application/x-ndjson', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  description: 'Steering accepts screenshots and plain-text/text-like files only.',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function normalizeMimeType(file: File, support: AttachmentSupport): string | null {
  const type = file.type?.trim().toLowerCase();
  if (type && support.supportedMimeTypes?.includes(type)) return type;

  const ext = getExtension(file.name);
  if (!ext) return null;

  const extensionMap: Record<string, string> = {
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

  const normalized = extensionMap[ext] || null;
  return normalized && support.supportedMimeTypes?.includes(normalized) ? normalized : normalized;
}

function isTextLikeMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/x-ndjson';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fileToAttachment(file: File, mimeType: string): Promise<SteeringAttachmentPayload> {
  if (isTextLikeMime(mimeType)) {
    return {
      name: file.name,
      content: await file.text(),
      encoding: 'utf8',
      mimeType,
    };
  }

  return {
    name: file.name,
    content: arrayBufferToBase64(await file.arrayBuffer()),
    encoding: 'base64',
    mimeType,
  };
}

export const SessionSteeringComposer: React.FC<SessionSteeringComposerProps> = ({
  sessionKey,
  title = 'Session steering',
  description,
  enabled = true,
  disabledReason,
  attachmentSupport,
  inputPlaceholder,
  compact = false,
}) => {
  const support = attachmentSupport || FALLBACK_ATTACHMENT_SUPPORT;
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalBytes = useMemo(
    () => attachments.reduce((sum, item) => sum + item.file.size, 0),
    [attachments],
  );

  const accept = useMemo(() => (support.supportedExtensions || []).join(','), [support.supportedExtensions]);

  const resetFeedback = () => {
    setNotice(null);
    setError(null);
  };

  const handlePickFiles = () => {
    if (!enabled || sending) return;
    fileInputRef.current?.click();
  };

  const handleFilesSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;

    resetFeedback();

    const next = [...attachments];
    const seenNames = new Set(next.map(item => item.file.name));
    let nextBytes = next.reduce((sum, item) => sum + item.file.size, 0);

    for (const file of files) {
      const mimeType = normalizeMimeType(file, support);
      if (!mimeType) {
        setError(`Unsupported attachment: ${file.name}. Use screenshots or plain-text files.`);
        continue;
      }
      if (seenNames.has(file.name)) {
        setError(`Attachment already added: ${file.name}`);
        continue;
      }
      if (file.size > support.maxFileBytes) {
        setError(`${file.name} is too large. Max ${formatBytes(support.maxFileBytes)} per file.`);
        continue;
      }
      if (next.length >= support.maxFiles) {
        setError(`You can attach up to ${support.maxFiles} files per steering message.`);
        break;
      }
      if (nextBytes + file.size > support.maxTotalBytes) {
        setError(`Attachments exceed the ${formatBytes(support.maxTotalBytes)} total limit.`);
        continue;
      }

      seenNames.add(file.name);
      nextBytes += file.size;
      next.push({
        id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        mimeType,
      });
    }

    setAttachments(next);
  };

  const handleRemoveAttachment = (id: string) => {
    resetFeedback();
    setAttachments(prev => prev.filter(item => item.id !== id));
  };

  const handleSend = async () => {
    if (!enabled || sending) return;
    if (!message.trim() && attachments.length === 0) return;

    resetFeedback();
    setSending(true);

    try {
      const payloadAttachments = await Promise.all(
        attachments.map(item => fileToAttachment(item.file, item.mimeType)),
      );

      const response = await authenticatedFetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionKey)}/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          attachments: payloadAttachments,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to send steering message');
      }

      setMessage('');
      setAttachments([]);
      const target = typeof data?.targetSessionKey === 'string' ? data.targetSessionKey : sessionKey;
      setNotice(data?.attachmentsWritten
        ? `Steering delivery acknowledged by ${target} with attachments. Transcript updates below.`
        : `Steering delivery acknowledged by ${target}. Transcript updates below.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send steering message');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={`session-steering-composer ${enabled ? '' : 'disabled'} ${compact ? 'compact' : ''}`}>
      {!compact && (
        <>
          <div className="session-steering-header">
            <div>
              <div className="session-steering-title">{title}</div>
              {description && <div className="session-steering-description">{description}</div>}
            </div>
          </div>

          <div className="session-steering-helper">
            <Paperclip size={13} />
            <span>
              {support.description} Up to {support.maxFiles} files, {formatBytes(support.maxFileBytes)} each, {formatBytes(support.maxTotalBytes)} total.
            </span>
          </div>
        </>
      )}

      {disabledReason && (
        <div className="session-steering-alert session-steering-alert-warning" role="status">
          <AlertCircle size={14} />
          <span>{disabledReason}</span>
        </div>
      )}

      {notice && (
        <div className="session-steering-alert session-steering-alert-success" role="status" aria-live="polite">
          <span>{notice}</span>
        </div>
      )}

      {error && (
        <div className="session-steering-alert session-steering-alert-error" role="alert">
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="session-steering-attachments">
          {attachments.map(item => {
            const isImage = item.mimeType.startsWith('image/');
            return (
              <div key={item.id} className="session-steering-attachment-chip">
                {isImage ? <ImageIcon size={13} /> : <FileText size={13} />}
                <span className="session-steering-attachment-name">{item.file.name}</span>
                <span className="session-steering-attachment-size">{formatBytes(item.file.size)}</span>
                <button type="button" onClick={() => handleRemoveAttachment(item.id)} disabled={sending}>
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="session-steering-input-row">
        <textarea
          className="session-steering-input"
          value={message}
          onChange={event => setMessage(event.target.value)}
          placeholder={inputPlaceholder || 'Send a steering message, or attach screenshots and text files.'}
          rows={compact ? 1 : 2}
          disabled={!enabled || sending}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
        />

        <div className="session-steering-actions">
          <button type="button" className="session-steering-attach-btn" onClick={handlePickFiles} disabled={!enabled || sending}>
            <Paperclip size={14} />
            <span>Attach</span>
          </button>
          <button
            type="button"
            className="session-steering-send-btn"
            onClick={() => void handleSend()}
            disabled={!enabled || sending || (!message.trim() && attachments.length === 0)}
          >
            <Send size={14} />
            <span>{sending ? 'Sending…' : 'Send'}</span>
          </button>
        </div>
      </div>

      {!compact && (
        <div className="session-steering-footer">
          <span>{attachments.length}/{support.maxFiles} files</span>
          <span>{formatBytes(totalBytes)} / {formatBytes(support.maxTotalBytes)}</span>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={accept}
        className="session-steering-file-input"
        onChange={handleFilesSelected}
      />
    </div>
  );
};
