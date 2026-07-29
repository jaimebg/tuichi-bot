import { normalizeWhitespace } from '../utils/text.js';
import { log } from '../logger.js';
import { parseSqliteUtc } from '../utils/time.js';

export class RecentChatTracker {
    constructor(db, limit = 20, contextWindowMinutes = 10) {
        this.db = db;
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

        // Also persist to DB
        this.db.chat.addMessage(userKey, displayName, normalizeWhitespace(message));
    }

    cleanOldMessages() {
        const cutoff = Date.now() - this.contextWindowMs;
        this.messages = this.messages.filter((msg) => msg.timestamp > cutoff);
    }

    getRecentContext(excludeUser = null, botUsername = null) {
        this.cleanOldMessages();
        return this.messages
            .filter((msg) => {
                if (msg.userKey === excludeUser) return false;
                if (botUsername) {
                    const lower = msg.message.toLowerCase();
                    if (lower.includes(`@${botUsername}`)) return false;
                    if (lower.startsWith('!vicky') || lower.startsWith('!vickiña')) return false;
                }
                return true;
            })
            .slice(-10)
            .map((msg) => `${msg.displayName}: ${msg.message}`)
            .join("; ");
    }

    load() {
        const rows = this.db.chat.getRecent(this.limit);
        this.messages = rows.reverse().map(r => ({
            userKey: r.user_id, displayName: r.display_name,
            message: r.message, timestamp: parseSqliteUtc(r.timestamp) ?? Date.now()
        }));
        this.cleanOldMessages();
        log('info', `Loaded ${this.messages.length} recent chat messages from DB`);
    }

    save() {
        this.db.chat.pruneOlderThan(this.contextWindowMs / 60000);
    }
}
