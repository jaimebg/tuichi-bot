import { log } from '../logger.js';
import { parseSqliteUtc } from '../utils/time.js';

const MAX_RECENT_MESSAGES = 20;
const MAX_COMMANDS_TRACKED = 10;

export class UserMemory {
    constructor(db, limit = 100, engagementTrackingDays = 7) {
        this.db = db;
        this.memories = new Map();
        this.limit = limit;
        this.engagementTrackingMs = engagementTrackingDays * 24 * 60 * 60 * 1000;
    }

    getUserData(userKey) {
        if (!this.memories.has(userKey)) {
            this.memories.set(userKey, this.createEmptyUserData());
        }

        const userData = this.memories.get(userKey);
        if (!(userData.preferences instanceof Map)) {
            userData.preferences = new Map(userData.preferences ? Object.entries(userData.preferences) : []);
        }
        if (!Array.isArray(userData.personality)) {
            userData.personality = [];
        }
        if (!Array.isArray(userData.conversationThemes)) {
            userData.conversationThemes = [];
        }
        if (!userData.engagementPattern) {
            userData.engagementPattern = this.createEmptyEngagementPattern();
        } else {
            if (!(userData.engagementPattern.commonWords instanceof Map)) {
                userData.engagementPattern.commonWords = new Map(
                    userData.engagementPattern.commonWords
                        ? Object.entries(userData.engagementPattern.commonWords)
                        : []
                );
            }
            if (!(userData.engagementPattern.activeHours instanceof Set)) {
                userData.engagementPattern.activeHours = new Set(
                    Array.isArray(userData.engagementPattern.activeHours)
                        ? userData.engagementPattern.activeHours
                        : []
                );
            }
        }
        if (!Array.isArray(userData.recentMessages)) {
            userData.recentMessages = [];
        }
        if (!(userData.commandsUsed instanceof Map)) {
            userData.commandsUsed = new Map(
                userData.commandsUsed ? Object.entries(userData.commandsUsed) : []
            );
        }
        if (!userData.metadata || typeof userData.metadata !== "object") {
            userData.metadata = {};
        }
        if (!userData.firstSeen) {
            userData.firstSeen = Date.now();
        }

        return userData;
    }

    createEmptyUserData() {
        return {
            preferences: new Map(),
            personality: [],
            engagementPattern: this.createEmptyEngagementPattern(),
            conversationThemes: [],
            recentMessages: [],
            commandsUsed: new Map(),
            metadata: {},
            firstSeen: Date.now()
        };
    }

    createEmptyEngagementPattern() {
        return {
            totalMessages: 0,
            averageLength: 0,
            commonWords: new Map(),
            activeHours: new Set(),
            lastSeen: null
        };
    }

    updateEngagement(userKey, message, timestamp = Date.now(), metadata = {}) {
        const userData = this.getUserData(userKey);
        const engagement = userData.engagementPattern;

        if (metadata.displayName) {
            userData.metadata.displayName = metadata.displayName;
        }
        userData.metadata.lastMessageAt = timestamp;

        engagement.totalMessages++;
        engagement.averageLength = ((engagement.averageLength * (engagement.totalMessages - 1)) + message.length) / engagement.totalMessages;
        engagement.lastSeen = timestamp;

        const hour = new Date(timestamp).getHours();
        engagement.activeHours.add(hour);

        const words = message.toLowerCase().split(/\s+/).filter((word) => word.length > 3);
        words.forEach((word) => {
            engagement.commonWords.set(word, (engagement.commonWords.get(word) || 0) + 1);
        });

        if (engagement.commonWords.size > 20) {
            const sorted = [...engagement.commonWords.entries()].sort((a, b) => b[1] - a[1]);
            engagement.commonWords = new Map(sorted.slice(0, 20));
        }

        userData.recentMessages.push({
            timestamp,
            content: message
        });
        if (userData.recentMessages.length > MAX_RECENT_MESSAGES) {
            userData.recentMessages.splice(0, userData.recentMessages.length - MAX_RECENT_MESSAGES);
        }

        if (message.startsWith("!")) {
            const [command] = message.split(/\s+/, 1);
            const commandKey = command.toLowerCase();
            const count = userData.commandsUsed.get(commandKey) || 0;
            userData.commandsUsed.set(commandKey, count + 1);
            if (userData.commandsUsed.size > MAX_COMMANDS_TRACKED) {
                const sortedCommands = [...userData.commandsUsed.entries()].sort((a, b) => b[1] - a[1]);
                userData.commandsUsed = new Map(sortedCommands.slice(0, MAX_COMMANDS_TRACKED));
            }
        }
    }

    addPersonalityTrait(userKey, trait) {
        const userData = this.getUserData(userKey);
        if (!userData.personality.includes(trait)) {
            userData.personality.push(trait);
            if (userData.personality.length > 10) {
                userData.personality.shift();
            }
        }
    }

    addConversationTheme(userKey, theme) {
        const userData = this.getUserData(userKey);
        userData.conversationThemes.unshift(theme);
        if (userData.conversationThemes.length > 5) {
            userData.conversationThemes.pop();
        }
    }

    getUserSummary(userKey) {
        if (!this.memories.has(userKey)) {
            return null;
        }

        const userData = this.getUserData(userKey);
        if (!userData) return null;

        const engagement = userData.engagementPattern;
        const topWords = [...engagement.commonWords.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([word]) => word);

        return {
            messageCount: engagement.totalMessages,
            averageLength: Math.round(engagement.averageLength),
            topWords,
            personality: userData.personality,
            themes: userData.conversationThemes,
            activeHours: [...engagement.activeHours],
            daysSinceFirstSeen: Math.floor((Date.now() - userData.firstSeen) / (1000 * 60 * 60 * 24)),
            lastSeen: engagement.lastSeen,
            displayName: userData.metadata.displayName,
            recentMessages: userData.recentMessages.slice(-3),
            commands: [...userData.commandsUsed.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([command, count]) => ({ command, count }))
        };
    }

    getDetailedContext(userKey) {
        if (!this.memories.has(userKey)) {
            return null;
        }

        const userData = this.getUserData(userKey);
        if (!userData) return null;

        const engagement = userData.engagementPattern;
        const topWords = [...engagement.commonWords.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([word, count]) => ({ word, count }));

        return {
            userKey,
            displayName: userData.metadata.displayName || userKey,
            firstSeen: userData.firstSeen,
            lastSeen: engagement.lastSeen,
            messageCount: engagement.totalMessages,
            averageLength: Math.round(engagement.averageLength),
            activeHours: [...engagement.activeHours],
            personality: [...userData.personality],
            themes: [...userData.conversationThemes],
            topWords,
            recentMessages: userData.recentMessages.slice(-MAX_RECENT_MESSAGES),
            commands: [...userData.commandsUsed.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([command, count]) => ({ command, count })),
            preferences: userData.preferences instanceof Map
                ? Object.fromEntries(userData.preferences.entries())
                : {},
            metadata: {
                ...userData.metadata
            }
        };
    }

    /** Persist all in-memory data to DB. Called by bot on auto-save/shutdown. */
    save() {
        for (const [userKey, userData] of this.memories) {
            const eng = userData.engagementPattern || {};
            const commonWords = eng.commonWords instanceof Map
                ? Object.fromEntries(eng.commonWords) : (eng.commonWords || {});
            const activeHours = eng.activeHours instanceof Set
                ? [...eng.activeHours] : (eng.activeHours || []);
            this.db.users.upsert({
                userId: userKey,
                displayName: userData.metadata?.displayName || null,
                personalityTraits: userData.personality || [],
                conversationThemes: userData.conversationThemes || [],
                topWords: commonWords,
                messageCount: eng.totalMessages || 0,
                avgMessageLength: eng.averageLength || 0,
                activeHours
            });
        }
    }

    /** Load from DB into memory cache. Called once at startup. */
    load() {
        const rows = this.db.users.getAll();
        for (const row of rows) {
            const userData = this.createEmptyUserData();
            userData.personality = JSON.parse(row.personality_traits || '[]');
            userData.conversationThemes = JSON.parse(row.conversation_themes || '[]');
            userData.metadata.displayName = row.display_name;
            userData.firstSeen = parseSqliteUtc(row.first_seen) ?? Date.now();
            const eng = userData.engagementPattern;
            eng.totalMessages = row.message_count;
            eng.averageLength = row.avg_message_length;
            eng.commonWords = new Map(Object.entries(JSON.parse(row.top_words || '{}')));
            eng.activeHours = new Set(JSON.parse(row.active_hours || '[]'));
            eng.lastSeen = parseSqliteUtc(row.last_seen) ?? Date.now();
            this.memories.set(row.user_id, userData);
        }
        log('info', `Loaded ${this.memories.size} user memories from DB`);
    }

    cleanup() {
        const cutoff = Date.now() - this.engagementTrackingMs;
        const usersToRemove = [];

        for (const userKey of this.memories.keys()) {
            const userData = this.getUserData(userKey);
            if (userData.engagementPattern.lastSeen && userData.engagementPattern.lastSeen < cutoff) {
                usersToRemove.push(userKey);
            }
        }

        usersToRemove.forEach((userKey) => {
            this.memories.delete(userKey);
        });

        if (usersToRemove.length > 0) {
            log("info", `Cleaned up ${usersToRemove.length} inactive user memories`);
        }

        if (this.memories.size > this.limit) {
            const sortedKeys = [...this.memories.keys()].sort((a, b) => {
                const aLastSeen = this.getUserData(a).engagementPattern.lastSeen || 0;
                const bLastSeen = this.getUserData(b).engagementPattern.lastSeen || 0;
                return aLastSeen - bLastSeen;
            });

            const toRemove = sortedKeys.slice(0, this.memories.size - this.limit);
            toRemove.forEach((userKey) => {
                this.memories.delete(userKey);
            });

            if (toRemove.length > 0) {
                log("info", `Removed ${toRemove.length} old user memories to stay within limit`);
            }
        }
    }
}
