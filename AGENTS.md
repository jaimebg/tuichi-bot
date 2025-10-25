# AI Agent Guide

## Architecture Basics
- `main.js` is the only executable entry point; it builds a `CONFIG` object, resolves the `resources/` directory, then boots `TwitchChatBot`.
- Core behaviour lives in `src/twitch/twitchChatBot.js`; this class composes helpers from:
  - `src/intelligence/` for user memory, recent chat, threaded conversations, and inactivity tracking.
  - `src/games/` for game managers (polls, adventures, trivia, survive).
  - `src/persistence/dataPersistence.js` for JSON saves under `data/`.
  - `src/media/mediaOverlayServer.js` for the SSE overlay.
  - `src/twitch/channelPointsWatcher.js` for EventSub channel point redemptions.
- Logging is centralised in `src/logger.js`; always call `setLogLevel` before instantiating the bot to keep `isDebugEnabled()` aligned.

## Documentation Policy
**⚠️ CRITICAL: NEVER CREATE NEW `.md` FILES FOR DOCUMENTATION.**

All documentation must be maintained in:
1. **`README.md`** – Primary documentation for users and developers
2. **`AGENTS.md`** – Architecture and development guidelines (this file)

### When Making Changes
1. **After adding new features:** Update `README.md` with new commands, examples, and troubleshooting steps.
2. **After architectural changes:** Update `AGENTS.md` with new patterns, modules, or workflow changes.
3. **Before committing:** Ensure `README.md` and `AGENTS.md` reflect all significant changes.

**Exception:** Temporary debugging files (e.g., test reports) can be created, but must be listed in `.gitignore` and removed before final commits.

## Static Content & Secrets
- All editable text/JSON assets (greetings, persona, lore, aliases, reward map) now live in `resources/`. Update `main.js` if you introduce new files so agents use `RESOURCES_DIR`.
- Runtime state is persisted automatically to `data/` (created on demand). Never hardcode defaults into `src/intelligence`—they expect serialised Maps/Sets via the persistence helpers.
- **Credentials are hardcoded in `main.js`** at the top of the file in `TWITCH_CREDENTIALS` and `GROQ_CREDENTIALS` objects. Before shipping or committing to a public repository:
  - Replace placeholder values (`your_oauth_token_here`, etc.) with actual credentials
  - Consider using environment variables or a secrets manager in production
  - **NEVER commit real credentials to version control** – use `.gitignore` for `.env` files and credential files
  - For production deployments, either:
    1. Load credentials from environment variables before running
    2. Use a secrets management system (e.g., Docker secrets, AWS Secrets Manager, HashiCorp Vault)
    3. Create a separate `credentials.js` file and add it to `.gitignore`

## Working Patterns

### Game Manager Architecture
Each interactive game lives in `src/games/` and follows a consistent pattern:
- **File naming**: `{gameType}Manager.js` (e.g., `pollManager.js`, `triviaManager.js`)
- **Class structure**: 
  - Private Maps/Sets for state (`this.activeGames`, `this.votes`, `this.answers`, etc.)
  - Constructor accepting `groq` (AI client) and `logger` for dependency injection
  - Public methods: `start{Game}()`, `record{Action}()`, `end{Game}()`, `cancel{Game}()`, `get{Game}Status()`
- **Integration**: Each manager is instantiated in `TwitchChatBot` constructor and wired via handler methods that route messages
- **Cleanup**: Always implement `cancel{Game}()` to clear timers and state; call during bot shutdown via `twitchChatBot.shutdown()`
- **Persistence**: Managers handle their own state; use `dataPersistence.js` helpers if you need to save game history

### Existing Game Managers (v2.1)
- **`pollManager.js`** – Multiple-choice surveys with voting limits, auto-end on timer
- **`adventureManager.js`** – Redesigned role-playing with difficulty scaling, death probabilities, dynamic rounds
- **`triviaManager.js`** – AI-generated questions with timed multi-choice answers and explanations
- **`surviveManager.js`** – Multi-round battle royale where players write `!survive` each round to avoid elimination; continues until 1 survivor or all eliminated

### Intelligence Enhancements
- **`inactivityTracker.js`** (v2.0) – Automatically generates AI-powered shame messages for inactive users; tracks per-channel inactivity thresholds and anti-spam delays
- Integrates into `TwitchChatBot.start()` and `.shutdown()`; updates on every message via `handleMessage()`

### General Feature Patterns
- When adding new bot features, extend `TwitchChatBot` methods and wire additional helpers via its constructor; avoid requiring modules directly from `main.js`.
- Always clamp or normalise outbound chat text using `src/utils/text.js` helpers—existing flows rely on `normalizeWhitespace` and `clampResponseLength`.
- Channel point integrations should register new reward mappings in `resources/mediaRewards.json`; `mediaOverlayServer` auto-loads that file at start.

### Adding New Games in Future
1. Create `src/games/{newGame}Manager.js` following the manager pattern above
2. Add to `TwitchChatBot` constructor: `this.{newGame}Manager = new {NewGame}Manager(this.groq, this.logger);`
3. Add handler method: `handle{NewGame}Command()` that calls manager methods
4. Route in `handleMessage()` before mention handling
5. Add cleanup in `shutdown()`: `this.{newGame}Manager.cancel{NewGame}();`
6. Update `README.md` with command syntax and examples
7. Update this section in `AGENTS.md` with new manager details

## Developer Workflow
- Install dependencies with `npm install`; run the bot locally using `npm start` (alias for `node main.js`).
- No automated tests exist; sanity-check syntax with `node --check main.js` when Node is available, and exercise flows by connecting to a test Twitch channel.
- If persistence is enabled, ensure the `data/` folder is writable to avoid silent downgrades (the persistence module logs a warning and disables itself otherwise).

## External Integrations
- The bot consumes Twitch IRC via `tmi.js`, Twitch EventSub WebSockets via `ws`, and Groq Chat Completions (OpenAI-compatible schema). Respect the existing error-handling pattern: capture errors, log via `log("warn" | "error", ...)`, and continue gracefully.
- The overlay server listens on `CONFIG.mediaOverlay.port` (default 8910). Remember to update both the config and `README.md` if you change host/port defaults so streamers can adjust OBS/browser sources.

Please review these notes after significant architectural changes and keep them in sync. Let me know if any section is unclear or missing context so we can iterate.
