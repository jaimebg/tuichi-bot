# TuichiBot

![CI](https://github.com/jaimebg/tuichi-bot/actions/workflows/ci.yml/badge.svg)

A Node.js Twitch chat bot with AI-powered conversation, interactive chat games, and presence-driven greetings — deployable to any Twitch channel.

## What it does

### Core functionality
- **Smart greetings & goodbyes**: welcomes viewers when they appear in chat and bids farewell when they leave, using the Helix Get Chatters API (reliable presence, unlike Twitch's batched IRC JOIN/PART). Requires the broadcaster token with `moderator:read:chatters` (see Credentials below).
- **AI chat responses**: responds to `@mentions` and replies using Groq AI, with per-user memory and conversation context.
- **Interactive adventures** (`!aventura [tema]`): AI-narrated, story-driven adventures voted on by chat, up to 4 rounds.
- **Interactive polls** (`!poll`): real-time chat polls; viewers vote with numbered options.
- **Trivia game** (`!trivia`): AI-generated trivia with 4 multiple-choice options.
- **Survive game** (`!survive`): multi-round battle royale where players write `!survive` each round to avoid elimination.
- **Inactivity mentions**: automatic AI-generated messages ribbing inactive users (15+ min silent).
- **Single-word echo**: randomly repeats single-word messages for engagement.
- **User memory & profiles**: tracks personality traits, conversation themes, and engagement patterns per user.
- **Threaded conversations**: maintains context across multiple exchanges using Twitch replies.
- **User aliases**: maps usernames to preferred display names for personalized interactions.

### Technical features
- SQLite persistence (`better-sqlite3` with WAL mode)
- `@twurple` for Twitch chat, API, and auth (with token auto-refresh)
- Automatic reconnection and error recovery
- Rate limiting and cooldowns
- Configurable logging levels
- Media overlay server (SSE) for channel point rewards, for use as an OBS browser source
- EventSub WebSocket for channel point redemptions and stream online/offline/category events
- Circuit breaker on the Groq API with exponential backoff
- Health check server with metrics and a small REST API
- systemd integration with watchdog and memory limits
- Automated tests via Node.js's built-in test runner

## Architecture

```mermaid
graph TD
    Bot[Bot: orchestrator] --> DB[(SQLite)]
    Bot --> TwitchApi[TwitchApi<br/>auth + Helix API]
    Bot --> Chat[ChatHandler<br/>@twurple/chat]
    Bot --> AI[AiController<br/>Groq + circuit breaker]
    Bot --> Router[CommandRouter<br/>help / status / greet toggle]
    Bot --> Presence[ChatterPresence<br/>Helix Get Chatters]
    Bot --> Greeter[Greeter<br/>greetings + goodbyes]
    Bot --> Ambient[AmbientResponder<br/>echo / spontaneous reply / auto-media]
    Bot --> Persona[PersonaResponder<br/>mentions + replies]
    Bot --> Announcer[StreamAnnouncer<br/>live + category-change messages]
    Bot --> Maint[MaintenanceTasks<br/>backups / inactivity / top users]
    Bot --> Games[GameController]
    Games --> Poll[PollManager]
    Games --> Trivia[TriviaManager]
    Games --> Adventure[AdventureManager]
    Games --> Survive[SurviveManager]
    Bot --> Intel[Intelligence:<br/>UserMemory, UserContextStore,<br/>RecentChatTracker, ConversationThreads]
    Intel --> DB
    Bot --> StreamMon[StreamMonitor<br/>EventSub + polling]
    Bot --> Overlay[MediaOverlayServer<br/>SSE for OBS]
    Bot --> EventSub[EventSubClient<br/>EventSub WebSocket]
    Bot --> Scheduler[Scheduler]
    Bot --> Metrics[MetricsCollector]
    Bot --> Health[HealthServer<br/>:9090]
    Bot --> Watchdog[Watchdog<br/>systemd sd_notify]
    Presence -.->|join / leave| Greeter
```

`ChatterPresence` and `EventSubClient`'s channel-points/stream-event subscriptions both depend on `TWITCH_BROADCASTER_TOKEN` being set; without it, presence-based greetings/goodbyes and channel-point redemptions are disabled gracefully (everything else still works).

## Getting started

### Prerequisites
- Docker (recommended), or Node.js 22+ if running without Docker
- A Twitch bot account with chat permissions
- A Groq API key

### Quickstart with Docker

```bash
git clone https://github.com/jaimebg/tuichi-bot.git
cd tuichi-bot
cp .env.example .env    # fill in your credentials
docker compose up
```

The bot starts with the example resource files included (generic greetings, a placeholder persona, no aliases). To personalize it, add your own files under `resources/` — see the [Resource files](#resource-files) table below.

> **`data/` ownership on a fresh clone.** The container runs as a non-root user (uid 1000). `data/` ships in the repo (as `data/.gitkeep`) precisely so the bind mount finds an already-existing directory instead of Docker creating it as `root`. Even so, **if you clone the repo as `root`** (common on a brand-new VPS) or as a user whose uid isn't 1000, `data/` will end up owned by someone the container can't write as, and the bot will fail to create `data/tuichi.db`. Fix: clone as a regular user, or run `sudo chown -R 1000:1000 data` before the first `docker compose up`.

### Alternative: run without Docker

```bash
git clone https://github.com/jaimebg/tuichi-bot.git
cd tuichi-bot
npm install
cp .env.example .env    # fill in your credentials
npm start
```

### Obtaining credentials

**Twitch API credentials** (`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_API_TOKEN`, `TWITCH_REFRESH_TOKEN`)
1. Create an application at https://dev.twitch.tv/console/apps (redirect URL: `http://localhost:3000`)
2. Use the OAuth Authorization Code flow to obtain access and refresh tokens
3. **Bot account token** (`TWITCH_API_TOKEN`/`TWITCH_REFRESH_TOKEN`) — scopes: `chat:read chat:edit`
4. The bot auto-refreshes the access token using the refresh token

**Broadcaster token** (`TWITCH_BROADCASTER_TOKEN`/`TWITCH_BROADCASTER_REFRESH_TOKEN`) — optional, but required for channel points, stream EventSub, and presence-based greetings/goodbyes. Authorize this on the **channel owner's** account.
- Required scopes: `channel:read:redemptions channel:read:subscriptions moderator:read:chatters`
- `moderator:read:chatters` powers presence (greetings/goodbyes via Get Chatters). The broadcaster is implicitly a moderator of their own channel.
- If you previously authorized this token **without** `moderator:read:chatters`, you must re-authorize it — otherwise the bot logs `ChatterPresence disabled: Get Chatters unauthorized` and greetings/goodbyes stay off (everything else keeps working).
- If this token is absent entirely, the bot logs `Presence tracking disabled` at startup and runs without greetings, goodbyes, and channel-point redemptions.

**Groq API key** (`GROQ_API_KEY`)
- Create a key from the Groq console: https://console.groq.com/keys

## Resource files

All in `resources/`. `src/config.js` resolves each one by looking for the real file first; if it isn't there, it falls back to the matching `.example` template and logs a warning (e.g. `Usando persona.example.txt como plantilla. Crea resources/persona.txt para personalizarlo.`) so you know you're running on placeholder content. The repo ships every `.example` file, so a fresh clone always starts successfully — `greetings.txt`, `goodbyes.txt`, and `persona.txt` only block startup if you delete **both** the real file and its `.example` counterpart (the error names this exact section: `ver la sección "Resource files" del README`).

| File | Required | Template | Format |
|---|---|---|---|
| `greetings.txt` | Yes* | `greetings.example.txt` | One greeting per line. `{user}` is replaced with the viewer's display name. |
| `goodbyes.txt` | Yes* | `goodbyes.example.txt` | One farewell per line. `{user}` is replaced with the viewer's display name. |
| `persona.txt` | Yes* | `persona.example.txt` | Free text: personality/behavior instructions for the AI. |
| `lore.txt` | No | `lore.example.txt` | Free text: world-building fed into `!aventura` prompts. Falls back to an empty string (silently) if both the real file and the template are missing. |
| `aliases.txt` | No | `aliases.example.txt` | `usuario_twitch:Nombre Preferido`, one per line. Lines starting with `#` are comments. Falls back to no aliases (silently) if both are missing. |
| `mediaRewards.json` | No | `mediaRewards.example.json` | Channel point → media overlay mappings. See the structure in the template. If missing entirely, the overlay simply has no reward mappings. |

\* "Required" here means the bot refuses to start (with the error above) only if **neither** the real file nor its `.example` template can be found — since both templates are checked into the repo, this only happens if you remove them.

## Command reference

| Command | Who | Description |
|---|---|---|
| `!ayuda` | Everyone | Lists all commands |
| `!poll <pregunta> \| <opción1> \| <opción2> [\| <segundos>]` | Everyone | Starts a poll; vote with `!1`, `!2`, etc. Duration defaults to 60s if omitted, otherwise clamped to 10–300s |
| `!trivia [tema]` | Everyone | AI-generated 4-option trivia; answer with `!a`/`!b`/`!c`/`!d`; 30s timer |
| `!aventura [tema]` | Everyone | Starts an AI-narrated interactive adventure with up to 4 options per round; vote with `!1`–`!4`; 60s per voting round, up to 4 rounds before an AI-generated ending |
| `!survive` | Everyone | Starts (or joins) a battle-royale elimination game; needs 2+ people present in chat; 30s per round |
| `!1` `!2` `!3` `!4` | Everyone | Votes during an active poll or adventure |
| `!a` `!b` `!c` `!d` | Everyone | Answers during an active trivia |
| `@<bot_username> <message>`, or a reply to the bot | Everyone | Triggers an AI (Groq) conversational response |
| `!status` | Channel owner only | Bot health snapshot: chat/DB status, uptime, AI circuit-breaker state, memory usage, message counters |
| `!saluditos` | Channel owner only | Toggles greetings/goodbyes on or off |

"Channel owner only" commands are gated on the account configured in `TWITCH_CHANNEL`, not a hardcoded name — so on any deployment, only that channel's owner account can run them.

## npm scripts

| Command | Description |
|---|---|
| `npm start` | Start the bot (`node --env-file=.env src/index.js`) |
| `npm test` | Run all tests (`node --test --test-timeout=20000 test/**/*.test.js`) |
| `npm run lint` | Run ESLint |
| `npm run add-rewards` | Sync channel point rewards from `resources/mediaRewards.json` to Twitch (creates/deletes rewards based on each entry's `sync_to_twitch` flag) |
| `npm run migrate` | One-time migration from the legacy JSON-file persistence (`data/*.json`, `resources/users/*/profile.json`) into `data/tuichi.db`. The original files are left untouched. |

## Project structure

```
src/
  index.js                  Entry point (loads config, starts bot, wires shutdown signals)
  config.js                 Builds frozen config from .env + resource files
  logger.js                 Centralized logging with adjustable levels
  bot/
    bot.js                  Central orchestrator wiring all modules together via events
    aiController.js         AI response generation via Groq, with circuit breaker
    chatHandler.js          @twurple/chat wrapper (send queue, EventEmitter)
    commandRouter.js        !ayuda / !status / !saluditos
    gameController.js       Routes game commands (!poll, !trivia, !aventura, !survive)
    greeter.js              Presence-driven greetings and goodbyes
    ambientResponder.js     Single-word echo, spontaneous replies, auto-triggered media
    personaResponder.js     @mention / reply-to-bot AI conversational path
    streamAnnouncer.js      AI-generated stream-live and category-change chat messages
    maintenanceTasks.js     DB backups, memory checks, inactivity shame message, top users
    prompts.js              Channel-parameterized system prompts shared by the modules above
    chatterPresence.js      Polls Helix Get Chatters; emits join/leave for greetings/goodbyes
    streamMonitor.js        Stream online/offline + category tracking (EventSub + polling)
    scheduler.js            Centralized periodic task runner
    metricsCollector.js     In-memory counters and error ring buffer
    healthServer.js         HTTP health/metrics/REST API server
    watchdog.js             systemd sd_notify integration
  games/
    pollManager.js          Multiple-choice polls
    triviaManager.js        AI-generated trivia
    adventureManager.js     Story-driven adventures with round-based voting
    surviveManager.js       Multi-round battle royale
  intelligence/
    userMemory.js           Per-user personality and engagement tracking
    userContextStore.js     Per-viewer context snapshots for AI prompts
    recentChatTracker.js    Recent chat message buffer
    conversationThreads.js  Threaded conversation context
    messageLogger.js        Message counting and logging
    inactivityTracker.js    Tracks user inactivity for shame messages
  media/
    mediaOverlayServer.js   SSE server for the browser overlay
    overlay/                Static HTML/CSS/JS for the OBS browser source
  persistence/
    database.js             SQLite (better-sqlite3) with an 8-table schema
  twitch/
    twitchApi.js            Shared auth + API layer (@twurple/auth + @twurple/api)
    eventSubClient.js       EventSub WebSocket (channel points + stream events)
  utils/
    text.js                 Whitespace normalization, response clamping
    json.js                 JSON extraction from AI responses
    time.js                 SQLite UTC timestamp parsing
scripts/
  addRewards.js             Sync channel point rewards to Twitch
  migrateData.js           One-time legacy-JSON-to-SQLite migration
  deploy.sh                Push-to-VPS deploy with health verification
  backup-db.sh             Crontab fallback for daily SQLite backup
  setup-vps.sh             One-time VPS provisioning
test/                       Automated tests (node:test), mirroring src/
resources/                  Resource files (greetings, persona, lore, aliases, rewards) + .example templates
data/                       SQLite database and backups (created on first run)
```

## VPS deployment (systemd)

### Quick setup

```bash
# On the VPS
./scripts/setup-vps.sh
# Edit .env with your credentials
sudo systemctl start tuichi-bot
```

### systemd management

```bash
sudo systemctl start tuichi-bot    # Start
sudo systemctl stop tuichi-bot     # Stop
sudo systemctl restart tuichi-bot  # Restart
sudo systemctl status tuichi-bot   # Status
journalctl -u tuichi-bot -f        # Live logs
```

### Health check

```bash
curl http://localhost:9090/health              # Public health status
curl -H "Authorization: Bearer <KEY>" \
     http://localhost:9090/metrics              # Full metrics (requires HEALTH_API_KEY)
curl http://localhost:9090/api/status           # Stream status summary
```

### Deploy updates

```bash
VPS_HOST=your-vps-host ./scripts/deploy.sh
```

Runs tests locally, pulls on the VPS, restarts the service, and verifies health.

### Backups

The SQLite database is backed up automatically:
- **In-app**: daily backup to `data/backups/` with 7-day retention (`MaintenanceTasks.backupDb`)
- **Cron fallback**: `scripts/backup-db.sh` (installed by `setup-vps.sh` at 04:00 daily)

## Troubleshooting

- **Bot exits on startup** — check that all required `.env` variables are set; the bot prints which ones are missing.
- **Resource file errors on startup** — the error names the missing files under `resources/`. See [Resource files](#resource-files) above; the fix is to add the real file or restore its `.example` template.
- **No AI replies** — verify `GROQ_API_KEY` is valid; check logs for API errors.
- **Overlay not showing** — open `http://localhost:8910/overlay` in OBS/browser source; verify rewards are mapped in `resources/mediaRewards.json`.
- **Token refresh errors** — verify `TWITCH_REFRESH_TOKEN`, `TWITCH_CLIENT_ID`, and `TWITCH_CLIENT_SECRET` are correct.
- **EventSub 429 errors** — rate limiting from rapid reconnections; the bot backs off automatically, wait and it will reconnect.
- **Circuit breaker open** — the Groq API had 3+ consecutive failures; the bot auto-recovers after a 1–5 min cooldown. Check `/metrics` for details.
- **Health check returns 503** — chat connection or database is unhealthy; check `journalctl -u tuichi-bot` for details. (A 503 does not kill the process — the systemd watchdog is pinged on event-loop liveness, not chat activity, so a quiet chat won't trigger a restart.)
- **No greetings or goodbyes** — presence needs the broadcaster token with `moderator:read:chatters`. Look for `ChatterPresence disabled: Get Chatters unauthorized` in the logs; if present, re-authorize `TWITCH_BROADCASTER_TOKEN` with that scope. If the token is absent entirely, you'll see `Presence tracking disabled` at startup.
- **`data/tuichi.db` fails to create under Docker** — see the `data/` ownership note under [Quickstart with Docker](#quickstart-with-docker).

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TWITCH_USERNAME` | Yes | — | Bot account login name |
| `TWITCH_CHANNEL` | Yes | — | Channel to join (broadcaster's login, without `#`) |
| `TWITCH_API_TOKEN` | Yes | — | Bot account OAuth access token |
| `TWITCH_REFRESH_TOKEN` | Yes | — | Bot account OAuth refresh token |
| `TWITCH_CLIENT_ID` | Yes | — | Twitch application client ID |
| `TWITCH_CLIENT_SECRET` | Yes | — | Twitch application client secret |
| `GROQ_API_KEY` | Yes | — | Groq API key for AI responses |
| `TWITCH_BROADCASTER_TOKEN` | No | — | Broadcaster account OAuth access token. Enables channel points, stream EventSub, and presence-based greetings/goodbyes. |
| `TWITCH_BROADCASTER_REFRESH_TOKEN` | No | — | Broadcaster account OAuth refresh token (paired with the above) |
| `EXCLUDED_USERS` | No | — | Comma-separated extra usernames excluded from greetings, goodbyes, the inactivity shame message, presence events, and the habitual-users list in the stream-start announcement. The bot always excludes itself, the channel owner, and a built-in bot list (`streamelements`, `nightbot`, `streamlabs`, `moobot`, `fossabot`) — this variable only adds to that list. It does **not** filter incoming chat messages, which are processed normally for every user, and it does **not** filter the `!status` top-users summary. |
| `MEDIA_OVERLAY_ENABLED` | No | `true` | Set to `false` to disable the media overlay server |
| `MEDIA_OVERLAY_PORT` | No | `8910` | Port for the SSE overlay server |
| `HEALTH_PORT` | No | `9090` | Port for the health/metrics/REST server |
| `HEALTH_API_KEY` | No | — | Bearer token required for `/metrics`, `/api/users`, `/api/say`. Without it, those three routes always return 401 (there is no "open" mode). |
| `LOG_LEVEL` | No | `info` | One of `debug`, `info`, `warn`, `error` |

## Requirements

- Node.js 22+ (or Docker)
- A Twitch bot account with chat permissions
- A Groq API key
