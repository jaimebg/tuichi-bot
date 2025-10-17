const { log } = require("../logger");

/**
 * MessageLogger: Ultra-lightweight participation tracker.
 * Only tracks user message counts for stream statistics (top users at disconnect).
 * Stores only counters and display names - no message data or timestamps.
 */
class MessageLogger {
    constructor(cleanupIntervalMs = 60000) {
        // Maps to track user participation (extremely lightweight)
        this.userMessageCount = new Map(); // userKey -> count
        this.userDisplayName = new Map();  // userKey -> displayName (for later retrieval)

        // Periodic cleanup to prevent unbounded growth
        this.cleanupIntervalMs = cleanupIntervalMs;
        this.lastCleanup = Date.now();
    }

    /**
     * Increment message count for a user. Only tracks a +1 counter.
     * Message content itself is already tracked by recentChat for intelligence.
     */
    logMessage(userKey, displayName) {
        // Update user stats
        this.userMessageCount.set(userKey, (this.userMessageCount.get(userKey) || 0) + 1);
        this.userDisplayName.set(userKey, displayName);

        // Periodic cleanup
        if (Date.now() - this.lastCleanup > this.cleanupIntervalMs) {
            this.cleanupOldUsers();
        }
    }

    /**
     * Get top N users by message count during the current session.
     * Returns array of { userKey, displayName, messageCount } sorted by count descending.
     */
    getTopUsers(limit = 10) {
        return [...this.userMessageCount.entries()]
            .map(([userKey, count]) => ({
                userKey,
                displayName: this.userDisplayName.get(userKey) || userKey,
                messageCount: count
            }))
            .sort((a, b) => b.messageCount - a.messageCount)
            .slice(0, limit);
    }

    /**
     * Clean up users - currently a no-op since we only store lightweight counters.
     * Maps will naturally stay bounded by the number of unique users in a stream.
     */
    cleanupOldUsers() {
        this.lastCleanup = Date.now();
    }

    /**
     * Get statistics about the message log.
     */
    getStats() {
        return {
            uniqueUsers: this.userMessageCount.size,
            totalMessageCount: [...this.userMessageCount.values()].reduce((a, b) => a + b, 0)
        };
    }

    /**
     * Clear all logging data (e.g., for stream reset).
     */
    reset() {
        this.userMessageCount.clear();
        this.userDisplayName.clear();
        this.lastCleanup = Date.now();
    }

    serialize() {
        return {
            userMessageCount: Object.fromEntries(this.userMessageCount),
            userDisplayName: Object.fromEntries(this.userDisplayName)
        };
    }

    deserialize(data) {
        if (data) {
            this.userMessageCount = new Map(Object.entries(data.userMessageCount || {}));
            this.userDisplayName = new Map(Object.entries(data.userDisplayName || {}));
        }
    }
}

module.exports = MessageLogger;
