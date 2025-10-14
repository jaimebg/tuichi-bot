const { log } = require("../logger");

class UserMemory {
    constructor(limit = 100, engagementTrackingDays = 7) {
        this.memories = new Map();
        this.limit = limit;
        this.engagementTrackingMs = engagementTrackingDays * 24 * 60 * 60 * 1000;
    }

    getUserData(userKey) {
        if (!this.memories.has(userKey)) {
            this.memories.set(userKey, {
                preferences: new Map(),
                personality: [],
                engagementPattern: {
                    totalMessages: 0,
                    averageLength: 0,
                    commonWords: new Map(),
                    activeHours: new Set(),
                    lastSeen: null
                },
                conversationThemes: [],
                firstSeen: Date.now()
            });
        }
        return this.memories.get(userKey);
    }

    updateEngagement(userKey, message, timestamp = Date.now()) {
        const userData = this.getUserData(userKey);
        const engagement = userData.engagementPattern;

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
        const userData = this.memories.get(userKey);
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
            daysSinceFirstSeen: Math.floor((Date.now() - userData.firstSeen) / (1000 * 60 * 60 * 24))
        };
    }

    serialize() {
        return {
            memories: this.memories,
            limit: this.limit,
            engagementTrackingMs: this.engagementTrackingMs
        };
    }

    deserialize(data) {
        if (data && data.memories) {
            this.memories = data.memories instanceof Map ? data.memories : new Map(Object.entries(data.memories));
            this.limit = data.limit || this.limit;
            this.engagementTrackingMs = data.engagementTrackingMs || this.engagementTrackingMs;
        }
    }

    cleanup() {
        const cutoff = Date.now() - this.engagementTrackingMs;
        const usersToRemove = [];

        for (const [userKey, userData] of this.memories.entries()) {
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
            const sorted = [...this.memories.entries()].sort((a, b) => {
                const aLastSeen = a[1].engagementPattern.lastSeen || 0;
                const bLastSeen = b[1].engagementPattern.lastSeen || 0;
                return aLastSeen - bLastSeen;
            });

            const toRemove = sorted.slice(0, this.memories.size - this.limit);
            toRemove.forEach(([userKey]) => {
                this.memories.delete(userKey);
            });

            if (toRemove.length > 0) {
                log("info", `Removed ${toRemove.length} old user memories to stay within limit`);
            }
        }
    }
}

module.exports = UserMemory;
