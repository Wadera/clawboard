import { randomUUID } from 'crypto';
import { pool } from '../db/connection';
import { agentHistoryService } from './AgentHistoryService';
import type { Task } from './TaskManagerDB';

export interface TaskTimelineEvent {
  id: string;
  taskId: string;
  eventType: string;
  title: string;
  description?: string | null;
  createdAt: string;
  sessionKey?: string | null;
  actor?: string | null;
  harness?: string | null;
  source: 'timeline' | 'agent-history' | 'review-history' | 'legacy';
  metadata?: Record<string, any>;
}

export interface RecordTaskTimelineEventInput {
  taskId: string;
  eventType: string;
  title: string;
  description?: string | null;
  sessionKey?: string | null;
  actor?: string | null;
  harness?: string | null;
  metadata?: Record<string, any>;
  createdAt?: string;
}

function normalizeMetadata(value: any): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeReviewDecision(entry: any): 'pass' | 'reject' | 'escalate' | 'running' | 'unknown' {
  const decision = typeof entry?.decision === 'string' ? entry.decision : null;
  if (decision === 'pass' || decision === 'reject' || decision === 'escalate' || decision === 'running') {
    return decision;
  }

  const outcome = typeof entry?.outcome === 'string' ? entry.outcome : null;
  switch (outcome) {
    case 'pass':
    case 'passed':
      return 'pass';
    case 'reject':
    case 'rejected':
      return 'reject';
    case 'needs_human_review':
    case 'escalate':
    case 'escalated':
      return 'escalate';
    case 'running':
      return 'running';
    default:
      return 'unknown';
  }
}

function reviewDecisionTitle(entry: any): string {
  switch (normalizeReviewDecision(entry)) {
    case 'pass':
      return 'Automated reviewer passed task';
    case 'reject':
      return 'Automated reviewer rejected task';
    case 'escalate':
      return 'Automated reviewer escalated task';
    case 'running':
      return 'Automated reviewer started';
    default:
      return 'Automated reviewer ran';
  }
}

function reviewDecisionEventType(entry: any): string {
  const decision = normalizeReviewDecision(entry);
  return decision === 'unknown' ? 'review.unknown' : `review.${decision}`;
}

function reviewCreatedAt(task: Task, entry: any): string {
  const value = entry?.completedAt || entry?.createdAt || entry?.at || task.updated || task.created;
  return typeof value === 'string' && value ? value : task.updated || task.created;
}

function reviewSummary(entry: any): string | null {
  if (typeof entry?.summary === 'string' && entry.summary.trim()) return entry.summary.trim();
  if (typeof entry?.details === 'string' && entry.details.trim()) return entry.details.trim();
  return null;
}

function reviewActor(entry: any): string | null {
  if (typeof entry?.triggeredBy === 'string' && entry.triggeredBy.trim()) return entry.triggeredBy.trim();
  if (typeof entry?.actor === 'string' && entry.actor.trim()) return entry.actor.trim();
  if (entry?.actor && typeof entry.actor === 'object' && typeof entry.actor.triggeredBy === 'string' && entry.actor.triggeredBy.trim()) {
    return entry.actor.triggeredBy.trim();
  }
  return null;
}

class TaskTimelineService {
  async recordEvent(input: RecordTaskTimelineEventInput): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO task_timeline_events (
          id,
          task_id,
          event_type,
          title,
          description,
          session_key,
          actor,
          harness,
          metadata,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, COALESCE($10::timestamptz, CURRENT_TIMESTAMP))`,
        [
          randomUUID(),
          input.taskId,
          input.eventType,
          input.title,
          input.description || null,
          input.sessionKey || null,
          input.actor || null,
          input.harness || null,
          JSON.stringify(input.metadata || {}),
          input.createdAt || null,
        ]
      );
    } catch (err) {
      console.error('[TaskTimelineService] Failed to record event:', err);
    }
  }

  async listStoredEvents(taskId: string): Promise<TaskTimelineEvent[]> {
    try {
      const result = await pool.query(
        `SELECT id, task_id, event_type, title, description, session_key, actor, harness, metadata, created_at
         FROM task_timeline_events
         WHERE task_id = $1
         ORDER BY created_at DESC, id DESC`,
        [taskId]
      );

      return result.rows.map((row: any) => ({
        id: String(row.id),
        taskId: String(row.task_id),
        eventType: String(row.event_type),
        title: String(row.title),
        description: row.description ? String(row.description) : null,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        sessionKey: row.session_key ? String(row.session_key) : null,
        actor: row.actor ? String(row.actor) : null,
        harness: row.harness ? String(row.harness) : null,
        source: 'timeline',
        metadata: normalizeMetadata(row.metadata),
      }));
    } catch (err) {
      console.error('[TaskTimelineService] Failed to load stored events:', err);
      return [];
    }
  }

  async buildTimeline(task: Task): Promise<TaskTimelineEvent[]> {
    const stored = await this.listStoredEvents(task.id);
    const events = [...stored];
    const seen = new Set(events.map((event) => `${event.eventType}:${event.sessionKey || '-'}:${event.createdAt}`));

    const historyRecords = await agentHistoryService.findByTaskId(task.id);
    for (const record of historyRecords) {
      const spawnKey = `session.spawned:${record.sessionKey || '-'}:${record.startedAt}`;
      if (!seen.has(spawnKey)) {
        events.push({
          id: `history-start-${record.taskId}-${record.sessionKey}`,
          taskId: task.id,
          eventType: 'session.spawned',
          title: 'Spawned session',
          description: record.label || record.name || task.title,
          createdAt: record.startedAt,
          sessionKey: record.sessionKey,
          actor: record.name || null,
          harness: null,
          source: 'agent-history',
          metadata: {
            label: record.label,
            model: record.model,
          },
        });
        seen.add(spawnKey);
      }

      if (record.completedAt) {
        const finishKey = `session.finished:${record.sessionKey || '-'}:${record.completedAt}`;
        if (!seen.has(finishKey)) {
          const outcome = record.outcome || 'completed';
          const finishTitle = outcome === 'stuck'
            ? 'Session ended in stuck state'
            : outcome === 'error'
              ? 'Session ended with error'
              : 'Session finished';
          events.push({
            id: `history-finish-${record.taskId}-${record.sessionKey}`,
            taskId: task.id,
            eventType: 'session.finished',
            title: finishTitle,
            description: record.label || record.name || task.title,
            createdAt: record.completedAt,
            sessionKey: record.sessionKey,
            actor: record.name || null,
            harness: null,
            source: 'agent-history',
            metadata: {
              outcome,
              durationMs: record.durationMs,
              tokenUsage: record.tokenUsage,
            },
          });
          seen.add(finishKey);
        }
      }
    }

    const reviewEntries = Array.isArray((task as any).reviewHistory)
      ? (task as any).reviewHistory
      : [];
    for (const entry of reviewEntries) {
      const createdAt = reviewCreatedAt(task, entry);
      const eventType = reviewDecisionEventType(entry);
      const reviewKey = `${eventType}:-:${createdAt}`;
      if (seen.has(reviewKey)) continue;
      events.push({
        id: `review-${entry.id || createdAt}`,
        taskId: task.id,
        eventType,
        title: reviewDecisionTitle(entry),
        description: reviewSummary(entry),
        createdAt,
        sessionKey: entry.evidence?.completedBy?.sessionKey || null,
        actor: reviewActor(entry),
        harness: entry.evidence?.completedBy?.harness || null,
        source: 'review-history',
        metadata: {
          decision: normalizeReviewDecision(entry),
          findings: entry.findings,
          statusBefore: entry.statusBefore,
          statusAfter: entry.statusAfter,
          outcome: entry.outcome,
          attemptCount: entry.attemptCount,
        },
      });
      seen.add(reviewKey);
    }

    for (const sessionKey of task.sessionRefs || []) {
      const legacyKey = `session.reference:${sessionKey}:-`;
      if (seen.has(legacyKey)) continue;
      events.push({
        id: `legacy-session-${task.id}-${sessionKey}`,
        taskId: task.id,
        eventType: 'session.reference',
        title: 'Legacy session reference',
        description: 'Captured before durable task timeline events were enabled.',
        createdAt: task.updated || task.created,
        sessionKey,
        actor: null,
        harness: null,
        source: 'legacy',
        metadata: {},
      });
      seen.add(legacyKey);
    }

    events.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return events;
  }
}

export const taskTimelineService = new TaskTimelineService();
