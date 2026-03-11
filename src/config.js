import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWhitespace } from './utils/text.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESOURCES_DIR = path.join(ROOT, 'resources');

const REQUIRED_ENV = [
  'TWITCH_USERNAME', 'TWITCH_CHANNEL',
  'TWITCH_API_TOKEN', 'TWITCH_REFRESH_TOKEN',
  'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'GROQ_API_KEY'
];


/** Validate required keys exist and are non-empty. */
export function validateEnv(env, keys) {
  const result = {};
  const missing = [];
  for (const key of keys) {
    const val = env[key];
    if (!val || !val.trim()) missing.push(key);
    else result[key] = val.trim();
  }
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  return result;
}

function readTextFile(filePath, label) {
  try { return fs.readFileSync(path.resolve(filePath), 'utf8'); }
  catch (err) { throw new Error(`Unable to read ${label} file: ${err.message}`); }
}

function loadGreetings(filePath) {
  const msgs = readTextFile(filePath, 'greetings').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!msgs.length) throw new Error('Greeting file must contain at least one message.');
  return msgs;
}

function loadPersona(filePath) {
  const p = normalizeWhitespace(readTextFile(filePath, 'persona'));
  if (!p) throw new Error('Persona file cannot be empty.');
  return p;
}

function loadLore(filePath) {
  try { return normalizeWhitespace(readTextFile(filePath, 'lore')) || ''; }
  catch (_) { return ''; }
}

function loadAliases(filePath) {
  const aliases = {};
  for (const line of readTextFile(filePath, 'aliases').split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) {
      const [u, a] = t.split(':').map(s => s.trim());
      if (u && a) aliases[u.toLowerCase()] = a;
    }
  }
  return aliases;
}

/** Build frozen config from env vars and resource files. */
export function buildConfig(env = process.env) {
  const vars = validateEnv(env, REQUIRED_ENV);
  const greetings = loadGreetings(path.join(RESOURCES_DIR, 'greetings.txt'));
  const persona = loadPersona(path.join(RESOURCES_DIR, 'persona.txt'));
  const lore = loadLore(path.join(RESOURCES_DIR, 'lore.txt'));
  const aliases = loadAliases(path.join(RESOURCES_DIR, 'aliases.txt'));
  return Object.freeze({
    twitch: Object.freeze({
      username: vars.TWITCH_USERNAME, channel: vars.TWITCH_CHANNEL,
      apiToken: vars.TWITCH_API_TOKEN,
      refreshToken: vars.TWITCH_REFRESH_TOKEN,
      clientId: vars.TWITCH_CLIENT_ID, clientSecret: vars.TWITCH_CLIENT_SECRET,
      broadcasterToken: (env.TWITCH_BROADCASTER_TOKEN || '').trim() || null,
      broadcasterRefreshToken: (env.TWITCH_BROADCASTER_REFRESH_TOKEN || '').trim() || null
    }),
    groq: Object.freeze({
      apiKey: vars.GROQ_API_KEY,
      baseUrl: 'https://api.groq.com/openai/v1',
      models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
      temperature: 0.7, timeoutMs: 20000, maxTokens: 10000
    }),
    ai: Object.freeze({
      maxChars: 500, historyLimit: 5, userCooldownMs: 1000, globalCooldownMs: 1000
    }),
    intelligence: Object.freeze({
      recentChatLimit: 20, userMemoryLimit: 100, conversationThreadLimit: 10,
      engagementTrackingDays: 7, contextWindowMinutes: 10,
      maxRecentMessages: 12, autoTriggerChance: 0.1
    }),
    adventure: Object.freeze({ votingTimeMs: 80000, defaultMaxRounds: 3, maxRoundsLimit: 10 }),
    media: Object.freeze({
      enabled: (env.MEDIA_OVERLAY_ENABLED ?? 'true') !== 'false',
      host: '0.0.0.0', port: Number(env.MEDIA_OVERLAY_PORT) || 8910,
      displayDurationMs: 12000,
      rewardsFile: path.join(RESOURCES_DIR, 'mediaRewards.json'),
      keepLastFrame: false
    }),
    channelPoints: Object.freeze({
      enabled: true, reconnectBaseMs: 5000, maxReconnectMs: 60000, keepaliveGraceMs: 15000
    }),
    health: Object.freeze({
      port: Number(env.HEALTH_PORT) || 9090,
      apiKey: (env.HEALTH_API_KEY || '').trim() || null
    }),
    singleWordEchoChance: 0.05,
    singleWordEchoDelayMs: 2000,
    spontaneousReplyChance: 0.05,
    spontaneousReplyCooldownMs: 5 * 60 * 1000,
    logLevel: env.LOG_LEVEL || 'info',
    resources: Object.freeze({ greetings, persona, lore, aliases }),
    paths: Object.freeze({
      root: ROOT, resources: RESOURCES_DIR,
      data: path.join(ROOT, 'data'), db: path.join(ROOT, 'data', 'tuichi.db')
    })
  });
}
