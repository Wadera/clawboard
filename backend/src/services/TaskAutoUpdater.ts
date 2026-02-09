/**
 * TaskAutoUpdater - Automatically update task status based on bot's actual work
 * 
 * This service monitors:
 * 1. Session activity (what the bot is currently doing)
 * 2. File edits in workspace
 * 3. Tool usage patterns
 * 
 * And automatically:
 * - Moves tasks to "in-progress" when work starts
 * - Moves tasks to "done" when work completes
 * - Detects task context from commit messages, file paths, etc.
 */

import { EventEmitter } from 'events';
import { taskManager, Task } from './TaskManager';

export interface WorkContext {
  activity: string;
  files: string[];
  tools: string[];
  keywords: string[];
}

export class TaskAutoUpdater extends EventEmitter {
  private currentContext: WorkContext = {
    activity: '',
    files: [],
    tools: [],
    keywords: []
  };

  private currentTaskId: string | null = null;

  /**
   * Update current work context from session monitoring
   */
  updateContext(activity: string, details?: { files?: string[]; tools?: string[] }): void {
    this.currentContext = {
      activity,
      files: details?.files || [],
      tools: details?.tools || [],
      keywords: this.extractKeywords(activity)
    };

    // Try to match context to a task
    this.matchTaskFromContext();
  }

  /**
   * Extract keywords from activity description
   */
  private extractKeywords(activity: string): string[] {
    const text = activity.toLowerCase();
    const keywords: string[] = [];

    // Common work patterns
    const patterns = [
      /working on ([a-z-]+)/i,
      /building ([a-z-]+)/i,
      /implementing ([a-z-]+)/i,
      /fixing ([a-z-]+)/i,
      /creating ([a-z-]+)/i,
      /updating ([a-z-]+)/i,
      /phase (\d+)/i,
      /v(\d+\.\d+\.\d+)/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        keywords.push(match[1]);
      }
    }

    // Extract hashtags
    const hashtags = text.match(/#([a-z0-9-]+)/gi);
    if (hashtags) {
      keywords.push(...hashtags.map(t => t.slice(1)));
    }

    return keywords;
  }

  /**
   * Match current work context to a task
   */
  private async matchTaskFromContext(): Promise<void> {
    try {
      const allTasks = taskManager.getAllTasks();
      
      // Skip if no active work
      if (!this.currentContext.activity || this.currentContext.activity === 'idle') {
        // If we had a task in progress, consider completing it
        if (this.currentTaskId) {
          console.log('[TaskAutoUpdater] Activity idle, keeping current task in-progress');
        }
        return;
      }

      // Find best matching task
      let bestMatch: Task | null = null;
      let bestScore = 0;

      for (const task of allTasks) {
        // Skip completed/archived/ideas tasks — only match todo and in-progress
        if (task.status === 'completed' || task.status === 'archived' || task.status === 'ideas') continue;

        const score = this.scoreTaskMatch(task);
        
        if (score > bestScore) {
          bestScore = score;
          bestMatch = task;
        }
      }

      // If we found a good match (score > 2), auto-update
      if (bestMatch && bestScore >= 2) {
        await this.setCurrentTask(bestMatch.id);
      }
    } catch (err: any) {
      console.error('[TaskAutoUpdater] Error in matchTaskFromContext:', err.message);
      // Don't throw - this is a background service, errors should not crash the server
    }
  }

  /**
   * Score how well a task matches current context
   */
  private scoreTaskMatch(task: Task): number {
    let score = 0;
    const activity = this.currentContext.activity.toLowerCase();
    const taskText = `${task.title} ${task.description} ${task.tags.join(' ')}`.toLowerCase();

    // Check if task title/description mentioned in activity
    const taskWords = task.title.toLowerCase().split(/\s+/);
    for (const word of taskWords) {
      if (word.length > 3 && activity.includes(word)) {
        score += 2;
      }
    }

    // Check keyword matches
    for (const keyword of this.currentContext.keywords) {
      if (taskText.includes(keyword)) {
        score += 1;
      }
    }

    // Check tag matches
    for (const tag of task.tags) {
      if (activity.includes(tag.toLowerCase())) {
        score += 1.5;
      }
    }

    // Check project match
    if (task.project && activity.includes(task.project.toLowerCase())) {
      score += 1;
    }

    return score;
  }

  /**
   * Manually set current task (called by external services)
   */
  async setCurrentTask(taskId: string | null): Promise<void> {
    try {
      if (this.currentTaskId === taskId) return;

      // Move previous task out of in-progress (if any)
      if (this.currentTaskId) {
        const prevTask = taskManager.getTask(this.currentTaskId);
        if (prevTask && prevTask.status === 'in-progress') {
          // Move back to todo (unless it should be done)
          await taskManager.updateTask(this.currentTaskId, { 
            status: 'todo',
            notes: prevTask.notes + `\n[Auto] Paused: ${new Date().toISOString()}`
          });
          console.log('[TaskAutoUpdater] Moved task back to todo:', prevTask.title);
        }
      }

      this.currentTaskId = taskId;

      // Move new task to in-progress
      if (taskId) {
        const task = taskManager.getTask(taskId);
        if (task && task.status !== 'in-progress') {
          await taskManager.updateTask(taskId, { 
            status: 'in-progress',
            notes: task.notes + `\n[Auto] Started: ${new Date().toISOString()}`
          });
          console.log('[TaskAutoUpdater] Auto-started task:', task.title);
          this.emit('task:started', task);
        }
      }
    } catch (err: any) {
      console.error('[TaskAutoUpdater] Error in setCurrentTask:', err.message);
      // Don't throw - this is a background service, errors should not crash the server
    }
  }

  /**
   * Mark current task as completed
   */
  async completeCurrentTask(): Promise<void> {
    try {
      if (!this.currentTaskId) return;

      const task = taskManager.getTask(this.currentTaskId);
      if (task) {
        await taskManager.updateTask(this.currentTaskId, { 
          status: 'completed',
          notes: task.notes + `\n[Auto] Completed: ${new Date().toISOString()}`
        });
        console.log('[TaskAutoUpdater] Auto-completed task:', task.title);
        this.emit('task:completed', task);
      }

      this.currentTaskId = null;
    } catch (err: any) {
      console.error('[TaskAutoUpdater] Error in completeCurrentTask:', err.message);
      // Don't throw - this is a background service, errors should not crash the server
    }
  }

  /**
   * Get current task ID
   */
  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  /**
   * Get current task object
   */
  getCurrentTask(): Task | null {
    if (!this.currentTaskId) return null;
    return taskManager.getTask(this.currentTaskId) || null;
  }
}

export const taskAutoUpdater = new TaskAutoUpdater();
