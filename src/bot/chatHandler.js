import { EventEmitter } from 'node:events';
import { ChatClient } from '@twurple/chat';
import { log } from '../logger.js';
import { normalizeWhitespace } from '../utils/text.js';

/**
 * Wraps @twurple/chat. Emits: 'message', 'join', 'part', 'connected'.
 */
export class ChatHandler extends EventEmitter {
  /**
   * @param {{ authProvider: import('@twurple/auth').AuthProvider, channel: string, botUsername: string }} opts
   */
  constructor({ authProvider, channel, botUsername }) {
    super();
    this.channel = channel.toLowerCase();
    this.botUsername = botUsername.toLowerCase();
    this.client = new ChatClient({
      authProvider,
      channels: [this.channel]
    });
    this._registerHandlers();
    this._lastActivityAt = Date.now();

    // Outgoing message queue (Twitch rate-limit protection)
    this._queue = [];
    this._draining = false;
    this._lastSendAt = 0;
    this._sendIntervalMs = 350;
    this._maxQueueSize = 20;
  }

  _registerHandlers() {
    this.client.onConnect(() => {
      log('info', `Connected to Twitch chat #${this.channel}`);
      this.emit('connected');
      this._lastActivityAt = Date.now();
    });

    this.client.onDisconnect((_manually, reason) => {
      log('warn', `Disconnected from Twitch: ${reason ?? 'unknown'}`);
    });

    this.client.onJoin((channel, user) => {
      if (user.toLowerCase() === this.botUsername) return;
      this.emit('join', { userKey: user.toLowerCase(), username: user });
    });

    this.client.onPart((channel, user) => {
      if (user.toLowerCase() === this.botUsername) return;
      this.emit('part', { userKey: user.toLowerCase(), username: user });
    });

    this.client.onMessage((channel, user, text, msg) => {
      if (user.toLowerCase() === this.botUsername) return;
      this._lastActivityAt = Date.now();
      const trimmed = normalizeWhitespace(text);
      if (!trimmed) return;
      this.emit('message', {
        userKey: user.toLowerCase(),
        displayName: msg.userInfo.displayName || user,
        message: trimmed,
        tags: {
          id: msg.id,
          username: user.toLowerCase(),
          'display-name': msg.userInfo.displayName || user,
          'reply-parent-user-login': msg.parentMessageUserName?.toLowerCase() ?? ''
        },
        msg // raw @twurple message for reply
      });
    });
  }

  async connect() {
    this.client.connect();
  }

  /** Send a message to the channel (queued to respect Twitch rate limits). */
  async sendMessage(text, replyToMsg = null) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return;
    return new Promise((resolve, reject) => {
      if (this._queue.length >= this._maxQueueSize) {
        log('warn', `Send queue full (${this._maxQueueSize}), dropping message`);
        reject(new Error('Send queue full'));
        return;
      }
      this._queue.push({ text: normalized, replyToMsg, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    while (this._queue.length) {
      const item = this._queue.shift();
      const wait = this._sendIntervalMs - (Date.now() - this._lastSendAt);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      try {
        if (item.replyToMsg) {
          await this.client.say(this.channel, item.text, { replyTo: item.replyToMsg });
        } else {
          await this.client.say(this.channel, item.text);
        }
        this._lastSendAt = Date.now();
        item.resolve();
      } catch (err) {
        item.reject(err);
      }
    }
    this._draining = false;
  }

  /** Send a long message, splitting at word boundaries if needed. */
  async sendLongMessage(text, replyToMsg = null) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return;
    const MAX = 500;
    if (normalized.length <= MAX) {
      await this.sendMessage(normalized, replyToMsg);
      return;
    }
    const parts = [];
    let remaining = normalized;
    while (remaining.length > MAX) {
      let cut = MAX;
      while (cut > 0 && remaining[cut] !== ' ') cut--;
      if (cut === 0) cut = MAX;
      parts.push(remaining.substring(0, cut));
      remaining = remaining.substring(cut).trim();
    }
    if (remaining) parts.push(remaining);
    for (const part of parts) {
      await this.sendMessage(part, replyToMsg);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  async disconnect() {
    this.client.quit();
  }

  isHealthy(streamIsOnline = false) {
    const threshold = streamIsOnline ? 10 * 60 * 1000 : 60 * 60 * 1000;
    return (Date.now() - this._lastActivityAt) < threshold;
  }
}
