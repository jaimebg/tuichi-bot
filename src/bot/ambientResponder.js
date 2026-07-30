import { log } from '../logger.js';
import { clampResponseLength } from '../utils/text.js';
import { spontaneousReplySystemPrompt } from './prompts.js';

/**
 * Ambient (unprompted) reactions to ordinary chat: single-word echo, spontaneous
 * replies to random messages, and auto-triggered media. All three are
 * probabilistic — gated by `Math.random()` — which is why `random` is injected
 * here (default `Math.random`): it's what makes these behaviors testable.
 *
 * None of these fire on commands (`!...`) or @mentions; those are handled
 * elsewhere (GameController, Bot._handleMention).
 */
export class AmbientResponder {
  constructor({ chat, ai, config, recentChat, userMemory, streamMonitor, mediaOverlay, random = Math.random }) {
    this.chat = chat;
    this.ai = ai;
    this.config = config;
    this.recentChat = recentChat;
    this.userMemory = userMemory;
    this.streamMonitor = streamMonitor;
    this.mediaOverlay = mediaOverlay;
    this.random = random;

    this.lastSpontaneousReplyAt = 0;
  }

  // --- Single-word echo ---
  handleSingleWordEcho(message, tags) {
    if (!message || message.includes(' ')) return;
    if (this.config.singleWordEchoChance <= 0) return;
    if (this.random() >= this.config.singleWordEchoChance) return;
    const firstChar = message.charAt(0);
    if (firstChar === '@' || firstChar === '!') return;
    const replyParentLogin = (tags?.['reply-parent-user-login'] || '').toLowerCase();
    if (replyParentLogin === this.config.twitch.username) return;
    const delay = this.config.singleWordEchoDelayMs || 0;
    const send = () => this.chat.sendMessage(message).catch(err =>
      log('warn', `Failed to repeat single-word message: ${err.message}`)
    );
    if (delay > 0) setTimeout(send, delay);
    else send();
  }

  // --- Spontaneous reply to random chat messages ---
  async handleSpontaneousReply({ userKey, displayName, message, msg }) {
    if (!this.ai.groqConfig) return;
    if (this.config.spontaneousReplyChance <= 0) return;
    const firstChar = message.charAt(0);
    if (firstChar === '!' || firstChar === '@') return;
    const mentionToken = `@${this.config.twitch.username}`;
    if (message.toLowerCase().includes(mentionToken)) return;
    const now = Date.now();
    if (now - this.lastSpontaneousReplyAt < this.config.spontaneousReplyCooldownMs) return;
    if (this.random() >= this.config.spontaneousReplyChance) return;
    if (this.ai.pendingRequests.has(`spontaneous:${userKey}`)) return;

    this.ai.pendingRequests.add(`spontaneous:${userKey}`);
    try {
      const alias = this.ai._getAlias(userKey, displayName);
      const recentChat = this.recentChat.getRecentContext(userKey, this.config.twitch.username);
      const userSummary = this.userMemory.getUserSummary(userKey);

      let streamContext = '';
      if (this.streamMonitor.currentGame) streamContext = `Categoría actual: ${this.streamMonitor.currentGame}.`;

      const contextParts = [];
      if (streamContext) contextParts.push(streamContext);
      if (recentChat) contextParts.push(`Chat reciente: ${recentChat}`);
      if (userSummary?.personality?.length) contextParts.push(`Personalidad de ${alias}: ${userSummary.personality.join(', ')}`);
      if (userSummary?.themes?.length) contextParts.push(`Temas de interés de ${alias}: ${userSummary.themes.join(', ')}`);

      const contextText = contextParts.length ? `\nContexto: ${contextParts.join(' ')}` : '';

      const msgs = [
        { role: 'system', content: spontaneousReplySystemPrompt({
            persona: this.config.resources.persona,
            channel: this.config.twitch.channel,
            contextText, maxChars: this.ai.maxChars
          }) },
        { role: 'user', content: `${alias} acaba de decir en el chat: "${message}"\n\nResponde de forma natural y relevante a lo que dijo, como si fueras parte de la conversación.` }
      ];

      const reply = await this.ai.fetchGroqResponse(msgs);
      if (reply === null) return;
      const finalMessage = clampResponseLength(reply, this.ai.maxChars);
      if (!finalMessage?.trim()) return;

      await this.chat.sendMessage(finalMessage, msg);
      this.lastSpontaneousReplyAt = Date.now();
      this.ai._recordResponse(userKey);
      log('debug', `Spontaneous reply to ${displayName}: ${finalMessage.slice(0, 50)}...`);
    } catch (err) {
      log('warn', `Failed spontaneous reply to ${displayName}: ${err.message}`);
    } finally {
      this.ai.pendingRequests.delete(`spontaneous:${userKey}`);
    }
  }

  // --- Auto-trigger media ---
  handleAutoTriggerMedia(message, displayName) {
    if (!this.mediaOverlay) return;
    const lowerMessage = message.toLowerCase();
    const messageWords = lowerMessage.split(/\s+/).filter(w => w.length > 3);
    const matchingTitles = new Set();
    const allTitles = Object.keys(this.mediaOverlay.rewardNameMap || {});
    for (const word of messageWords) {
      for (const title of allTitles) {
        const reward = this.mediaOverlay.rewardNameMap[title];
        if (reward && (reward.type === 'video' || reward.type === 'audio') && title.toLowerCase().includes(word)) {
          matchingTitles.add(title);
        }
      }
    }
    const arr = Array.from(matchingTitles);
    if (arr.length > 0 && this.random() < (this.config.intelligence.autoTriggerChance ?? 0.1)) {
      const selected = arr[Math.floor(this.random() * arr.length)];
      this.mediaOverlay.triggerByTitle(selected, displayName);
    }
  }
}
