import crypto from 'crypto';
import { Pool } from 'pg';
import { pool as defaultPool } from '../db/connection';
import { taskManagerDB, Task } from './TaskManagerDB';

/**
 * Outbound webhooks for task change notifications (task 3c7da35b).
 * Subscribes to TaskManagerDB events; delivery is best-effort
 * (5s timeout, one retry) and never blocks the emitting operation.
 */

export interface WebhookRow {
  id: string;
  url: string;
  secret: string | null;
  events: string[];
  active: boolean;
  description: string | null;
  created_at: string;
  last_delivery_at: string | null;
  last_delivery_status: number | null;
  last_delivery_error: string | null;
}

export type WebhookEvent =
  | 'task.created' | 'task.updated' | 'task.deleted' | 'task.archived'
  | 'report.created' | 'report.updated' | 'report.deleted';

const DELIVERY_TIMEOUT_MS = 5000;

function taskSummary(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    project: task.project ?? null,
    autoStart: task.autoStart ?? false,
    tags: task.tags ?? [],
  };
}

export class WebhookService {
  private pool: Pool;
  private started = false;

  constructor(poolOverride?: Pool) {
    this.pool = poolOverride || defaultPool;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    taskManagerDB.on('task:created', (task: Task) => this.dispatch('task.created', taskSummary(task)));
    taskManagerDB.on('task:updated', (task: Task) => this.dispatch('task.updated', taskSummary(task)));
    taskManagerDB.on('task:deleted', (id: string) => this.dispatch('task.deleted', { id }));
    taskManagerDB.on('task:archived', (id: string) => this.dispatch('task.archived', { id }));
    console.log('🪝 WebhookService listening for task events');
  }

  async listActiveFor(event: WebhookEvent): Promise<WebhookRow[]> {
    const r = await this.pool.query<WebhookRow>(
      'SELECT * FROM webhooks WHERE active AND $1 = ANY(events)', [event],
    );
    return r.rows;
  }

  buildSignature(secret: string, body: string): string {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  buildPayload(event: WebhookEvent, data: Record<string, unknown>): string {
    return JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  }

  /**
   * Fire-and-forget emission for callers without an EventEmitter (the
   * reports routes — task c655d243 item 7). Reuses the same subscriber
   * lookup + delivery machinery as the task events and never throws.
   */
  emitEvent(event: WebhookEvent, data: Record<string, unknown>): void {
    void this.dispatch(event, data);
  }

  private async dispatch(event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
    try {
      const hooks = await this.listActiveFor(event);
      for (const hook of hooks) {
        void this.deliver(hook, event, data).catch(() => { /* recorded in deliver */ });
      }
    } catch (err) {
      console.error('[webhooks] dispatch failed:', err instanceof Error ? err.message : err);
    }
  }

  async deliver(hook: WebhookRow, event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
    const body = this.buildPayload(event, data);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-ClawBoard-Event': event,
      'X-ClawBoard-Webhook-Id': hook.id,
    };
    if (hook.secret) headers['X-ClawBoard-Signature'] = this.buildSignature(hook.secret, body);

    let lastError: string | null = null;
    let status: number | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
        const resp = await fetch(hook.url, { method: 'POST', headers, body, signal: controller.signal });
        clearTimeout(timer);
        status = resp.status;
        if (resp.ok) { lastError = null; break; }
        lastError = `HTTP ${resp.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    await this.pool.query(
      'UPDATE webhooks SET last_delivery_at = NOW(), last_delivery_status = $2, last_delivery_error = $3 WHERE id = $1',
      [hook.id, status, lastError],
    ).catch(() => { /* status bookkeeping is best-effort */ });
  }
}

export const webhookService = new WebhookService();
