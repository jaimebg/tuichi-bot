import { log } from '../logger.js';

/**
 * MessageLogger: Ultra-lightweight participation tracker.
 * Only tracks user message counts for stream statistics (top users at disconnect).
 * Stores only counters and display names - no message data or timestamps.
 */
export class MessageLogger {
    constructor(cleanupIntervalMs = 60000) {
        this.userMessageCount = new Map();
        this.userDisplayName = new Map();
        this.cleanupIntervalMs = cleanupIntervalMs;
        this.lastCleanup = Date.now();
    }

    logMessage(userKey, displayName) {
        this.userMessageCount.set(userKey, (this.userMessageCount.get(userKey) || 0) + 1);
        this.userDisplayName.set(userKey, displayName);

        if (Date.now() - this.lastCleanup > this.cleanupIntervalMs) {
            this.cleanupOldUsers();
        }
    }

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

    cleanupOldUsers() {
        this.lastCleanup = Date.now();
        // Cap tracked users to prevent unbounded growth
        if (this.userMessageCount.size > 500) {
            const sorted = [...this.userMessageCount.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 250);
            this.userMessageCount = new Map(sorted);
            // Prune display names to match
            for (const key of this.userDisplayName.keys()) {
                if (!this.userMessageCount.has(key)) {
                    this.userDisplayName.delete(key);
                }
            }
        }
    }

    getStats() {
        return {
            uniqueUsers: this.userMessageCount.size,
            totalMessageCount: [...this.userMessageCount.values()].reduce((a, b) => a + b, 0)
        };
    }

    reset() {
        this.userMessageCount.clear();
        this.userDisplayName.clear();
        this.lastCleanup = Date.now();
    }
}
