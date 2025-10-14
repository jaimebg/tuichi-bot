const { log } = require("../logger");

class ConversationThreads {
    constructor(limit = 10) {
        this.threads = new Map();
        this.userThreads = new Map();
        this.limit = limit;
        this.nextThreadId = 1;
    }

    getOrCreateThread(userKey, isReply = false, replyToUser = null) {
        if (isReply && replyToUser && this.userThreads.has(replyToUser)) {
            const threadId = this.userThreads.get(replyToUser);
            this.userThreads.set(userKey, threadId);
            return threadId;
        }

        if (this.userThreads.has(userKey)) {
            return this.userThreads.get(userKey);
        }

        const threadId = this.nextThreadId++;
        this.userThreads.set(userKey, threadId);
        this.threads.set(threadId, []);

        if (this.threads.size > this.limit) {
            const oldestThread = Math.min(...this.threads.keys());
            this.threads.delete(oldestThread);
            for (const [user, id] of this.userThreads.entries()) {
                if (id === oldestThread) {
                    this.userThreads.delete(user);
                }
            }
        }

        return threadId;
    }

    addMessage(threadId, role, content, timestamp = Date.now()) {
        if (!this.threads.has(threadId)) return;

        const thread = this.threads.get(threadId);
        thread.push({ role, content, timestamp });

        if (thread.length > 20) {
            thread.shift();
        }
    }

    getThread(threadId, limit = null) {
        const thread = this.threads.get(threadId) || [];
        return limit ? thread.slice(-limit) : thread;
    }

    serialize() {
        return {
            threads: this.threads,
            userThreads: this.userThreads,
            limit: this.limit,
            nextThreadId: this.nextThreadId
        };
    }

    deserialize(data) {
        if (data) {
            this.threads = data.threads instanceof Map ? data.threads : new Map(Object.entries(data.threads || {}));
            this.userThreads = data.userThreads instanceof Map ? data.userThreads : new Map(Object.entries(data.userThreads || {}));
            this.limit = data.limit || this.limit;
            this.nextThreadId = data.nextThreadId || 1;
        }
    }

    cleanup(maxAgeMs = 24 * 60 * 60 * 1000) {
        const cutoff = Date.now() - maxAgeMs;
        const threadsToRemove = [];

        for (const [threadId, messages] of this.threads.entries()) {
            if (messages.length === 0) {
                threadsToRemove.push(threadId);
                continue;
            }

            const lastMessage = messages[messages.length - 1];
            if (lastMessage.timestamp < cutoff) {
                threadsToRemove.push(threadId);
            }
        }

        threadsToRemove.forEach((threadId) => {
            this.threads.delete(threadId);
            for (const [user, id] of this.userThreads.entries()) {
                if (id === threadId) {
                    this.userThreads.delete(user);
                }
            }
        });

        if (threadsToRemove.length > 0) {
            log("info", `Cleaned up ${threadsToRemove.length} old conversation threads`);
        }
    }
}

module.exports = ConversationThreads;
