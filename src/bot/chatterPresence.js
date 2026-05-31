import { EventEmitter } from 'node:events';
import { log } from '../logger.js';

/**
 * Tracks who is currently in chat using the Helix "Get Chatters" API.
 *
 * Twitch IRC JOIN/PART events are not a reliable presence source: without the
 * membership capability they only fire for the bot's own account, and even with
 * it they are batched 30-60s and dropped on large channels. Get Chatters is the
 * authoritative, real(ish)-time list of who is connected to the chat session.
 *
 * Emits:
 *   'join'  { userKey, username } - a user newly appeared since the last poll
 *   'leave' { userKey, username } - a user has been absent for confirmLeaveCycles
 *                                   consecutive polls (and is not recently active)
 */
export class ChatterPresence extends EventEmitter {
  constructor({ twitchApi, channel, botUsername = '', ignoredUsers = new Set(),
    confirmLeaveCycles = 2, recentMessageHoldMs = 5 * 60 * 1000 } = {}) {
    super();
    this.twitchApi = twitchApi;
    this.channel = String(channel || '').toLowerCase();
    this.botUsername = String(botUsername || '').toLowerCase();
    this.ignoredUsers = ignoredUsers;
    this.confirmLeaveCycles = Math.max(1, confirmLeaveCycles);
    this.recentMessageHoldMs = recentMessageHoldMs;

    this.present = new Map();        // userKey -> displayName (authoritative snapshot)
    this._missing = new Map();       // userKey -> consecutive absent-poll count
    this._lastMessageAt = new Map(); // userKey -> timestamp of last chat message
    this._seeded = false;
    this._disabled = false;
    this._authErrorLogged = false;
  }

  isEnabled() { return !this._disabled; }

  /**
   * Record that a user just sent a chat message. Keeps an actively-chatting user
   * from being declared "left" if the Chatters API momentarily lags behind.
   */
  markActive(userKey, displayName) {
    if (!userKey) return;
    this._lastMessageAt.set(userKey, Date.now());
    this._missing.delete(userKey);
    if (this.present.has(userKey) && displayName) this.present.set(userKey, displayName);
  }

  getPresentList() { return [...this.present.keys()]; }
  getPresentCount() { return this.present.size; }

  /** Forget current presence so the next poll re-seeds without emitting joins (use on chat reconnect). */
  reset() {
    this.present.clear();
    this._missing.clear();
    this._seeded = false;
  }

  _isGreetable(userKey) {
    return !!userKey && userKey !== this.botUsername && !this.ignoredUsers.has(userKey);
  }

  /** Poll the Chatters API once and emit join/leave diffs. Safe to call on a scheduler. */
  async poll() {
    if (this._disabled) return;

    let chatters;
    try {
      chatters = await this.twitchApi.getChatters(this.channel);
    } catch (err) {
      const status = err?.statusCode ?? err?.status;
      const msg = err?.message || '';
      const isAuth = status === 401 || status === 403 || /\b(401|403)\b/.test(msg) || /scope/i.test(msg);
      if (isAuth) {
        this._disabled = true;
        if (!this._authErrorLogged) {
          this._authErrorLogged = true;
          log('error', 'ChatterPresence disabled: Get Chatters unauthorized. The broadcaster token ' +
            'needs the "moderator:read:chatters" scope — re-authorize it (see README).');
        }
        return;
      }
      log('warn', `Get Chatters poll failed: ${err?.message || err}`);
      return; // transient — preserve current state, emit nothing
    }
    if (!Array.isArray(chatters)) return; // null/undefined => treat as transient

    const api = new Map();
    for (const c of chatters) {
      const key = (c?.userName || '').toLowerCase();
      if (!key || key === this.botUsername) continue;
      api.set(key, c.displayName || c.userName);
    }

    // First successful poll: adopt the current list silently (these viewers were
    // already here, not new arrivals).
    if (!this._seeded) {
      this.present = api;
      this._missing.clear();
      this._seeded = true;
      log('info', `ChatterPresence seeded with ${this.present.size} existing chatters`);
      return;
    }

    // Joins / refresh
    for (const [key, displayName] of api) {
      const isNew = !this.present.has(key);
      this.present.set(key, displayName);
      this._missing.delete(key);
      if (isNew && this._isGreetable(key)) this.emit('join', { userKey: key, username: displayName });
    }

    // Leaves (confirmed across multiple polls, unless recently active)
    const now = Date.now();
    for (const [key, displayName] of [...this.present]) {
      if (api.has(key)) continue;
      const lastMsg = this._lastMessageAt.get(key) || 0;
      if (now - lastMsg < this.recentMessageHoldMs) continue; // still chatting — hold
      const missing = (this._missing.get(key) || 0) + 1;
      if (missing >= this.confirmLeaveCycles) {
        this.present.delete(key);
        this._missing.delete(key);
        if (this._isGreetable(key)) this.emit('leave', { userKey: key, username: displayName });
      } else {
        this._missing.set(key, missing);
      }
    }

    // Bound the activity map.
    if (this._lastMessageAt.size > 1000) {
      const cutoff = now - this.recentMessageHoldMs;
      for (const [k, ts] of this._lastMessageAt) if (ts < cutoff) this._lastMessageAt.delete(k);
    }
  }
}
