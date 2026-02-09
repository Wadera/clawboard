/**
 * WorkMonitor - Phase 4 Step 3
 * 
 * Watches Clawdbot session transcripts in real-time and:
 * 1. Detects what work is happening (tool calls, file writes, commits)
 * 2. Matches activity to existing tasks or creates new ones
 * 3. Auto-checks subtasks as work progresses
 * 4. Auto-moves tasks between columns (in-progress → completed, → stuck)
 * 
 * This is the "brain" that connects live AI activity to the task board.
 */

import { EventEmitter } from 'events';
import { watch, FSWatcher, createReadStream } from 'fs';
import { readFile, stat } from 'fs/promises';
import { createInterface } from 'readline';
import path from 'path';
import { taskManager, Task, Subtask } from './TaskManager';
import { TaskDetector, WorkEvent } from './taskDetector';
import { WebSocketService } from './websocket';

export interface WorkMonitorConfig {
  transcriptsDir: string;
  sessionsPath: string;
  wsService: WebSocketService;
  /** How often to scan transcripts (ms) */
  pollIntervalMs?: number;
  /** Minimum confidence to auto-match a task (0-1) */
  matchThreshold?: number;
  /** Enable auto-task creation when no match found */
  autoCreateTasks?: boolean;
}

interface TranscriptState {
  /** Last byte offset we read to */
  lastOffset: number;
  /** Last byte position in file */
  lastByteOffset: number;
  /** Last modified time */
  lastMtime: number;
  /** Session key */
  sessionKey: string;
}

interface TranscriptMessage {
  type: string;
  message: {
    role: string;
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      id?: string;
      input?: any;
      [key: string]: any;
    }>;
    [key: string]: any;
  };
  timestamp: string;
}

export class WorkMonitor extends EventEmitter {
  private config: WorkMonitorConfig;
  private detector: TaskDetector;
  private transcriptStates: Map<string, TranscriptState> = new Map();
  private watcher: FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(config: WorkMonitorConfig) {
    super();
    this.config = {
      pollIntervalMs: 5000,
      matchThreshold: 0.4,
      autoCreateTasks: false, // Conservative default — don't spam tasks
      ...config,
    };
    this.detector = new TaskDetector();
  }

  /**
   * Start monitoring transcripts
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    console.log('[WorkMonitor] Starting...');
    console.log(`  Transcripts: ${this.config.transcriptsDir}`);
    console.log(`  Poll interval: ${this.config.pollIntervalMs}ms`);
    console.log(`  Match threshold: ${this.config.matchThreshold}`);
    console.log(`  Auto-create tasks: ${this.config.autoCreateTasks}`);

    // Watch for new/changed transcript files
    try {
      this.watcher = watch(
        this.config.transcriptsDir,
        { persistent: true, recursive: false },
        (_event, filename) => {
          if (filename && filename.endsWith('.jsonl') && !filename.endsWith('.lock')) {
            this.processTranscript(filename);
          }
        }
      );
    } catch (err) {
      console.error('[WorkMonitor] Failed to watch transcripts dir:', err);
    }

    // Poll on interval as backup (file watchers can miss events)
    this.pollTimer = setInterval(() => this.pollTranscripts(), this.config.pollIntervalMs!);

    // Initial scan
    this.pollTranscripts();
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    this.running = false;

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    console.log('[WorkMonitor] Stopped');
  }

  /**
   * Poll all transcript files for changes
   */
  private async pollTranscripts(): Promise<void> {
    try {
      // Find the main session transcript
      const sessionsData = await readFile(this.config.sessionsPath, 'utf-8');
      const sessions: Record<string, any> = JSON.parse(sessionsData);

      for (const [key, session] of Object.entries(sessions)) {
        if (!session.sessionId) continue;
        const filename = `${session.sessionId}.jsonl`;
        await this.processTranscript(filename, key);
      }
    } catch (err) {
      // Silently ignore — sessions file might be temporarily unavailable
    }
  }

  /**
   * Process new messages in a transcript file
   * Uses byte-offset streaming to avoid reading entire files into memory
   */
  private async processTranscript(filename: string, sessionKey?: string): Promise<void> {
    const filePath = path.join(this.config.transcriptsDir, filename);

    try {
      const fileStat = await stat(filePath);
      const state = this.transcriptStates.get(filename);

      // Skip if not modified
      if (state && fileStat.mtimeMs <= state.lastMtime) return;

      const key = sessionKey || filename.replace('.jsonl', '');
      const startByte = state ? state.lastByteOffset : Math.max(0, fileStat.size - 8192); // On first run, only read last ~8KB
      const events: WorkEvent[] = [];

      if (startByte >= fileStat.size) {
        // File hasn't grown
        this.transcriptStates.set(filename, {
          lastOffset: state?.lastOffset ?? 0,
          lastByteOffset: fileStat.size,
          lastMtime: fileStat.mtimeMs,
          sessionKey: key,
        });
        return;
      }

      // Stream only the new portion of the file
      const stream = createReadStream(filePath, {
        start: startByte,
        encoding: 'utf-8',
      });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      let lineCount = 0;
      let firstLine = true;
      for await (const line of rl) {
        // First line might be partial if we started mid-file
        if (firstLine && startByte > 0) {
          firstLine = false;
          continue; // Skip potentially truncated first line
        }
        firstLine = false;
        if (!line.trim()) continue;
        lineCount++;

        try {
          const msg: TranscriptMessage = JSON.parse(line);
          const detected = this.detector.detectEvents(msg);
          events.push(...detected);
        } catch {
          // Skip malformed lines
        }
      }

      // Update state with new byte offset
      this.transcriptStates.set(filename, {
        lastOffset: (state?.lastOffset ?? 0) + lineCount,
        lastByteOffset: fileStat.size,
        lastMtime: fileStat.mtimeMs,
        sessionKey: key,
      });

      // Process detected events
      if (events.length > 0) {
        await this.processWorkEvents(events, key);
      }
    } catch (err) {
      // File might not exist yet or be temporarily locked
    }
  }

  /**
   * Process detected work events — match to tasks, update subtasks, move columns
   */
  private async processWorkEvents(events: WorkEvent[], sessionKey: string): Promise<void> {
    const allTasks = taskManager.getAllTasks();
    const activeTasks = allTasks.filter(t => 
      t.status === 'in-progress' || t.status === 'todo'
    );

    for (const event of events) {
      console.log(`[WorkMonitor] Event: ${event.type} — ${event.description}`);

      // 1. Try to match event to an existing task's subtask
      const subtaskMatch = this.matchEventToSubtask(event, activeTasks);
      if (subtaskMatch) {
        await this.checkOffSubtask(subtaskMatch.task, subtaskMatch.subtask, sessionKey);
        continue;
      }

      // 2. Try to match event to an existing task (general match)
      const taskMatch = this.matchEventToTask(event, activeTasks);
      if (taskMatch) {
        // Add session ref if not already there
        await this.addSessionRef(taskMatch, sessionKey);
        
        // If task is in todo and we're doing work on it, move to in-progress
        if (taskMatch.status === 'todo') {
          await taskManager.updateTask(taskMatch.id, {
            status: 'in-progress',
            startedAt: new Date().toISOString(),
          });
          console.log(`[WorkMonitor] Auto-moved to in-progress: ${taskMatch.title}`);
        }
        continue;
      }

      // 3. Handle error events — move matching in-progress tasks to stuck
      if (event.type === 'error') {
        const inProgressTasks = allTasks.filter(t => t.status === 'in-progress');
        for (const task of inProgressTasks) {
          if (this.isEventRelatedToTask(event, task)) {
            await taskManager.updateTask(task.id, {
              status: 'stuck',
              blockedReason: `Error detected: ${event.description}`,
            });
            console.log(`[WorkMonitor] Auto-moved to stuck: ${task.title}`);
            
            this.config.wsService.broadcast({
              type: 'work:task-stuck',
              taskId: task.id,
              reason: event.description,
              timestamp: Date.now(),
            });
            break;
          }
        }
      }
    }
  }

  /**
   * Match a work event to a specific subtask
   */
  private matchEventToSubtask(
    event: WorkEvent,
    tasks: Task[]
  ): { task: Task; subtask: Subtask } | null {
    const eventText = `${event.description} ${event.details?.join(' ') || ''}`.toLowerCase();

    for (const task of tasks) {
      if (!task.subtasks || task.subtasks.length === 0) continue;

      for (const subtask of task.subtasks) {
        if (subtask.completed) continue;

        const subtaskText = subtask.text.toLowerCase();
        const score = this.textSimilarity(eventText, subtaskText);

        if (score >= (this.config.matchThreshold! + 0.1)) {
          return { task, subtask };
        }
      }
    }

    return null;
  }

  /**
   * Match a work event to a task
   */
  private matchEventToTask(event: WorkEvent, tasks: Task[]): Task | null {
    const eventText = `${event.description} ${event.details?.join(' ') || ''}`.toLowerCase();
    let bestMatch: Task | null = null;
    let bestScore = 0;

    for (const task of tasks) {
      const taskText = `${task.title} ${task.description} ${task.tags.join(' ')} ${task.project || ''}`.toLowerCase();
      const score = this.textSimilarity(eventText, taskText);

      if (score > bestScore && score >= this.config.matchThreshold!) {
        bestScore = score;
        bestMatch = task;
      }
    }

    return bestMatch;
  }

  /**
   * Check if an event is related to a task (looser matching for error detection)
   */
  private isEventRelatedToTask(event: WorkEvent, task: Task): boolean {
    const eventText = `${event.description} ${event.details?.join(' ') || ''}`.toLowerCase();
    const taskText = `${task.title} ${task.project || ''}`.toLowerCase();
    return this.textSimilarity(eventText, taskText) >= 0.2;
  }

  /**
   * Simple text similarity score (0-1) based on shared words
   */
  private textSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let shared = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) shared++;
    }

    // Jaccard-like: shared / smaller set size
    return shared / Math.min(wordsA.size, wordsB.size);
  }

  /**
   * Check off a subtask and check if task is complete
   */
  private async checkOffSubtask(task: Task, subtask: Subtask, sessionKey: string): Promise<void> {
    const updatedSubtasks = task.subtasks.map(s => {
      if (s.id === subtask.id) {
        return {
          ...s,
          completed: true,
          completedAt: new Date().toISOString(),
          sessionRef: sessionKey,
        };
      }
      return s;
    });

    await taskManager.updateTask(task.id, { subtasks: updatedSubtasks });
    console.log(`[WorkMonitor] ✅ Checked off subtask: "${subtask.text}" on "${task.title}"`);

    // Broadcast subtask completion
    this.config.wsService.broadcast({
      type: 'work:subtask-completed',
      taskId: task.id,
      subtaskId: subtask.id,
      subtaskText: subtask.text,
      timestamp: Date.now(),
    });

    // Check if ALL subtasks are now complete
    const allComplete = updatedSubtasks.every(s => s.completed);
    if (allComplete && updatedSubtasks.length > 0) {
      await taskManager.updateTask(task.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      console.log(`[WorkMonitor] 🎉 Auto-completed task: "${task.title}"`);

      this.config.wsService.broadcast({
        type: 'work:task-completed',
        taskId: task.id,
        taskTitle: task.title,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Add session reference to a task
   */
  private async addSessionRef(task: Task, sessionKey: string): Promise<void> {
    if (task.sessionRefs.includes(sessionKey)) return;

    const updatedRefs = [...task.sessionRefs, sessionKey];
    await taskManager.updateTask(task.id, { sessionRefs: updatedRefs });
  }
}
