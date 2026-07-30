import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PersonaResponder } from '../../src/bot/personaResponder.js';

/**
 * Builds a PersonaResponder with fully-overridable fake deps. Mock method
 * names mirror what bot.js actually calls on these collaborators today:
 * `userContextStore.getContextSnapshot` and `conversationThreads.getThread`
 * (not `getPromptContext` / `getThreadMessages`).
 */
function makeResponder({
  groqConfig = { apiKey: 'x' },
  pendingRequests = new Set(),
  waitForCooldown = () => Promise.resolve(true),
  fetchGroqResponse = () => Promise.resolve('respuesta de prueba'),
  conversationThreadsOverrides = {},
  botUsername = 'mibot'
} = {}) {
  const sent = [];
  const sendCalls = [];
  const addMessageCalls = [];
  const recorded = [];

  const ai = {
    groqConfig,
    maxChars: 400,
    pendingRequests,
    waitForCooldown,
    fetchGroqResponse,
    buildChatMessages: () => [],
    _getAlias: (k, d) => d,
    _recordResponse: (userKey) => recorded.push(userKey)
  };

  const conversationThreads = {
    getOrCreateThread: () => 't1',
    addMessage: (...args) => addMessageCalls.push(args),
    getThread: () => [],
    ...conversationThreadsOverrides
  };

  const responder = new PersonaResponder({
    chat: { sendMessage: (m, replyTo) => { sent.push(m); sendCalls.push({ m, replyTo }); return Promise.resolve(); } },
    ai,
    config: { twitch: { username: botUsername, channel: 'micanal' }, resources: { persona: 'P' }, ai: { historyLimit: 5 } },
    conversationThreads,
    userMemory: { getUserSummary: () => null },
    userContextStore: { getContextSnapshot: () => null },
    recentChat: { getRecentContext: () => '' },
    streamMonitor: { currentGame: null },
    metrics: { increment: () => {} }
  });

  return { sent, sendCalls, addMessageCalls, recorded, ai, conversationThreads, responder };
}

describe('PersonaResponder', () => {
  describe('respondToMention', () => {
    it('no responde sin config de IA', async () => {
      const { sent, responder } = makeResponder({ groqConfig: null });
      await responder.respondToMention({
        userKey: 'a', displayName: 'A', message: '@mibot hola',
        msg: {}, mentionContext: '', threadId: 't1', timestamp: Date.now()
      });
      assert.equal(sent.length, 0);
    });

    it('responde cuando hay config de IA', async () => {
      const { sent, responder } = makeResponder();
      await responder.respondToMention({
        userKey: 'a', displayName: 'A', message: '@mibot hola',
        msg: {}, mentionContext: '', threadId: 't1', timestamp: Date.now()
      });
      assert.equal(sent.length, 1);
      assert.equal(sent[0], 'respuesta de prueba');
    });

    it('bloquea una segunda llamada mientras la primera sigue en curso (guard de pendingRequests)', async () => {
      // Exercises the real protective window of `pendingRequests`: once a call has
      // passed the cooldown wait and added the userKey, an overlapping call for the
      // same user must be dropped until the in-flight Groq fetch settles. (Note: a
      // *perfectly simultaneous* pair of calls launched via Promise.all — as in an
      // earlier draft of this test — races both past the `.has()` check before either
      // reaches `.add()`, because the check happens before the cooldown await and the
      // add happens after it. That race is a pre-existing property of the original
      // `_respondToMention` in bot.js, not something introduced here, so it is not
      // asserted against.)
      //
      // Each invocation of fetchGroqResponse gets its OWN resolver, tracked
      // independently in `fetchResolvers`. This matters: an earlier draft used a
      // single shared `resolveFetch` variable, so if the guard regressed and a
      // second call also reached fetchGroqResponse, the second call would silently
      // clobber `resolveFetch`, leaving the first call's promise unresolvable
      // forever -- the test would hang instead of failing (and `node --test` runs
      // with no --test-timeout, so a hang here wedges the whole suite rather than
      // reporting red). With independent resolvers, a guard regression is caught
      // by a synchronous, immediate assertion (fetchResolvers.length) rather than
      // by ever needing to resolve a promise nobody is holding a handle to.
      const fetchResolvers = [];
      const fetchGroqResponse = () => new Promise((resolve) => { fetchResolvers.push(resolve); });
      const { sent, responder } = makeResponder({ fetchGroqResponse });
      const args = {
        userKey: 'a', displayName: 'A', message: '@mibot hola',
        msg: {}, mentionContext: '', threadId: 't1', timestamp: Date.now()
      };

      const first = responder.respondToMention(args);
      // Let the first call clear waitForCooldown and reach pendingRequests.add()
      // before the in-flight fetchGroqResponse.
      await new Promise((r) => setTimeout(r, 0));

      const second = responder.respondToMention(args);
      // Give the second call a chance to run to its own first await (or return
      // early if the guard blocks it) without depending on real wall-clock time.
      await new Promise((r) => setTimeout(r, 0));

      assert.equal(sent.length, 0, 'nada debe haberse enviado mientras la primera sigue en curso');
      assert.equal(fetchResolvers.length, 1,
        'la segunda llamada no debe haber llegado a invocar fetchGroqResponse (debe quedar bloqueada por el guard)');

      fetchResolvers[0]('respuesta de prueba');
      await Promise.all([first, second]);
      assert.equal(sent.length, 1, 'la primera llamada sí debe completarse y enviar una vez resuelta');
    });

    it('cierra la carrera TOCTOU: dos mentions del mismo usuario solapadas durante waitForCooldown producen un solo envío', async () => {
      // Reproduces the empirically-confirmed bug: the guard used to check
      // `pendingRequests.has(userKey)` BEFORE awaiting `waitForCooldown`, and
      // only `.add(userKey)` AFTER it resolved. Two calls landing inside that
      // wait both cleared the guard before either had marked itself, so both
      // went on to fetch and send. `waitForCooldown` here genuinely waits (a
      // real setTimeout, not an immediately-resolved promise) so the second
      // call's guard check happens while the first is still mid-wait -- the
      // actual window described in the bug report.
      let waitForCooldownCalls = 0;
      const waitForCooldown = () => new Promise((resolve) => {
        waitForCooldownCalls++;
        setTimeout(() => resolve(true), 20);
      });
      const { sent, ai, responder } = makeResponder({ waitForCooldown });
      const args = (msg) => ({
        userKey: 'race', displayName: 'R', message: '@mibot hola',
        msg, mentionContext: '', threadId: 't1', timestamp: Date.now()
      });

      const first = responder.respondToMention(args({ id: 'first' }));
      // Land the second call inside the first call's cooldown wait window,
      // well before its 20ms setTimeout fires.
      await new Promise((r) => setTimeout(r, 5));
      const second = responder.respondToMention(args({ id: 'second' }));

      await Promise.all([first, second]);

      assert.equal(sent.length, 1, 'una única mención concurrente del mismo usuario debe producir un único envío');
      assert.equal(ai.pendingRequests.has('race'), false, 'la marca no debe quedar filtrada tras resolverse ambas llamadas');
      assert.ok(waitForCooldownCalls >= 1);
    });

    it('respeta el guard de pendingRequests ya activo para ese usuario', async () => {
      const pendingRequests = new Set(['a']);
      const { sent, responder } = makeResponder({ pendingRequests });
      await responder.respondToMention({
        userKey: 'a', displayName: 'A', message: '@mibot hola',
        msg: {}, mentionContext: '', threadId: 't1', timestamp: Date.now()
      });
      assert.equal(sent.length, 0);
    });

    it('no responde si waitForCooldown resuelve false, y no filtra la marca de pendingRequests', async () => {
      // The slot is reserved (added) BEFORE awaiting waitForCooldown, so this
      // `!ready` early-return path must still release it via the `finally` --
      // otherwise this userKey would never get a reply again for the life of
      // the process.
      const pendingRequests = new Set();
      const { sent, responder } = makeResponder({ pendingRequests, waitForCooldown: () => Promise.resolve(false) });
      await responder.respondToMention({
        userKey: 'a', displayName: 'A', message: '@mibot hola',
        msg: {}, mentionContext: '', threadId: 't1', timestamp: Date.now()
      });
      assert.equal(sent.length, 0);
      assert.equal(pendingRequests.has('a'), false, 'pendingRequests no debe quedar bloqueado cuando waitForCooldown resuelve false');
    });

    it('envía el mensaje de fallback del circuit breaker cuando la respuesta es null', async () => {
      const { sent, responder } = makeResponder({ fetchGroqResponse: () => Promise.resolve(null) });
      await responder.respondToMention({
        userKey: 'a', displayName: 'A', message: '@mibot hola',
        msg: {}, mentionContext: '', threadId: 't1', timestamp: Date.now()
      });
      assert.equal(sent.length, 1);
      assert.match(sent[0], /problemas para pensar/);
    });

    it('envía un mensaje de fallback cuando la respuesta clampeada queda vacía', async () => {
      const { sent, responder } = makeResponder({ fetchGroqResponse: () => Promise.resolve('   ') });
      await responder.respondToMention({
        userKey: 'a', displayName: 'A', message: '@mibot hola',
        msg: {}, mentionContext: '', threadId: 't1', timestamp: Date.now()
      });
      assert.equal(sent.length, 1);
      assert.match(sent[0], /problema para procesar/);
    });

    it('envía la respuesta como reply pasando el objeto msg original', async () => {
      const rawMsg = { id: 'msg-123' };
      const { sendCalls, responder } = makeResponder();
      await responder.respondToMention({
        userKey: 'a', displayName: 'A', message: '@mibot hola',
        msg: rawMsg, mentionContext: '', threadId: 't1', timestamp: Date.now()
      });
      assert.equal(sendCalls.length, 1);
      assert.equal(sendCalls[0].replyTo, rawMsg);
    });

    it('registra el mensaje de usuario y de asistente en el hilo, y llama _recordResponse', async () => {
      const { addMessageCalls, recorded, responder } = makeResponder();
      const timestamp = 12345;
      await responder.respondToMention({
        userKey: 'a', displayName: 'A', message: '@mibot hola',
        msg: {}, mentionContext: '', threadId: 't1', timestamp
      });
      assert.equal(addMessageCalls.length, 2);
      assert.equal(addMessageCalls[0][0], 't1');
      assert.equal(addMessageCalls[0][1], 'user');
      assert.equal(addMessageCalls[0][2], '@mibot hola');
      assert.equal(addMessageCalls[0][3], timestamp);
      assert.equal(addMessageCalls[1][0], 't1');
      assert.equal(addMessageCalls[1][1], 'assistant');
      assert.equal(addMessageCalls[1][2], 'respuesta de prueba');
      assert.deepEqual(recorded, ['a']);
    });

    it('elimina siempre la guarda pendingRequests, incluso si la petición falla', async () => {
      const pendingRequests = new Set();
      const { responder } = makeResponder({
        pendingRequests,
        fetchGroqResponse: () => Promise.reject(new Error('boom'))
      });
      await responder.respondToMention({
        userKey: 'a', displayName: 'A', message: '@mibot hola',
        msg: {}, mentionContext: '', threadId: 't1', timestamp: Date.now()
      });
      assert.equal(pendingRequests.has('a'), false, 'pendingRequests no debe quedar bloqueado tras un error');
    });
  });

  describe('handleMention', () => {
    it('ignora mensajes que ni mencionan ni responden al bot', () => {
      const { sent, conversationThreads, responder } = makeResponder();
      let created = false;
      conversationThreads.getOrCreateThread = () => { created = true; return 't1'; };
      responder.handleMention({
        userKey: 'a', displayName: 'A', message: 'hola a todos',
        tags: {}, msg: {}, timestamp: Date.now()
      });
      assert.equal(created, false);
      assert.equal(sent.length, 0);
    });

    it('detecta una mención por substring, en minúsculas', async () => {
      // hasMention lowercases the incoming message but NOT the configured
      // username, so the mention token itself must already be lowercase
      // (matching how config.twitch.username is populated in practice).
      const { sent, responder } = makeResponder({ botUsername: 'mibot' });
      responder.handleMention({
        userKey: 'a', displayName: 'A', message: 'oye @MIBOT hola',
        tags: {}, msg: {}, timestamp: Date.now()
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(sent.length, 1);
    });

    it('detecta una reply al bot vía reply-parent-user-login (case-insensitive)', async () => {
      const { sent, responder } = makeResponder({ botUsername: 'mibot' });
      responder.handleMention({
        userKey: 'a', displayName: 'A', message: 'sin mención directa',
        tags: { 'reply-parent-user-login': 'MiBot' }, msg: {}, timestamp: Date.now()
      });
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(sent.length, 1);
    });

    it('no responde a una reply dirigida a otro usuario', () => {
      const { sent, responder } = makeResponder({ botUsername: 'mibot' });
      responder.handleMention({
        userKey: 'a', displayName: 'A', message: 'sin mención directa',
        tags: { 'reply-parent-user-login': 'otrousuario' }, msg: {}, timestamp: Date.now()
      });
      assert.equal(sent.length, 0);
    });

    it('pasa isReplyToBot y replyParentLogin correctos a getOrCreateThread', () => {
      const { conversationThreads, responder } = makeResponder({ botUsername: 'mibot' });
      let captured = null;
      conversationThreads.getOrCreateThread = (userKey, isReplyToBot, replyParentLogin) => {
        captured = { userKey, isReplyToBot, replyParentLogin };
        return 't1';
      };
      responder.handleMention({
        userKey: 'a', displayName: 'A', message: 'sin mención directa',
        tags: { 'reply-parent-user-login': 'MiBot' }, msg: {}, timestamp: Date.now()
      });
      assert.deepEqual(captured, { userKey: 'a', isReplyToBot: true, replyParentLogin: 'mibot' });
    });

    it('no espera (fire-and-forget) la resolución de respondToMention', async () => {
      // A wall-clock assertion here (e.g. `Date.now() - start < 5`) is vacuous:
      // an async function always returns control to its caller at its own first
      // internal `await`, whether or not THAT caller happens to `await` the
      // result -- so timing looks identical whether handleMention fires
      // respondToMention and forgets it, or is itself `async` and internally
      // `await`s it (proven empirically: both versions show `sent.length === 0`
      // immediately and `sent.length === 1` ~10ms later). The real, deterministic
      // discriminator is the *return value*: a plain synchronous function that
      // never awaits its own body returns `undefined` on the spot; an `async`
      // function always returns a thenable/Promise, regardless of whether the
      // caller uses it.
      const { sent, responder } = makeResponder();
      const args = {
        userKey: 'a', displayName: 'A', message: '@mibot hola',
        tags: {}, msg: {}, timestamp: Date.now()
      };

      const returnValue = responder.handleMention(args);

      assert.equal(returnValue, undefined,
        'handleMention no debe devolver una promesa (no debe ser async ni esperar a respondToMention)');
      assert.equal(sent.length, 0, 'nada debe haberse enviado de forma síncrona');

      // The fire-and-forget chain still completes on its own once it's had a
      // chance to run.
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(sent.length, 1, 'el envío fire-and-forget sí debe completarse eventualmente');
    });
  });
});
