export function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const str = text.trim();

  // Direct parse
  try { return JSON.parse(str); } catch (_) { /* continue */ }

  // Code fences
  const fence = str.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (_) { /* continue */ }
  }

  // First { ... last }
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(str.substring(start, end + 1)); } catch (_) { /* continue */ }
  }

  return null;
}
