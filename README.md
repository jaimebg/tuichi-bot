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

## Installation

1. **Clone and install**:
   ```bash
   git clone <repository-url>
   cd tuichi-bot
   npm install
   ```

2. **Configure** in `bot.js`:
   - Set your Twitch bot username and OAuth token
   - Add Groq API key for AI features
   - Adjust other settings as needed

3. **Run**:
   ```bash
   npm start
   ```

## Configuration Files

- **`greetings.txt`**: Greeting messages (one per line, use `{user}` placeholder)
- **`persona.txt`**: AI personality and behavior guidelines
- **`lore.txt`**: Story elements and world-building for adventures
- **`aliases.txt`**: Username-to-alias mappings (format: `username:Alias Name`)

## Commands

- **`!aventura [theme] [rounds]`**: Start an interactive adventure (default 3 rounds)
- **`!1`** or **`!2`**: Vote during active adventures

## Requirements

- Node.js 16+
- Twitch bot account with chat permissions
- Groq API key (optional, for AI features)

## Dependencies

- `tmi.js`: Twitch IRC client
- `node-fetch`: HTTP requests
