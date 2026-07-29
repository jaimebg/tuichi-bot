import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  spontaneousReplySystemPrompt, streamStartFallback, shameSystemPrompt
} from '../../src/bot/prompts.js';

describe('prompts', () => {
  it('interpola el canal en el prompt de respuesta espontánea', () => {
    const p = spontaneousReplySystemPrompt({
      persona: 'PERSONA', channel: 'micanal', contextText: '\nContexto: CONTEXTO_DE_PRUEBA', maxChars: 400
    });
    assert.ok(p.includes('micanal'));
    assert.ok(p.includes('PERSONA'));
    assert.ok(p.includes('400'));
    assert.ok(p.includes('CONTEXTO_DE_PRUEBA'));
    assert.ok(!p.toLowerCase().includes('jaimevarecto'));
  });

  it('el fallback de inicio de directo incluye título y categoría', () => {
    const m = streamStartFallback({ channelDisplayName: 'MiCanal', title: 'Mi título', game: 'Just Chatting' });
    assert.ok(m.includes('MiCanal'));
    assert.ok(m.includes('Mi título'));
    assert.ok(m.includes('Just Chatting'));
  });

  it('interpola el canal y la persona en el prompt de vergüenza', () => {
    const s = shameSystemPrompt({ persona: 'PERSONA', channel: 'micanal' });
    assert.ok(s.includes('micanal'));
    assert.ok(s.includes('PERSONA'));
  });

  it('ningún prompt contiene el canal original hardcodeado', () => {
    const args = { persona: 'P', channel: 'micanal' };
    for (const fn of [spontaneousReplySystemPrompt, shameSystemPrompt]) {
      assert.ok(!fn(args).toLowerCase().includes('jaimevarecto'), `${fn.name} sigue hardcodeado`);
    }
  });
});
