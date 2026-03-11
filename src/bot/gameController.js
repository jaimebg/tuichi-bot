import { EventEmitter } from 'node:events';
import { PollManager } from '../games/pollManager.js';
import { TriviaManager } from '../games/triviaManager.js';
import { AdventureManager } from '../games/adventureManager.js';
import { SurviveManager } from '../games/surviveManager.js';
import { log } from '../logger.js';

/**
 * Routes game commands. Emits 'send' and 'sendLong' for bot to relay to chat.
 * Receives AI callback via constructor (no direct aiController import).
 */
export class GameController extends EventEmitter {
  constructor({ generateGameContent, groqConfig, lore, adventureConfig }) {
    super();
    this.generateGameContent = generateGameContent;
    this.pollManager = new PollManager();
    this.triviaManager = new TriviaManager(groqConfig);
    this.adventureManager = new AdventureManager(groqConfig, lore);
    this.surviveManager = new SurviveManager();
    this.adventureConfig = adventureConfig || {};
  }

  /** Returns true if message was handled as a game command. */
  handleCommand(userKey, displayName, message, presentUsers) {
    const lower = message.toLowerCase();

    // Poll vote (!1, !2, !3...)
    if (this.pollManager.isActive() && /^!\d+$/.test(message)) {
      this.pollManager.recordVote(userKey, parseInt(message.slice(1)));
      return true;
    }
    if (lower.startsWith('!poll')) {
      this._handlePoll(userKey, displayName, message);
      return true;
    }

    // Trivia answer
    if (this.triviaManager.isActive() && /^![a-d]$/i.test(message)) {
      this.triviaManager.recordAnswer(userKey, message.slice(1));
      return true;
    }
    if (lower === '!trivia') {
      this._handleTrivia(userKey, displayName);
      return true;
    }

    // Survive
    if (lower === '!survive') {
      this._handleSurvive(userKey, displayName, presentUsers);
      return true;
    }

    // Adventure vote
    if (this.adventureManager.isActive() && /^!\d+$/.test(message)) {
      this.adventureManager.recordVote(userKey, parseInt(message.slice(1)));
      return true;
    }
    if (lower.startsWith('!aventura')) {
      this._handleAdventure(userKey, displayName, message);
      return true;
    }

    return false;
  }

  _send(text) { this.emit('send', text); }
  _sendLong(text) { this.emit('sendLong', text); }

  _handlePoll(userKey, displayName, message) {
    const args = message.split(/\s+/).slice(1);
    if (args.length === 0) {
      this._send('¡Encuestas! Uso: !poll "<pregunta>" | "opción 1" "opción 2" ["opción 3"] [tiempo_segundos]');
      return;
    }
    const match = message.match(/"([^"]*)"/g);
    if (!match || match.length < 3) {
      this._send('❌ Formato inválido. Usa: !poll "<pregunta>" "opción1" "opción2" ... [tiempo_en_segundos]');
      return;
    }
    const question = match[0].slice(1, -1);
    const options = match.slice(1).map(m => m.slice(1, -1));
    if (options.length < 2) { this._send('❌ Necesitas al menos 2 opciones.'); return; }
    let durationMs = 60000;
    const lastArg = args[args.length - 1];
    if (!lastArg.includes('"') && !isNaN(parseInt(lastArg))) {
      durationMs = Math.min(300000, Math.max(10000, parseInt(lastArg) * 1000));
    }
    const started = this.pollManager.startPoll(question, options, durationMs);
    if (!started) { this._send('❌ Ya hay una encuesta activa o parámetros inválidos.'); return; }
    const optionsList = options.map((opt, idx) => `${idx + 1}) ${opt}`).join(' | ');
    this._send(`📊 ENCUESTA: ${question}`);
    this._send(optionsList);
    this._send(`¡Vota con !1, !2, !3, etc. Tiempo: ${Math.round(durationMs / 1000)}s!`);
    this.pollManager.scheduleAutoEnd((results) => this._handlePollEnd(results));
  }

  _handlePollEnd(results) {
    if (!results || results.totalVotes === 0) { this._send('📊 Encuesta cerrada. Nadie votó.'); return; }
    let text = `📊 Resultados: ${results.question}\n`;
    for (const opt of results.options) {
      const bar = '█'.repeat(Math.round((opt.votes / results.totalVotes) * 20)) + '░'.repeat(20 - Math.round((opt.votes / results.totalVotes) * 20));
      text += `${opt.number}) ${opt.text}: ${bar} ${opt.votes} votos (${Math.round((opt.votes / results.totalVotes) * 100)}%)\n`;
    }
    text += results.winners.length === 1 ? `🎉 ¡GANADOR: Opción ${results.winners[0]}!` : `🏳️ Empate entre opciones: ${results.winners.join(', ')}`;
    this._sendLong(text);
  }

  async _handleTrivia(userKey, displayName) {
    if (this.triviaManager.isActive()) { this._send('❌ Ya hay una trivia activa. ¡Responde con !a, !b, !c o !d!'); return; }
    const result = await this.triviaManager.startTrivia('general', 30000, this.generateGameContent);
    if (!result) { this._send('❌ No pude generar la pregunta. Intenta más tarde.'); return; }
    this._send(`🧠 TRIVIA: ${result.question}`);
    this._send(`a) ${result.options.a} | b) ${result.options.b} | c) ${result.options.c} | d) ${result.options.d}`);
    this._send(`⏰ Responde con !a, !b, !c o !d en ${result.durationSeconds} segundos!`);
    this.triviaManager.scheduleAutoEnd((results) => {
      if (!results) return;
      let msg = `🧠 Trivia terminada!\nPregunta: ${results.question}\n✅ Respuesta correcta: ${results.correct.toUpperCase()}\n${results.explanation}\n✅ Acertaron: ${results.correctCount} | ❌ Fallaron: ${results.wrongCount}`;
      if (results.correctCount > 0) {
        const winners = results.correctAnswers.slice(0, 5).join(', ');
        msg += `\n🏆 Ganadores: ${winners}${results.correctAnswers.length > 5 ? ` +${results.correctAnswers.length - 5}` : ''}`;
      }
      this._sendLong(msg);
    });
  }

  _handleSurvive(userKey, displayName, presentUsers) {
    if (this.surviveManager.isActive()) {
      const recorded = this.surviveManager.recordSurvive(userKey);
      if (recorded && recorded.status === 'recorded') {
        if (recorded.survivorsCount % 3 === 0 || recorded.survivorsCount === 1) {
          const status = this.surviveManager.getStatus();
          this._send(`✅ @${displayName} sobrevivió! Ronda ${status.roundNumber}: ${recorded.survivorsCount}/${status.playersInRound} 🏃‍♂️`);
        }
      }
      return;
    }
    const startedData = this.surviveManager.startSurvive(presentUsers, 30000);
    if (!startedData) { this._send('❌ Necesitas al menos 2 personas conectadas para jugar.'); return; }
    this._send('🎮 ¡SURVIVE - Battle Royale de Chat!');
    this._send(startedData.message);
    this._send(`Jugadores iniciales: ${startedData.count}`);
    this.surviveManager.scheduleRoundEnd((roundResult) => this._handleSurviveRoundEnd(roundResult));
  }

  _handleSurviveRoundEnd(roundResult) {
    if (!roundResult) return;
    const status = this.surviveManager.getStatus();
    const roundNumber = roundResult.roundNumber ?? status?.roundNumber ?? 1;
    const eliminated = Array.isArray(roundResult.eliminatedThisRound) ? roundResult.eliminatedThisRound : [];
    if (eliminated.length > 0) this._send(`💀 Ronda ${roundNumber}: Eliminados → ${eliminated.join(', ')}`);
    if (!roundResult.continueGame) { this._handleSurviveEnd(roundResult); return; }
    this._send(`\n🎮 Ronda ${roundResult.newRoundNumber}: ${roundResult.playersForNextRound} supervivientes restantes!`);
    this._send('¡Escribid !survive para sobrevivir!');
    this.surviveManager.scheduleRoundEnd((next) => this._handleSurviveRoundEnd(next));
  }

  _handleSurviveEnd(roundResult) {
    const finalResults = this.surviveManager.endSurvive();
    const summary = { ...roundResult, ...finalResults };
    const totalPlayers = summary.totalPlayers ?? summary.count ?? 0;
    const roundsPlayed = summary.roundsPlayed ?? summary.roundNumber ?? 1;
    const winners = Array.isArray(summary.winners) ? summary.winners.filter(Boolean) : [];
    const eliminatedList = Array.isArray(summary.eliminated) ? summary.eliminated.filter(Boolean) : [];
    let msg = `\n🏆 ¡FIN DEL SURVIVE!\nTotal de jugadores: ${totalPlayers}\nRondas jugadas: ${roundsPlayed}\nEliminados totales: ${summary.losersCount ?? eliminatedList.length}\n`;
    if (winners.length === 1) msg += `\n🥇 ¡CAMPEÓN: ${winners[0]}!`;
    else if (winners.length > 1) msg += `\n🥇 Ganadores: ${winners.join(', ')}`;
    else msg += '\n😱 ¡Nadie sobrevivió!';
    if (eliminatedList.length > 0) {
      const preview = eliminatedList.slice(0, 10).join(', ');
      msg += `\n❌ Eliminados (${eliminatedList.length}): ${preview}${eliminatedList.length > 10 ? ` +${eliminatedList.length - 10}` : ''}`;
    }
    this._sendLong(msg);
  }

  async _handleAdventure(userKey, displayName, message) {
    const parts = message.split(/\s+/).slice(1);
    const theme = parts.length === 0 ? 'una aventura de las Pentis' : parts.join(' ');
    if (this.adventureManager.isActive()) { this._send('❌ Ya hay una aventura en curso. ¡Votad con !1, !2, etc!'); return; }
    const result = await this.adventureManager.startAdventure(theme, this.generateGameContent);
    if (!result) { this._send('❌ No pude iniciar la aventura. Intenta más tarde.'); return; }
    this._send(`⚔️ AVENTURA: ${result.story}`);
    for (let i = 0; i < result.options.length; i++) this._send(`${i + 1}) ${result.options[i]}`);
    this._send(`¡Votad con !${Array.from({ length: result.options.length }, (_, i) => i + 1).join(' o !')} en 60 segundos!`);
    setTimeout(() => this._handleAdventureVotingEnd(), 60000);
  }

  async _handleAdventureVotingEnd() {
    if (!this.adventureManager.isActive()) return;
    const winner = this.adventureManager.getWinningOption();
    if (!winner) { this.adventureManager.cancelAdventure(); this._send('❌ Nadie votó. Aventura cancelada.'); return; }
    this._send(`🗳️ Opción ${winner.option} gana con ${winner.votes} votos: "${winner.text}"`);
    const continueResult = await this.adventureManager.continueAdventure(winner.text, this.generateGameContent);
    if (!continueResult) { this.adventureManager.cancelAdventure(); this._send('❌ Error continuando la aventura.'); return; }
    if (continueResult.options) {
      this._send(`⚔️ ${continueResult.story}`);
      for (let i = 0; i < continueResult.options.length; i++) this._send(`${i + 1}) ${continueResult.options[i]}`);
      this._send('¡Votad de nuevo en 60 segundos!');
      setTimeout(() => this._handleAdventureVotingEnd(), 60000);
    } else {
      this._send(`⚰️ FIN DE LA AVENTURA (Ronda ${continueResult.round}):`);
      this._send(continueResult.ending);
    }
  }

  cancelAll() {
    this.pollManager.cancelPoll();
    this.triviaManager.cancelTrivia();
    this.adventureManager.cancelAdventure();
    this.surviveManager.cancelSurvive();
  }
}
