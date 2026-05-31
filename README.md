# TuichiBot

A Node.js Twitch chat bot for the `jaimevarecto` channel, featuring AI-powered interactions, interactive games, and intelligent user engagement.

## Features

### Core Functionality
- **Smart Greetings & Goodbyes**: Welcomes viewers when they appear in chat and bids farewell when they leave, using the Helix Get Chatters API (reliable presence, unlike Twitch's batched IRC JOIN/PART). Requires the broadcaster token with `moderator:read:chatters` (see Credentials).
- **AI Chat Responses**: Responds to @mentions and replies using Groq AI with user memory and context
- **Interactive Adventures** (`!aventura [theme] [difficulty]`): Story-driven adventures with dynamic difficulty, death probability, and unpredictable endings
- **Interactive Polls** (`!poll`): Real-time chat polls; viewers vote with numbered options
- **Trivia Game** (`!trivia`): AI-generated trivia with 4 multiple-choice options
- **Survive Game** (`!survive`): Multi-round battle royale where players write `!survive` each round to avoid elimination
- **Inactivity Mentions**: Automatic AI-generated messages shaming inactive users (15+ min silent)
- **Single Word Echo**: Randomly repeats single-word messages for engagement
- **User Memory & Profiles**: Tracks personality traits, conversation themes, and engagement patterns
- **Threaded Conversations**: Maintains context across multiple exchanges using Twitch replies
- **User Aliases**: Maps usernames to preferred display names for personalized interactions

### Technical Features
- SQLite persistence (better-sqlite3 with WAL mode)
- @twurple for Twitch chat, API, and auth (with token auto-refresh)
- Automatic reconnection and error recovery
- Rate limiting and cooldowns
- Configurable logging levels
- Media overlay server (SSE) for channel point rewards
- EventSub WebSocket for channel point redemptions and stream events
- Circuit breaker on Groq API with exponential backoff
- Health check server with metrics and REST API
- systemd integration with watchdog and memory limits
- Automated tests via Node.js built-in test runner

## Getting Started

### Prerequisites
- Node.js 22+
- A Twitch bot account with chat permissions
- A Groq API key

### Installation

```bash
git clone <repository-url>
cd tuichi-bot
npm install
```

### Configuration

Create a `.env` file in the project root with the following variables:

```env
TWITCH_USERNAME=your_bot_username
TWITCH_CHANNEL=channel_to_join
TWITCH_API_TOKEN=your_api_access_token
TWITCH_REFRESH_TOKEN=your_refresh_token
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret
GROQ_API_KEY=your_groq_api_key

# Optional
LOG_LEVEL=info
MEDIA_OVERLAY_ENABLED=true
MEDIA_OVERLAY_PORT=8910
HEALTH_PORT=9090
HEALTH_API_KEY=your-secret-api-key

# Broadcaster token (channel owner) — enables channel points, stream EventSub,
# and greetings/goodbyes via Get Chatters. Without it, those features are disabled.
TWITCH_BROADCASTER_TOKEN=broadcaster_access_token
TWITCH_BROADCASTER_REFRESH_TOKEN=broadcaster_refresh_token
```

### Obtaining Credentials

**Twitch API Credentials** (`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_API_TOKEN`, `TWITCH_REFRESH_TOKEN`)
1. Create an application at https://dev.twitch.tv/console/apps (redirect URL: `http://localhost:3000`)
2. Use the OAuth Authorization Code flow to obtain access and refresh tokens
3. **Bot account token** (`TWITCH_API_TOKEN`/`TWITCH_REFRESH_TOKEN`) — scopes: `chat:read chat:edit`
4. The bot auto-refreshes the access token using the refresh token

**Broadcaster Token** (`TWITCH_BROADCASTER_TOKEN`/`TWITCH_BROADCASTER_REFRESH_TOKEN`) — authorize this on the **channel owner's** account
- Required scopes: `channel:read:redemptions channel:read:subscriptions moderator:read:chatters`
- `moderator:read:chatters` powers presence (greetings/goodbyes via Get Chatters). The broadcaster is implicitly a moderator of their own channel.
- ⚠️ If you previously authorized this token **without** `moderator:read:chatters`, you must re-authorize it — otherwise the bot logs `ChatterPresence disabled: Get Chatters unauthorized` and greetings/goodbyes stay off (everything else keeps working).

**Groq API Key** (`GROQ_API_KEY`)
- Create a key from the Groq console: https://console.groq.com/keys

### Customize bot behavior

- `resources/greetings.txt` -- Greeting messages for arriving viewers (`{user}` placeholder supported)
- `resources/goodbyes.txt` -- Farewell messages for departing viewers (`{user}` placeholder supported)
- `resources/persona.txt` -- AI personality and behavior guidelines
- `resources/lore.txt` -- Story elements for adventures
- `resources/aliases.txt` -- Username-to-alias mappings (`username:Alias Name`)
- `resources/mediaRewards.json` -- Channel point reward mappings for media overlay

### Run the bot

```bash
npm start
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the bot (`node --env-file=.env src/index.js`) |
| `npm test` | Run all tests |
| `npm run add-rewards` | Sync channel point rewards from `resources/mediaRewards.json` to Twitch |
| `npm run migrate` | One-time migration from legacy JSON data to SQLite |
| `npm run lint` | Run ESLint |

## Migration from v1

If upgrading from the legacy JSON-based persistence:

```bash
npm run migrate
```

This reads `data/*.json` files and imports them into `data/tuichi.db`. The original JSON files are left untouched.

## Command Reference

| Command | Description |
|---------|-------------|
| `!aventura [theme] [difficulty]` | Start an interactive adventure. Difficulties: `facil` (15% death), `normal` (35%, default), `dificil` (55%) |
| `!poll "<question>" "opt1" "opt2" [duration]` | Start a poll. Vote with `!1`, `!2`, etc. Default 60s, max 300s |
| `!trivia` | AI-generated trivia. Answer with `!a`, `!b`, `!c`, `!d`. 30s timer |
| `!survive` | Start a battle royale. Write `!survive` each round to stay alive |
| `!1` `!2` `!3` `!4` | Vote during adventures or polls |

## Project Structure

```
src/
  index.js                  Entry point (loads config, starts bot)
  config.js                 Builds frozen config from .env + resource files
  logger.js                 Centralized logging with adjustable levels
  bot/
    bot.js                  Central orchestrator wiring all modules
    aiController.js         AI response generation via Groq
    chatHandler.js          @twurple/chat wrapper with EventEmitter
    gameController.js       Routes game commands, emits chat messages
    streamMonitor.js        Stream status via EventSub + adaptive polling
  games/
    pollManager.js          Multiple-choice polls
    triviaManager.js        AI-generated trivia
    adventureManager.js     Story-driven adventures with difficulty scaling
    surviveManager.js       Multi-round battle royale
  intelligence/
    userMemory.js           Per-user personality and engagement tracking
    userContextStore.js     Per-viewer context snapshots for AI prompts
    recentChatTracker.js    Recent chat message buffer
    conversationThreads.js  Threaded conversation context
    messageLogger.js        Message counting and logging
    inactivityTracker.js    Tracks user inactivity for shame messages
  media/
    mediaOverlayServer.js   SSE server for browser overlay
    overlay/                Static HTML/CSS/JS for OBS browser source
  bot/
    chatterPresence.js      Polls Helix Get Chatters; emits join/leave for greetings/goodbyes
    streamMonitor.js        Stream online/offline + category tracking (EventSub + polling)
    scheduler.js            Centralized periodic task runner
    metricsCollector.js     In-memory counters and error ring buffer
    healthServer.js         HTTP health/metrics/REST API server
    watchdog.js             systemd sd_notify integration
  persistence/
    database.js             SQLite (better-sqlite3) with 8-table schema
  twitch/
    twitchApi.js            Shared auth + API layer (@twurple/auth + @twurple/api)
    eventSubClient.js       EventSub WebSocket (channel points + stream events)
    constants.js            Ignored users list
  utils/
    text.js                 Whitespace normalization, response clamping
    json.js                 JSON extraction from AI responses
scripts/
  addRewards.js             Sync channel point rewards to Twitch
  migrateData.js            One-time JSON-to-SQLite migration
  deploy.sh                 Push-to-VPS deploy with health verification
  backup-db.sh              Crontab fallback for daily SQLite backup
  setup-vps.sh              One-time VPS provisioning
test/                       Automated tests (node:test)
resources/                  Static config files (greetings, persona, lore, aliases, rewards)
data/                       SQLite database (created on first run)
```

## VPS Deployment (Oracle Cloud Free Tier)

### Quick Setup

```bash
# On the VPS
./scripts/setup-vps.sh
# Edit .env with your credentials
sudo systemctl start tuichi-bot
```

### systemd Management

```bash
sudo systemctl start tuichi-bot    # Start
sudo systemctl stop tuichi-bot     # Stop
sudo systemctl restart tuichi-bot  # Restart
sudo systemctl status tuichi-bot   # Status
journalctl -u tuichi-bot -f        # Live logs
```

### Health Check

```bash
curl http://localhost:9090/health              # Public health status
curl -H "Authorization: Bearer <KEY>" \
     http://localhost:9090/metrics              # Full metrics (requires HEALTH_API_KEY)
curl http://localhost:9090/api/status           # Stream status summary
```

### Deploy Updates

```bash
VPS_HOST=tuichi-vps ./scripts/deploy.sh
```

Runs tests locally, pulls on VPS, restarts service, and verifies health.

### Backups

SQLite database is backed up automatically:
- **In-app**: Daily backup to `data/backups/` with 7-day retention
- **Cron fallback**: `scripts/backup-db.sh` (installed by setup-vps.sh at 04:00 daily)

## Troubleshooting

- **Bot exits on startup** -- Check that all required `.env` variables are set. The bot will print which ones are missing.
- **No AI replies** -- Verify `GROQ_API_KEY` is valid. Check logs for API errors.
- **Overlay not showing** -- Open `http://localhost:8910/overlay` in OBS/browser source. Verify rewards are mapped in `resources/mediaRewards.json`.
- **Token refresh errors** -- Verify `TWITCH_REFRESH_TOKEN`, `TWITCH_CLIENT_ID`, and `TWITCH_CLIENT_SECRET` are correct.
- **EventSub 429 errors** -- Rate limiting from rapid reconnections. The bot backs off automatically; wait and it will reconnect.
- **Circuit breaker open** -- Groq API had 3+ consecutive failures. The bot auto-recovers after 1-5 min cooldown. Check `/metrics` for details.
- **Health check returns 503** -- Chat connection or database is unhealthy. Check `journalctl -u tuichi-bot` for details. (Note: a 503 no longer kills the process — the systemd watchdog is pinged on event-loop liveness, not chat activity, so a quiet chat won't trigger restarts.)
- **No greetings or goodbyes** -- Presence needs the broadcaster token with `moderator:read:chatters`. Look for `ChatterPresence disabled: Get Chatters unauthorized` in the logs; if present, re-authorize `TWITCH_BROADCASTER_TOKEN` with that scope. If the token is absent entirely, you'll see `Presence tracking disabled` at startup.
- **Bot restarts during quiet streams** -- Fixed: the watchdog ping was previously gated on recent chat activity, so a >10 min lull starved the systemd watchdog (`WatchdogSec=120`) and forced a restart. Confirm the cause in old logs with `journalctl -u tuichi-bot | grep -i watchdog`.

## Requirements

- Node.js 22+
- Twitch bot account with chat permissions
- Groq API key
