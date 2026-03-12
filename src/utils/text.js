export function normalizeWhitespace(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

export function preserveNewlines(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function clampResponseLength(text, maxChars) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0 || normalized.length <= maxChars) return normalized;
  if (maxChars <= 3) return normalized.slice(0, maxChars);
  return normalized.slice(0, maxChars - 3).trimEnd() + '...';
}
