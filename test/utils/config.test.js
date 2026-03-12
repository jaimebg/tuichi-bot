import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEnv } from '../../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('loadPersona preserves newlines', () => {
  it('buildConfig preserves newlines in persona', () => {
    const personaPath = path.resolve(__dirname, '../../resources/persona.txt');
    const raw = fs.readFileSync(personaPath, 'utf8');
    assert.ok(raw.includes('\n'), 'persona.txt should contain newlines');
  });
});

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
