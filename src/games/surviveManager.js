import { log } from '../logger.js';

export class SurviveManager {
    constructor() {
        this.activeSurvive = null;
        this.roundTimer = null;
        this.eliminated = new Set();
        this.roundParticipants = new Set();
    }

    /**
     * Start a survive game (Battle Royale de chat)
     * @param {string[]} connectedUsers - Array of currently connected users
     * @param {number} roundDurationMs - How long each round lasts (default 30 seconds)
     * @returns {object|null} - Survive game state
     */
    startSurvive(connectedUsers, roundDurationMs = 30000) {
        if (this.activeSurvive) {
            return null; // Survive game already active
        }

        const validUsers = connectedUsers.filter(u => u && u.length > 0);
        if (validUsers.length < 2) {
            return null; // Need at least 2 players
        }

        this.eliminated.clear();
        this.roundParticipants.clear();

        this.activeSurvive = {
            allPlayers: new Set(validUsers),          // All players that have ever participated
            currentRoundPlayers: new Set(validUsers), // Players at the start of this round
            survivorsThisRound: new Set(),            // Players who did !survive this round
            roundNumber: 1,
            startTime: Date.now(),
            roundStartTime: Date.now(),
            roundDurationMs,
            roundEndTime: Date.now() + roundDurationMs,
            hasEnded: false
        };

        log("debug", `Survive game started with ${validUsers.length} players: ${validUsers.join(', ')}`);

        return {
            players: Array.from(this.activeSurvive.allPlayers),
            count: this.activeSurvive.allPlayers.size,
            roundDurationSeconds: Math.ceil(roundDurationMs / 1000),
            message: `¡Ronda ${this.activeSurvive.roundNumber}! Escribid !survive para no ser eliminados.`
        };
    }

    /**
     * Record a player's !survive command for this round
     * @param {string} userKey - The player
     * @returns {object|null} - {status, survivorsCount}
     */
    recordSurvive(userKey) {
        if (!this.activeSurvive || this.activeSurvive.hasEnded) {
            return null;
        }

        // Check if player has already been eliminated in a previous round
        if (this.eliminated.has(userKey)) {
            return null; // Already eliminated, can't participate
        }

        // Check if they're part of this round
        if (!this.activeSurvive.currentRoundPlayers.has(userKey)) {
            return null; // Wasn't in this round
        }

        // Check if they already recorded this round
        if (this.activeSurvive.survivorsThisRound.has(userKey)) {
            return { status: 'already_recorded', survivorsCount: this.activeSurvive.survivorsThisRound.size };
        }

        // Record their survival for this round
        this.activeSurvive.survivorsThisRound.add(userKey);

        return {
            status: 'recorded',
            survivorsCount: this.activeSurvive.survivorsThisRound.size,
            totalRemaining: this.activeSurvive.currentRoundPlayers.size
        };
    }

    /**
     * Get players who didn't survive this round
     */
    getEliminatedThisRound() {
        if (!this.activeSurvive) {
            return [];
        }

        const eliminated = [];
        for (const player of this.activeSurvive.currentRoundPlayers) {
            if (!this.activeSurvive.survivorsThisRound.has(player)) {
                eliminated.push(player);
            }
        }
        return eliminated;
    }

    /**
     * Process end of round: eliminate those who didn't survive
     * @returns {object} - {eliminatedThisRound: [], continueGame: bool}
     */
    processRoundEnd() {
        if (!this.activeSurvive) {
            return null;
        }

        const currentRoundNumber = this.activeSurvive.roundNumber;
        const eliminatedThisRound = this.getEliminatedThisRound();

        // Mark them as permanently eliminated
        for (const player of eliminatedThisRound) {
            this.eliminated.add(player);
        }

        const survivorsThisRoundCount = this.activeSurvive.survivorsThisRound.size;
        log(
            "debug",
            `Round ${this.activeSurvive.roundNumber}: ${eliminatedThisRound.length} eliminated. Survivors: ${survivorsThisRoundCount}`
        );

        // Check if game should continue
        // End if 0-1 survived, or if only 2 players were in the round (avoids infinite loop when both always survive)
        const wasLastStandRound = this.activeSurvive.currentRoundPlayers.size <= 2;
        if (survivorsThisRoundCount <= 1 || wasLastStandRound) {
            // Game ends – either single winner, nobody survived, or final 2-player showdown
            const finalSnapshot = this.getResults() || {};
            this.activeSurvive.hasEnded = true;

            let reason;
            if (survivorsThisRoundCount === 0) reason = "everyone_died";
            else if (wasLastStandRound) reason = "last_survivors";
            else reason = "last_survivor";

            return {
                ...finalSnapshot,
                eliminatedThisRound,
                roundNumber: currentRoundNumber,
                continueGame: false,
                reason
            };
        }

        // Start new round with survivors
        this.activeSurvive.roundNumber++;
        this.activeSurvive.currentRoundPlayers = new Set(this.activeSurvive.survivorsThisRound);
        this.activeSurvive.survivorsThisRound.clear();
        this.activeSurvive.roundStartTime = Date.now();
        this.activeSurvive.roundEndTime = Date.now() + this.activeSurvive.roundDurationMs;

        return {
            eliminatedThisRound,
            continueGame: true,
            roundNumber: currentRoundNumber,
            newRoundNumber: this.activeSurvive.roundNumber,
            playersForNextRound: this.activeSurvive.currentRoundPlayers.size
        };
    }

    /**
     * Get current survive status
     */
    getStatus() {
        if (!this.activeSurvive) {
            return null;
        }

        const remaining = Math.max(0, this.activeSurvive.roundEndTime - Date.now());

        return {
            roundNumber: this.activeSurvive.roundNumber,
            playersInRound: this.activeSurvive.currentRoundPlayers.size,
            survivedSoFar: this.activeSurvive.survivorsThisRound.size,
            totalEliminated: this.eliminated.size,
            remaining: Array.from(this.activeSurvive.survivorsThisRound),
            remainingMs: remaining,
            remainingSeconds: Math.ceil(remaining / 1000)
        };
    }

    /**
     * Check if survive game is active
     */
    isActive() {
        return this.activeSurvive !== null && !this.activeSurvive.hasEnded;
    }

    /**
     * Get final results
     */
    getResults() {
        if (!this.activeSurvive) {
            return null;
        }

        const winners = Array.from(this.activeSurvive.survivorsThisRound);
        const totalEliminated = Array.from(this.eliminated);

        return {
            winners,
            eliminated: totalEliminated,
            totalPlayers: this.activeSurvive.allPlayers.size,
            winnersCount: winners.length,
            losersCount: totalEliminated.length,
            roundsPlayed: this.activeSurvive.roundNumber
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
        if (this.roundTimer) {
            clearTimeout(this.roundTimer);
            this.roundTimer = null;
        }

        if (!results) {
            log("warn", "Survive game ended but no results were available");
            return null;
        }

        const winnersList = Array.isArray(results.winners) ? results.winners : [];
        log(
            "debug",
            `Survive game ended after ${results.roundsPlayed} rounds. Winners: ${winnersList.join(', ') || 'ninguno'}`
        );

        return results;
    }

    /**
     * Cancel the survive game
     */
    cancelSurvive() {
        if (this.roundTimer) {
            clearTimeout(this.roundTimer);
            this.roundTimer = null;
        }
        this.activeSurvive = null;
        this.eliminated.clear();
        this.roundParticipants.clear();
        log("debug", "Survive game cancelled");
    }

    /**
     * Schedule end of current round
     * @param {Function} callback - Called with roundResult when round ends
     */
    scheduleRoundEnd(callback) {
        if (!this.activeSurvive) {
            return;
        }

        if (this.roundTimer) {
            clearTimeout(this.roundTimer);
        }

        const timeUntilRoundEnd = Math.max(0, this.activeSurvive.roundEndTime - Date.now());

        this.roundTimer = setTimeout(() => {
            const roundResult = this.processRoundEnd();
            if (callback) {
                callback(roundResult);
            }
        }, timeUntilRoundEnd);
    }
}

