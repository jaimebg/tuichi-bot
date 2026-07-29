// test/intelligence/recentChatTracker.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../src/persistence/database.js';
import { RecentChatTracker } from '../../src/intelligence/recentChatTracker.js';

describe('RecentChatTracker', () => {
  it('conserva los mensajes al recargar desde la BD', () => {
    const db = new Database(':memory:');
    new RecentChatTracker(db, 20, 10).addMessage('alice', 'Alice', 'hola mundo');

    const reloaded = new RecentChatTracker(db, 20, 10);
    reloaded.load();

    assert.equal(reloaded.messages.length, 1);
    assert.equal(reloaded.messages[0].userKey, 'alice');
    assert.equal(reloaded.messages[0].message, 'hola mundo');
    db.close();
  });

  it('asigna un timestamp coherente con el reloj actual al recargar', () => {
    const db = new Database(':memory:');
    new RecentChatTracker(db, 20, 10).addMessage('bob', 'Bob', 'test');

    const reloaded = new RecentChatTracker(db, 20, 10);
    reloaded.load();

    const skewMinutes = Math.abs(Date.now() - reloaded.messages[0].timestamp) / 60000;
    assert.ok(skewMinutes < 1, `desfase de ${skewMinutes} minutos`);
    db.close();
  });

  it('no produce NaN si la columna de timestamp viene vacía', () => {
    const db = new Database(':memory:');
    db.raw.prepare("INSERT INTO recent_chat (user_id,display_name,message,timestamp) VALUES ('x','X','sin fecha',NULL)").run();

    const tracker = new RecentChatTracker(db, 20, 10);
    tracker.load();

    assert.equal(tracker.messages.length, 1, 'la fila con timestamp NULL se descartó en vez de recuperarse');
    const [msg] = tracker.messages;
    assert.ok(!Number.isNaN(msg.timestamp), 'timestamp es NaN');
    const skewMinutes = Math.abs(Date.now() - msg.timestamp) / 60000;
    assert.ok(skewMinutes < 1, `desfase de ${skewMinutes} minutos`);
    db.close();
  });
});
