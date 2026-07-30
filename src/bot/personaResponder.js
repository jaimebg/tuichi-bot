import { log } from '../logger.js';
import { clampResponseLength } from '../utils/text.js';

/**
 * Handles @mentions and replies-to-bot: the bot's most user-visible AI code
 * path. Detects whether an incoming message addresses the bot, threads it into
 * ConversationThreads, and (fire-and-forget) generates and sends the Groq
 * reply.
 *
 * `ai.pendingRequests` is a shared Set injected via the AiController instance —
 * it's the same live object used by AmbientResponder's spontaneous-reply path,
 * so concurrent-request protection holds across both callers.
 */
export class PersonaResponder {
  constructor({ chat, ai, config, conversationThreads, userMemory, userContextStore, recentChat, streamMonitor, metrics }) {
    this.chat = chat;
    this.ai = ai;
    this.config = config;
    this.conversationThreads = conversationThreads;
    this.userMemory = userMemory;
    this.userContextStore = userContextStore;
    this.recentChat = recentChat;
    this.streamMonitor = streamMonitor;
    this.metrics = metrics;
  }

  // --- Mention/reply handling ---
  handleMention({ userKey, displayName, message, tags, msg, timestamp }) {
    const mentionToken = `@${this.config.twitch.username}`;
    const lowerMessage = message.toLowerCase();
    const hasMention = lowerMessage.includes(mentionToken);
    const replyParentLogin = (tags?.['reply-parent-user-login'] || '').toLowerCase();
    const isReplyToBot = replyParentLogin === this.config.twitch.username;

    if (!hasMention && !isReplyToBot) return;

    const mentionContext = { hasMention, isReplyToBot, replyParentLogin };
    const threadId = this.conversationThreads.getOrCreateThread(userKey, isReplyToBot, replyParentLogin);

    this.respondToMention({ userKey, displayName, message, msg, mentionContext, threadId, timestamp });
  }

  async respondToMention({ userKey, displayName, message, msg, mentionContext, threadId, timestamp }) {
    if (!this.ai.groqConfig) return;
    if (this.ai.pendingRequests.has(userKey)) return;
    // Reserve the slot BEFORE awaiting the cooldown wait, not after: two
    // mentions from the same user landing inside that wait would otherwise
    // both clear the `.has()` check above before either had a chance to
    // `.add()`, letting both through (see git history for the empirically
    // confirmed race). The `finally` below is the single release point for
    // every path out of this function from here on, including `!ready`.
    this.ai.pendingRequests.add(userKey);
    try {
      const ready = await this.ai.waitForCooldown(userKey);
      if (!ready) return;

      // Gather context for AI prompt
      const streamDuration = Math.floor((Date.now() - (this.streamMonitor.streamStartTime || Date.now())) / (1000 * 60));
      let streamContext = `Hora actual: ${new Date().toLocaleTimeString('es-ES')}. Stream activo por ${streamDuration} minutos.`;
      if (this.streamMonitor.currentGame) streamContext += ` Categoría: ${this.streamMonitor.currentGame}.`;

      const recentChat = this.recentChat.getRecentContext(userKey, this.config.twitch.username);
      const userSummary = this.userMemory.getUserSummary(userKey);
      const userProfile = this.userContextStore.getContextSnapshot(userKey);

      // Thread-based conversation history as separate API messages (no text duplicate)
      const conversationHistory = this.conversationThreads.getThread(threadId, 6)
        .filter(m => m.timestamp > Date.now() - 10 * 60 * 1000)
        .map(m => ({ role: m.role, content: m.content }));

      const chatMessages = this.ai.buildChatMessages({
        userKey, displayName, message, mentionContext,
        streamContext, recentChat, userSummary, userProfile,
        conversationHistory
      });

      let aiReply = await this.ai.fetchGroqResponse(chatMessages);
      if (aiReply === null) {
        // Circuit breaker open
        await this.chat.sendMessage('Estoy teniendo problemas para pensar, dame un momento', msg);
        return;
      }
      let finalMessage = clampResponseLength(aiReply, this.ai.maxChars);
      if (!finalMessage || !finalMessage.trim()) {
        finalMessage = 'lo siento, tuve un problema para procesar tu pregunta';
      }

      // @twurple reply uses { replyTo: msg } — pass the raw msg object
      await this.chat.sendMessage(finalMessage, msg);

      this.conversationThreads.addMessage(threadId, 'user', message, timestamp);
      this.conversationThreads.addMessage(threadId, 'assistant', finalMessage, Date.now());
      this.ai._recordResponse(userKey);
      log('debug', `Replied to ${displayName} via Groq.`);
    } catch (err) {
      log('warn', `Failed to reply to ${displayName}: ${err.message}`);
    } finally {
      this.ai.pendingRequests.delete(userKey);
    }
  }
}
