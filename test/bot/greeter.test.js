import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Greeter } from '../../src/bot/greeter.js';

function makeGreeter({ random = () => 0, greetCooldownMs = 60000 } = {}) {
  const sent = [];
  const cleared = [];
  const greeter = new Greeter({
    chat: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); } },
    greetings: ['hola {user}'],
    goodbyes: ['adios {user}'],
    excludedUsers: new Set(['streamelements']),
    botUsername: 'mibot',
    greetCooldownMs,
    inactivityTracker: { clearUser: (k) => cleared.push(k) },
    random
  });
  return { greeter, sent, cleared };
}

const tick = () => new Promise(r => setTimeout(r, 10));

describe('Greeter', () => {
  let greeter, sent, cleared;
  beforeEach(() => { ({ greeter, sent, cleared } = makeGreeter()); });

  it('sustituye {user} en saludos y despedidas', () => {
    assert.equal(greeter.pickGreeting('Alice'), 'hola Alice');
    assert.equal(greeter.pickGoodbye('Alice'), 'adios Alice');
  });

  it('saluda a quien entra', async () => {
    greeter.handlePresenceJoin('alice', 'Alice');
    await tick();
    assert.deepEqual(sent, ['hola Alice']);
  });

  it('despide a quien sale', async () => {
    greeter.handlePresenceLeave('alice', 'Alice');
    await tick();
    assert.deepEqual(sent, ['adios Alice']);
  });

  it('no saluda a usuarios excluidos ni a sí mismo', async () => {
    greeter.handlePresenceJoin('streamelements', 'StreamElements');
    greeter.handlePresenceJoin('mibot', 'MiBot');
    await tick();
    assert.equal(sent.length, 0);
  });

  it('no saluda ni despide cuando está deshabilitado', async () => {
    greeter.setEnabled(false);
    greeter.handlePresenceJoin('alice', 'Alice');
    greeter.handlePresenceLeave('bob', 'Bob');
    await tick();
    assert.equal(sent.length, 0);
  });

  it('respeta el cooldown de re-saludo si no ha habido salida', async () => {
    greeter.handlePresenceJoin('alice', 'Alice');
    await tick();
    greeter.handlePresenceJoin('alice', 'Alice');
    await tick();
    assert.equal(sent.length, 1, 'saludó dos veces dentro del cooldown');
  });

  it('vuelve a saludar tras una salida confirmada, sin esperar el cooldown', async () => {
    greeter.handlePresenceJoin('alice', 'Alice');
    await tick();
    greeter.handlePresenceLeave('alice', 'Alice');
    await tick();
    greeter.handlePresenceJoin('alice', 'Alice');
    await tick();
    assert.deepEqual(sent, ['hola Alice', 'adios Alice', 'hola Alice']);
  });

  it('limpia el tracker de inactividad al salir', async () => {
    greeter.handlePresenceLeave('alice', 'Alice');
    await tick();
    assert.deepEqual(cleared, ['alice']);
  });

  it('pruneGreeted descarta las marcas anteriores al corte', async () => {
    greeter.handlePresenceJoin('alice', 'Alice');
    await tick();
    greeter.pruneGreeted(Date.now() + 1000);
    assert.equal(greeter.greetedUsers.size, 0);
  });

  it('loadGreeted rehidrata las marcas persistidas', () => {
    greeter.loadGreeted({ alice: Date.now() });
    assert.ok(greeter.greetedUsers.has('alice'));
  });
});
