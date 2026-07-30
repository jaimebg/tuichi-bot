import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StreamAnnouncer } from '../../src/bot/streamAnnouncer.js';

const config = { twitch: { channel: 'micanal' }, resources: { persona: 'P' }, ai: { maxChars: 400 } };

describe('StreamAnnouncer', () => {
  it('usa el fallback sin config de IA, con canal, título y categoría', async () => {
    const a = new StreamAnnouncer({ ai: { groqConfig: null }, config });
    const m = await a.generateStreamStartMessage('Mi título', 'Just Chatting');
    assert.ok(m.includes('micanal'));
    assert.ok(m.includes('Mi título'));
    assert.ok(m.includes('Just Chatting'));
  });

  it('usa el fallback si la IA falla', async () => {
    const a = new StreamAnnouncer({
      ai: { groqConfig: { apiKey: 'x' }, fetchGroqResponse: () => Promise.reject(new Error('boom')) },
      config
    });
    const m = await a.generateStreamStartMessage('T', 'G');
    assert.ok(m.includes('micanal'));
  });

  it('usa la respuesta de la IA cuando funciona', async () => {
    const a = new StreamAnnouncer({
      ai: { groqConfig: { apiKey: 'x' }, fetchGroqResponse: () => Promise.resolve('ya estamos en directo') },
      config
    });
    assert.equal(await a.generateStreamStartMessage('T', 'G'), 'ya estamos en directo');
  });

  it('incluye a los usuarios habituales (excluyendo los ignorados) y el título/categoría en el prompt', async () => {
    const calls = [];
    const userMemory = { memories: new Map([['alice', {}], ['bob', {}], ['ignoreme', {}]]) };
    const configWithExclusions = {
      ...config,
      engagement: { excludedUsers: new Set(['ignoreme']) }
    };
    const a = new StreamAnnouncer({
      ai: {
        groqConfig: { apiKey: 'x' },
        fetchGroqResponse: (msgs) => { calls.push(msgs); return Promise.resolve('ok'); }
      },
      config: configWithExclusions,
      userMemory
    });
    await a.generateStreamStartMessage('Mi título', 'Just Chatting');
    assert.equal(calls.length, 1);
    const userPrompt = calls[0][1].content;
    assert.ok(userPrompt.includes('alice'), 'debe incluir usuarios habituales no excluidos');
    assert.ok(userPrompt.includes('bob'), 'debe incluir usuarios habituales no excluidos');
    assert.ok(!userPrompt.includes('ignoreme'), 'no debe incluir usuarios de la lista de exclusión');
    assert.ok(userPrompt.includes('Mi título'));
    assert.ok(userPrompt.includes('Just Chatting'));
  });

  // generateCategoryChangeMessage isn't covered by the brief's test list; added here
  // for behavior-preservation coverage of its own inline fallback (distinct from
  // streamStartFallback) and its "must contain the required phrase" validation.
  describe('generateCategoryChangeMessage', () => {
    it('usa el fallback inline sin config de IA', async () => {
      const a = new StreamAnnouncer({ ai: { groqConfig: null }, config });
      const m = await a.generateCategoryChangeMessage('Just Chatting', 'Fortnite');
      assert.equal(m, '¡Cambio de categoría! Ahora estamos jugando Fortnite (antes: Just Chatting).');
    });

    it('usa el fallback inline si la IA falla', async () => {
      const a = new StreamAnnouncer({
        ai: { groqConfig: { apiKey: 'x' }, fetchGroqResponse: () => Promise.reject(new Error('boom')) },
        config
      });
      const m = await a.generateCategoryChangeMessage('Just Chatting', 'Fortnite');
      assert.equal(m, '¡Cambio de categoría! Ahora estamos jugando Fortnite (antes: Just Chatting).');
    });

    it('usa la respuesta de la IA cuando incluye la frase requerida', async () => {
      const a = new StreamAnnouncer({
        ai: { groqConfig: { apiKey: 'x' }, fetchGroqResponse: () => Promise.resolve('Ahora estamos en Fortnite, vamos!') },
        config
      });
      const m = await a.generateCategoryChangeMessage('Just Chatting', 'Fortnite');
      assert.equal(m, 'Ahora estamos en Fortnite, vamos!');
    });

    it('vuelve al fallback si la respuesta de la IA no incluye la frase requerida', async () => {
      const a = new StreamAnnouncer({
        ai: { groqConfig: { apiKey: 'x' }, fetchGroqResponse: () => Promise.resolve('cambiamos de juego') },
        config
      });
      const m = await a.generateCategoryChangeMessage('Just Chatting', 'Fortnite');
      assert.equal(m, '¡Cambio de categoría! Ahora estamos jugando Fortnite (antes: Just Chatting).');
    });

    it('incluye el chat reciente (últimos 5 mensajes) en el prompt', async () => {
      const calls = [];
      const recentChat = {
        messages: [
          { displayName: 'Old', message: 'debería quedar fuera (más de 5 atrás)' },
          { displayName: 'Alice', message: 'uno' },
          { displayName: 'Bob', message: 'dos' },
          { displayName: 'Carl', message: 'tres' },
          { displayName: 'Dana', message: 'cuatro' },
          { displayName: 'Eve', message: 'cinco' }
        ]
      };
      const a = new StreamAnnouncer({
        ai: {
          groqConfig: { apiKey: 'x' },
          fetchGroqResponse: (msgs) => { calls.push(msgs); return Promise.resolve('Ahora estamos en Fortnite'); }
        },
        config,
        recentChat
      });
      await a.generateCategoryChangeMessage('Just Chatting', 'Fortnite');
      assert.equal(calls.length, 1);
      const userPrompt = calls[0][1].content;
      assert.ok(userPrompt.includes('Alice: uno'));
      assert.ok(userPrompt.includes('Eve: cinco'));
      assert.ok(!userPrompt.includes('Old:'), 'solo deben incluirse los últimos 5 mensajes');
    });
  });
});
