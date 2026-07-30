import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from '../../src/persistence/database.js';
import { MaintenanceTasks } from '../../src/bot/maintenanceTasks.js';

const config = {
  twitch: { channel: 'micanal' },
  resources: { persona: 'P' }
};

function makeTasks(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuichi-test-'));
  const dbPath = path.join(tmp, 'test.db');
  const db = new Database(dbPath);
  const sent = [];
  const saveAllCalls = [];
  const deps = {
    db,
    chat: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); } },
    ai: { groqConfig: { apiKey: 'x' }, userLastResponseAt: new Map(),
      fetchGroqResponse: () => Promise.resolve('mensaje sarcástico de sobra') },
    config: { ...config, paths: { data: tmp, db: dbPath } },
    messageLogger: { getTopUsers: () => [], userMessageCount: new Map() },
    userMemory: { memories: new Map() },
    userContextStore: { contexts: new Map() },
    inactivityTracker: { getShameCandidate: () => null, recordShame: () => {},
      userLastActivity: new Map() },
    chatterPresence: null,
    greeter: { greetedUsers: new Map() },
    saveAll: () => { saveAllCalls.push(true); return Promise.resolve(); },
    ...overrides
  };
  const tasks = new MaintenanceTasks(deps);
  return { tasks, sent, saveAllCalls, db, tmp, dbPath, deps };
}

function cleanup(db, tmp) {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

describe('MaintenanceTasks', () => {
  describe('backupDb', () => {
    it('crea un fichero en data/backups', async () => {
      const { tasks, db, tmp } = makeTasks();
      await tasks.backupDb();
      const backupDir = path.join(tmp, 'backups');
      assert.ok(fs.existsSync(backupDir), 'no se creó el directorio de backups');
      assert.ok(fs.readdirSync(backupDir).some(f => f.endsWith('.db')));
      cleanup(db, tmp);
    });

    it('poda backups con más de 7 días mantenendo los recientes', async () => {
      const { tasks, db, tmp } = makeTasks();
      const backupDir = path.join(tmp, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const oldFile = path.join(backupDir, 'tuichi-old.db');
      const freshFile = path.join(backupDir, 'tuichi-fresh.db');
      fs.writeFileSync(oldFile, 'x');
      fs.writeFileSync(freshFile, 'x');
      const eightDaysAgo = Date.now() - 8 * 86400_000;
      fs.utimesSync(oldFile, eightDaysAgo / 1000, eightDaysAgo / 1000);

      await tasks.backupDb();

      const remaining = fs.readdirSync(backupDir);
      assert.ok(!remaining.includes('tuichi-old.db'), 'el backup de más de 7 días debería haberse borrado');
      assert.ok(remaining.includes('tuichi-fresh.db'), 'el backup reciente no debería borrarse');
      cleanup(db, tmp);
    });

    it('no lanza si el backup falla (p.ej. directorio no accesible)', async () => {
      const { tasks, db, tmp } = makeTasks({
        db: { raw: { backup: () => Promise.reject(new Error('disk full')) } }
      });
      await assert.doesNotReject(() => tasks.backupDb());
      cleanup(db, tmp);
    });
  });

  describe('getTopUsersMessage', () => {
    it('devuelve null si no hay usuarios', () => {
      const { tasks, db, tmp } = makeTasks();
      assert.equal(tasks.getTopUsersMessage(10), null);
      cleanup(db, tmp);
    });

    it('formatea el límite, displayName y contador de mensajes en orden', () => {
      const { tasks, db, tmp } = makeTasks({
        messageLogger: {
          getTopUsers: (limit) => [
            { userKey: 'alice', displayName: 'Alice', messageCount: 42 },
            { userKey: 'bob', displayName: 'Bob', messageCount: 10 }
          ].slice(0, limit)
        }
      });
      const msg = tasks.getTopUsersMessage(10);
      assert.equal(msg, 'Top 2 ridículas más activas hoy: @Alice (42 mensajes), @Bob (10 mensajes)');
      cleanup(db, tmp);
    });

    it('respeta el límite pasado a messageLogger.getTopUsers', () => {
      const calls = [];
      const { tasks, db, tmp } = makeTasks({
        messageLogger: {
          getTopUsers: (limit) => { calls.push(limit); return [{ userKey: 'a', displayName: 'A', messageCount: 1 }]; }
        }
      });
      tasks.getTopUsersMessage(3);
      assert.deepEqual(calls, [3]);
      cleanup(db, tmp);
    });
  });

  describe('checkInactivity / sendShameMessage', () => {
    it('no envía nada si no hay candidato', async () => {
      const { tasks, sent, db, tmp } = makeTasks();
      await tasks.checkInactivity();
      assert.equal(sent.length, 0);
      cleanup(db, tmp);
    });

    it('no envía nada si la IA no está configurada aunque haya candidato', async () => {
      const { tasks, sent, db, tmp } = makeTasks({
        ai: { groqConfig: null },
        inactivityTracker: {
          getShameCandidate: () => ({ userKey: 'alice', displayName: 'Alice', inactiveForMinutes: 20 }),
          recordShame: () => {}
        }
      });
      await tasks.checkInactivity();
      assert.equal(sent.length, 0);
      cleanup(db, tmp);
    });

    it('envía el mensaje de shame y lo registra cuando hay candidato', async () => {
      const recorded = [];
      const { tasks, sent, db, tmp } = makeTasks({
        inactivityTracker: {
          getShameCandidate: () => ({ userKey: 'alice', displayName: 'Alice', inactiveForMinutes: 20 }),
          recordShame: (userKey) => recorded.push(userKey)
        }
      });
      await tasks.checkInactivity();
      assert.equal(sent.length, 1);
      assert.equal(sent[0], 'mensaje sarcástico de sobra');
      assert.deepEqual(recorded, ['alice']);
      cleanup(db, tmp);
    });

    it('usa shameSystemPrompt con persona y canal en el prompt de sistema', async () => {
      const calls = [];
      const { tasks, db, tmp } = makeTasks({
        config: { twitch: { channel: 'micanal' }, resources: { persona: 'Soy dramática' },
          paths: { data: '/tmp', db: '/tmp/x.db' } },
        ai: {
          groqConfig: { apiKey: 'x' },
          fetchGroqResponse: (msgs) => { calls.push(msgs); return Promise.resolve('ok'); }
        }
      });
      await tasks.sendShameMessage({ userKey: 'alice', displayName: 'Alice', inactiveForMinutes: 20 });
      assert.equal(calls.length, 1);
      const systemPrompt = calls[0][0].content;
      assert.ok(systemPrompt.includes('micanal'));
      assert.ok(systemPrompt.includes('Soy dramática'));
      const userPrompt = calls[0][1].content;
      assert.ok(userPrompt.includes('Alice'));
      assert.ok(userPrompt.includes('20'));
      cleanup(db, tmp);
    });

    it('no envía ni registra shame si la IA falla', async () => {
      const recorded = [];
      const { tasks, sent, db, tmp } = makeTasks({
        ai: { groqConfig: { apiKey: 'x' }, fetchGroqResponse: () => Promise.reject(new Error('boom')) },
        inactivityTracker: {
          getShameCandidate: () => ({ userKey: 'alice', displayName: 'Alice', inactiveForMinutes: 20 }),
          recordShame: (userKey) => recorded.push(userKey)
        }
      });
      await tasks.checkInactivity();
      assert.equal(sent.length, 0);
      assert.deepEqual(recorded, []);
      cleanup(db, tmp);
    });

    it('no registra shame si el envío del mensaje al chat falla', async () => {
      const recorded = [];
      const { tasks, db, tmp } = makeTasks({
        chat: { sendMessage: () => Promise.reject(new Error('rate limited')) },
        inactivityTracker: {
          getShameCandidate: () => ({ userKey: 'alice', displayName: 'Alice', inactiveForMinutes: 20 }),
          recordShame: (userKey) => recorded.push(userKey)
        }
      });
      await tasks.checkInactivity();
      assert.deepEqual(recorded, [], 'no debería registrarse el shame si el mensaje nunca llegó al chat');
      cleanup(db, tmp);
    });

    it('no envía ni registra shame si la respuesta de la IA queda vacía tras el clamp', async () => {
      const recorded = [];
      const { tasks, sent, db, tmp } = makeTasks({
        ai: { groqConfig: { apiKey: 'x' }, fetchGroqResponse: () => Promise.resolve('   ') },
        inactivityTracker: {
          getShameCandidate: () => ({ userKey: 'alice', displayName: 'Alice', inactiveForMinutes: 20 }),
          recordShame: (userKey) => recorded.push(userKey)
        }
      });
      await tasks.checkInactivity();
      assert.equal(sent.length, 0);
      assert.deepEqual(recorded, []);
      cleanup(db, tmp);
    });
  });

  describe('checkMemory', () => {
    let originalMemoryUsage;
    let originalExit;
    let exitCalls;

    beforeEach(() => {
      originalMemoryUsage = process.memoryUsage;
      originalExit = process.exit;
      exitCalls = [];
      process.exit = (code) => { exitCalls.push(code); };
    });

    afterEach(() => {
      process.memoryUsage = originalMemoryUsage;
      process.exit = originalExit;
    });

    it('no hace nada si la memoria está por debajo de los umbrales', async () => {
      process.memoryUsage = () => ({ heapUsed: 100 * 1024 * 1024, rss: 200 * 1024 * 1024 });
      const { tasks, saveAllCalls, db, tmp } = makeTasks();
      tasks.checkMemory();
      await new Promise(r => setTimeout(r, 0));
      assert.equal(saveAllCalls.length, 0);
      assert.equal(exitCalls.length, 0);
      cleanup(db, tmp);
    });

    it('guarda todo y sale del proceso cuando la memoria es crítica (heap > 600MB)', async () => {
      process.memoryUsage = () => ({ heapUsed: 650 * 1024 * 1024, rss: 100 * 1024 * 1024 });
      const { tasks, saveAllCalls, db, tmp } = makeTasks();
      tasks.checkMemory();
      await new Promise(r => setTimeout(r, 0));
      assert.equal(saveAllCalls.length, 1);
      assert.deepEqual(exitCalls, [1]);
      cleanup(db, tmp);
    });

    it('sale del proceso cuando la memoria es crítica por rss (> 680MB) aunque el heap sea bajo', async () => {
      process.memoryUsage = () => ({ heapUsed: 50 * 1024 * 1024, rss: 700 * 1024 * 1024 });
      const { tasks, saveAllCalls, db, tmp } = makeTasks();
      tasks.checkMemory();
      await new Promise(r => setTimeout(r, 0));
      assert.equal(saveAllCalls.length, 1);
      assert.deepEqual(exitCalls, [1]);
      cleanup(db, tmp);
    });

    it('no hace nada si el heap está justo en el umbral alto (400MB, no > 400)', async () => {
      process.memoryUsage = () => ({ heapUsed: 400 * 1024 * 1024, rss: 100 * 1024 * 1024 });
      const { tasks, saveAllCalls, db, tmp } = makeTasks();
      tasks.checkMemory();
      await new Promise(r => setTimeout(r, 0));
      assert.equal(saveAllCalls.length, 0);
      assert.equal(exitCalls.length, 0);
      cleanup(db, tmp);
    });
  });
});
