import { log } from '../logger.js';
import { clampResponseLength } from '../utils/text.js';
import { extractJson } from '../utils/json.js';

export class AdventureManager {
    constructor(groqConfig, lore = '') {
        this.groqConfig = groqConfig;
        this.lore = lore;
        this.activeAdventure = null;
        this.votingTimer = null;
    }

    /**
     * Start a new adventure
     * @param {string} theme - The adventure theme
     * @param {object} fetchGroqResponse - Function to call Groq API
     * @returns {Promise<object>} - The initial adventure state
     */
    async startAdventure(theme, fetchGroqResponse) {
        if (this.activeAdventure) {
            return null; // Adventure already active
        }

        const prompt = `Inicia una aventura de rol con el tema: ${theme}.

Cuenta la escena inicial en 2-3 frases que presenten el conflicto, el tono y algún detalle sensorial o gracioso.
La narrativa debe avanzar (no solo presentar opciones) y dejar claro por qué la situación importa.
Después de la narración, plantea exactamente 3 opciones de acción distintas con verbos y una pista de su consecuencia.
Máximo 600 caracteres en total, en español con humor sarcástico ligero.

Responde en JSON: {"story": "Situación inicial", "options": ["Opción 1", "Opción 2", "Opción 3"]}`;

        const chatMessages = [
            {
                role: "system",
                content: `Eres un narrador de aventuras de rol interactivo. Creas historias divertidas y sarcásticas.
Tema: ${theme}.
Genera narrativa original y emocionante.

LORE DEL MUNDO:
${this.lore}`
            },
            { role: "user", content: prompt }
        ];

        try {
            const aiReply = await fetchGroqResponse(chatMessages);
            const finalMessage = clampResponseLength(aiReply, 600);

            let story = '';
            let options = [];
            let data = null;
            try {
                data = extractJson(finalMessage);
            } catch {
                // fallback
            }
            if (!data) {
                story = finalMessage.substring(0, 250);
                options = ["Avanzar", "Investigar", "Huir"];
            } else {
                story = data.story || '';
                options = Array.isArray(data.options) ? data.options.filter(o => o && o.trim()) : [];
            }

            if (!story || options.length < 2) {
                return null;
            }

            this.activeAdventure = {
                theme,
                story,
                options: options.slice(0, 4),
                round: 1,
                votes: new Map(),
                voters: new Set(),
                previousChoices: [],
                storySegments: story ? [story] : []
            };

            // Initialize vote counts
            for (let i = 0; i < this.activeAdventure.options.length; i++) {
                this.activeAdventure.votes.set(i + 1, 0);
            }

            log("debug", `Adventure started: "${theme}"`);

            return {
                story: this.activeAdventure.story,
                options: this.activeAdventure.options,
                round: this.activeAdventure.round
            };
        } catch (err) {
            log("warn", `Failed to start adventure: ${err.message}`);
            return null;
        }
    }

    /**
     * Record a vote for an option
     */
    recordVote(userKey, optionIndex) {
        if (!this.activeAdventure) {
            return false;
        }

        const numericIndex = parseInt(optionIndex, 10);
        if (isNaN(numericIndex) || numericIndex < 1 || numericIndex > this.activeAdventure.options.length) {
            return false;
        }

        if (this.activeAdventure.voters.has(userKey)) {
            return false; // User already voted this round
        }

        this.activeAdventure.voters.add(userKey);
        this.activeAdventure.votes.set(numericIndex, (this.activeAdventure.votes.get(numericIndex) || 0) + 1);

        return true;
    }

    /**
     * Get the winning option
     */
    getWinningOption() {
        if (!this.activeAdventure) {
            return null;
        }

        let maxVotes = 0;
        let winner = 1;

        for (let i = 1; i <= this.activeAdventure.options.length; i++) {
            const votes = this.activeAdventure.votes.get(i) || 0;
            if (votes > maxVotes) {
                maxVotes = votes;
                winner = i;
            }
        }

        return {
            option: winner,
            text: this.activeAdventure.options[winner - 1],
            votes: this.activeAdventure.votes.get(winner) || 0
        };
    }

    /**
     * Continue adventure based on chosen option
     */
    async continueAdventure(chosenOption, fetchGroqResponse) {
        if (!this.activeAdventure) {
            return null;
        }

        this.activeAdventure.previousChoices.push(chosenOption);
        this.activeAdventure.round++;

        if (!Array.isArray(this.activeAdventure.storySegments) || !this.activeAdventure.storySegments.length) {
            this.activeAdventure.storySegments = this.activeAdventure.story ? [this.activeAdventure.story] : [];
        }

        // Max 4 rounds before ending
        if (this.activeAdventure.round > 4) {
            return await this.endAdventure(chosenOption, 'end', fetchGroqResponse);
        }

        // Continue adventure
        const contextWindow = this.activeAdventure.storySegments.slice(-3).join(' ') || "La aventura acaba de comenzar.";
        const choicesSummary = this.activeAdventure.previousChoices.length
            ? this.activeAdventure.previousChoices.map((choice, index) => `${index + 1}. ${choice}`).join(' | ')
            : "Aún no se han tomado decisiones.";

        const prompt = `Continúa la aventura de rol.
Contexto reciente: ${contextWindow}
Elecciones acumuladas: ${choicesSummary}
Acción actual de la comunidad: ${chosenOption}

Escribe 2-3 frases en español que narren claramente la consecuencia inmediata, cómo cambia la situación y añade un giro o problema fresco con humor sarcástico ligero. Debe sentirse como un paso narrativo real, no un resumen.
Cierra con exactamente 3 nuevas opciones distintas, cada una con verbo y una pista de lo que provocará.
Máximo 550 caracteres en total.

Responde en JSON: {"story": "Continuación", "options": ["Opción 1", "Opción 2", "Opción 3"]}`;

        const chatMessages = [
            {
                role: "system",
                content: `Eres un narrador de aventuras de rol. Creas historias divertidas con giros sarcásticos.
Tema: ${this.activeAdventure.theme}.

LORE DEL MUNDO:
${this.lore}`
            },
            { role: "user", content: prompt }
        ];

        try {
            const aiReply = await fetchGroqResponse(chatMessages);
            const finalMessage = clampResponseLength(aiReply, 600);

            let newStory = '';
            let newOptions = [];
            let data = null;
            try {
                data = extractJson(finalMessage);
            } catch {
                // fallback
            }
            if (!data) {
                newStory = finalMessage;
                newOptions = ["Continuar", "Retroceder", "Escapar"];
            } else {
                newStory = data.story || '';
                newOptions = Array.isArray(data.options) ? data.options.filter(o => o && o.trim()) : [];
            }

            if (!newStory || newOptions.length < 2) {
                return null;
            }

            this.activeAdventure.story = newStory;
            this.activeAdventure.options = newOptions.slice(0, 4);
            this.activeAdventure.votes = new Map();
            this.activeAdventure.voters = new Set();
            this.activeAdventure.storySegments.push(newStory);

            for (let i = 0; i < this.activeAdventure.options.length; i++) {
                this.activeAdventure.votes.set(i + 1, 0);
            }

            return {
                story: this.activeAdventure.story,
                options: this.activeAdventure.options,
                round: this.activeAdventure.round
            };
        } catch (err) {
            log("warn", `Failed to continue adventure: ${err.message}`);
            return null;
        }
    }

    /**
     * End adventure with epilogue
     */
    async endAdventure(lastChoice, reason, fetchGroqResponse) {
        if (!this.activeAdventure) {
            return null;
        }

        const storySoFar = (Array.isArray(this.activeAdventure.storySegments) && this.activeAdventure.storySegments.length)
            ? this.activeAdventure.storySegments.join(' ')
            : (this.activeAdventure.story || "La aventura fue breve pero intensa.");

        const choicesSummary = this.activeAdventure.previousChoices.length
            ? this.activeAdventure.previousChoices.map((choice, index) => `${index + 1}. ${choice}`).join(' | ')
            : "La comunidad no tomó decisiones destacables.";

        const prompt = `Conclusión de aventura de rol.
Historia completa: ${storySoFar}
Decisiones tomadas: ${choicesSummary}
Última acción destacada: ${lastChoice}

Redacta un epílogo de 3-4 frases (máx 500 caracteres), en español, que conecte las decisiones con un desenlace memorable. Incluye consecuencias claras, un toque sarcástico y una línea final que deje sensación de cierre o gancho futuro.

Responde en JSON: {"ending": "Epílogo"}`;

        const chatMessages = [
            {
                role: "system",
                content: `Eres un narrador de aventuras. Cierras la aventura de forma sarcástica y memorable.
Tema: ${this.activeAdventure.theme}.

LORE DEL MUNDO:
${this.lore}`
            },
            { role: "user", content: prompt }
        ];

        try {
            const aiReply = await fetchGroqResponse(chatMessages);
            const finalMessage = clampResponseLength(aiReply, 500);

            let ending = finalMessage;
            let data = null;
            try {
                data = extractJson(finalMessage);
            } catch {
                // fallback
            }
            if (data) {
                ending = data.ending || finalMessage;
            }

            const result = {
                ending,
                reason,
                round: this.activeAdventure.round,
                totalChoices: this.activeAdventure.previousChoices.length
            };

            this.activeAdventure = null;

            return result;
        } catch (err) {
            log("warn", `Failed to end adventure properly: ${err.message}`);
            this.activeAdventure = null;
            return { ending: "La aventura terminó abruptamente.", reason };
        }
    }

    /**
     * Check if adventure is active
     */
    isActive() {
        return this.activeAdventure !== null;
    }

    /**
     * Get adventure status
     */
    getStatus() {
        if (!this.activeAdventure) {
            return null;
        }

        return {
            round: this.activeAdventure.round,
            story: this.activeAdventure.story,
            options: this.activeAdventure.options,
            difficulty: this.activeAdventure.difficulty,
            voters: this.activeAdventure.voters.size,
            theme: this.activeAdventure.theme,
            history: Array.isArray(this.activeAdventure.storySegments) ? [...this.activeAdventure.storySegments] : []
        };
    }

    /**
     * Cancel active adventure
     */
    cancelAdventure() {
        if (this.votingTimer) {
            clearTimeout(this.votingTimer);
            this.votingTimer = null;
        }
        this.activeAdventure = null;
        log("debug", "Adventure cancelled");
    }
}

