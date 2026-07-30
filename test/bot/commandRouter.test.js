import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../src/persistence/database.js';
import { CommandRouter } from '../../src/bot/commandRouter.js';

// metrics.getSnapshot() mirrors the real MetricsCollector shape: counters are
// nested under `.counters`, not spread at the top level (see metricsCollector.js).
function makeRouter() {
  const sent = [];
  // Tracks which chat method each message went out through, so tests can tell
  // sendMessage and sendLongMessage apart — not just their text — and catch a
  // mutation that quietly swaps one for the other (they behave differently on
  // long text: sendLongMessage splits at word boundaries, sendMessage doesn't).
  const calls = [];
  const db = new Database(':memory:');
  let enabled = true;
  const router = new CommandRouter({
    chat: {
      sendMessage: (m) => { calls.push({ method: 'sendMessage', text: m }); sent.push(m); return Promise.resolve(); },
      sendLongMessage: (m) => { calls.push({ method: 'sendLongMessage', text: m }); sent.push(m); return Promise.resolve(); },
      isHealthy: () => true
    },
    config: { twitch: { username: 'mibot', channel: 'micanal' } },
    ownerKey: 'micanal',
    db,
    metrics: {
      startedAt: Date.now(),
      getSnapshot: () => ({ counters: { messagesReceived: 1, messagesSent: 2 } })
    },
    ai: { getCircuitState: () => 'CLOSED' },
    streamMonitor: { isOnline: true },
    greeter: { isEnabled: () => enabled, setEnabled: (v) => { enabled = v; } }
  });
  return { router, sent, calls, db };
}

describe('CommandRouter', () => {
  it('!ayuda responde a cualquiera, vía sendLongMessage, y consume el mensaje', () => {
    const { router, sent, calls, db } = makeRouter();
    assert.equal(router.handle('cualquiera', '!ayuda'), true);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].includes('!poll'));
    assert.equal(calls[0].method, 'sendLongMessage');
    db.close();
  });

  it('el texto de ayuda no menciona !vicky', () => {
    const { router, db } = makeRouter();
    assert.ok(!router.helpText().toLowerCase().includes('vicky'));
    db.close();
  });

  it('el texto de ayuda interpola @botUsername desde config', () => {
    const { router, db } = makeRouter();
    assert.ok(router.helpText().includes('@mibot'));
    db.close();
  });

  it('!status funciona para el owner y reporta cada diagnóstico', () => {
    const { router, sent, db } = makeRouter();
    assert.equal(router.handle('micanal', '!status'), true);
    // Assert on each diagnostic individually (not just a loose "Status" substring)
    // so a mutation that garbles one field's content, order, or icon is caught.
    assert.ok(sent[0].includes('Status'));
    assert.ok(sent[0].includes('Chat: ✅'));
    assert.ok(sent[0].includes('DB: ✅'));
    assert.ok(sent[0].includes('AI: CLOSED'));
    assert.ok(sent[0].includes('Msgs: 1↓ 2↑'));
    db.close();
  });

  it('!status se ignora para quien no es owner', () => {
    const { router, sent, db } = makeRouter();
    assert.equal(router.handle('otra', '!status'), false);
    assert.equal(sent.length, 0);
    db.close();
  });

  it('!saluditos alterna el estado del Greeter', () => {
    const { router, sent, db } = makeRouter();
    assert.equal(router.handle('micanal', '!saluditos'), true);
    assert.ok(sent[0].includes('desactivados'));
    router.handle('micanal', '!saluditos');
    assert.ok(sent[1].includes('activados'));
    db.close();
  });

  it('!saluditos se ignora para quien no es owner', () => {
    const { router, sent, db } = makeRouter();
    assert.equal(router.handle('otra', '!saluditos'), false);
    assert.equal(sent.length, 0);
    db.close();
  });

  it('devuelve false para mensajes que no son comandos suyos', () => {
    const { router, db } = makeRouter();
    assert.equal(router.handle('alguien', 'hola qué tal'), false);
    assert.equal(router.handle('alguien', '!poll a | b'), false);
    db.close();
  });
});
