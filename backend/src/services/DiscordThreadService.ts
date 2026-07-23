/**
 * DiscordThreadService — Phase 3: Discord thread auto-creation for interactive tasks
 *
 * Responsibilities:
 * 1. Create Discord threads for interactive task spawns
 * 2. Stream ACP session output to the thread (batched every 5-10s)
 * 3. Poll thread for user replies and forward as steer commands
 * 4. Post lifecycle messages (completion summary, error reports)
 * 5. Archive thread on completion
 *
 * Uses the OpenClaw gateway's /tools/invoke HTTP endpoint to send Discord messages.
 * The gateway WS connection (GatewayConnector) emits 'agent:stream' events that
 * we subscribe to for output streaming.
 */

import { EventEmitter } from 'events';
import { taskManagerDB as taskManager } from './TaskManagerDB';
import { canonicalizeSessionKey } from './GatewayConnector';
import type { GatewayConnector } from './GatewayConnector';
import { createTaskExecutor } from './TaskExecutors';
import { taskTimelineService } from './TaskTimelineService';
import {
  createDiscordNotificationTransport,
  loadDiscordTransportConfig,
  type DiscordNotificationTransport,
  type DiscordTransportConfig,
} from './discord';

// ── Config ────────────────────────────────────────────────────────────────────

/** Discord channel where task threads are created */
const TASK_THREAD_CHANNEL_ID =
  process.env.CLAWBOARD_DISCORD_TASK_THREAD_CHANNEL_ID
  || process.env.DISCORD_TASK_THREAD_CHANNEL_ID
  || '1292093858154414153'; // #general

/** Authorised users who can steer tasks via Discord thread replies */
const ALLOWED_STEER_USER_IDS = (process.env.CLAWBOARD_DISCORD_ALLOWED_STEER_USERS || process.env.DISCORD_ALLOWED_STEER_USERS || '204643948960940033').split(',').map(s => s.trim());

/** Batch window: aggregate output for this many ms before posting */
const STREAM_BATCH_MS = 7000;

/** How often to poll for new thread replies (ms) */
const REPLY_POLL_INTERVAL_MS = 15000;

/** Maximum chars per Discord message (hard limit: 2000) */
const MAX_MSG_LEN = 1900;

/** Suppress identical outbound messages to the same thread inside this window. */
const OUTBOUND_DEDUP_TTL_MS = 120000;

/** Keep a short memory of recently-sent thread messages. */
const MAX_RECENT_OUTBOUND = 200;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ThreadState {
  taskId: string;
  taskTitle: string;
  threadId: string;
  sessionKey: string;
  /** Accumulated output waiting to be flushed */
  pendingText: string;
  flushTimer: NodeJS.Timeout | null;
  /** ID of the last message read (for polling) */
  lastMessageId: string | null;
  pollTimer: NodeJS.Timeout | null;
  active: boolean;
  /** Last cumulative assistant snapshot seen for this thread */
  lastAssistantText?: string;
}

type DiscordThreadServiceConfig = Pick<DiscordTransportConfig,
  'taskThreadChannelId'
  | 'allowedSteerUserIds'
  | 'pollIntervalMs'
  | 'streamBatchMs'
  | 'maxMessageLen'
  | 'archiveOnComplete'
  | 'lockOnComplete'
>;

interface SteeringHandlerInput {
  task: any;
  message: string;
  gatewayConnector: GatewayConnector | null;
}

type SteeringHandler = (input: SteeringHandlerInput) => Promise<{ harness: string }>;

interface DiscordThreadServiceOptions {
  transport?: DiscordNotificationTransport;
  config?: Partial<DiscordThreadServiceConfig>;
  steeringHandler?: SteeringHandler;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class DiscordThreadService extends EventEmitter {
  private threads: Map<string, ThreadState> = new Map(); // taskId → state
  private gatewayConnector: GatewayConnector | null = null;
  private agentStreamListener: ((event: { sessionKey: string; stream: string; text?: string; toolName?: string; toolInput?: string }) => void) | null = null;
  private recentOutbound: Map<string, number> = new Map();
  private transport: DiscordNotificationTransport | null = null;
  private config: DiscordThreadServiceConfig;
  private steeringHandler: SteeringHandler;
  private hasCustomSteeringHandler = false;

  constructor(options: DiscordThreadServiceOptions = {}) {
    super();
    const envConfig = loadDiscordTransportConfig();
    this.config = {
      taskThreadChannelId: options.config?.taskThreadChannelId || envConfig.taskThreadChannelId || TASK_THREAD_CHANNEL_ID,
      allowedSteerUserIds: options.config?.allowedSteerUserIds || envConfig.allowedSteerUserIds || ALLOWED_STEER_USER_IDS,
      pollIntervalMs: options.config?.pollIntervalMs || envConfig.pollIntervalMs || REPLY_POLL_INTERVAL_MS,
      streamBatchMs: options.config?.streamBatchMs || envConfig.streamBatchMs || STREAM_BATCH_MS,
      maxMessageLen: options.config?.maxMessageLen || envConfig.maxMessageLen || MAX_MSG_LEN,
      archiveOnComplete: options.config?.archiveOnComplete ?? envConfig.archiveOnComplete ?? true,
      lockOnComplete: options.config?.lockOnComplete ?? envConfig.lockOnComplete ?? false,
    };
    this.transport = options.transport || null;
    this.hasCustomSteeringHandler = Boolean(options.steeringHandler);
    this.steeringHandler = options.steeringHandler || this.defaultSteeringHandler.bind(this);
  }

  public async sendSystemChannelMessage(channelId: string, message: string): Promise<{ messageId?: string }> {
    if (!this.transport) throw new Error('Discord transport is not initialized');
    return this.transport.sendChannelMessage({ channelId, message: message.slice(0, this.config.maxMessageLen) });
  }

  public getSystemNotificationChannelId(): string {
    return this.config.taskThreadChannelId;
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────

  public setGatewayConnector(connector: GatewayConnector): void {
    if (this.gatewayConnector && this.agentStreamListener) {
      this.gatewayConnector.off('agent:stream', this.agentStreamListener);
    }

    this.gatewayConnector = connector;
    this.agentStreamListener = (event: { sessionKey: string; stream: string; text?: string; toolName?: string; toolInput?: string }) => {
      this.handleAgentStream(event);
    };

    // Subscribe to agent streaming events exactly once
    connector.on('agent:stream', this.agentStreamListener);

    if (!this.transport) {
      const selected = createDiscordNotificationTransport({ gatewayConnector: connector });
      this.transport = selected.transport;
      this.config = {
        taskThreadChannelId: selected.config.taskThreadChannelId,
        allowedSteerUserIds: selected.config.allowedSteerUserIds,
        pollIntervalMs: selected.config.pollIntervalMs,
        streamBatchMs: selected.config.streamBatchMs,
        maxMessageLen: selected.config.maxMessageLen,
        archiveOnComplete: selected.config.archiveOnComplete,
        lockOnComplete: selected.config.lockOnComplete,
      };
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Create a Discord thread for an interactive task.
   * If the task already has a discord_thread_id, reuse it.
   * Returns the thread ID or null on failure.
   */
  public async createThreadForTask(taskId: string, taskTitle: string, sessionKey: string): Promise<string | null> {
    try {
      // Check if thread already exists for this task
      const task = await taskManager.getTask(taskId);
      if (task?.discordThreadId) {
        console.log(`♻️  DiscordThreadService: Reusing existing thread ${task.discordThreadId} for task ${taskId}`);
        this.startTracking(taskId, taskTitle, task.discordThreadId, sessionKey);
        return task.discordThreadId;
      }

      const threadName = `🤖 Task: ${taskTitle}`.substring(0, 100);
      const initialMessage = [
        `## 🤖 Task Started`,
        `**${taskTitle}**`,
        ``,
        `An interactive agent session has been spawned for this task.`,
        ``,
        `💬 **Reply in this thread to steer the agent.**`,
        `📋 Session: \`${sessionKey}\``,
      ].join('\n');

      console.log(`🧵 DiscordThreadService: Creating Discord thread "${threadName}" for task ${taskId}`);

      const transport = this.getTransport();
      const result = await transport.createThread({
        channelId: this.config.taskThreadChannelId,
        threadName,
        initialMessage,
      });

      const threadId = result.threadId;
      if (!threadId) {
        console.error('DiscordThreadService: transport returned no thread ID');
        return null;
      }

      console.log(`✅ DiscordThreadService: Created thread ${threadId} for task ${taskId}`);

      // Persist thread ID in task record
      await taskManager.updateTask(taskId, { discordThreadId: threadId });

      this.startTracking(taskId, taskTitle, threadId, sessionKey);
      return threadId;

    } catch (err) {
      console.error(`❌ DiscordThreadService: Failed to create thread for task ${taskId}:`, err);
      return null;
    }
  }

  /**
   * Post a lifecycle message to the task thread (completion, failure, etc.)
   */
  public async postLifecycleMessage(taskId: string, kind: 'completed' | 'failed' | 'stuck', details?: string): Promise<void> {
    const state = this.threads.get(taskId);
    if (!state) return;

    // Flush any pending output first
    await this.flushPending(state);

    const icons: Record<string, string> = {
      completed: '✅',
      failed: '❌',
      stuck: '🚫',
    };

    const messages: Record<string, string> = {
      completed: '**Task completed!** The agent finished all subtasks and moved this task to review.',
      failed:    '**Task failed.** The agent encountered an error. Check the logs for details.',
      stuck:     '**Task stuck.** The agent stopped without completing. Manual intervention may be needed.',
    };

    const text = [
      `## ${icons[kind] || '🔔'} ${messages[kind] || `Task ${kind}`}`,
      details ? `\n${details}` : '',
    ].join('').trim();

    await this.sendToThread(state.threadId, text);

    // Archive thread on success
    if (kind === 'completed' && this.config.archiveOnComplete) {
      await this.archiveThread(state);
    }

    // Stop polling and flush
    this.stopTracking(taskId);
  }

  /**
   * Rebind the tracked session key for a task's thread after a provisional
   * spawn ('pending') resolves to its real Hermes session id. No-op when no
   * thread is tracked for the task.
   */
  public rebindTrackedSession(taskId: string, newSessionKey: string): void {
    const state = this.threads.get(taskId);
    if (!state || !newSessionKey || state.sessionKey === newSessionKey) return;
    console.log(`🔁 DiscordThreadService: Rebound thread ${state.threadId} for task ${taskId}: ${state.sessionKey} → ${newSessionKey}`);
    state.sessionKey = newSessionKey;
  }

  /**
   * Stop tracking a task thread (call on task completion / manual cancel).
   */
  public stopTracking(taskId: string): void {
    const state = this.threads.get(taskId);
    if (!state) return;

    state.active = false;
    if (state.flushTimer) clearTimeout(state.flushTimer);
    if (state.pollTimer) clearInterval(state.pollTimer);
    this.threads.delete(taskId);
    console.log(`🧹 DiscordThreadService: Stopped tracking task ${taskId}`);
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private startTracking(taskId: string, taskTitle: string, threadId: string, sessionKey: string): void {
    // Stop any existing tracking
    this.stopTracking(taskId);

    const state: ThreadState = {
      taskId,
      taskTitle,
      threadId,
      sessionKey,
      pendingText: '',
      flushTimer: null,
      lastMessageId: null,
      pollTimer: null,
      active: true,
      lastAssistantText: '',
    };
    this.threads.set(taskId, state);

    // Start polling for user replies
    state.pollTimer = setInterval(() => {
      this.pollThreadReplies(state).catch(err =>
        console.error(`DiscordThreadService: poll error for task ${taskId}:`, err)
      );
    }, this.config.pollIntervalMs);

    console.log(`📡 DiscordThreadService: Tracking thread ${threadId} for task ${taskId} (session: ${sessionKey})`);
  }

  /**
   * Handle a streaming event from the agent session.
   */
  private handleAgentStream(event: { sessionKey: string; stream: string; text?: string; toolName?: string; toolInput?: string }): void {
    // Find the thread state for this session
    const state = this.findStateBySession(event.sessionKey);
    if (!state || !state.active) return;

    if (event.stream === 'assistant' && event.text) {
      const delta = this.extractAssistantDelta(state, event.text);
      if (delta) this.appendText(state, delta);
    } else if (event.stream === 'tool_call' && event.toolName) {
      const preview = event.toolInput
        ? `\`${event.toolName}\`: ${this.truncate(event.toolInput, 200)}`
        : `\`${event.toolName}\``;
      this.appendText(state, `\n🔧 ${preview}\n`);
    }
  }

  /**
   * Reduce cumulative/replayed assistant chunks into only the unseen delta.
   */
  private extractAssistantDelta(state: ThreadState, incomingText: string): string {
    if (!incomingText) return '';

    const normalizedIncoming = incomingText.replace(/\r\n/g, '\n');
    const previous = (state.lastAssistantText || '').replace(/\r\n/g, '\n');

    if (!previous) {
      state.lastAssistantText = normalizedIncoming;
      return normalizedIncoming;
    }

    if (normalizedIncoming === previous) {
      return '';
    }

    if (normalizedIncoming.startsWith(previous)) {
      state.lastAssistantText = normalizedIncoming;
      return normalizedIncoming.slice(previous.length);
    }

    if (previous.startsWith(normalizedIncoming)) {
      state.lastAssistantText = normalizedIncoming;
      return '';
    }

    const suffixWindow = Math.min(previous.length, normalizedIncoming.length, 400);
    for (let overlap = suffixWindow; overlap >= 20; overlap--) {
      if (previous.slice(-overlap) === normalizedIncoming.slice(0, overlap)) {
        state.lastAssistantText = normalizedIncoming;
        return normalizedIncoming.slice(overlap);
      }
    }

    state.lastAssistantText = normalizedIncoming;
    return normalizedIncoming;
  }

  /**
   * Append text to pending buffer and schedule a flush.
   */
  private appendText(state: ThreadState, text: string): void {
    if (!text) return;

    state.pendingText += text;

    // If buffer is getting large, flush immediately
    if (state.pendingText.length > this.config.maxMessageLen * 2) {
      this.flushPending(state).catch(console.error);
      return;
    }

    // Schedule batch flush
    if (!state.flushTimer) {
      state.flushTimer = setTimeout(() => {
        state.flushTimer = null;
        this.flushPending(state).catch(console.error);
      }, this.config.streamBatchMs);
    }
  }

  /**
   * Post accumulated text to Discord thread and clear buffer.
   */
  private async flushPending(state: ThreadState): Promise<void> {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }

    const text = state.pendingText.trim();
    if (!text || !state.active) {
      state.pendingText = '';
      return;
    }
    state.pendingText = '';

    // Split into chunks if too long
    const chunks = this.splitIntoChunks(text, this.config.maxMessageLen);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      await this.sendToThread(state.threadId, chunk);
    }
  }

  /**
   * Poll for new messages in the Discord thread and steer the agent.
   */
  private async pollThreadReplies(state: ThreadState): Promise<void> {
    if (!state.active) return;

    try {
      const result = await this.getTransport().readThreadMessages({
        threadId: state.threadId,
        limit: 10,
        after: state.lastMessageId,
      });

      const messages: any[] = result?.messages || [];
      if (!messages.length) return;

      // Update lastMessageId to the newest message, including ignored bot replies,
      // so ClawBoard acknowledgements cannot self-amplify into steering loops.
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.id) state.lastMessageId = lastMsg.id;

      // Filter: only text messages from authorized users that aren't the bot itself
      const steerMessages = messages.filter(m => {
        const isAuthorized = this.config.allowedSteerUserIds.includes(m.author?.id || m.authorId || '');
        const isText = typeof m.content === 'string' && m.content.trim().length > 0;
        const isNotBot = !m.author?.bot && !m.bot;
        return isAuthorized && isText && isNotBot;
      });

      for (const msg of steerMessages) {
        const steerText = msg.content?.trim();
        if (!steerText) continue;

        console.log(`💬 DiscordThreadService: Steering task ${state.taskId} with: "${steerText.substring(0, 80)}..."`);

        try {
          const task = this.hasCustomSteeringHandler ? state : await taskManager.getTask(state.taskId);
          if (!task) {
            await this.sendToThread(state.threadId, `⚠️ *Failed to forward message to agent: task not found.*`);
            continue;
          }
          const result = await this.steeringHandler({ task, message: steerText, gatewayConnector: this.gatewayConnector });
          const label = result.harness === 'hermes' ? 'Hermes' : result.harness === 'openclaw' ? 'OpenClaw' : 'agent';
          await this.sendToThread(state.threadId, `↩️ *Steering message received and forwarded to ${label}.*`);
        } catch (err) {
          console.error(`DiscordThreadService: Failed to steer task ${state.taskId}:`, err);
          await this.sendToThread(state.threadId, `⚠️ *Failed to forward message to agent: ${(err as Error).message}*`);
        }
      }
    } catch (err) {
      // Don't spam errors — thread may have been archived or permission removed
      if ((err as any)?.message?.includes('Unknown Channel') || (err as any)?.message?.includes('404') || (err as any)?.message?.includes('403') || (err as any)?.message?.includes('401')) {
        console.log(`DiscordThreadService: Thread ${state.threadId} no longer accessible — stopping poll`);
        state.active = false;
        if (state.pollTimer) clearInterval(state.pollTimer);
      }
    }
  }

  /**
   * Send a message to a Discord thread via /tools/invoke.
   * Freshly-created Discord threads can reject the first post for a moment, so
   * retry a few times and fall back to channel send if thread-reply still fails.
   */
  private async sendToThread(threadId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const message = trimmed.substring(0, this.config.maxMessageLen);
    if (this.isRecentDuplicateOutbound(threadId, message)) {
      console.warn(`⚠️ DiscordThreadService: Suppressed duplicate outbound thread message for ${threadId}`);
      return;
    }

    if (this.transport) {
      try {
        await this.transport.sendThreadMessage({ threadId, message });
        this.rememberOutbound(threadId, message);
        return;
      } catch (err) {
        console.error(`DiscordThreadService: Failed to send to thread ${threadId}:`, err);
        return;
      }
    }

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.invokeMessageTool({
          action: 'thread-reply',
          args: {
            threadId,
            message,
          },
        });
        this.rememberOutbound(threadId, message);
        return;
      } catch (err) {
        lastError = err;
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, attempt * 1200));
          continue;
        }
      }
    }

    try {
      await this.invokeMessageTool({
        action: 'send',
        args: {
          target: `channel:${threadId}`,
          message,
        },
      });
      this.rememberOutbound(threadId, message);
      return;
    } catch (fallbackErr) {
      lastError = fallbackErr;
    }

    console.error(`DiscordThreadService: Failed to send to thread ${threadId}:`, lastError);
  }

  /**
   * Archive the Discord thread (lock it so no new messages can be sent).
   */
  private async archiveThread(state: ThreadState): Promise<void> {
    try {
      await this.getTransport().archiveThread({ threadId: state.threadId, locked: this.config.lockOnComplete });
      console.log(`📦 DiscordThreadService: Archived thread ${state.threadId}`);
    } catch (err) {
      // Archiving failing is non-fatal
      console.warn(`DiscordThreadService: Could not archive thread ${state.threadId}:`, (err as Error).message);
    }
  }

  private getTransport(): DiscordNotificationTransport {
    if (!this.transport) {
      if (this.gatewayConnector) {
        this.transport = createDiscordNotificationTransport({ gatewayConnector: this.gatewayConnector }).transport;
      } else {
        throw new Error('DiscordThreadService: Discord transport not configured');
      }
    }
    return this.transport;
  }

  private async defaultSteeringHandler(input: SteeringHandlerInput): Promise<{ harness: string }> {
    const task = input.task;
    const sessionKey = task.acpSessionKey || task.activeAgent?.sessionKey;
    if (!sessionKey) {
      throw new Error('No active session linked to this task. Spawn an interactive session first.');
    }

    const harness = task.executionProfile?.harness
      || task.activeAgent?.harness
      || (typeof sessionKey === 'string' && sessionKey.startsWith('hermes:') ? 'hermes' : 'openclaw');
    const executor = createTaskExecutor(harness as any, input.gatewayConnector);
    const steerResult = await executor.steer({
      taskId: task.id,
      sessionKey,
      message: input.message,
      model: task.model || null,
      cwd: task.cwd || task.workingDirectory || null,
    });

    await taskTimelineService.recordEvent({
      taskId: task.id,
      eventType: 'session.steered',
      title: 'Sent steering message from Discord thread',
      description: input.message.trim(),
      sessionKey,
      actor: 'user',
      harness,
      metadata: {
        sessionKey,
        messagePreview: input.message.trim().slice(0, 500),
        source: 'discord-thread',
      },
    });

    return { harness: steerResult.harness || harness };
  }

  /**
   * Call the OpenClaw gateway /tools/invoke HTTP endpoint.
   *
   * The gateway returns results in an AI content-array format:
   *   { ok: true, result: { content: [{ type: 'text', text: '<JSON_STRING>' }] } }
   *
   * This method unwraps that envelope and parses the inner JSON so callers get
   * a plain object (e.g. { ok: true, thread: { id: '...', ... } }).
   */
  private async invokeMessageTool(params: { action: string; args: Record<string, any> }): Promise<any> {
    if (!this.gatewayConnector) {
      throw new Error('DiscordThreadService: GatewayConnector not set');
    }

    const gatewayHttpUrl = this.gatewayConnector.getGatewayHttpUrl();
    const gatewayPassword = this.gatewayConnector.getGatewayPassword();

    const url = `${gatewayHttpUrl}/tools/invoke`;
    const body = {
      tool: 'message',
      action: params.action,
      args: params.args,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayPassword}`,
        'X-Openclaw-Message-Channel': 'discord',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`tools/invoke ${params.action} failed: ${response.status} ${errText}`);
    }

    const json = await response.json() as { ok: boolean; result?: any; error?: any };
    if (!json.ok) {
      throw new Error(`tools/invoke ${params.action} error: ${JSON.stringify(json.error)}`);
    }

    // Unwrap AI content-array envelope if present.
    // Gateway wraps tool results in { content: [{ type: 'text', text: '<JSON>' }] }.
    const rawResult = json.result;
    if (rawResult?.content && Array.isArray(rawResult.content)) {
      const textItem = rawResult.content.find((c: any) => c.type === 'text');
      if (textItem?.text) {
        try {
          return JSON.parse(textItem.text);
        } catch {
          // Not JSON — return raw text wrapped in an object
          return { text: textItem.text };
        }
      }
    }
    return rawResult;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  private findStateBySession(sessionKey: string): ThreadState | undefined {
    const resolvedSessionKey = canonicalizeSessionKey(sessionKey);
    for (const state of this.threads.values()) {
      if (canonicalizeSessionKey(state.sessionKey) === resolvedSessionKey) return state;
    }
    return undefined;
  }

  private isRecentDuplicateOutbound(threadId: string, message: string): boolean {
    this.pruneRecentOutbound();

    const fingerprint = `${threadId}:${message}`;
    const lastSentAt = this.recentOutbound.get(fingerprint);
    return Boolean(lastSentAt && Date.now() - lastSentAt < OUTBOUND_DEDUP_TTL_MS);
  }

  private rememberOutbound(threadId: string, message: string): void {
    this.pruneRecentOutbound();

    const fingerprint = `${threadId}:${message}`;
    this.recentOutbound.set(fingerprint, Date.now());
    if (this.recentOutbound.size > MAX_RECENT_OUTBOUND) {
      const oldestKey = this.recentOutbound.keys().next().value;
      if (oldestKey) this.recentOutbound.delete(oldestKey);
    }
  }

  private pruneRecentOutbound(): void {
    const now = Date.now();

    for (const [key, ts] of this.recentOutbound.entries()) {
      if (now - ts > OUTBOUND_DEDUP_TTL_MS) {
        this.recentOutbound.delete(key);
      }
    }
  }

  private truncate(text: string, maxLen: number): string {
    if (typeof text !== 'string') return String(text).substring(0, maxLen);
    return text.length > maxLen ? text.substring(0, maxLen) + '…' : text;
  }

  private splitIntoChunks(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      // Try to break at a newline near the limit
      let breakAt = maxLen;
      const nlIdx = remaining.lastIndexOf('\n', maxLen);
      if (nlIdx > maxLen * 0.5) breakAt = nlIdx + 1;
      chunks.push(remaining.substring(0, breakAt));
      remaining = remaining.substring(breakAt);
    }
    return chunks;
  }
}

// Singleton
export const discordThreadService = new DiscordThreadService();
