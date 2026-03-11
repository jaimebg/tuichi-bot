import { log } from '../logger.js';
import { clampResponseLength } from '../utils/text.js';
import { extractJson } from '../utils/json.js';

export class TriviaManager {
    constructor(groqConfig) {
        this.groqConfig = groqConfig;
        this.activeTrivia = null;
        this.triviaTimer = null;
    }

    /**
     * Start a trivia question
     * @param {string} category - Category for the question (e.g., "Pentesilea", "Gaming", "General")
     * @param {number} durationMs - How long to answer (default 30 seconds)
     * @param {Function} fetchGroqResponse - Function to call Groq API
     * @returns {Promise<object|null>} - Trivia state or null if failed
     */
    async startTrivia(category = 'general', durationMs = 30000, fetchGroqResponse) {
        if (this.activeTrivia) {
            return null; // Trivia already active
        }

        const prompt = `Genera UNA pregunta de trivia en español sobre la categoría: "${category}".

REQUISITOS:
- Pregunta clara y emocionante
- 4 opciones múltiples (a, b, c, d)
- Una respuesta correcta evidente
- Nivel de dificultad: medio
- Tema relacionado con Twitch, gaming, Pentesilea, o culture general según la categoría

Responde en JSON: 
{
  "question": "La pregunta exacta",
  "options": {
    "a": "Opción A",
    "b": "Opción B", 
    "c": "Opción C",
    "d": "Opción D"
  },
  "correct": "a",
  "explanation": "Breve explicación de la respuesta correcta"
}`;

        const chatMessages = [
            {
                role: "system",
                content: `Eres un creador de preguntas de trivia entretenidas y bien equilibradas.
Categoría: ${category}.
Responde SOLO con JSON válido, sin explicaciones adicionales.`
            },
            { role: "user", content: prompt }
        ];

        try {
            const aiReply = await fetchGroqResponse(chatMessages);
            const finalMessage = clampResponseLength(aiReply, 1000);

            let triviaData = null;
            try {
                triviaData = extractJson(finalMessage);
            } catch (e) {
                log("warn", "Failed to parse trivia JSON");
                return null;
            }
            if (!triviaData) {
                log("warn", "Failed to parse trivia JSON");
                return null;
            }

            if (!triviaData.question || !triviaData.options || !triviaData.correct) {
                return null;
            }

            this.activeTrivia = {
                question: triviaData.question,
                options: triviaData.options,
                correct: triviaData.correct.toLowerCase(),
                explanation: triviaData.explanation || "Respuesta correcta",
                category,
                answers: new Map(),
                answerers: new Set(),
                startTime: Date.now(),
                endTime: Date.now() + durationMs,
                durationMs
            };

            log("debug", `Trivia started: "${triviaData.question}"`);

            return {
                question: this.activeTrivia.question,
                options: this.activeTrivia.options,
                durationSeconds: Math.ceil(durationMs / 1000),
                category
            };
        } catch (err) {
            log("warn", `Failed to start trivia: ${err.message}`);
            return null;
        }
    }

    /**
     * Record an answer from a user
     * @param {string} userKey - The user answering
     * @param {string} answer - The answer (a, b, c, or d)
     * @returns {object|null} - {isCorrect, wasNew} or null if invalid
     */
    recordAnswer(userKey, answer) {
        if (!this.activeTrivia) {
            return null;
        }

        const normalizedAnswer = answer.toLowerCase().trim();
        if (!['a', 'b', 'c', 'd'].includes(normalizedAnswer)) {
            return null;
        }

        if (this.activeTrivia.answerers.has(userKey)) {
            return null; // User already answered
        }

        this.activeTrivia.answerers.add(userKey);
        this.activeTrivia.answers.set(userKey, normalizedAnswer);

        const isCorrect = normalizedAnswer === this.activeTrivia.correct;

        log("debug", `Trivia answer from ${userKey}: ${normalizedAnswer} (${isCorrect ? 'correct' : 'wrong'})`);

        return { isCorrect, wasNew: true };
    }

    /**
     * Check if trivia is currently active
     */
    isActive() {
        return this.activeTrivia !== null;
    }

    /**
     * Get trivia status
     */
    getTriviaStatus() {
        if (!this.activeTrivia) {
            return null;
        }

        const remaining = Math.max(0, this.activeTrivia.endTime - Date.now());

        return {
            question: this.activeTrivia.question,
            options: this.activeTrivia.options,
            answered: this.activeTrivia.answerers.size,
            remainingMs: remaining,
            remainingSeconds: Math.ceil(remaining / 1000)
        };
    }

    /**
     * End trivia and get results
     */
    endTrivia() {
        if (!this.activeTrivia) {
            return null;
        }

        const results = {
            question: this.activeTrivia.question,
            correct: this.activeTrivia.correct,
            explanation: this.activeTrivia.explanation,
            totalAnswered: this.activeTrivia.answerers.size,
            correctAnswers: [],
            wrongAnswers: [],
            correctCount: 0,
            wrongCount: 0
        };

        // Separate correct and wrong answers
        for (const [userKey, answer] of this.activeTrivia.answers) {
            if (answer === this.activeTrivia.correct) {
                results.correctAnswers.push(userKey);
                results.correctCount++;
            } else {
                results.wrongAnswers.push(userKey);
                results.wrongCount++;
            }
        }

        this.activeTrivia = null;
        if (this.triviaTimer) {
            clearTimeout(this.triviaTimer);
            this.triviaTimer = null;
        }

        log("debug", `Trivia ended: ${results.correctCount} correct, ${results.wrongCount} wrong`);

        return results;
    }

    /**
     * Cancel active trivia
     */
    cancelTrivia() {
        if (this.triviaTimer) {
            clearTimeout(this.triviaTimer);
            this.triviaTimer = null;
        }
        this.activeTrivia = null;
        log("debug", "Trivia cancelled");
    }

    /**
     * Schedule auto-end of trivia
     * @param {Function} callback - Called when trivia ends
     */
    scheduleAutoEnd(callback) {
        if (!this.activeTrivia) {
            return;
        }

        if (this.triviaTimer) {
            clearTimeout(this.triviaTimer);
        }

        this.triviaTimer = setTimeout(() => {
            const results = this.endTrivia();
            if (callback) {
                callback(results);
            }
        }, this.activeTrivia.durationMs);
    }
}

