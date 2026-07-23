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
import { pool } from '../db/connection';
import { agentTypeStampAliases } from './SessionIngester';
import { taskManagerDB as taskManager, Task } from './TaskManagerDB';
import { agentHistoryService } from './AgentHistoryService';
import { taskTimelineService } from './TaskTimelineService';
import { canonicalizeSessionKey, getSessionKeyAliases } from './GatewayConnector';
import type { GatewayConnector } from './GatewayConnector';
import { transcriptIngester } from './TranscriptIngester';
import { discordThreadService } from './DiscordThreadService';
import { getHermesSessionRuntimeState, getHermesTaskStateDbPath, hermesSessionKeyFor, isProcessAlive, resolveLaunchedHermesSession } from './HermesRuntime';
import { hermesCanonicalAdapter } from './HermesCanonicalAdapter';

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
  private gatewayConnector: GatewayConnector | null = null;
  private trackedSessions: Map<string, TrackedSession> = new Map();
  private recentlyEndedSessions: Map<string, number> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private checkInFlight = false;
  private readonly IDLE_THRESHOLD_MS = 600000; // 10 minutes of no updates = completed
  private readonly ERROR_THRESHOLD_MS = 1800000; // 30 minutes of no updates = failed
  private readonly MIN_RUN_TIME_MS = 60000; // Don't auto-complete tasks that ran less than 1 minute
  private readonly ENDED_DEDUP_TTL_MS = 300000; // Suppress duplicate completion handling for 5 minutes

  constructor(sessionsPath: string) {
    super();
    this.sessionsPath = sessionsPath;
  }

  /**
   * Persist canonical Hermes evidence before advancing task lifecycle state.
   * Adapter failure is isolated from legacy reconciliation, but is recorded by
   * the adapter health ledger rather than leaving canonical ingestion unused.
   */
  private async ingestHermesAttempt(sessionKey: string): Promise<void> {
    const match = sessionKey.match(/(?:hermes:[^:]+:|agent:main:local:dm:)([A-Za-z0-9_-]+)$/);
    const sessionId = match?.[1] || null;
    if (!sessionId) return;
    try {
      await hermesCanonicalAdapter.ingestSessionId(
        sessionId,
        new Date(),
        getHermesTaskStateDbPath(),
      );
    } catch (error) {
      console.warn(`Canonical Hermes ingestion failed for ${sessionKey}:`, (error as Error).message);
    }
  }

  /**
   * Wire in GatewayConnector so synthetic session entries can be updated on completion.
   */
  public setGatewayConnector(connector: GatewayConnector): void {
    this.gatewayConnector = connector;
  }

  /**
   * Start monitoring tracked task sessions
   */
  public start() {
    console.log('🤖 Starting tracked-task session updater...');
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
    if (this.checkInFlight) {
      return;
    }

    this.checkInFlight = true;

    try {
      // 1. Find all tasks with activeAgent set (from PostgreSQL via TaskManagerDB)
      const activeTasks = await this.findTasksWithActiveAgent();

      // 2. Read current session states
      const sessions = await this.readSessions();
      const now = Date.now();

      for (const [endedSessionKey, endedAt] of this.recentlyEndedSessions.entries()) {
        if (now - endedAt > this.ENDED_DEDUP_TTL_MS) {
          this.recentlyEndedSessions.delete(endedSessionKey);
        }
      }

      // 3. Update tracking for each active task
      for (const task of activeTasks) {
        const sessionKey = task.acpSessionKey || task.activeAgent?.sessionKey;
        if (!sessionKey) continue;
        // 'pending' is a shared provisional sentinel, not a session key. All
        // internal map bookkeeping for provisional tasks must be task-scoped so
        // one crashed provisional spawn cannot gate every other pending task.
        const trackingKey = sessionKey === 'pending' ? `pending:${task.id}` : sessionKey;
        if (this.recentlyEndedSessions.has(trackingKey)) continue;

        const harness = (task as any).executionProfile?.harness || task.activeAgent?.harness || 'openclaw';
        if (harness === 'hermes') {
          // Bind step: a provisional 'pending' key means spawn-agent returned
          // before Hermes registered its sessions row. Resolve the real session
          // id here, BEFORE any completion checks, so a slow-starting turn is
          // never mis-reaped.
          if (sessionKey === 'pending' && task.activeAgent?.sourceTag) {
            const spawnedAtUnix = typeof (task.activeAgent as any).spawnedAtUnix === 'number'
              ? (task.activeAgent as any).spawnedAtUnix as number
              : Math.floor(new Date(task.startedAt || task.updated).getTime() / 1000) - 2;
            try {
              const row = await resolveLaunchedHermesSession(task.activeAgent.sourceTag, spawnedAtUnix, task.activeAgent.logPath || '');
              if (row) {
                const realSessionKey = hermesSessionKeyFor(row);
                console.log(`🔗 Bound provisional Hermes session for task ${task.id}: ${realSessionKey}`);
                await taskManager.updateTask(task.id, {
                  activeAgent: { ...task.activeAgent, sessionKey: realSessionKey },
                  sessionRefs: Array.from(new Set([...(task.sessionRefs || []), realSessionKey])),
                  ...((task as any).executionMode === 'interactive' ? { acpSessionKey: realSessionKey } : {}),
                });
                await this.ingestHermesAttempt(realSessionKey);

                // Persona analytics: stamp the task's agentTypeId onto the
                // now-known real session row (best-effort; the row may also be
                // created later, in which case the ingester subquery stamps it).
                const bindAgentTypeId = (task as any).agentTypeId as string | null | undefined;
                if (bindAgentTypeId) {
                  pool.query(
                    `UPDATE sessions
                        SET agent_type_id = $1, updated_at = NOW()
                      WHERE session_key = ANY($2::text[])
                        AND agent_type_id IS NULL`,
                    [bindAgentTypeId, agentTypeStampAliases(realSessionKey)]
                  ).catch(err => console.warn(`Failed to stamp agent type on bound session ${realSessionKey}:`, err));
                }

                // Rebind any Discord thread tracking the provisional key so
                // stream mirroring and thread steering target the real session.
                if (typeof (discordThreadService as any).rebindTrackedSession === 'function') {
                  try {
                    (discordThreadService as any).rebindTrackedSession(task.id, realSessionKey);
                  } catch (rebindErr) {
                    console.warn(`Failed to rebind Discord thread session for task ${task.id}:`, rebindErr);
                  }
                }

                // Give the provisional 'session.spawned' timeline event a
                // resolvable follow-up.
                await taskTimelineService.recordEvent({
                  taskId: task.id,
                  eventType: 'session.linked',
                  title: 'Linked Hermes session',
                  description: `Provisional spawn resolved to Hermes session ${row.id}.`,
                  sessionKey: realSessionKey,
                  actor: task.activeAgent?.name || null,
                  harness: 'hermes',
                  metadata: {
                    realSessionKey,
                    sourceTag: task.activeAgent.sourceTag,
                    provisionalSince: spawnedAtUnix,
                  },
                }).catch(err => console.warn('Failed to record session.linked timeline event:', err));

                continue;
              }
            } catch (bindErr) {
              console.warn(`Failed to bind provisional Hermes session for task ${task.id}:`, bindErr);
            }
            if (isProcessAlive(task.activeAgent?.pid)) {
              // Worker is alive but the session row is not visible yet — still starting.
              continue;
            }
            // PID is dead and no session row could be bound: fall through so the
            // dead-session path below reaps the task to stuck.
          }

          const hermesState = await getHermesSessionRuntimeState(sessionKey, task.activeAgent?.pid);
          const tracked = this.trackedSessions.get(trackingKey);
          const runtimeState = hermesState.state;
          const statusTimestamp = hermesState.updatedAt ? new Date(hermesState.updatedAt).getTime() : now;
          const taskRunTime = now - (new Date(task.startedAt || task.updated).getTime());

          if (!tracked) {
            this.trackedSessions.set(trackingKey, {
              sessionKey: trackingKey,
              taskId: task.id,
              lastSeen: statusTimestamp,
              state: runtimeState === 'completed' ? 'completed' : runtimeState === 'failed' ? 'error' : (runtimeState === 'idle' ? 'idle' : 'running'),
            });

            agentHistoryService.recordStart({
              name: task.activeAgent?.name || 'hermes-agent',
              label: hermesState.label || task.title,
              sessionKey: trackingKey,
              model: hermesState.model || undefined,
              taskId: task.id,
              taskTitle: task.title,
            }).catch(err => console.error('Failed to record Hermes agent start:', err));
          } else {
            tracked.lastSeen = statusTimestamp;
            tracked.state = runtimeState === 'completed' ? 'completed' : runtimeState === 'failed' ? 'error' : (runtimeState === 'idle' ? 'idle' : 'running');
          }

          if (runtimeState === 'completed' || (!hermesState.pidAlive && runtimeState === 'idle' && (now - statusTimestamp) > this.IDLE_THRESHOLD_MS)) {
            await this.ingestHermesAttempt(sessionKey);
            if (task.status === 'review') {
              console.log(`🔍 Hermes session ended, task already in review: ${sessionKey} — preserving review status`);
              await taskManager.updateTask(task.id, { activeAgent: null, acpSessionKey: null });
            } else if (taskRunTime >= this.MIN_RUN_TIME_MS) {
              console.log(`🔍 Hermes session ended: ${sessionKey} → moving task to review`);
              await this.completeTaskFromSession(task, 'review');
            }
            this.trackedSessions.delete(trackingKey);
            this.recentlyEndedSessions.set(trackingKey, now);
            continue;
          }

          if ((runtimeState === 'failed' || (runtimeState === 'none' && !hermesState.pidAlive)) && taskRunTime >= this.MIN_RUN_TIME_MS) {
            await this.ingestHermesAttempt(sessionKey);
            console.log(`❌ Hermes session failed or disappeared: ${sessionKey}`);
            await this.completeTaskFromSession(task, 'stuck');
            this.trackedSessions.delete(trackingKey);
            this.recentlyEndedSessions.set(trackingKey, now);
            continue;
          }

          continue;
        }

        // ── Interactive sessions: different completion semantics ─────────────
        // Interactive sessions are persistent between turns. Temporary absence
        // from live state is not enough to mark them done.
        const isInteractive = (task as any).executionMode === 'interactive';
        if (isInteractive) {
          const resolvedSessionKey = canonicalizeSessionKey(sessionKey);
          const liveSession = this.gatewayConnector?.getSessionState(resolvedSessionKey);
          const sessionState = this.getSessionState(resolvedSessionKey, sessions);
          const tracked = this.trackedSessions.get(trackingKey);

          if (liveSession) {
            const lastSeen = liveSession.lastActivity || now;
            if (!tracked) {
              this.trackedSessions.set(trackingKey, {
                sessionKey: trackingKey,
                taskId: task.id,
                lastSeen,
                state: liveSession.state === 'idle' ? 'idle' : 'running',
              });
            } else {
              tracked.lastSeen = lastSeen;
              tracked.state = liveSession.state === 'idle' ? 'idle' : 'running';
            }

            if (now - lastSeen > this.ERROR_THRESHOLD_MS) {
              console.log(`❌ Interactive session timed out: ${resolvedSessionKey}`);
              await this.completeTaskFromSession(task, 'stuck');
              this.trackedSessions.delete(trackingKey);
              this.recentlyEndedSessions.set(trackingKey, now);
            }
            continue;
          }

          if (!sessionState.confirmedGone) {
            const lastSeen = sessionState.updatedAt || now;
            if (!tracked) {
              this.trackedSessions.set(trackingKey, {
                sessionKey: trackingKey,
                taskId: task.id,
                lastSeen,
                state: sessionState.state,
              });
            } else {
              tracked.lastSeen = lastSeen;
              tracked.state = sessionState.state;
            }
            continue;
          }

          const timeSinceStart = now - new Date(task.startedAt || task.updated).getTime();
          if (timeSinceStart > this.MIN_RUN_TIME_MS) {
            console.log(`🔗 Interactive session ended: ${resolvedSessionKey} (task: ${task.title}) → moving to review`);
            await this.completeTaskFromSession(task, 'review');
            this.trackedSessions.delete(trackingKey);
            this.recentlyEndedSessions.set(trackingKey, now);
          }
          continue; // Skip standard cron session processing
        }
        const sessionState = this.getSessionState(sessionKey, sessions);

        // Track this session
        const tracked = this.trackedSessions.get(trackingKey);

        if (!tracked) {
          // First time seeing this session — record in history
          console.log(`🤖 Now tracking sub-agent session: ${sessionKey} (task: ${task.title})`);
          this.trackedSessions.set(trackingKey, {
            sessionKey: trackingKey,
            taskId: task.id,
            lastSeen: Date.now(),
            state: sessionState.state
          });

          // Persist agent info to history store
          const sessionData = sessions[canonicalizeSessionKey(sessionKey)] || sessions[sessionKey];
          agentHistoryService.recordStart({
            name: task.activeAgent?.name || sessionKey.split(':').pop() || 'unknown',
            label: sessionData?.label || task.activeAgent?.name || sessionKey.split(':').pop() || 'unknown',
            sessionKey: trackingKey,
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
          // If the agent already moved the task to 'review', respect that —
          // just clear the activeAgent and let the orchestrator handle it.
          if (task.status === 'review') {
            console.log(`🔍 Tracked agent session ended, task already in review: ${sessionKey} — preserving review status`);
            await taskManager.updateTask(task.id, { activeAgent: null, acpSessionKey: null });
            this.trackedSessions.delete(trackingKey);
            this.recentlyEndedSessions.set(trackingKey, Date.now());
            continue;
          }
          // Session is confirmed removed from sessions.json (not just idle)
          // Check if agent actually made subtask progress before promoting to review
          const subtasks = task.subtasks || [];
          const hasSubtasks = subtasks.length > 0;
          const completedOrReview = subtasks.filter((s: any) => 
            s.status === 'completed' || s.status === 'approved' || s.status === 'review' || s.status === 'skipped'
          ).length;
          
          if (hasSubtasks && completedOrReview === 0) {
            // Agent finished without touching any subtasks — don't promote to review
            console.log(`⚠️ Tracked agent session ended: ${sessionKey} (task ran for ${Math.round(taskRunTime/1000)}s) but 0/${subtasks.length} subtasks progressed → keeping in-progress`);
            // Just clear the agent tracking, don't change task status
            await taskManager.updateTask(task.id, {
              activeAgent: null,
              acpSessionKey: null,
              notes: task.notes 
                ? `${task.notes}\n\n[Auto] Sub-agent ended with no subtask progress — staying in-progress: ${new Date().toISOString()}`
                : `[Auto] Sub-agent ended with no subtask progress — staying in-progress: ${new Date().toISOString()}`
            });
          } else {
            console.log(`🔍 Tracked agent session ended: ${sessionKey} (task ran for ${Math.round(taskRunTime/1000)}s, ${completedOrReview}/${subtasks.length} subtasks done) → moving to review`);
            await this.completeTaskFromSession(task, 'review');
          }
          this.trackedSessions.delete(trackingKey);
          this.recentlyEndedSessions.set(trackingKey, Date.now());
        } else if (sessionState.state === 'error' || timeSinceLastUpdate > this.ERROR_THRESHOLD_MS) {
          // Session errored or went silent for too long (30 min)
          console.log(`❌ Sub-agent session failed/timed out: ${sessionKey} (silent for ${Math.round(timeSinceLastUpdate/1000)}s)`);
          await this.completeTaskFromSession(task, 'stuck');
          this.trackedSessions.delete(trackingKey);
          this.recentlyEndedSessions.set(trackingKey, Date.now());
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
    } finally {
      this.checkInFlight = false;
    }
  }

  /**
   * Find all tasks with activeAgent.sessionKey set (queries PostgreSQL via TaskManagerDB)
   */
  private async findTasksWithActiveAgent(): Promise<Task[]> {
    const allTasks = await taskManager.getAllTasks();
    return allTasks.filter(task => {
      // Include tasks with standard activeAgent OR interactive tasks with acpSessionKey
      const hasActiveAgent = task.activeAgent && task.activeAgent.sessionKey;
      const hasAcpSession = (task as any).acpSessionKey;
      return (hasActiveAgent || hasAcpSession) &&
        (task.status === 'in-progress' || task.status === 'review');
    });
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
    // Look for session using all known aliases so interactive tracked tasks
    // with legacy cron:<jobId> keys resolve to the real agent:main:cron:<jobId>
    // session stored by OpenClaw.
    const aliases = getSessionKeyAliases(sessionKey);
    let sessionData: SessionData | undefined;
    for (const alias of aliases) {
      sessionData = sessions[alias];
      if (sessionData) break;
    }

    if (!sessionData) {
      // Session actually removed from sessions.json → confirmed completed
      return {
        state: 'completed',
        updatedAt: Date.now(),
        confirmedGone: true
      };
    }

    const updatedAt = typeof sessionData.updatedAt === 'number' ? sessionData.updatedAt : Date.now();
    const timeSinceUpdate = Date.now() - updatedAt;

    // Determine state based on recency
    if (timeSinceUpdate < 30000) {
      // Active in last 30 seconds
      return { state: 'running', updatedAt, confirmedGone: false };
    } else if (timeSinceUpdate < this.IDLE_THRESHOLD_MS) {
      // Idle but still present — could be thinking or waiting for tool
      return { state: 'idle', updatedAt, confirmedGone: false };
    } else {
      // Session still in sessions.json but very stale — likely done but not cleaned up
      return { state: 'completed', updatedAt, confirmedGone: false };
    }
  }

  /**
   * Update task status when sub-agent completes
   */
  private async completeTaskFromSession(task: Task, status: 'review' | 'stuck'): Promise<void> {
    try {
      const now = new Date().toISOString();
      const rawSessionKey = task.acpSessionKey || task.activeAgent?.sessionKey;
      // 'pending' is a shared provisional sentinel and must never be persisted
      // or recorded as a real session key. Use a task-scoped pseudo key for
      // bookkeeping records on the reap path instead.
      const isProvisional = rawSessionKey === 'pending';
      const pendingScopedKey = `pending:${task.id}`;
      const sessionKey = isProvisional ? undefined : rawSessionKey;
      const harness = (task as any).executionProfile?.harness || task.activeAgent?.harness || 'openclaw';
      let resolvedSessionKey = sessionKey ? canonicalizeSessionKey(sessionKey) : undefined;
      const completedBy = task.activeAgent ? { ...task.activeAgent } : undefined;
      if (completedBy && isProvisional) {
        // Never leave the bare 'pending' sentinel on the completion record.
        completedBy.sessionKey = task.activeAgent?.sourceTag || pendingScopedKey;
      }

      if (harness === 'hermes' && (resolvedSessionKey || task.activeAgent?.pid)) {
        try {
          const hermesState = await getHermesSessionRuntimeState(resolvedSessionKey, task.activeAgent?.pid);
          if (hermesState.sessionKey && hermesState.sessionKey !== 'pending') {
            resolvedSessionKey = hermesState.sessionKey;
            if (completedBy) {
              completedBy.sessionKey = hermesState.sessionKey;
            }
          }
        } catch (error) {
          console.warn('Failed to resolve canonical Hermes session key before completion:', error);
        }
      }

      // Read session metadata before the session disappears.
      let tokenUsage: { input: number; output: number; total: number } | undefined;
      let transcriptPath: string | undefined;
      if (resolvedSessionKey) {
        try {
          const sessions = await this.readSessions();
          const sessionData = sessions[resolvedSessionKey] || (sessionKey ? sessions[sessionKey] : undefined);
          if (sessionData) {
            tokenUsage = {
              input: sessionData.inputTokens || 0,
              output: sessionData.outputTokens || 0,
              total: sessionData.totalTokens || 0,
            };
            if (typeof sessionData.sessionFile === 'string' && sessionData.sessionFile.trim()) {
              transcriptPath = sessionData.sessionFile;
            } else if (sessionData.sessionId) {
              transcriptPath = `${sessionData.sessionId}.jsonl`;
            }
          }
        } catch { /* best effort */ }
      }

      // Ingest transcript BEFORE the session disappears from sessions.json
      if (resolvedSessionKey) {
        try {
          await transcriptIngester.ingestCompleted(resolvedSessionKey, transcriptPath);
        } catch (err) {
          console.warn('TranscriptIngester: pre-cleanup ingest failed:', err);
        }
      }

      // Record completion in history. Reaped provisional tasks use the
      // task-scoped pseudo key (matching recordStart in the tracking loop).
      const historyKey = resolvedSessionKey || (isProvisional ? pendingScopedKey : undefined);
      if (historyKey) {
        await agentHistoryService.recordCompletion(historyKey, task.id, {
          outcome: status === 'review' ? 'completed' : 'stuck',
          tokenUsage,
        }).catch(err => console.error('Failed to record agent completion:', err));
      }

      // Preserve agent info as completedBy instead of clearing it
      await taskManager.updateTask(task.id, {
        status,
        activeAgent: null, // Clear active (no longer running)
        acpSessionKey: null,
        completedBy: completedBy,
        // Align with mergeSessionRefs in routes/tasks.ts: the literal 'pending'
        // sentinel must never end up in persisted sessionRefs.
        sessionRefs: Array.from(new Set([...(task.sessionRefs || []), ...(resolvedSessionKey ? [resolvedSessionKey] : []), ...(sessionKey ? [sessionKey] : [])])).filter((key) => Boolean(key) && key !== 'pending'),
        needsReview: status === 'review', // Flag for orchestrator review
        notes: task.notes 
          ? `${task.notes}\n\n[Auto] Tracked agent session ended → ${status}: ${now}`
          : `[Auto] Tracked agent session ended → ${status}: ${now}`
      });

      await taskTimelineService.recordEvent({
        taskId: task.id,
        eventType: 'session.finished',
        title: status === 'review' ? 'Session finished and handed off for review' : 'Session finished in stuck state',
        description: task.activeAgent?.name
          ? `${task.activeAgent.name} finished this run.`
          : 'Tracked session finished for this task.',
        sessionKey: resolvedSessionKey || sessionKey || null,
        actor: task.activeAgent?.name || null,
        harness: task.activeAgent?.harness || null,
        metadata: {
          outcome: status,
          tokenUsage,
        },
      });

      console.log(`🔍 Auto-updated task "${task.title}" → ${status} (tracked agent session ended)`);

      // Phase 3: Notify Discord thread of lifecycle change
      if (task.discordThreadId) {
        const kind = status === 'review' ? 'completed' : status === 'stuck' ? 'stuck' : 'failed';
        const subtasks = task.subtasks || [];
        const done = subtasks.filter((s: any) => s.status === 'completed' || s.status === 'review' || s.status === 'skipped').length;
        const details = `Subtask progress: ${done}/${subtasks.length}`;
        discordThreadService.postLifecycleMessage(task.id, kind, details)
          .catch(err => console.warn(`DiscordThreadService lifecycle notify failed:`, err));
      }

      // Emit event
      this.emit('task:auto-updated', { taskId: task.id, status, sessionKey: resolvedSessionKey || sessionKey });

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
  process.env.OPENCLAW_SESSIONS_PATH || process.env.CLAWDBOT_SESSIONS_PATH || '/clawdbot/sessions/sessions.json'
);
