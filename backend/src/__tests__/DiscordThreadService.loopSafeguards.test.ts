import { EventEmitter } from 'events';
import { DiscordThreadService } from '../services/DiscordThreadService';

class FakeGatewayConnector extends EventEmitter {
  public steerSession = jest.fn(async () => undefined);
  public getGatewayHttpUrl(): string {
    return 'http://gateway.invalid';
  }
  public getGatewayPassword(): string {
    return 'test-token';
  }
}

describe('DiscordThreadService loop safeguards', () => {
  const trackedServices: DiscordThreadService[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const service of trackedServices) {
      service.stopTracking('task-1');
    }
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    trackedServices.length = 0;
  });

  async function flushBatchWindow(ms = 7000): Promise<void> {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  }

  function setupTrackedService(sessionKey = 'cron:test-session') {
    const service = new DiscordThreadService();
    const connector = new FakeGatewayConnector();
    const sent: Array<{ threadId: string; text: string }> = [];

    trackedServices.push(service);
    (service as any).sendToThread = jest.fn(async (threadId: string, text: string) => {
      sent.push({ threadId, text });
    });
    (service as any).startTracking('task-1', 'Bounded thread test', 'thread-1', sessionKey);
    service.setGatewayConnector(connector as any);

    return { service, connector, sent };
  }

  it('provides a safe in-memory reproduction for cumulative assistant snapshots', async () => {
    const { connector, sent } = setupTrackedService();

    connector.emit('agent:stream', {
      sessionKey: 'cron:test-session',
      stream: 'assistant',
      text: 'Hello',
    });
    connector.emit('agent:stream', {
      sessionKey: 'cron:test-session',
      stream: 'assistant',
      text: 'Hello world',
    });
    connector.emit('agent:stream', {
      sessionKey: 'cron:test-session',
      stream: 'assistant',
      text: 'Hello world!!!',
    });

    await flushBatchWindow();

    expect(sent).toEqual([
      { threadId: 'thread-1', text: 'Hello world!!!' },
    ]);
  });

  it('does not stack duplicate agent stream listeners when rewired', async () => {
    const { service, connector, sent } = setupTrackedService();

    service.setGatewayConnector(connector as any);
    connector.emit('agent:stream', {
      sessionKey: 'cron:test-session',
      stream: 'assistant',
      text: 'Listener test',
    });

    await flushBatchWindow();

    expect(sent).toEqual([
      { threadId: 'thread-1', text: 'Listener test' },
    ]);
  });

  it('suppresses identical outbound thread posts after a successful send', async () => {
    const service = new DiscordThreadService();
    const invokeMessageTool = jest.fn(async () => ({ ok: true }));
    (service as any).invokeMessageTool = invokeMessageTool;

    await (service as any).sendToThread('thread-1', 'duplicate check');
    await (service as any).sendToThread('thread-1', 'duplicate check');

    expect(invokeMessageTool).toHaveBeenCalledTimes(1);
    expect(invokeMessageTool).toHaveBeenCalledWith({
      action: 'thread-reply',
      args: {
        threadId: 'thread-1',
        message: 'duplicate check',
      },
    });
  });

  it('allows retrying the same outbound text after a failed send', async () => {
    const service = new DiscordThreadService();
    let fail = true;
    const invokeMessageTool = jest.fn(async (params: { action: string }) => {
      if (params.action === 'thread-reply' || params.action === 'send') {
        if (fail) throw new Error('temporary send failure');
        return { ok: true };
      }
      return { ok: true, messages: [] };
    });
    (service as any).invokeMessageTool = invokeMessageTool;

    const firstAttempt = (service as any).sendToThread('thread-1', 'retry me');
    await jest.advanceTimersByTimeAsync(5000);
    await firstAttempt;

    fail = false;
    await (service as any).sendToThread('thread-1', 'retry me');

    expect(invokeMessageTool).toHaveBeenCalledTimes(5);
    expect(invokeMessageTool.mock.calls[4][0]).toEqual({
      action: 'thread-reply',
      args: {
        threadId: 'thread-1',
        message: 'retry me',
      },
    });
  });


  it('preserves steerability without self-amplifying poll replies', async () => {
    const connector = new FakeGatewayConnector();
    const steeringHandler = jest.fn(async (_input: any) => ({ harness: 'openclaw' }));
    const readThreadMessages = jest.fn(async (params: { after?: string | null }) => {
      if (!params.after) {
        return {
          messages: [
            { id: 'm1', content: 'please tighten the fix', author: { id: '204643948960940033', bot: false } },
            { id: 'm2', content: 'ack', author: { id: 'bot-user', bot: true }, bot: true },
          ],
        };
      }
      return { messages: [] };
    });
    const sendThreadMessage = jest.fn(async () => ({ ok: true }));
    const service = new DiscordThreadService({
      transport: {
        name: 'clawboard-bot',
        createThread: jest.fn(async () => ({ threadId: 'thread-1' })),
        sendThreadMessage,
        readThreadMessages,
        archiveThread: jest.fn(async () => undefined),
      } as any,
      config: { allowedSteerUserIds: ['204643948960940033'] },
      steeringHandler,
    });

    trackedServices.push(service);
    service.setGatewayConnector(connector as any);
    (service as any).startTracking('task-1', 'Steer test', 'thread-1', 'cron:test-session');

    const state = (service as any).threads.get('task-1');
    await (service as any).pollThreadReplies(state);
    await (service as any).pollThreadReplies(state);

    expect(steeringHandler).toHaveBeenCalledTimes(1);
    expect(steeringHandler.mock.calls[0][0]).toEqual(expect.objectContaining({
      message: 'please tighten the fix',
      gatewayConnector: connector,
    }));
    expect(connector.steerSession).not.toHaveBeenCalled();

    expect(readThreadMessages).toHaveBeenNthCalledWith(1, {
      threadId: 'thread-1',
      limit: 10,
      after: null,
    });
    expect(readThreadMessages).toHaveBeenNthCalledWith(2, {
      threadId: 'thread-1',
      limit: 10,
      after: 'm2',
    });
    expect(sendThreadMessage).toHaveBeenCalledTimes(1);
  });
});
