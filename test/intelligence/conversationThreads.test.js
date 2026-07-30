// test/intelligence/conversationThreads.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../src/persistence/database.js';
import { ConversationThreads } from '../../src/intelligence/conversationThreads.js';

describe('ConversationThreads', () => {
  it('devuelve el mismo hilo para el mismo usuario', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    const id = t.getOrCreateThread('alice');
    assert.equal(t.getOrCreateThread('alice'), id);
    db.close();
  });

  it('crea hilos distintos para usuarios distintos', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    const idAlice = t.getOrCreateThread('alice');
    const idBob = t.getOrCreateThread('bob');
    assert.notEqual(idAlice, idBob);
    db.close();
  });

  it('cuando isReply=true y el usuario al que se responde tiene hilo, reutiliza ese hilo y queda mapeado para el futuro', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    const idAlice = t.getOrCreateThread('alice');
    const idBob = t.getOrCreateThread('bob', true, 'alice');
    assert.equal(idBob, idAlice);
    // El mapeo userKey->thread debe persistir: una llamada posterior sin isReply
    // para 'bob' debe seguir devolviendo el mismo hilo compartido con 'alice'.
    assert.equal(t.getOrCreateThread('bob'), idAlice);
    db.close();
  });

  it('cuando isReply=true pero el usuario al que se responde no tiene hilo, crea uno nuevo', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    const id = t.getOrCreateThread('bob', true, 'nadie_conocido');
    assert.equal(t.threads.has(id), true);
    assert.equal(t.getOrCreateThread('bob'), id);
    db.close();
  });

  it('persiste y recarga los hilos', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    const id = t.getOrCreateThread('alice');
    t.addMessage(id, 'user', 'hola');
    t.save();

    const reloaded = new ConversationThreads(db, 10);
    reloaded.load();
    assert.equal(reloaded.threads.size, 1);
    const reloadedId = reloaded.getOrCreateThread('alice');
    const messages = reloaded.getThread(reloadedId, 10);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'hola');
    db.close();
  });

  it('persiste y recarga varios hilos de distintos usuarios sin mezclar su contenido', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    const idAlice = t.getOrCreateThread('alice');
    t.addMessage(idAlice, 'user', 'hola de alice');
    const idBob = t.getOrCreateThread('bob');
    t.addMessage(idBob, 'user', 'hola de bob');
    t.save();

    const reloaded = new ConversationThreads(db, 10);
    reloaded.load();
    assert.equal(reloaded.threads.size, 2);

    const reloadedAliceId = reloaded.getOrCreateThread('alice');
    const reloadedBobId = reloaded.getOrCreateThread('bob');
    assert.notEqual(reloadedAliceId, reloadedBobId);
    assert.equal(reloaded.getThread(reloadedAliceId, 10)[0].content, 'hola de alice');
    assert.equal(reloaded.getThread(reloadedBobId, 10)[0].content, 'hola de bob');
    db.close();
  });

  it('save() omite hilos sin mensajes al persistir', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    t.getOrCreateThread('alice'); // no messages added
    t.save();

    assert.deepEqual(db.threads.getAll(), []);
    db.close();
  });

  it('respeta el límite de mensajes por hilo (20, hardcodeado en addMessage)', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    const id = t.getOrCreateThread('alice');
    for (let i = 0; i < 25; i++) t.addMessage(id, 'user', `mensaje ${i}`);

    const msgs = t.getThread(id, 100);
    assert.equal(msgs.length, 20);
    // El recorte es FIFO: se descartan los mensajes más antiguos, quedan los últimos 20 (5..24)
    assert.equal(msgs[0].content, 'mensaje 5');
    assert.equal(msgs[msgs.length - 1].content, 'mensaje 24');
    db.close();
  });

  it('el límite del constructor acota la cantidad de hilos, no de mensajes', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 3);
    const ids = ['a', 'b', 'c', 'd'].map((u) => t.getOrCreateThread(u));
    // Al superar el límite de 3 hilos, se descarta el hilo más antiguo (id numérico más bajo)
    assert.equal(t.threads.size, 3);
    assert.equal(t.threads.has(ids[0]), false);
    assert.equal(t.threads.has(ids[3]), true);
    // El desalojo solo debe afectar al usuario dueño del hilo descartado ('a').
    // Los demás usuarios deben seguir mapeados a su hilo original en userThreads.
    assert.equal(t.userThreads.has('a'), false);
    assert.equal(t.userThreads.get('b'), ids[1]);
    assert.equal(t.userThreads.get('c'), ids[2]);
    assert.equal(t.userThreads.get('d'), ids[3]);
    db.close();
  });

  it('conserva el orden y el rol de los mensajes', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    const id = t.getOrCreateThread('alice');
    t.addMessage(id, 'user', 'pregunta');
    t.addMessage(id, 'assistant', 'respuesta');
    const msgs = t.getThread(id, 10);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'user');
    assert.equal(msgs[0].content, 'pregunta');
    assert.equal(msgs[1].role, 'assistant');
    assert.equal(msgs[1].content, 'respuesta');
    db.close();
  });

  it('getThread sin límite devuelve todos los mensajes; con límite devuelve solo los últimos N', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    const id = t.getOrCreateThread('alice');
    for (let i = 0; i < 5; i++) t.addMessage(id, 'user', `m${i}`);

    assert.equal(t.getThread(id).length, 5);
    const ultimos2 = t.getThread(id, 2);
    assert.equal(ultimos2.length, 2);
    assert.equal(ultimos2[0].content, 'm3');
    assert.equal(ultimos2[1].content, 'm4');
    db.close();
  });

  it('getThread para un hilo inexistente devuelve un arreglo vacío', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    assert.deepEqual(t.getThread(9999, 10), []);
    db.close();
  });

  it('addMessage en un hilo inexistente no lanza y no crea el hilo', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    t.addMessage(9999, 'user', 'fantasma');
    assert.equal(t.threads.has(9999), false);
    db.close();
  });

  it('cleanup() elimina hilos cuyo último mensaje es más viejo que maxAgeMs', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    const viejoId = t.getOrCreateThread('viejo');
    t.addMessage(viejoId, 'user', 'hace tiempo', Date.now() - 1000);
    const nuevoId = t.getOrCreateThread('nuevo');
    t.addMessage(nuevoId, 'user', 'reciente', Date.now());

    t.cleanup(500); // maxAgeMs=500ms: el mensaje de hace 1000ms queda fuera de la ventana

    assert.equal(t.threads.has(viejoId), false);
    assert.equal(t.threads.has(nuevoId), true);
    assert.equal(t.userThreads.has('viejo'), false);
    assert.equal(t.userThreads.has('nuevo'), true);
    db.close();
  });

  it('cleanup() elimina hilos vacíos (sin mensajes) sin importar la edad', () => {
    const db = new Database(':memory:');
    const t = new ConversationThreads(db, 10);
    const vacioId = t.getOrCreateThread('vacio');
    // No se agrega ningún mensaje a este hilo.

    t.cleanup(24 * 60 * 60 * 1000);

    assert.equal(t.threads.has(vacioId), false);
    db.close();
  });
});
