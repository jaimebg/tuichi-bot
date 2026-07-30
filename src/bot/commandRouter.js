import { log } from '../logger.js';

/**
 * Routes the small set of standalone chat commands that don't belong to a
 * game (GameController) or the AI/persona path: `!ayuda` (help, open to
 * everyone) and the owner-only diagnostics/toggle pair `!status` /
 * `!saluditos`.
 *
 * `handle()` returns true when it consumed the message — the same contract
 * as `gameController.handleCommand(...)` — so the caller (Bot._handleMessage)
 * can `return` on true.
 *
 * `ownerKey` is passed in already-derived (lowercased, `#`-stripped channel
 * name from config.twitch.channel) rather than recomputed here, since Bot
 * already owns that derivation and other modules key off the same value.
 */
export class CommandRouter {
  constructor({ chat, config, ownerKey, db, metrics, ai, streamMonitor, greeter }) {
    this.chat = chat;
    this.config = config;
    this.ownerKey = ownerKey;
    this.db = db;
    this.metrics = metrics;
    this.ai = ai;
    this.streamMonitor = streamMonitor;
    this.greeter = greeter;
  }

  /** The `!ayuda` command list text, with `@botUsername` interpolated. */
  helpText() {
    return '📋 Comandos: ' +
      '!ayuda - Lista de comandos | ' +
      '!poll pregunta | opción1 | opción2 [| segundos] - Crear encuesta (votar con !1, !2...) | ' +
      '!trivia - Trivia con IA (responder con !a, !b, !c, !d) | ' +
      '!aventura [tema] - Aventura interactiva (votar con !1, !2...) | ' +
      '!survive - Battle royale de chat | ' +
      `También puedes mencionarme con @${this.config.twitch.username} para hablar conmigo guapa xdd`;
  }

  /** Returns true if the message was one of this router's commands and has been handled. */
  handle(userKey, message) {
    if (message === '!ayuda') {
      this._handleAyuda();
      return true;
    }
    if (message === '!status' && userKey === this.ownerKey) {
      this._handleStatus();
      return true;
    }
    if (message === '!saluditos' && userKey === this.ownerKey) {
      this._handleSaluditos();
      return true;
    }
    return false;
  }

  _handleAyuda() {
    this.chat.sendLongMessage(this.helpText())
      .catch(err => log('warn', `Failed to send ayuda: ${err.message}`));
  }

  _handleStatus() {
    const chatOk = this.chat.isHealthy(this.streamMonitor?.isOnline ?? false);
    let dbOk = false;
    try { dbOk = !!this.db.raw.prepare('SELECT 1 as v').get(); } catch { /* db unavailable */ }
    const uptimeS = Math.floor((Date.now() - this.metrics.startedAt) / 1000);
    const hours = Math.floor(uptimeS / 3600);
    const mins = Math.floor((uptimeS % 3600) / 60);
    const circuit = this.ai?.getCircuitState?.() ?? 'unknown';
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const snap = this.metrics.getSnapshot();
    this.chat.sendMessage(
      `🤖 Status: ${chatOk && dbOk ? '✅ OK' : '⚠️ Problemas'} | ` +
      `Uptime: ${hours}h${mins}m | ` +
      `Chat: ${chatOk ? '✅' : '❌'} | DB: ${dbOk ? '✅' : '❌'} | ` +
      `AI: ${circuit} | Mem: ${mem}MB | ` +
      `Msgs: ${snap.counters.messagesReceived}↓ ${snap.counters.messagesSent}↑`
    ).catch(err => log('warn', `Failed to send status: ${err.message}`));
  }

  _handleSaluditos() {
    this.greeter.setEnabled(!this.greeter.isEnabled());
    this.chat.sendMessage(`Saludos ${this.greeter.isEnabled() ? 'activados' : 'desactivados'}`)
      .catch(err => log('warn', `Failed to send saluditos toggle: ${err.message}`));
  }
}
