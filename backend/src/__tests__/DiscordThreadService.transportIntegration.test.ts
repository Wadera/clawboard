import { EventEmitter } from 'events';
import { DiscordThreadService } from '../services/DiscordThreadService';
import type { DiscordNotificationTransport } from '../services/discord';

const mockGetTask = jest.fn();
const mockUpdateTask = jest.fn();

jest.mock('../services/TaskManagerDB', () => ({
  taskManagerDB: {
    getTask: (...args: unknown[]) => mockGetTask(...args),
    updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  },
}));

class FakeGatewayConnector extends EventEmitter {
  public steerSession = jest.fn(async () => undefined);
  public getGatewayHttpUrl(): string { return 'http://gateway.invalid'; }
  public getGatewayPassword(): string { return 'test-token'; }
}

describe('DiscordThreadService transport integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetTask.mockReset();
    mockUpdateTask.mockReset();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('creates threads through the selected transport and persists the thread id', async () => {
    mockGetTask.mockResolvedValue({ id: 'task-1', title: 'Transport task' });
    mockUpdateTask.mockResolvedValue({});
    const transport = fakeTransport({
      createThread: jest.fn(async () => ({ threadId: 'thread-1', threadUrl: 'https://discord.com/channels/guild/thread-1' })),
    });
    const service = new DiscordThreadService({
      transport,
      config: serviceConfig(),
    });

    const threadId = await service.createThreadForTask('task-1', 'Transport task', 'hermes:session-1');

    expect(threadId).toBe('thread-1');
    expect(transport.createThread).toHaveBeenCalledWith({
      channelId: 'channel-1',
      threadName: '🤖 Task: Transport task',
      initialMessage: expect.stringContaining('Task Started'),
    });
    expect(mockUpdateTask).toHaveBeenCalledWith('task-1', { discordThreadId: 'thread-1' });
    service.stopTracking('task-1');
  });

  it('polls through the transport and delegates steering through the harness-aware steering boundary', async () => {
    mockGetTask.mockResolvedValue({
      id: 'task-1',
      title: 'Hermes task',
      executionProfile: { harness: 'hermes' },
      acpSessionKey: 'hermes:session-1',
      model: 'test-model',
    });
    const steeringHandler = jest.fn(async () => ({ harness: 'hermes' as const }));
    const transport = fakeTransport({
      readThreadMessages: jest.fn(async () => ({
        messages: [
          { id: 'm1', content: 'please adjust', author: { id: 'u1', bot: false } },
          { id: 'm2', content: 'bot ack', author: { id: 'bot', bot: true } },
        ],
      })),
      sendThreadMessage: jest.fn(async () => ({ messageId: 'ack-1' })),
    });
    const connector = new FakeGatewayConnector();
    const service = new DiscordThreadService({ transport, config: serviceConfig(), steeringHandler });
    service.setGatewayConnector(connector as any);
    (service as any).startTracking('task-1', 'Hermes task', 'thread-1', 'hermes:session-1');

    const state = (service as any).threads.get('task-1');
    await (service as any).pollThreadReplies(state);

    expect(steeringHandler).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ taskId: 'task-1' }),
      message: 'please adjust',
      gatewayConnector: connector,
    }));
    expect(connector.steerSession).not.toHaveBeenCalled();
    expect(transport.sendThreadMessage).toHaveBeenCalledWith({
      threadId: 'thread-1',
      message: '↩️ *Steering message received and forwarded to Hermes.*',
    });
    expect(state.lastMessageId).toBe('m2');
    service.stopTracking('task-1');
  });
});

function fakeTransport(overrides: Partial<DiscordNotificationTransport> = {}): DiscordNotificationTransport {
  return {
    name: 'clawboard-bot',
    createThread: jest.fn(async () => ({ threadId: 'thread-1' })),
    sendThreadMessage: jest.fn(async () => ({ messageId: 'msg-1' })),
    readThreadMessages: jest.fn(async () => ({ messages: [] })),
    archiveThread: jest.fn(async () => undefined),
    ...overrides,
  } as DiscordNotificationTransport;
}

function serviceConfig() {
  return {
    taskThreadChannelId: 'channel-1',
    allowedSteerUserIds: ['u1'],
    pollIntervalMs: 15000,
    streamBatchMs: 7000,
    maxMessageLen: 1900,
    archiveOnComplete: true,
    lockOnComplete: false,
  };
}
