const { normalizeWhitespace } = require("../utils/text");

class RecentChatTracker {
    constructor(limit = 20, contextWindowMinutes = 10) {
        this.messages = [];
        this.limit = limit;
        this.contextWindowMs = contextWindowMinutes * 60 * 1000;
    }

    addMessage(userKey, displayName, message, timestamp = Date.now()) {
        this.messages.push({
            userKey,
            displayName,
            message: normalizeWhitespace(message),
            timestamp
        });

        if (this.messages.length > this.limit) {
            this.messages.shift();
        }

        this.cleanOldMessages();
    }

    cleanOldMessages() {
        const cutoff = Date.now() - this.contextWindowMs;
        this.messages = this.messages.filter((msg) => msg.timestamp > cutoff);
    }

    getRecentContext(excludeUser = null) {
        this.cleanOldMessages();
        return this.messages
            .filter((msg) => msg.userKey !== excludeUser)
            .slice(-10)
            .map((msg) => `${msg.displayName}: ${msg.message}`)
            .join("; ");
    }

    serialize() {
        this.cleanOldMessages();
        return {
            messages: this.messages,
            limit: this.limit,
            contextWindowMs: this.contextWindowMs
        };
    }

    deserialize(data) {
        if (data) {
            this.messages = data.messages || [];
            this.limit = data.limit || this.limit;
            this.contextWindowMs = data.contextWindowMs || this.contextWindowMs;
            this.cleanOldMessages();
        }
    }
}

module.exports = RecentChatTracker;
