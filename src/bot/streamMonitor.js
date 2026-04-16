import { EventEmitter } from 'node:events';
import { log } from '../logger.js';

/**
 * Monitors stream status. Emits: 'live', 'offline', 'categoryChange'.
 *
 * Primary: EventSub notifications via handleLive()/handleOffline().
 * Fallback: Polling for category changes (every 5min) or full status (every 60s if EventSub is down).
 */
export class StreamMonitor extends EventEmitter {
  constructor({ twitchApi, channel, pollIntervalMs = 300000, fallbackIntervalMs = 60000 }) {
    super();
    this.twitchApi = twitchApi;
    this.channel = channel;
    this.pollIntervalMs = pollIntervalMs;          // 5 min (category change only)
    this.fallbackIntervalMs = fallbackIntervalMs;   // 60s (full check, no EventSub)
    this.isOnline = false;
    this.currentGame = null;
    this.currentTitle = null;
    this.streamStartTime = null;
    this._timer = null;
    this._eventSubConnected = false;
    this._eventSubLiveAt = 0; // timestamp of last EventSub live confirmation
  }

  start() {
    if (this._timer) return;
    this._schedulePolling();
    log('info', 'Started stream monitoring');
    this.check(); // initial check
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    log('info', 'Stopped stream monitoring');
  }

  /** Called by EventSubClient when stream.online fires */
  handleLive(event) {
    if (this.isOnline) return; // already known
    this.isOnline = true;
    this._eventSubLiveAt = Date.now();
    this.streamStartTime = event.started_at ? new Date(event.started_at).getTime() : Date.now();
    log('info', 'Stream went live (via EventSub)');
    // Fetch title/game from API then emit 'live'
    this._fetchAndEmitLive();
  }

  /** Called by EventSubClient when stream.offline fires */
  handleOffline() {
    if (!this.isOnline) return; // already known
    this.isOnline = false;
    this._eventSubLiveAt = 0;
    this.currentGame = null;
    this.currentTitle = null;
    this.streamStartTime = null;
    log('info', 'Stream went offline (via EventSub)');
    this.emit('offline');
  }

  setEventSubConnected(connected) {
    if (this._eventSubConnected === connected) return;
    this._eventSubConnected = connected;
    log('info', `StreamMonitor: EventSub ${connected ? 'connected' : 'disconnected'}, adjusting poll interval`);
    // Reschedule polling with appropriate interval
    if (this._timer) {
      clearInterval(this._timer);
      this._schedulePolling();
    }
  }

  _schedulePolling() {
    const interval = this._eventSubConnected ? this.pollIntervalMs : this.fallbackIntervalMs;
    this._timer = setInterval(() => this.check(), interval);
  }

  /**
   * Fetch stream info from API and emit 'live'. Used by handleLive() so EventSub
   * always triggers the live event even if the API lags behind.
   */
  async _fetchAndEmitLive() {
    try {
      const info = await this.twitchApi.getStreamByUserName(this.channel);
      if (info) {
        this.currentGame = info.gameName;
        this.currentTitle = info.title;
      }
    } catch (err) {
      log('warn', `Stream info fetch after EventSub live failed: ${err.message}`);
    }
    // Always emit — EventSub is authoritative for online/offline state
    this.emit('live', { title: this.currentTitle || '', game: this.currentGame || '' });
  }

  /** Poll-based check. Only emits events when EventSub hasn't recently confirmed state. */
  async check() {
    try {
      const info = await this.twitchApi.getStreamByUserName(this.channel);
      const wasOnline = this.isOnline;
      const previousGame = this.currentGame;

      if (info) {
        this.isOnline = true;
        this.currentGame = info.gameName;
        this.currentTitle = info.title;
        this.streamStartTime = new Date(info.startedAt).getTime();
        if (!wasOnline) {
          this.emit('live', { title: info.title, game: info.gameName });
        } else if (previousGame && previousGame !== this.currentGame) {
          this.emit('categoryChange', { previous: previousGame, current: this.currentGame, title: this.currentTitle });
        }
      } else {
        // Guard: don't contradict EventSub within 60s (API may lag behind)
        if (this._eventSubLiveAt && Date.now() - this._eventSubLiveAt < 60_000) {
          log('debug', 'API returned null but EventSub recently confirmed live, ignoring');
          return;
        }
        this.isOnline = false;
        if (wasOnline) this.emit('offline');
      }
    } catch (err) {
      log('warn', `Stream check failed: ${err.message}`);
    }
  }
}
