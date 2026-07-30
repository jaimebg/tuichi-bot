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
├── AiController (Groq chat completions, circuit breaker)
├── Intelligence modules (most take `db` in constructor -- `MessageLogger` and `InactivityTracker` don't)
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
├── ChatterPresence (EventEmitter: join, leave -- polls Helix Get Chatters; drives greetings/goodbyes/present list)
├── CommandRouter (!ayuda / !status / !saluditos; plain class, called directly from Bot._handleMessage)
├── Greeter (presence-driven greetings/goodbyes; consumes ChatterPresence's join/leave)
├── AmbientResponder (single-word echo, spontaneous replies, auto-triggered media)
├── PersonaResponder (@mention / reply-to-bot AI conversational path)
├── StreamAnnouncer (AI-generated stream-live / category-change chat messages)
├── MaintenanceTasks (DB backups, memory checks, inactivity shame message, top-users summary)
├── MediaOverlayServer (SSE + static file serving)
├── EventSubClient (EventSub WebSocket: channel points + stream events)
├── Scheduler (centralized periodic task runner)
├── MetricsCollector (in-memory counters + error ring buffer)
├── HealthServer (HTTP health/metrics/REST API on port 9090)
└── Watchdog (systemd sd_notify via execFile)
```

`CommandRouter`, `Greeter`, `AmbientResponder`, `PersonaResponder`, `StreamAnnouncer`, and `MaintenanceTasks` are the six modules extracted from what used to be inline logic on `Bot`. Unlike `GameController`/`ChatHandler`/`StreamMonitor`/`ChatterPresence`, they are plain classes wired via constructor injection and called directly from `Bot` (no EventEmitter) — see "Events over callbacks" below. Shared system-prompt text that's parameterized by channel/persona (not hardcoded per-module) lives in `src/bot/prompts.js`.

### Persistence

- SQLite via `better-sqlite3` at `data/tuichi.db` with WAL mode and prepared statements.
- 8 tables (`src/persistence/database.js`): `schema_version`, `user_memory`, `user_messages`, `recent_chat`, `conversation_threads`, `user_context`, `bot_state`, `game_history`.
- Database class exposes typed helper namespaces: `db.users.*`, `db.chat.*`, `db.threads.*`, `db.context.*`, `db.state.*`, `db.games.*`.
- `UserMemory`, `RecentChatTracker`, and `ConversationThreads` call `save()`/`load()` against the database; `UserContextStore` instead uses `flush()`/`syncFromUserMemory()`; `MessageLogger` and `InactivityTracker` hold no `db` reference and persist nothing. No JSON file I/O anywhere.

### Credentials

- All credentials come from environment variables loaded via `node --env-file=.env`.
- Required vars: `TWITCH_USERNAME`, `TWITCH_CHANNEL`, `TWITCH_API_TOKEN`, `TWITCH_REFRESH_TOKEN`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `GROQ_API_KEY`.
- Never hardcode credentials. Never commit `.env`.
- Optional vars: `HEALTH_PORT` (default 9090), `HEALTH_API_KEY`, `EXCLUDED_USERS`, `LOG_LEVEL` (default `info`), `MEDIA_OVERLAY_ENABLED` (default `true`), `MEDIA_OVERLAY_PORT` (default 8910). The README's "Environment variables" table is the reference; keep the two in sync.
- `TWITCH_USERNAME` is normalized to lowercase in `src/config.js`. It must be: the mention path compares `@${username}` against a lowercased message, and the reply-parent tag arrives lowercased, so a mixed-case value used to silently disable every @mention and reply with no error at all.
- Broadcaster token (`TWITCH_BROADCASTER_TOKEN`, `TWITCH_BROADCASTER_REFRESH_TOKEN`): channel owner's token for EventSub (channel points / stream events) and presence. Scopes: `channel:read:redemptions channel:read:subscriptions moderator:read:chatters`. Without it, EventSub and greetings/goodbyes are disabled gracefully, and `!survive` can never gather participants either -- it reads its present-users list from `ChatterPresence` (`bot.js`'s `this.chatterPresence?.getPresentList() ?? []`), which is `null` without this token, so the game always reports nobody connected. `getChatters` uses this token (the broadcaster is implicitly a moderator).

### Production (VPS)

- systemd service: `tuichi-bot.service` -- auto-restart, watchdog, memory limits (768M).
- Health server on port 9090: `/health`, `/metrics`, `/api/status`, `/api/users`, `/api/say`.
- Circuit breaker on Groq API: 3 failures -> OPEN (1-5 min backoff) -> HALF_OPEN -> CLOSED.
- Scheduled tasks via `Scheduler` module (replaces manual setInterval).
- Daily SQLite backup to `data/backups/` (7-day retention).
- Deploy: `scripts/deploy.sh` (test -> git pull -> restart -> health check).
- Sync rewards to Twitch: `scripts/addRewards.js` (creates/deletes rewards based on `sync_to_twitch` flag in `mediaRewards.json`).

## Conventions

- **Logging**: Use `log('level', ...)` from `src/logger.js`. Levels: debug, info, warn, error. Call `setLogLevel()` once at startup.
- **Text output**: Always normalize with `normalizeWhitespace()` and clamp with `clampResponseLength()` from `src/utils/text.js`.
- **JSON from AI**: Use `extractJson()` from `src/utils/json.js` to parse AI responses that contain JSON.
- **Excluded users**: `config.engagement.excludedUsers` (a `Set`, built in `src/config.js` from the optional `EXCLUDED_USERS` env var plus a built-in bot list, the bot's own username and the channel owner). The exact consumers, and nothing else: greetings and goodbyes (`greeter.js`), the inactivity shame candidate list (`InactivityTracker`), presence events (`ChatterPresence`), and the habitual-users list in the stream-start announcement (`streamAnnouncer.js`). **It does not filter incoming messages** -- that chat is processed normally, commands and AI replies included -- **and it does not filter the top-users summary**: `MaintenanceTasks.getTopUsersMessage()` reads `MessageLogger.getTopUsers()`, which has no exclusion concept, and `logMessage` is called for every message before any exclusion check. Don't assume this set is consulted anywhere it isn't; grep for `excludedUsers` before claiming otherwise. The old `IGNORED_USERS` constant and `src/twitch/constants.js` no longer exist.
- **SQLite timestamps**: read every DB timestamp column through `parseSqliteUtc()` from `src/utils/time.js`. SQLite stores UTC without a zone marker, so `new Date(str)` would parse it as local time; the helper accepts both that format and ISO-8601 with `Z`, and returns `null` -- never `NaN` -- for missing or malformed values. Never hand-roll the conversion (a `+ 'Z'` concatenation used to be the fix and it broke on values that already ended in `Z`).
- **Date comparisons in SQL**: normalize both sides with `julianday()`. SQLite compares dates as byte strings, so a column holding a mix of the legacy `'YYYY-MM-DD HH:MM:SS'` format and the current ISO-8601 format compares incorrectly -- `'T'` sorts after `' '`. This affects `ORDER BY` as well as `WHERE`.
- **Resource files**: load them through the spec table in `src/config.js`, which resolves `resources/X` first and falls back to `resources/X.example.*`, warning per file. Required resources that are missing entirely are collected into a single error naming all of them. Never read a resource file directly from a consumer -- `scripts/addRewards.js` does it via the exported `resolveResourcePath` for this reason.
- **Events over callbacks**: Modules communicate via EventEmitter. ChatHandler emits `message`/`connected` (it also emits `join`/`part`, but Twitch only delivers those for the bot's own account without the membership capability, so they are not used for presence). GameController emits `send`/`sendLong`. StreamMonitor emits `live`/`offline`/`categoryChange`. ChatterPresence emits `join`/`leave` (authoritative presence from Helix Get Chatters) — this is what drives greetings/goodbyes.

## Development

```bash
npm install          # Install dependencies
npm test             # Run all tests (node:test, 20s per-test timeout)
npm start            # Start bot (requires .env)
npm run lint         # ESLint -- must stay at 0 problems
docker compose up    # Run in a container (see README for the data/ ownership caveat)
```

- Tests use Node.js built-in test runner (`node:test`) with `describe`/`it`/`assert`.
- Test files live in `test/` mirroring `src/` structure.
- Database tests use in-memory SQLite (`:memory:`).
- `npm test` carries `--test-timeout=20000` deliberately: without it a hung test wedges CI indefinitely instead of failing.
- **No test instantiates `Bot`.** A stale reference to moved state therefore ships green. When changing `Bot`'s wiring or extracting from it, construct a real `Bot` (fake credentials, temp DB, media/channelPoints disabled) as a smoke check.
- When adding a regression test, verify it can actually fail: break the code it guards, confirm the test goes red, then restore. Several tests in this repo's history passed against deliberately broken code before this became the habit.

## Adding New Games

1. Create `src/games/{name}Manager.js` following existing manager pattern (constructor takes no external deps, public methods: `start`, `record`, `end`, `cancel`, `getStatus`)
2. Import and instantiate in `GameController` constructor
3. Add command routing in `GameController.handleCommand()`
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

All in `resources/`, resolved by the `RESOURCE_SPECS` table in `src/config.js`. Each one resolves to
the real file if present, otherwise its committed `.example` counterpart (with a warning naming the
real file to create). The real files are gitignored; only the `.example` versions are committed.

| File | Required | Purpose |
|---|---|---|
| `greetings.txt` | yes | One greeting per line, `{user}` placeholder |
| `goodbyes.txt` | yes | One goodbye per line, `{user}` placeholder |
| `persona.txt` | yes | AI personality prompt |
| `lore.txt` | no | Adventure lore / world-building |
| `aliases.txt` | no | `username:Display Name` mappings, `#` for comments |
| `mediaRewards.json` | no | Channel point reward configs for the media overlay |

"Required" means: if neither the real file nor its `.example` exists, `buildConfig` throws. Optional
resources fall back to a declared empty value (`''` for lore, `{}` for aliases) instead.

Missing required resources are collected into a **single** error naming all of them, which points at
the README's `Resource files` section — keep that heading spelled exactly that way or the error lies.
See the README table for each file's format with inline examples.
