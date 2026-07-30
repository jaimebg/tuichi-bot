import { log, setErrorObserver } from '../logger.js';
import { Database } from '../persistence/database.js';
import { TwitchApi } from '../twitch/twitchApi.js';
import { ChatHandler } from './chatHandler.js';
import { AiController } from './aiController.js';
import { GameController } from './gameController.js';
import { CommandRouter } from './commandRouter.js';
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
import { StreamAnnouncer } from './streamAnnouncer.js';
import { MaintenanceTasks } from './maintenanceTasks.js';


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

    // Standalone chat commands: !ayuda (everyone), !status/!saluditos (owner-only)
    this.commandRouter = new CommandRouter({
      chat: this.chat, config, ownerKey: this.ownerKey,
      db: this.db, metrics: this.metrics, ai: this.ai,
      streamMonitor: this.streamMonitor, greeter: this.greeter
    });

    // @mentions and replies-to-bot: the AI-driven conversational path
    this.persona = new PersonaResponder({
      chat: this.chat, ai: this.ai, config,
      conversationThreads: this.conversationThreads, userMemory: this.userMemory,
      userContextStore: this.userContextStore, recentChat: this.recentChat,
      streamMonitor: this.streamMonitor, metrics: this.metrics
    });

    // Periodic/maintenance work: DB backups, memory checks, inactivity shame message,
    // top-users summary. saveAll is injected as a callback since it lives on Bot and
    // touches modules outside this class's scope (see maintenanceTasks.js docblock).
    this.maintenance = new MaintenanceTasks({
      db: this.db, chat: this.chat, ai: this.ai, config,
      messageLogger: this.messageLogger, userMemory: this.userMemory,
      userContextStore: this.userContextStore, inactivityTracker: this.inactivityTracker,
      chatterPresence: this.chatterPresence, greeter: this.greeter,
      saveAll: () => this._saveAll()
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
        const topMsg = this.maintenance.getTopUsersMessage(10);
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
    this.scheduler.register('inactivity-check', () => this.maintenance.checkInactivity(), 120_000);
    // Ping the systemd watchdog unconditionally: this callback firing proves the
    // event loop is alive, which is all the watchdog is meant to detect. Chat
    // silence is NOT a liveness failure and must never trigger a restart.
    this.scheduler.register('watchdog-notify', () => this.watchdog.notifyWatchdog(), 30_000);
    this.scheduler.register('chat-health-check', () => {
      if (!this.chat.isHealthy(this.streamMonitor.isOnline)) {
        log('warn', 'Chat connection appears unhealthy (no recent messages)');
      }
    }, 60_000);
    this.scheduler.register('memory-check', () => this.maintenance.checkMemory(), 5 * 60_000);
    this.scheduler.register('db-backup', () => this.maintenance.backupDb(), 86400_000);
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

    // Standalone commands: !ayuda (everyone), !status/!saluditos (owner only)
    if (this.commandRouter.handle(userKey, message)) return;

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
}
