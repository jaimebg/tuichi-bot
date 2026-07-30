import { log } from '../logger.js';

/**
 * Presence-driven greetings and goodbyes.
 *
 * Consumes the 'join'/'leave' events of `ChatterPresence` (which polls the Helix
 * Get Chatters endpoint) — NOT ChatHandler's 'join'/'part'. Twitch IRC only
 * delivers membership events for the bot's own account without the membership
 * capability, so they're useless as a presence source. ChatterPresence already
 * filters out the bot itself and ignored users before emitting, but the checks
 * here are kept as defense in depth (and to preserve the exact behavior of the
 * code this module was extracted from).
 *
 * Two behaviors are load-bearing:
 *   - Re-greet cooldown: a join is not greeted if `greetedUsers` holds a mark
 *     newer than `greetCooldownMs` (avoids double-greeting someone who flickers
 *     in the Get Chatters listing).
 *   - A confirmed leave forgets the mark (`greetedUsers.delete(userKey)`), so a
 *     genuine rejoin IS greeted again immediately, with no cooldown wait. The
 *     cooldown only suppresses re-greets that were NOT preceded by a leave.
 */
export class Greeter {
  constructor({ chat, greetings, goodbyes, excludedUsers, botUsername,
    greetCooldownMs, inactivityTracker, random = Math.random } = {}) {
    this.chat = chat;
    this.greetings = greetings;
    this.goodbyes = goodbyes;
    this.excludedUsers = excludedUsers;
    this.botUsername = botUsername;
    this.greetCooldownMs = greetCooldownMs;
    this.inactivityTracker = inactivityTracker;
    this.random = random;

    this.enabled = true;
    this._greetedUsers = new Map(); // userKey -> last-greeted timestamp (re-greet cooldown)
  }

  setEnabled(enabled) { this.enabled = !!enabled; }
  isEnabled() { return this.enabled; }

  get greetedUsers() { return this._greetedUsers; }

  /** Discard greeted-marks older than cutoffMs. Used by Bot._saveAll before persisting. */
  pruneGreeted(cutoffMs) {
    for (const [key, ts] of this._greetedUsers) {
      if (ts < cutoffMs) this._greetedUsers.delete(key);
    }
  }

  /** Rehydrate greeted-marks persisted in bot_state (userKey -> epoch ms). */
  loadGreeted(entries) {
    if (!entries) return;
    this._greetedUsers = new Map(Object.entries(entries));
  }

  handlePresenceJoin(userKey, username) {
    if (!this.enabled) return;
    if (userKey === this.botUsername) return;
    if (this.excludedUsers.has(userKey)) return;
    // Re-greet cooldown: don't greet a user we already greeted recently.
    const lastGreeted = this._greetedUsers.get(userKey);
    if (lastGreeted && Date.now() - lastGreeted < this.greetCooldownMs) return;
    this._sendGreeting(userKey, username);
  }

  handlePresenceLeave(userKey, username) {
    if (userKey === this.botUsername) return;
    this.inactivityTracker.clearUser(userKey);
    // Confirmed departure: forget the greeting so a genuine rejoin is greeted again
    // immediately (no cooldown). The cooldown only suppresses re-greets without a leave.
    this._greetedUsers.delete(userKey);
    if (!this.enabled || this.excludedUsers.has(userKey)) return;
    this._sendGoodbye(username);
  }

  _sendGreeting(userKey, username) {
    const text = this.pickGreeting(username);
    this.chat.sendMessage(text).then(() => {
      this._greetedUsers.set(userKey, Date.now());
      log('info', `Greeted ${username}`);
    }).catch(err => log('warn', `Failed to greet ${username}: ${err.message}`));
  }

  pickGreeting(username) {
    const idx = Math.floor(this.random() * this.greetings.length);
    return this.greetings[idx].replace(/\{user\}/g, username);
  }

  _sendGoodbye(username) {
    const text = this.pickGoodbye(username);
    this.chat.sendMessage(text).catch(err =>
      log('warn', `Failed to send goodbye for ${username}: ${err.message}`)
    );
  }

  pickGoodbye(username) {
    const idx = Math.floor(this.random() * this.goodbyes.length);
    return this.goodbyes[idx].replace(/\{user\}/g, username);
  }
}
