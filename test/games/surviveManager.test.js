import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SurviveManager } from '../../src/games/surviveManager.js';

describe('SurviveManager', () => {
  let sm;
  beforeEach(() => { sm = new SurviveManager(); });

  it('is inactive at construction', () => {
    assert.equal(sm.isActive(), false);
    assert.equal(sm.getStatus(), null);
  });

  it('refuses to start with fewer than 2 valid players', () => {
    assert.equal(sm.startSurvive(['alice']), null);
    assert.equal(sm.startSurvive([]), null);
    assert.equal(sm.isActive(), false);
  });

  it('filters out empty/falsy entries from connectedUsers', () => {
    const result = sm.startSurvive(['alice', '', 'bob', null]);
    assert.ok(result);
    assert.equal(result.count, 2);
  });

  it('starts a game with >=2 players', () => {
    const result = sm.startSurvive(['alice', 'bob', 'carol'], 30000);
    assert.ok(result);
    assert.equal(result.count, 3);
    assert.deepEqual(result.players.sort(), ['alice', 'bob', 'carol']);
    assert.equal(sm.isActive(), true);
    assert.equal(sm.getStatus().playersInRound, 3);
    assert.equal(sm.getStatus().roundNumber, 1);
  });

  it('refuses to start a second game while one is active', () => {
    sm.startSurvive(['alice', 'bob']);
    const second = sm.startSurvive(['carol', 'dave']);
    assert.equal(second, null);
    assert.equal(sm.getStatus().playersInRound, 2);
  });

  it('records a valid survive for a player in the round', () => {
    sm.startSurvive(['alice', 'bob', 'carol']);
    const result = sm.recordSurvive('alice');
    assert.deepEqual(result, { status: 'recorded', survivorsCount: 1, totalRemaining: 3 });
    assert.equal(sm.getStatus().survivedSoFar, 1);
  });

  it('does not record the same participant twice in the same round', () => {
    sm.startSurvive(['alice', 'bob', 'carol']);
    sm.recordSurvive('alice');
    const again = sm.recordSurvive('alice');
    assert.deepEqual(again, { status: 'already_recorded', survivorsCount: 1 });
    assert.equal(sm.getStatus().survivedSoFar, 1);
  });

  it('rejects a survive from someone who was not part of the round', () => {
    sm.startSurvive(['alice', 'bob']);
    assert.equal(sm.recordSurvive('carol'), null);
  });

  it('rejects a survive when there is no active game', () => {
    assert.equal(sm.recordSurvive('alice'), null);
  });

  it('getEliminatedThisRound lists players who did not record survive', () => {
    sm.startSurvive(['alice', 'bob', 'carol']);
    sm.recordSurvive('alice');
    const eliminated = sm.getEliminatedThisRound().sort();
    assert.deepEqual(eliminated, ['bob', 'carol']);
  });

  it('processRoundEnd continues the game when >1 survive and >2 players were in the round', () => {
    sm.startSurvive(['alice', 'bob', 'carol']);
    sm.recordSurvive('alice');
    sm.recordSurvive('bob');
    const result = sm.processRoundEnd();
    assert.equal(result.continueGame, true);
    assert.deepEqual(result.eliminatedThisRound, ['carol']);
    assert.equal(result.newRoundNumber, 2);
    assert.equal(result.playersForNextRound, 2);
    assert.equal(sm.getStatus().totalEliminated, 1);
    assert.equal(sm.isActive(), true);
  });

  it('processRoundEnd ends the game when <=1 player survives', () => {
    sm.startSurvive(['alice', 'bob', 'carol']);
    sm.recordSurvive('alice');
    const result = sm.processRoundEnd();
    assert.equal(result.continueGame, false);
    assert.equal(result.reason, 'last_survivor');
    assert.equal(sm.isActive(), false);
  });

  it('processRoundEnd ends the game on a last-stand round even if both survive', () => {
    sm.startSurvive(['alice', 'bob']);
    sm.recordSurvive('alice');
    sm.recordSurvive('bob');
    const result = sm.processRoundEnd();
    assert.equal(result.continueGame, false);
    assert.equal(result.reason, 'last_survivors');
    assert.equal(sm.isActive(), false);
  });

  it('processRoundEnd reports everyone_died when nobody survives', () => {
    sm.startSurvive(['alice', 'bob', 'carol']);
    const result = sm.processRoundEnd();
    assert.equal(result.continueGame, false);
    assert.equal(result.reason, 'everyone_died');
  });

  it('rejects a survive from an eliminated player in a later round', () => {
    sm.startSurvive(['alice', 'bob', 'carol']);
    sm.recordSurvive('alice');
    sm.recordSurvive('bob');
    sm.processRoundEnd(); // carol eliminated, round 2 starts with alice+bob
    assert.equal(sm.recordSurvive('carol'), null);
  });

  it('rejects a survive once the game has ended', () => {
    sm.startSurvive(['alice', 'bob', 'carol']);
    sm.recordSurvive('alice');
    sm.processRoundEnd(); // ends: only 1 survivor
    assert.equal(sm.recordSurvive('alice'), null);
  });

  it('endSurvive returns final results and clears the game', () => {
    sm.startSurvive(['alice', 'bob', 'carol']);
    sm.recordSurvive('alice');
    const results = sm.endSurvive();
    assert.ok(results);
    assert.equal(results.totalPlayers, 3);
    assert.deepEqual(results.winners, ['alice']);
    assert.equal(sm.isActive(), false);
    assert.equal(sm.getStatus(), null);
  });

  it('cancel() returns the game to inactive', () => {
    sm.startSurvive(['alice', 'bob', 'carol']);
    sm.recordSurvive('alice');
    sm.cancelSurvive();
    assert.equal(sm.isActive(), false);
    assert.equal(sm.getStatus(), null);
  });
});
