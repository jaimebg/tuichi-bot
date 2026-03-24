import { log } from '../logger.js';
import { clampResponseLength } from '../utils/text.js';
import { extractJson } from '../utils/json.js';

export class TriviaManager {
    constructor(groqConfig) {
        this.groqConfig = groqConfig;
        this.activeTrivia = null;
        this.triviaTimer = null;
        this.recentQuestions = []; // Track recent questions to avoid repeats
        this.maxRecentQuestions = 30;
    }

    /**
     * Start a trivia question
     * @param {string} category - Category for the question (e.g., "Pentesilea", "Gaming", "General")
     * @param {number} durationMs - How long to answer (default 30 seconds)
     * @param {Function} fetchGroqResponse - Function to call Groq API
     * @returns {Promise<object|null>} - Trivia state or null if failed
     */
    async startTrivia(category = 'general', durationMs = 30000, fetchGroqResponse, customTopic = null) {
        if (this.activeTrivia) {
            return null; // Trivia already active
        }

        let subtopic;
        if (customTopic) {
            subtopic = customTopic;
        } else {
            const subtopics = [
                'historia antigua', 'ciencia y tecnología', 'videojuegos clásicos', 'anime y manga',
                'música pop', 'cine y series', 'deportes', 'mitología', 'geografía', 'gastronomía',
                'literatura', 'arte', 'astronomía', 'biología', 'matemáticas curiosas', 'récords mundiales',
                'cultura pop de los 90', 'inventos históricos', 'animales raros', 'idiomas del mundo'
            ];
            subtopic = subtopics[Math.floor(Math.random() * subtopics.length)];
        }
        // Build list of recent questions for this topic to avoid repeats
        const recentForTopic = this.recentQuestions
            .filter(q => q.subtopic.toLowerCase() === subtopic.toLowerCase())
            .map(q => q.question);
        const allRecent = this.recentQuestions.map(q => q.question);

        // Pick a random angle to approach the topic from
        const angles = [
            'un dato histórico poco conocido', 'una curiosidad científica', 'un récord o estadística',
            'un origen etimológico o cultural', 'una conexión inesperada con otro tema',
            'un error común o mito popular', 'una persona poco conocida relacionada',
            'un evento reciente o moderno', 'un aspecto técnico o de detalle',
            'una anécdota divertida o absurda', 'algo que casi nadie sabe',
            'una pregunta trampa con opciones engañosas', 'un dato geográfico o regional'
        ];
        const angle = angles[Math.floor(Math.random() * angles.length)];

        let avoidSection = '';
        if (recentForTopic.length > 0) {
            avoidSection = `\n\nPREGUNTAS YA HECHAS SOBRE ESTE TEMA (NO las repitas ni hagas variaciones de estas):\n${recentForTopic.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
        } else if (allRecent.length > 0) {
            const sample = allRecent.slice(-10);
            avoidSection = `\n\nPREGUNTAS RECIENTES (evita temas similares):\n${sample.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
        }

        const prompt = `Genera UNA pregunta de trivia ORIGINAL en español.
Categoría: "${category}". Subtema sugerido: "${subtopic}".
Enfoque: ${angle}.

REQUISITOS:
- Pregunta sorprendente, poco común y específica (no la primera que se te ocurra)
- 4 opciones múltiples (a, b, c, d) plausibles pero con una sola correcta
- Nivel de dificultad: medio-alto
- NO uses preguntas genéricas ni las más famosas del tema
- Sé CREATIVO: busca un ángulo inesperado o un dato oscuro${avoidSection}

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
                content: `Eres un creador de preguntas de trivia entretenidas, creativas y variadas. NUNCA repitas una pregunta.
Categoría: ${category}. Subtema: ${subtopic}. Enfoque: ${angle}.
Cada pregunta debe ser diferente, inesperada y desde un ángulo único. Responde SOLO con JSON válido, sin explicaciones adicionales.`
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

            // Track this question to avoid repeats
            this.recentQuestions.push({ subtopic, question: triviaData.question });
            if (this.recentQuestions.length > this.maxRecentQuestions) {
                this.recentQuestions.shift();
            }

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

