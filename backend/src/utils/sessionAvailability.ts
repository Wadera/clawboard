import fs from 'fs';
import path from 'path';

export type SessionRuntimeState = 'live' | 'starting' | 'missing' | 'ended';
export type SessionTranscriptState = 'available' | 'missing' | 'none';

export interface SessionRuntimeAvailability {
  state: SessionRuntimeState;
  reason: string;
}

export interface SessionTranscriptAvailability {
  state: SessionTranscriptState;
  reason: string;
  transcriptPath: string | null;
  fileSize: number | null;
}

export interface SessionAvailabilityRow {
  status?: string | null;
  started_at?: string | Date | null;
  updated_at?: string | Date | null;
  last_activity_at?: string | Date | null;
  transcript_path?: string | null;
  session_id?: string | null;
  message_count?: number | string | null;
  tool_call_count?: number | string | null;
  file_size?: number | string | null;
}

function toTimestamp(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function toCount(value: number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function findDeletedTranscript(dir: string, sessionId: string): string | null {
  try {
    const prefix = `${sessionId}.jsonl.deleted.`;
    const files = fs.readdirSync(dir)
      .filter((file) => file.startsWith(prefix))
      .sort()
      .reverse();
    return files.length > 0 ? path.join(dir, files[0]) : null;
  } catch {
    return null;
  }
}

export function resolveTranscriptAvailability(row: SessionAvailabilityRow, transcriptsDir: string): SessionTranscriptAvailability {
  const reportedPath = row.transcript_path ? String(row.transcript_path) : null;
  let transcriptPath = reportedPath && fs.existsSync(reportedPath) ? reportedPath : null;

  if (!transcriptPath && row.session_id) {
    const sessionId = String(row.session_id);
    const candidate = path.join(transcriptsDir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      transcriptPath = candidate;
    } else {
      transcriptPath = findDeletedTranscript(transcriptsDir, sessionId);
    }
  }

  if (transcriptPath) {
    let fileSize: number | null = null;
    try {
      fileSize = fs.statSync(transcriptPath).size;
    } catch {
      fileSize = row.file_size != null ? toCount(row.file_size) : null;
    }
    return {
      state: 'available',
      reason: 'Transcript file is available for this session.',
      transcriptPath,
      fileSize,
    };
  }

  const recordedActivity = toCount(row.message_count) + toCount(row.tool_call_count);
  if (recordedActivity > 0) {
    return {
      state: 'missing',
      reason: 'Session metadata reports recorded messages or tool calls, but no transcript file is currently available.',
      transcriptPath: null,
      fileSize: null,
    };
  }

  return {
    state: 'none',
    reason: 'No transcript has been recorded for this session yet.',
    transcriptPath: null,
    fileSize: null,
  };
}

export function resolveRuntimeAvailability(
  row: SessionAvailabilityRow,
  liveState: Record<string, any> | null,
  now = Date.now(),
  startupGraceMs = 45_000,
): SessionRuntimeAvailability {
  if (liveState) {
    return {
      state: 'live',
      reason: 'Live runtime heartbeat is available for this session.',
    };
  }

  if (row.status !== 'active') {
    return {
      state: 'ended',
      reason: 'Session is no longer marked active.',
    };
  }

  const startedAt = toTimestamp(row.started_at);
  const updatedAt = toTimestamp(row.updated_at) ?? toTimestamp(row.last_activity_at);
  const freshest = Math.max(startedAt ?? 0, updatedAt ?? 0);

  if (freshest > 0 && (now - freshest) <= startupGraceMs) {
    return {
      state: 'starting',
      reason: 'Session is marked active and still within the startup grace window, but no live runtime heartbeat has arrived yet.',
    };
  }

  return {
    state: 'missing',
    reason: 'Session is still marked active, but no current runtime heartbeat is available.',
  };
}