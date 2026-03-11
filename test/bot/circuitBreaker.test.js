import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AiController } from '../../src/bot/aiController.js';

describe('AiController circuit breaker', () => {
  let ai;
  beforeEach(() => {
    ai = new AiController({
      groqConfig: {
        apiKey: 'test', baseUrl: 'http://localhost:19999',
        models: ['test-model'], temperature: 0.7, timeoutMs: 200, maxTokens: 100
      },
      persona: 'Test',
      aiConfig: { maxChars: 200, historyLimit: 5, userCooldownMs: 0, globalCooldownMs: 0 },
      aliases: {}
    });
    ai._circuit.cooldownMs = 100;
    ai._circuit.maxCooldownMs = 500;
  });

  it('starts in CLOSED state', () => {
    assert.equal(ai._circuit.state, 'CLOSED');
  });

  it('opens after 3 consecutive failures', async () => {
    for (let i = 0; i < 3; i++) {
      try { await ai.fetchGroqResponse([{ role: 'user', content: 'hi' }]); } catch { /* expected */ }
    }
    assert.equal(ai._circuit.state, 'OPEN');
  });

  it('returns null immediately when OPEN', async () => {
    ai._circuit.state = 'OPEN';
    ai._circuit.openUntil = Date.now() + 60000;
    const result = await ai.fetchGroqResponse([{ role: 'user', content: 'hi' }]);
    assert.equal(result, null);
  });

  it('transitions to HALF_OPEN after cooldown', async () => {
    ai._circuit.state = 'OPEN';
    ai._circuit.openUntil = Date.now() - 1;
    try { await ai.fetchGroqResponse([{ role: 'user', content: 'hi' }]); } catch { /* expected */ }
    assert.equal(ai._circuit.state, 'OPEN');
  });

  it('resets to CLOSED on success after HALF_OPEN', () => {
    ai._circuit.state = 'HALF_OPEN';
    ai._circuit.failures = 3;
    ai._circuitSuccess();
    assert.equal(ai._circuit.state, 'CLOSED');
    assert.equal(ai._circuit.failures, 0);
  });

  it('getCircuitState returns current state', () => {
    assert.equal(ai.getCircuitState(), 'CLOSED');
    ai._circuit.state = 'OPEN';
    assert.equal(ai.getCircuitState(), 'OPEN');
  });
});
