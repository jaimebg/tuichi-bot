const { log } = require("../logger");

class PollManager {
    constructor() {
        this.activePoll = null;
        this.pollTimer = null;
    }

    /**
     * Start a new poll with the given options
     * @param {string} question - The poll question
     * @param {string[]} options - Array of options (e.g., ["Opción 1", "Opción 2"])
     * @param {number} durationMs - How long the poll lasts
     * @returns {boolean} - True if poll started successfully
     */
    startPoll(question, options, durationMs = 60000) {
        if (this.activePoll) {
            return false; // Poll already active
        }

        if (!question || !Array.isArray(options) || options.length < 2) {
            return false;
        }

        // Limit to reasonable number of options
        if (options.length > 10) {
            return false;
        }

        this.activePoll = {
            question,
            options: options.map(opt => opt.trim()).filter(opt => opt),
            votes: new Map(),
            voters: new Set(),
            startTime: Date.now(),
            endTime: Date.now() + durationMs,
            durationMs
        };

        // Initialize vote counts
        for (let i = 0; i < this.activePoll.options.length; i++) {
            this.activePoll.votes.set(i + 1, 0);
        }

        log("debug", `Poll started: "${question}" with ${this.activePoll.options.length} options`);

        return true;
    }

    /**
     * Register a vote for the active poll
     * @param {string} userKey - The user voting
     * @param {number} optionIndex - The option number (1-indexed)
     * @returns {boolean} - True if vote was recorded
     */
    recordVote(userKey, optionIndex) {
        if (!this.activePoll) {
            return false;
        }

        const numericIndex = parseInt(optionIndex, 10);
        if (isNaN(numericIndex) || numericIndex < 1 || numericIndex > this.activePoll.options.length) {
            return false;
        }

        if (this.activePoll.voters.has(userKey)) {
            return false; // User already voted
        }

        this.activePoll.voters.add(userKey);
        this.activePoll.votes.set(numericIndex, (this.activePoll.votes.get(numericIndex) || 0) + 1);

        log("debug", `Vote recorded for option ${numericIndex} by ${userKey}`);
        return true;
    }

    /**
     * Check if a poll is currently active
     * @returns {boolean}
     */
    isActive() {
        return this.activePoll !== null;
    }

    /**
     * Get current poll status
     * @returns {object|null}
     */
    getPollStatus() {
        if (!this.activePoll) {
            return null;
        }

        const remaining = Math.max(0, this.activePoll.endTime - Date.now());
        const totalVotes = this.activePoll.voters.size;

        const optionsWithVotes = this.activePoll.options.map((opt, idx) => ({
            number: idx + 1,
            text: opt,
            votes: this.activePoll.votes.get(idx + 1) || 0
        }));

        return {
            question: this.activePoll.question,
            options: optionsWithVotes,
            totalVotes,
            remainingMs: remaining,
            remainingSeconds: Math.ceil(remaining / 1000)
        };
    }

    /**
     * End the current poll and return results
     * @returns {object|null} - Poll results or null if no active poll
     */
    endPoll() {
        if (!this.activePoll) {
            return null;
        }

        const results = {
            question: this.activePoll.question,
            options: this.activePoll.options.map((opt, idx) => ({
                number: idx + 1,
                text: opt,
                votes: this.activePoll.votes.get(idx + 1) || 0
            })),
            totalVotes: this.activePoll.voters.size
        };

        // Find winner
        let maxVotes = 0;
        let winners = [];
        results.options.forEach(opt => {
            if (opt.votes > maxVotes) {
                maxVotes = opt.votes;
                winners = [opt.number];
            } else if (opt.votes === maxVotes && opt.votes > 0) {
                winners.push(opt.number);
            }
        });

        results.winners = winners;

        this.activePoll = null;
        log("debug", `Poll ended with winners: ${winners.join(', ')}`);

        return results;
    }

    /**
     * Cancel the active poll
     * @returns {boolean}
     */
    cancelPoll() {
        if (!this.activePoll) {
            return false;
        }

        this.activePoll = null;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }

        log("debug", "Poll cancelled");
        return true;
    }

    /**
     * Schedule auto-end of poll
     * @param {Function} callback - Called when poll ends
     */
    scheduleAutoEnd(callback) {
        if (!this.activePoll) {
            return;
        }

        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }

        this.pollTimer = setTimeout(() => {
            const results = this.endPoll();
            if (callback) {
                callback(results);
            }
        }, this.activePoll.durationMs);
    }
}

module.exports = PollManager;
