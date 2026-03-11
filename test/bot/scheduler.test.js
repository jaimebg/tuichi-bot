import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../../src/bot/scheduler.js';

describe('Scheduler', () => {
  let scheduler;
  beforeEach(() => { scheduler = new Scheduler(); });
  afterEach(() => { scheduler.stopAll(); });

  it('registers and runs a task', async () => {
    let count = 0;
    scheduler.register('test', () => { count++; }, 50, { runImmediately: true });
    assert.equal(count, 1);
    await new Promise(r => setTimeout(r, 120));
    assert.ok(count >= 2, `expected count >= 2, got ${count}`);
  });

  it('tracks task status', () => {
    scheduler.register('a', () => {}, 1000);
    const status = scheduler.getStatus();
    assert.ok(status.has('a'));
    assert.equal(status.get('a').runCount, 0);
  });

  it('catches task errors without stopping other tasks', async () => {
    let bRan = false;
    scheduler.register('a', () => { throw new Error('boom'); }, 50, { runImmediately: true });
    scheduler.register('b', () => { bRan = true; }, 50, { runImmediately: true });
    assert.ok(bRan);
    assert.ok(scheduler.getStatus().get('a').lastError.includes('boom'));
  });

  it('unregisters a task', () => {
    scheduler.register('x', () => {}, 1000);
    scheduler.unregister('x');
    assert.equal(scheduler.getStatus().has('x'), false);
  });

  it('stopAll clears everything', () => {
    scheduler.register('a', () => {}, 1000);
    scheduler.register('b', () => {}, 1000);
    scheduler.stopAll();
    assert.equal(scheduler.getStatus().size, 0);
  });
});
