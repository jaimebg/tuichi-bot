# AI Agent Guide

## Architecture Basics
- `main.js` is the only executable entry point; it builds a `CONFIG` object, resolves the `resources/` directory, then boots `TwitchChatBot`.
- Core behaviour lives in `src/twitch/twitchChatBot.js`; this class composes helpers from:
  - `src/intelligence/` for user memory, recent chat, and threaded conversations.
  - `src/persistence/dataPersistence.js` for JSON saves under `data/`.
  - `src/media/mediaOverlayServer.js` for the SSE overlay.
  - `src/twitch/channelPointsWatcher.js` for EventSub channel point redemptions.
- Logging is centralised in `src/logger.js`; always call `setLogLevel` before instantiating the bot to keep `isDebugEnabled()` aligned.

## Static Content & Secrets
- All editable text/JSON assets (greetings, persona, lore, aliases, reward map) now live in `resources/`. Update `main.js` if you introduce new files so agents use `RESOURCES_DIR`.
- Runtime state is persisted automatically to `data/` (created on demand). Never hardcode defaults into `src/intelligence`—they expect serialised Maps/Sets via the persistence helpers.
- Replace the placeholder Twitch/Groq secrets in `main.js` before shipping. Prefer reading environment variables inside `CONFIG` so credentials stay out of version control.

## Working Patterns
- When adding new bot features, extend `TwitchChatBot` methods and wire additional helpers via its constructor; avoid requiring modules directly from `main.js`.
- Always clamp or normalise outbound chat text using `src/utils/text.js` helpers—existing flows rely on `normalizeWhitespace` and `clampResponseLength`.
- Channel point integrations should register new reward mappings in `resources/mediaRewards.json`; `mediaOverlayServer` auto-loads that file at start.

## Developer Workflow
- Install dependencies with `npm install`; run the bot locally using `npm start` (alias for `node main.js`).
- No automated tests exist; sanity-check syntax with `node --check main.js` when Node is available, and exercise flows by connecting to a test Twitch channel.
- If persistence is enabled, ensure the `data/` folder is writable to avoid silent downgrades (the persistence module logs a warning and disables itself otherwise).

## External Integrations
- The bot consumes Twitch IRC via `tmi.js`, Twitch EventSub WebSockets via `ws`, and Groq Chat Completions (OpenAI-compatible schema). Respect the existing error-handling pattern: capture errors, log via `log("warn" | "error", ...)`, and continue gracefully.
- The overlay server listens on `CONFIG.mediaOverlay.port` (default 8910). Remember to update both the config and `README.md` if you change host/port defaults so streamers can adjust OBS/browser sources.

Please review these notes after significant architectural changes and keep them in sync. Let me know if any section is unclear or missing context so we can iterate.
