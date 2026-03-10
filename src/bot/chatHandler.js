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
  }

  _registerHandlers() {
    this.client.onConnect(() => {
      log('info', `Connected to Twitch chat #${this.channel}`);
      this.emit('connected');
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

  /** Send a message to the channel. */
  async sendMessage(text, replyToMsg = null) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return;
    if (replyToMsg) {
      await this.client.say(this.channel, normalized, { replyTo: replyToMsg });
    } else {
      await this.client.say(this.channel, normalized);
    }
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
}
