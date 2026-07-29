import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSqliteUtc } from '../../src/utils/time.js';

describe('parseSqliteUtc', () => {
  it('interpreta el formato datetime() de SQLite como UTC, no como hora local', () => {
    // Aserción independiente de la zona horaria del runner: Date.UTC() no depende del TZ local.
    assert.equal(
      parseSqliteUtc('2026-07-29 21:02:45'),
      Date.UTC(2026, 6, 29, 21, 2, 45)
    );
  });

  it('acepta ISO-8601 con Z', () => {
    assert.equal(
      parseSqliteUtc('2026-07-29T21:02:45.000Z'),
      Date.UTC(2026, 6, 29, 21, 2, 45)
    );
  });

  it('acepta ISO-8601 con milisegundos del formato strftime', () => {
    assert.equal(
      parseSqliteUtc('2026-07-29T21:02:45.123Z'),
      Date.UTC(2026, 6, 29, 21, 2, 45) + 123
    );
  });

  it('acepta epoch numérico y cadena numérica', () => {
    assert.equal(parseSqliteUtc(1785358965158), 1785358965158);
    assert.equal(parseSqliteUtc('1785358965158'), 1785358965158);
  });

  it('devuelve null para valores ausentes o basura, nunca NaN', () => {
    for (const v of [null, undefined, '', '   ', 'no soy una fecha', {}]) {
      assert.equal(parseSqliteUtc(v), null, `falló con ${JSON.stringify(v)}`);
    }
  });
});
