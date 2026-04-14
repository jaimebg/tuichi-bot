import { log } from '../logger.js';

/**
 * InactivityTracker: Tracks user activity and identifies inactive users
 * to potentially trigger AI-generated shame messages
 */
export class InactivityTracker {
    constructor(inactivityThresholdMinutes = 15, checkIntervalMs = 60000, ignoredUsers = new Set()) {
        this.userLastActivity = new Map();
        this.inactivityThresholdMs = inactivityThresholdMinutes * 60 * 1000;
        this.checkIntervalMs = checkIntervalMs;
        this.shameTracker = new Map();
        this.minTimeBeweenShames = 30 * 60 * 1000;
        this.lastCheckTime = Date.now();
        this.ignoredUsers = ignoredUsers;
    }

    updateActivity(userKey, displayName) {
        this.userLastActivity.set(userKey, {
            timestamp: Date.now(),
            displayName
        });
    }

    getInactiveUsers() {
        const now = Date.now();
        const inactive = [];

        for (const [userKey, data] of this.userLastActivity) {
            const inactiveMs = now - data.timestamp;
            if (inactiveMs >= this.inactivityThresholdMs) {
                inactive.push({
                    userKey,
                    displayName: data.displayName,
                    inactiveForMs: inactiveMs,
                    inactiveForMinutes: Math.floor(inactiveMs / (60 * 1000))
                });
            }
        }

        return inactive;
    }

    getShameCandidate() {
        const inactive = this.getInactiveUsers();
        if (inactive.length === 0) {
            return null;
        }

        const now = Date.now();

        for (const user of inactive.sort((a, b) => b.inactiveForMs - a.inactiveForMs)) {
            if (this.ignoredUsers.has(user.userKey)) {
                continue;
            }
            const lastShame = this.shameTracker.get(user.userKey) || 0;
            if (now - lastShame >= this.minTimeBeweenShames) {
                return user;
            }
        }

        return null;
    }

    recordShame(userKey) {
        this.shameTracker.set(userKey, Date.now());
        log("debug", `Recorded shame for ${userKey}`);
    }

    clearUser(userKey) {
        this.userLastActivity.delete(userKey);
        this.shameTracker.delete(userKey);
    }

    getStats() {
        return {
            trackedUsers: this.userLastActivity.size,
            inactiveUsers: this.getInactiveUsers().length
        };
    }

    /** Remove users inactive for more than 2x the threshold (they're long gone). */
    cleanup() {
        const cutoff = Date.now() - (this.inactivityThresholdMs * 2);
        for (const [userKey, data] of this.userLastActivity) {
            if (data.timestamp < cutoff) {
                this.userLastActivity.delete(userKey);
            }
        }
        // Prune shame records older than 2 hours
        const shameCutoff = Date.now() - 2 * 60 * 60 * 1000;
        for (const [userKey, ts] of this.shameTracker) {
            if (ts < shameCutoff) {
                this.shameTracker.delete(userKey);
            }
        }
    }

    shouldCheck() {
        const now = Date.now();
        if (now - this.lastCheckTime >= this.checkIntervalMs) {
            this.lastCheckTime = now;
            return true;
        }
        return false;
    }

    reset() {
        this.userLastActivity.clear();
        this.shameTracker.clear();
        this.lastCheckTime = Date.now();
    }
}
