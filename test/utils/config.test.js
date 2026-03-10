import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv } from '../../src/config.js';

describe('validateEnv', () => {
  it('throws on missing required env var', () => {
    assert.throws(
      () => validateEnv({ TWITCH_USERNAME: '' }, ['TWITCH_USERNAME']),
      /TWITCH_USERNAME/
    );
  });
  it('returns values for present vars', () => {
    const env = { TWITCH_USERNAME: 'bot', GROQ_API_KEY: 'key123' };
    const result = validateEnv(env, ['TWITCH_USERNAME', 'GROQ_API_KEY']);
    assert.equal(result.TWITCH_USERNAME, 'bot');
    assert.equal(result.GROQ_API_KEY, 'key123');
  });
});
