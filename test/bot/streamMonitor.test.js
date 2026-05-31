import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StreamMonitor } from '../../src/bot/streamMonitor.js';

/** Mock TwitchApi.getStreamByUserName returning each value in `seq` on successive calls. */
function mockApi(seq) {
  let i = 0;
  return {
    getStreamByUserName: async () => {
      const v = seq[Math.min(i, seq.length - 1)];
      i++;
      return v;
    }
  };
}

const liveInfo = { title: 'T', gameName: 'G', startedAt: '2024-01-01T00:00:00Z' };

describe('StreamMonitor', () => {
  it('does NOT announce live on the first (seed) check', async () => {
    const sm = new StreamMonitor({ twitchApi: mockApi([liveInfo]), channel: 'x' });
    let announced = 0;
    sm.on('live', () => announced++);

    await sm.check();

    assert.equal(announced, 0, 'startup state must not re-announce stream start');
    assert.equal(sm.isOnline, true, 'state is still seeded as online');
  });

  it('announces live on a genuine offline -> online transition', async () => {
    const sm = new StreamMonitor({ twitchApi: mockApi([null, liveInfo]), channel: 'x' });
    let announced = 0;
    sm.on('live', () => announced++);

    await sm.check(); // seed (offline)
    await sm.check(); // offline -> online

    assert.equal(announced, 1);
  });

  it('does NOT announce offline on the first (seed) check', async () => {
    const sm = new StreamMonitor({ twitchApi: mockApi([null]), channel: 'x' });
    let offline = 0;
    sm.on('offline', () => offline++);

    await sm.check();

    assert.equal(offline, 0);
    assert.equal(sm.isOnline, false);
  });

  it('setEventSubConnected toggles state and reschedules the poll timer', () => {
    const sm = new StreamMonitor({ twitchApi: mockApi([null]), channel: 'x', pollIntervalMs: 5000, fallbackIntervalMs: 1000 });
    sm._schedulePolling();
    assert.equal(sm._eventSubConnected, false);
    assert.ok(sm._timer);

    sm.setEventSubConnected(true);
    assert.equal(sm._eventSubConnected, true);
    assert.ok(sm._timer);

    sm.stop();
    assert.equal(sm._timer, null);
  });
});
