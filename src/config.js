import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preserveNewlines } from './utils/text.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESOURCES_DIR = path.join(ROOT, 'resources');

const REQUIRED_ENV = [
  'TWITCH_USERNAME', 'TWITCH_CHANNEL',
  'TWITCH_API_TOKEN', 'TWITCH_REFRESH_TOKEN',
  'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'GROQ_API_KEY'
];

const DEFAULT_EXCLUDED_BOTS = ['streamelements', 'nightbot', 'streamlabs', 'moobot', 'fossabot'];

/**
 * Usuarios excluidos de las interacciones proactivas del bot: saludos, mensajes de inactividad
 * y listado de top users. NO filtra mensajes entrantes: sus mensajes se procesan con normalidad.
 */
function buildExcludedUsers(env, botUsername, channel) {
  const extra = (env.EXCLUDED_USERS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return new Set([
    ...DEFAULT_EXCLUDED_BOTS,
    botUsername.toLowerCase(),
    channel.toLowerCase().replace(/^#/, ''),
    ...extra
  ]);
}


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

function loadLines(filePath, label) {
  const msgs = readTextFile(filePath, label).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!msgs.length) throw new Error(`${label} file must contain at least one message.`);
  return msgs;
}

function loadPersona(filePath) {
  const p = preserveNewlines(readTextFile(filePath, 'persona'));
  if (!p) throw new Error('Persona file cannot be empty.');
  return p;
}

function loadLore(filePath) {
  return preserveNewlines(readTextFile(filePath, 'lore')) || '';
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

/**
 * Resuelve un recurso: primero el fichero real, luego su variante .example.
 * Exportada para poder probar la resolución contra un directorio controlado
 * por el test, en vez de depender de lo que haya en RESOURCES_DIR.
 * @returns {{path: string, isExample: boolean}|null}
 */
export function resolveResourcePath(dir, filename) {
  const real = path.join(dir, filename);
  if (fs.existsSync(real)) return { path: real, isExample: false };

  const ext = path.extname(filename);
  const example = path.join(dir, `${path.basename(filename, ext)}.example${ext}`);
  if (fs.existsSync(example)) return { path: example, isExample: true };

  return null;
}

const RESOURCE_SPECS = [
  { key: 'greetings', file: 'greetings.txt', required: true, loader: loadLines, fallback: [] },
  { key: 'goodbyes', file: 'goodbyes.txt', required: true, loader: loadLines, fallback: [] },
  { key: 'persona', file: 'persona.txt', required: true, loader: loadPersona, fallback: '' },
  { key: 'lore', file: 'lore.txt', required: false, loader: loadLore, fallback: '' },
  { key: 'aliases', file: 'aliases.txt', required: false, loader: loadAliases, fallback: {} }
];

/**
 * Carga todos los recursos, acumulando los obligatorios ausentes en un único error.
 * Exportada por el mismo motivo que resolveResourcePath: probar contra un
 * directorio fixture controlado por el test, no contra RESOURCES_DIR real.
 */
export function loadResources(dir) {
  const resources = {};
  const missing = [];

  for (const spec of RESOURCE_SPECS) {
    const resolved = resolveResourcePath(dir, spec.file);

    if (!resolved) {
      if (spec.required) missing.push(spec.file);
      else resources[spec.key] = spec.fallback;
      continue;
    }

    if (resolved.isExample) {
      log('warn', `Usando ${path.basename(resolved.path)} como plantilla. Crea resources/${spec.file} para personalizarlo.`);
    }

    resources[spec.key] = spec.loader(resolved.path, spec.key);
  }

  if (missing.length) {
    throw new Error(
      `Faltan ficheros de recursos obligatorios en resources/: ${missing.join(', ')}.\n` +
      `Crea cada uno, o restaura su plantilla .example. Formato de cada fichero: ` +
      `ver la sección "Resource files" del README.`
    );
  }

  return resources;
}

/** Resuelve mediaRewards.json (real o .example), avisando si cae a la plantilla. */
function resolveMediaRewardsFile(dir) {
  const resolved = resolveResourcePath(dir, 'mediaRewards.json');
  if (!resolved) return path.join(dir, 'mediaRewards.json');
  if (resolved.isExample) {
    log('warn', `Usando ${path.basename(resolved.path)} como plantilla. Crea resources/mediaRewards.json para personalizarlo.`);
  }
  return resolved.path;
}

/** Build frozen config from env vars and resource files. */
export function buildConfig(env = process.env) {
  const vars = validateEnv(env, REQUIRED_ENV);
  const resources = loadResources(RESOURCES_DIR);
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
      temperature: 0.7, timeoutMs: 20000, maxTokens: 1024
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
      rewardsFile: resolveMediaRewardsFile(RESOURCES_DIR),
      keepLastFrame: false
    }),
    channelPoints: Object.freeze({
      enabled: true, reconnectBaseMs: 5000, maxReconnectMs: 60000, keepaliveGraceMs: 15000
    }),
    engagement: Object.freeze({
      excludedUsers: buildExcludedUsers(env, vars.TWITCH_USERNAME, vars.TWITCH_CHANNEL)
    }),
    presence: Object.freeze({
      pollIntervalMs: 45_000,            // how often to poll Helix Get Chatters
      confirmLeaveCycles: 2,             // consecutive absent polls before a goodbye
      recentMessageHoldMs: 5 * 60 * 1000, // don't goodbye someone who chatted this recently
      greetCooldownMs: 30 * 60 * 1000     // minimum gap before re-greeting a returning viewer
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
    resources: Object.freeze(resources),
    paths: Object.freeze({
      root: ROOT, resources: RESOURCES_DIR,
      data: path.join(ROOT, 'data'), db: path.join(ROOT, 'data', 'tuichi.db')
    })
  });
}
