# CLAUDE.md

## Architecture

- Entry point: `src/index.js` -- builds config, sets log level, creates `Bot`, wires shutdown handlers.
- Config: `src/config.js` -- reads `.env` via `--env-file`, loads resource files, returns a frozen config object.
- `Bot` (`src/bot/bot.js`) is the central orchestrator. It creates all modules via constructor injection and wires them together through events.
- All source code is ES Modules (`"type": "module"` in package.json). No CommonJS.

### Module Dependency Flow

```
Bot
├── Database (better-sqlite3, WAL mode)
├── TwitchApi (@twurple/auth + @twurple/api)
├── ChatHandler (@twurple/chat, EventEmitter: message, join, part, connected)
├── AiController (Groq chat completions)
├── Intelligence modules (all take `db` in constructor)
│   ├── UserMemory
│   ├── UserContextStore
│   ├── RecentChatTracker
│   ├── ConversationThreads
│   ├── MessageLogger
│   └── InactivityTracker
├── GameController (EventEmitter: send, sendLong)
│   ├── PollManager
│   ├── TriviaManager
│   ├── AdventureManager
│   └── SurviveManager
├── StreamMonitor (EventEmitter: live, offline, categoryChange)
├── MediaOverlayServer (SSE + static file serving)
└── ChannelPointsWatcher (EventSub WebSocket)
```

### Persistence

- SQLite via `better-sqlite3` at `data/tuichi.db` with WAL mode and prepared statements.
- 8 tables: users, chat_messages, conversation_threads, bot_state, game_history, user_context, user_engagement, user_notes.
- Database class exposes typed helper namespaces: `db.users.*`, `db.chat.*`, `db.threads.*`, `db.context.*`, `db.state.*`, `db.games.*`.
- Intelligence modules call `save()`/`load()` against the database; no JSON file I/O.

### Credentials

- All credentials come from environment variables loaded via `node --env-file=.env`.
- Required vars: `TWITCH_USERNAME`, `TWITCH_CHANNEL`, `TWITCH_OAUTH_TOKEN`, `TWITCH_API_TOKEN`, `TWITCH_REFRESH_TOKEN`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `GROQ_API_KEY`.
- Never hardcode credentials. Never commit `.env`.

## Conventions

- **Logging**: Use `log('level', ...)` from `src/logger.js`. Levels: debug, info, warn, error. Call `setLogLevel()` once at startup.
- **Text output**: Always normalize with `normalizeWhitespace()` and clamp with `clampResponseLength()` from `src/utils/text.js`.
- **JSON from AI**: Use `extractJson()` from `src/utils/json.js` to parse AI responses that contain JSON.
- **Ignored users**: `IGNORED_USERS` set in `src/twitch/constants.js` -- bot skips messages from these.
- **Events over callbacks**: Modules communicate via EventEmitter. ChatHandler emits `message`/`join`/`part`/`connected`. GameController emits `send`/`sendLong`. StreamMonitor emits `live`/`offline`/`categoryChange`.

## Development

```bash
npm install          # Install dependencies
npm test             # Run all tests (node:test)
npm start            # Start bot (requires .env)
npm run lint         # ESLint
```

- Tests use Node.js built-in test runner (`node:test`) with `describe`/`it`/`assert`.
- Test files live in `test/` mirroring `src/` structure.
- Database tests use in-memory SQLite (`:memory:`).

## Adding New Games

1. Create `src/games/{name}Manager.js` following existing manager pattern (constructor takes no external deps, public methods: `start`, `record`, `end`, `cancel`, `getStatus`)
2. Import and instantiate in `GameController` constructor
3. Add command routing in `GameController._setupCommandRoutes()`
4. Add cleanup in `GameController.cancelAll()`
5. Update README command reference

## Adding New Intelligence Modules

1. Create `src/intelligence/{name}.js` with constructor taking `(db, ...config)`
2. Add `save()`/`load()` methods that use `db.*` helpers
3. Instantiate in `Bot` constructor, call `load()` in `Bot.start()`, include in auto-save interval

## Documentation Policy

- `README.md` -- User-facing documentation (setup, commands, troubleshooting)
- `CLAUDE.md` -- Architecture and development guidelines (this file)
- Do not create other documentation files unless explicitly requested.
- Update both files after significant changes.

## Resource Files

All in `resources/`:
- `greetings.txt` -- One greeting per line, `{user}` placeholder
- `persona.txt` -- AI personality prompt
- `lore.txt` -- Adventure lore/world-building
- `aliases.txt` -- `username:Display Name` mappings
- `mediaRewards.json` -- Channel point reward configs for media overlay
