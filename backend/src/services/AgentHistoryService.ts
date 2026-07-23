/**
 * AgentHistoryService - Persist agent session history for completed tasks
 * 
 * Stores agent run info so completed tasks retain friendly names
 * even after sessions disappear from sessions.json.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

export interface AgentHistoryRecord {
  name: string;
  label: string;
  sessionKey: string;
  model?: string;
  startedAt: string;
  taskId: string;
  taskTitle?: string;
  // Populated on completion
  completedAt?: string;
  outcome?: 'completed' | 'stuck' | 'error';
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
}

const HISTORY_FILE = process.env.AGENT_HISTORY_FILE || '/clawdbot/memory/agent-history.json';

class AgentHistoryService {
  private records: AgentHistoryRecord[] = [];
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await readFile(HISTORY_FILE, 'utf-8');
      this.records = JSON.parse(data);
    } catch {
      this.records = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
    await writeFile(HISTORY_FILE, JSON.stringify(this.records, null, 2), 'utf-8');
  }

  /**
   * Record when an agent starts working on a task
   */
  async recordStart(record: {
    name: string;
    label: string;
    sessionKey: string;
    model?: string;
    taskId: string;
    taskTitle?: string;
  }): Promise<void> {
    await this.load();
    
    // Don't duplicate - update if exists for same sessionKey+taskId
    const existing = this.records.find(
      r => r.sessionKey === record.sessionKey && r.taskId === record.taskId
    );
    if (existing) {
      Object.assign(existing, record);
    } else {
      this.records.push({
        ...record,
        startedAt: new Date().toISOString(),
      });
    }
    await this.save();
  }

  /**
   * Record when an agent completes a task
   */
  async recordCompletion(sessionKey: string, taskId: string, data: {
    outcome: 'completed' | 'stuck' | 'error';
    tokenUsage?: { input: number; output: number; total: number };
  }): Promise<void> {
    await this.load();
    
    const record = this.records.find(
      r => r.sessionKey === sessionKey && r.taskId === taskId
    );
    if (record) {
      record.completedAt = new Date().toISOString();
      record.outcome = data.outcome;
      record.tokenUsage = data.tokenUsage;
      if (record.startedAt) {
        record.durationMs = Date.now() - new Date(record.startedAt).getTime();
      }
    }
    await this.save();
  }

  /**
   * Look up agent info by session key (for completed tasks)
   */
  async findBySessionKey(sessionKey: string): Promise<AgentHistoryRecord | undefined> {
    await this.load();
    return this.records.find(r => r.sessionKey === sessionKey);
  }

  /**
   * Look up agent info by task ID
   */
  async findByTaskId(taskId: string): Promise<AgentHistoryRecord[]> {
    await this.load();
    return this.records.filter(r => r.taskId === taskId);
  }

  /**
   * Get all history records
   */
  async getAll(): Promise<AgentHistoryRecord[]> {
    await this.load();
    return [...this.records];
  }
}

export const agentHistoryService = new AgentHistoryService();
