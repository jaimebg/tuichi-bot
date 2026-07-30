import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AmbientResponder } from '../../src/bot/ambientResponder.js';
import { spontaneousReplySystemPrompt } from '../../src/bot/prompts.js';

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

/**
 * Builds an AmbientResponder with fully-overridable fake deps. Defaults mirror
 * the brief's makeDeps: chances at 1, cooldowns/delays at 0, random at 0 (so a
 * roll of `random() >= chance` never fires unless the test asks for it) — every
 * probabilistic guard defaults to "pass" so each test only needs to arrange the
 * one guard it's targeting.
 */
function makeDeps({
  random = () => 0,
  ai: aiOverrides = {},
  config: configOverrides = {},
  recentChat: recentChatOverrides = {},
  userMemory: userMemoryOverrides = {},
  streamMonitor: streamMonitorOverrides = {},
  mediaOverlay = null,
  fetchReply = 'respuesta de la IA'
} = {}) {
  const sent = [];
  const sendCalls = [];
  const fetchCalls = [];
  const recorded = [];

  const ai = {
    groqConfig: null,
    maxChars: 400,
    pendingRequests: new Set(),
    _getAlias: (userKey, displayName) => displayName,
    _recordResponse: (userKey) => recorded.push(userKey),
    fetchGroqResponse: async (msgs) => { fetchCalls.push(msgs); return fetchReply; },
    ...aiOverrides
  };

  const config = {
    twitch: { username: 'mibot', channel: 'micanal' },
    singleWordEchoChance: 1, singleWordEchoDelayMs: 0,
    spontaneousReplyChance: 1, spontaneousReplyCooldownMs: 0,
    intelligence: { autoTriggerChance: 1 },
    resources: { persona: 'P' },
    ...configOverrides
  };

  const recentChat = { getRecentContext: () => '', ...recentChatOverrides };
  const userMemory = { getUserSummary: () => null, ...userMemoryOverrides };
  const streamMonitor = { currentGame: null, ...streamMonitorOverrides };

  const responder = new AmbientResponder({
    chat: { sendMessage: (m, replyTo) => { sent.push(m); sendCalls.push({ m, replyTo }); return Promise.resolve(); } },
    ai, config, recentChat, userMemory, streamMonitor, mediaOverlay, random
  });

  return { sent, sendCalls, fetchCalls, recorded, ai, config, responder };
}

describe('AmbientResponder', () => {

  describe('handleSingleWordEcho', () => {
    it('repite mensajes de una sola palabra', async () => {
      const { sent, responder } = makeDeps();
      responder.handleSingleWordEcho('kappa', {});
      await tick();
      assert.deepEqual(sent, ['kappa']);
    });

    it('no repite mensajes de varias palabras', async () => {
      const { sent, responder } = makeDeps();
      responder.handleSingleWordEcho('dos palabras', {});
      await tick();
      assert.equal(sent.length, 0);
    });

    it('no repite comandos ni menciones', async () => {
      const { sent, responder } = makeDeps();
      responder.handleSingleWordEcho('!poll', {});
      responder.handleSingleWordEcho('@alguien', {});
      await tick();
      assert.equal(sent.length, 0);
    });

    it('no repite cuando el dado sale por encima de la probabilidad', async () => {
      // NOTA: con singleWordEchoChance = 1 (el default de este helper) la condición
      // `random() >= chance` nunca puede ser cierta con random() en [0,1), así que el
      // guard de probabilidad sería inobservable. Se baja la probabilidad a 0.5 para
      // que un roll de 0.99 quede por encima y dispare el guard.
      const { sent, responder } = makeDeps({ config: { singleWordEchoChance: 0.5 }, random: () => 0.99 });
      responder.handleSingleWordEcho('kappa', {});
      await tick();
      assert.equal(sent.length, 0);
    });

    it('no repite si la probabilidad de eco está deshabilitada (chance <= 0)', async () => {
      const { sent, responder } = makeDeps({ config: { singleWordEchoChance: 0 } });
      responder.handleSingleWordEcho('kappa', {});
      await tick();
      assert.equal(sent.length, 0);
    });

    it('no repite si el mensaje es respuesta al propio bot', async () => {
      const { sent, responder } = makeDeps();
      responder.handleSingleWordEcho('kappa', { 'reply-parent-user-login': 'MiBot' });
      await tick();
      assert.equal(sent.length, 0);
    });

    it('aplica el delay configurado antes de enviar', async () => {
      const { sent, responder } = makeDeps({ config: { singleWordEchoDelayMs: 30 } });
      responder.handleSingleWordEcho('kappa', {});
      assert.equal(sent.length, 0, 'no debe enviar sincrónicamente cuando hay delay configurado');
      await tick(50);
      assert.deepEqual(sent, ['kappa']);
    });
  });

  describe('handleSpontaneousReply', () => {
    it('no intenta respuesta espontánea sin config de IA', async () => {
      const { sent, responder } = makeDeps();
      await responder.handleSpontaneousReply({ userKey: 'a', displayName: 'A', message: 'hola', msg: {} });
      assert.equal(sent.length, 0);
    });

    it('no responde si la probabilidad está deshabilitada (chance <= 0)', async () => {
      const { sent, fetchCalls, responder } = makeDeps({
        ai: { groqConfig: {} }, config: { spontaneousReplyChance: 0 }
      });
      await responder.handleSpontaneousReply({ userKey: 'a', displayName: 'A', message: 'hola', msg: {} });
      assert.equal(fetchCalls.length, 0);
      assert.equal(sent.length, 0);
    });

    it('no responde a mensajes que empiezan por ! o @', async () => {
      const { fetchCalls, responder } = makeDeps({ ai: { groqConfig: {} } });
      await responder.handleSpontaneousReply({ userKey: 'a', displayName: 'A', message: '!comando', msg: {} });
      await responder.handleSpontaneousReply({ userKey: 'a', displayName: 'A', message: '@alguien hola', msg: {} });
      assert.equal(fetchCalls.length, 0);
    });

    it('no responde si el mensaje menciona al bot', async () => {
      const { fetchCalls, responder } = makeDeps({ ai: { groqConfig: {} } });
      await responder.handleSpontaneousReply({ userKey: 'a', displayName: 'A', message: 'hola @MiBot que tal', msg: {} });
      assert.equal(fetchCalls.length, 0);
    });

    it('respeta el cooldown global desde la última respuesta espontánea', async () => {
      const { fetchCalls, sent, responder } = makeDeps({
        ai: { groqConfig: {} }, config: { spontaneousReplyCooldownMs: 60_000 }
      });
      await responder.handleSpontaneousReply({ userKey: 'a', displayName: 'A', message: 'primero', msg: {} });
      assert.equal(sent.length, 1, 'la primera respuesta debería enviarse');
      await responder.handleSpontaneousReply({ userKey: 'b', displayName: 'B', message: 'segundo', msg: {} });
      assert.equal(fetchCalls.length, 1, 'el cooldown global debe bloquear la segunda petición, incluso de otro usuario');
      assert.equal(sent.length, 1);
    });

    it('no responde cuando el dado sale por encima de la probabilidad', async () => {
      const { fetchCalls, responder } = makeDeps({
        ai: { groqConfig: {} }, config: { spontaneousReplyChance: 0.05 }, random: () => 0.5
      });
      await responder.handleSpontaneousReply({ userKey: 'a', displayName: 'A', message: 'hola', msg: {} });
      assert.equal(fetchCalls.length, 0);
    });

    it('no responde si ya hay una petición pendiente para ese usuario', async () => {
      const pendingRequests = new Set(['spontaneous:a']);
      const { fetchCalls, responder } = makeDeps({
        ai: { groqConfig: {}, pendingRequests }
      });
      await responder.handleSpontaneousReply({ userKey: 'a', displayName: 'A', message: 'hola', msg: {} });
      assert.equal(fetchCalls.length, 0);
      assert.ok(pendingRequests.has('spontaneous:a'), 'la marca pre-existente no debería tocarse al salir por este guard');
    });

    it('usa spontaneousReplySystemPrompt para el mensaje de sistema', async () => {
      const { fetchCalls, responder } = makeDeps({ ai: { groqConfig: {} } });
      await responder.handleSpontaneousReply({ userKey: 'a', displayName: 'Alice', message: 'hola a todos', msg: {} });
      assert.equal(fetchCalls.length, 1);
      const expected = spontaneousReplySystemPrompt({
        persona: 'P', channel: 'micanal', contextText: '', maxChars: 400
      });
      assert.equal(fetchCalls[0][0].role, 'system');
      assert.equal(fetchCalls[0][0].content, expected);
    });

    it('envía la respuesta, marca el cooldown y limpia la petición pendiente', async () => {
      const { sent, sendCalls, recorded, ai, responder } = makeDeps({
        ai: { groqConfig: {} }, fetchReply: 'una respuesta genial'
      });
      const msg = { id: 'msg-1' };
      await responder.handleSpontaneousReply({ userKey: 'a', displayName: 'Alice', message: 'hola', msg });
      assert.deepEqual(sent, ['una respuesta genial']);
      assert.equal(sendCalls[0].replyTo, msg);
      assert.deepEqual(recorded, ['a']);
      assert.equal(ai.pendingRequests.has('spontaneous:a'), false);
    });

    it('no envía nada si la IA devuelve null (circuit breaker abierto)', async () => {
      const { sent, ai, responder } = makeDeps({ ai: { groqConfig: {} }, fetchReply: null });
      await responder.handleSpontaneousReply({ userKey: 'a', displayName: 'Alice', message: 'hola', msg: {} });
      assert.equal(sent.length, 0);
      assert.equal(ai.pendingRequests.has('spontaneous:a'), false, 'debe limpiar la petición pendiente incluso sin enviar');
    });

    it('no envía nada si la respuesta queda vacía tras normalizar', async () => {
      const { sent, responder } = makeDeps({ ai: { groqConfig: {} }, fetchReply: '   ' });
      await responder.handleSpontaneousReply({ userKey: 'a', displayName: 'Alice', message: 'hola', msg: {} });
      assert.equal(sent.length, 0);
    });
  });

  describe('handleAutoTriggerMedia', () => {
    it('no dispara nada sin mediaOverlay configurado', () => {
      const { responder } = makeDeps({ mediaOverlay: null });
      assert.doesNotThrow(() => responder.handleAutoTriggerMedia('me encanta este video', 'Alice'));
    });

    it('dispara el reward de video/audio cuyo título coincide con una palabra del mensaje', () => {
      const triggered = [];
      const mediaOverlay = {
        rewardNameMap: {
          'Fancy Video Reward': { type: 'video' },
          'Some Audio Clip': { type: 'audio' },
          'Image Only': { type: 'image' }
        },
        triggerByTitle: (title, displayName) => triggered.push({ title, displayName })
      };
      const { responder } = makeDeps({ mediaOverlay });
      responder.handleAutoTriggerMedia('me encanta ese video genial', 'Alice');
      assert.deepEqual(triggered, [{ title: 'Fancy Video Reward', displayName: 'Alice' }]);
    });

    it('ignora rewards que no son de tipo video/audio aunque el título coincida', () => {
      const triggered = [];
      const mediaOverlay = {
        rewardNameMap: { 'Image Only': { type: 'image' } },
        triggerByTitle: (title, displayName) => triggered.push({ title, displayName })
      };
      const { responder } = makeDeps({ mediaOverlay });
      responder.handleAutoTriggerMedia('quiero ver image ahora', 'Alice');
      assert.equal(triggered.length, 0);
    });

    it('no dispara si ninguna palabra del mensaje coincide con un título', () => {
      const triggered = [];
      const mediaOverlay = {
        rewardNameMap: { 'Fancy Video Reward': { type: 'video' } },
        triggerByTitle: (title, displayName) => triggered.push({ title, displayName })
      };
      const { responder } = makeDeps({ mediaOverlay });
      responder.handleAutoTriggerMedia('sin coincidencias aquí', 'Alice');
      assert.equal(triggered.length, 0);
    });

    it('respeta la probabilidad de auto-trigger', () => {
      const triggered = [];
      const mediaOverlay = {
        rewardNameMap: { 'Fancy Video Reward': { type: 'video' } },
        triggerByTitle: (title, displayName) => triggered.push({ title, displayName })
      };
      const { responder } = makeDeps({
        mediaOverlay, config: { intelligence: { autoTriggerChance: 0.1 } }, random: () => 0.5
      });
      responder.handleAutoTriggerMedia('me encanta ese video genial', 'Alice');
      assert.equal(triggered.length, 0);
    });
  });
});
