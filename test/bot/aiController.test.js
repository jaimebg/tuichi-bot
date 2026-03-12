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

  describe('extractIntelligence — Spanish traits', () => {
    let mockMemory;

    beforeEach(() => {
      mockMemory = {
        _traits: [],
        _themes: [],
        addPersonalityTrait(userKey, trait) { this._traits.push(trait); },
        addConversationTheme(userKey, theme) { this._themes.push(theme); }
      };
    });

    it('detects graciosa from jajaja', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'jajaja que bueno');
      assert.ok(mockMemory._traits.includes('graciosa'));
    });

    it('detects graciosa from jaja (short form)', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'jaja buenisimo');
      assert.ok(mockMemory._traits.includes('graciosa'));
    });

    it('detects graciosa from xdd', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'buenisimo xdd');
      assert.ok(mockMemory._traits.includes('graciosa'));
    });

    it('detects agradecida from gracias', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'gracias por la info');
      assert.ok(mockMemory._traits.includes('agradecida'));
    });

    it('detects intensa from short message with !', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'VAMOS!');
      assert.ok(mockMemory._traits.includes('intensa'));
    });

    it('does not detect intensa from long message with !', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'que bonito dia hace hoy no crees!');
      assert.ok(!mockMemory._traits.includes('intensa'));
    });

    it('does not detect intensa from punctuation-only message', () => {
      ai.extractIntelligence(mockMemory, 'user1', '???!!!');
      assert.ok(!mockMemory._traits.includes('intensa'));
    });

    it('detects curiosa from interrogative word', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'que haces esta noche');
      assert.ok(mockMemory._traits.includes('curiosa'));
    });

    it('does not detect curiosa from bare ?', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'en serio?');
      assert.ok(!mockMemory._traits.includes('curiosa'));
    });

    it('detects colegui from illo', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'illo que pasa');
      assert.ok(mockMemory._traits.includes('colegui'));
    });

    it('detects colegui from crack', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'eres un crack');
      assert.ok(mockMemory._traits.includes('colegui'));
    });

    it('detects flirty from guapa', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'hola guapa');
      assert.ok(mockMemory._traits.includes('flirty'));
    });

    it('detects flirty from cielo', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'ay cielo que mona');
      assert.ok(mockMemory._traits.includes('flirty'));
    });

    it('detects borde_cariñosa from cabrona', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'eres una cabrona');
      assert.ok(mockMemory._traits.includes('borde_cariñosa'));
    });

    it('detects borde_cariñosa from accented imbécil', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'eres imbécil o que');
      assert.ok(mockMemory._traits.includes('borde_cariñosa'));
    });

    it('detects malhablada from hostia', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'hostia que fuerte');
      assert.ok(mockMemory._traits.includes('malhablada'));
    });

    it('detects multiple traits from one message', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'jajaja gracias illo');
      assert.ok(mockMemory._traits.includes('graciosa'));
      assert.ok(mockMemory._traits.includes('agradecida'));
      assert.ok(mockMemory._traits.includes('colegui'));
    });

    it('produces no traits from empty message', () => {
      ai.extractIntelligence(mockMemory, 'user1', '');
      assert.equal(mockMemory._traits.length, 0);
    });

    it('produces no traits from emoji-only message', () => {
      ai.extractIntelligence(mockMemory, 'user1', '😂😂😂');
      assert.equal(mockMemory._traits.length, 0);
    });

    it('produces no traits from punctuation-only message', () => {
      ai.extractIntelligence(mockMemory, 'user1', '???!!!...');
      assert.equal(mockMemory._traits.length, 0);
    });

    it('does not produce old English traits', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'lol thanks haha');
      assert.ok(!mockMemory._traits.includes('humorous'));
      assert.ok(!mockMemory._traits.includes('polite'));
    });
  });

  describe('extractIntelligence — Spanish themes', () => {
    let mockMemory;

    beforeEach(() => {
      mockMemory = {
        _traits: [],
        _themes: [],
        addPersonalityTrait(userKey, trait) { this._traits.push(trait); },
        addConversationTheme(userKey, theme) { this._themes.push(theme); }
      };
    });

    it('detects gaming from jugar', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'vamos a jugar');
      assert.ok(mockMemory._themes.includes('gaming'));
    });

    it('detects tecnologia from programar', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'estoy aprendiendo a programar');
      assert.ok(mockMemory._themes.includes('tecnologia'));
    });

    it('detects tecnologia from accented código', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'el código tiene un bug');
      assert.ok(mockMemory._themes.includes('tecnologia'));
    });

    it('detects musica from cancion', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'que cancion es esta');
      assert.ok(mockMemory._themes.includes('musica'));
    });

    it('detects curro from trabajo', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'estoy hasta arriba de trabajo');
      assert.ok(mockMemory._themes.includes('curro'));
    });

    it('detects comida from cocinar', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'hoy me toca cocinar');
      assert.ok(mockMemory._themes.includes('comida'));
    });

    it('detects deporte from gym', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'vengo del gym reventada');
      assert.ok(mockMemory._themes.includes('deporte'));
    });

    it('detects puterio from fiesta', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'vamos de fiesta o que');
      assert.ok(mockMemory._themes.includes('puterio'));
    });

    it('detects series from netflix', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'que veis en netflix');
      assert.ok(mockMemory._themes.includes('series'));
    });

    it('detects cotilleo from drama', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'menudo drama se ha liado');
      assert.ok(mockMemory._themes.includes('cotilleo'));
    });

    it('produces no themes from empty message', () => {
      ai.extractIntelligence(mockMemory, 'user1', '');
      assert.equal(mockMemory._themes.length, 0);
    });

    it('does not produce old English themes', () => {
      ai.extractIntelligence(mockMemory, 'user1', 'playing a game and listening to music');
      assert.ok(!mockMemory._themes.includes('gaming'));
      assert.ok(!mockMemory._themes.includes('music'));
    });
  });
});
