import { execFile } from 'node:child_process';
import { log } from '../logger.js';

export class Watchdog {
  constructor() {
    this._available = !!process.env.NOTIFY_SOCKET;
    if (this._available) {
      log('info', 'systemd watchdog: NOTIFY_SOCKET detected');
    }
  }

  isAvailable() { return this._available; }

  notifyReady() {
    if (!this._available) return Promise.resolve();
    return this._send(['--ready']);
  }

  notifyWatchdog() {
    if (!this._available) return Promise.resolve();
    return this._send(['WATCHDOG=1']);
  }

  _send(args) {
    return new Promise((resolve) => {
      execFile('systemd-notify', args, (err) => {
        if (err) log('debug', `systemd-notify failed: ${err.message}`);
        resolve();
      });
    });
  }
}
