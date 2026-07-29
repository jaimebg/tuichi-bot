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
});
