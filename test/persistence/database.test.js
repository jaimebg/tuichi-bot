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
});
