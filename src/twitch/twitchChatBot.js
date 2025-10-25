const tmi = require("tmi.js");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const { log, isDebugEnabled } = require("../logger");
const { normalizeWhitespace, clampResponseLength } = require("../utils/text");
const DataPersistence = require("../persistence/dataPersistence");
const UserMemory = require("../intelligence/userMemory");
const RecentChatTracker = require("../intelligence/recentChatTracker");
const ConversationThreads = require("../intelligence/conversationThreads");
const MessageLogger = require("../intelligence/messageLogger");
const InactivityTracker = require("../intelligence/inactivityTracker");
const MediaOverlayServer = require("../media/mediaOverlayServer");
const ChannelPointsWatcher = require("./channelPointsWatcher");
const PollManager = require("../games/pollManager");
const AdventureManager = require("../games/adventureManager");
const TriviaManager = require("../games/triviaManager");
const SurviveManager = require("../games/surviveManager");
const { IGNORED_USERS } = require("./constants");
function extractFeaturesSection(content) {
    const lines = content.split('\n');
    let start = -1;
    let end = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('## Features')) {
            start = i;
        } else if (start !== -1 && lines[i].startsWith('## ') && lines[i] !== '## Features') {
            end = i;
            break;
        }
    }
    if (start === -1) return '';
    const section = lines.slice(start, end === -1 ? lines.length : end).join('\n');
    return section;
}
function extractCommandReference(content) {
    const lines = content.split('\n');
    let start = -1;
    let end = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('## Command Reference')) {
            start = i;
        } else if (start !== -1 && lines[i].startsWith('## ') && lines[i] !== '## Command Reference') {
            end = i;
            break;
        }
    }
    if (start === -1) return '';
    const section = lines.slice(start, end === -1 ? lines.length : end).join('\n');
    return section;
}
class TwitchChatBot {
    constructor({
        username,
        channel,
        token,
        apiToken,
        refreshToken,
        clientId,
        clientSecret,
        messages,
        persona,
        lore,
        aliases,
        groqConfig,
        singleWordEchoChance,
        singleWordEchoDelayMs,
        ai,
        intelligence,
        adventure,
        channelPoints,
        mediaOverlay
    }) {
        if (!Array.isArray(messages) || messages.length === 0) {
            log("error", "Greeting messages array cannot be empty.");
            process.exit(1);
        }

        this.originalUsername = username;
        this.username = username.toLowerCase();
        this.channel = channel.toLowerCase();
        this.token = token.startsWith("oauth:") ? token : `oauth:${token}`;
        this.apiToken = apiToken;
        this.refreshToken = refreshToken;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.messages = messages.slice();
        this.persona = persona;
        this.lore = lore || "";
        this.aliases = aliases || {};
        this.groqConfig = groqConfig;
        this.adventureConfig = adventure;
        this.channelPointsConfig = channelPoints || {};
        this.mediaOverlayConfig = mediaOverlay || {};
        this.mediaOverlay = null;
        this.channelPointWatcher = null;
        this.greetingIgnoreLogins = IGNORED_USERS;
        this.existingUsers = new Set();
        this.startupGraceMs = 5000;
        this.startupIgnoreUntil = 0;
        this.initialNamesHandled = false;

        this.singleWordEchoChance = Number(singleWordEchoChance ?? 0);
        this.singleWordEchoDelayMs = Math.max(0, Number(singleWordEchoDelayMs ?? 0));

        this.aiMaxChars = Number(ai?.maxChars ?? 1);
        this.aiHistoryLimit = Number(ai?.historyLimit ?? 0);
        this.aiUserCooldownMs = Number(ai?.userCooldownMs ?? 0);
        this.aiGlobalCooldownMs = Number(ai?.globalCooldownMs ?? 0);
        this.autoTriggerChance = Number(intelligence?.autoTriggerChance ?? 0.1);

        this.presentUsers = new Set();
        this.userHasChatted = new Set();
        this.silentUsers = new Set();
        this.greetedUsers = new Map();
        this.greetingsEnabled = true;
        this.conversationHistory = new Map();
        this.pendingAIRequests = new Set();
        this.userLastAIResponseAt = new Map();
        this.lastAIGlobalResponseAt = 0;

        // Intelligence features
        this.dataPersistence = new DataPersistence(intelligence?.persistence);
        this.userMemory = new UserMemory(intelligence?.userMemoryLimit, intelligence?.engagementTrackingDays);
        this.recentChat = new RecentChatTracker(intelligence?.recentChatLimit, intelligence?.contextWindowMinutes);
        this.conversationThreads = new ConversationThreads(intelligence?.conversationThreads);
        this.messageLogger = new MessageLogger(intelligence?.messageLogMaxSize ?? 5000, intelligence?.messageLogCleanupMs ?? 60000);
        this.inactivityTracker = new InactivityTracker(15, 90000); // Check every 90 seconds for inactive users
        this.streamStartTime = Date.now();
        this.lastDataSave = 0;

        // Game managers
        this.pollManager = new PollManager();
        this.adventureManager = new AdventureManager(groqConfig);
        this.triviaManager = new TriviaManager(groqConfig);
        this.surviveManager = new SurviveManager();
        this.inactivityCheckInterval = null;

        // Stream monitoring
        this.isStreamOnline = false;
        this.currentGame = null;
        this.currentTitle = null;
        this.streamCheckInterval = null;

        if (this.mediaOverlayConfig.enabled) {
            this.mediaOverlay = new MediaOverlayServer(this.mediaOverlayConfig);
        }

        if (this.channelPointsConfig.enabled) {
            if (!this.apiToken) {
                log("warn", "Channel points watcher enabled but twitch.apiToken is missing.");
            } else {
                const eventSub = this.channelPointsConfig.eventSub || {};
                this.channelPointWatcher = new ChannelPointsWatcher({
                    clientId: this.clientId,
                    accessToken: this.apiToken,
                    getAccessToken: () => this.apiToken,
                    refreshAccessToken: async () => {
                        const refreshed = await this.refreshApiToken();
                        return refreshed ? this.apiToken : null;
                    },
                    channelLogin: this.channel,
                    reconnectBaseMs: eventSub.reconnectBaseMs,
                    maxReconnectMs: eventSub.maxReconnectMs,
                    keepaliveGraceMs: eventSub.keepaliveGraceMs
                }, (redemption) => this.handleChannelPointRedemption(redemption));
            }
        }

        this.client = new tmi.Client({
            options: { debug: isDebugEnabled() },
            connection: { secure: true, reconnect: true },
            identity: { username: this.originalUsername, password: this.token },
            channels: [`#${this.channel}`]
        });

        this.registerHandlers();

        // Load persisted data
        this.loadPersistedData();
    }

    registerHandlers() {
        this.client.on("connected", (addr, port) => {
            log("info", `Connected to ${addr}:${port}`);
            this.client.raw("CAP REQ :twitch.tv/membership");
            this.existingUsers.clear();
            this.presentUsers.clear();
            this.userHasChatted.clear();

            this.startupIgnoreUntil = Date.now() + this.startupGraceMs;
            this.initialNamesHandled = false;
        });

        this.client.on("disconnected", (reason) => {
            log("warn", `Disconnected from Twitch IRC: ${reason}`);
        });

        this.client.on("reconnect", () => {
            log("info", "Reconnecting to Twitch IRC...");
        });

        this.client.on("notice", (channel, msgid, message) => {
            log("warn", `Notice from Twitch (${msgid}): ${message}`);
        });

        this.client.on("names", (channel, users) => {
            this.handleInitialNames(channel, users);
        });

        this.client.on("namespaced", (channel, users) => {
            this.handleInitialNames(channel, users);
        });

        this.client.on("join", (channel, username, self) => {
            this.handleJoin(channel, username, self);
        });

        this.client.on("part", (channel, username, self) => {
            this.handlePart(channel, username, self);
        });

        this.client.on("message", (channel, tags, message, self) => {
            this.handleMessage(channel, tags, message, self);
        });
    }

    handleChannelPointRedemption(redemption) {
        if (!redemption) {
            return;
        }
        const userDisplay = redemption.user?.display_name || redemption.user?.login || "unknown";
        const rewardTitle = redemption.reward?.title || "Channel reward";
        log("info", `Channel points redeemed by ${userDisplay}: ${rewardTitle}`);

        if (this.mediaOverlay) {
            const handled = this.mediaOverlay.triggerReward(redemption);
            if (!handled) {
                const rewardId = redemption.reward?.id || "unknown";
                log("debug", `No media mapping configured for reward ${rewardTitle} (${rewardId})`);
            }
        }
    }

    async start() {
        await this.client.connect();
        log("info", `Joined channel #${this.channel}`);

        // Start auto-save
        this.dataPersistence.startAutoSave(() => {
            this.saveData();
        });

        if (this.mediaOverlay) {
            await this.mediaOverlay.start();
        }

        if (this.channelPointWatcher) {
            await this.channelPointWatcher.start();
        }

        // Start stream monitoring
        this.startStreamMonitoring();

        // Start inactivity tracking
        this.startInactivityTracking();
    }

    async loadPersistedData() {
        try {
            // Load user memory
            const userMemoryData = await this.dataPersistence.loadData('userMemory');
            if (userMemoryData) {
                this.userMemory.deserialize(userMemoryData);
                log("info", `Loaded ${this.userMemory.memories.size} user memories`);
            }

            // Load recent chat
            const recentChatData = await this.dataPersistence.loadData('recentChat');
            if (recentChatData) {
                this.recentChat.deserialize(recentChatData);
                log("info", `Loaded ${this.recentChat.messages.length} recent messages`);
            }

            // Load conversation threads
            const threadsData = await this.dataPersistence.loadData('conversationThreads');
            if (threadsData) {
                this.conversationThreads.deserialize(threadsData);
                log("info", `Loaded ${this.conversationThreads.threads.size} conversation threads`);
            }

            // Load bot state
            const botStateData = await this.dataPersistence.loadData('botState');
            if (botStateData) {
                if (botStateData.greetedUsers) {
                    this.greetedUsers = new Map(Object.entries(botStateData.greetedUsers));
                }
                if (botStateData.greetingsEnabled !== undefined) {
                    this.greetingsEnabled = botStateData.greetingsEnabled;
                }
                // Don't load userHasChatted - let it reset each session
                log("info", "Loaded bot state data");
            }
        } catch (err) {
            log("warn", `Failed to load persisted data: ${err.message}`);
        }
    }

    async saveData() {
        try {
            const now = Date.now();

            // Clean up old data before saving
            this.userMemory.cleanup();
            this.conversationThreads.cleanup();

            // Save user memory
            await this.dataPersistence.saveData('userMemory', this.userMemory.serialize());

            // Save recent chat
            await this.dataPersistence.saveData('recentChat', this.recentChat.serialize());

            // Save conversation threads
            await this.dataPersistence.saveData('conversationThreads', this.conversationThreads.serialize());

            // Save bot state
            const botState = {
                greetedUsers: Object.fromEntries(this.greetedUsers),
                greetingsEnabled: this.greetingsEnabled,
                // Don't save userHasChatted - let it reset each session
                lastSaved: now
            };
            await this.dataPersistence.saveData('botState', botState);

            this.lastDataSave = now;
            log("debug", "Data saved successfully");
        } catch (err) {
            log("warn", `Failed to save data: ${err.message}`);
        }
    }

    async shutdown() {
        try {
            // Stop auto-save and save final data
            this.dataPersistence.stopAutoSave();
            await this.saveData();

            // Stop game managers
            this.pollManager.cancelPoll();
            this.triviaManager.cancelTrivia();
            this.adventureManager.cancelAdventure();
            this.surviveManager.cancelSurvive();

            // Stop inactivity tracking
            this.stopInactivityTracking();

            // Stop stream monitoring
            this.stopStreamMonitoring();

            if (this.channelPointWatcher) {
                await this.channelPointWatcher.stop();
            }

            if (this.mediaOverlay) {
                await this.mediaOverlay.stop();
            }

            // Disconnect from Twitch
            await this.client.disconnect();

            log("info", "Bot shutdown complete");
        } catch (err) {
            log("warn", `Error while shutting down: ${err.message}`);
        }
    }

    startStreamMonitoring() {
        if (this.streamCheckInterval) return;
        this.streamCheckInterval = setInterval(() => {
            this.checkStreamStatus();
        }, 60000); // Check every 60 seconds
        log("info", "Started stream monitoring");
        // Initial check
        this.checkStreamStatus();
    }

    stopStreamMonitoring() {
        if (this.streamCheckInterval) {
            clearInterval(this.streamCheckInterval);
            this.streamCheckInterval = null;
            log("info", "Stopped stream monitoring");
        }
    }

    async checkStreamStatus() {
        try {
            const streamInfo = await this.getStreamInfo();
            const wasOnline = this.isStreamOnline;
            const previousGame = this.currentGame;

            if (streamInfo) {
                this.isStreamOnline = true;
                this.currentGame = streamInfo.game_name;
                this.currentTitle = streamInfo.title;
                this.streamStartTime = new Date(streamInfo.started_at).getTime();

                if (!wasOnline) {
                    // Stream just went online - start a new session
                    this.messageLogger.reset();
                    const startMessage = await this.generateStreamStartMessage(streamInfo.title, this.currentGame);
                    await this.sendMessage(startMessage);
                } else if (previousGame && previousGame !== this.currentGame) {
                    // Game changed
                    const changeMessage = await this.generateCategoryChangeMessage(previousGame, this.currentGame);
                    await this.sendMessage(changeMessage);
                }
            } else {
                this.isStreamOnline = false;
                if (wasOnline) {
                    // Stream went offline
                    await this.sendMessage("El stream se ha desconectado. Venga guapa.");

                    // Send top 10 users message
                    const topUsersMsg = this.getTopUsersMessage(10);
                    if (topUsersMsg) {
                        await this.sendMessage(topUsersMsg);
                    }
                }
            }
        } catch (err) {
            log("warn", `Failed to check stream status: ${err.message}`);
        }
    }

    async generateStreamStartMessage(title, game) {
        if (!this.groqConfig) {
            // Fallback message
            return `JaimeVaRecto está ahora en directo ${title} ${game}`;
        }

        // Gather context from user memories (no recent chat for stream start)
        const habitualUsers = Array.from(this.userMemory.memories.keys())
            .filter(user => !this.greetingIgnoreLogins.has(user.toLowerCase()))
            .slice(0, 10)
            .join(', ');
        const prompt = `Genera un mensaje de bienvenida detallado y atractivo para el inicio de un stream de Twitch, que se enviará cuando el stream comience y que los espectadores leerán al entrar. Título del stream: "${title}". Categoría: "${game}". 

Información disponible:
- Título del stream: "${title}"
- Categoría del stream: "${game}"
- Usuarios que suelen estar activos: ${habitualUsers || 'Ninguno disponible'}

El mensaje debe incluir el titulo del directo: ${title} y la categoría: ${game}". 
Haz el mensaje largo y detallado (hasta 400 caracteres), entusiasta, único cada vez. Menciona algunos usuarios habituales si es apropiado, pero sin dar por hecho que estén conectados actualmente. Responde solo con el mensaje, sin comillas ni explicaciones adicionales.`;

        const chatMessages = [
            { role: "system", content: `Eres un creador de contenido de Twitch entusiasta y creativo. Tu personalidad es: ${this.persona}.` },
            { role: "user", content: prompt }
        ];

        try {
            const aiReply = await this.fetchGroqResponse(chatMessages);
            const finalMessage = clampResponseLength(aiReply, 400);
            return finalMessage;
        } catch (err) {
            log("warn", `Failed to generate stream start message: ${err.message}`);
            return `JaimeVaRecto está ahora en directo ${title} ${game}`;
        }
    }

    async generateCategoryChangeMessage(previousGame, newGame) {
        if (!this.groqConfig) {
            // Fallback message
            return `¡Cambio de categoría! Ahora estamos jugando ${newGame} (antes: ${previousGame}).`;
        }

        // Gather context from recent chat and user memories
        const recentMessages = this.recentChat.messages.slice(-5).map(msg =>
            `${msg.displayName}: ${msg.message}`
        ).join('\n');

        const activeUsers = Array.from(this.userMemory.memories.keys()).slice(0, 10).join(', ');

        const prompt = `Genera un mensaje detallado y atractivo para anunciar un cambio de categoría en un stream de Twitch. Categoría anterior: "${previousGame}". Nueva categoría: "${newGame}". 

Información disponible:
- Título del stream actual: "${this.currentTitle || 'No disponible'}"
- Categoría actual: "${newGame}"
- Mensajes recientes del chat: ${recentMessages || 'Ninguno disponible'}
- Usuarios activos recientes: ${activeUsers || 'Ninguno disponible'}

El mensaje debe incluir exactamente esta frase: "Ahora estamos en  ${newGame}". 
Haz el mensaje largo y detallado (hasta 200 caracteres), entusiasta, único cada vez, y relacionado con la actividad reciente del chat y los usuarios. Explica por qué el cambio de categoría es emocionante y cómo se relaciona con las conversaciones recientes. Menciona algunos usuarios activos si es apropiado. Responde solo con el mensaje, sin comillas ni explicaciones adicionales.`;

        const chatMessages = [
            { role: "system", content: `Eres un creador de contenido de Twitch entusiasta y creativo. Tu personalidad es: ${this.persona}. Genera mensajes largos, detallados y atractivos que conecten con la comunidad del stream y expliquen los cambios de categoría.` },
            { role: "user", content: prompt }
        ];

        try {
            const aiReply = await this.fetchGroqResponse(chatMessages);
            const finalMessage = clampResponseLength(aiReply, 200);
            if (finalMessage && finalMessage.includes(`Ahora estamos jugando ${newGame}`)) {
                return finalMessage;
            } else {
                // Fallback if AI doesn't include the required phrase
                return `¡Cambio de categoría! Ahora estamos jugando ${newGame} (antes: ${previousGame}). ¡Vamos a explorar algo nuevo juntos!`;
            }
        } catch (err) {
            log("warn", `Failed to generate category change message: ${err.message}`);
            return `¡Cambio de categoría! Ahora estamos jugando ${newGame} (antes: ${previousGame}).`;
        }
    }

    /**
     * Generate a message with the top users who participated during the stream.
     * Returns a formatted message mentioning the top 10 users.
     */
    getTopUsersMessage(limit = 10) {
        const topUsers = this.messageLogger.getTopUsers(limit);

        if (topUsers.length === 0) {
            return null;
        }

        const userList = topUsers
            .map(user => `@${user.displayName} (${user.messageCount} mensajes)`)
            .join(', ');

        return `Top ${topUsers.length} ridículas más activas hoy: ${userList}`;
    }

    async getStreamInfo() {
        if (!this.clientId || !this.apiToken) {
            return null;
        }
        try {
            const response = await fetch(`https://api.twitch.tv/helix/streams?user_login=${this.channel}`, {
                headers: {
                    'Client-ID': this.clientId,
                    'Authorization': `Bearer ${this.apiToken}`
                }
            });
            if (response.status === 401) {
                // Token expired, try to refresh
                log("warn", "API token expired, attempting to refresh...");
                const refreshed = await this.refreshApiToken();
                if (refreshed) {
                    // Retry with new token
                    const retryResponse = await fetch(`https://api.twitch.tv/helix/streams?user_login=${this.channel}`, {
                        headers: {
                            'Client-ID': this.clientId,
                            'Authorization': `Bearer ${this.apiToken}`
                        }
                    });
                    if (retryResponse.ok) {
                        const data = await retryResponse.json();
                        return data.data && data.data.length > 0 ? data.data[0] : null;
                    }
                }
                log("error", "Failed to refresh API token");
                return null;
            }
            if (!response.ok) {
                return null;
            }
            const data = await response.json();
            return data.data && data.data.length > 0 ? data.data[0] : null;
        } catch (err) {
            log("warn", `Twitch API request failed: ${err.message}`);
            return null;
        }
    }

    async refreshApiToken() {
        if (!this.refreshToken || !this.clientId) {
            return false;
        }
        try {
            const params = {
                grant_type: 'refresh_token',
                refresh_token: this.refreshToken,
                client_id: this.clientId
            };
            if (this.clientSecret) {
                params.client_secret = this.clientSecret;
            }
            const response = await fetch('https://id.twitch.tv/oauth2/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams(params)
            });
            if (!response.ok) {
                log("error", `Token refresh failed: ${response.status}`);
                return false;
            }
            const data = await response.json();
            this.apiToken = data.access_token;
            if (data.refresh_token) {
                this.refreshToken = data.refresh_token;
            }
            log("info", "API token refreshed successfully");
            return true;
        } catch (err) {
            log("error", `Token refresh error: ${err.message}`);
            return false;
        }
    }

    handleJoin(channel, username, self) {
        if (self) {
            return;
        }
        const cleanedChannel = String(channel || "").replace(/^#/, "").toLowerCase();
        if (cleanedChannel !== this.channel) {
            return;
        }
        if (!username) {
            return;
        }
        const userKey = username.toLowerCase();
        if (userKey === this.username) {
            return;
        }
        const skipGreeting = this.greetingIgnoreLogins.has(userKey);
        this.presentUsers.add(userKey);
        // Don't delete userHasChatted - once they've chatted, no more greetings

        if (!this.initialNamesHandled && Date.now() < this.startupIgnoreUntil) {
            this.existingUsers.add(userKey);
            return;
        }

        if (this.existingUsers.has(userKey) || skipGreeting) {
            return;
        }

        this.silentUsers.add(userKey);
        if (!this.greetingsEnabled) {
            return;
        }
        this.scheduleGreeting(username);
    }

    handlePart(channel, username, self) {
        if (self) {
            return;
        }
        const cleanedChannel = String(channel || "").replace(/^#/, "").toLowerCase();
        if (cleanedChannel !== this.channel) {
            return;
        }
        if (!username) {
            return;
        }
        const userKey = username.toLowerCase();
        if (userKey === this.username) {
            return;
        }
        if (!this.greetingsEnabled) {
            return;
        }
        if (this.silentUsers.has(userKey)) {
            this.client.say(channel, `Venga guapa ${username} vete por donde viniste catJump`);
        }
        this.presentUsers.delete(userKey);
        this.userHasChatted.delete(userKey); // Reset chat status when user leaves so they can be greeted again
        this.existingUsers.delete(userKey);
        this.silentUsers.delete(userKey);
        this.inactivityTracker.clearUser(userKey); // Clear inactivity tracking
    }

    handleMessage(channel, tags, message, self) {
        if (self) {
            return;
        }
        const cleanedChannel = String(channel || "").replace(/^#/, "").toLowerCase();
        if (cleanedChannel !== this.channel) {
            return;
        }
        const userKey = (tags?.username || tags?.["display-name"] || "").toLowerCase();
        if (!userKey) {
            return;
        }
        if (userKey === this.username) {
            return;
        }
        const displayName = tags?.["display-name"] || userKey;
        const trimmedMessage = normalizeWhitespace(message);

        this.presentUsers.add(userKey);
        this.userHasChatted.add(userKey);
        this.silentUsers.delete(userKey);
        this.existingUsers.delete(userKey);

        if (!trimmedMessage) {
            return;
        }

        const timestamp = Date.now();

        // Track all messages for intelligence
        this.recentChat.addMessage(userKey, displayName, trimmedMessage, timestamp);
        this.userMemory.updateEngagement(userKey, trimmedMessage, timestamp);
        this.messageLogger.logMessage(userKey, displayName);
        this.inactivityTracker.updateActivity(userKey, displayName);

        // Handle !saluditos toggle
        if (trimmedMessage === "!saluditos" && userKey === "jaimevarecto") {
            this.greetingsEnabled = !this.greetingsEnabled;
            this.client.say(`#${this.channel}`, `Saludos ${this.greetingsEnabled ? 'activados' : 'desactivados'}`);
            return;
        }

        // Extract personality traits and themes
        this.extractIntelligence(userKey, trimmedMessage);

        this.handleSingleWordEcho(trimmedMessage, tags);

        // NEW: Handle game commands
        const lowerMessage = trimmedMessage.toLowerCase();

        // Handle poll commands
        if (lowerMessage.startsWith("!poll")) {
            this.handlePollCommand(userKey, displayName, trimmedMessage, tags);
            return;
        }

        // Handle trivia command
        if (lowerMessage === "!trivia") {
            this.handleTriviaCommand(userKey, displayName, timestamp);
            return;
        }

        // Handle trivia answers (a, b, c, d)
        if (this.triviaManager.isActive() && /^!([a-d])$/i.test(trimmedMessage)) {
            const answer = trimmedMessage.slice(1);
            const result = this.triviaManager.recordAnswer(userKey, answer);
            if (result) {
                // Silently record answer, only announce at end
            }
            return;
        }

        // Handle survive command
        if (lowerMessage === "!survive") {
            this.handleSurviveCommand(userKey, displayName, timestamp);
            return;
        }

        // Handle adventure command (must come before mention handling)
        if (lowerMessage.startsWith("!aventura")) {
            this.handleAdventureCommand(userKey, displayName, trimmedMessage, tags, timestamp);
            return;
        }

        // Handle adventure votes (!1, !2, !3, !4)
        if (this.adventureManager.isActive() && /^!(\d+)$/.test(trimmedMessage)) {
            const option = parseInt(trimmedMessage.slice(1));
            const recorded = this.adventureManager.recordVote(userKey, option);
            if (recorded) {
                // Silently record vote
            }
            return;
        }

        this.handleMention({
            userKey,
            displayName,
            message: trimmedMessage,
            tags,
            timestamp
        });

        // Auto-trigger media based on message content
        const messageWords = lowerMessage.split(/\s+/).filter(word => word.length > 3);
        const matchingTitles = new Set();
        if (this.mediaOverlay) {
            for (const word of messageWords) {
                for (const title of this.getAllTitles()) {
                    const reward = this.mediaOverlay.rewardNameMap[title];
                    if (reward && (reward.type === "video" || reward.type === "audio") && title.toLowerCase().includes(word)) {
                        matchingTitles.add(title);
                    }
                }
            }
            const matchingTitlesArray = Array.from(matchingTitles);
            if (matchingTitlesArray.length > 0 && Math.random() < this.autoTriggerChance) {
                const randomIndex = Math.floor(Math.random() * matchingTitlesArray.length);
                const selectedTitle = matchingTitlesArray[randomIndex];
                this.triggerMediaByTitle(selectedTitle, displayName);
            }
        }
    }


    scheduleGreeting(username) {
        const userKey = username.toLowerCase();
        if (userKey === this.username) {
            return;
        }
        const skipGreeting = this.greetingIgnoreLogins.has(userKey);
        if (this.existingUsers.has(userKey) || skipGreeting) {
            return;
        }
        if (this.userHasChatted.has(userKey)) {
            return;
        }

        const now = Date.now();
        const lastGreeting = this.greetedUsers.get(userKey);

        if (!this.presentUsers.has(userKey)) {
            this.presentUsers.add(userKey);
        }

        this.sendGreeting(username);
    }

    sendGreeting(username) {
        const text = this.pickGreeting(username);
        const userKey = username.toLowerCase();
        const now = Date.now();
        this.client.say(`#${this.channel}`, text).then(() => {
            this.greetedUsers.set(userKey, now);
            log("info", `Greeted ${username}`);
        }).catch((err) => {
            log("warn", `Failed to greet ${username}: ${err.message}`);
        });
    }

    pickGreeting(username) {
        const index = Math.floor(Math.random() * this.messages.length);
        return this.messages[index].replace(/\{user\}/g, username);
    }

    handleInitialNames(channel, rawUsers) {
        const cleanedChannel = String(channel || "").replace(/^#/, "").toLowerCase();
        if (cleanedChannel !== this.channel) {
            return;
        }
        if (this.initialNamesHandled) {
            return;
        }

        const users = Array.isArray(rawUsers)
            ? rawUsers
            : rawUsers && typeof rawUsers === "object"
                ? Object.keys(rawUsers)
                : [];

        let suppressed = 0;
        for (const name of users) {
            const key = typeof name === "string" ? name.toLowerCase() : "";
            if (!key || key === this.username || this.greetingIgnoreLogins.has(key)) {
                continue;
            }
            this.presentUsers.add(key);
            this.existingUsers.add(key);
            suppressed += 1;
        }

        this.initialNamesHandled = true;
        this.startupIgnoreUntil = Date.now();

        if (suppressed > 0) {
            log("debug", `Suppressed greetings for ${suppressed} existing viewers.`);
        }
    }

    extractIntelligence(userKey, message) {
        const lowerMessage = message.toLowerCase();

        // Extract personality traits
        if (lowerMessage.includes('lol') || lowerMessage.includes('haha') || lowerMessage.includes('😂')) {
            this.userMemory.addPersonalityTrait(userKey, 'humorous');
        }
        if (lowerMessage.includes('thanks') || lowerMessage.includes('thx') || lowerMessage.includes('appreciate')) {
            this.userMemory.addPersonalityTrait(userKey, 'polite');
        }
        if (lowerMessage.includes('!') && lowerMessage.length < 20) {
            this.userMemory.addPersonalityTrait(userKey, 'enthusiastic');
        }
        if (lowerMessage.includes('?')) {
            this.userMemory.addPersonalityTrait(userKey, 'curious');
        }

        // Extract conversation themes
        const gameKeywords = ['playing', 'game', 'level', 'boss', 'win', 'lose', 'score'];
        const techKeywords = ['code', 'programming', 'bug', 'feature', 'api', 'github'];
        const musicKeywords = ['song', 'music', 'beat', 'artist', 'album', 'playlist'];

        if (gameKeywords.some(keyword => lowerMessage.includes(keyword))) {
            this.userMemory.addConversationTheme(userKey, 'gaming');
        }
        if (techKeywords.some(keyword => lowerMessage.includes(keyword))) {
            this.userMemory.addConversationTheme(userKey, 'technology');
        }
        if (musicKeywords.some(keyword => lowerMessage.includes(keyword))) {
            this.userMemory.addConversationTheme(userKey, 'music');
        }
    }

    handleSingleWordEcho(message, tags) {
        if (!message || message.includes(" ")) {
            return;
        }
        if (this.singleWordEchoChance <= 0) {
            return;
        }
        if (Math.random() >= this.singleWordEchoChance) {
            return;
        }
        const firstChar = message.charAt(0);
        if (firstChar === "@" || firstChar === "!") {
            return;
        }
        const replyParentLogin = (tags?.["reply-parent-user-login"] || "").toLowerCase();
        if (replyParentLogin === this.username) {
            return;
        }
        const sendEcho = () => {
            this.client.say(`#${this.channel}`, message).catch((err) => {
                log("warn", `Failed to repeat single-word message: ${err.message}`);
            });
        };

        if (this.singleWordEchoDelayMs > 0) {
            setTimeout(sendEcho, this.singleWordEchoDelayMs);
        } else {
            sendEcho();
        }
    }

    handleMention({ userKey, displayName, message, tags, timestamp }) {
        const mentionToken = `@${this.username}`;
        const lowerMessage = message.toLowerCase();
        const hasMention = lowerMessage.includes(mentionToken);
        const replyParentLogin = (tags?.["reply-parent-user-login"] || "").toLowerCase();
        const isReplyToBot = replyParentLogin === this.username;

        if (!hasMention && !isReplyToBot) {
            return;
        }

        const replyToId = tags?.id || tags?.["id"];
        const mentionContext = { hasMention, isReplyToBot, replyParentLogin };

        // Create or get conversation thread
        const threadId = this.conversationThreads.getOrCreateThread(
            userKey,
            isReplyToBot,
            replyParentLogin
        );

        // Add user message to thread
        this.conversationThreads.addMessage(threadId, 'user', message, timestamp);

        this.respondToMention({
            userKey,
            displayName,
            message,
            replyToId,
            mentionContext,
            threadId,
            timestamp
        });
    }

    async respondToMention({ userKey, displayName, message, replyToId, mentionContext, threadId, timestamp }) {
        if (!this.groqConfig) {
            log("warn", "Groq configuration is missing; cannot respond to mentions.");
            return;
        }
        if (!this.canSendAIResponse(userKey)) {
            return;
        }
        if (this.pendingAIRequests.has(userKey)) {
            log("debug", `Skipping AI reply for ${displayName} (request already pending).`);
            return;
        }

        this.pendingAIRequests.add(userKey);

        try {
            const chatMessages = this.buildAIChatMessages({ userKey, displayName, message, mentionContext, threadId });
            if (!chatMessages.length) {
                return;
            }

            let aiReply = await this.fetchGroqResponse(chatMessages);
            let finalMessage = clampResponseLength(aiReply, this.aiMaxChars);
            if (!finalMessage) {
                log("debug", `Groq returned empty response for ${displayName}.`);
                return;
            }



            // Ensure finalMessage is not empty - if it is, use a fallback
            if (!finalMessage || finalMessage.trim().length === 0) {
                log("warn", `finalMessage is empty after processing. Setting fallback response.`);
                finalMessage = "lo siento, tuve un problema para procesar tu pregunta";
            }

            log("debug", `Final message to send: "${finalMessage}"`);
            await this.sendMessage(finalMessage, replyToId);

            // Update both old and new conversation tracking
            this.updateConversationHistory(userKey, message, finalMessage);
            this.conversationThreads.addMessage(threadId, 'assistant', finalMessage, Date.now());

            const now = Date.now();
            this.userLastAIResponseAt.set(userKey, now);
            this.lastAIGlobalResponseAt = now;

            log("debug", `Replied to ${displayName} via Groq.`);
        } catch (err) {
            log("warn", `Failed to reply to ${displayName}: ${err.message}`);
        } finally {
            this.pendingAIRequests.delete(userKey);
        }
    }

    canSendAIResponse(userKey) {
        const now = Date.now();
        if (this.aiGlobalCooldownMs > 0 && now - this.lastAIGlobalResponseAt < this.aiGlobalCooldownMs) {
            log("debug", "Skipping Groq reply (global cooldown active).");
            return false;
        }
        const lastUser = this.userLastAIResponseAt.get(userKey);
        if (this.aiUserCooldownMs > 0 && lastUser && now - lastUser < this.aiUserCooldownMs) {
            log("debug", `Skipping Groq reply for ${userKey} (user cooldown active).`);
            return false;
        }
        return true;
    }

    buildAIChatMessages({ userKey, displayName, message, mentionContext, threadId }) {
        const personaText = this.persona;
        const limitsLine = `Responde en no mas de ${this.aiMaxChars} caracteres.`;

        const alias = this.aliases[userKey] || displayName;

        // Build comprehensive context
        const contextParts = [];

        // Current time and stream context
        const now = new Date();
        const streamDuration = Math.floor((Date.now() - this.streamStartTime) / (1000 * 60));
        let streamContext = `Hora actual: ${now.toLocaleTimeString('es-ES')}. Stream activo por ${streamDuration} minutos.`;
        if (this.currentGame) {
            streamContext += ` Categoría: ${this.currentGame}.`;
        }
        contextParts.push(streamContext);

        // Recent chat context
        const recentContext = this.recentChat.getRecentContext(userKey);
        if (recentContext) {
            contextParts.push(`Mensajes recientes en el chat: ${recentContext}`);
        }

        // User memory and personality
        const userSummary = this.userMemory.getUserSummary(userKey);
        if (userSummary) {
            const memoryParts = [];
            if (userSummary.messageCount > 0) {
                memoryParts.push(`${userSummary.messageCount} mensajes`);
            }
            if (userSummary.personality.length > 0) {
                memoryParts.push(`personalidad: ${userSummary.personality.join(', ')}`);
            }
            if (userSummary.themes.length > 0) {
                memoryParts.push(`temas de interes: ${userSummary.themes.join(', ')}`);
            }
            if (userSummary.topWords.length > 0) {
                memoryParts.push(`palabras comunes: ${userSummary.topWords.join(', ')}`);
            }
            if (memoryParts.length > 0) {
                contextParts.push(`Sobre ${alias}: ${memoryParts.join('; ')}.`);
            }
        }

        // Conversation thread context
        const threadHistory = this.conversationThreads.getThread(threadId, 6);
        const threadContext = threadHistory
            .filter(msg => msg.timestamp > Date.now() - (10 * 60 * 1000)) // Last 10 minutes
            .map(msg => `${msg.role === 'user' ? alias : 'Tú'}: ${msg.content}`)
            .join('; ');
        if (threadContext) {
            contextParts.push(`Conversación reciente: ${threadContext}`);
        }

        const contextText = contextParts.length > 0 ? `\n\nContexto: ${contextParts.join(' ')}` : '';

        const descriptor = mentionContext.isReplyToBot
            ? "El espectador esta respondiendo directamente a tu ultimo mensaje."
            : "El espectador te esta mencionando en el chat.";

        const systemContent = `${personaText}${contextText}\n${limitsLine}`;

        // Get traditional conversation history as fallback
        const history = this.getConversationHistory(userKey);

        const userContent = `${descriptor}\nUsuario ${alias} dice: ${message}`;

        return [
            { role: "system", content: systemContent },
            ...history,
            { role: "user", content: userContent }
        ];
    }

    getConversationHistory(userKey) {
        const history = this.conversationHistory.get(userKey);
        if (!Array.isArray(history) || history.length === 0) {
            return [];
        }
        if (!this.aiHistoryLimit || history.length <= this.aiHistoryLimit) {
            return history.slice();
        }
        return history.slice(-this.aiHistoryLimit);
    }

    updateConversationHistory(userKey, userMessage, botMessage) {
        const normalizedUser = normalizeWhitespace(userMessage);
        const normalizedBot = normalizeWhitespace(botMessage);
        if (!normalizedUser && !normalizedBot) {
            return;
        }
        const history = this.conversationHistory.get(userKey) || [];
        if (normalizedUser) {
            history.push({ role: "user", content: normalizedUser });
        }
        if (normalizedBot) {
            history.push({ role: "assistant", content: normalizedBot });
        }
        if (this.aiHistoryLimit > 0 && history.length > this.aiHistoryLimit) {
            history.splice(0, history.length - this.aiHistoryLimit);
        }
        this.conversationHistory.set(userKey, history);
    }







    async sendMessage(message, replyToId) {
        const text = normalizeWhitespace(message);
        if (!text) {
            return;
        }
        const channelName = `#${this.channel}`;
        if (replyToId) {
            const command = `@reply-parent-msg-id=${replyToId} PRIVMSG ${channelName} :${text}`;
            await this.client.raw(command);
        } else {
            await this.client.say(channelName, text);
        }
    }

    async sendLongMessage(message, replyToId = null) {
        const text = normalizeWhitespace(message);
        if (!text) {
            return;
        }
        const maxLength = 500;
        if (text.length <= maxLength) {
            await this.sendMessage(text, replyToId);
            return;
        }
        // Split into parts
        const parts = [];
        let remaining = text;
        while (remaining.length > maxLength) {
            let cutAt = maxLength;
            // Try to cut at word boundary
            while (cutAt > 0 && remaining[cutAt] !== ' ') {
                cutAt--;
            }
            if (cutAt === 0) cutAt = maxLength; // No space found, cut anyway
            parts.push(remaining.substring(0, cutAt));
            remaining = remaining.substring(cutAt).trim();
        }
        if (remaining) parts.push(remaining);

        for (const part of parts) {
            await this.sendMessage(part, replyToId);
            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    async fetchGroqResponse(messages) {
        if (!this.groqConfig) {
            return "";
        }
        const { baseUrl, apiKey, models, temperature, timeoutMs, maxTokens } = this.groqConfig;
        const modelList = Array.isArray(models) && models.length ? models : ["llama-3.3-70b-versatile"];
        const errors = [];

        for (const model of modelList) {
            try {
                log("debug", `Calling Groq model ${model}`);
                const response = await fetch(`${baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${apiKey}`
                    },
                    body: JSON.stringify({
                        model,
                        messages,
                        temperature,
                        max_tokens: maxTokens
                    }),
                    timeout: timeoutMs
                });

                if (!response.ok) {
                    const error = new Error(`Groq API returned status ${response.status}`);
                    error.status = response.status;
                    try {
                        error.detail = await response.text();
                    } catch (err) {
                        error.detail = "<failed to read response body>";
                    }
                    throw error;
                }

                const payload = await response.json();
                const text = normalizeWhitespace(payload?.choices?.[0]?.message?.content || "");
                if (!text) {
                    throw new Error("Groq returned an empty response");
                }
                if (model !== modelList[0]) {
                    log("info", `Fallback Groq model ${model} succeeded.`);
                }
                return text;
            } catch (err) {
                errors.push({ model, err });
                const detail = err && err.detail ? ` detail: ${err.detail}` : "";
                log("warn", `Groq model ${model} failed: ${err.message}${detail}`);
            }
        }

        const summary = errors.map(({ model, err }) => {
            const detail = err && err.detail ? ` detail: ${err.detail}` : "";
            return `${model}: ${err.message}${detail}`;
        }).join("; ");
        throw new Error(`All Groq models failed (${summary || "no detail"})`);
    }



    getAllTitles() {
        if (!this.mediaOverlay) {
            return [];
        }
        return Object.keys(this.mediaOverlay.rewardNameMap);
    }

    triggerMediaByTitle(title, userDisplayName) {
        if (!this.mediaOverlay) {
            return false;
        }
        return this.mediaOverlay.triggerByTitle(title, userDisplayName);
    }

    // ===== POLL COMMAND HANDLERS =====
    handlePollCommand(userKey, displayName, message, tags) {
        const args = message.split(/\s+/).slice(1);

        if (args.length === 0) {
            const helpText = `¡Encuestas! Uso: !poll "<pregunta>" | "opción 1" "opción 2" ["opción 3"] [tiempo_segundos]
Ejemplo: !poll "¿Qué categoría?" "Gaming" "IRL" "Retro" 60`;
            this.sendMessage(helpText);
            return;
        }

        // Simple parsing: looks for text between quotes
        const match = message.match(/"([^"]*)"/g);
        if (!match || match.length < 3) {
            this.sendMessage(`❌ Formato inválido. Usa: !poll "<pregunta>" "opción1" "opción2" ... [tiempo_en_segundos]`);
            return;
        }

        const question = match[0].slice(1, -1);
        const options = match.slice(1).map(m => m.slice(1, -1));

        if (options.length < 2) {
            this.sendMessage(`❌ Necesitas al menos 2 opciones.`);
            return;
        }

        // Extract duration if specified
        let durationMs = 60000; // Default 60 seconds
        const lastArg = args[args.length - 1];
        if (!lastArg.includes('"') && !isNaN(parseInt(lastArg))) {
            durationMs = Math.min(300000, Math.max(10000, parseInt(lastArg) * 1000));
        }

        const started = this.pollManager.startPoll(question, options, durationMs);
        if (!started) {
            this.sendMessage(`❌ Ya hay una encuesta activa o parámetros inválidos.`);
            return;
        }

        const optionsList = options.map((opt, idx) => `${idx + 1}) ${opt}`).join(" | ");
        this.sendMessage(`📊 ENCUESTA: ${question}`);
        this.sendMessage(`${optionsList}`);
        this.sendMessage(`¡Vota con !1, !2, !3, etc. Tiempo: ${Math.round(durationMs / 1000)}s!`);

        this.pollManager.scheduleAutoEnd((results) => {
            this.handlePollEnd(results);
        });
    }

    handlePollEnd(results) {
        if (!results || results.totalVotes === 0) {
            this.sendMessage(`📊 Encuesta cerrada. Nadie votó.`);
            return;
        }

        let resultsText = `📊 Resultados: ${results.question}\n`;
        for (const option of results.options) {
            const barLength = Math.round((option.votes / results.totalVotes) * 20);
            const bar = '█'.repeat(barLength) + '░'.repeat(20 - barLength);
            const percentage = Math.round((option.votes / results.totalVotes) * 100);
            resultsText += `${option.number}) ${option.text}: ${bar} ${option.votes} votos (${percentage}%)\n`;
        }

        if (results.winners.length === 1) {
            resultsText += `🎉 ¡GANADOR: Opción ${results.winners[0]}!`;
        } else {
            resultsText += `🏳️ Empate entre opciones: ${results.winners.join(', ')}`;
        }

        this.sendLongMessage(resultsText);
    }

    async handlePollVote(userKey, optionIndex) {
        const recorded = this.pollManager.recordVote(userKey, optionIndex);
        if (!recorded) {
            // Already voted or invalid
            return;
        }
    }

    // ===== TRIVIA COMMAND HANDLERS =====
    async handleTriviaCommand(userKey, displayName, timestamp) {
        if (this.triviaManager.isActive()) {
            this.sendMessage(`❌ Ya hay una trivia activa. ¡Responde con !a, !b, !c o !d!`);
            return;
        }

        const result = await this.triviaManager.startTrivia('general', 30000, (msgs) => this.fetchGroqResponse(msgs));
        if (!result) {
            this.sendMessage(`❌ No pude generar la pregunta. Intenta más tarde.`);
            return;
        }

        this.sendMessage(`🧠 TRIVIA: ${result.question}`);
        this.sendMessage(`a) ${result.options.a} | b) ${result.options.b} | c) ${result.options.c} | d) ${result.options.d}`);
        this.sendMessage(`⏰ Responde con !a, !b, !c o !d en ${result.durationSeconds} segundos!`);

        this.triviaManager.scheduleAutoEnd((results) => {
            this.handleTriviaEnd(results);
        });
    }

    handleTriviaEnd(results) {
        if (!results) {
            return;
        }

        let message = `🧠 Trivia terminada!\n`;
        message += `Pregunta: ${results.question}\n`;
        message += `✅ Respuesta correcta: ${results.correct.toUpperCase()}\n`;
        message += `${results.explanation}\n`;
        message += `✅ Acertaron: ${results.correctCount} | ❌ Fallaron: ${results.wrongCount}`;

        if (results.correctCount > 0) {
            const winners = results.correctAnswers.slice(0, 5).join(', ');
            message += `\n🏆 Ganadores: ${winners}${results.correctAnswers.length > 5 ? ` +${results.correctAnswers.length - 5}` : ''}`;
        }

        this.sendLongMessage(message);
    }

    // ===== SURVIVE COMMAND HANDLERS =====
    handleSurviveCommand(userKey, displayName, timestamp) {
        if (this.surviveManager.isActive()) {
            // Game is active - record this player's survival attempt
            const recorded = this.surviveManager.recordSurvive(userKey);
            if (recorded && recorded.status === 'recorded') {
                // Only announce every few survivals to avoid spam
                if (recorded.survivorsCount % 3 === 0 || recorded.survivorsCount === 1) {
                    const status = this.surviveManager.getStatus();
                    this.sendMessage(`✅ @${displayName} sobrevivió! Ronda ${status.roundNumber}: ${recorded.survivorsCount}/${status.playersInRound} 🏃‍♂️`);
                }
            }
            return;
        }

        // Start new survive game with current users
        const users = Array.from(this.presentUsers);
        const startedData = this.surviveManager.startSurvive(users, 30000); // 30 seconds per round

        if (!startedData) {
            this.sendMessage(`❌ Necesitas al menos 2 personas conectadas para jugar.`);
            return;
        }

        this.sendMessage(`🎮 ¡SURVIVE - Battle Royale de Chat!`);
        this.sendMessage(`${startedData.message}`);
        this.sendMessage(`Jugadores iniciales: ${startedData.count}`);

        // Schedule end of first round
        this.surviveManager.scheduleRoundEnd((roundResult) => {
            this.handleSurviveRoundEnd(roundResult);
        });
    }

    handleSurviveRoundEnd(roundResult) {
        if (!roundResult) {
            return;
        }

        const status = this.surviveManager.getStatus();

        if (roundResult.eliminatedThisRound.length > 0) {
            const eliminated = roundResult.eliminatedThisRound.join(', ');
            this.sendMessage(`💀 Ronda ${status.roundNumber - 1}: Eliminados → ${eliminated}`);
        }

        if (!roundResult.continueGame) {
            // Game has ended
            this.handleSurviveEnd(roundResult);
            return;
        }

        // Continue to next round
        this.sendMessage(`\n🎮 Ronda ${roundResult.newRoundNumber}: ${roundResult.playersForNextRound} supervivientes restantes!`);
        this.sendMessage(`¡Escribid !survive para sobrevivir!`);

        // Schedule next round end
        this.surviveManager.scheduleRoundEnd((nextRoundResult) => {
            this.handleSurviveRoundEnd(nextRoundResult);
        });
    }

    handleSurviveEnd(roundResult) {
        if (!roundResult) {
            return;
        }

        let message = `\n🏆 ¡FIN DEL SURVIVE!\n`;
        message += `Total de jugadores: ${roundResult.totalPlayers}\n`;
        message += `Rondas jugadas: ${roundResult.roundsPlayed}\n`;
        message += `Eliminados totales: ${roundResult.losersCount}\n`;

        if (roundResult.winners.length === 1) {
            message += `\n🥇 ¡CAMPEÓN: ${roundResult.winners[0]}!`;
        } else if (roundResult.winners.length > 1) {
            message += `\n🥇 Ganadores: ${roundResult.winners.join(', ')}`;
        } else {
            message += `\n😱 ¡Nadie sobrevivió!`;
        }

        if (roundResult.eliminated.length > 0) {
            const eliminated = roundResult.eliminated.slice(0, 10).join(', ');
            message += `\n❌ Eliminados (${roundResult.eliminated.length}): ${eliminated}${roundResult.eliminated.length > 10 ? ` +${roundResult.eliminated.length - 10}` : ''}`;
        }

        this.sendLongMessage(message);
    }

    // ===== ADVENTURE COMMAND HANDLERS (NEW) =====
    async handleAdventureCommand(userKey, displayName, message, tags, timestamp) {
        const parts = message.split(/\s+/).slice(1);
        let theme = '';
        let difficulty = 'normal';

        // Parse arguments: !aventura [theme] [difficulty]
        if (parts.length === 0) {
            theme = 'una aventura de las Pentis';
        } else if (parts.length === 1) {
            const last = parts[0].toLowerCase();
            if (['fácil', 'normal', 'difícil'].includes(last)) {
                difficulty = last;
                theme = 'una aventura de las Pentis';
            } else {
                theme = parts.join(' ');
            }
        } else {
            const last = parts[parts.length - 1].toLowerCase();
            if (['fácil', 'normal', 'difícil'].includes(last)) {
                difficulty = last;
                theme = parts.slice(0, -1).join(' ');
            } else {
                theme = parts.join(' ');
            }
        }

        if (this.adventureManager.isActive()) {
            this.sendMessage(`❌ Ya hay una aventura en curso. ¡Votad con !1, !2, etc!`);
            return;
        }

        const result = await this.adventureManager.startAdventure(theme, difficulty, (msgs) => this.fetchGroqResponse(msgs));
        if (!result) {
            this.sendMessage(`❌ No pude iniciar la aventura. Intenta más tarde.`);
            return;
        }

        this.sendMessage(`⚔️ AVENTURA (${difficulty.toUpperCase()}): ${result.story}`);

        for (let i = 0; i < result.options.length; i++) {
            this.sendMessage(`${i + 1}) ${result.options[i]}`);
        }

        this.sendMessage(`¡Votad con !${Array.from({ length: result.options.length }, (_, i) => i + 1).join(' o !')} en 60 segundos!`);
        this.sendMessage(result.warning);

        // Schedule voting end
        setTimeout(() => this.handleAdventureVotingEnd(), 60000);
    }

    async handleAdventureVotingEnd() {
        if (!this.adventureManager.isActive()) {
            return;
        }

        const winner = this.adventureManager.getWinningOption();
        if (!winner) {
            this.adventureManager.cancelAdventure();
            this.sendMessage(`❌ Nadie votó. Aventura cancelada.`);
            return;
        }

        this.sendMessage(`🗳️ Opción ${winner.option} gana con ${winner.votes} votos: "${winner.text}"`);

        const continueResult = await this.adventureManager.continueAdventure(winner.text, (msgs) => this.fetchGroqResponse(msgs));

        if (!continueResult) {
            this.adventureManager.cancelAdventure();
            this.sendMessage(`❌ Error continuando la aventura.`);
            return;
        }

        if (continueResult.options) {
            // Continue adventure
            this.sendMessage(`⚔️ ${continueResult.story}`);

            for (let i = 0; i < continueResult.options.length; i++) {
                this.sendMessage(`${i + 1}) ${continueResult.options[i]}`);
            }

            this.sendMessage(`¡Votad de nuevo en 60 segundos!`);
            this.sendMessage(continueResult.warning);

            setTimeout(() => this.handleAdventureVotingEnd(), 60000);
        } else {
            // Adventure ended
            this.sendMessage(`⚰️ FIN DE LA AVENTURA (Ronda ${continueResult.round}):`);
            this.sendMessage(continueResult.ending);

            if (continueResult.reason === 'death') {
                this.sendMessage(`💀 Todos murieron heroicamente.`);
            }
        }
    }

    // ===== INACTIVITY SYSTEM =====
    async startInactivityTracking() {
        if (this.inactivityCheckInterval) {
            return;
        }

        this.inactivityCheckInterval = setInterval(async () => {
            const shameCandidate = this.inactivityTracker.getShameCandidate();
            if (shameCandidate && this.groqConfig) {
                await this.sendShameMessage(shameCandidate);
            }
        }, 120000); // Check every 2 minutes

        log("info", "Inactivity tracking started");
    }

    stopInactivityTracking() {
        if (this.inactivityCheckInterval) {
            clearInterval(this.inactivityCheckInterval);
            this.inactivityCheckInterval = null;
        }
    }

    async sendShameMessage(shameCandidate) {
        const prompt = `Genera un mensaje largo y sarcástico (150-200 caracteres) fingiendo que te duele profundamente que @${shameCandidate.displayName} no te haga caso.
Usuario ha estado inactivo ${shameCandidate.inactiveForMinutes} minutos.
Sé muy cómico, melodramático y sarcástico. Exagera tus sentimientos heridos.
Responde solo con el mensaje, sin comillas.`;

        const chatMessages = [
            {
                role: "system",
                content: `Eres un bot de Twitch en el canal jaimevarecto que es profundamente dramático y sarcástico cuando los usuarios se ignoran. Eres muy cómico y exageras tus emociones de forma que la gente te quiere más. 
Personalidad: ${this.persona}`
            },
            { role: "user", content: prompt }
        ];

        try {
            const aiReply = await this.fetchGroqResponse(chatMessages);
            const finalMessage = clampResponseLength(aiReply, 200);

            if (finalMessage && finalMessage.length > 0) {
                await this.sendMessage(finalMessage);
                this.inactivityTracker.recordShame(shameCandidate.userKey);
                log("debug", `Sent shame message to ${shameCandidate.displayName}`);
            }
        } catch (err) {
            log("warn", `Failed to generate shame message: ${err.message}`);
        }
    }
}

module.exports = TwitchChatBot;
