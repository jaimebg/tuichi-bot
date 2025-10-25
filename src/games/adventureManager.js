const { log } = require("../logger");
const { clampResponseLength } = require("../utils/text");

class AdventureManager {
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

        const prompt = `Inicia una aventura de rol básica con el tema: ${theme}.

Crea una situación inicial interesante. Describe el escenario y da 3 opciones de acción.
Manténlo en español, divertido, breve (no más de 500 caracteres).

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
            try {
                let jsonStr = finalMessage.trim();
                if (!jsonStr.startsWith('{')) {
                    const start = jsonStr.indexOf('{');
                    const end = jsonStr.lastIndexOf('}');
                    if (start !== -1 && end !== -1 && end > start) {
                        jsonStr = jsonStr.substring(start, end + 1);
                    }
                }
                const data = JSON.parse(jsonStr);
                story = data.story || '';
                options = Array.isArray(data.options) ? data.options.filter(o => o && o.trim()) : [];
            } catch (e) {
                log("warn", "Failed to parse adventure JSON, using fallback");
                story = finalMessage.substring(0, 250);
                options = ["Avanzar", "Investigar", "Huir"];
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
                previousChoices: []
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

        // Max 4 rounds before ending
        if (this.activeAdventure.round > 4) {
            return await this.endAdventure(chosenOption, 'end', fetchGroqResponse);
        }

        // Continue adventure
        const prompt = `Continúa la aventura de rol.
Historia: ${this.activeAdventure.story}
Elecciones previas: ${this.activeAdventure.previousChoices.join(' → ')}
Acción elegida: ${chosenOption}

Continúa la historia de forma divertida e interesante. Describe las consecuencias de la acción.
Presenta 3 nuevas opciones de acción.

Breve (400 caracteres máx), en español.
JSON: {"story": "Continuación", "options": ["Opción 1", "Opción 2", "Opción 3"]}`;

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
            try {
                let jsonStr = finalMessage.trim();
                if (!jsonStr.startsWith('{')) {
                    const start = jsonStr.indexOf('{');
                    const end = jsonStr.lastIndexOf('}');
                    if (start !== -1 && end !== -1 && end > start) {
                        jsonStr = jsonStr.substring(start, end + 1);
                    }
                }
                const data = JSON.parse(jsonStr);
                newStory = data.story || '';
                newOptions = Array.isArray(data.options) ? data.options.filter(o => o && o.trim()) : [];
            } catch (e) {
                newStory = finalMessage;
                newOptions = ["Continuar", "Retroceder", "Escapar"];
            }

            if (!newStory || newOptions.length < 2) {
                return null;
            }

            this.activeAdventure.story = newStory;
            this.activeAdventure.options = newOptions.slice(0, 4);
            this.activeAdventure.votes = new Map();
            this.activeAdventure.voters = new Set();

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

        const prompt = `Conclusión de aventura de rol.
Historia: ${this.activeAdventure.story}
Última acción: ${lastChoice}

Describe el FINAL de forma divertida y memorable (victoria, escape, giro inesperado, etc.).
Breve epílogo (250 caracteres máx), en español, sarcástico.
JSON: {"ending": "Epílogo"}`;

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
            const finalMessage = clampResponseLength(aiReply, 400);

            let ending = finalMessage;
            try {
                let jsonStr = finalMessage.trim();
                if (!jsonStr.startsWith('{')) {
                    const start = jsonStr.indexOf('{');
                    const end = jsonStr.lastIndexOf('}');
                    if (start !== -1 && end !== -1 && end > start) {
                        jsonStr = jsonStr.substring(start, end + 1);
                    }
                }
                const data = JSON.parse(jsonStr);
                ending = data.ending || finalMessage;
            } catch (e) {
                // Use finalMessage as-is
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
            theme: this.activeAdventure.theme
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

module.exports = AdventureManager;
