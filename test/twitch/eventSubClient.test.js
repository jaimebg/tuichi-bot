import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventSubClient } from '../../src/twitch/eventSubClient.js';

// Minimal mock TwitchApi
function mockTwitchApi() {
  return {
    getUserByName: async () => ({ id: '12345', displayName: 'Test' }),
    getAccessToken: async () => 'mock-token',
    authProvider: { clientId: 'mock-client-id' }
  };
}

describe('EventSubClient', () => {
  let client;

  beforeEach(() => {
    client = new EventSubClient({
      twitchApi: mockTwitchApi(),
      channelLogin: 'testchannel',
      reconnectBaseMs: 100,
      maxReconnectMs: 1000,
      keepaliveGraceMs: 500
    });
  });

  afterEach(async () => { await client.stop(); });

  it('registers subscriptions', () => {
    const cb = () => {};
    client.registerSubscription('stream.online', '1', { broadcaster_user_id: '123' }, cb);
    assert.equal(client._subscriptions.size, 1);
    assert.equal(client._subscriptions.get('stream.online').callback, cb);
  });

  it('registers multiple subscriptions', () => {
    client.registerSubscription('stream.online', '1', {}, () => {});
    client.registerSubscription('stream.offline', '1', {}, () => {});
    client.registerSubscription('channel.channel_points_custom_reward_redemption.add', '1', {}, () => {});
    assert.equal(client._subscriptions.size, 3);
  });

  it('routes notifications to correct callback', () => {
    const events = [];
    client.registerSubscription('stream.online', '1', {}, (e) => events.push({ type: 'online', e }));
    client.registerSubscription('stream.offline', '1', {}, (e) => events.push({ type: 'offline', e }));

    // Simulate a notification message
    client._handleNotification({
      payload: {
        subscription: { type: 'stream.online' },
        event: { broadcaster_user_id: '123' }
      }
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'online');
  });

  it('ignores notifications for unregistered types', () => {
    const events = [];
    client.registerSubscription('stream.online', '1', {}, (e) => events.push(e));
    client._handleNotification({
      payload: {
        subscription: { type: 'stream.offline' },
        event: {}
      }
    });
    assert.equal(events.length, 0);
  });

  it('isConnected returns false before start', () => {
    assert.equal(client.isConnected(), false);
  });

  it('dedupes connection-state changes passed to onConnectionChange', () => {
    const events = [];
    const c = new EventSubClient({
      twitchApi: mockTwitchApi(), channelLogin: 'x',
      onConnectionChange: (v) => events.push(v)
    });
    c._setConnected(true);
    c._setConnected(true);   // no-op (already connected)
    c._setConnected(false);
    c._setConnected(false);  // no-op (already disconnected)
    assert.deepEqual(events, [true, false]);
  });

  it('reports disconnect when the socket closes', async () => {
    const events = [];
    const c = new EventSubClient({
      twitchApi: mockTwitchApi(), channelLogin: 'x',
      reconnectBaseMs: 100, maxReconnectMs: 1000,
      onConnectionChange: (v) => events.push(v)
    });
    c.started = true;
    c._setConnected(true);     // simulate "connected"
    c._handleSocketClose(1006); // socket dropped
    assert.deepEqual(events, [true, false]);
    await c.stop();
  });
});

describe('EventSubClient reconnect URL handling', () => {
  let client;

  beforeEach(() => {
    client = new EventSubClient({
      twitchApi: mockTwitchApi(),
      channelLogin: 'testchannel',
      reconnectBaseMs: 100,
      maxReconnectMs: 1000,
      keepaliveGraceMs: 500
    });
  });

  afterEach(async () => { await client.stop(); });

  it('treats a session_reconnect URL as single-use', () => {
    const url = 'wss://cell-a.eventsub.wss.twitch.tv/ws?challenge=abc&id=xyz';
    client.reconnectUrl = url;
    assert.equal(client._takeTargetUrl(), url);
    // Twitch rejects a reused reconnect URL with close code 4007, so the next
    // attempt must fall back to the base endpoint.
    assert.equal(client._takeTargetUrl(), client.socketUrl);
  });

  it('does not re-dial a stale reconnect URL after the reconnect attempt fails', async () => {
    const staleUrl = 'wss://cell-a.eventsub.wss.twitch.tv/ws?challenge=abc&id=xyz';
    const dialed = [];
    client.started = true;
    client.broadcasterId = '12345';
    client._connect = function (url = null) { dialed.push(url || this._takeTargetUrl()); };

    client._handleSessionReconnect(staleUrl);
    // The URL is already dead: Twitch closes with 4007 and no session_welcome
    // ever arrives, so reconnectUrl is never cleared by the welcome handler.
    client._handleSocketClose(4007);
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(dialed.length, 2, 'should have re-dialed once after the 4007 close');
    assert.equal(dialed[0], staleUrl);
    assert.equal(dialed[1], client.socketUrl, 'must fall back to the base endpoint, not the dead URL');
  });
});

describe('EventSubClient subscription auth', () => {
  const realFetch = globalThis.fetch;
  let client;
  let requests;

  function fakeResponse(status) {
    return {
      status, ok: status >= 200 && status < 300,
      json: async () => ({ data: [{ id: 'sub-id' }] }),
      text: async () => ''
    };
  }

  // Twitch answers 401 to any token in `rejected`, 202 otherwise.
  function mockFetch(rejected = new Set()) {
    globalThis.fetch = async (_url, opts) => {
      const token = opts.headers.Authorization.replace('Bearer ', '');
      requests.push({ type: JSON.parse(opts.body).type, token });
      return fakeResponse(rejected.has(token) ? 401 : 202);
    };
  }

  function makeClient(twitchApi) {
    client = new EventSubClient({
      twitchApi, channelLogin: 'testchannel',
      reconnectBaseMs: 100, maxReconnectMs: 1000, keepaliveGraceMs: 500
    });
    client.started = true;
    client.sessionId = 'session-1';
    client.broadcasterId = '12345';
    client.registerSubscription('channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: '' }, () => {});
    client.registerSubscription('stream.online', '1', { broadcaster_user_id: '' }, () => {});
    return client;
  }

  beforeEach(() => { requests = []; });
  afterEach(async () => { globalThis.fetch = realFetch; await client?.stop(); });

  it('creates subscriptions with the broadcaster token, not the bot token', async () => {
    mockFetch();
    makeClient({
      ...mockTwitchApi(),
      getAccessToken: async () => 'bot-token',
      getBroadcasterAccessToken: async () => 'broadcaster-token'
    });

    await client._ensureSubscriptions();

    assert.deepEqual(requests.map((r) => r.token), ['broadcaster-token', 'broadcaster-token']);
    assert.equal(client._subscriptionsCreated, true);
  });

  it('refreshes the token and retries after a 401 instead of reconnecting', async () => {
    mockFetch(new Set(['stale-token']));
    let refreshes = 0;
    makeClient({
      ...mockTwitchApi(),
      getBroadcasterAccessToken: async () => (refreshes ? 'fresh-token' : 'stale-token'),
      refreshBroadcasterAccessToken: async () => { refreshes++; return 'fresh-token'; }
    });
    let reconnects = 0;
    client._reconnect = () => { reconnects++; };

    await client._ensureSubscriptions();

    assert.equal(refreshes, 1);
    assert.equal(reconnects, 0);
    assert.deepEqual(requests.map((r) => r.token), ['stale-token', 'fresh-token', 'fresh-token']);
    assert.equal(client._subscriptionsCreated, true);
  });

  it('backs off between reconnects while the token keeps being rejected', async () => {
    mockFetch(new Set(['dead-token']));
    makeClient({
      ...mockTwitchApi(),
      getBroadcasterAccessToken: async () => 'dead-token',
      refreshBroadcasterAccessToken: async () => null
    });
    // Each re-dial opens a socket and gets a fresh session, as Twitch does.
    let dials = 0;
    client._connect = function () {
      dials++;
      this._handleSocketOpen();
      this._handleSessionWelcome({ id: `session-${dials + 1}`, keepalive_timeout_seconds: 10 });
    };

    await client._ensureSubscriptions();
    const firstDelay = client.currentReconnectDelay;
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(dials, 1);
    assert.equal(client._subscriptionsCreated, false);
    assert.ok(client.currentReconnectDelay > firstDelay,
      `delay should grow (was ${firstDelay}, now ${client.currentReconnectDelay})`);
  });
});
