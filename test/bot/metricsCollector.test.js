import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCollector } from '../../src/bot/metricsCollector.js';

describe('MetricsCollector', () => {
  let metrics;
  beforeEach(() => { metrics = new MetricsCollector(); });

  it('increments counters', () => {
    metrics.increment('messagesReceived');
    metrics.increment('messagesReceived');
    const snap = metrics.getSnapshot();
    assert.equal(snap.counters.messagesReceived, 2);
  });

  it('ignores unknown counter keys', () => {
    metrics.increment('bogus');
    const snap = metrics.getSnapshot();
    assert.equal(snap.counters.bogus, undefined);
  });

  it('records AI latency', () => {
    metrics.recordAiLatency(100);
    metrics.recordAiLatency(200);
    const snap = metrics.getSnapshot();
    assert.equal(snap.avgAiLatencyMs, 150);
  });

  it('records errors as ring buffer', () => {
    for (let i = 0; i < 110; i++) metrics.recordError(`err-${i}`);
    const snap = metrics.getSnapshot();
    assert.equal(snap.errors.length, 100);
    assert.equal(snap.errors[0].message, 'err-10');
  });

  it('computes uptime', () => {
    const snap = metrics.getSnapshot();
    assert.ok(snap.uptimeMs >= 0);
  });

  it('includes memory usage', () => {
    const snap = metrics.getSnapshot();
    assert.ok(snap.memory.heapUsed > 0);
    assert.ok(snap.memory.rss > 0);
  });

  it('counts errors in time windows', () => {
    metrics.recordError('recent');
    const snap = metrics.getSnapshot();
    assert.equal(snap.errorsLastHour, 1);
    assert.equal(snap.errorsLast24h, 1);
  });
});
