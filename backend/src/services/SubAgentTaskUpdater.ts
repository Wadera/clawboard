/**
 * SubAgentTaskUpdater - Auto-update task status when sub-agent sessions complete
 * 
 * This service:
 * 1. Monitors sessions.json for sub-agent activity
 * 2. Tracks tasks with activeAgent.sessionKey set
 * 3. Auto-updates task status when the linked session completes:
 *    - Completed successfully → mark task as 'completed'
 *    - Errored/aborted → mark task as 'stuck'
 * 
 * This closes the feedback loop so the Kanban board reflects reality
 * without relying on agents to manually PATCH tasks.
 */

import { readFile } from 'fs/promises';
import { EventEmitter } from 'events';
import { taskManager, Task } from './TaskManager';
import { agentHistoryService } from './AgentHistoryService';

interface SessionData {
  updatedAt: number;
  label?: string;
  sessionId?: string;
  [key: string]: any;
}

interface TrackedSession {
  sessionKey: string;
  taskId: string;
  lastSeen: number;
  state: 'running' | 'idle' | 'completed' | 'error';
}

export class SubAgentTaskUpdater extends EventEmitter {
  private sessionsPath: string;
  private trackedSessions: Map<string, TrackedSession> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly IDLE_THRESHOLD_MS = 600000; // 10 minutes of no updates = completed
  private readonly ERROR_THRESHOLD_MS = 1800000; // 30 minutes of no updates = failed
  private readonly MIN_RUN_TIME_MS = 60000; // Don't auto-complete tasks that ran less than 1 minute

  constructor(sessionsPath: string) {
    super();
    this.sessionsPath = sessionsPath;
  }

  /**
   * Start monitoring sub-agent sessions
   */
  public start() {
    console.log('🤖 Starting SubAgentTaskUpdater...');
    console.log(`   Sessions file: ${this.sessionsPath}`);

    // Poll every 5 seconds to check session status
    this.pollInterval = setInterval(() => {
      this.checkSessionsAndUpdateTasks();
    }, 5000);

    // Initial check
    this.checkSessionsAndUpdateTasks();
  }

  /**
   * Stop monitoring
   */
  public stop() {
    console.log('🤖 Stopping SubAgentTaskUpdater...');
    
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.trackedSessions.clear();
  }

  /**
   * Main loop: check sessions and update tasks
   */
  private async checkSessionsAndUpdateTasks() {
    try {
      // 1. Find all tasks with activeAgent set
      const activeTasks = this.findTasksWithActiveAgent();

      // 2. Read current session states
      const sessions = await this.readSessions();

      // 3. Update tracking for each active task
      for (const task of activeTasks) {
        if (!task.activeAgent?.sessionKey) continue;

        const sessionKey = task.activeAgent.sessionKey;
        const sessionState = this.getSessionState(sessionKey, sessions);

        // Track this session
        const tracked = this.trackedSessions.get(sessionKey);
        
        if (!tracked) {
          // First time seeing this session — record in history
          console.log(`🤖 Now tracking sub-agent session: ${sessionKey} (task: ${task.title})`);
          this.trackedSessions.set(sessionKey, {
            sessionKey,
            taskId: task.id,
            lastSeen: Date.now(),
            state: sessionState.state
          });
          
          // Persist agent info to history store
          const sessionData = sessions[sessionKey];
          agentHistoryService.recordStart({
            name: task.activeAgent?.name || sessionKey.split(':').pop() || 'unknown',
            label: sessionData?.label || task.activeAgent?.name || sessionKey.split(':').pop() || 'unknown',
            sessionKey,
            model: sessionData?.model,
            taskId: task.id,
            taskTitle: task.title,
          }).catch(err => console.error('Failed to record agent start:', err));
          
          continue;
        }

        // Update tracked session state
        const timeSinceLastUpdate = Date.now() - sessionState.updatedAt;
        const taskRunTime = Date.now() - (new Date(task.startedAt || task.updated).getTime());
        tracked.state = sessionState.state;

        // Guard: never auto-complete tasks that just started
        if (taskRunTime < this.MIN_RUN_TIME_MS) {
          continue;
        }

        // Guard: don't complete if sessionKey is "pending" (task spawned but agent not yet created)
        if (sessionKey === 'pending' || sessionKey.includes('pending')) {
          continue;
        }

        // Check if session has completed
        if (sessionState.state === 'completed' && sessionState.confirmedGone) {
          // Session is confirmed removed from sessions.json (not just idle)
          console.log(`✅ Sub-agent session completed: ${sessionKey} (task ran for ${Math.round(taskRunTime/1000)}s)`);
          await this.completeTaskFromSession(task, 'completed');
          this.trackedSessions.delete(sessionKey);
        } else if (sessionState.state === 'error' || timeSinceLastUpdate > this.ERROR_THRESHOLD_MS) {
          // Session errored or went silent for too long (30 min)
          console.log(`❌ Sub-agent session failed/timed out: ${sessionKey} (silent for ${Math.round(timeSinceLastUpdate/1000)}s)`);
          await this.completeTaskFromSession(task, 'stuck');
          this.trackedSessions.delete(sessionKey);
        } else {
          // Update last seen time when session is still active
          tracked.lastSeen = sessionState.updatedAt;
        }
      }

      // 4. Clean up tracking for tasks that no longer have activeAgent
      const activeTaskIds = new Set(activeTasks.map(t => t.id));
      for (const [sessionKey, tracked] of this.trackedSessions.entries()) {
        if (!activeTaskIds.has(tracked.taskId)) {
          console.log(`🧹 Cleaned up tracking for completed task: ${sessionKey}`);
          this.trackedSessions.delete(sessionKey);
        }
      }

    } catch (error) {
      console.error('❌ SubAgentTaskUpdater error:', error);
    }
  }

  /**
   * Find all tasks with activeAgent.sessionKey set
   */
  private findTasksWithActiveAgent(): Task[] {
    const allTasks = taskManager.getAllTasks();
    return allTasks.filter(task => 
      task.activeAgent && 
      task.activeAgent.sessionKey &&
      task.status === 'in-progress'
    );
  }

  /**
   * Read sessions.json
   */
  private async readSessions(): Promise<Record<string, SessionData>> {
    try {
      const data = await readFile(this.sessionsPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Failed to read sessions.json:', error);
      return {};
    }
  }

  /**
   * Get session state from sessions data
   */
  private getSessionState(sessionKey: string, sessions: Record<string, SessionData>): {
    state: 'running' | 'idle' | 'completed' | 'error';
    updatedAt: number;
    confirmedGone: boolean;
  } {
    // Look for session in the sessions object
    const sessionData = sessions[sessionKey];

    if (!sessionData) {
      // Session actually removed from sessions.json → confirmed completed
      return {
        state: 'completed',
        updatedAt: Date.now(),
        confirmedGone: true
      };
    }

    const timeSinceUpdate = Date.now() - sessionData.updatedAt;

    // Determine state based on recency
    if (timeSinceUpdate < 30000) {
      // Active in last 30 seconds
      return { state: 'running', updatedAt: sessionData.updatedAt, confirmedGone: false };
    } else if (timeSinceUpdate < this.IDLE_THRESHOLD_MS) {
      // Idle but still present — could be thinking or waiting for tool
      return { state: 'idle', updatedAt: sessionData.updatedAt, confirmedGone: false };
    } else {
      // Session still in sessions.json but very stale — likely done but not cleaned up
      return { state: 'completed', updatedAt: sessionData.updatedAt, confirmedGone: false };
    }
  }

  /**
   * Update task status when sub-agent completes
   */
  private async completeTaskFromSession(task: Task, status: 'completed' | 'stuck'): Promise<void> {
    try {
      const now = new Date().toISOString();
      const sessionKey = task.activeAgent?.sessionKey;

      // Read token data from sessions.json before session disappears
      let tokenUsage: { input: number; output: number; total: number } | undefined;
      if (sessionKey) {
        try {
          const sessions = await this.readSessions();
          const sessionData = sessions[sessionKey];
          if (sessionData) {
            tokenUsage = {
              input: sessionData.inputTokens || 0,
              output: sessionData.outputTokens || 0,
              total: sessionData.totalTokens || 0,
            };
          }
        } catch { /* best effort */ }
      }

      // Record completion in history
      if (sessionKey) {
        await agentHistoryService.recordCompletion(sessionKey, task.id, {
          outcome: status === 'completed' ? 'completed' : 'stuck',
          tokenUsage,
        }).catch(err => console.error('Failed to record agent completion:', err));
      }

      // Preserve agent info as completedBy instead of clearing it
      await taskManager.updateTask(task.id, {
        status,
        activeAgent: null, // Clear active (no longer running)
        completedBy: task.activeAgent ? { ...task.activeAgent } : undefined,
        completedAt: status === 'completed' ? now : task.completedAt,
        needsReview: status === 'completed', // Flag for review when completed by agent
        notes: task.notes 
          ? `${task.notes}\n\n[Auto] Sub-agent ${status === 'completed' ? 'completed' : 'failed'}: ${now}`
          : `[Auto] Sub-agent ${status === 'completed' ? 'completed' : 'failed'}: ${now}`
      });

      console.log(`✅ Auto-updated task "${task.title}" → ${status} (sub-agent finished)`);

      // Emit event
      this.emit('task:auto-updated', { taskId: task.id, status, sessionKey });

    } catch (error) {
      console.error(`Failed to update task ${task.id}:`, error);
    }
  }

  /**
   * Get current tracking status (for debugging)
   */
  public getTrackingStatus(): TrackedSession[] {
    return Array.from(this.trackedSessions.values());
  }
}

// Singleton instance
export const subAgentTaskUpdater = new SubAgentTaskUpdater(
  process.env.OPENCLAW_SESSIONS_PATH || '/clawdbot/sessions/sessions.json'
);
