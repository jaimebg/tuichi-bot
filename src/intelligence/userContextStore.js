const fs = require("fs");
const path = require("path");
const { log } = require("../logger");

class UserContextStore {
    constructor(options = {}) {
        this.baseDir = options.baseDir || options.directory || path.join(__dirname, "..", "..", "resources", "users");
        this.maxRecentMessages = options.maxRecentMessages || 12;
        this.contexts = new Map();
        this.dirtyUsers = new Set();

        this.ensureBaseDirectory();
        this.loadExistingContexts();
    }

    ensureBaseDirectory() {
        try {
            if (!fs.existsSync(this.baseDir)) {
                fs.mkdirSync(this.baseDir, { recursive: true });
                log("info", `Created user context directory at ${this.baseDir}`);
            }
        } catch (err) {
            log("warn", `Unable to ensure user context directory: ${err.message}`);
        }
    }

    loadExistingContexts() {
        try {
            const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
            entries.forEach((entry) => {
                if (!entry.isDirectory()) return;
                const userKey = entry.name.toLowerCase();
                const profilePath = path.join(this.baseDir, entry.name, "profile.json");
                if (fs.existsSync(profilePath)) {
                    try {
                        const raw = fs.readFileSync(profilePath, "utf8");
                        const parsed = JSON.parse(raw);
                        this.contexts.set(userKey, parsed);
                    } catch (err) {
                        log("warn", `Failed to load user profile for ${userKey}: ${err.message}`);
                    }
                }
            });
            if (this.contexts.size > 0) {
                log("info", `Loaded ${this.contexts.size} user context profiles.`);
            }
        } catch (err) {
            log("warn", `Unable to scan user context directory: ${err.message}`);
        }
    }

    sanitizeUserKey(userKey) {
        return String(userKey || "")
            .toLowerCase()
            .replace(/[^a-z0-9_]/gi, "_");
    }

    getUserDir(userKey) {
        const safeKey = this.sanitizeUserKey(userKey);
        return path.join(this.baseDir, safeKey);
    }

    getContext(userKey) {
        const key = this.sanitizeUserKey(userKey);
        if (!this.contexts.has(key)) {
            this.contexts.set(key, this.createEmptyContext(key));
        }
        return this.contexts.get(key);
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

        const key = this.sanitizeUserKey(detailedContext.userKey);
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
        if (this.dirtyUsers.size === 0) {
            return;
        }

        const tasks = [];
        for (const userKey of this.dirtyUsers) {
            const context = this.contexts.get(userKey);
            if (!context) {
                continue;
            }
            const userDir = this.getUserDir(userKey);
            const profilePath = path.join(userDir, "profile.json");
            tasks.push(
                fs.promises
                    .mkdir(userDir, { recursive: true })
                    .then(() =>
                        fs.promises.writeFile(profilePath, JSON.stringify(context, null, 2), "utf8")
                    )
                    .catch((err) => {
                        log("warn", `Failed to persist profile for ${userKey}: ${err.message}`);
                    })
            );
        }

        await Promise.all(tasks);
        this.dirtyUsers.clear();
    }

    getContextSnapshot(userKey) {
        const key = this.sanitizeUserKey(userKey);
        const context = this.contexts.get(key);
        if (!context) {
            return null;
        }
        return JSON.parse(JSON.stringify(context));
    }
}

module.exports = UserContextStore;
