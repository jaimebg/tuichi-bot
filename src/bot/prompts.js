/**
 * Prompts de sistema del bot, parametrizados por canal y persona.
 *
 * El texto está en castellano de forma deliberada: la persona del bot (resources/persona.txt)
 * lo está, y mezclar idiomas degrada la calidad de las respuestas. Para adaptar el bot a otro
 * idioma, traducir este módulo y el fichero de persona; no hay capa de i18n.
 */

export function spontaneousReplySystemPrompt({ persona, channel, contextText = '', maxChars }) {
  return `${persona}\n\nEstás en el chat del canal ${channel}. A veces te metes en la conversación de forma espontánea, con humor y naturalidad, como si fueras un espectador más. No menciones que eres un bot ni que estás respondiendo aleatoriamente. Sé breve y natural.${contextText}\nResponde en no mas de ${maxChars} caracteres.`;
}

export function streamStartFallback({ channelDisplayName, title, game }) {
  return `${channelDisplayName} está ahora en directo ${title} ${game}`;
}

export function streamStartSystemPrompt({ persona, channel }) {
  return `${persona}\n\nEstás en el chat del canal ${channel}. Acaba de empezar el directo. Anuncia que el canal está en directo con tu tono habitual, mencionando el título y la categoría.`;
}

export function categoryChangeSystemPrompt({ persona, channel }) {
  return `${persona}\n\nEstás en el chat del canal ${channel}. El directo acaba de cambiar de categoría. Comenta el cambio con tu tono habitual.`;
}

export function shameSystemPrompt({ persona, channel }) {
  return `Eres un bot de Twitch en el canal ${channel} que es profundamente dramático y sarcástico cuando los usuarios se ignoran. Personalidad: ${persona}`;
}
