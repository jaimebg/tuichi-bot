import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Watchdog } from '../../src/bot/watchdog.js';

describe('Watchdog', () => {
  const originalEnv = process.env.NOTIFY_SOCKET;
  afterEach(() => {
    if (originalEnv !== undefined) process.env.NOTIFY_SOCKET = originalEnv;
    else delete process.env.NOTIFY_SOCKET;
  });

  it('isAvailable returns false without NOTIFY_SOCKET', () => {
    delete process.env.NOTIFY_SOCKET;
    const wd = new Watchdog();
    assert.equal(wd.isAvailable(), false);
  });

  it('notifyReady is a no-op without NOTIFY_SOCKET', async () => {
    delete process.env.NOTIFY_SOCKET;
    const wd = new Watchdog();
    await wd.notifyReady();
  });

  it('notifyWatchdog is a no-op without NOTIFY_SOCKET', async () => {
    delete process.env.NOTIFY_SOCKET;
    const wd = new Watchdog();
    await wd.notifyWatchdog();
  });
});
