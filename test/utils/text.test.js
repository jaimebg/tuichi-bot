import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWhitespace, clampResponseLength, preserveNewlines, stripAccents } from '../../src/utils/text.js';

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

describe('preserveNewlines', () => {
  it('preserves single newlines', () => {
    assert.equal(preserveNewlines('line1\nline2'), 'line1\nline2');
  });
  it('collapses multiple blank lines into one', () => {
    assert.equal(preserveNewlines('line1\n\n\nline2'), 'line1\n\nline2');
  });
  it('trims trailing whitespace per line', () => {
    assert.equal(preserveNewlines('hello   \nworld  '), 'hello\nworld');
  });
  it('collapses multiple spaces within a line', () => {
    assert.equal(preserveNewlines('hello   world'), 'hello world');
  });
  it('returns empty for non-string', () => {
    assert.equal(preserveNewlines(null), '');
  });
  it('handles Windows line endings', () => {
    assert.equal(preserveNewlines('line1\r\nline2'), 'line1\nline2');
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

describe('stripAccents', () => {
  it('removes Spanish diacritics', () => {
    assert.equal(stripAccents('código'), 'codigo');
    assert.equal(stripAccents('canción'), 'cancion');
    assert.equal(stripAccents('reunión'), 'reunion');
  });
  it('preserves non-accented text', () => {
    assert.equal(stripAccents('hello world'), 'hello world');
  });
  it('handles ñ as expected', () => {
    assert.equal(stripAccents('año'), 'ano');
  });
  it('returns empty for non-string', () => {
    assert.equal(stripAccents(null), '');
  });
});
