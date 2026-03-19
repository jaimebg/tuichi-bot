import { log, setErrorObserver } from '../logger.js';
import { Database } from '../persistence/database.js';
import { TwitchApi } from '../twitch/twitchApi.js';
import { ChatHandler } from './chatHandler.js';
import { AiController } from './aiController.js';
import { GameController } from './gameController.js';
import { StreamMonitor } from './streamMonitor.js';
import { UserMemory } from '../intelligence/userMemory.js';
import { UserContextStore } from '../intelligence/userContextStore.js';
import { RecentChatTracker } from '../intelligence/recentChatTracker.js';
import { ConversationThreads } from '../intelligence/conversationThreads.js';
import { MessageLogger } from '../intelligence/messageLogger.js';
import { InactivityTracker } from '../intelligence/inactivityTracker.js';
import { MediaOverlayServer } from '../media/mediaOverlayServer.js';
import { EventSubClient } from '../twitch/eventSubClient.js';
import { Scheduler } from './scheduler.js';
import { MetricsCollector } from './metricsCollector.js';
import { HealthServer } from './healthServer.js';
import { Watchdog } from './watchdog.js';
import { IGNORED_USERS } from '../twitch/constants.js';
import { normalizeWhitespace, clampResponseLength } from '../utils/text.js';
import fs from 'node:fs';
import path from 'node:path';

export class Bot {
  constructor(config) {
    this.config = config;
    this.db = new Database(config.paths.db);

    // Twitch API + Auth
    this.twitchApi = new TwitchApi({
      clientId: config.twitch.clientId,
      clientSecret: config.twitch.clientSecret,
      accessToken: config.twitch.apiToken,
      refreshToken: config.twitch.refreshToken,
      broadcasterToken: config.twitch.broadcasterToken,
      broadcasterRefreshToken: config.twitch.broadcasterRefreshToken
    });

    // Chat
    this.chat = new ChatHandler({
      authProvider: this.twitchApi.authProvider,
      channel: config.twitch.channel,
      botUsername: config.twitch.username
    });

    // Wrap sendMessage to count metrics
    const originalSend = this.chat.sendMessage.bind(this.chat);
    this.chat.sendMessage = async (...args) => {
      const result = await originalSend(...args);
      this.metrics.increment('messagesSent');
      return result;
    };

    // AI
    this.ai = new AiController({
      groqConfig: config.groq, persona: config.resources.persona,
      lore: config.resources.lore, aiConfig: config.ai,
      aliases: config.resources.aliases
    });

    // Intelligence
    this.userMemory = new UserMemory(this.db, config.intelligence.userMemoryLimit, config.intelligence.engagementTrackingDays);
    this.userContextStore = new UserContextStore(this.db, config.intelligence.maxRecentMessages);
    this.recentChat = new RecentChatTracker(this.db, config.intelligence.recentChatLimit, config.intelligence.contextWindowMinutes);
    this.conversationThreads = new ConversationThreads(this.db, config.intelligence.conversationThreadLimit);
    this.messageLogger = new MessageLogger();
    this.inactivityTracker = new InactivityTracker(15, 90000, IGNORED_USERS);
    this.lastSpontaneousReplyAt = 0;

    // Games (AI callback injected, not imported)
    this.gameController = new GameController({
      generateGameContent: (msgs) => this.ai.generateGameContent(msgs),
      groqConfig: config.groq, lore: config.resources.lore,
      adventureConfig: config.adventure
    });

    // Stream Monitor
    this.streamMonitor = new StreamMonitor({
      twitchApi: this.twitchApi, channel: config.twitch.channel
    });

    // Media Overlay
    this.mediaOverlay = config.media.enabled ? new MediaOverlayServer(config.media) : null;

    // EventSub (shared WebSocket for channel points + stream events)
    this.eventSubClient = config.channelPoints.enabled ? new EventSubClient({
      twitchApi: this.twitchApi, channelLogin: config.twitch.channel,
      reconnectBaseMs: config.channelPoints.reconnectBaseMs,
      maxReconnectMs: config.channelPoints.maxReconnectMs,
      keepaliveGraceMs: config.channelPoints.keepaliveGraceMs
    }) : null;

    if (this.eventSubClient) {
      // Channel points redemption
      this.eventSubClient.registerSubscription(
        'channel.channel_points_custom_reward_redemption.add', '1',
        { broadcaster_user_id: '' }, // auto-filled by EventSubClient
        (event) => this._handleRedemptionEvent(event)
      );
      // Stream online/offline
      this.eventSubClient.registerSubscription(
        'stream.online', '1',
        { broadcaster_user_id: '' },
        (event) => this.streamMonitor.handleLive(event)
      );
      this.eventSubClient.registerSubscription(
        'stream.offline', '1',
        { broadcaster_user_id: '' },
        () => this.streamMonitor.handleOffline()
      );
    }

    // Session state
    this.presentUsers = new Set();
    this.userHasChatted = new Set();
    this.silentUsers = new Set();
    this.existingUsers = new Set();
    this.greetedUsers = new Map();
    this.greetingsEnabled = true;
    this.startupIgnoreUntil = 0;
    this.initialNamesHandled = false;

    // Production modules
    this.metrics = new MetricsCollector();
    this.scheduler = new Scheduler();
    this.watchdog = new Watchdog();
    this.healthServer = new HealthServer({
      port: config.health.port,
      apiKey: config.health.apiKey,
      bot: this,
      metrics: this.metrics
    });

    this._wireEvents();
  }

  _wireEvents() {
    // Chat events -> bot routing
    this.chat.on('message', (data) => this._handleMessage(data));
    this.chat.on('join', ({ userKey, username }) => this._handleJoin(userKey, username));
    this.chat.on('part', ({ userKey, username }) => this._handlePart(userKey, username));
    this.chat.on('connected', () => {
      this.existingUsers.clear();
      this.presentUsers.clear();
      this.userHasChatted.clear();
      this.startupIgnoreUntil = Date.now() + 5000;
      this.initialNamesHandled = false;
    });

    // Game controller -> chat
    this.gameController.on('send', (text) => this.chat.sendMessage(text));
    this.gameController.on('sendLong', (text) => this.chat.sendLongMessage(text));

    // Stream monitor -> chat
    this.streamMonitor.on('live', async (info) => {
      this.messageLogger.reset();
      const msg = await this._generateStreamStartMessage(info.title, info.game);
      await this.chat.sendMessage(msg);
    });
    this.streamMonitor.on('offline', async () => {
      await this.chat.sendMessage('El stream se ha desconectado. Venga guapa.');
      const topMsg = this._getTopUsersMessage(10);
      if (topMsg) await this.chat.sendMessage(topMsg);
    });
    this.streamMonitor.on('categoryChange', async (info) => {
      const msg = await this._generateCategoryChangeMessage(info.previous, info.current);
      await this.chat.sendMessage(msg);
    });
  }

  async start() {
    await this.twitchApi.ensureReady();

    // Load persisted data
    this.userMemory.load();
    this.userContextStore.syncFromUserMemory(this.userMemory);
    this.recentChat.load();
    this.conversationThreads.load();
    this._loadBotState();

    // Wire error observer for metrics
    setErrorObserver((msg) => this.metrics.recordError(msg));

    // Wire metrics into modules
    this.ai.setMetrics(this.metrics);
    this.gameController.setMetrics(this.metrics);

    // Connect chat
    await this.chat.connect();
    log('info', `Joined channel #${this.config.twitch.channel}`);

    // Start sub-systems
    if (this.mediaOverlay) await this.mediaOverlay.start();
    if (this.eventSubClient) await this.eventSubClient.start();
    this.streamMonitor.start();
    await this.healthServer.start();

    // Register scheduled tasks
    this.scheduler.register('auto-save', () => this._saveAll(), 5 * 60_000);
    this.scheduler.register('inactivity-check', () => this._checkInactivity(), 120_000);
    this.scheduler.register('watchdog-notify', () => {
      if (this.healthServer.isSystemHealthy()) this.watchdog.notifyWatchdog();
    }, 30_000);
    this.scheduler.register('chat-health-check', () => {
      if (!this.chat.isHealthy(this.streamMonitor.isOnline)) {
        log('warn', 'Chat connection appears unhealthy (zombie detected)');
      }
    }, 60_000);
    this.scheduler.register('memory-check', () => this._checkMemory(), 5 * 60_000);
    this.scheduler.register('db-backup', () => this._backupDb(), 86400_000);

    // Notify systemd we're ready
    await this.watchdog.notifyReady();
  }

  async shutdown() {
    this.scheduler.stopAll();
    await this._saveAll();
    this.gameController.cancelAll();
    this.streamMonitor.stop();
    if (this.eventSubClient) await this.eventSubClient.stop();
    if (this.mediaOverlay) await this.mediaOverlay.stop();
    await this.healthServer.stop();
    await this.chat.disconnect();
    this.db.close();
    log('info', 'Bot shutdown complete');
  }

  // --- Message handling ---
  _handleMessage({ userKey, displayName, message, tags, msg }) {
    this.presentUsers.add(userKey);
    this.userHasChatted.add(userKey);
    this.silentUsers.delete(userKey);
    this.existingUsers.delete(userKey);

    const timestamp = Date.now();
    this.recentChat.addMessage(userKey, displayName, message, timestamp);
    this.userMemory.updateEngagement(userKey, message, timestamp, { displayName });
    this.messageLogger.logMessage(userKey, displayName);
    this.metrics.increment('messagesReceived');
    this.inactivityTracker.updateActivity(userKey, displayName);

    // Help command (everyone)
    if (message === '!ayuda') {
      this.chat.sendLongMessage(
        '📋 Comandos: ' +
        '!ayuda - Lista de comandos | ' +
        '!poll pregunta | opción1 | opción2 [| segundos] - Crear encuesta (votar con !1, !2...) | ' +
        '!trivia - Trivia con IA (responder con !a, !b, !c, !d) | ' +
        '!aventura [tema] - Aventura interactiva (votar con !1, !2...) | ' +
        '!survive - Battle royale de chat | ' +
        '!vicky [mensaje] - Consulta al oráculo de Vicky Perez | ' +
        `También puedes mencionarme con @${this.config.twitch.username} para hablar conmigo guapa xdd`
      );
      return;
    }

    // Status command (owner only)
    if (message === '!status' && userKey === 'jaimevarecto') {
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
        `Msgs: ${snap.messagesReceived ?? 0}↓ ${snap.messagesSent ?? 0}↑`
      );
      return;
    }

    // Greetings toggle (owner only)
    if (message === '!saluditos' && userKey === 'jaimevarecto') {
      this.greetingsEnabled = !this.greetingsEnabled;
      this.chat.sendMessage(`Saludos ${this.greetingsEnabled ? 'activados' : 'desactivados'}`);
      return;
    }

    // Vicky oracle command
    if (message.startsWith('!vicky')) {
      this._handleVicky({ userKey, displayName, message, msg });
      return;
    }

    // Intelligence extraction
    this.ai.extractIntelligence(this.userMemory, userKey, message);
    const detailed = this.userMemory.getDetailedContext(userKey);
    if (detailed) this.userContextStore.updateFromMemory(detailed);

    // Single-word echo
    this._handleSingleWordEcho(message, tags);

    // Game commands
    if (this.gameController.handleCommand(userKey, displayName, message, Array.from(this.presentUsers))) return;

    // Mention/reply handling -> AI response
    this._handleMention({ userKey, displayName, message, tags, msg, timestamp });

    // Spontaneous reply to random messages
    this._handleSpontaneousReply({ userKey, displayName, message, msg });

    // Auto-trigger media based on message content
    this._handleAutoTriggerMedia(message, displayName);
  }

  // --- Single-word echo ---
  _handleSingleWordEcho(message, tags) {
    if (!message || message.includes(' ')) return;
    if (this.config.singleWordEchoChance <= 0) return;
    if (Math.random() >= this.config.singleWordEchoChance) return;
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
  async _handleSpontaneousReply({ userKey, displayName, message, msg }) {
    if (!this.ai.groqConfig) return;
    if (this.config.spontaneousReplyChance <= 0) return;
    const firstChar = message.charAt(0);
    if (firstChar === '!' || firstChar === '@') return;
    const mentionToken = `@${this.config.twitch.username}`;
    if (message.toLowerCase().includes(mentionToken)) return;
    const now = Date.now();
    if (now - this.lastSpontaneousReplyAt < this.config.spontaneousReplyCooldownMs) return;
    if (Math.random() >= this.config.spontaneousReplyChance) return;
    if (this.ai.pendingRequests.has(`spontaneous:${userKey}`)) return;

    this.ai.pendingRequests.add(`spontaneous:${userKey}`);
    try {
      const alias = this.ai._getAlias(userKey, displayName);
      const recentChat = this.recentChat.getRecentContext(userKey);
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
        { role: 'system', content: `${this.config.resources.persona}\n\nEstás en el chat del canal jaimevarecto. A veces te metes en la conversación de forma espontánea, con humor y naturalidad, como si fueras un espectador más. No menciones que eres un bot ni que estás respondiendo aleatoriamente. Sé breve y natural.${contextText}\nResponde en no mas de ${this.ai.maxChars} caracteres.` },
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

  // --- Vicky oracle ---
  async _handleVicky({ userKey, displayName, message, msg }) {
    if (!this.ai.groqConfig) return;
    if (this.ai.pendingRequests.has(`vicky:${userKey}`)) return;
    const ready = await this.ai.waitForCooldown(userKey);
    if (!ready) return;

    this.ai.pendingRequests.add(`vicky:${userKey}`);
    try {
      const alias = this.ai._getAlias(userKey, displayName);
      const userMessage = message.replace(/^!vicky\s*/i, '').trim();
      const prompt = userMessage
        ? `${alias} te dice: "${userMessage}"\n\nResponde como Vicky Perez.`
        : `${alias} te invoca! Suelta una de tus perlas de sabiduria, un consejo de maquillaje, una queja dramatica o una profecia caotica. Se tu misma.`;

      const msgs = [
        { role: 'system', content: `${this.config.resources.vicky}\nResponde en no mas de ${this.ai.maxChars} caracteres.` },
        { role: 'user', content: prompt }
      ];

      const reply = await this.ai.fetchGroqResponse(msgs);
      if (reply === null) {
        await this.chat.sendMessage('ahora mismo no puedo hablar que tengo la Bruja Averia encima', msg);
        return;
      }
      const finalMessage = clampResponseLength(reply, this.ai.maxChars);
      if (!finalMessage?.trim()) return;

      await this.chat.sendMessage(finalMessage, msg);
      this.ai._recordResponse(userKey);
      log('debug', `Vicky replied to ${displayName}: ${finalMessage.slice(0, 50)}...`);
    } catch (err) {
      log('warn', `Vicky failed for ${displayName}: ${err.message}`);
    } finally {
      this.ai.pendingRequests.delete(`vicky:${userKey}`);
    }
  }

  // --- Auto-trigger media ---
  _handleAutoTriggerMedia(message, displayName) {
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
    if (arr.length > 0 && Math.random() < (this.config.intelligence.autoTriggerChance ?? 0.1)) {
      const selected = arr[Math.floor(Math.random() * arr.length)];
      this.mediaOverlay.triggerByTitle(selected, displayName);
    }
  }

  // --- Join handling ---
  _handleJoin(userKey, username) {
    if (userKey === this.config.twitch.username) return;
    const skipGreeting = IGNORED_USERS.has(userKey);
    this.presentUsers.add(userKey);

    // During startup grace period, treat joins as existing users (replaces handleInitialNames)
    if (!this.initialNamesHandled && Date.now() < this.startupIgnoreUntil) {
      this.existingUsers.add(userKey);
      return;
    }
    // Once grace period ends, mark it handled
    if (!this.initialNamesHandled) {
      this.initialNamesHandled = true;
      log('debug', `Startup grace period ended, ${this.existingUsers.size} existing viewers tracked.`);
    }

    if (this.existingUsers.has(userKey) || skipGreeting) return;
    this.silentUsers.add(userKey);
    if (!this.greetingsEnabled) return;
    this._scheduleGreeting(username);
  }

  // --- Part handling ---
  _handlePart(userKey, username) {
    if (userKey === this.config.twitch.username) return;
    if (this.greetingsEnabled && this.silentUsers.has(userKey)) {
      this.chat.sendMessage(`Venga guapa ${username} vete por donde viniste catJump`);
    }
    this.presentUsers.delete(userKey);
    this.userHasChatted.delete(userKey);
    this.existingUsers.delete(userKey);
    this.silentUsers.delete(userKey);
    this.inactivityTracker.clearUser(userKey);
  }

  // --- Greeting subsystem ---
  _scheduleGreeting(username) {
    const userKey = username.toLowerCase();
    if (userKey === this.config.twitch.username) return;
    if (IGNORED_USERS.has(userKey) || this.existingUsers.has(userKey)) return;
    if (this.userHasChatted.has(userKey)) return;
    this.presentUsers.add(userKey);
    this._sendGreeting(username);
  }

  _sendGreeting(username) {
    const userKey = username.toLowerCase();
    const text = this._pickGreeting(username);
    this.chat.sendMessage(text).then(() => {
      this.greetedUsers.set(userKey, Date.now());
      log('info', `Greeted ${username}`);
    }).catch(err => log('warn', `Failed to greet ${username}: ${err.message}`));
  }

  _pickGreeting(username) {
    const greetings = this.config.resources.greetings;
    const idx = Math.floor(Math.random() * greetings.length);
    return greetings[idx].replace(/\{user\}/g, username);
  }

  // --- Mention/reply handling ---
  _handleMention({ userKey, displayName, message, tags, msg, timestamp }) {
    const mentionToken = `@${this.config.twitch.username}`;
    const lowerMessage = message.toLowerCase();
    const hasMention = lowerMessage.includes(mentionToken);
    const replyParentLogin = (tags?.['reply-parent-user-login'] || '').toLowerCase();
    const isReplyToBot = replyParentLogin === this.config.twitch.username;

    if (!hasMention && !isReplyToBot) return;

    const mentionContext = { hasMention, isReplyToBot, replyParentLogin };
    const threadId = this.conversationThreads.getOrCreateThread(userKey, isReplyToBot, replyParentLogin);
    this.conversationThreads.addMessage(threadId, 'user', message, timestamp);

    this._respondToMention({ userKey, displayName, message, msg, mentionContext, threadId, timestamp });
  }

  async _respondToMention({ userKey, displayName, message, msg, mentionContext, threadId, timestamp }) {
    if (!this.ai.groqConfig) return;
    if (this.ai.pendingRequests.has(userKey)) return;
    const ready = await this.ai.waitForCooldown(userKey);
    if (!ready) return;

    this.ai.pendingRequests.add(userKey);
    try {
      // Gather context for AI prompt
      const alias = this.ai._getAlias(userKey, displayName);
      const streamDuration = Math.floor((Date.now() - (this.streamMonitor.streamStartTime || Date.now())) / (1000 * 60));
      let streamContext = `Hora actual: ${new Date().toLocaleTimeString('es-ES')}. Stream activo por ${streamDuration} minutos.`;
      if (this.streamMonitor.currentGame) streamContext += ` Categoría: ${this.streamMonitor.currentGame}.`;

      const recentChat = this.recentChat.getRecentContext(userKey);
      const userSummary = this.userMemory.getUserSummary(userKey);
      const userProfile = this.userContextStore.getContextSnapshot(userKey);

      // Thread history
      const threadHistory = this.conversationThreads.getThread(threadId, 6);
      const threadContext = threadHistory
        .filter(m => m.timestamp > Date.now() - 10 * 60 * 1000)
        .map(m => `${m.role === 'user' ? alias : 'Tú'}: ${m.content}`)
        .join('; ');

      // Get thread-based conversation history as separate messages
      const conversationHistory = threadHistory
        .filter(m => m.timestamp > Date.now() - 10 * 60 * 1000)
        .map(m => ({ role: m.role, content: m.content }));

      const chatMessages = this.ai.buildChatMessages({
        userKey, displayName, message, mentionContext,
        streamContext, recentChat, userSummary, userProfile,
        threadHistory: threadContext, conversationHistory
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

      this.conversationThreads.addMessage(threadId, 'assistant', finalMessage, Date.now());
      this.ai._recordResponse(userKey);
      log('debug', `Replied to ${displayName} via Groq.`);
    } catch (err) {
      log('warn', `Failed to reply to ${displayName}: ${err.message}`);
    } finally {
      this.ai.pendingRequests.delete(userKey);
    }
  }

  // --- Channel point redemptions ---
  _handleRedemptionEvent(event) {
    // Normalize EventSub event to the format _handleRedemption expects
    const normalized = {
      id: event.id,
      reward: event.reward || {},
      user: {
        display_name: event.user_name || event.user_login || '',
        login: event.user_login || '',
        id: event.user_id || ''
      },
      user_input: event.user_input || '',
      redeemed_at: event.redeemed_at,
      status: event.status
    };
    this._handleRedemption(normalized);
  }

  _handleRedemption(redemption) {
    if (!redemption) return;
    const userDisplay = redemption.user?.display_name || redemption.user?.login || 'unknown';
    const rewardTitle = redemption.reward?.title || 'Channel reward';
    log('info', `Channel points redeemed by ${userDisplay}: ${rewardTitle}`);
    if (this.mediaOverlay) {
      const handled = this.mediaOverlay.triggerReward(redemption);
      if (!handled) {
        log('debug', `No media mapping for reward ${rewardTitle} (${redemption.reward?.id || 'unknown'})`);
      }
    }
  }

  // --- Stream start/category AI messages ---
  async _generateStreamStartMessage(title, game) {
    if (!this.ai.groqConfig) return `JaimeVaRecto está ahora en directo ${title} ${game}`;
    const habitualUsers = Array.from(this.userMemory.memories.keys())
      .filter(u => !IGNORED_USERS.has(u.toLowerCase())).slice(0, 10).join(', ');
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
      return `JaimeVaRecto está ahora en directo ${title} ${game}`;
    }
  }

  async _generateCategoryChangeMessage(previousGame, newGame) {
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

  // --- Persistence & lifecycle helpers ---
  async _saveAll() {
    this.userMemory.cleanup();
    this.conversationThreads.cleanup();
    this.userMemory.save();
    this.recentChat.save();
    this.conversationThreads.save();
    await this.userContextStore.flush();
    this.db.state.set('greetingsEnabled', String(this.greetingsEnabled));
    this.db.state.set('greetedUsers', JSON.stringify(Object.fromEntries(this.greetedUsers)));
    log('debug', 'Data saved');
  }
  _loadBotState() {
    const ge = this.db.state.get('greetingsEnabled');
    if (ge !== null) this.greetingsEnabled = ge === 'true';
    const gu = this.db.state.get('greetedUsers');
    if (gu) {
      try { this.greetedUsers = new Map(Object.entries(JSON.parse(gu))); } catch { /* ignore corrupt data */ }
    }
  }
  _getTopUsersMessage(limit) {
    const top = this.messageLogger.getTopUsers(limit);
    if (!top.length) return null;
    return `Top ${top.length} ridículas más activas hoy: ${top.map(u => `@${u.displayName} (${u.messageCount} mensajes)`).join(', ')}`;
  }
  async _checkInactivity() {
    const candidate = this.inactivityTracker.getShameCandidate();
    if (candidate && this.ai.groqConfig) {
      await this._sendShameMessage(candidate);
    }
  }

  _checkMemory() {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    if (heapMB > 600) {
      log('error', `Heap usage critical: ${heapMB}MB — initiating graceful restart`);
      this._saveAll().then(() => process.exit(1));
    } else if (heapMB > 400) {
      log('warn', `Heap usage high: ${heapMB}MB`);
    }
  }

  async _backupDb() {
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

  // --- Inactivity shame message ---
  async _sendShameMessage(candidate) {
    const prompt = `Genera un mensaje largo y sarcástico (150-200 caracteres) fingiendo que te duele profundamente que @${candidate.displayName} no te haga caso.\nUsuario ha estado inactivo ${candidate.inactiveForMinutes} minutos.\nSé muy cómico, melodramático y sarcástico. Responde solo con el mensaje, sin comillas.`;
    const msgs = [
      { role: 'system', content: `Eres un bot de Twitch en el canal jaimevarecto que es profundamente dramático y sarcástico cuando los usuarios se ignoran. Personalidad: ${this.config.resources.persona}` },
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
