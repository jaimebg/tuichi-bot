/**
 * Prompts de sistema del bot, parametrizados por canal y persona.
 *
 * El texto está en castellano de forma deliberada: la persona del bot (resources/persona.txt)
 * lo está, y mezclar idiomas degrada la calidad de las respuestas. Para adaptar el bot a otro
 * idioma, traducir este módulo y el fichero de persona; no hay capa de i18n.
 *
 * Solo viven aquí los prompts que tenían el canal hardcodeado en bot.js. Los system prompts
 * de inicio de directo y cambio de categoría ("Eres un creador de contenido de Twitch
 * entusiasta...") nunca mencionaron el canal, así que se quedan inline en bot.js; no los
 * "completes" aquí sin comprobar antes que hay un sitio real que los use.
 */

export function spontaneousReplySystemPrompt({ persona, channel, contextText = '', maxChars }) {
  return `${persona}\n\nEstás en el chat del canal ${channel}. A veces te metes en la conversación de forma espontánea, con humor y naturalidad, como si fueras un espectador más. No menciones que eres un bot ni que estás respondiendo aleatoriamente. Sé breve y natural.${contextText}\nResponde en no mas de ${maxChars} caracteres.`;
}

export function streamStartFallback({ channelDisplayName, title, game }) {
  return `${channelDisplayName} está ahora en directo ${title} ${game}`;
}

export function shameSystemPrompt({ persona, channel }) {
  return `Eres un bot de Twitch en el canal ${channel} que es profundamente dramático y sarcástico cuando los usuarios se ignoran. Personalidad: ${persona}`;
}
