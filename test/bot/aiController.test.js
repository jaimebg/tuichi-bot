import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AiController } from '../../src/bot/aiController.js';

describe('AiController', () => {
  let ai;
  const mockGroqConfig = {
    apiKey: 'test', baseUrl: 'http://localhost', models: ['test-model'],
    temperature: 0.7, timeoutMs: 5000, maxTokens: 100
  };

  beforeEach(() => {
    ai = new AiController({
      groqConfig: mockGroqConfig,
      persona: 'Test persona',
      aiConfig: { maxChars: 200, historyLimit: 5, userCooldownMs: 0, globalCooldownMs: 0 },
      aliases: { alice: 'Alicia' }
    });
  });

  it('respects user cooldown', () => {
    assert.equal(ai.canSendAIResponse('alice'), true);
    ai._recordResponse('alice');
    // With 0ms cooldown, should still be true
    assert.equal(ai.canSendAIResponse('alice'), true);
  });

  it('uses alias in prompt building', () => {
    const alias = ai._getAlias('alice', 'Alice');
    assert.equal(alias, 'Alicia');
  });

  it('falls back to displayName when no alias', () => {
    const alias = ai._getAlias('bob', 'Bob');
    assert.equal(alias, 'Bob');
  });
});
