import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PollManager } from '../../src/games/pollManager.js';

describe('PollManager', () => {
  let pm;
  beforeEach(() => { pm = new PollManager(); });

  it('starts a poll', () => {
    assert.equal(pm.startPoll('Q?', ['A', 'B'], 60000), true);
    assert.equal(pm.isActive(), true);
  });
  it('rejects poll with <2 options', () => {
    assert.equal(pm.startPoll('Q?', ['A'], 60000), false);
  });
  it('records votes', () => {
    pm.startPoll('Q?', ['A', 'B'], 60000);
    assert.equal(pm.recordVote('alice', 1), true);
    assert.equal(pm.recordVote('alice', 2), false); // already voted
    assert.equal(pm.recordVote('bob', 2), true);
  });
  it('ends poll with correct winner', () => {
    pm.startPoll('Q?', ['A', 'B'], 60000);
    pm.recordVote('alice', 1);
    pm.recordVote('bob', 1);
    pm.recordVote('charlie', 2);
    const results = pm.endPoll();
    assert.deepEqual(results.winners, [1]);
    assert.equal(results.totalVotes, 3);
  });
});
