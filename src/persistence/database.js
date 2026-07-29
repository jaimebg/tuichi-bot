import BetterSqlite3 from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';

/**
 * Expresión SQL que produce el instante actual en ISO-8601 UTC ("2026-07-29T21:02:45.123Z").
 *
 * El `datetime()` de SQLite devuelve "2026-07-29 21:02:45": UTC pero sin marcador de zona, así que
 * `new Date(str)` lo interpretaría como hora local. Guardar el sufijo `Z` elimina la ambigüedad.
 *
 * Se define una sola vez a propósito: un formato distinto en cualquiera de las columnas
 * reintroduciría timestamps ambiguos de forma silenciosa.
 *
 * Todas las escrituras lo indican de forma EXPLÍCITA en el INSERT en lugar de apoyarse en el
 * DEFAULT de la columna: `CREATE TABLE IF NOT EXISTS` no reescribe la definición de una tabla
 * que ya existe, así que en la BD de producción los DEFAULT siguen usando `datetime()`.
 * Sin el valor explícito, esas columnas seguirían generando filas ambiguas indefinidamente.
 */
const NOW_UTC = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT DEFAULT (${NOW_UTC})
);
CREATE TABLE IF NOT EXISTS user_memory (
  user_id TEXT PRIMARY KEY, display_name TEXT,
  personality_traits TEXT, conversation_themes TEXT, top_words TEXT,
  message_count INTEGER DEFAULT 0, avg_message_length REAL DEFAULT 0,
  active_hours TEXT,
  first_seen TEXT DEFAULT (${NOW_UTC}),
  last_seen TEXT DEFAULT (${NOW_UTC})
);
CREATE TABLE IF NOT EXISTS user_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL, display_name TEXT, message TEXT NOT NULL,
  timestamp TEXT DEFAULT (${NOW_UTC}),
  FOREIGN KEY (user_id) REFERENCES user_memory(user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_messages_user ON user_messages(user_id, timestamp);
CREATE TABLE IF NOT EXISTS recent_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL, display_name TEXT, message TEXT NOT NULL,
  timestamp TEXT DEFAULT (${NOW_UTC})
);
CREATE INDEX IF NOT EXISTS idx_recent_chat_time ON recent_chat(timestamp);
CREATE TABLE IF NOT EXISTS conversation_threads (
  user_id TEXT PRIMARY KEY,
  messages TEXT NOT NULL,
  updated_at TEXT DEFAULT (${NOW_UTC})
);
CREATE TABLE IF NOT EXISTS user_context (
  user_id TEXT PRIMARY KEY, display_name TEXT,
  first_seen TEXT, last_seen TEXT,
  message_count INTEGER DEFAULT 0, avg_message_length REAL DEFAULT 0,
  active_hours TEXT, personality TEXT, themes TEXT, top_words TEXT,
  recent_commands TEXT, preferences TEXT, metadata TEXT,
  updated_at TEXT DEFAULT (${NOW_UTC})
);
CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS game_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_type TEXT NOT NULL, started_by TEXT,
  participants TEXT, result TEXT,
  started_at TEXT DEFAULT (${NOW_UTC}), ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_game_history_type ON game_history(game_type, started_at);
`;

export class Database {
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.raw = new BetterSqlite3(dbPath);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.exec(SCHEMA_SQL);
    this._prepare();
  }

  _prepare() {
    const s = {};
    // user_memory
    s.upsertUser = this.raw.prepare(`INSERT INTO user_memory (user_id,display_name,personality_traits,conversation_themes,top_words,message_count,avg_message_length,active_hours,first_seen,last_seen) VALUES (@userId,@displayName,@personalityTraits,@conversationThemes,@topWords,@messageCount,@avgMessageLength,@activeHours,${NOW_UTC},${NOW_UTC}) ON CONFLICT(user_id) DO UPDATE SET display_name=COALESCE(@displayName,display_name),personality_traits=COALESCE(@personalityTraits,personality_traits),conversation_themes=COALESCE(@conversationThemes,conversation_themes),top_words=COALESCE(@topWords,top_words),message_count=COALESCE(@messageCount,message_count),avg_message_length=COALESCE(@avgMessageLength,avg_message_length),active_hours=COALESCE(@activeHours,active_hours),last_seen=${NOW_UTC}`);
    s.getUser = this.raw.prepare('SELECT * FROM user_memory WHERE user_id=?');
    s.getAllUsers = this.raw.prepare('SELECT * FROM user_memory');
    s.deleteUser = this.raw.prepare('DELETE FROM user_memory WHERE user_id=?');
    // user_messages
    s.addUserMsg = this.raw.prepare(`INSERT INTO user_messages (user_id,display_name,message,timestamp) VALUES (?,?,?,${NOW_UTC})`);
    s.getUserMsgs = this.raw.prepare('SELECT * FROM user_messages WHERE user_id=? ORDER BY julianday(timestamp) DESC LIMIT ?');
    // recent_chat
    s.addChat = this.raw.prepare(`INSERT INTO recent_chat (user_id,display_name,message,timestamp) VALUES (?,?,?,${NOW_UTC})`);
    s.getRecentChat = this.raw.prepare('SELECT * FROM recent_chat ORDER BY julianday(timestamp) DESC LIMIT ?');
    s.pruneChat = this.raw.prepare("DELETE FROM recent_chat WHERE julianday(timestamp) < julianday('now', ? || ' minutes')");
    // conversation_threads
    s.upsertThread = this.raw.prepare(`INSERT INTO conversation_threads (user_id,messages,updated_at) VALUES (?,?,${NOW_UTC}) ON CONFLICT(user_id) DO UPDATE SET messages=excluded.messages,updated_at=${NOW_UTC}`);
    s.getThread = this.raw.prepare('SELECT * FROM conversation_threads WHERE user_id=?');
    s.deleteThread = this.raw.prepare('DELETE FROM conversation_threads WHERE user_id=?');
    s.getAllThreads = this.raw.prepare('SELECT * FROM conversation_threads');
    // user_context
    s.upsertCtx = this.raw.prepare(`INSERT INTO user_context (user_id,display_name,first_seen,last_seen,message_count,avg_message_length,active_hours,personality,themes,top_words,recent_commands,preferences,metadata,updated_at) VALUES (@userId,@displayName,@firstSeen,@lastSeen,@messageCount,@avgMessageLength,@activeHours,@personality,@themes,@topWords,@recentCommands,@preferences,@metadata,${NOW_UTC}) ON CONFLICT(user_id) DO UPDATE SET display_name=COALESCE(@displayName,display_name),last_seen=COALESCE(@lastSeen,last_seen),message_count=COALESCE(@messageCount,message_count),avg_message_length=COALESCE(@avgMessageLength,avg_message_length),active_hours=COALESCE(@activeHours,active_hours),personality=COALESCE(@personality,personality),themes=COALESCE(@themes,themes),top_words=COALESCE(@topWords,top_words),recent_commands=COALESCE(@recentCommands,recent_commands),preferences=COALESCE(@preferences,preferences),metadata=COALESCE(@metadata,metadata),updated_at=${NOW_UTC}`);
    s.getCtx = this.raw.prepare('SELECT * FROM user_context WHERE user_id=?');
    s.getAllCtx = this.raw.prepare('SELECT * FROM user_context');
    // bot_state
    s.setState = this.raw.prepare('INSERT OR REPLACE INTO bot_state (key,value) VALUES (?,?)');
    s.getState = this.raw.prepare('SELECT value FROM bot_state WHERE key=?');
    // game_history
    s.logGame = this.raw.prepare(`INSERT INTO game_history (game_type,started_by,participants,result,started_at) VALUES (@gameType,@startedBy,@participants,@result,${NOW_UTC})`);
    s.endGame = this.raw.prepare(`UPDATE game_history SET ended_at=${NOW_UTC},result=? WHERE id=?`);
    s.getRecentGames = this.raw.prepare('SELECT * FROM game_history WHERE game_type=? ORDER BY julianday(started_at) DESC LIMIT ?');

    const jsonify = (v) => v ? JSON.stringify(v) : null;

    this.users = {
      upsert: (d) => s.upsertUser.run({ userId: d.userId, displayName: d.displayName ?? null, personalityTraits: jsonify(d.personalityTraits), conversationThemes: jsonify(d.conversationThemes), topWords: jsonify(d.topWords), messageCount: d.messageCount ?? null, avgMessageLength: d.avgMessageLength ?? null, activeHours: jsonify(d.activeHours) }),
      get: (id) => s.getUser.get(id),
      getAll: () => s.getAllUsers.all(),
      delete: (id) => s.deleteUser.run(id),
      addMessage: (uid, dn, msg) => s.addUserMsg.run(uid, dn, msg),
      getMessages: (uid, limit = 20) => s.getUserMsgs.all(uid, limit)
    };
    this.chat = {
      addMessage: (uid, dn, msg) => s.addChat.run(uid, dn, msg),
      getRecent: (limit = 20) => s.getRecentChat.all(limit),
      pruneOlderThan: (min) => s.pruneChat.run(`-${min}`)
    };
    this.threads = {
      upsert: (uid, msgs) => s.upsertThread.run(uid, JSON.stringify(msgs)),
      get: (uid) => s.getThread.get(uid),
      delete: (uid) => s.deleteThread.run(uid),
      getAll: () => s.getAllThreads.all()
    };
    this.context = {
      upsert: (d) => s.upsertCtx.run({ userId: d.userId, displayName: d.displayName ?? null, firstSeen: d.firstSeen ?? null, lastSeen: d.lastSeen ?? null, messageCount: d.messageCount ?? null, avgMessageLength: d.avgMessageLength ?? null, activeHours: jsonify(d.activeHours), personality: jsonify(d.personality), themes: jsonify(d.themes), topWords: jsonify(d.topWords), recentCommands: jsonify(d.recentCommands), preferences: jsonify(d.preferences), metadata: jsonify(d.metadata) }),
      get: (uid) => s.getCtx.get(uid),
      getAll: () => s.getAllCtx.all()
    };
    this.state = {
      set: (k, v) => s.setState.run(k, v),
      get: (k) => { const r = s.getState.get(k); return r ? r.value : null; }
    };
    this.games = {
      log: (d) => s.logGame.run({ gameType: d.gameType, startedBy: d.startedBy ?? null, participants: jsonify(d.participants), result: jsonify(d.result) }),
      end: (id, result) => s.endGame.run(JSON.stringify(result), id),
      getRecent: (type, limit = 10) => s.getRecentGames.all(type, limit)
    };
  }

  transaction(fn) { return this.raw.transaction(fn)(this); }
  close() { this.raw.close(); log('info', 'Database connection closed'); }
}