# TuichiBot

A sophisticated Node.js Twitch chat bot for the `jaimevarecto` channel, featuring AI-powered interactions, interactive adventures, and intelligent user engagement.

## Features

### Core Functionality
- **Smart Greetings**: Welcomes new viewers with customizable messages, skipping those who chat first
- **AI Chat Responses**: Responds to @mentions and replies using Groq AI with user memory and context
- **Interactive Adventures** (REDESIGNED): Story-driven adventures with `!aventura [theme] [difficulty]` featuring dynamic difficulty, death probability, and unpredictable endings
- **Interactive Polls**: Create real-time chat polls with `!poll`; viewers vote with numbered options
- **Trivia Game**: AI-generated trivia questions with 4 multiple-choice options via `!trivia`
- **Survive Game** (v2.1): Multi-round battle royale where users write `!survive` each round to survive elimination
- **Inactivity Mentions**: Automatic AI-generated messages mention inactive users (15+ min silent) with sarcastic/comedic shame
- **Single Word Echo**: Randomly repeats single-word messages for engagement
- **User Memory & Profiles**: Tracks personality traits, conversation themes, engagement patterns, and persists per-user profiles under `resources/users/` for richer AI context
- **Threaded Conversations**: Maintains context across multiple exchanges using Twitch replies
- **User Aliases**: Maps usernames to preferred display names for personalized interactions

### Technical Features
- Persistent data storage across restarts
- Automatic reconnection and error recovery
- Rate limiting and cooldowns
- Configurable logging levels
- Model fallback for AI responses

## Getting Started

1. **Install dependencies**
   ```bash
   git clone <repository-url>
   cd tuichi-bot
   npm install
   ```

2. **Configure credentials in `main.js`**
   - Open `main.js` and locate the `TWITCH_CREDENTIALS` and `GROQ_CREDENTIALS` objects at the top
   - Replace all placeholder values (e.g., `your_oauth_token_here`) with your actual credentials:
     - **`username`** – Your bot's Twitch username
     - **`channel`** – The channel to join (usually your main channel)
     - **`oauthToken`** – OAuth token for IRC chat access
     - **`apiToken`** – Twitch API access token
     - **`refreshToken`** – Twitch API refresh token (for auto-renewal)
     - **`clientId`** – Your Twitch app's client ID
     - **`clientSecret`** – Your Twitch app's client secret
     - **`GROQ_CREDENTIALS.apiKey`** – Your Groq API key
   - ⚠️ **Security Warning**: The credentials are now hardcoded in `main.js`. In production:
     - Never commit real credentials to version control
     - Use `.gitignore` or load from environment variables before running
     - Consider using a secrets manager for production deployments

3. **Customize bot behavior**
   - Edit `resources/greetings.txt` – Greeting messages for new viewers
   - Edit `resources/persona.txt` – AI personality and behavior guidelines
- Edit `resources/lore.txt` – Story elements for adventures
- Edit `resources/aliases.txt` – Username-to-alias mappings
- Edit `resources/mediaRewards.json` – Channel point reward mappings
- (Optional) Seed per-user context by editing `resources/users/<login>/profile.json`; the bot will merge your notes with live data on the next auto-save.

4. **Run the bot**
   ```bash
   npm start
   ```
   The default `npm start` script runs `node main.js`. The bot will start and connect to the configured channel.

## Scripts

- **`addRewards.js`** – Automates adding channel point rewards to Twitch from `resources/mediaRewards.json`. It refreshes the API token, creates missing rewards on Twitch, and updates the JSON with their IDs. Run with `npm run add-rewards` after editing rewards. Requires valid Twitch API credentials in `main.js`.

## Configuration Files

All user-editable text and reward configuration is stored in the `resources/` folder:

- **`resources/greetings.txt`** – Greeting messages (one per line, `{user}` placeholder supported)
- **`resources/persona.txt`** – AI personality and behavior guidelines
- **`resources/lore.txt`** – Story elements and world-building for adventures
- **`resources/aliases.txt`** – Username-to-alias mappings (format `username:Alias Name`)
- **`resources/mediaRewards.json`** – Overlay reward mappings for channel redemptions (each reward has an `id` matching the Twitch reward ID, `title`, `cost`, and `action` for media playback; durations are detected automatically for videos and audio).
- **`resources/users/`** – Auto-generated per-user profiles (`profile.json` per viewer) used to enrich AI responses. The folder ships with a `.gitignore` so live data is not committed.

### User Context Profiles

Every viewer that chats now receives a dedicated folder at `resources/users/<login>/` with a `profile.json` summary (message counts, recent quotes, command usage, active hours, and any manual notes). These files are refreshed on each auto-save and shutdown, and the AI prompt consumes them automatically. You can safely pre-populate or tweak details between streams—just keep values in plain JSON so the bot can merge live updates.

Runtime state (user memories, chat history, etc.) is still stored separately under `data/` when persistence is enabled.

## Command Reference

### Core Commands
- **`!aventura [theme] [difficulty]`** – Start an interactive adventure. Difficulty options: `fácil` (15% death), `normal` (35% death, default), `difícil` (55% death). Adventures are dynamic and can end at any time based on decisions and probability. Warning: the story may conclude unexpectedly—viewers should agree on the safest action.
- **`!poll "<question>" "option1" "option2" ["option3"] [duration_seconds]`** – Start a poll. Viewers vote with `!1`, `!2`, `!3`, etc. Duration defaults to 60 seconds. Max 10 options.
- **`!trivia`** – Generate a random trivia question (4 multiple-choice options: a, b, c, d). Viewers answer with `!a`, `!b`, etc. Reveals correct answer and winners after 30 seconds.
- **`!survive`** – Start a multi-round battle royale game. All connected users participate. Each round lasts 30 seconds—viewers must write `!survive` to avoid elimination. Those who don't write it are eliminated for that round. The game continues until only 1 player remains (the champion) or everyone is eliminated.

### Voting During Adventures
- **`!1`**, **`!2`**, **`!3`**, **`!4`** – Vote for options during an active adventure.

## Project Structure

- `main.js` – Minimal bootstrapper that loads config files and starts the bot (used by `npm start`).
- `addRewards.js` – Utility script to create and sync channel point rewards with Twitch API.
- `src/logger.js` – Centralised logging with adjustable levels.
- `src/config/loaders.js` – File loaders for greetings, persona, lore, aliases.
- `src/utils/text.js` – Common text helpers (whitespace normalisation, clamping).
- `src/persistence/` – Data persistence layer for user memories, chat history, and bot state.
- `src/intelligence/` – User memory, recent chat tracker, conversation threading, and inactivity tracking modules.
- `src/games/` – Game managers for polls, adventures, trivia, and survive game.
- `src/media/mediaOverlayServer.js` – SSE server that powers the browser overlay for media rewards.
- `src/twitch/channelPointsWatcher.js` – Twitch EventSub WebSocket client for channel point redemptions.
- `src/twitch/twitchChatBot.js` – The main bot class tying everything together.
- `resources/` – Static configuration files (greetings, persona, lore, aliases, reward map).
- `data/` – Persisted JSON state (created on demand when persistence is enabled).

## Credentials and Configuration

All bot credentials are configured directly in `main.js` in the `TWITCH_CREDENTIALS` and `GROQ_CREDENTIALS` objects. Update these values with your actual credentials.

### Obtaining Credentials

**Twitch Chat OAuth Token** (`oauthToken`)
- Generate via https://twitchapps.com/tmi/ while logged in as your bot account
- Alternative: Use the IRC OAuth flow with your Twitch app

**Twitch API Credentials** (`clientId`, `clientSecret`, `apiToken`, `refreshToken`)
- Create an application at https://dev.twitch.tv/console/apps
- Download the client secret and save it securely
- Use the OAuth Authorization Code flow to obtain API access and refresh tokens
- Required scopes: `channel:read:redemptions` (for EventSub channel points)

**Groq API Key** (`GROQ_CREDENTIALS.apiKey`)
- Create a key from the Groq console: https://console.groq.com/keys
- Required for AI responses (trivia, adventures, inactivity messages)

### Security Best Practices

⚠️ **DO NOT commit real credentials to version control!**

**For Development:**
- Keep credentials in `main.js` locally only
- Use `.gitignore` to prevent accidental commits:
  ```
  # .gitignore
  main.js
  credentials.js
  .env
  ```

**For Production:**
- Load credentials from environment variables before starting the bot
- Use Docker secrets or a secrets manager (AWS Secrets Manager, HashiCorp Vault, etc.)
- Create a separate `credentials.js` file and load it in `main.js`:
  ```javascript
  const { TWITCH_CREDENTIALS, GROQ_CREDENTIALS } = require('./credentials.js');
  ```
  Then add `credentials.js` to `.gitignore`

### Deployment Options

- Use a process manager such as `pm2`, Docker, or systemd to keep the bot online
- Remember to expose the media overlay port (`8910` by default) if you want to load the browser overlay in OBS or similar tools
- For long-running deployments, ensure the `data/` folder is accessible and writable for persistence

## Requirements

- Node.js 16+
- Twitch bot account with IRC/chat permissions
- Groq API key (required for AI replies)

## New Features (v2.0)

### Interactive Games

#### Polls (`!poll`)
Create real-time chat polls with multiple options. Viewers vote by typing option numbers.

**Usage:**
```
!poll "<question>" "option1" "option2" ["option3"] [duration_seconds]
```

**Example:**
```
!poll "¿Qué jugamos?" "The Witcher 3" "Elden Ring" "Stardew Valley" 60
```

**Features:**
- 2-10 options per poll
- One vote per user per poll
- Results displayed with vote counts and percentages
- Auto-ends after specified duration (default 60s, max 300s)

#### Trivia (`!trivia`)
AI-generated trivia questions with 4 multiple-choice options.

**Usage:**
```
!trivia
```

**Features:**
- Questions generated dynamically by Groq AI
- 4 options: a, b, c, d
- Viewers answer with `!a`, `!b`, `!c`, or `!d`
- One answer per user per question
- Auto-ends after 30 seconds
- Reveals correct answer with explanation
- Lists winners who answered correctly

#### Survive Game (`!survive`) – v2.1
Multi-round elimination game where players survive by writing `!survive` each round.

**Usage:**
```
!survive
```

**Game Flow:**
1. Any user writes `!survive` to start the game (requires 2+ connected players)
2. Each round lasts **30 seconds**
3. Players must write `!survive` during each round to survive
4. Those who DON'T write `!survive` in time are **permanently eliminated**
5. Game continues with remaining players for the next round
6. Game ends when only **1 player remains** (the champion) or **everyone is eliminated**

**Features:**
- **Multiple rounds**: Continues until 1 winner or all eliminated
- **Per-round elimination**: Those who don't write `!survive` exit the game
- **Progressive difficulty**: Fewer players each round = less chaos
- **Announces elimination**: Shows who was eliminated each round
- **Final results**: Shows champion, total eliminations, and rounds played
- **Spam prevention**: Only announces every 3rd survival to reduce spam

**Example Output:**
```
🎮 ¡SURVIVE - Battle Royale de Chat!
¡Ronda 1! Escribid !survive para no ser eliminados.
Jugadores iniciales: 12

✅ superviviste! Ronda 1: 3/12 🏃‍♂️
💀 Ronda 1: Eliminados → usuario1, usuario2, usuario3, usuario4, usuario5

🎮 Ronda 2: 7 supervivientes restantes!
¡Escribid !survive para sobrevivir!

🏆 ¡FIN DEL SURVIVE!
Total de jugadores: 12
Rondas jugadas: 4
Eliminados totales: 11

🥇 ¡CAMPEÓN: usuario_ganador!
```

#### Adventures - Redesigned (`!aventura`)
Completely redesigned adventure system with dynamic difficulty, death probability, and unpredictable endings.

**Usage:**
```
!aventura [theme] [difficulty]
```

**Difficulty Levels:**
- `fácil` – 15% death chance, up to 8 rounds
- `normal` – 35% death chance, up to 5 rounds (default)
- `difícil` – 55% death chance, up to 3 rounds

**Examples:**
```
!aventura                              # Random adventure, normal difficulty
!aventura una expedición a Marte       # Themed adventure
!aventura difícil                      # Themed (automatic), hard difficulty
!aventura rescate de dragón difícil   # Themed adventure with difficulty
```

**Features:**
- **Dynamic rounds**: No fixed round count; story progresses based on choices and difficulty
- **Death probability**: Varies by difficulty; story can end at ANY moment
- **Unpredictable endings**: Three possible outcomes:
  - Continuation (next round of choices)
  - Death (sudden, dramatic end based on probability)
  - Conclusion (story reaches natural end based on rounds)
- **Viewer warnings**: Constant reminders that the adventure is dangerous and can end unexpectedly
- **Voting**: `!1`, `!2`, `!3`, `!4` to vote for options (2-4 options per round)
- **60-second voting timer** per round
- **Unique narration**: AI generates different story branches each playthrough
- **Lore-inspired**: Adventures are inspired by Pentesilea lore but create original narratives

### Inactivity System (Automatic)
Automatically mentions users who haven't chatted for 15+ minutes with AI-generated comedic/sarcastic messages.

**Features:**
- Checks every 2 minutes for inactive users
- Generates unique shame messages with AI
- Anti-spam: Max 1 mention per user every 30 minutes
- Melodramatic tone with emojis
- Completely automatic, no commands needed

## Troubleshooting

- **Bot exits immediately on startup** – Verify all credentials in `main.js` are correctly filled in. Check that placeholder values like `your_oauth_token_here` have been replaced with actual tokens.
- **Bot won't connect to Twitch** – Ensure the `oauthToken` is valid and the bot account has channel access. Verify `channel` name is correct.
- **No AI replies to mentions** – Ensure Groq credentials are set correctly and the Groq API key is valid. Check logs for API errors.
- **Overlay not showing** – Open `http://localhost:8910/overlay` in OBS/browser source and verify channel point rewards are mapped in `resources/mediaRewards.json`.
- **Games not starting** – Verify Groq API key is valid (used for trivia, adventures, and inactivity shame messages).
- **Adventure ends too quickly** – This is intentional on hard difficulty; probability of death increases with difficulty level. Easy mode has lower death probability.
- **No inactivity shame mentions** – Ensure users have been silent for 15+ minutes and check logs to confirm `inactivityTracker` is running (happens every 2 minutes).
- **Token refresh errors** – Verify `refreshToken`, `clientId`, and `clientSecret` are all correctly configured for the OAuth token refresh flow.
- **EventSub WebSocket errors (429)** – This can indicate rate limiting or rapid reconnections. Check that credentials are correctly set and try restarting the bot.

## Architecture Notes

For detailed architecture information, refer to `AGENTS.md`. The bot follows a modular design:

- **Game Managers** (`src/games/`) – Independent managers for polls, adventures, trivia, and survive game
- **Intelligence Modules** (`src/intelligence/`) – User memory, chat tracking, conversation threading, and inactivity tracking
- **Main Coordinator** (`src/twitch/twitchChatBot.js`) – Orchestrates all managers and handles Twitch IRC events

All new features integrate seamlessly with existing functionality. Data is persisted automatically to `data/` when enabled.
