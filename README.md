# TuichiBot

A sophisticated Node.js Twitch chat bot for the `jaimevarecto` channel, featuring AI-powered interactions, interactive adventures, and intelligent user engagement.

## Features

### Core Functionality
- **Smart Greetings**: Welcomes new viewers with customizable messages, skipping those who chat first
- **AI Chat Responses**: Responds to @mentions and replies using Groq AI with user memory and context
- **Interactive Adventures** (REDESIGNED): Story-driven adventures with `!aventura [theme] [difficulty]` featuring dynamic difficulty, death probability, and unpredictable endings
- **Interactive Polls**: Create real-time chat polls with `!poll`; viewers vote with numbered options
- **Trivia Game**: AI-generated trivia questions with 4 multiple-choice options via `!trivia`
- **Survive Game**: Battle royale-style chat game where the last to write `!survive` is eliminated
- **Inactivity Mentions**: Automatic AI-generated messages mention inactive users (15+ min silent) with sarcastic/comedic shame
- **Single Word Echo**: Randomly repeats single-word messages for engagement
- **User Memory**: Tracks personality traits, conversation themes, and engagement patterns
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

2. **Configure the bot**
   - Edit `main.js` (or copy it to your own entry file) and provide the Twitch credentials, API tokens, and feature flags inside the `CONFIG` object.
   - Update the content files under `resources/` (`greetings.txt`, `persona.txt`, `lore.txt`, `aliases.txt`) to match your channel tone.
   - If you plan to commit your repo, keep secrets out of source control (e.g., load them from environment variables or a secrets file before constructing `CONFIG`).

3. **Run the bot**
   ```bash
   npm start
   ```
   The default `npm start` script runs `node main.js`. You can point the script at any other launcher that creates a `TwitchChatBot` instance.

4. **Deploy or keep-alive options**
   - Use a process manager such as `pm2`, Docker, or systemd to keep the bot online.
   - Remember to expose the media overlay port (`8910` by default) if you want to load the browser overlay in OBS or similar tools.

## Scripts

- **`addRewards.js`** – Automates adding channel point rewards to Twitch from `resources/mediaRewards.json`. It refreshes the API token, creates missing rewards on Twitch, and updates the JSON with their IDs. Run with `npm run add-rewards` after editing rewards. Requires valid Twitch API credentials in `main.js`.

## Configuration Files

All user-editable text and reward configuration is stored in the `resources/` folder:

- **`resources/greetings.txt`** – Greeting messages (one per line, `{user}` placeholder supported)
- **`resources/persona.txt`** – AI personality and behavior guidelines
- **`resources/lore.txt`** – Story elements and world-building for adventures
- **`resources/aliases.txt`** – Username-to-alias mappings (format `username:Alias Name`)
- **`resources/mediaRewards.json`** – Overlay reward mappings for channel redemptions (each reward has an `id` matching the Twitch reward ID, `title`, `cost`, and `action` for media playback; durations are detected automatically for videos and audio).

Runtime state (user memories, chat history, etc.) is still stored separately under `data/` when persistence is enabled.

## Command Reference

### Core Commands
- **`!aventura [theme] [difficulty]`** – Start an interactive adventure. Difficulty options: `fácil` (15% death), `normal` (35% death, default), `difícil` (55% death). Adventures are dynamic and can end at any time based on decisions and probability. Warning: the story may conclude unexpectedly—viewers should agree on the safest action.
- **`!poll "<question>" "option1" "option2" ["option3"] [duration_seconds]`** – Start a poll. Viewers vote with `!1`, `!2`, `!3`, etc. Duration defaults to 60 seconds. Max 10 options.
- **`!trivia`** – Generate a random trivia question (4 multiple-choice options: a, b, c, d). Viewers answer with `!a`, `!b`, etc. Reveals correct answer and winners after 30 seconds.
- **`!survive`** – Start a battle royale game. All connected users participate. Viewers write `!survive` to stay alive; last to write is eliminated after 2 minutes (+ 5s grace period).

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

## Credentials and Token Sources

Populate the fields in `CONFIG.twitch` and `CONFIG.ai` with secrets from the following locations:

- **Twitch Chat OAuth Token (`oauthToken`)** – Generate via https://twitchapps.com/tmi/ while logged in as your bot account, or use the IRC OAuth flow.
- **Twitch API App Credentials (`clientId`, `clientSecret`)** – Create an application at https://dev.twitch.tv/console/apps. Download the client secret once and store it securely.
- **Twitch API Access/Refresh Tokens (`apiToken`, `refreshToken`)** – Use the OAuth Authorization Code flow for your Twitch app to obtain app access tokens with the required scopes (`channel:read:redemptions` for EventSub channel points). Save the refresh token so the bot can renew automatically.
- **Groq API Key (`CONFIG.ai.groq.apiKey`)** – Create a key from the Groq console (https://console.groq.com/keys). Required for AI responses.

You can load these secrets from environment variables or a private JSON/YAML file before instantiating `TwitchChatBot` to avoid hardcoding them in source control.

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

#### Survive Game (`!survive`)
Battle royale-style game where the last user to write `!survive` is eliminated.

**Usage:**
```
!survive
```

**Features:**
- All connected users participate
- Duration: 2 minutes (+ 5s grace period for late entries)
- Last to write `!survive` is eliminated
- Shows winners and eliminated players at the end

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

- **Bot exits immediately** – Double-check that `CONFIG.twitch.*` tokens are valid and the bot account has channel access.
- **No AI replies** – Ensure Groq credentials are set and the chosen model is available.
- **Overlay not showing** – Open `http://localhost:8910/overlay` in OBS/browser and verify rewards are mapped in `mediaRewards.json`.
- **Games not starting** – Verify Groq API key is valid (used for trivia, adventures, and inactivity messages).
- **Adventure ends too quickly** – This is intentional on hard difficulty; probability of death increases with difficulty level.
- **No inactivity mentions** – Ensure users have been silent for 15+ minutes and check that `inactivityTracker` is running.

## Architecture Notes

For detailed architecture information, refer to `AGENTS.md`. The bot follows a modular design:

- **Game Managers** (`src/games/`) – Independent managers for polls, adventures, trivia, and survive game
- **Intelligence Modules** (`src/intelligence/`) – User memory, chat tracking, conversation threading, and inactivity tracking
- **Main Coordinator** (`src/twitch/twitchChatBot.js`) – Orchestrates all managers and handles Twitch IRC events

All new features integrate seamlessly with existing functionality. Data is persisted automatically to `data/` when enabled.
