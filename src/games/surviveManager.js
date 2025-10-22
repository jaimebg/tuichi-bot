const { log } = require("../logger");

class SurviveManager {
    constructor() {
        this.activeSurvive = null;
        this.surviveTimer = null;
        this.timeoutTimer = null;
    }

    /**
     * Start a survive game (Battle Royale de chat)
     * @param {string[]} connectedUsers - Array of currently connected users
     * @param {number} durationMs - How long players have to vote (default 120 seconds)
     * @returns {object|null} - Survive game state
     */
    startSurvive(connectedUsers, durationMs = 120000) {
        if (this.activeSurvive) {
            return null; // Survive game already active
        }

        const validUsers = connectedUsers.filter(u => u && u.length > 0);
        if (validUsers.length < 2) {
            return null; // Need at least 2 players
        }

        this.activeSurvive = {
            players: new Set(validUsers),
            survivors: new Set(validUsers),
            startTime: Date.now(),
            endTime: Date.now() + durationMs,
            durationMs,
            timeoutMs: 5000, // 5 second timeout after game ends for late entries
            lastActionTime: Date.now(),
            hasEnded: false
        };

        log("debug", `Survive game started with ${validUsers.length} players: ${validUsers.join(', ')}`);

        return {
            players: Array.from(this.activeSurvive.players),
            count: this.activeSurvive.players.size,
            durationSeconds: Math.ceil(durationMs / 1000),
            message: `¡Escribid !survive para SOBREVIVIR! El último que escriba perderá. ⏰`
        };
    }

    /**
     * Record a player's !survive command
     * @param {string} userKey - The player
     * @returns {object|null} - {isSurvivor, rank, survivors}
     */
    recordSurvive(userKey) {
        if (!this.activeSurvive) {
            return null;
        }

        // Can join late with timeout
        if (!this.activeSurvive.players.has(userKey) && Date.now() - this.activeSurvive.startTime > this.activeSurvive.durationMs) {
            if (Date.now() - this.activeSurvive.startTime > this.activeSurvive.durationMs + this.activeSurvive.timeoutMs) {
                return null; // Too late
            }
        }

        if (!this.activeSurvive.players.has(userKey)) {
            this.activeSurvive.players.add(userKey);
        }

        if (this.activeSurvive.survivors.has(userKey)) {
            this.activeSurvive.survivors.add(userKey); // They're still in if they survive
            return { status: 'recorded', userKey };
        }

        return null;
    }

    /**
     * Remove a player (they're out)
     */
    removePlayer(userKey) {
        if (!this.activeSurvive) {
            return false;
        }

        return this.activeSurvive.survivors.delete(userKey);
    }

    /**
     * Get the list of players NOT yet survived
     */
    getOutPlayers() {
        if (!this.activeSurvive) {
            return [];
        }

        const out = [];
        for (const player of this.activeSurvive.players) {
            if (!this.activeSurvive.survivors.has(player)) {
                out.push(player);
            }
        }
        return out;
    }

    /**
     * Get current survive status
     */
    getStatus() {
        if (!this.activeSurvive) {
            return null;
        }

        const remaining = Math.max(0, this.activeSurvive.endTime - Date.now());

        return {
            survivors: this.activeSurvive.survivors.size,
            totalPlayers: this.activeSurvive.players.size,
            remaining: Array.from(this.activeSurvive.survivors),
            remainingMs: remaining,
            remainingSeconds: Math.ceil(remaining / 1000)
        };
    }

    /**
     * Check if a player is still alive
     */
    isAlive(userKey) {
        if (!this.activeSurvive) {
            return false;
        }
        return this.activeSurvive.survivors.has(userKey);
    }

    /**
     * Check if survive game is active
     */
    isActive() {
        return this.activeSurvive !== null && !this.activeSurvive.hasEnded;
    }

    /**
     * Get winners and losers
     */
    getResults() {
        if (!this.activeSurvive) {
            return null;
        }

        const survivors = Array.from(this.activeSurvive.survivors);
        const eliminated = Array.from(this.activeSurvive.players).filter(p => !survivors.includes(p));

        return {
            survivors,
            eliminated,
            totalPlayers: this.activeSurvive.players.size,
            winnersCount: survivors.length,
            losersCount: eliminated.length
        };
    }

    /**
     * End the survive game
     * @returns {object} - Results with winners and losers
     */
    endSurvive() {
        if (!this.activeSurvive) {
            return null;
        }

        this.activeSurvive.hasEnded = true;

        const results = this.getResults();

        this.activeSurvive = null;
        if (this.surviveTimer) {
            clearTimeout(this.surviveTimer);
            this.surviveTimer = null;
        }
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }

        log("debug", `Survive game ended. Winners: ${results.survivors.join(', ')}`);

        return results;
    }

    /**
     * Cancel the survive game
     */
    cancelSurvive() {
        if (this.surviveTimer) {
            clearTimeout(this.surviveTimer);
            this.surviveTimer = null;
        }
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        this.activeSurvive = null;
        log("debug", "Survive game cancelled");
    }

    /**
     * Schedule auto-end of survive game
     * @param {Function} callback - Called when game ends
     */
    scheduleAutoEnd(callback) {
        if (!this.activeSurvive) {
            return;
        }

        if (this.surviveTimer) {
            clearTimeout(this.surviveTimer);
        }

        this.surviveTimer = setTimeout(() => {
            // Add timeout period for late entries
            if (this.timeoutTimer) {
                clearTimeout(this.timeoutTimer);
            }

            this.timeoutTimer = setTimeout(() => {
                const results = this.endSurvive();
                if (callback) {
                    callback(results);
                }
            }, this.activeSurvive.timeoutMs);
        }, this.activeSurvive.durationMs);
    }
}

module.exports = SurviveManager;
