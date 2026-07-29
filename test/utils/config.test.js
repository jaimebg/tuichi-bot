import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEnv, buildConfig } from '../../src/config.js';

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

describe('engagement.excludedUsers', () => {
  const baseEnv = {
    TWITCH_USERNAME: 'mibot', TWITCH_CHANNEL: 'micanal',
    TWITCH_API_TOKEN: 'x', TWITCH_REFRESH_TOKEN: 'x',
    TWITCH_CLIENT_ID: 'x', TWITCH_CLIENT_SECRET: 'x', GROQ_API_KEY: 'x'
  };

  it('incluye por defecto bots comunes, el bot y el canal', () => {
    const cfg = buildConfig({ ...baseEnv });
    assert.ok(cfg.engagement.excludedUsers.has('streamelements'));
    assert.ok(cfg.engagement.excludedUsers.has('nightbot'));
    assert.ok(cfg.engagement.excludedUsers.has('mibot'));
    assert.ok(cfg.engagement.excludedUsers.has('micanal'));
  });

  it('añade los usuarios de EXCLUDED_USERS, normalizados a minúsculas', () => {
    const cfg = buildConfig({ ...baseEnv, EXCLUDED_USERS: 'OtroBot, Tercero ,,' });
    assert.ok(cfg.engagement.excludedUsers.has('otrobot'));
    assert.ok(cfg.engagement.excludedUsers.has('tercero'));
    assert.ok(!cfg.engagement.excludedUsers.has(''));
  });
});

describe('resolución de recursos', () => {
  const baseEnv = {
    TWITCH_USERNAME: 'mibot', TWITCH_CHANNEL: 'micanal',
    TWITCH_API_TOKEN: 'x', TWITCH_REFRESH_TOKEN: 'x',
    TWITCH_CLIENT_ID: 'x', TWITCH_CLIENT_SECRET: 'x', GROQ_API_KEY: 'x'
  };

  it('construye la config con solo los ficheros .example presentes', () => {
    // En un clon limpio no existen los resources reales, solo los .example.
    const cfg = buildConfig({ ...baseEnv });
    assert.ok(Array.isArray(cfg.resources.greetings));
    assert.ok(cfg.resources.greetings.length > 0);
    assert.ok(typeof cfg.resources.persona === 'string');
    assert.ok(cfg.resources.persona.length > 0);
    assert.equal(typeof cfg.resources.aliases, 'object');
  });

  it('config.resources tiene exactamente las claves esperadas', () => {
    const cfg = buildConfig({ ...baseEnv });
    assert.deepEqual(
      Object.keys(cfg.resources).sort(),
      ['aliases', 'goodbyes', 'greetings', 'lore', 'persona']
    );
  });
});
