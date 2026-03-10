import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../../src/utils/json.js';

describe('extractJson', () => {
  it('parses clean JSON', () => {
    const r = extractJson('{"story":"hello","options":["a","b"]}');
    assert.deepEqual(r, { story: 'hello', options: ['a', 'b'] });
  });
  it('extracts JSON from surrounding text', () => {
    const r = extractJson('Here: {"key":"val"} done');
    assert.deepEqual(r, { key: 'val' });
  });
  it('extracts from code fences', () => {
    assert.deepEqual(extractJson('```json\n{"q":"W?"}\n```'), { q: 'W?' });
  });
  it('returns null for plain text', () => {
    assert.equal(extractJson('just text'), null);
  });
  it('returns null for empty/null', () => {
    assert.equal(extractJson(''), null);
    assert.equal(extractJson(null), null);
  });
});
