import crypto from 'crypto';
import { pool } from '../db/connection';
import { journalRunService } from './JournalRunService';
import { discordThreadService } from './DiscordThreadService';

const MEANINGFUL = new Set(['review_ready', 'approved', 'rejected', 'validation_failed', 'publication_unknown', 'rollback_unknown', 'published', 'rolled_back']);

export class JournalRunNotificationService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private channel = process.env.CLAWBOARD_DISCORD_JOURNAL_CHANNEL_ID || '',
    private interval = Math.max(30_000, Number(process.env.CLAWBOARD_JOURNAL_NOTICE_POLL_MS || 60_000)),
  ) {}

  start(): void {
    if (!this.channel || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.interval);
    void this.tick();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(): Promise<void> {
    if (this.running || !this.channel) return;
    this.running = true;
    try {
      for (const run of await journalRunService.list(100)) {
        const history = await journalRunService.history(run.key);
        const event = history[history.length - 1];
        if (!event || !MEANINGFUL.has(event.state) || !event.at) continue;
        const fp = crypto.createHash('sha256').update(`${run.key}|${event.state}|${event.at}|${event.reasonCode || ''}`).digest('hex');
        const recent = Date.parse(event.at) > Date.now() - 15 * 60_000;
        const row = await pool.query(
          `INSERT INTO journal_run_notifications(run_key,event_fingerprint,event_state,channel_id,status)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(run_key,event_fingerprint,channel_id) DO UPDATE
             SET status='pending',next_attempt_at=NULL
             WHERE journal_run_notifications.status='failed'
               AND journal_run_notifications.next_attempt_at<=NOW()
           RETURNING id,status,attempt_count`,
          [run.key, fp, event.state, this.channel, recent ? 'pending' : 'suppressed'],
        );
        if (!row.rowCount || row.rows[0].status !== 'pending') continue;
        if (!recent && Number(row.rows[0].attempt_count || 0) === 0) continue;
        const rate = await pool.query(
          `SELECT count(*)::int n FROM journal_run_notifications
           WHERE channel_id=$1 AND status='sent' AND sent_at>NOW()-INTERVAL '10 minutes'`,
          [this.channel],
        );
        if (Number(rate.rows[0]?.n || 0) >= 5) {
          await pool.query(`UPDATE journal_run_notifications SET status='suppressed',last_error_code='global_rate_limit' WHERE id=$1`, [row.rows[0].id]);
          continue;
        }
        try {
          const sent = await discordThreadService.sendSystemChannelMessage(this.channel, this.render(run.key, run.date, event.state));
          await pool.query(`UPDATE journal_run_notifications SET status='sent',sent_at=NOW(),attempt_count=attempt_count+1,discord_message_id=$2,last_error_code=NULL WHERE id=$1`, [row.rows[0].id, sent.messageId || null]);
        } catch {
          await pool.query(`UPDATE journal_run_notifications SET status='failed',attempt_count=attempt_count+1,next_attempt_at=NOW()+INTERVAL '10 minutes',last_error_code='send_failed' WHERE id=$1`, [row.rows[0].id]);
        }
      }
    } finally { this.running = false; }
  }

  private render(key: string, date: string | null, state: string): string {
    const base = (process.env.CLAWBOARD_JOURNAL_DASHBOARD_URL || 'http://localhost:8082/dashboard/journal').split('?')[0];
    const labels: Record<string, string> = { review_ready: 'ready for review', approved: 'approved', rejected: 'rejected', validation_failed: 'validation failed', publication_unknown: 'publication needs reconciliation', rollback_unknown: 'rollback needs reconciliation', published: 'published', rolled_back: 'rolled back' };
    return `Journal ${date || 'run'} · ${labels[state] || state} · ${key.slice(0, 8)} · ${base}`.slice(0, 400);
  }
}

export const journalRunNotificationService = new JournalRunNotificationService();
