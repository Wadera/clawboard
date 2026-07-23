import {
  ClawBoardBotDiscordTransport,
  createDiscordNotificationTransport,
  OpenClawGatewayDiscordTransport,
  DisabledDiscordTransport,
} from '../services/discord';

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    process.env = saved;
  }
}

describe('Discord notification transport selection', () => {
  it('selects ClawBoard bot transport when configured with a token', () => {
    withEnv({
      CLAWBOARD_DISCORD_TRANSPORT: 'clawboard-bot',
      CLAWBOARD_DISCORD_BOT_TOKEN: 'super-secret-token',
      CLAWBOARD_DISCORD_TASK_THREAD_CHANNEL_ID: 'chan-1',
    }, () => {
      const selected = createDiscordNotificationTransport({ gatewayConnector: null, logger: quietLogger() });
      expect(selected.transport).toBeInstanceOf(ClawBoardBotDiscordTransport);
      expect(selected.transport.name).toBe('clawboard-bot');
      expect(selected.reason).toBeNull();
    });
  });

  it('fails closed when ClawBoard bot token is missing and does not fall back implicitly', () => {
    withEnv({
      CLAWBOARD_DISCORD_TRANSPORT: 'clawboard-bot',
      CLAWBOARD_DISCORD_BOT_TOKEN: undefined,
      CLAWBOARD_DISCORD_TASK_THREAD_CHANNEL_ID: 'chan-1',
      CLAWBOARD_DISCORD_FALLBACK_TRANSPORT: undefined,
    }, () => {
      const selected = createDiscordNotificationTransport({ gatewayConnector: null, logger: quietLogger() });
      expect(selected.transport).toBeInstanceOf(DisabledDiscordTransport);
      expect(selected.transport.name).toBe('disabled');
      expect(selected.reason).toContain('missing ClawBoard bot token');
    });
  });

  it('selects OpenClaw gateway only by explicit rollback config', () => {
    const gatewayConnector = { getGatewayHttpUrl: () => 'http://gateway', getGatewayPassword: () => 'pw' } as any;
    withEnv({ CLAWBOARD_DISCORD_TRANSPORT: 'openclaw-gateway' }, () => {
      const selected = createDiscordNotificationTransport({ gatewayConnector, logger: quietLogger() });
      expect(selected.transport).toBeInstanceOf(OpenClawGatewayDiscordTransport);
      expect(selected.transport.name).toBe('openclaw-gateway');
    });
  });

  it('honors legacy Discord channel and steer-user aliases during transition', () => {
    withEnv({
      CLAWBOARD_DISCORD_TRANSPORT: 'clawboard-bot',
      CLAWBOARD_DISCORD_BOT_TOKEN: 'super-secret-token',
      CLAWBOARD_DISCORD_TASK_THREAD_CHANNEL_ID: undefined,
      DISCORD_TASK_THREAD_CHANNEL_ID: 'legacy-channel',
      CLAWBOARD_DISCORD_ALLOWED_STEER_USERS: undefined,
      DISCORD_ALLOWED_STEER_USERS: 'u1,u2',
    }, () => {
      const selected = createDiscordNotificationTransport({ gatewayConnector: null, logger: quietLogger() });
      expect(selected.config.taskThreadChannelId).toBe('legacy-channel');
      expect(selected.config.allowedSteerUserIds).toEqual(['u1', 'u2']);
    });
  });
});

describe('ClawBoardBotDiscordTransport REST behavior', () => {
  const token = 'do-not-leak-token';

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a thread, sends starter text, and returns a derived guild URL', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'thread-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'msg-1' }));
    const transport = new ClawBoardBotDiscordTransport({ token, guildId: 'guild-1', fetchImpl: fetchMock as any });

    const result = await transport.createThread({ channelId: 'channel-1', threadName: 'Task thread', initialMessage: 'hello' });

    expect(result).toEqual({ threadId: 'thread-1', threadUrl: 'https://discord.com/channels/guild-1/thread-1' });
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://discord.com/api/v10/channels/channel-1/threads', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: `Bot ${token}` }),
      body: JSON.stringify({ name: 'Task thread', type: 11, auto_archive_duration: 1440 }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://discord.com/api/v10/channels/thread-1/messages', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ content: 'hello' }),
    }));
  });

  it('posts, reads with after, archives, and maps Discord messages', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'msg-1' }))
      .mockResolvedValueOnce(jsonResponse([{ id: 'm1', content: 'reply', author: { id: 'u1', bot: false, username: 'W' }, timestamp: 'now' }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'thread-1', thread_metadata: { archived: true } }));
    const transport = new ClawBoardBotDiscordTransport({ token, fetchImpl: fetchMock as any });

    await expect(transport.sendThreadMessage({ threadId: 'thread-1', message: 'hi' })).resolves.toEqual({ messageId: 'msg-1' });
    await expect(transport.readThreadMessages({ threadId: 'thread-1', limit: 10, after: 'm0' })).resolves.toEqual({
      messages: [{ id: 'm1', content: 'reply', author: { id: 'u1', bot: false, username: 'W' }, timestamp: 'now' }],
    });
    await expect(transport.archiveThread({ threadId: 'thread-1', locked: false })).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[1][0]).toBe('https://discord.com/api/v10/channels/thread-1/messages?limit=10&after=m0');
    expect(fetchMock.mock.calls[2][1]).toEqual(expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ archived: true, locked: false }),
    }));
  });

  it('sanitizes Discord API errors so bot tokens are never exposed', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ message: `bad auth ${token}`, code: 50001 }, 403));
    const transport = new ClawBoardBotDiscordTransport({ token, fetchImpl: fetchMock as any });

    await expect(transport.sendThreadMessage({ threadId: 'thread-1', message: 'hi' })).rejects.toThrow(/Discord API thread message failed: 403/);
    await expect(transport.sendThreadMessage({ threadId: 'thread-1', message: 'hi' })).rejects.not.toThrow(token);
  });
});

function jsonResponse(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function quietLogger() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}
