import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TriviaManager } from '../../src/games/triviaManager.js';

function fakeAi({ question = '¿Capital de Francia?', options = { a: 'París', b: 'Londres', c: 'Roma', d: 'Berlín' }, correct = 'a', explanation = 'Es la capital de Francia.' } = {}) {
  return () => Promise.resolve(JSON.stringify({ question, options, correct, explanation }));
}

describe('TriviaManager', () => {
  let tm;
  beforeEach(() => { tm = new TriviaManager({ apiKey: 'x' }); });

  it('is inactive at construction', () => {
    assert.equal(tm.isActive(), false);
    assert.equal(tm.getTriviaStatus(), null);
  });

  it('starts trivia from a valid AI JSON response', async () => {
    const result = await tm.startTrivia('general', 30000, fakeAi());
    assert.ok(result);
    assert.equal(result.question, '¿Capital de Francia?');
    assert.equal(result.category, 'general');
    assert.equal(result.durationSeconds, 30);
    assert.equal(tm.isActive(), true);
  });

  it('returns null and stays inactive when the AI reply is not parseable JSON', async () => {
    const result = await tm.startTrivia('general', 30000, () => Promise.resolve('esto no es json'));
    assert.equal(result, null);
    assert.equal(tm.isActive(), false);
  });

  it('returns null when the parsed JSON is missing required fields', async () => {
    const missingCorrect = () => Promise.resolve(JSON.stringify({ question: 'Q?', options: { a: '1', b: '2' } }));
    const result = await tm.startTrivia('general', 30000, missingCorrect);
    assert.equal(result, null);
    assert.equal(tm.isActive(), false);
  });

  it('refuses to start a second trivia while one is active', async () => {
    await tm.startTrivia('general', 30000, fakeAi());
    const second = await tm.startTrivia('general', 30000, fakeAi({ question: 'otra' }));
    assert.equal(second, null);
    assert.equal(tm.getTriviaStatus().question, '¿Capital de Francia?');
  });

  it('records a valid answer and reports correctness', async () => {
    await tm.startTrivia('general', 30000, fakeAi({ correct: 'b' }));
    const result = tm.recordAnswer('alice', 'b');
    assert.deepEqual(result, { isCorrect: true, wasNew: true });
    assert.equal(tm.getTriviaStatus().answered, 1);
  });

  it('reports isCorrect: false for a wrong answer', async () => {
    await tm.startTrivia('general', 30000, fakeAi({ correct: 'b' }));
    const result = tm.recordAnswer('alice', 'c');
    assert.deepEqual(result, { isCorrect: false, wasNew: true });
  });

  it('normalizes case and whitespace on answers', async () => {
    await tm.startTrivia('general', 30000, fakeAi({ correct: 'b' }));
    const result = tm.recordAnswer('alice', ' B ');
    assert.equal(result.isCorrect, true);
  });

  it('rejects an answer letter outside a-d', async () => {
    await tm.startTrivia('general', 30000, fakeAi());
    const result = tm.recordAnswer('alice', 'e');
    assert.equal(result, null);
    assert.equal(tm.getTriviaStatus().answered, 0);
  });

  it('rejects a duplicate answer from the same user', async () => {
    await tm.startTrivia('general', 30000, fakeAi());
    tm.recordAnswer('alice', 'a');
    const second = tm.recordAnswer('alice', 'b');
    assert.equal(second, null);
    assert.equal(tm.getTriviaStatus().answered, 1);
  });

  it('rejects an answer when there is no active trivia', () => {
    assert.equal(tm.recordAnswer('alice', 'a'), null);
  });

  it('endTrivia tallies correct/wrong answers and clears state', async () => {
    await tm.startTrivia('general', 30000, fakeAi({ correct: 'a' }));
    tm.recordAnswer('alice', 'a');
    tm.recordAnswer('bob', 'c');
    const results = tm.endTrivia();
    assert.equal(results.correctCount, 1);
    assert.equal(results.wrongCount, 1);
    assert.deepEqual(results.correctAnswers, ['alice']);
    assert.deepEqual(results.wrongAnswers, ['bob']);
    assert.equal(tm.isActive(), false);
    assert.equal(tm.getTriviaStatus(), null);
  });

  it('cancel() returns trivia to inactive', async () => {
    await tm.startTrivia('general', 30000, fakeAi());
    tm.recordAnswer('alice', 'a');
    tm.cancelTrivia();
    assert.equal(tm.isActive(), false);
    assert.equal(tm.getTriviaStatus(), null);
  });
});
