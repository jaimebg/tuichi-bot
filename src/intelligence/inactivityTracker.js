const { log } = require("../logger");

/**
 * InactivityTracker: Tracks user activity and identifies inactive users
 * to potentially trigger AI-generated shame messages
 */
class InactivityTracker {
    constructor(inactivityThresholdMinutes = 15, checkIntervalMs = 60000) {
        this.userLastActivity = new Map(); // userKey -> {timestamp, displayName}
        this.inactivityThresholdMs = inactivityThresholdMinutes * 60 * 1000;
        this.checkIntervalMs = checkIntervalMs;
        this.shameTracker = new Map(); // userKey -> last time we shamed them
        this.minTimeBeweenShames = 30 * 60 * 1000; // Don't shame same user more than every 30 mins
        this.lastCheckTime = Date.now();
    }

    /**
     * Update user activity
     * @param {string} userKey - The user
     * @param {string} displayName - Their display name
     */
    updateActivity(userKey, displayName) {
        this.userLastActivity.set(userKey, {
            timestamp: Date.now(),
            displayName
        });
    }

    /**
     * Get users who have been inactive for too long
     * @returns {Array<{userKey, displayName, inactiveForMs}>}
     */
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

    /**
     * Get a user to shame (if enough time has passed since last shame)
     * @returns {object|null} - {userKey, displayName, inactiveForMinutes}
     */
    getShameCandidate() {
        const inactive = this.getInactiveUsers();
        if (inactive.length === 0) {
            return null;
        }

        const now = Date.now();

        // Find the most inactive user who hasn't been shamed recently
        for (const user of inactive.sort((a, b) => b.inactiveForMs - a.inactiveForMs)) {
            const lastShame = this.shameTracker.get(user.userKey) || 0;
            if (now - lastShame >= this.minTimeBeweenShames) {
                return user;
            }
        }

        return null;
    }

    /**
     * Mark that we've shamed a user
     * @param {string} userKey - The user
     */
    recordShame(userKey) {
        this.shameTracker.set(userKey, Date.now());
        log("debug", `Recorded shame for ${userKey}`);
    }

    /**
     * Clear user activity (e.g., when they leave)
     * @param {string} userKey - The user
     */
    clearUser(userKey) {
        this.userLastActivity.delete(userKey);
        this.shameTracker.delete(userKey);
    }

    /**
     * Get activity stats
     */
    getStats() {
        return {
            trackedUsers: this.userLastActivity.size,
            inactiveUsers: this.getInactiveUsers().length
        };
    }

    /**
     * Check if enough time has passed for a periodic check
     */
    shouldCheck() {
        const now = Date.now();
        if (now - this.lastCheckTime >= this.checkIntervalMs) {
            this.lastCheckTime = now;
            return true;
        }
        return false;
    }

    /**
     * Serialize for persistence
     */
    serialize() {
        return {
            userLastActivity: Object.fromEntries(this.userLastActivity),
            shameTracker: Object.fromEntries(this.shameTracker)
        };
    }

    /**
     * Deserialize from persistence
     */
    deserialize(data) {
        if (data && data.userLastActivity) {
            this.userLastActivity = new Map(Object.entries(data.userLastActivity));
        }
        if (data && data.shameTracker) {
            this.shameTracker = new Map(Object.entries(data.shameTracker));
        }
    }

    /**
     * Clear all data
     */
    reset() {
        this.userLastActivity.clear();
        this.shameTracker.clear();
        this.lastCheckTime = Date.now();
    }
}

module.exports = InactivityTracker;
