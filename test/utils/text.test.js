import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWhitespace, clampResponseLength } from '../../src/utils/text.js';

describe('normalizeWhitespace', () => {
  it('collapses multiple spaces', () => {
    assert.equal(normalizeWhitespace('hello   world'), 'hello world');
  });
  it('trims leading/trailing', () => {
    assert.equal(normalizeWhitespace('  hello  '), 'hello');
  });
  it('returns empty for non-string', () => {
    assert.equal(normalizeWhitespace(null), '');
  });
});

describe('clampResponseLength', () => {
  it('returns text unchanged under limit', () => {
    assert.equal(clampResponseLength('short', 100), 'short');
  });
  it('truncates with ellipsis over limit', () => {
    const result = clampResponseLength('a'.repeat(50), 20);
    assert.equal(result.length, 20);
    assert.ok(result.endsWith('...'));
  });
  it('returns empty for empty input', () => {
    assert.equal(clampResponseLength('', 100), '');
  });
});
