# TuichiBot

A sophisticated Node.js Twitch chat bot for the `jaimevarecto` channel, featuring AI-powered interactions, interactive adventures, and intelligent user engagement.

## Features

### Core Functionality
- **Smart Greetings**: Welcomes new viewers with customizable messages, skipping those who chat first
- **AI Chat Responses**: Responds to @mentions and replies using Groq AI with user memory and context
- **Interactive Adventures**: Start story-driven adventures with `!aventura [theme] [rounds]` where viewers vote on choices
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

- **`!aventura [theme] [rounds]`** – Start an adventure. `rounds` is optional (default 3; capped by config).
- **`!1`**, **`!2`** – Vote for options during an active adventure.

## Project Structure

- `main.js` – Minimal bootstrapper that loads config files and starts the bot (used by `npm start`).
- `addRewards.js` – Utility script to create and sync channel point rewards with Twitch API.
- `src/logger.js` – Centralised logging with adjustable levels.
- `src/config/loaders.js` – File loaders for greetings, persona, lore, aliases.
- `src/utils/text.js` – Common text helpers (whitespace normalisation, clamping).
- `src/persistence` – Data persistence layer for user memories, chat history, and bot state.
- `src/intelligence` – User memory, recent chat tracker, and conversation threading modules.
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

## Troubleshooting

- **Bot exits immediately** – Double-check that `CONFIG.twitch.*` tokens are valid and the bot account has channel access.
- **No AI replies** – Ensure Groq credentials are set and the chosen model is available.
- **Overlay not showing** – Open `http://localhost:8910/overlay` in OBS/browser and verify rewards are mapped in `mediaRewards.json`.

Feel free to adapt the module tree or swap out `main.js` with a custom launcher; the `TwitchChatBot` class only needs a valid config object to run.
