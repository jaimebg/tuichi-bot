// test/intelligence/userContextStore.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../src/persistence/database.js';
import { UserContextStore } from '../../src/intelligence/userContextStore.js';

function sampleContext(userKey, ts) {
  return {
    userKey, displayName: userKey, firstSeen: ts, lastSeen: ts,
    messageCount: 1, averageLength: 5, activeHours: [], personality: [],
    themes: [], topWords: [], commands: [], preferences: {}, metadata: {}
  };
}

describe('UserContextStore', () => {
  it('recarga firstSeen y lastSeen sin NaN (regresión del parche +Z sobre ISO)', async () => {
    const db = new Database(':memory:');
    const store = new UserContextStore(db);
    const now = Date.now();
    store.updateFromMemory(sampleContext('alice', now));
    await store.flush();

    const reloaded = new UserContextStore(db);
    reloaded.loadExistingContexts();
    const ctx = reloaded.contexts.get('alice');

    assert.ok(ctx, 'no se recargó el contexto de alice');
    assert.ok(!Number.isNaN(ctx.firstSeen), 'firstSeen es NaN');
    assert.ok(!Number.isNaN(ctx.lastSeen), 'lastSeen es NaN');
    const skewMinutes = Math.abs(now - ctx.firstSeen) / 60000;
    assert.ok(skewMinutes < 1, `desfase de ${skewMinutes} minutos en firstSeen`);
    db.close();
  });

  it('el orden LRU de desalojo usa lastSeen real, no NaN degradado a 0', async () => {
    const db = new Database(':memory:');
    const store = new UserContextStore(db);
    const ahora = Date.now();
    const antiguo = ahora - 30 * 86400000;
    store.updateFromMemory(sampleContext('reciente', ahora));
    store.updateFromMemory(sampleContext('antigua', antiguo));
    await store.flush();

    const reloaded = new UserContextStore(db);
    reloaded.loadExistingContexts();

    assert.ok(
      reloaded.contexts.get('reciente').lastSeen > reloaded.contexts.get('antigua').lastSeen,
      'lastSeen recargado no distingue reciente de antigua'
    );
    db.close();
  });

  it('deja firstSeen/lastSeen en null cuando la columna está vacía', () => {
    const db = new Database(':memory:');
    db.context.upsert({ userId: 'sinfechas', displayName: 'Sin Fechas' });
    const store = new UserContextStore(db);
    store.loadExistingContexts();
    const ctx = store.contexts.get('sinfechas');
    assert.equal(ctx.lastSeen, null);
    db.close();
  });
});
