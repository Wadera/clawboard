export type SessionHarness = 'openclaw' | 'hermes' | 'unknown';
export type SessionType =
  | 'main'
  | 'heartbeat'
  | 'cron'
  | 'subagent'
  | 'acp'
  | 'cli'
  | 'dm'
  | 'group'
  | 'channel'
  | 'thread'
  | 'unknown';

const OPENCLAW_RUNTIME_KINDS = new Set(['main', 'heartbeat', 'cron', 'subagent', 'acp']);
const HERMES_PLATFORMS = new Set([
  'local',
  'discord',
  'telegram',
  'signal',
  'slack',
  'whatsapp',
  'homeassistant',
  'webhook',
  'feishu',
  'wecom',
  'wecom_callback',
  'weixin',
  'qqbot',
  'bluebubbles',
  'mattermost',
]);
const HERMES_CHAT_TYPES = new Set(['dm', 'group', 'channel', 'thread']);

function getParts(sessionKey: string): string[] {
  return String(sessionKey || '').split(':').filter(Boolean);
}

function getPlatformAndChatType(sessionKey: string): { platform: string | null; chatType: string | null } {
  const parts = getParts(sessionKey);
  if (parts.length < 4 || parts[0] !== 'agent' || parts[1] !== 'main') {
    return { platform: null, chatType: null };
  }
  return {
    platform: parts[2] || null,
    chatType: parts[3] || null,
  };
}

export function deriveSessionHarness(input: {
  sessionKey: string;
  kind?: string | null;
  spawnInfo?: Record<string, any> | null;
}): SessionHarness {
  const sessionKey = String(input.sessionKey || '');
  const kind = String(input.kind || '').toLowerCase();
  const spawnInfo = input.spawnInfo || {};
  const explicitHarness = String(
    spawnInfo.harness || spawnInfo.sessionHarness || spawnInfo.sourceHarness || ''
  ).toLowerCase();
  const spawnChatType = String(
    spawnInfo.chatType || spawnInfo.origin?.chatType || ''
  ).toLowerCase();

  if (explicitHarness === 'openclaw' || explicitHarness === 'hermes') {
    return explicitHarness;
  }

  if (
    sessionKey.startsWith('cron:')
    || sessionKey.includes(':heartbeat')
    || sessionKey.includes(':cron:')
    || sessionKey.includes(':subagent:')
    || sessionKey.includes(':acp:')
    || sessionKey.endsWith(':main')
    || OPENCLAW_RUNTIME_KINDS.has(kind)
  ) {
    return 'openclaw';
  }

  const { platform, chatType } = getPlatformAndChatType(sessionKey);
  const effectiveChatType = spawnChatType || chatType || '';

  if (platform === 'local' && effectiveChatType === 'dm') {
    return 'hermes';
  }

  if (platform === 'discord' && effectiveChatType === 'channel') {
    return 'openclaw';
  }

  if (platform && HERMES_PLATFORMS.has(platform) && effectiveChatType && HERMES_CHAT_TYPES.has(effectiveChatType)) {
    return 'hermes';
  }

  return 'unknown';
}

export function deriveSessionType(input: {
  sessionKey: string;
  kind?: string | null;
  harness?: SessionHarness | null;
}): SessionType {
  const sessionKey = String(input.sessionKey || '');
  const kind = String(input.kind || '').toLowerCase();
  const harness = input.harness || deriveSessionHarness(input);
  const { platform, chatType } = getPlatformAndChatType(sessionKey);

  if (sessionKey.endsWith(':main') || kind === 'main') return 'main';
  if (sessionKey.includes(':heartbeat') || kind === 'heartbeat') return 'heartbeat';
  if (sessionKey.includes(':cron:') || sessionKey.startsWith('cron:') || kind === 'cron') return 'cron';
  if (sessionKey.includes(':subagent:') || kind === 'subagent') return 'subagent';
  if (sessionKey.includes(':acp:') || kind === 'acp') return 'acp';

  if (harness === 'hermes') {
    if (platform === 'local' && chatType === 'dm') return 'cli';
    if (chatType && HERMES_CHAT_TYPES.has(chatType)) {
      return chatType as SessionType;
    }
  }

  if (harness === 'openclaw' && kind === 'discord') {
    return 'channel';
  }

  return 'unknown';
}

export function getSessionDisplayLabel(input: {
  sessionKey: string;
  label?: string | null;
  harness?: SessionHarness | null;
  sessionType?: SessionType | null;
}): string {
  const harness = input.harness || deriveSessionHarness({ sessionKey: input.sessionKey });
  const sessionType = input.sessionType || deriveSessionType({ sessionKey: input.sessionKey, harness });
  const rawLabel = String(input.label || '').trim();

  if (sessionType === 'main' || /^main session$/i.test(rawLabel)) {
    if (harness === 'openclaw') return 'Main OpenClaw';
    if (harness === 'hermes') return 'Main Hermes';
    return 'Main';
  }

  if (sessionType === 'heartbeat') {
    return 'Heartbeat';
  }

  if (sessionType === 'cli' && (!rawLabel || /^main session$/i.test(rawLabel) || /^local$/i.test(rawLabel))) {
    return harness === 'hermes' ? 'Main Hermes' : 'CLI session';
  }

  if (rawLabel) return rawLabel;
  return input.sessionKey.slice(0, 30);
}

export function getHarnessBadgeLabel(harness: SessionHarness): string {
  switch (harness) {
    case 'openclaw': return 'OpenClaw';
    case 'hermes': return 'Hermes';
    default: return 'Unknown';
  }
}

export function getSessionTypeBadgeLabel(sessionType: SessionType): string {
  switch (sessionType) {
    case 'main': return 'main';
    case 'heartbeat': return 'heartbeat';
    case 'cron': return 'cron';
    case 'subagent': return 'sub agent';
    case 'acp': return 'acp';
    case 'cli': return 'cli';
    case 'dm': return 'dm';
    case 'group': return 'group';
    case 'channel': return 'channel';
    case 'thread': return 'thread';
    default: return 'unknown';
  }
}
