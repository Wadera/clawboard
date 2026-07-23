#!/usr/bin/env node
// clawbeat-deliver.js — Deliver message to main session via gateway WebSocket RPC
// Usage:
//   NODE_PATH=~/.npm-global/lib/node_modules/openclaw/node_modules \
//   node clawbeat-deliver.js "message" [sessionKey] [idempotencyKey]
// Exit 0 = success, 1 = failure

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const configPath = path.join(process.env.HOME, '.openclaw/openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const port = config.gateway?.port || 18789;
const token = config.gateway?.auth?.token || '';
const password = config.gateway?.auth?.password || '';
const message = process.argv[2] || '';
const sessionKey = process.argv[3] || 'agent:main:main';
const idempotencyKey = process.argv[4] || `clawbeat-${Date.now()}`;

if (!message) {
  console.error('Usage: node clawbeat-deliver.js "message" [sessionKey] [idempotencyKey]');
  process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
  headers: { origin: `http://127.0.0.1:${port}` }
});

const timeout = setTimeout(() => {
  console.error('TIMEOUT');
  ws.close();
  process.exit(1);
}, 15000);

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'req', method: 'connect', id: 'c1',
    params: {
      minProtocol: 3, maxProtocol: 4,
      auth: { token, password },
      client: { id: 'openclaw-control-ui', mode: 'webchat', version: '1.0', platform: 'linux' },
      scopes: ['operator.admin']
    }
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.id === 'c1' && !msg.error) {
    // Authenticated — inject a normal user-style turn into the target session.
    // NOTE: agent RPC doesn't support deliveryContext, so the AI must
    // use the message tool to send responses to Discord explicitly.
    const fullMessage = message + '\n\n---\n⚠️ This message was injected by ClawBeat via gateway agent RPC (not via Discord). ' +
      'If you need to notify Wadera, use the message tool to send to Discord channel:1465806566350651484.';

    ws.send(JSON.stringify({
      type: 'req', method: 'agent', id: 'a1',
      params: {
        sessionKey,
        message: fullMessage,
        idempotencyKey,
      }
    }));
  } else if (msg.id === 'a1') {
    clearTimeout(timeout);
    if (msg.error) {
      console.error(`FAIL: ${JSON.stringify(msg.error)}`);
      ws.close();
      process.exit(1);
    } else {
      console.log('OK');
      ws.close();
      process.exit(0);
    }
  } else if (msg.error) {
    clearTimeout(timeout);
    console.error(`AUTH_FAIL: ${JSON.stringify(msg.error)}`);
    ws.close();
    process.exit(1);
  }
  // Ignore other messages (connect.challenge handled by protocol)
});

ws.on('close', () => { clearTimeout(timeout); });
ws.on('error', (e) => {
  clearTimeout(timeout);
  console.error(`WS_ERROR: ${e.message}`);
  process.exit(1);
});
