/**
 * Formato de datetime() de SQLite: "YYYY-MM-DD HH:MM:SS" (UTC, sin marcador de zona),
 * con segundos fraccionarios opcionales como los que produce strftime('%Y-%m-%d %H:%M:%f', ...).
 */
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * Convierte un timestamp leído de SQLite a epoch en ms.
 *
 * SQLite `datetime('now')` devuelve UTC sin marcador de zona, y `new Date(str)` interpretaría
 * ese formato como hora local. Esta función fuerza la lectura como UTC.
 *
 * @param {string|number|null|undefined} value
 * @returns {number|null} epoch en ms, o null si no es parseable.
 */
export function parseSqliteUtc(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  // Epoch en forma de cadena numérica.
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  // Formato de SQLite: añadir la 'Z' que le falta para que se lea como UTC.
  const normalized = SQLITE_DATETIME.test(trimmed) ? `${trimmed.replace(' ', 'T')}Z` : trimmed;

  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}
