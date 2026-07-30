import { log } from '../logger.js';
import { clampResponseLength } from '../utils/text.js';
import { streamStartFallback } from './prompts.js';

/**
 * Generates the AI-crafted chat announcements for two StreamMonitor events:
 * going live and changing category. Falls back to a canned message whenever
 * the AI is unconfigured or the Groq call throws.
 *
 * The system prompts below ("Eres un creador de contenido de Twitch
 * entusiasta...") never reference the channel name, so — per the note in
 * prompts.js — they stay inline here instead of living in prompts.js.
 *
 * `userMemory` and `recentChat` default to empty stand-ins so this class can
 * be constructed with just `{ ai, config }` in tests; when wired from Bot
 * they're the real UserMemory/RecentChatTracker instances, which is what
 * lets the stream-start and category-change prompts mention habitual users
 * and recent chat context, exactly as the original bot.js methods did.
 */
export class StreamAnnouncer {
  constructor({ ai, config, userMemory = { memories: new Map() }, recentChat = { messages: [] } }) {
    this.ai = ai;
    this.config = config;
    this.userMemory = userMemory;
    this.recentChat = recentChat;
  }

  async generateStreamStartMessage(title, game) {
    if (!this.ai.groqConfig) return streamStartFallback({
      channelDisplayName: this.config.twitch.channel, title, game
    });
    const excludedUsers = this.config.engagement?.excludedUsers ?? new Set();
    const habitualUsers = Array.from(this.userMemory.memories.keys())
      .filter(u => !excludedUsers.has(u.toLowerCase())).slice(0, 10).join(', ');
    const prompt = `Genera un mensaje de bienvenida detallado y atractivo para el inicio de un stream de Twitch. Título: "${title}". Categoría: "${game}". Usuarios habituales: ${habitualUsers || 'Ninguno disponible'}. El mensaje debe incluir el titulo y la categoría. Hasta 400 caracteres, entusiasta, único. Responde solo con el mensaje.`;
    const msgs = [
      { role: 'system', content: `Eres un creador de contenido de Twitch entusiasta. Tu personalidad es: ${this.config.resources.persona}.` },
      { role: 'user', content: prompt }
    ];
    try {
      const reply = await this.ai.fetchGroqResponse(msgs);
      return clampResponseLength(reply, 400);
    } catch (err) {
      log('warn', `Failed to generate stream start message: ${err.message}`);
      return streamStartFallback({
        channelDisplayName: this.config.twitch.channel, title, game
      });
    }
  }

  async generateCategoryChangeMessage(previousGame, newGame) {
    const fallback = `¡Cambio de categoría! Ahora estamos jugando ${newGame} (antes: ${previousGame}).`;
    if (!this.ai.groqConfig) return fallback;
    const recentMessages = this.recentChat.messages.slice(-5)
      .map(m => `${m.displayName}: ${m.message}`).join('\n');
    const prompt = `Genera un mensaje para anunciar un cambio de categoría. Anterior: "${previousGame}". Nueva: "${newGame}". Chat reciente: ${recentMessages || 'Ninguno'}. Incluye exactamente "Ahora estamos en ${newGame}". Hasta 200 caracteres. Solo el mensaje.`;
    const msgs = [
      { role: 'system', content: `Eres un creador de contenido de Twitch entusiasta. Tu personalidad es: ${this.config.resources.persona}.` },
      { role: 'user', content: prompt }
    ];
    try {
      const reply = await this.ai.fetchGroqResponse(msgs);
      const finalMessage = clampResponseLength(reply, 200);
      // Validate AI included the required phrase; fallback if not
      if (finalMessage && finalMessage.includes('Ahora estamos')) return finalMessage;
      return fallback;
    } catch (err) {
      log('warn', `Failed to generate category change message: ${err.message}`);
      return fallback;
    }
  }
}
