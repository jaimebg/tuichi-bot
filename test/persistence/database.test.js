import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../src/persistence/database.js';

describe('Database', () => {
  let db;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  describe('schema', () => {
    it('creates all required tables', () => {
      const tables = db.raw.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all().map(r => r.name);
      for (const t of ['user_memory', 'user_messages', 'recent_chat',
        'conversation_threads', 'user_context', 'bot_state', 'game_history', 'schema_version']) {
        assert.ok(tables.includes(t), `missing table: ${t}`);
      }
    });
  });

  describe('users', () => {
    it('upserts and retrieves user memory', () => {
      db.users.upsert({ userId: 'alice', displayName: 'Alice',
        personalityTraits: ['humorous'], messageCount: 5, avgMessageLength: 20.5 });
      const user = db.users.get('alice');
      assert.equal(user.display_name, 'Alice');
      assert.equal(user.message_count, 5);
      assert.deepEqual(JSON.parse(user.personality_traits), ['humorous']);
    });
    it('returns undefined for missing user', () => {
      assert.equal(db.users.get('nobody'), undefined);
    });
  });

  describe('chat', () => {
    it('adds and retrieves recent messages', () => {
      db.chat.addMessage('alice', 'Alice', 'hello');
      db.chat.addMessage('bob', 'Bob', 'hey');
      assert.equal(db.chat.getRecent(10).length, 2);
    });
    it('prunes old messages', () => {
      db.chat.addMessage('alice', 'Alice', 'old');
      db.raw.prepare("UPDATE recent_chat SET timestamp = datetime('now', '-1 hour')").run();
      db.chat.addMessage('bob', 'Bob', 'new');
      db.chat.pruneOlderThan(30);
      const msgs = db.chat.getRecent(10);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].user_id, 'bob');
    });
  });

  describe('threads', () => {
    it('stores and retrieves conversation threads', () => {
      db.threads.upsert('alice', [{ role: 'user', content: 'hi' }]);
      const t = db.threads.get('alice');
      assert.equal(JSON.parse(t.messages)[0].content, 'hi');
    });
  });

  describe('state', () => {
    it('sets and gets', () => {
      db.state.set('greetingsEnabled', 'true');
      assert.equal(db.state.get('greetingsEnabled'), 'true');
    });
    it('returns null for missing key', () => {
      assert.equal(db.state.get('x'), null);
    });
  });

  describe('games', () => {
    it('logs game history', () => {
      db.games.log({ gameType: 'trivia', startedBy: 'alice',
        participants: ['alice', 'bob'], result: { winner: 'alice' } });
      const h = db.games.getRecent('trivia', 5);
      assert.equal(h.length, 1);
      assert.equal(h[0].game_type, 'trivia');
    });
  });

  describe('formato de timestamps', () => {
    const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/;

    it('recent_chat.timestamp se guarda como ISO-8601 con Z', () => {
      db.chat.addMessage('alice', 'Alice', 'hola');
      assert.match(db.chat.getRecent(1)[0].timestamp, ISO_8601_UTC);
    });

    it('user_memory.first_seen se guarda como ISO-8601 con Z', () => {
      db.users.upsert({ userId: 'alice', displayName: 'Alice' });
      assert.match(db.users.get('alice').first_seen, ISO_8601_UTC);
    });

    it('user_memory.last_seen se guarda como ISO-8601 con Z al actualizar', () => {
      db.users.upsert({ userId: 'alice', displayName: 'Alice' });
      db.users.upsert({ userId: 'alice', messageCount: 2 });
      assert.match(db.users.get('alice').last_seen, ISO_8601_UTC);
    });

    it('user_messages.timestamp se guarda como ISO-8601 con Z', () => {
      db.users.upsert({ userId: 'alice', displayName: 'Alice' });
      db.users.addMessage('alice', 'Alice', 'hola');
      assert.match(db.users.getMessages('alice')[0].timestamp, ISO_8601_UTC);
    });

    it('conversation_threads.updated_at se guarda como ISO-8601 con Z', () => {
      db.threads.upsert('alice', [{ role: 'user', content: 'hi' }]);
      assert.match(db.threads.get('alice').updated_at, ISO_8601_UTC);
      db.threads.upsert('alice', [{ role: 'user', content: 'again' }]);
      assert.match(db.threads.get('alice').updated_at, ISO_8601_UTC);
    });

    it('user_context.updated_at se guarda como ISO-8601 con Z', () => {
      db.context.upsert({ userId: 'alice', displayName: 'Alice' });
      assert.match(db.context.get('alice').updated_at, ISO_8601_UTC);
      db.context.upsert({ userId: 'alice', messageCount: 3 });
      assert.match(db.context.get('alice').updated_at, ISO_8601_UTC);
    });

    it('game_history.started_at y ended_at se guardan como ISO-8601 con Z', () => {
      const info = db.games.log({ gameType: 'trivia', startedBy: 'alice' });
      db.games.end(info.lastInsertRowid, { winner: 'alice' });
      const row = db.games.getRecent('trivia', 1)[0];
      assert.match(row.started_at, ISO_8601_UTC);
      assert.match(row.ended_at, ISO_8601_UTC);
    });

    it('schema_version.applied_at se guarda como ISO-8601 con Z', () => {
      db.raw.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
      const row = db.raw.prepare('SELECT applied_at FROM schema_version WHERE version=1').get();
      assert.match(row.applied_at, ISO_8601_UTC);
    });

    /**
     * `CREATE TABLE IF NOT EXISTS` no reescribe la definición de una tabla que ya existe, así que
     * en la BD de producción los DEFAULT de las columnas siguen siendo `datetime('now')`. Se
     * recrean aquí las tablas con el DEFAULT antiguo para comprobar que las escrituras emiten
     * ISO-8601 por sí mismas y no dependen del DEFAULT de la columna.
     */
    describe('sobre una BD con el schema antiguo ya existente', () => {
      const LEGACY_TABLES = [
        `CREATE TABLE recent_chat (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           user_id TEXT NOT NULL, display_name TEXT, message TEXT NOT NULL,
           timestamp TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE user_messages (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           user_id TEXT NOT NULL, display_name TEXT, message TEXT NOT NULL,
           timestamp TEXT DEFAULT (datetime('now')))`,
        `CREATE TABLE game_history (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           game_type TEXT NOT NULL, started_by TEXT, participants TEXT, result TEXT,
           started_at TEXT DEFAULT (datetime('now')), ended_at TEXT)`
      ];

      beforeEach(() => {
        db.raw.exec('DROP TABLE recent_chat; DROP TABLE user_messages; DROP TABLE game_history;');
        for (const sql of LEGACY_TABLES) db.raw.exec(sql);
      });

      it('recent_chat.timestamp sigue siendo ISO-8601 con Z', () => {
        db.chat.addMessage('alice', 'Alice', 'hola');
        assert.match(db.chat.getRecent(1)[0].timestamp, ISO_8601_UTC);
      });

      it('user_messages.timestamp sigue siendo ISO-8601 con Z', () => {
        db.users.upsert({ userId: 'alice', displayName: 'Alice' });
        db.users.addMessage('alice', 'Alice', 'hola');
        assert.match(db.users.getMessages('alice')[0].timestamp, ISO_8601_UTC);
      });

      it('game_history.started_at sigue siendo ISO-8601 con Z', () => {
        db.games.log({ gameType: 'trivia', startedBy: 'alice' });
        assert.match(db.games.getRecent('trivia', 1)[0].started_at, ISO_8601_UTC);
      });
    });
  });

  /**
   * La BD de producción conserva filas escritas con `datetime('now')` ("2026-07-29 21:02:45")
   * junto a las nuevas en ISO-8601. SQLite compara fechas como cadenas byte a byte y
   * 'T' (0x54) > ' ' (0x20), así que sin normalizar con julianday() TODAS las filas ISO
   * quedan por encima de TODAS las filas con espacio, sin mirar la hora real.
   *
   * Estos tests usan filas del MISMO DÍA a propósito: si las fechas difiriesen en el año la
   * comparación se resolvería antes de llegar al carácter problemático y no detectarían nada.
   */
  describe('timestamps en formato mixto (transición de la BD de producción)', () => {
    const nowIso = (offset) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','${offset}')`;
    const nowLegacy = (offset) => `datetime('now','${offset}')`;

    const insertChat = (message, expr) => db.raw.prepare(
      `INSERT INTO recent_chat (user_id,display_name,message,timestamp) VALUES ('u','U',?,${expr})`
    ).run(message);

    it('poda por hora real, no por orden de bytes', () => {
      insertChat('A-iso-reciente', nowIso('-1 minutes'));
      insertChat('B-iso-rancio', nowIso('-60 minutes'));
      insertChat('C-legacy-reciente', nowLegacy('-1 minutes'));
      insertChat('D-legacy-rancio', nowLegacy('-60 minutes'));

      db.chat.pruneOlderThan(10);

      const survivors = db.raw.prepare('SELECT message FROM recent_chat')
        .all().map(r => r.message).sort();
      // Si sobrevive B-iso-rancio, el cutoff está en formato con espacio.
      // Si falta C-legacy-reciente, el cutoff está en ISO crudo. Ambos = falta julianday().
      assert.deepEqual(survivors, ['A-iso-reciente', 'C-legacy-reciente']);
    });

    it('recent_chat se ordena por hora real', () => {
      insertChat('legacy-hace-1min', nowLegacy('-1 minutes'));
      insertChat('iso-hace-5min', nowIso('-5 minutes'));

      assert.deepEqual(db.chat.getRecent(10).map(r => r.message),
        ['legacy-hace-1min', 'iso-hace-5min']);
    });

    it('user_messages se ordena por hora real', () => {
      db.users.upsert({ userId: 'alice', displayName: 'Alice' });
      const insertMsg = (message, expr) => db.raw.prepare(
        `INSERT INTO user_messages (user_id,display_name,message,timestamp) VALUES ('alice','Alice',?,${expr})`
      ).run(message);
      insertMsg('legacy-hace-1min', nowLegacy('-1 minutes'));
      insertMsg('iso-hace-5min', nowIso('-5 minutes'));

      assert.deepEqual(db.users.getMessages('alice', 10).map(r => r.message),
        ['legacy-hace-1min', 'iso-hace-5min']);
    });

    it('game_history se ordena por hora real', () => {
      const insertGame = (startedBy, expr) => db.raw.prepare(
        `INSERT INTO game_history (game_type,started_by,started_at) VALUES ('trivia',?,${expr})`
      ).run(startedBy);
      insertGame('legacy-hace-1min', nowLegacy('-1 minutes'));
      insertGame('iso-hace-5min', nowIso('-5 minutes'));

      assert.deepEqual(db.games.getRecent('trivia', 10).map(r => r.started_by),
        ['legacy-hace-1min', 'iso-hace-5min']);
    });
  });
});
