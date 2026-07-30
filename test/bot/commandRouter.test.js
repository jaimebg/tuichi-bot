import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../src/persistence/database.js';
import { CommandRouter } from '../../src/bot/commandRouter.js';

// metrics.getSnapshot() mirrors the real MetricsCollector shape: counters are
// nested under `.counters`, not spread at the top level (see metricsCollector.js).
//
// `overrides.chat`/`overrides.ai`/`overrides.metrics` let individual tests force
// the unhealthy/degraded branches of !status (chat down, AI circuit not CLOSED,
// different counters) without duplicating the whole harness. `overrides.db`
// lets a test hand the router a db stand-in whose `raw.prepare(...).get()`
// throws, to exercise the DB-probe-failed branch -- the in-memory sqlite `db`
// this function always creates (and that callers must still `.close()`) is
// kept separate from that, so cleanup never depends on which db the router
// itself was wired with.
function makeRouter(overrides = {}) {
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
      isHealthy: () => true,
      ...overrides.chat
    },
    config: { twitch: { username: 'mibot', channel: 'micanal' } },
    ownerKey: 'micanal',
    db: overrides.db ?? db,
    metrics: {
      startedAt: Date.now(),
      getSnapshot: () => ({ counters: { messagesReceived: 1, messagesSent: 2 } }),
      ...overrides.metrics
    },
    ai: { getCircuitState: () => 'CLOSED', ...overrides.ai },
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

  it('!status funciona para el owner y reporta cada diagnóstico cuando todo está sano', () => {
    const { router, sent, db } = makeRouter();
    assert.equal(router.handle('micanal', '!status'), true);
    // Assert on each diagnostic individually (not just a loose "Status" substring)
    // so a mutation that garbles, hardcodes, or deletes any one field is caught.
    // chatOk=true && dbOk=true (both mocks/real-db healthy) -> overall "OK", not
    // "Problemas"; the unhealthy branch is exercised by the two tests below.
    assert.ok(sent[0].includes('✅ OK'));
    assert.ok(!sent[0].includes('⚠️ Problemas'));
    assert.ok(sent[0].includes('Chat: ✅'));
    assert.ok(sent[0].includes('DB: ✅'));
    assert.ok(sent[0].includes('AI: CLOSED'));
    assert.ok(sent[0].includes('Msgs: 1↓ 2↑'));
    // Uptime and Mem are dynamic fields with no injectable seam (real
    // Date.now()/process.memoryUsage()), but their mere *presence* is still
    // something a mutation can delete without any other assertion noticing --
    // pin both, including the exact "0h0m" (elapsed time between makeRouter()
    // capturing metrics.startedAt and this synchronous call is sub-millisecond,
    // so uptimeS is deterministically 0 here).
    assert.ok(sent[0].includes('Uptime: 0h0m'));
    assert.match(sent[0], /Mem: \d+MB/);
    db.close();
  });

  it('!status reporta "Problemas" y "Chat: ❌" cuando el chat no está sano (DB sigue OK)', () => {
    const { router, sent, db } = makeRouter({ chat: { isHealthy: () => false } });
    assert.equal(router.handle('micanal', '!status'), true);
    assert.ok(sent[0].includes('⚠️ Problemas'));
    assert.ok(!sent[0].includes('✅ OK'));
    assert.ok(sent[0].includes('Chat: ❌'));
    assert.ok(sent[0].includes('DB: ✅'));
    db.close();
  });

  it('!status reporta "Problemas" y "DB: ❌" cuando el probe de la base de datos falla (chat sigue OK)', () => {
    const failingDb = { raw: { prepare: () => { throw new Error('boom'); } } };
    const { router, sent, db } = makeRouter({ db: failingDb });
    assert.equal(router.handle('micanal', '!status'), true);
    assert.ok(sent[0].includes('⚠️ Problemas'));
    assert.ok(!sent[0].includes('✅ OK'));
    assert.ok(sent[0].includes('DB: ❌'));
    assert.ok(sent[0].includes('Chat: ✅'));
    db.close(); // closes makeRouter's own in-memory db, not the failingDb stand-in
  });

  it('!status interpola el estado real del circuito de IA, no un valor fijo', () => {
    const { router, sent, db } = makeRouter({ ai: { getCircuitState: () => 'OPEN' } });
    assert.equal(router.handle('micanal', '!status'), true);
    assert.ok(sent[0].includes('AI: OPEN'));
    assert.ok(!sent[0].includes('AI: CLOSED'));
    db.close();
  });

  it('!status interpola los contadores reales de mensajes, no valores fijos', () => {
    const { router, sent, db } = makeRouter({
      metrics: { getSnapshot: () => ({ counters: { messagesReceived: 42, messagesSent: 7 } }) }
    });
    assert.equal(router.handle('micanal', '!status'), true);
    assert.ok(sent[0].includes('Msgs: 42↓ 7↑'));
    assert.ok(!sent[0].includes('Msgs: 1↓ 2↑'));
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
