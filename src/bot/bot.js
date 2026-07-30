import { log, setErrorObserver } from '../logger.js';
import { Database } from '../persistence/database.js';
import { TwitchApi } from '../twitch/twitchApi.js';
import { ChatHandler } from './chatHandler.js';
import { AiController } from './aiController.js';
import { GameController } from './gameController.js';
import { StreamMonitor } from './streamMonitor.js';
import { ChatterPresence } from './chatterPresence.js';
import { Greeter } from './greeter.js';
import { AmbientResponder } from './ambientResponder.js';
import { PersonaResponder } from './personaResponder.js';
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
import { clampResponseLength } from '../utils/text.js';
import { shameSystemPrompt } from './prompts.js';
import { StreamAnnouncer } from './streamAnnouncer.js';
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
    this.inactivityTracker = new InactivityTracker(15, 90000, config.engagement.excludedUsers);

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

    // Ambient (unprompted) reactions: single-word echo, spontaneous replies, auto-triggered media
    this.ambient = new AmbientResponder({
      chat: this.chat, ai: this.ai, config,
      recentChat: this.recentChat, userMemory: this.userMemory,
      streamMonitor: this.streamMonitor, mediaOverlay: this.mediaOverlay
    });

    // Stream-start / category-change chat announcements
    this.streamAnnouncer = new StreamAnnouncer({
      ai: this.ai, config,
      userMemory: this.userMemory, recentChat: this.recentChat
    });

    // EventSub (shared WebSocket for channel points + stream events)
    this.eventSubClient = config.channelPoints.enabled ? new EventSubClient({
      twitchApi: this.twitchApi, channelLogin: config.twitch.channel,
      reconnectBaseMs: config.channelPoints.reconnectBaseMs,
      maxReconnectMs: config.channelPoints.maxReconnectMs,
      keepaliveGraceMs: config.channelPoints.keepaliveGraceMs,
      // Let StreamMonitor widen its poll interval while EventSub is delivering events.
      onConnectionChange: (connected) => this.streamMonitor.setEventSubConnected(connected)
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

    // Chatter presence (Helix Get Chatters) — authoritative source for who is in
    // chat, driving greetings/goodbyes and the present-users list. Requires the
    // broadcaster token (with moderator:read:chatters); disabled gracefully if absent.
    this.chatterPresence = config.twitch.broadcasterToken ? new ChatterPresence({
      twitchApi: this.twitchApi,
      channel: config.twitch.channel,
      botUsername: config.twitch.username,
      ignoredUsers: config.engagement.excludedUsers,
      confirmLeaveCycles: config.presence.confirmLeaveCycles,
      recentMessageHoldMs: config.presence.recentMessageHoldMs
    }) : null;
    if (!this.chatterPresence) {
      log('warn', 'Presence tracking disabled: set TWITCH_BROADCASTER_TOKEN (with moderator:read:chatters) to enable greetings/goodbyes.');
    }

    // Presence-driven greetings/goodbyes
    this.greeter = new Greeter({
      chat: this.chat,
      greetings: config.resources.greetings,
      goodbyes: config.resources.goodbyes,
      excludedUsers: config.engagement.excludedUsers,
      botUsername: config.twitch.username,
      greetCooldownMs: config.presence.greetCooldownMs,
      inactivityTracker: this.inactivityTracker
    });
    // Owner-only commands (!status, !saluditos) are gated on the configured channel,
    // not a hardcoded name, so any deployment's channel owner can use them.
    this.ownerKey = config.twitch.channel.toLowerCase().replace(/^#/, '');

    // Production modules
    this.metrics = new MetricsCollector();

    // @mentions and replies-to-bot: the AI-driven conversational path
    this.persona = new PersonaResponder({
      chat: this.chat, ai: this.ai, config,
      conversationThreads: this.conversationThreads, userMemory: this.userMemory,
      userContextStore: this.userContextStore, recentChat: this.recentChat,
      streamMonitor: this.streamMonitor, metrics: this.metrics
    });

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
    // Chat events -> bot routing. Guard so a single bad message can't crash the process.
    this.chat.on('message', (data) => {
      try { this._handleMessage(data); }
      catch (err) {
        log('error', `Error handling message from ${data?.displayName || 'unknown'}: ${err.message}`);
        log('debug', err.stack);
      }
    });
    this.chat.on('connected', () => {
      // Re-seed presence on reconnect so we don't mass-greet the existing audience.
      this.chatterPresence?.reset();
    });

    // Presence (Helix Get Chatters) -> greetings + goodbyes
    if (this.chatterPresence) {
      this.chatterPresence.on('join', ({ userKey, username }) => this.greeter.handlePresenceJoin(userKey, username));
      this.chatterPresence.on('leave', ({ userKey, username }) => this.greeter.handlePresenceLeave(userKey, username));
    }

    // Game controller -> chat
    this.gameController.on('send', (text) => this.chat.sendMessage(text).catch(err =>
      log('warn', `Failed to send game message: ${err.message}`)
    ));
    this.gameController.on('sendLong', (text) => this.chat.sendLongMessage(text).catch(err =>
      log('warn', `Failed to send long game message: ${err.message}`)
    ));

    // Stream monitor -> chat
    this.streamMonitor.on('live', async (info) => {
      try {
        this.messageLogger.reset();
        const msg = await this.streamAnnouncer.generateStreamStartMessage(info.title, info.game);
        await this.chat.sendMessage(msg);
      } catch (err) { log('warn', `Failed to handle stream live event: ${err.message}`); }
    });
    this.streamMonitor.on('offline', async () => {
      try {
        await this.chat.sendMessage('El stream se ha desconectado. Venga guapa.');
        const topMsg = this._getTopUsersMessage(10);
        if (topMsg) await this.chat.sendMessage(topMsg);
      } catch (err) { log('warn', `Failed to handle stream offline event: ${err.message}`); }
    });
    this.streamMonitor.on('categoryChange', async (info) => {
      try {
        const msg = await this.streamAnnouncer.generateCategoryChangeMessage(info.previous, info.current);
        await this.chat.sendMessage(msg);
      } catch (err) { log('warn', `Failed to handle category change event: ${err.message}`); }
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
    // Ping the systemd watchdog unconditionally: this callback firing proves the
    // event loop is alive, which is all the watchdog is meant to detect. Chat
    // silence is NOT a liveness failure and must never trigger a restart.
    this.scheduler.register('watchdog-notify', () => this.watchdog.notifyWatchdog(), 30_000);
    this.scheduler.register('chat-health-check', () => {
      if (!this.chat.isHealthy(this.streamMonitor.isOnline)) {
        log('warn', 'Chat connection appears unhealthy (no recent messages)');
      }
    }, 60_000);
    this.scheduler.register('memory-check', () => this._checkMemory(), 5 * 60_000);
    this.scheduler.register('db-backup', () => this._backupDb(), 86400_000);
    if (this.chatterPresence) {
      this.scheduler.register('presence-poll', () => this.chatterPresence.poll(),
        this.config.presence.pollIntervalMs, { runImmediately: true });
    }

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
    this.chatterPresence?.markActive(userKey, displayName);

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
        `También puedes mencionarme con @${this.config.twitch.username} para hablar conmigo guapa xdd`
      ).catch(err => log('warn', `Failed to send ayuda: ${err.message}`));
      return;
    }

    // Status command (owner only)
    if (message === '!status' && userKey === this.ownerKey) {
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
      return;
    }

    // Greetings toggle (owner only)
    if (message === '!saluditos' && userKey === this.ownerKey) {
      this.greeter.setEnabled(!this.greeter.isEnabled());
      this.chat.sendMessage(`Saludos ${this.greeter.isEnabled() ? 'activados' : 'desactivados'}`)
        .catch(err => log('warn', `Failed to send saluditos toggle: ${err.message}`));
      return;
    }

    // Intelligence extraction
    this.ai.extractIntelligence(this.userMemory, userKey, message);
    const detailed = this.userMemory.getDetailedContext(userKey);
    if (detailed) this.userContextStore.updateFromMemory(detailed);

    // Single-word echo
    this.ambient.handleSingleWordEcho(message, tags);

    // Game commands
    const present = this.chatterPresence?.getPresentList() ?? [];
    if (this.gameController.handleCommand(userKey, displayName, message, present)) return;

    // Mention/reply handling -> AI response
    this.persona.handleMention({ userKey, displayName, message, tags, msg, timestamp });

    // Spontaneous reply to random messages
    this.ambient.handleSpontaneousReply({ userKey, displayName, message, msg });

    // Auto-trigger media based on message content
    this.ambient.handleAutoTriggerMedia(message, displayName);
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

  // --- Persistence & lifecycle helpers ---
  async _saveAll() {
    this.userMemory.cleanup();
    this.conversationThreads.cleanup();
    this.inactivityTracker.cleanup();
    this.userMemory.save();
    this.recentChat.save();
    this.conversationThreads.save();
    await this.userContextStore.flush();
    // Prune greeted entries past the re-greet cooldown, then persist the rest so
    // returning viewers aren't re-greeted across restarts.
    this.greeter.pruneGreeted(Date.now() - this.config.presence.greetCooldownMs);
    this.db.state.set('greetingsEnabled', String(this.greeter.isEnabled()));
    this.db.state.set('greetedUsers', JSON.stringify(Object.fromEntries(this.greeter.greetedUsers)));
    log('debug', 'Data saved');
  }
  _loadBotState() {
    const ge = this.db.state.get('greetingsEnabled');
    if (ge !== null) this.greeter.setEnabled(ge === 'true');
    const gu = this.db.state.get('greetedUsers');
    if (gu) {
      try { this.greeter.loadGreeted(JSON.parse(gu)); } catch { /* ignore corrupt data */ }
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
    // RSS is what systemd's MemoryMax (768M) enforces, and it includes native
    // memory (better-sqlite3, ws buffers) that heapUsed misses. Keep margin below it.
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    if (heapMB > 600 || rssMB > 680) {
      log('error', `Memory critical (heap ${heapMB}MB, rss ${rssMB}MB) — initiating graceful restart`);
      this._saveAll().then(() => process.exit(1)).catch(() => process.exit(1));
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
