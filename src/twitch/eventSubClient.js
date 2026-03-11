import WebSocket from 'ws';
import { log } from '../logger.js';

export class EventSubClient {
  constructor({ twitchApi, channelLogin, reconnectBaseMs, maxReconnectMs, keepaliveGraceMs }) {
    this.twitchApi = twitchApi;
    this.channelLogin = channelLogin;
    this.reconnectBaseMs = Number.isFinite(reconnectBaseMs) ? Number(reconnectBaseMs) : 5000;
    this.maxReconnectMs = Number.isFinite(maxReconnectMs) ? Number(maxReconnectMs) : 60000;
    this.keepaliveGraceMs = Number.isFinite(keepaliveGraceMs) ? Number(keepaliveGraceMs) : 15000;

    this._subscriptions = new Map();
    this.socketUrl = 'wss://eventsub.wss.twitch.tv/ws';
    this.ws = null;
    this.started = false;
    this.broadcasterId = null;
    this.sessionId = null;
    this.keepaliveTimeoutMs = 0;
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
    this.reconnectUrl = null;
    this.currentReconnectDelay = this.reconnectBaseMs;
    this._subscriptionsCreated = false;
    this._pendingSubscriptions = false;
  }

  registerSubscription(type, version, condition, callback) {
    this._subscriptions.set(type, { version, condition, callback });
  }

  isConnected() { return this.started && this.ws?.readyState === WebSocket.OPEN; }

  async start() {
    if (this.started) return;
    if (!this.twitchApi) { log('warn', 'EventSubClient requires a TwitchApi instance.'); return; }
    this.started = true;
    this.currentReconnectDelay = this.reconnectBaseMs;
    try {
      await this._ensureBroadcasterId();
      if (!this.broadcasterId) { log('warn', 'Unable to resolve broadcaster ID.'); this.started = false; return; }
      this._connect();
    } catch (err) {
      this.started = false;
      log('warn', `Failed to start EventSubClient: ${err.message}`);
    }
  }

  async stop() {
    this.started = false;
    this.sessionId = null;
    this._subscriptionsCreated = false;
    this._pendingSubscriptions = false;
    this.reconnectUrl = null;
    this.currentReconnectDelay = this.reconnectBaseMs;
    this._clearKeepaliveTimer();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { try { this.ws.terminate(); } catch (_) {} this.ws = null; }
  }

  async _ensureBroadcasterId() {
    if (this.broadcasterId) return;
    const user = await this.twitchApi.getUserByName(this.channelLogin);
    if (!user) throw new Error(`Could not resolve broadcaster for ${this.channelLogin}`);
    this.broadcasterId = user.id;
  }

  _connect(url = null) {
    if (!this.started || !this.broadcasterId) return;
    if (this.ws) { try { this.ws.terminate(); } catch (_) {} this.ws = null; }
    const targetUrl = url || this.socketUrl;
    log('info', `Connecting to Twitch EventSub at ${targetUrl}`);
    const ws = new WebSocket(targetUrl);
    this.ws = ws;

    ws.on('open', () => {
      log('info', 'Connected to Twitch EventSub WebSocket.');
      this.currentReconnectDelay = this.reconnectBaseMs;
    });
    ws.on('message', (data) => this._handleMessage(data));
    ws.on('close', (code) => this._handleSocketClose(code));
    ws.on('error', (err) => {
      log('warn', `EventSub WebSocket error: ${err.message}`);
      if (err.code === 'ECONNREFUSED') log('warn', 'Connection refused - server may be temporarily unavailable');
      else if (err.code === 'ENOTFOUND') log('warn', 'DNS resolution failed - check network connectivity');
    });
  }

  _handleSocketClose(code) {
    this._clearKeepaliveTimer();
    this.ws = null;
    if (!this.started) return;

    // Rate-limited close codes
    const rateLimitCodes = new Set([4002, 4007, 4019, 4020]);
    const is429 = rateLimitCodes.has(code);
    log('warn', `EventSub WebSocket closed (code ${code ?? 0}). Scheduling reconnect.`);
    this._scheduleReconnect(is429);
  }

  _handleMessage(message) {
    const text = typeof message === 'string' ? message : message.toString('utf8');
    let parsed;
    try { parsed = JSON.parse(text); } catch { return; }

    switch (parsed.metadata?.message_type) {
      case 'session_welcome':
        this._handleSessionWelcome(parsed.payload?.session);
        break;
      case 'session_keepalive':
        this._resetKeepaliveTimer();
        break;
      case 'session_reconnect':
        this._handleSessionReconnect(parsed.payload?.session?.reconnect_url);
        break;
      case 'notification':
        this._resetKeepaliveTimer();
        this._handleNotification(parsed);
        break;
      case 'revocation':
        this._handleRevocation(parsed);
        break;
    }
  }

  _handleSessionWelcome(session) {
    if (!session) return;
    this.sessionId = session.id;
    this.reconnectUrl = null;
    this._subscriptionsCreated = false;
    this._pendingSubscriptions = false;
    this.keepaliveTimeoutMs = Number.isFinite(session.keepalive_timeout_seconds)
      ? session.keepalive_timeout_seconds * 1000 : 0;
    this._resetKeepaliveTimer();
    this._ensureSubscriptions();
  }

  _handleSessionReconnect(reconnectUrl) {
    if (!reconnectUrl) { this._scheduleReconnect(); return; }
    log('info', `EventSub session requested reconnect to ${reconnectUrl}`);
    this.reconnectUrl = reconnectUrl;
    this._reconnect(true);
  }

  _handleNotification(message) {
    const subType = message.payload?.subscription?.type;
    const event = message.payload?.event;
    if (!subType || !event) return;

    const sub = this._subscriptions.get(subType);
    if (!sub) return;

    try { sub.callback(event); }
    catch (err) { log('warn', `Error processing EventSub notification (${subType}): ${err.message}`); }
  }

  _handleRevocation(message) {
    const type = message.payload?.subscription?.type;
    const reason = message.payload?.subscription?.status;
    log('warn', `EventSub subscription revoked (${type || 'unknown'}): ${reason || 'no reason'}`);
    this._subscriptionsCreated = false;
    this._ensureSubscriptions();
  }

  _resetKeepaliveTimer() {
    this._clearKeepaliveTimer();
    if (!this.keepaliveTimeoutMs) return;
    this.keepaliveTimer = setTimeout(() => {
      log('warn', 'EventSub keepalive missed; reconnecting.');
      this._reconnect();
    }, this.keepaliveTimeoutMs + this.keepaliveGraceMs);
  }

  _clearKeepaliveTimer() {
    if (this.keepaliveTimer) { clearTimeout(this.keepaliveTimer); this.keepaliveTimer = null; }
  }

  _scheduleReconnect(is429 = false) {
    if (!this.started || this.reconnectTimer) return;
    let delay = Math.min(this.currentReconnectDelay, this.maxReconnectMs);
    if (is429) {
      delay = Math.max(delay, 30000);
      log('warn', `EventSub rate limited. Waiting ${Math.round(delay / 1000)}s before reconnecting.`);
    } else {
      log('info', `Reconnecting to EventSub in ${Math.round(delay / 1000)}s`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect(this.reconnectUrl || this.socketUrl);
    }, delay);
    this.currentReconnectDelay = Math.min(this.currentReconnectDelay * 1.5, this.maxReconnectMs);
  }

  _reconnect(immediate = false) {
    this._clearKeepaliveTimer();
    if (this.ws) { try { this.ws.terminate(); } catch (_) {} this.ws = null; }
    if (!this.started) return;
    this._subscriptionsCreated = false;
    this._pendingSubscriptions = false;
    if (immediate) {
      this.currentReconnectDelay = this.reconnectBaseMs;
      this._connect(this.reconnectUrl || this.socketUrl);
    } else {
      this._scheduleReconnect();
    }
  }

  async _ensureSubscriptions() {
    if (!this.started || this._subscriptionsCreated || this._pendingSubscriptions) return;
    if (!this.sessionId || !this.broadcasterId) return;
    this._pendingSubscriptions = true;

    const clientId = this.twitchApi.authProvider.clientId;
    const token = await this.twitchApi.getAccessToken();
    if (!token) { log('warn', 'EventSubClient: no access token available.'); this._pendingSubscriptions = false; return; }

    let allOk = true;
    for (const [type, { version, condition }] of this._subscriptions) {
      try {
        const resolvedCondition = { ...condition };
        // Auto-fill broadcaster_user_id if condition uses it
        if ('broadcaster_user_id' in resolvedCondition && !resolvedCondition.broadcaster_user_id) {
          resolvedCondition.broadcaster_user_id = this.broadcasterId;
        }

        const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
          method: 'POST',
          headers: {
            'Client-Id': clientId,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            type, version,
            condition: resolvedCondition,
            transport: { method: 'websocket', session_id: this.sessionId }
          })
        });

        if (response.status === 409) {
          log('info', `EventSub subscription already exists: ${type}`);
          continue;
        }
        if (response.status === 429) {
          log('warn', `Subscription rate limited for ${type}. Will retry.`);
          allOk = false;
          this._scheduleReconnect(true);
          break;
        }
        if (response.status === 401) {
          log('warn', `Subscription auth failed for ${type}. Reconnecting.`);
          allOk = false;
          this._reconnect();
          break;
        }
        if (!response.ok) {
          const errText = await response.text();
          log('warn', `Subscription failed for ${type} (${response.status}): ${errText}`);
          allOk = false;
          continue;
        }
        const payload = await response.json();
        const subId = payload?.data?.[0]?.id;
        log('info', `EventSub subscription ready: ${type} (${subId || 'ok'})`);
      } catch (err) {
        log('warn', `Failed to create subscription ${type}: ${err.message}`);
        allOk = false;
      }
    }
    this._subscriptionsCreated = allOk;
    this._pendingSubscriptions = false;
  }
}
