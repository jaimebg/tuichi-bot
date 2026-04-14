import { log } from '../logger.js';

export class UserContextStore {
    constructor(db, maxRecentMessages = 12, maxCachedContexts = 200) {
        this.db = db;
        this.maxRecentMessages = maxRecentMessages;
        this.maxCachedContexts = maxCachedContexts;
        this.contexts = new Map();
        this.dirtyUsers = new Set();
        this.loadExistingContexts();
    }

    loadExistingContexts() {
        const rows = this.db.context.getAll();
        for (const row of rows) {
            this.contexts.set(row.user_id, {
                userKey: row.user_id,
                displayName: row.display_name,
                firstSeen: row.first_seen ? new Date(row.first_seen).getTime() : null,
                lastSeen: row.last_seen ? new Date(row.last_seen).getTime() : null,
                messageCount: row.message_count,
                averageLength: row.avg_message_length,
                activeHours: JSON.parse(row.active_hours || '[]'),
                personality: JSON.parse(row.personality || '[]'),
                themes: JSON.parse(row.themes || '[]'),
                topWords: JSON.parse(row.top_words || '[]'),
                recentMessages: [],
                commands: JSON.parse(row.recent_commands || '[]'),
                preferences: JSON.parse(row.preferences || '{}'),
                metadata: JSON.parse(row.metadata || '{}')
            });
        }
        if (this.contexts.size > 0)
            log('info', `Loaded ${this.contexts.size} user context profiles from DB`);
    }

    getContext(userKey) {
        if (!this.contexts.has(userKey)) {
            this.contexts.set(userKey, this.createEmptyContext(userKey));
        }
        return this.contexts.get(userKey);
    }

    createEmptyContext(userKey) {
        const now = Date.now();
        return {
            userKey,
            displayName: null,
            firstSeen: now,
            lastSeen: null,
            messageCount: 0,
            averageLength: 0,
            activeHours: [],
            personality: [],
            themes: [],
            topWords: [],
            recentMessages: [],
            commands: [],
            preferences: {},
            metadata: {}
        };
    }

    mergeUnique(existing = [], incoming = []) {
        const combined = new Set();
        existing.forEach((value) => combined.add(value));
        incoming.forEach((value) => combined.add(value));
        return Array.from(combined);
    }

    mergeRecentMessages(existing = [], incoming = []) {
        const combined = [...existing, ...(incoming || [])];
        combined.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        const trimmed = combined.slice(-this.maxRecentMessages);
        return trimmed.map((entry) => ({
            timestamp: entry.timestamp,
            content: entry.content
        }));
    }

    mergeCommands(existing = [], incoming = []) {
        const counts = new Map();
        existing.forEach(({ command, count }) => {
            counts.set(command, Math.max(counts.get(command) || 0, count));
        });
        incoming.forEach(({ command, count }) => {
            counts.set(command, Math.max(counts.get(command) || 0, count));
        });
        return [...counts.entries()]
            .map(([command, count]) => ({ command, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
    }

    updateFromMemory(detailedContext) {
        if (!detailedContext || !detailedContext.userKey) {
            return;
        }

        const key = detailedContext.userKey;
        const context = this.getContext(key);

        if (detailedContext.displayName) {
            context.displayName = detailedContext.displayName;
        }
        if (!context.firstSeen || (detailedContext.firstSeen && detailedContext.firstSeen < context.firstSeen)) {
            context.firstSeen = detailedContext.firstSeen || context.firstSeen;
        }
        if (detailedContext.lastSeen) {
            context.lastSeen = detailedContext.lastSeen;
        }
        if (typeof detailedContext.messageCount === "number") {
            context.messageCount = detailedContext.messageCount;
        }
        if (typeof detailedContext.averageLength === "number") {
            context.averageLength = detailedContext.averageLength;
        }
        if (Array.isArray(detailedContext.activeHours)) {
            context.activeHours = this.mergeUnique(context.activeHours, detailedContext.activeHours).sort(
                (a, b) => a - b
            );
        }
        if (Array.isArray(detailedContext.personality)) {
            context.personality = this.mergeUnique(context.personality, detailedContext.personality);
        }
        if (Array.isArray(detailedContext.themes)) {
            context.themes = this.mergeUnique(context.themes, detailedContext.themes);
        }
        if (Array.isArray(detailedContext.topWords)) {
            context.topWords = detailedContext.topWords.slice(0, 10);
        }
        if (Array.isArray(detailedContext.recentMessages)) {
            context.recentMessages = this.mergeRecentMessages(context.recentMessages, detailedContext.recentMessages);
        }
        if (Array.isArray(detailedContext.commands)) {
            context.commands = this.mergeCommands(context.commands, detailedContext.commands);
        }
        if (detailedContext.preferences && typeof detailedContext.preferences === "object") {
            context.preferences = {
                ...context.preferences,
                ...detailedContext.preferences
            };
        }
        if (detailedContext.metadata && typeof detailedContext.metadata === "object") {
            context.metadata = {
                ...context.metadata,
                ...detailedContext.metadata
            };
        }
        if (!context.metadata) {
            context.metadata = {};
        }
        context.metadata.originalLogin = detailedContext.userKey;

        this.dirtyUsers.add(key);
    }

    syncFromUserMemory(userMemory) {
        if (!userMemory || !userMemory.memories) {
            return;
        }
        for (const userKey of userMemory.memories.keys()) {
            const detailed = userMemory.getDetailedContext(userKey);
            if (detailed) {
                this.updateFromMemory(detailed);
            }
        }
    }

    async flush() {
        if (this.dirtyUsers.size === 0) return;
        for (const userKey of this.dirtyUsers) {
            const ctx = this.contexts.get(userKey);
            if (!ctx) continue;
            this.db.context.upsert({
                userId: userKey,
                displayName: ctx.displayName,
                firstSeen: ctx.firstSeen ? new Date(ctx.firstSeen).toISOString() : null,
                lastSeen: ctx.lastSeen ? new Date(ctx.lastSeen).toISOString() : null,
                messageCount: ctx.messageCount,
                avgMessageLength: ctx.averageLength,
                activeHours: ctx.activeHours,
                personality: ctx.personality,
                themes: ctx.themes,
                topWords: ctx.topWords,
                recentCommands: ctx.commands,
                preferences: ctx.preferences,
                metadata: ctx.metadata
            });
        }
        this.dirtyUsers.clear();
        this._evictStaleContexts();
    }

    /** Remove oldest contexts when cache exceeds limit (LRU by lastSeen). */
    _evictStaleContexts() {
        if (this.contexts.size <= this.maxCachedContexts) return;
        const sorted = [...this.contexts.entries()]
            .sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
        const toRemove = sorted.slice(0, this.contexts.size - this.maxCachedContexts);
        for (const [key] of toRemove) {
            this.contexts.delete(key);
        }
        if (toRemove.length > 0) {
            log('info', `Evicted ${toRemove.length} stale user contexts from cache (${this.contexts.size} remaining)`);
        }
    }

    getContextSnapshot(userKey) {
        const context = this.contexts.get(userKey);
        if (!context) {
            return null;
        }
        return JSON.parse(JSON.stringify(context));
    }
}
