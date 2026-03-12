import { log } from '../logger.js';
import { normalizeWhitespace, stripAccents } from '../utils/text.js';

export class AiController {
  constructor({ groqConfig, persona, lore, aiConfig, aliases }) {
    this.groqConfig = groqConfig;
    this.persona = persona;
    this.lore = lore || '';
    this.aliases = aliases || {};
    this.maxChars = aiConfig.maxChars;
    this.historyLimit = aiConfig.historyLimit;
    this.userCooldownMs = aiConfig.userCooldownMs;
    this.globalCooldownMs = aiConfig.globalCooldownMs;
    this.pendingRequests = new Set();
    this.userLastResponseAt = new Map();
    this.lastGlobalResponseAt = 0;
    this.metrics = null;
    this._circuit = {
      state: 'CLOSED',
      failures: 0,
      failureThreshold: 3,
      cooldownMs: 60_000,
      maxCooldownMs: 300_000,
      backoffMultiplier: 2,
      openUntil: 0
    };
  }

  setMetrics(metrics) { this.metrics = metrics; }

  canSendAIResponse(userKey) {
    const now = Date.now();
    if (this.globalCooldownMs > 0 && now - this.lastGlobalResponseAt < this.globalCooldownMs) return false;
    const last = this.userLastResponseAt.get(userKey);
    if (this.userCooldownMs > 0 && last && now - last < this.userCooldownMs) return false;
    return true;
  }

  _recordResponse(userKey) {
    const now = Date.now();
    this.userLastResponseAt.set(userKey, now);
    this.lastGlobalResponseAt = now;
  }

  _getAlias(userKey, displayName) {
    return this.aliases[userKey] || displayName;
  }

  getCircuitState() { return this._circuit.state; }

  _circuitSuccess() {
    this._circuit.state = 'CLOSED';
    this._circuit.failures = 0;
    this._circuit.cooldownMs = 60_000;
  }

  _circuitFailure() {
    this._circuit.failures++;
    if (this._circuit.state === 'HALF_OPEN' || this._circuit.failures >= this._circuit.failureThreshold) {
      this._circuit.state = 'OPEN';
      this._circuit.openUntil = Date.now() + this._circuit.cooldownMs;
      this.metrics?.increment('circuitOpens');
      log('warn', `Circuit breaker OPEN — Groq unavailable. Retry in ${this._circuit.cooldownMs / 1000}s`);
    }
  }

  /**
   * Build the messages array for Groq API.
   * @param {object} context - { userKey, displayName, message, mentionContext, threadHistory, recentChat, userSummary, userProfile, streamContext }
   * @returns {Array<{role: string, content: string}>}
   */
  buildChatMessages(context) {
    const alias = this._getAlias(context.userKey, context.displayName);
    const limitsLine = `Responde en no mas de ${this.maxChars} caracteres.`;
    const contextParts = [];

    if (context.streamContext) contextParts.push(context.streamContext);
    if (context.recentChat) contextParts.push(`Mensajes recientes en el chat: ${context.recentChat}`);

    // User memory context
    if (context.userSummary) {
      const s = context.userSummary;
      const parts = [];
      if (s.messageCount > 0) parts.push(`${s.messageCount} mensajes`);
      if (s.personality?.length) parts.push(`personalidad: ${s.personality.join(', ')}`);
      if (s.themes?.length) parts.push(`temas de interes: ${s.themes.join(', ')}`);
      if (s.topWords?.length) parts.push(`palabras comunes: ${s.topWords.join(', ')}`);
      if (s.lastSeen) {
        const diffMs = Date.now() - s.lastSeen;
        const relative = diffMs < 60000 ? 'menos de un minuto'
          : diffMs < 3600000 ? `${Math.floor(diffMs / 60000)} minutos`
          : diffMs < 86400000 ? `${Math.floor(diffMs / 3600000)} horas`
          : `${Math.floor(diffMs / 86400000)} días`;
        parts.push(`último mensaje hace ${relative}`);
      }
      if (parts.length) contextParts.push(`Sobre ${alias}: ${parts.join('; ')}.`);
      // Recent message samples
      if (Array.isArray(s.recentMessages) && s.recentMessages.length) {
        const samples = s.recentMessages.map(e => e?.content).filter(Boolean).slice(-2)
          .map(t => t.length > 80 ? `${t.slice(0, 77)}...` : t);
        if (samples.length) contextParts.push(`Últimos mensajes de ${alias}: ${samples.join(' | ')}`);
      }
      // Frequent commands
      if (Array.isArray(s.commands) && s.commands.length) {
        const cmds = s.commands.slice(0, 3).map(c => `${c.command} (${c.count})`);
        if (cmds.length) contextParts.push(`Comandos habituales de ${alias}: ${cmds.join(', ')}.`);
      }
    }

    // User profile context
    if (context.userProfile && context.userProfile.messageCount > 0) {
      const p = context.userProfile;
      const profileParts = [];
      if (p.firstSeen) profileParts.push(`primer mensaje registrado el ${new Date(p.firstSeen).toLocaleDateString('es-ES')}`);
      if (Array.isArray(p.activeHours) && p.activeHours.length)
        profileParts.push(`horario habitual: ${p.activeHours.slice(0, 4).map(h => `${h}:00h`).join(', ')}`);
      if (p.preferences && Object.keys(p.preferences).length)
        profileParts.push(`preferencias: ${Object.entries(p.preferences).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
      if (profileParts.length) contextParts.push(`Historial de ${alias}: ${profileParts.join('; ')}.`);
    }

    if (context.threadHistory) contextParts.push(`Conversación reciente: ${context.threadHistory}`);

    const contextText = contextParts.length ? `\n\nContexto: ${contextParts.join(' ')}` : '';
    const descriptor = context.mentionContext?.isReplyToBot
      ? 'El espectador esta respondiendo directamente a tu ultimo mensaje.'
      : 'El espectador te esta mencionando en el chat.';
    const systemContent = `${this.persona}${contextText}\n${limitsLine}`;

    // Include conversation history as separate API messages for multi-turn quality
    const history = Array.isArray(context.conversationHistory)
      ? context.conversationHistory.slice(-(this.historyLimit || 5))
      : [];

    return [
      { role: 'system', content: systemContent },
      ...history,
      { role: 'user', content: `${descriptor}\nUsuario ${alias} dice: ${context.message}` }
    ];
  }

  /** Call Groq API with model fallback. */
  async fetchGroqResponse(messages) {
    if (!this.groqConfig) return '';

    // Circuit breaker check
    if (this._circuit.state === 'OPEN') {
      if (Date.now() < this._circuit.openUntil) return null;
      this._circuit.state = 'HALF_OPEN';
      log('info', 'Circuit breaker HALF_OPEN — testing Groq');
    }

    this.metrics?.increment('aiRequests');
    const startTime = Date.now();
    const { baseUrl, apiKey, models, temperature, timeoutMs, maxTokens } = this.groqConfig;
    const modelList = Array.isArray(models) && models.length ? models : ['llama-3.3-70b-versatile'];
    const errors = [];

    for (const model of modelList) {
      try {
        log('debug', `Calling Groq model ${model}`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
          signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw Object.assign(new Error(`Groq API ${response.status}`), { detail });
        }

        const payload = await response.json();
        const text = normalizeWhitespace(payload?.choices?.[0]?.message?.content || '');
        if (!text) throw new Error('Groq returned empty response');
        if (model !== modelList[0]) {
          log('info', `Fallback model ${model} succeeded.`);
          this.metrics?.increment('modelFallbacks');
        }
        this.metrics?.recordAiLatency(Date.now() - startTime);
        this._circuitSuccess();
        return text;
      } catch (err) {
        errors.push({ model, err });
        this.metrics?.increment('aiErrors');
        log('warn', `Groq model ${model} failed: ${err.message}`);
      }
    }
    this._circuitFailure();
    if (this._circuit.state === 'OPEN') {
      this._circuit.cooldownMs = Math.min(
        this._circuit.cooldownMs * this._circuit.backoffMultiplier,
        this._circuit.maxCooldownMs
      );
      return null;
    }
    throw new Error(`All Groq models failed: ${errors.map(e => `${e.model}: ${e.err.message}`).join('; ')}`);
  }

  /** Generate game content (used by gameController via callback injection). */
  async generateGameContent(messages) {
    return this.fetchGroqResponse(messages);
  }

  /** Extract personality traits and themes from message. */
  extractIntelligence(userMemory, userKey, message) {
    const lower = stripAccents(message.toLowerCase());

    const traits = [
      [['jaja', 'xdd', 'xd', 'lmao', 'jsjsj', 'jiji'], 'graciosa'],
      [['gracias', 'ty', 'grax', 'thx'], 'agradecida'],
      [['illo', 'bro', 'tia', 'mana', 'tio', 'macho', 'colega', 'crack', 'chaval', 'chavala'], 'colegui'],
      [['guapo', 'guapa', 'cari', 'amor', 'bb', 'bonita', 'cielo', 'reina'], 'flirty'],
      [['cabrona', 'perra', 'zorra', 'mamonazo', 'imbecil'], 'borde_cariñosa'],
      [['hostia', 'joder', 'mierda', 'cono', 'puta'], 'malhablada']
    ];

    for (const [keywords, trait] of traits) {
      if (keywords.some(k => lower.includes(k)))
        userMemory.addPersonalityTrait(userKey, trait);
    }

    if (lower.includes('!') && message.length < 15 && /[a-z]/.test(lower))
      userMemory.addPersonalityTrait(userKey, 'intensa');

    const interrogatives = ['que ', 'como ', 'por que ', 'donde ', 'cuando ', 'cual ', 'quien '];
    if (interrogatives.some(q => lower.startsWith(q)))
      userMemory.addPersonalityTrait(userKey, 'curiosa');

    const themes = [
      [['juego', 'jugar', 'partida', 'boss', 'nivel', 'ganar', 'perder', 'stream'], 'gaming'],
      [['codigo', 'programar', 'bug', 'feature', 'api', 'github', 'code'], 'tecnologia'],
      [['cancion', 'musica', 'playlist', 'tema', 'artista', 'cantar'], 'musica'],
      [['curro', 'trabajo', 'jefe', 'oficina', 'turno', 'reunion'], 'curro'],
      [['comer', 'cena', 'cocinar', 'hambre', 'receta', 'comida'], 'comida'],
      [['gym', 'entreno', 'correr', 'pesas', 'deporte'], 'deporte'],
      [['pedo', 'resaca', 'birra', 'copa', 'fiesta', 'botellon', 'salir', 'plan', 'ligar'], 'puterio'],
      [['serie', 'peli', 'pelicula', 'netflix', 'capitulo', 'temporada'], 'series'],
      [['drama', 'cotilleo', 'lio', 'lia', 'follon', 'polemico'], 'cotilleo']
    ];

    for (const [keywords, theme] of themes) {
      if (keywords.some(k => lower.includes(k)))
        userMemory.addConversationTheme(userKey, theme);
    }
  }
}
