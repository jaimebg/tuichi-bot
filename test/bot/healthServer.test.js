// test/bot/healthServer.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HealthServer } from '../../src/bot/healthServer.js';
import { MetricsCollector } from '../../src/bot/metricsCollector.js';

// Minimal mock objects
function mockBot() {
  return {
    chat: { isHealthy: () => true },
    db: { raw: { prepare: () => ({ get: () => ({ v: 1 }) }) } },
    streamMonitor: { isOnline: true, currentGame: 'Test', currentTitle: 'Title' },
    messageLogger: { getTopUsers: () => [{ displayName: 'Alice', messageCount: 5 }] },
    chatterPresence: { getPresentCount: () => 1 },
    userMemory: { memories: new Map([['alice', {}]]) }
  };
}

describe('HealthServer', () => {
  let server, metrics;
  const PORT = 19876; // avoid conflicts

  beforeEach(async () => {
    metrics = new MetricsCollector();
    server = new HealthServer({ port: PORT, apiKey: 'test-key', bot: mockBot(), metrics });
    await server.start();
  });

  afterEach(async () => { await server.stop(); });

  it('GET /health returns 200 when healthy', async () => {
    const res = await fetch(`http://localhost:${PORT}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  it('GET /metrics requires API key', async () => {
    const res = await fetch(`http://localhost:${PORT}/metrics`);
    assert.equal(res.status, 401);
  });

  it('GET /metrics returns data with valid API key', async () => {
    const res = await fetch(`http://localhost:${PORT}/metrics`, {
      headers: { Authorization: 'Bearer test-key' }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.uptimeMs >= 0);
  });

  it('GET /api/status returns summary without auth', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/status`);
    assert.equal(res.status, 200);
  });

  it('returns 405 for unsupported methods', async () => {
    const res = await fetch(`http://localhost:${PORT}/health`, { method: 'POST' });
    assert.equal(res.status, 405);
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`http://localhost:${PORT}/unknown`);
    assert.equal(res.status, 404);
  });

  it('isSystemHealthy returns boolean', () => {
    assert.equal(server.isSystemHealthy(), true);
  });
});
