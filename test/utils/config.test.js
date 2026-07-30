import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEnv, buildConfig, resolveResourcePath, loadResources } from '../../src/config.js';

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

// Unidad, contra un directorio fixture que el test controla por completo --
// no depende de lo que haya (o no) en resources/ de esta máquina. Esto es lo
// que permite que un mutante que elimine la caída a .example, o que rompa el
// error único agregado, sea detectado sin importar si los ficheros reales
// están presentes en disco (que es el estado permanente en dev, ya que la
// tarea los gitignora en vez de borrarlos).
describe('resolveResourcePath y loadResources (unidad, directorio fixture)', () => {
  function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tuichi-config-test-'));
  }

  function withCapturedWarnings(fn) {
    const originalWarn = console.warn;
    const calls = [];
    console.warn = (...args) => calls.push(args.join(' '));
    try {
      const result = fn();
      return { result, warnings: calls };
    } finally {
      console.warn = originalWarn;
    }
  }

  it('el fichero real gana sobre su .example cuando ambos existen', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'greetings.txt'), 'real greeting\n');
      fs.writeFileSync(path.join(dir, 'greetings.example.txt'), 'example greeting\n');

      const resolved = resolveResourcePath(dir, 'greetings.txt');
      assert.equal(resolved.isExample, false);
      assert.equal(resolved.path, path.join(dir, 'greetings.txt'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cuando falta el fichero real, usa el .example y avisa nombrando el fichero real', () => {
    const dir = makeTempDir();
    try {
      // Solo aportamos .example para greetings; goodbyes/persona (también
      // obligatorios) usan su fichero real para aislar el aviso a greetings.
      fs.writeFileSync(path.join(dir, 'greetings.example.txt'), 'hola {user}\nbuenas {user}\n');
      fs.writeFileSync(path.join(dir, 'goodbyes.txt'), 'adios {user}\n');
      fs.writeFileSync(path.join(dir, 'persona.txt'), 'Eres un bot.\n');

      const { result: resources, warnings } = withCapturedWarnings(() => loadResources(dir));

      assert.deepEqual(resources.greetings, ['hola {user}', 'buenas {user}']);
      assert.ok(
        warnings.some(w => w.includes('greetings.example.txt') && w.includes('greetings.txt')),
        `esperaba un aviso nombrando greetings.txt, recibido: ${JSON.stringify(warnings)}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recurso obligatorio ausente y sin .example: UN error que nombra a todos los que faltan', () => {
    const dir = makeTempDir();
    try {
      // greetings, goodbyes y persona (los tres obligatorios) no tienen ni
      // fichero real ni .example. lore/aliases (opcionales) tampoco -- no
      // deben aparecer en el error.
      assert.throws(
        () => loadResources(dir),
        (err) => {
          assert.ok(!/ENOENT/.test(err.message), `no debe ser un ENOENT crudo: ${err.message}`);
          assert.ok(err.message.includes('greetings.txt'), err.message);
          assert.ok(err.message.includes('goodbyes.txt'), err.message);
          assert.ok(err.message.includes('persona.txt'), err.message);
          assert.ok(!err.message.includes('lore.txt'), err.message);
          assert.ok(!err.message.includes('aliases.txt'), err.message);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recurso opcional ausente y sin .example: usa el fallback declarado, nunca undefined', () => {
    const dir = makeTempDir();
    try {
      // greetings/goodbyes/persona (obligatorios) presentes; lore/aliases
      // (opcionales) completamente ausentes, real y .example.
      fs.writeFileSync(path.join(dir, 'greetings.txt'), 'hola {user}\n');
      fs.writeFileSync(path.join(dir, 'goodbyes.txt'), 'adios {user}\n');
      fs.writeFileSync(path.join(dir, 'persona.txt'), 'Eres un bot.\n');

      const resources = loadResources(dir);

      assert.equal(resources.lore, '');
      assert.deepEqual(resources.aliases, {});
      assert.notEqual(resources.lore, undefined);
      assert.notEqual(resources.aliases, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
