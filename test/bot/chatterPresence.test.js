import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatterPresence } from '../../src/bot/chatterPresence.js';

/** Mock TwitchApi whose getChatters returns whatever the current scenario sets. */
function makePresence(overrides = {}) {
  const state = { chatters: [], error: null };
  const twitchApi = {
    getChatters: async () => {
      if (state.error) throw state.error;
      return state.chatters;
    }
  };
  const presence = new ChatterPresence({
    twitchApi,
    channel: 'testchannel',
    botUsername: 'tuichibot',
    ignoredUsers: new Set(['nightbot']),
    confirmLeaveCycles: 2,
    recentMessageHoldMs: 5 * 60 * 1000,
    ...overrides
  });
  return { presence, state };
}

function chatter(name) {
  return { userId: name, userName: name, displayName: name };
}

function collect(presence) {
  const joins = [];
  const leaves = [];
  presence.on('join', (e) => joins.push(e.userKey));
  presence.on('leave', (e) => leaves.push(e.userKey));
  return { joins, leaves };
}

describe('ChatterPresence', () => {
  it('seeds existing chatters on the first poll without emitting joins', async () => {
    const { presence, state } = makePresence();
    const { joins, leaves } = collect(presence);
    state.chatters = [chatter('alice'), chatter('bob')];

    await presence.poll();

    assert.deepEqual(joins, []);
    assert.deepEqual(leaves, []);
    assert.deepEqual(presence.getPresentList().sort(), ['alice', 'bob']);
  });

  it('emits join for a user that appears after seeding', async () => {
    const { presence, state } = makePresence();
    state.chatters = [chatter('alice')];
    await presence.poll(); // seed
    const { joins } = collect(presence);

    state.chatters = [chatter('alice'), chatter('carol')];
    await presence.poll();

    assert.deepEqual(joins, ['carol']);
    assert.ok(presence.getPresentList().includes('carol'));
  });

  it('emits leave only after confirmLeaveCycles consecutive absences', async () => {
    const { presence, state } = makePresence();
    state.chatters = [chatter('alice'), chatter('bob')];
    await presence.poll(); // seed
    const { leaves } = collect(presence);

    // bob disappears
    state.chatters = [chatter('alice')];
    await presence.poll();
    assert.deepEqual(leaves, [], 'no leave after a single absence');

    await presence.poll();
    assert.deepEqual(leaves, ['bob'], 'leave fires on the 2nd consecutive absence');
    assert.ok(!presence.getPresentList().includes('bob'));
  });

  it('does not declare a user left while they are recently active in chat', async () => {
    const { presence, state } = makePresence();
    state.chatters = [chatter('alice'), chatter('bob')];
    await presence.poll(); // seed
    const { leaves } = collect(presence);

    presence.markActive('bob', 'bob'); // bob just chatted
    state.chatters = [chatter('alice')]; // API momentarily drops bob
    await presence.poll();
    await presence.poll();

    assert.deepEqual(leaves, [], 'recently-active user is held, not goodbye-d');
    assert.ok(presence.getPresentList().includes('bob'));
  });

  it('cancels a pending leave when the user chats again', async () => {
    const { presence, state } = makePresence();
    state.chatters = [chatter('alice'), chatter('bob')];
    await presence.poll(); // seed
    const { leaves } = collect(presence);

    state.chatters = [chatter('alice')];
    await presence.poll(); // bob missing (count 1)
    presence.markActive('bob', 'bob'); // resets missing
    await presence.poll(); // still missing but held by recent activity

    assert.deepEqual(leaves, []);
  });

  it('never emits join/leave for the bot or ignored users', async () => {
    const { presence, state } = makePresence();
    state.chatters = [chatter('alice')];
    await presence.poll(); // seed
    const { joins, leaves } = collect(presence);

    state.chatters = [chatter('alice'), chatter('tuichibot'), chatter('nightbot')];
    await presence.poll();
    assert.deepEqual(joins, [], 'bot and ignored users never produce joins');

    state.chatters = [chatter('alice')];
    await presence.poll();
    await presence.poll();
    assert.deepEqual(leaves, [], 'bot and ignored users never produce leaves');
  });

  it('keeps state and emits nothing on a transient fetch error', async () => {
    const { presence, state } = makePresence();
    state.chatters = [chatter('alice'), chatter('bob')];
    await presence.poll(); // seed
    const { joins, leaves } = collect(presence);

    state.error = new Error('network blip');
    await presence.poll();

    assert.deepEqual(joins, []);
    assert.deepEqual(leaves, []);
    assert.deepEqual(presence.getPresentList().sort(), ['alice', 'bob'], 'present set preserved');
    assert.equal(presence.isEnabled(), true, 'transient errors do not disable');
  });

  it('disables itself permanently on an auth error (missing scope)', async () => {
    const { presence, state } = makePresence();
    state.chatters = [chatter('alice')];
    await presence.poll(); // seed

    state.error = Object.assign(new Error('unauthorized'), { statusCode: 401 });
    await presence.poll();

    assert.equal(presence.isEnabled(), false);
  });

  it('re-seeds (no mass joins) after reset', async () => {
    const { presence, state } = makePresence();
    state.chatters = [chatter('alice')];
    await presence.poll(); // seed
    const { joins } = collect(presence);

    presence.reset();
    state.chatters = [chatter('alice'), chatter('bob'), chatter('carol')];
    await presence.poll(); // re-seed, no joins

    assert.deepEqual(joins, []);
    assert.deepEqual(presence.getPresentList().sort(), ['alice', 'bob', 'carol']);
  });

  it('counts recent chatters as present before Get Chatters lists them', async () => {
    const { presence, state } = makePresence();
    state.chatters = [chatter('alice')];
    await presence.poll(); // seed

    presence.markActive('bob', 'Bob'); // spoke, but the API hasn't caught up yet
    assert.deepEqual(presence.getPresentList().sort(), ['alice', 'bob']);
    assert.equal(presence.getPresentCount(), 2);
  });

  it('does not double-count a recent chatter the API already lists', async () => {
    const { presence, state } = makePresence();
    state.chatters = [chatter('alice')];
    await presence.poll(); // seed

    presence.markActive('alice', 'Alice');
    assert.deepEqual(presence.getPresentList(), ['alice']);
    assert.equal(presence.getPresentCount(), 1);
  });

  it('drops a chatter from the present list once the activity hold expires', async () => {
    const { presence, state } = makePresence({ recentMessageHoldMs: 20 });
    state.chatters = [chatter('alice')];
    await presence.poll(); // seed

    presence.markActive('bob', 'Bob');
    await new Promise(r => setTimeout(r, 40));
    assert.deepEqual(presence.getPresentList(), ['alice']);
  });

  it('never lists the bot itself as present, even if it chats', async () => {
    const { presence, state } = makePresence();
    state.chatters = [];
    await presence.poll(); // seed

    presence.markActive('tuichibot', 'TuichiBot');
    assert.deepEqual(presence.getPresentList(), []);
  });

  it('lists a recent chatter only once after the API catches up', async () => {
    const { presence, state } = makePresence();
    state.chatters = [];
    await presence.poll(); // seed
    const { joins } = collect(presence);

    presence.markActive('bob', 'Bob');
    state.chatters = [chatter('bob')];
    await presence.poll();
    // The join itself is still emitted (Greeter suppresses the greeting via
    // noteChatActivity); presence just must not list bob twice.
    assert.deepEqual(joins, ['bob']);
    assert.deepEqual(presence.getPresentList(), ['bob']);
  });
});
