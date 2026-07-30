import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';
import { clampResponseLength } from '../utils/text.js';
import { shameSystemPrompt } from './prompts.js';

/**
 * Periodic/maintenance work extracted from Bot: DB backups, memory pressure
 * checks, the inactivity "shame" message, and the top-users summary sent
 * when the stream goes offline.
 *
 * `checkMemory`'s "memory critical" branch needs to trigger the same full
 * save-and-exit sequence Bot._saveAll() performs (flushing every intelligence
 * module before the process restarts under systemd). That method lives on
 * Bot and touches modules well outside this class's scope, so it's injected
 * as a `saveAll` callback rather than duplicated here — mirroring how
 * GameController is handed `generateGameContent` instead of importing AiController.
 */
export class MaintenanceTasks {
  constructor({ db, chat, ai, config, messageLogger, userMemory, userContextStore,
    inactivityTracker, chatterPresence = null, greeter, saveAll }) {
    this.db = db;
    this.chat = chat;
    this.ai = ai;
    this.config = config;
    this.messageLogger = messageLogger;
    this.userMemory = userMemory;
    this.userContextStore = userContextStore;
    this.inactivityTracker = inactivityTracker;
    this.chatterPresence = chatterPresence;
    this.greeter = greeter;
    this.saveAll = saveAll;
  }

  /** Top-N most active users today, for the stream-offline summary message. */
  getTopUsersMessage(limit) {
    const top = this.messageLogger.getTopUsers(limit);
    if (!top.length) return null;
    return `Top ${top.length} ridículas más activas hoy: ${top.map(u => `@${u.displayName} (${u.messageCount} mensajes)`).join(', ')}`;
  }

  /** Runs on the scheduler; sends a shame message if there's an eligible inactive user. */
  async checkInactivity() {
    const candidate = this.inactivityTracker.getShameCandidate();
    if (candidate && this.ai.groqConfig) {
      await this.sendShameMessage(candidate);
    }
  }

  /** Runs on the scheduler; logs/escalates on memory pressure (systemd MemoryMax is 768M). */
  checkMemory() {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    // RSS is what systemd's MemoryMax (768M) enforces, and it includes native
    // memory (better-sqlite3, ws buffers) that heapUsed misses. Keep margin below it.
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    if (heapMB > 600 || rssMB > 680) {
      log('error', `Memory critical (heap ${heapMB}MB, rss ${rssMB}MB) — initiating graceful restart`);
      this.saveAll().then(() => process.exit(1)).catch(() => process.exit(1));
    } else if (heapMB > 400 || rssMB > 560) {
      log('warn', `Memory high: heap ${heapMB}MB rss ${rssMB}MB | ` +
        `present:${this.chatterPresence?.getPresentCount() ?? 0} ` +
        `contexts:${this.userContextStore.contexts.size} ` +
        `memories:${this.userMemory.memories.size} ` +
        `inactivity:${this.inactivityTracker.userLastActivity.size} ` +
        `cooldowns:${this.ai.userLastResponseAt.size} ` +
        `msgLogger:${this.messageLogger.userMessageCount.size} ` +
        `greetedUsers:${this.greeter.greetedUsers.size}`
      );
    }
  }

  /** Runs daily on the scheduler; backs up the SQLite DB and prunes backups older than 7 days. */
  async backupDb() {
    try {
      const backupDir = path.join(this.config.paths.data, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const dest = path.join(backupDir, `tuichi-${new Date().toISOString().slice(0, 10)}.db`);
      await this.db.raw.backup(dest);
      // Prune backups older than 7 days
      const cutoff = Date.now() - 7 * 86400_000;
      for (const file of fs.readdirSync(backupDir)) {
        const filePath = path.join(backupDir, file);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
      }
      log('info', `Database backed up to ${dest}`);
    } catch (err) {
      log('error', `Database backup failed: ${err.message}`);
    }
  }

  /** Sends the AI-generated sarcastic "you're ignoring me" message and records it. */
  async sendShameMessage(candidate) {
    const prompt = `Genera un mensaje largo y sarcástico (150-200 caracteres) fingiendo que te duele profundamente que @${candidate.displayName} no te haga caso.\nUsuario ha estado inactivo ${candidate.inactiveForMinutes} minutos.\nSé muy cómico, melodramático y sarcástico. Responde solo con el mensaje, sin comillas.`;
    const msgs = [
      { role: 'system', content: shameSystemPrompt({
          persona: this.config.resources.persona, channel: this.config.twitch.channel
        }) },
      { role: 'user', content: prompt }
    ];
    try {
      const reply = await this.ai.fetchGroqResponse(msgs);
      const finalMessage = clampResponseLength(reply, 200);
      if (finalMessage) {
        await this.chat.sendMessage(finalMessage);
        this.inactivityTracker.recordShame(candidate.userKey);
        log('debug', `Sent shame message to ${candidate.displayName}`);
      }
    } catch (err) {
      log('warn', `Failed to generate shame message: ${err.message}`);
    }
  }
}
