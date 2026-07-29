// test/intelligence/userMemory.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../src/persistence/database.js';
import { UserMemory } from '../../src/intelligence/userMemory.js';

describe('UserMemory', () => {
  it('recarga firstSeen y lastSeen sin desfase de zona horaria', () => {
    const db = new Database(':memory:');
    const memory = new UserMemory(db, 100, 7);
    memory.updateEngagement('alice', 'hola', Date.now(), { displayName: 'Alice' });
    memory.save();

    const reloaded = new UserMemory(db, 100, 7);
    reloaded.load();
    const data = reloaded.getUserData('alice');

    assert.ok(!Number.isNaN(data.firstSeen), 'firstSeen es NaN');
    const skewMinutes = Math.abs(Date.now() - data.firstSeen) / 60000;
    assert.ok(skewMinutes < 1, `desfase de ${skewMinutes} minutos en firstSeen`);

    assert.ok(!Number.isNaN(data.engagementPattern.lastSeen), 'lastSeen es NaN');
    const lastSeenSkewMinutes = Math.abs(Date.now() - data.engagementPattern.lastSeen) / 60000;
    assert.ok(lastSeenSkewMinutes < 1, `desfase de ${lastSeenSkewMinutes} minutos en lastSeen`);
    db.close();
  });

  it('conserva displayName y estructura al recargar', () => {
    const db = new Database(':memory:');
    const memory = new UserMemory(db, 100, 7);
    memory.updateEngagement('bob', 'me gustan los gatos', Date.now(), { displayName: 'Bob' });
    memory.save();

    const reloaded = new UserMemory(db, 100, 7);
    reloaded.load();

    assert.equal(reloaded.memories.size, 1);
    assert.ok(reloaded.memories.has('bob'));
    assert.equal(reloaded.getUserData('bob').metadata.displayName, 'Bob');
    db.close();
  });

  it('no produce NaN si first_seen/last_seen vienen vacíos en la BD', () => {
    const db = new Database(':memory:');
    db.raw.prepare("INSERT INTO user_memory (user_id, first_seen, last_seen) VALUES ('sinfechas', NULL, NULL)").run();

    const memory = new UserMemory(db, 100, 7);
    memory.load();
    // Lee directamente del Map, sin pasar por getUserData(): ese método repara
    // en el sitio un firstSeen falsy (incluido NaN), lo que enmascararía
    // justo el bug que este test debe detectar.
    const data = memory.memories.get('sinfechas');

    assert.ok(data, 'no se cargó el registro sinfechas');
    assert.ok(data.firstSeen !== null, 'firstSeen es null');
    assert.ok(!Number.isNaN(data.firstSeen), 'firstSeen es NaN');
    const firstSeenSkew = Math.abs(Date.now() - data.firstSeen) / 60000;
    assert.ok(firstSeenSkew < 1, `desfase de ${firstSeenSkew} minutos en firstSeen`);

    assert.ok(data.engagementPattern.lastSeen !== null, 'lastSeen es null');
    assert.ok(!Number.isNaN(data.engagementPattern.lastSeen), 'lastSeen es NaN');
    const lastSeenSkew = Math.abs(Date.now() - data.engagementPattern.lastSeen) / 60000;
    assert.ok(lastSeenSkew < 1, `desfase de ${lastSeenSkew} minutos en lastSeen`);
    db.close();
  });

  it('no refresca last_seen de usuarios que no han hablado', () => {
    const db = new Database(':memory:');
    const memory = new UserMemory(db, 100, 7);

    const hace10dias = Date.now() - 10 * 24 * 60 * 60 * 1000;
    memory.updateEngagement('inactiva', 'hola', hace10dias, { displayName: 'Inactiva' });
    memory.getUserData('inactiva').engagementPattern.lastSeen = hace10dias;
    memory.getUserData('inactiva').firstSeen = hace10dias;
    memory.save();

    const reloaded = new UserMemory(db, 100, 7);
    reloaded.load();
    const diasDesdeUltimaVez = (Date.now() - reloaded.getUserData('inactiva').engagementPattern.lastSeen) / 86400000;

    assert.ok(diasDesdeUltimaVez > 9, `last_seen se refrescó: solo ${diasDesdeUltimaVez} días`);
    db.close();
  });

  it('cleanup() elimina usuarios inactivos más allá de la ventana', () => {
    const db = new Database(':memory:');
    const memory = new UserMemory(db, 100, 7);
    memory.updateEngagement('inactiva', 'hola', Date.now(), { displayName: 'Inactiva' });
    memory.getUserData('inactiva').engagementPattern.lastSeen = Date.now() - 10 * 86400000;

    memory.cleanup();

    assert.equal(memory.memories.has('inactiva'), false);
    db.close();
  });
});
