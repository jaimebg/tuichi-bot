import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../src/persistence/database.js';
import { UserMemory } from '../../src/intelligence/userMemory.js';
import { RecentChatTracker } from '../../src/intelligence/recentChatTracker.js';
import { ConversationThreads } from '../../src/intelligence/conversationThreads.js';

describe('Bot Integration', () => {
  it('intelligence modules work together with DB', () => {
    const db = new Database(':memory:');
    const userMemory = new UserMemory(db, 100, 7);
    const recentChat = new RecentChatTracker(db, 20, 10);
    const threads = new ConversationThreads(db, 10);

    // Simulate user activity
    userMemory.updateEngagement('alice', 'hello world', Date.now(), { displayName: 'Alice' });
    recentChat.addMessage('alice', 'Alice', 'hello world');
    const threadId = threads.getOrCreateThread('alice');
    threads.addMessage(threadId, 'user', 'hello world');

    // Save to DB
    userMemory.save();
    recentChat.save();
    threads.save();

    // Create new instances and load from DB
    const userMemory2 = new UserMemory(db, 100, 7);
    userMemory2.load();
    assert.equal(userMemory2.memories.size, 1);
    assert.ok(userMemory2.memories.has('alice'));

    const recentChat2 = new RecentChatTracker(db, 20, 10);
    recentChat2.load();
    assert.equal(recentChat2.messages.length, 1);

    const threads2 = new ConversationThreads(db, 10);
    threads2.load();
    assert.equal(threads2.threads.size, 1);

    db.close();
  });
});
