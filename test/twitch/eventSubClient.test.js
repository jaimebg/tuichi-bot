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
