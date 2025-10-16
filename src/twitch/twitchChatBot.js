const tmi = require("tmi.js");
const fetch = require("node-fetch");
const { log, isDebugEnabled } = require("../logger");
const { normalizeWhitespace, clampResponseLength } = require("../utils/text");
const DataPersistence = require("../persistence/dataPersistence");
const UserMemory = require("../intelligence/userMemory");
const RecentChatTracker = require("../intelligence/recentChatTracker");
const ConversationThreads = require("../intelligence/conversationThreads");
const MediaOverlayServer = require("../media/mediaOverlayServer");
const ChannelPointsWatcher = require("./channelPointsWatcher");
const { IGNORED_USERS } = require("./constants");
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
        braveConfig,
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
        this.braveConfig = braveConfig;
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
        this.conversationHistory = new Map();
        this.pendingAIRequests = new Set();
        this.userLastAIResponseAt = new Map();
        this.lastAIGlobalResponseAt = 0;

        // Intelligence features
        this.dataPersistence = new DataPersistence(intelligence?.persistence);
        this.userMemory = new UserMemory(intelligence?.userMemoryLimit, intelligence?.engagementTrackingDays);
        this.recentChat = new RecentChatTracker(intelligence?.recentChatLimit, intelligence?.contextWindowMinutes);
        this.conversationThreads = new ConversationThreads(intelligence?.conversationThreads);
        this.streamStartTime = Date.now();
        this.lastDataSave = 0;

        // Stream monitoring
        this.isStreamOnline = false;
        this.currentGame = null;
        this.currentTitle = null;
        this.streamCheckInterval = null;

        // Adventure game features
        this.adventureGame = {
            active: false,
            story: '',
            options: [],
            votes: new Map(),
            voters: new Set(),
            timer: null,
            votingTime: this.adventureConfig?.votingTimeMs ?? 30000,
            round: 0,
            maxRounds: this.adventureConfig?.defaultMaxRounds ?? 3
        };

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

            // Stop adventure game timer
            if (this.adventureGame.timer) {
                clearTimeout(this.adventureGame.timer);
            }

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
                    // Stream just went online
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
        const activeUsers = Array.from(this.userMemory.memories.keys()).slice(0, 10).join(', ');
        const prompt = `Genera un mensaje de bienvenida detallado y atractivo para el inicio de un stream de Twitch. Título del stream: "${title}". Categoría: "${game}". 

Información disponible:
- Título del stream: "${title}"
- Categoría del stream: "${game}"
- Usuarios activos recientes: ${activeUsers || 'Ninguno disponible'}

El mensaje debe incluir exactamente esta frase: "JaimeVaRecto está ahora en directo ${title} ${game}". 
Haz el mensaje largo y detallado (hasta 200 caracteres), entusiasta, único cada vez. Menciona algunos usuarios activos si es apropiado. Responde solo con el mensaje, sin comillas ni explicaciones adicionales.`;

        const chatMessages = [
            { role: "system", content: `Eres un creador de contenido de Twitch entusiasta y creativo. Tu personalidad es: ${this.persona}. Genera mensajes largos, detallados y atractivos que conecten con la comunidad del stream.` },
            { role: "user", content: prompt }
        ];

        try {
            const aiReply = await this.fetchGroqResponse(chatMessages);
            const finalMessage = clampResponseLength(aiReply, 200);
            if (finalMessage && finalMessage.includes(`JaimeVaRecto está ahora en directo ${title} ${game}`)) {
                return finalMessage;
            } else {
                // Fallback if AI doesn't include the required phrase
                return `¡Bienvenidos de vuelta! JaimeVaRecto está ahora en directo ${title} ${game}. ¡Vamos a continuar la diversión donde la dejamos!`;
            }
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
        if (this.silentUsers.has(userKey)) {
            this.client.say(channel, `Venga guapa ${username} vete por donde viniste catJump`);
        }
        this.presentUsers.delete(userKey);
        this.userHasChatted.delete(userKey); // Reset chat status when user leaves so they can be greeted again
        this.existingUsers.delete(userKey);
        this.silentUsers.delete(userKey);
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

        // Extract personality traits and themes
        this.extractIntelligence(userKey, trimmedMessage);

        this.handleSingleWordEcho(trimmedMessage, tags);
        this.handleMention({
            userKey,
            displayName,
            message: trimmedMessage,
            tags,
            timestamp
        });

        // Handle adventure game votes
        if (this.adventureGame.active && trimmedMessage.match(/^!(\d+)$/)) {
            const option = parseInt(trimmedMessage.slice(1));
            if (option >= 1 && option <= this.adventureGame.options.length) {
                if (this.adventureGame.voters.has(userKey)) {
                    this.client.say(`#${this.channel}`, `@${displayName}, ya votaste en esta ronda, RIDÍCULA.`);
                    return;
                }
                this.adventureGame.voters.add(userKey);
                this.adventureGame.votes.set(option, (this.adventureGame.votes.get(option) || 0) + 1);
                log("debug", `Vote for option ${option} by ${displayName}`);
            }
        }

        // Auto-trigger rewards based on message content
        const lowerMessage = trimmedMessage.toLowerCase();
        const matchingTitles = [];
        for (const title of this.getAllTitles()) {
            const titleWords = title.split(/\s+/);
            if (titleWords.length > 3) {
                for (const word of titleWords) {
                    if (word && lowerMessage.includes(word)) {
                        matchingTitles.push(title);
                        break;
                    }
                }
            }
        }
        if (matchingTitles.length > 0 && Math.random() < this.autoTriggerChance) {
            const randomIndex = Math.floor(Math.random() * matchingTitles.length);
            const selectedTitle = matchingTitles[randomIndex];
            this.triggerMediaByTitle(selectedTitle, displayName);
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

        // Handle adventure command
        if (lowerMessage.startsWith('!aventura')) {
            this.handleAdventureCommand(userKey, displayName, message, tags, timestamp);
            return;
        }

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

            const maxSearchAttempts = 2;
            let searchAttempts = 0;
            let directive = this.extractSearchDirective(finalMessage);
            let hasNotifiedUser = false;

            while (directive && searchAttempts < maxSearchAttempts) {
                const query = directive.query;
                if (!query) {
                    log("debug", "Search directive detected without query. Removing directive.");
                    finalMessage = directive.cleaned;
                    break;
                }

                // Notify user that a search is being performed
                if (!hasNotifiedUser) {
                    log("debug", `Performing web search for: ${query}`);
                    await this.sendMessage(`Buscando información sobre "${query}"...`, replyToId);
                    hasNotifiedUser = true;
                    // Small delay to ensure notification is sent before search
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

                const searchResults = await this.searchWeb(query);
                if (searchResults === 'Search failed.' || searchResults === 'Web search not configured.') {
                    finalMessage = `Lo siento, no pude obtener información de internet para "${query}". ${directive.cleaned}`;
                    directive = null;
                    break;
                }
                chatMessages.push({
                    role: "system",
                    content: `Resultados de busqueda web para "${query}": ${searchResults}`
                });

                searchAttempts += 1;

                const retryAiReply = await this.fetchGroqResponse(chatMessages);
                const retryMessage = clampResponseLength(retryAiReply, this.aiMaxChars);
                if (retryMessage) {
                    aiReply = retryAiReply;
                    finalMessage = retryMessage;
                    directive = this.extractSearchDirective(finalMessage);
                    continue;
                }

                finalMessage = `Resultados de busqueda para "${query}": ${searchResults}`;
                directive = null;
                break;
            }

            if (directive) {
                finalMessage = directive.cleaned;
            } else {
                const leftoverDirective = this.extractSearchDirective(finalMessage);
                if (leftoverDirective) {
                    finalMessage = leftoverDirective.cleaned;
                }
            }

            // Final cleanup to ensure no search directives are sent to chat
            const finalDirective = this.extractSearchDirective(finalMessage);
            if (finalDirective) {
                finalMessage = finalDirective.cleaned;
            }

            if (!finalMessage) {
                log("debug", `Groq returned empty response for ${displayName} after search handling.`);
                return;
            }

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

    async handleAdventureCommand(userKey, displayName, message, tags, timestamp) {
        if (this.adventureGame.active) {
            this.client.say(`#${this.channel}`, `${displayName}, ya hay una aventura en curso. ¡Vota con !1 o !2!`);
            return;
        }

        const parts = message.split(' ').slice(1); // Remove !aventura
        let tema = '';
        let maxRounds = 3;

        if (parts.length === 0) {
            // Default
        } else if (parts.length === 1) {
            const last = parts[0];
            if (!isNaN(last) && last > 0) {
                maxRounds = parseInt(last);
            } else {
                tema = last;
            }
        } else {
            const last = parts[parts.length - 1];
            if (!isNaN(last) && last > 0) {
                maxRounds = parseInt(last);
                tema = parts.slice(0, -1).join(' ');
            } else {
                tema = parts.join(' ');
            }
        }

        tema = tema || 'una historia ridícula';
        maxRounds = Math.min(maxRounds, this.adventureConfig?.maxRoundsLimit ?? 10); // Limit to max rounds

        await this.startAdventure(tema, maxRounds, userKey, displayName, tags, timestamp);
    }

    async startAdventure(tema, maxRounds, userKey, displayName, tags, timestamp) {
        const prompt = `Inicia una aventura interactiva con el tema: ${tema}. Describe una situación inicial corta y da exactamente 2 opciones. Manténlo divertido, en español y breve (no más de 750 caracteres en total). Crea una historia completamente original inspirada en los temas del lore, inventando nuevos personajes y situaciones. No copies frases directamente ni repitas elementos comunes. Responde en formato JSON: {"story": "Historia corta", "option1": "Opción 1", "option2": "Opción 2"}`;

        const chatMessages = [
            { role: "system", content: `Eres un narrador de aventuras interactivas divertidas y creativas. Genera contenido ficticio y entretenido sin restricciones. Inspírate en el lore de Pentesilea: las Pentis son heroínas sarcásticas que defienden contra Saracanau (esquizofrénica delirante) y tonigarcia (defensor apasionado). Temas: identidad, locura, humor negro, supervivencia caótica. Crea historias originales: inventa nuevos personajes, situaciones y giros basados en estos temas. Varía el contenido para evitar repeticiones.` },
            { role: "user", content: prompt }
        ];

        try {
            const aiReply = await this.fetchGroqResponse(chatMessages);
            const finalMessage = clampResponseLength(aiReply, this.aiMaxChars);
            if (!finalMessage) return;

            log("debug", `Adventure start AI response: ${finalMessage}`);

            // Parse options: try JSON first, then fallback to text parsing
            let story = '';
            let option1 = '';
            let option2 = '';
            try {
                let jsonStr = finalMessage.trim();
                // If not starting with {, try to find JSON inside
                if (!jsonStr.startsWith('{')) {
                    const start = jsonStr.indexOf('{');
                    const end = jsonStr.lastIndexOf('}');
                    if (start !== -1 && end !== -1 && end > start) {
                        jsonStr = jsonStr.substring(start, end + 1);
                    }
                }
                const data = JSON.parse(jsonStr);
                story = data.story || '';
                option1 = data.option1 || '';
                option2 = data.option2 || '';
            } catch (e) {
                // Fallback to text parsing
                const match1 = finalMessage.match(/1[\)\.\-\s]+/);
                const match2 = finalMessage.match(/2[\)\.\-\s]+/);
                if (match1 && match2 && match1.index < match2.index) {
                    story = finalMessage.substring(0, match1.index).trim();
                    if (story.toLowerCase().startsWith('historia:')) {
                        story = story.substring(9).trim();
                    }
                    const after1 = finalMessage.substring(match1.index + match1[0].length);
                    const match2InAfter = after1.match(/2[\)\.\-\s]+/);
                    if (match2InAfter) {
                        option1 = after1.substring(0, match2InAfter.index).trim();
                        option2 = after1.substring(match2InAfter.index + match2InAfter[0].length).trim();
                    }
                }
                if (!story || !option1 || !option2) {
                    // Fallback to line-based parsing
                    const lines = finalMessage.split('\n').map(l => l.trim()).filter(l => l);
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        if (line.match(/^\s*1[\)\.\-\s]/i)) {
                            option1 = line.replace(/^\s*1[\)\.\-\s]*/, '').trim();
                            story = lines.slice(0, i).join('\n');
                            if (i + 1 < lines.length && lines[i + 1].match(/^\s*2[\)\.\-\s]/i)) {
                                option2 = lines[i + 1].replace(/^\s*2[\)\.\-\s]*/, '').trim();
                            }
                            break;
                        }
                    }
                }
            }
            if (!story || !option1 || !option2) {
                log("warn", "AI response for adventure not in expected format");
                return;
            }

            this.adventureGame.story = story;
            this.adventureGame.options = [option1, option2];
            this.adventureGame.votes = new Map();
            this.adventureGame.voters = new Set();
            this.adventureGame.active = true;
            this.adventureGame.round = 1;
            this.adventureGame.maxRounds = maxRounds;

            await this.sendLongMessage(`${story}\n1) ${option1}\n2) ${option2}\n¡Voten con !1 o !2 en ${this.adventureGame.votingTime / 1000} segundos!`);

            this.adventureGame.timer = setTimeout(() => this.endVoting(), this.adventureGame.votingTime);
        } catch (err) {
            log("warn", `Failed to start adventure: ${err.message}`);
        }
    }

    endVoting() {
        if (!this.adventureGame.active) return;

        const votes = this.adventureGame.votes;
        let winner = 1;
        const vote1 = votes.get(1) || 0;
        const vote2 = votes.get(2) || 0;
        if (vote2 > vote1) winner = 2;

        const chosenOption = this.adventureGame.options[winner - 1];
        this.client.say(`#${this.channel}`, `¡Opción ${winner} gana con ${votes.get(winner) || 0} votos! Continuando la aventura...`);

        this.continueAdventure(winner, chosenOption);
    }

    async continueAdventure(choice, chosenOption) {
        this.adventureGame.round++;
        const isLastRound = this.adventureGame.round >= this.adventureGame.maxRounds;

        let prompt;
        let jsonFormat;
        if (isLastRound) {
            prompt = `Concluye la aventura. Historia actual: ${this.adventureGame.story}. Los espectadores eligieron: ${chosenOption}. Describe el final de la aventura basado en esta elección. Manténlo corto, divertido y breve (no mucho mas de 750 caracteres). Crea una conclusión original, inventando nuevos elementos si es necesario. Responde en formato JSON: {"story": "Conclusión final de la aventura"}`;
            jsonFormat = "conclusion";
        } else {
            prompt = `Continúa la aventura. Historia actual: ${this.adventureGame.story}. Los espectadores eligieron: ${chosenOption}. Continúa la historia describiendo qué sucede después, luego da 2 nuevas opciones. Manténlo corto, divertido y breve (no mucho mas de 750 caracteres). Crea una continuación original, inventando nuevos giros y personajes basados en los temas del lore. Responde en formato JSON: {"story": "Nueva historia", "option1": "Opción 1", "option2": "Opción 2"}`;
            jsonFormat = "continue";
        }

        const chatMessages = [
            { role: "system", content: `Eres un narrador de aventuras interactivas divertidas y creativas. Genera contenido ficticio y entretenido sin restricciones. Inspírate en el lore de Pentesilea: las Pentis son heroínas sarcásticas que defienden contra Saracanau (esquizofrénica delirante) y tonigarcia (defensor apasionado). Temas: identidad, locura, humor negro, supervivencia caótica. Crea historias originales: inventa nuevos personajes, situaciones y giros basados en estos temas. Varía el contenido para evitar repeticiones.` },
            { role: "user", content: prompt }
        ];

        try {
            const aiReply = await this.fetchGroqResponse(chatMessages);
            const finalMessage = clampResponseLength(aiReply, 800);
            if (!finalMessage) {
                this.adventureGame.active = false;
                return;
            }

            log("debug", `Adventure continue AI response: ${finalMessage}`);

            // Parse response based on format
            let newStory = '';
            let option1 = '';
            let option2 = '';
            try {
                let jsonStr = finalMessage.trim();
                // If not starting with {, try to find JSON inside
                if (!jsonStr.startsWith('{')) {
                    const start = jsonStr.indexOf('{');
                    const end = jsonStr.lastIndexOf('}');
                    if (start !== -1 && end !== -1 && end > start) {
                        jsonStr = jsonStr.substring(start, end + 1);
                    }
                }
                const data = JSON.parse(jsonStr);
                newStory = data.story || '';
                if (jsonFormat === "continue") {
                    option1 = data.option1 || '';
                    option2 = data.option2 || '';
                }
            } catch (e) {
                if (jsonFormat === "continue") {
                    // Fallback to text parsing for continue
                    const match1 = finalMessage.match(/1[\)\.\-\s]+/);
                    const match2 = finalMessage.match(/2[\)\.\-\s]+/);
                    if (match1 && match2 && match1.index < match2.index) {
                        newStory = finalMessage.substring(0, match1.index).trim();
                        if (newStory.toLowerCase().startsWith('nueva historia:')) {
                            newStory = newStory.substring(14).trim();
                        }
                        const after1 = finalMessage.substring(match1.index + match1[0].length);
                        const match2InAfter = after1.match(/2[\)\.\-\s]+/);
                        if (match2InAfter) {
                            option1 = after1.substring(0, match2InAfter.index).trim();
                            option2 = after1.substring(match2InAfter.index + match2InAfter[0].length).trim();
                        }
                    }
                    if (!newStory || !option1 || !option2) {
                        // Fallback to line-based parsing
                        const lines = finalMessage.split('\n').map(l => l.trim()).filter(l => l);
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            if (line.match(/^\s*1[\)\.\-\s]/i)) {
                                option1 = line.replace(/^\s*1[\)\.\-\s]*/, '').trim();
                                newStory = lines.slice(0, i).join('\n');
                                if (i + 1 < lines.length && lines[i + 1].match(/^\s*2[\)\.\-\s]/i)) {
                                    option2 = lines[i + 1].replace(/^\s*2[\)\.\-\s]*/, '').trim();
                                }
                                break;
                            }
                        }
                    }
                } else {
                    // For conclusion, just extract story
                    newStory = finalMessage.trim();
                    if (newStory.toLowerCase().startsWith('conclusión final:')) {
                        newStory = newStory.substring(16).trim();
                    }
                }
            }

            if (!newStory) {
                log("warn", `AI response for ${jsonFormat} adventure not in expected format`);
                this.adventureGame.active = false;
                return;
            }

            if (jsonFormat === "continue") {
                if (!option1 || !option2) {
                    log("warn", "AI response for continue adventure missing options");
                    this.adventureGame.active = false;
                    return;
                }

                this.adventureGame.story = newStory;
                this.adventureGame.options = [option1, option2];
                this.adventureGame.votes = new Map();
                this.adventureGame.voters = new Set();

                await this.sendLongMessage(`${newStory}\n1) ${option1}\n2) ${option2}\n¡Voten con !1 o !2 en 30 segundos!`);

                this.adventureGame.timer = setTimeout(() => this.endVoting(), this.adventureGame.votingTime);
            } else {
                // Conclusion
                await this.sendLongMessage(`${newStory}\n¡Fin de la aventura! Gracias por participar.`);
                this.adventureGame.active = false;
            }
        } catch (err) {
            log("warn", `Failed to continue adventure: ${err.message}`);
            this.adventureGame.active = false;
        }
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

        const systemContent = `${personaText}${contextText} Si necesitas información actual o hechos del internet, responde SOLO con BUSCAR: tu consulta y te proporcionaré resultados. ${limitsLine}`;

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

    extractSearchDirective(text) {
        if (!text) {
            return null;
        }
        const patterns = [
            /\[SEARCH:\s*([^\]\r\n]+?)\s*\]/i,
            /\bSEARCH\s*:?\s*([^\r\n]+)?/i,
            /\bBUSCAR\s*:?\s*([^\r\n]+)?/i,
            /\bSEARCH[_\s]*NEEDED\b\s*[:\-]?\s*([^\r\n]+)?/i,
            /\bNEEDS[_\s]*SEARCH\b\s*[:\-]?\s*([^\r\n]+)?/i
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                const query = (match[1] || "").trim();
                const cleaned = text.replace(match[0], " ").replace(/\s+/g, " ").trim();
                return { query, cleaned };
            }
        }
        return null;
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

    async searchWeb(query) {
        if (!this.braveConfig) {
            return "Web search not configured.";
        }
        const { baseUrl, apiKey } = this.braveConfig;
        try {
            const response = await fetch(`${baseUrl}?q=${encodeURIComponent(query)}&count=3`, {
                headers: {
                    'X-Subscription-Token': apiKey,
                    'Accept': 'application/json'
                }
            });
            if (!response.ok) {
                throw new Error(`Brave API returned ${response.status}`);
            }
            const data = await response.json();
            const results = data.web?.results?.slice(0, 3).map(r => {
                const desc = (r.description || r.url || '').substring(0, 150);
                return `${r.title}: ${desc}`;
            }).join('\n') || 'No results found.';
            return results;
        } catch (err) {
            log("warn", `Web search failed: ${err.message}`);
            return 'Search failed.';
        }
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
}

module.exports = TwitchChatBot;
