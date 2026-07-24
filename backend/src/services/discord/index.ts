export interface DiscordMessageAuthor {
  id: string;
  bot?: boolean;
  username?: string;
}

export interface DiscordMessage {
  id: string;
  content: string;
  author?: DiscordMessageAuthor;
  authorId?: string;
  timestamp?: string;
}

export interface CreateThreadResult {
  threadId: string;
  threadUrl?: string;
}

export interface DiscordNotificationTransport {
  readonly name: 'clawboard-bot' | 'openclaw-gateway' | 'disabled';
  createThread(input: { channelId: string; threadName: string; initialMessage?: string }): Promise<CreateThreadResult>;
  sendThreadMessage(input: { threadId: string; message: string }): Promise<{ messageId?: string }>;
  sendChannelMessage(input: { channelId: string; message: string }): Promise<{ messageId?: string }>;
  readThreadMessages(input: { threadId: string; limit: number; after?: string | null }): Promise<{ messages: DiscordMessage[] }>;
  archiveThread(input: { threadId: string; locked?: boolean }): Promise<void>;
}

export interface DiscordTransportConfig {
  transportName: 'clawboard-bot' | 'openclaw-gateway' | 'disabled';
  fallbackTransportName: 'openclaw-gateway' | 'disabled';
  taskThreadChannelId: string;
  allowedSteerUserIds: string[];
  guildId: string | null;
  botTokenConfigured: boolean;
  pollIntervalMs: number;
  streamBatchMs: number;
  maxMessageLen: number;
  archiveOnComplete: boolean;
  lockOnComplete: boolean;
}

type FetchLike = typeof fetch;
type LoggerLike = Pick<typeof console, 'log' | 'warn' | 'error'>;

const DEFAULT_TASK_THREAD_CHANNEL_ID = '';
const DEFAULT_ALLOWED_STEER_USERS = '';
const DISCORD_API_BASE = 'https://discord.com/api/v10';

function envFirst(primary: string, legacy?: string, fallback = ''): string {
  return process.env[primary] || (legacy ? process.env[legacy] : undefined) || fallback;
}

function envNumber(primary: string, fallback: number): number {
  const value = process.env[primary];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBool(primary: string, fallback: boolean): boolean {
  const value = process.env[primary];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function splitIds(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function loadDiscordTransportConfig(): DiscordTransportConfig {
  const transportName = (process.env.CLAWBOARD_DISCORD_TRANSPORT || 'disabled').trim() as DiscordTransportConfig['transportName'];
  const fallbackTransportName = (process.env.CLAWBOARD_DISCORD_FALLBACK_TRANSPORT || 'disabled').trim() as DiscordTransportConfig['fallbackTransportName'];
  return {
    transportName: ['clawboard-bot', 'openclaw-gateway', 'disabled'].includes(transportName) ? transportName : 'disabled',
    fallbackTransportName: fallbackTransportName === 'openclaw-gateway' ? 'openclaw-gateway' : 'disabled',
    taskThreadChannelId: envFirst('CLAWBOARD_DISCORD_TASK_THREAD_CHANNEL_ID', 'DISCORD_TASK_THREAD_CHANNEL_ID', DEFAULT_TASK_THREAD_CHANNEL_ID),
    allowedSteerUserIds: splitIds(envFirst('CLAWBOARD_DISCORD_ALLOWED_STEER_USERS', 'DISCORD_ALLOWED_STEER_USERS', DEFAULT_ALLOWED_STEER_USERS)),
    guildId: envFirst('CLAWBOARD_DISCORD_GUILD_ID', 'DISCORD_GUILD_ID', '') || null,
    botTokenConfigured: Boolean(process.env.CLAWBOARD_DISCORD_BOT_TOKEN),
    pollIntervalMs: envNumber('CLAWBOARD_DISCORD_POLL_INTERVAL_MS', 15000),
    streamBatchMs: envNumber('CLAWBOARD_DISCORD_STREAM_BATCH_MS', 7000),
    maxMessageLen: envNumber('CLAWBOARD_DISCORD_MAX_MESSAGE_LEN', 1900),
    archiveOnComplete: envBool('CLAWBOARD_DISCORD_ARCHIVE_ON_COMPLETE', true),
    lockOnComplete: envBool('CLAWBOARD_DISCORD_LOCK_ON_COMPLETE', false),
  };
}

export class DisabledDiscordTransport implements DiscordNotificationTransport {
  public readonly name = 'disabled' as const;
  constructor(private readonly reason = 'Discord task thread transport is disabled') {}
  async createThread(): Promise<CreateThreadResult> {
    throw new Error(this.reason);
  }
  async sendThreadMessage(): Promise<{ messageId?: string }> {
    return {};
  }
  async sendChannelMessage(): Promise<{ messageId?: string }> {
    return {};
  }
  async readThreadMessages(): Promise<{ messages: DiscordMessage[] }> {
    return { messages: [] };
  }
  async archiveThread(): Promise<void> {}
}

export class ClawBoardBotDiscordTransport implements DiscordNotificationTransport {
  public readonly name = 'clawboard-bot' as const;
  private readonly token: string;
  private readonly guildId: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(options: { token: string; guildId?: string | null; fetchImpl?: FetchLike }) {
    this.token = options.token;
    this.guildId = options.guildId || null;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async createThread(input: { channelId: string; threadName: string; initialMessage?: string }): Promise<CreateThreadResult> {
    const created = await this.request<any>(`/channels/${encodeURIComponent(input.channelId)}/threads`, {
      method: 'POST',
      body: { name: input.threadName, type: 11, auto_archive_duration: 1440 },
      action: 'thread create',
    });
    const threadId = created?.id;
    if (!threadId) throw new Error('Discord API thread create failed: response did not include thread id');
    if (input.initialMessage?.trim()) {
      await this.sendThreadMessage({ threadId, message: input.initialMessage });
    }
    return {
      threadId,
      ...(this.guildId ? { threadUrl: `https://discord.com/channels/${this.guildId}/${threadId}` } : {}),
    };
  }

  async sendThreadMessage(input: { threadId: string; message: string }): Promise<{ messageId?: string }> {
    const sent = await this.request<any>(`/channels/${encodeURIComponent(input.threadId)}/messages`, {
      method: 'POST',
      body: { content: input.message },
      action: 'thread message',
    });
    return { messageId: sent?.id };
  }

  async sendChannelMessage(input: { channelId: string; message: string }): Promise<{ messageId?: string }> {
    return this.sendThreadMessage({ threadId: input.channelId, message: input.message });
  }

  async readThreadMessages(input: { threadId: string; limit: number; after?: string | null }): Promise<{ messages: DiscordMessage[] }> {
    const params = new URLSearchParams({ limit: String(input.limit) });
    if (input.after) params.set('after', input.after);
    const messages = await this.request<any[]>(`/channels/${encodeURIComponent(input.threadId)}/messages?${params.toString()}`, {
      method: 'GET',
      action: 'thread read',
    });
    return {
      messages: Array.isArray(messages) ? messages.map(m => ({
        id: String(m.id || ''),
        content: String(m.content || ''),
        author: m.author ? { id: String(m.author.id || ''), bot: Boolean(m.author.bot), username: m.author.username } : undefined,
        authorId: m.author_id || m.authorId,
        timestamp: m.timestamp,
      })) : [],
    };
  }

  async archiveThread(input: { threadId: string; locked?: boolean }): Promise<void> {
    await this.request<any>(`/channels/${encodeURIComponent(input.threadId)}`, {
      method: 'PATCH',
      body: { archived: true, locked: Boolean(input.locked) },
      action: 'thread archive',
    });
  }

  private async request<T>(path: string, options: { method: string; body?: Record<string, unknown>; action: string }): Promise<T> {
    const response = await this.fetchImpl(`${DISCORD_API_BASE}${path}`, {
      method: options.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${this.token}`,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    } as RequestInit);

    if (!response.ok) {
      throw new Error(`Discord API ${options.action} failed: ${response.status} ${await this.sanitizedErrorText(response)}`.trim());
    }
    return await response.json() as T;
  }

  private async sanitizedErrorText(response: Response): Promise<string> {
    let parsed: any = null;
    try {
      parsed = await response.json();
    } catch {
      try { parsed = JSON.parse(await response.text()); } catch { parsed = null; }
    }
    const message = typeof parsed?.message === 'string' ? parsed.message.replaceAll(this.token, '[redacted]') : '';
    const code = parsed?.code !== undefined ? ` code=${parsed.code}` : '';
    return `${message}${code}`.trim();
  }
}

export class OpenClawGatewayDiscordTransport implements DiscordNotificationTransport {
  public readonly name = 'openclaw-gateway' as const;
  constructor(private readonly gatewayConnector: any) {}

  async createThread(input: { channelId: string; threadName: string; initialMessage?: string }): Promise<CreateThreadResult> {
    const result = await this.invokeMessageTool({ action: 'thread-create', args: { target: `channel:${input.channelId}`, threadName: input.threadName } });
    const threadId = result?.thread?.id || result?.threadId || result?.id || result?.channel?.id;
    if (!threadId) throw new Error('OpenClaw gateway thread-create returned no thread ID');
    if (input.initialMessage?.trim()) await this.sendThreadMessage({ threadId, message: input.initialMessage });
    return { threadId };
  }

  async sendThreadMessage(input: { threadId: string; message: string }): Promise<{ messageId?: string }> {
    const result = await this.invokeMessageTool({ action: 'thread-reply', args: { threadId: input.threadId, message: input.message } });
    return { messageId: result?.message?.id || result?.messageId || result?.id };
  }

  async sendChannelMessage(input: { channelId: string; message: string }): Promise<{ messageId?: string }> {
    const result = await this.invokeMessageTool({ action: 'send', args: { target: `channel:${input.channelId}`, message: input.message } });
    return { messageId: result?.message?.id || result?.messageId || result?.id };
  }

  async readThreadMessages(input: { threadId: string; limit: number; after?: string | null }): Promise<{ messages: DiscordMessage[] }> {
    const result = await this.invokeMessageTool({
      action: 'read',
      args: { target: `channel:${input.threadId}`, limit: input.limit, ...(input.after ? { after: input.after } : {}) },
    });
    return { messages: Array.isArray(result?.messages) ? result.messages : [] };
  }

  async archiveThread(input: { threadId: string; locked?: boolean }): Promise<void> {
    await this.invokeMessageTool({ action: 'channel-edit', args: { channelId: input.threadId, archived: true, locked: Boolean(input.locked) } });
  }

  private async invokeMessageTool(params: { action: string; args: Record<string, any> }): Promise<any> {
    if (!this.gatewayConnector) throw new Error('OpenClaw gateway transport requires GatewayConnector');
    const gatewayHttpUrl = this.gatewayConnector.getGatewayHttpUrl();
    const gatewayPassword = this.gatewayConnector.getGatewayPassword();
    const response = await fetch(`${gatewayHttpUrl}/tools/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gatewayPassword}`,
        'X-Openclaw-Message-Channel': 'discord',
      },
      body: JSON.stringify({ tool: 'message', action: params.action, args: params.args }),
    });
    if (!response.ok) throw new Error(`tools/invoke ${params.action} failed: ${response.status} ${await response.text().catch(() => '')}`);
    const json = await response.json() as { ok: boolean; result?: any; error?: any };
    if (!json.ok) throw new Error(`tools/invoke ${params.action} error: ${JSON.stringify(json.error)}`);
    const rawResult = json.result;
    if (rawResult?.content && Array.isArray(rawResult.content)) {
      const textItem = rawResult.content.find((c: any) => c.type === 'text');
      if (textItem?.text) {
        try { return JSON.parse(textItem.text); } catch { return { text: textItem.text }; }
      }
    }
    return rawResult;
  }
}

export function createDiscordNotificationTransport(options: { gatewayConnector: any | null; logger?: LoggerLike }): {
  transport: DiscordNotificationTransport;
  config: DiscordTransportConfig;
  reason: string | null;
} {
  const config = loadDiscordTransportConfig();
  const logger = options.logger || console;

  if (config.transportName === 'disabled') {
    return { transport: new DisabledDiscordTransport('Discord task thread transport disabled by config'), config, reason: 'disabled by config' };
  }

  if (config.transportName === 'openclaw-gateway') {
    logger.warn('Discord task thread transport is using explicit OpenClaw gateway compatibility mode; system messages will use the OpenClaw/Nim identity.');
    return { transport: new OpenClawGatewayDiscordTransport(options.gatewayConnector), config, reason: null };
  }

  const token = process.env.CLAWBOARD_DISCORD_BOT_TOKEN;
  if (!token) {
    const reason = 'Discord task thread disabled: missing ClawBoard bot token';
    if (config.fallbackTransportName === 'openclaw-gateway') {
      logger.warn(`${reason}; using explicitly configured OpenClaw gateway fallback.`);
      return { transport: new OpenClawGatewayDiscordTransport(options.gatewayConnector), config, reason };
    }
    logger.warn(reason);
    return { transport: new DisabledDiscordTransport(reason), config, reason };
  }

  return {
    transport: new ClawBoardBotDiscordTransport({ token, guildId: config.guildId }),
    config,
    reason: null,
  };
}
