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
    const data = memory.getUserData('sinfechas');

    assert.ok(!Number.isNaN(data.firstSeen), 'firstSeen es NaN');
    const firstSeenSkew = Math.abs(Date.now() - data.firstSeen) / 60000;
    assert.ok(firstSeenSkew < 1, `desfase de ${firstSeenSkew} minutos en firstSeen`);

    assert.ok(!Number.isNaN(data.engagementPattern.lastSeen), 'lastSeen es NaN');
    const lastSeenSkew = Math.abs(Date.now() - data.engagementPattern.lastSeen) / 60000;
    assert.ok(lastSeenSkew < 1, `desfase de ${lastSeenSkew} minutos en lastSeen`);
    db.close();
  });
});
