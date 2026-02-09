/**
 * AutoArchive - Phase 4 Step 7
 * 
 * Periodically checks for completed tasks older than the archive threshold
 * and moves them to the 'archived' status.
 * 
 * Default: archive after 7 days. Configurable per-task via archivedAt override.
 */

import { taskManager } from './TaskManager';

const DEFAULT_ARCHIVE_AFTER_DAYS = 7;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour

export class AutoArchive {
  private timer: NodeJS.Timeout | null = null;
  private archiveAfterDays: number;

  constructor(archiveAfterDays = DEFAULT_ARCHIVE_AFTER_DAYS) {
    this.archiveAfterDays = archiveAfterDays;
  }

  /**
   * Start the auto-archive timer
   */
  start(): void {
    console.log(`[AutoArchive] Starting — archive completed tasks after ${this.archiveAfterDays} days`);
    
    // Run immediately on start
    this.runArchive();

    // Then check periodically
    this.timer = setInterval(() => this.runArchive(), CHECK_INTERVAL_MS);
  }

  /**
   * Stop the auto-archive timer
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[AutoArchive] Stopped');
  }

  /**
   * Run one archive cycle
   */
  async runArchive(): Promise<number> {
    try {
      const tasks = taskManager.getAllTasks();
      const now = Date.now();
      const thresholdMs = this.archiveAfterDays * 24 * 60 * 60 * 1000;
      let archived = 0;

      for (const task of tasks) {
        if (task.status !== 'completed') continue;
        if (!task.completedAt) continue;

        const completedTime = new Date(task.completedAt).getTime();
        if (isNaN(completedTime)) continue;

        if (now - completedTime >= thresholdMs) {
          await taskManager.updateTask(task.id, {
            status: 'archived',
            archivedAt: new Date().toISOString(),
          });
          archived++;
          console.log(`[AutoArchive] Archived: "${task.title}" (completed ${Math.round((now - completedTime) / 86400000)}d ago)`);
        }
      }

      if (archived > 0) {
        console.log(`[AutoArchive] Archived ${archived} task(s)`);
      }

      return archived;
    } catch (err) {
      console.error('[AutoArchive] Error:', err);
      return 0;
    }
  }
}

export const autoArchive = new AutoArchive();
