import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AdventureManager } from '../../src/games/adventureManager.js';

function fakeAi({ story = 'Te despiertas en un bosque oscuro y algo cruje entre los árboles.', options = ['Explorar', 'Gritar', 'Dormir'] } = {}) {
  return () => Promise.resolve(JSON.stringify({ story, options }));
}

describe('AdventureManager', () => {
  let am;
  beforeEach(() => { am = new AdventureManager({ apiKey: 'x' }, 'lore de prueba'); });

  it('is inactive at construction', () => {
    assert.equal(am.isActive(), false);
    assert.equal(am.getStatus(), null);
  });

  it('starts an adventure from a valid AI JSON response', async () => {
    const result = await am.startAdventure('bosque encantado', fakeAi());
    assert.ok(result);
    assert.equal(result.round, 1);
    assert.equal(result.options.length, 3);
    assert.ok(result.story.includes('bosque oscuro'));
    assert.equal(am.isActive(), true);
  });

  it('falls back to raw text and default options when the AI reply is not JSON', async () => {
    const longText = 'x'.repeat(300);
    const result = await am.startAdventure('tema', () => Promise.resolve(longText));
    assert.ok(result);
    assert.deepEqual(result.options, ['Avanzar', 'Investigar', 'Huir']);
    assert.equal(result.story.length, 250);
    assert.equal(am.isActive(), true);
  });

  it('returns null and stays inactive when the AI gives fewer than 2 options', async () => {
    const result = await am.startAdventure('tema', fakeAi({ options: ['solo una'] }));
    assert.equal(result, null);
    assert.equal(am.isActive(), false);
  });

  it('returns null and stays inactive when the AI gives no story', async () => {
    const result = await am.startAdventure('tema', fakeAi({ story: '' }));
    assert.equal(result, null);
    assert.equal(am.isActive(), false);
  });

  it('refuses to start a second adventure while one is active', async () => {
    await am.startAdventure('tema1', fakeAi());
    const second = await am.startAdventure('tema2', fakeAi({ story: 'otra historia' }));
    assert.equal(second, null);
    assert.equal(am.getStatus().theme, 'tema1');
  });

  it('records a valid vote for an option', async () => {
    await am.startAdventure('tema', fakeAi());
    assert.equal(am.recordVote('alice', 1), true);
    assert.equal(am.getStatus().voters, 1);
  });

  it('rejects a vote with an out-of-range option index', async () => {
    await am.startAdventure('tema', fakeAi());
    assert.equal(am.recordVote('alice', 0), false);
    assert.equal(am.recordVote('alice', 4), false);
    assert.equal(am.getStatus().voters, 0);
  });

  it('rejects a duplicate vote from the same user', async () => {
    await am.startAdventure('tema', fakeAi());
    am.recordVote('alice', 1);
    const second = am.recordVote('alice', 2);
    assert.equal(second, false);
    assert.equal(am.getStatus().voters, 1);
  });

  it('rejects a vote when there is no active adventure', () => {
    assert.equal(am.recordVote('alice', 1), false);
  });

  it('getWinningOption reports the option with the most votes', async () => {
    await am.startAdventure('tema', fakeAi());
    am.recordVote('alice', 2);
    am.recordVote('bob', 2);
    am.recordVote('carol', 1);
    const winner = am.getWinningOption();
    assert.equal(winner.option, 2);
    assert.equal(winner.votes, 2);
    assert.equal(winner.text, 'Gritar');
  });

  it('continueAdventure advances the round and resets votes', async () => {
    await am.startAdventure('tema', fakeAi());
    am.recordVote('alice', 1);
    const result = await am.continueAdventure('Explorar', fakeAi({ story: 'La aventura continúa con un nuevo giro.', options: ['Seguir', 'Volver', 'Esconderse'] }));
    assert.ok(result);
    assert.equal(result.round, 2);
    assert.equal(am.getStatus().voters, 0);
    // The voter set was reset, so alice can vote again this round.
    assert.equal(am.recordVote('alice', 1), true);
  });

  it('continueAdventure ends the adventure after round 4', async () => {
    await am.startAdventure('tema', fakeAi());
    let result;
    for (let i = 0; i < 4; i++) {
      result = await am.continueAdventure(`accion ${i}`, fakeAi());
    }
    assert.equal(result.reason, 'end');
    assert.equal(am.isActive(), false);
    assert.equal(am.getStatus(), null);
  });

  it('endAdventure clears state and returns the given reason', async () => {
    await am.startAdventure('tema', fakeAi());
    const result = await am.endAdventure('accion final', 'manual', fakeAi());
    assert.equal(result.reason, 'manual');
    assert.equal(am.isActive(), false);
    assert.equal(am.getStatus(), null);
  });

  it('cancel() returns the adventure to inactive', async () => {
    await am.startAdventure('tema', fakeAi());
    am.recordVote('alice', 1);
    am.cancelAdventure();
    assert.equal(am.isActive(), false);
    assert.equal(am.getStatus(), null);
  });
});
