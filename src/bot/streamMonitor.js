import { EventEmitter } from 'node:events';
import { log } from '../logger.js';

/**
 * Polls stream status. Emits: 'live', 'offline', 'categoryChange'.
 */
export class StreamMonitor extends EventEmitter {
  constructor({ twitchApi, channel, intervalMs = 60000 }) {
    super();
    this.twitchApi = twitchApi;
    this.channel = channel;
    this.intervalMs = intervalMs;
    this.isOnline = false;
    this.currentGame = null;
    this.currentTitle = null;
    this.streamStartTime = null;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.check(), this.intervalMs);
    log('info', 'Started stream monitoring');
    this.check(); // initial check
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    log('info', 'Stopped stream monitoring');
  }

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
        this.isOnline = false;
        if (wasOnline) this.emit('offline');
      }
    } catch (err) {
      log('warn', `Stream check failed: ${err.message}`);
    }
  }
}
