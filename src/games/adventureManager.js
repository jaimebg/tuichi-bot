const { log } = require("../logger");
const { clampResponseLength } = require("../utils/text");

class AdventureManager {
    constructor(groqConfig) {
        this.groqConfig = groqConfig;
        this.activeAdventure = null;
        this.votingTimer = null;
    }

    /**
     * Start a new adventure with difficulty level
     * @param {string} theme - The adventure theme
     * @param {string} difficulty - 'fácil' | 'normal' | 'difícil'
     * @param {object} fetchGroqResponse - Function to call Groq API
     * @returns {Promise<object>} - The initial adventure state
     */
    async startAdventure(theme, difficulty = 'normal', fetchGroqResponse) {
        if (this.activeAdventure) {
            return null; // Adventure already active
        }

        const difficultyConfig = this.getDifficultyConfig(difficulty);

        const prompt = `Inicia una aventura de rol real con el tema: ${theme}. 
Dificultad: ${difficulty} (Probabilidad de muerte: ${Math.round(difficultyConfig.deathChance * 100)}%).

Crea una situación inicial inmersiva y peligrosa. Describe el escenario, da 2-3 opciones de acción. 
IMPORTANTE: Esta aventura puede terminar en CUALQUIER MOMENTO si las elecciones son malas o desafortunadas. 
Los espectadores DEBEN ponerse de acuerdo en la acción más prudente.

Manténlo en español, divertido, breve (no más de 600 caracteres).
Inspírate en el lore de Pentesilea: heroínas sarcásticas lidiando con caos.

Responde en JSON: {"story": "Situación inicial", "options": ["Opción 1", "Opción 2", "Opción 3?"]}
Nota: Incluye solo opciones que existan realmente en la historia.`;

        const chatMessages = [
            {
                role: "system",
                content: `Eres un narrador de aventuras de rol reales, peligrosas e inmersivas. 
La muerte y el fracaso son posibles EN CUALQUIER MOMENTO basado en decisiones malas.
Tema: ${theme}. Dificultad: ${difficulty}.
Genera narrativa original y emocionante sin restricciones creativas.`
            },
            { role: "user", content: prompt }
        ];

        try {
            const aiReply = await fetchGroqResponse(chatMessages);
            const finalMessage = clampResponseLength(aiReply, 800);

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
                // Fallback parsing
                log("warn", "Failed to parse adventure JSON, using fallback");
                story = finalMessage.substring(0, 300);
                options = ["Avanzar cautelosamente", "Investigar primero", "Huir"];
            }

            if (!story || options.length < 2) {
                return null;
            }

            this.activeAdventure = {
                theme,
                difficulty,
                difficultyConfig,
                story,
                options: options.slice(0, 4), // Max 4 options
                round: 1,
                votes: new Map(),
                voters: new Set(),
                previousChoices: [],
                startTime: Date.now(),
                lastActionTime: Date.now(),
                isDeadly: true // All adventures are potentially deadly
            };

            // Initialize vote counts
            for (let i = 0; i < this.activeAdventure.options.length; i++) {
                this.activeAdventure.votes.set(i + 1, 0);
            }

            log("debug", `Adventure started: "${theme}" (${difficulty})`);

            return {
                story: this.activeAdventure.story,
                options: this.activeAdventure.options,
                round: this.activeAdventure.round,
                difficulty: this.activeAdventure.difficulty,
                warning: "⚠️ ADVERTENCIA: Esta aventura puede terminar EN CUALQUIER MOMENTO. ¡Poneos de acuerdo!"
            };
        } catch (err) {
            log("warn", `Failed to start adventure: ${err.message}`);
            return null;
        }
    }

    /**
     * Get difficulty configuration
     */
    getDifficultyConfig(difficulty) {
        const configs = {
            fácil: {
                deathChance: 0.15,
                continueChance: 0.85,
                maxRounds: 8,
                votingTimeMs: 45000
            },
            normal: {
                deathChance: 0.35,
                continueChance: 0.65,
                maxRounds: 5,
                votingTimeMs: 60000
            },
            difícil: {
                deathChance: 0.55,
                continueChance: 0.45,
                maxRounds: 3,
                votingTimeMs: 75000
            }
        };

        return configs[difficulty.toLowerCase()] || configs.normal;
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
     * Continue or end adventure based on choices and difficulty
     */
    async continueAdventure(chosenOption, fetchGroqResponse) {
        if (!this.activeAdventure) {
            return null;
        }

        this.activeAdventure.previousChoices.push(chosenOption);
        this.activeAdventure.round++;

        // Check if adventure should end early (death/failure)
        const shouldDie = Math.random() < this.activeAdventure.difficultyConfig.deathChance;
        const tooManyRounds = this.activeAdventure.round > this.activeAdventure.difficultyConfig.maxRounds;

        if (shouldDie || tooManyRounds) {
            return await this.endAdventure(chosenOption, shouldDie ? 'death' : 'end', fetchGroqResponse);
        }

        // Continue adventure
        const prompt = `Continúa la aventura de rol. 
Historia: ${this.activeAdventure.story}
Elecciones previas: ${this.activeAdventure.previousChoices.join(' → ')}
Acción elegida: ${chosenOption}
Dificultad: ${this.activeAdventure.difficulty}

Continúa la historia de forma dramática e inmersiva. Describe las consecuencias de la acción.
Presenta nuevas opciones (2-3) que pueden llevar al éxito o a la muerte.
IMPORTANTE: La muerte sigue siendo posible en la siguiente acción.

Breve (600 caracteres máx), en español, emocionante.
JSON: {"story": "Continuación", "options": ["Opción 1", "Opción 2", "Opción 3?"]}`;

        const chatMessages = [
            {
                role: "system",
                content: `Eres un narrador de aventuras dinámico. La historia puede terminar en muerte EN CUALQUIER MOMENTO.
Tema: ${this.activeAdventure.theme}. Dificultad: ${this.activeAdventure.difficulty}.`
            },
            { role: "user", content: prompt }
        ];

        try {
            const aiReply = await fetchGroqResponse(chatMessages);
            const finalMessage = clampResponseLength(aiReply, 800);

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
                newOptions = ["Continuar", "Retroceder", "Buscar salida"];
            }

            if (!newStory || newOptions.length < 2) {
                return null;
            }

            this.activeAdventure.story = newStory;
            this.activeAdventure.options = newOptions.slice(0, 4);
            this.activeAdventure.votes = new Map();
            this.activeAdventure.voters = new Set();
            this.activeAdventure.lastActionTime = Date.now();

            for (let i = 0; i < this.activeAdventure.options.length; i++) {
                this.activeAdventure.votes.set(i + 1, 0);
            }

            return {
                story: this.activeAdventure.story,
                options: this.activeAdventure.options,
                round: this.activeAdventure.round,
                difficulty: this.activeAdventure.difficulty,
                warning: "⚠️ Recuerda: ¡La muerte está cerca! Elegid la mejor opción."
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

        let prompt = '';
        if (reason === 'death') {
            prompt = `Conclusión FATAL de aventura de rol. 
Historia: ${this.activeAdventure.story}
Última acción: ${lastChoice}
Dificultad: ${this.activeAdventure.difficulty}

Describe la MUERTE ÉPICA y DRAMÁTICA del grupo de aventureros. Hazlo memorable, trágico pero cómico.
Breve epílogo (300 caracteres máx), en español.
JSON: {"ending": "Epilogo trágico"}`;
        } else {
            prompt = `Conclusión de aventura de rol. 
Historia: ${this.activeAdventure.story}
Última acción: ${lastChoice}
Dificultad: ${this.activeAdventure.difficulty}

Describe el FINAL (puede ser victoria, escape, derrota, o giro inesperado). 
Breve epílogo (300 caracteres máx), en español, emocionante.
JSON: {"ending": "Epílogo"}`;
        }

        const chatMessages = [
            {
                role: "system",
                content: `Eres un narrador épico. Cierra la aventura de forma dramática y memorable.
Tema: ${this.activeAdventure.theme}.`
            },
            { role: "user", content: prompt }
        ];

        try {
            const aiReply = await fetchGroqResponse(chatMessages);
            const finalMessage = clampResponseLength(aiReply, 500);

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
                totalChoices: this.activeAdventure.previousChoices.length,
                difficulty: this.activeAdventure.difficulty
            };

            this.activeAdventure = null;

            return result;
        } catch (err) {
            log("warn", `Failed to end adventure properly: ${err.message}`);
            this.activeAdventure = null;
            return { ending: "La aventura terminó abruptamente.", reason, difficulty: this.activeAdventure?.difficulty };
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
