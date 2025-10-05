# TuichiBot (jaimitadas_bot)

A sophisticated Node.js Twitch chat bot designed for the `jaimevarecto` channel. The bot provides intelligent viewer greetings, AI-powered chat interactions, and various engagement features to enhance the streaming experience.

## Features

### 🎯 Core Functionality
- **Smart Viewer Greetings**: Automatically greets new viewers joining the channel with customizable messages, but not if they write a message before being greeted
- **AI Chat Integration**: Responds to mentions and replies using Groq AI with conversation context and user memory
- **Single Word Echo**: Randomly repeats single-word messages to maintain chat engagement
- **User Intelligence**: Tracks user personality, engagement patterns, and conversation themes across sessions
- **Threaded Replies**: Uses Twitch's reply system for contextual AI responses
- **Data Persistence**: Saves user memories and conversation threads to maintain context across bot restarts

### 🤖 AI Features
- **User Memory System**: Tracks user personality traits, engagement patterns, and conversation themes
- **Conversation Threading**: Maintains conversation context across multiple exchanges
- **Recent Chat Context**: Uses recent channel activity to inform responses
- **Multiple Model Support**: Fallback system between different AI models
- **Rate Limiting**: User and global cooldowns prevent spam
- **Character Limits**: Configurable response length limits
- **Spanish Persona**: Configured for Spanish-speaking streams with specific personality
- **Intelligence Features**: Detects topic changes, tracks user activity patterns, and personalizes responses

### ⚙️ Technical Features
- **Persistent Connection**: Maintains stable Twitch IRC connection with auto-reconnect
- **Graceful Startup**: Ignores existing users during initial connection to prevent greeting spam
- **Smart Greeting Logic**: Users are greeted when they join, but not if they write a message first. They can be re-greeted if they leave and rejoin
- **Data Persistence**: Saves user memories, conversation threads, and bot state to local JSON files
- **Comprehensive Logging**: Configurable log levels for debugging and monitoring
- **Error Handling**: Robust error handling with model fallbacks and retry logic
- **Memory Management**: Automatic cleanup of old user data and conversation threads

## Prerequisites

- **Node.js 16+**
- **Twitch Bot Account** (e.g., `jaimitadas_bot`)
- **OAuth Token** for the bot account
- **Groq API Key** for AI features (optional but recommended)

## Installation

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd tuichi-bot
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure the bot** by editing the `CONFIG` object in `bot.js`:
   ```javascript
   const CONFIG = {
       twitch: {
           username: "your_bot_username",
           channel: "target_channel",
           oauthToken: "your_oauth_token"
       },
       ai: {
           groq: {
               apiKey: "your_groq_api_key"
           }
       }
   };
   ```

## Configuration

### Twitch Settings
```javascript
twitch: {
    username: "jaimitadas_bot",     // Bot's Twitch username
    channel: "jaimevarecto",        // Target channel to monitor
    oauthToken: "oauth_token_here"  // Bot's OAuth token
}
```

### Greeting Configuration
```javascript
greetings: {
    file: "greetings.txt",          // File containing greeting messages
    cooldownSeconds: 1              // Cooldown between greetings per user
}
```

### AI Configuration
```javascript
ai: {
    maxChars: 450,                  // Maximum response length
    historyLimit: 5,                // Messages to remember per user
    userCooldownSeconds: 1,         // Per-user AI response cooldown
    globalCooldownSeconds: 1,       // Global AI response cooldown
    groq: {
        apiKey: "your_api_key",
        baseUrl: "https://api.groq.com/openai/v1",
        models: [                   // Fallback model list
            "openai/gpt-oss-120b",
            "llama-3.3-70b-versatile"
        ],
        temperature: 0.7,
        timeoutMs: 20000,
        maxTokens: 10000
    }
}
```

### Behavior Settings
```javascript
singleWordEchoChance: 0.08,         // 8% chance to echo single words
singleWordEchoDelayMs: 1500,        // Delay before echoing
logLevel: "info"                    // Logging level (debug, info, warn, error)
```

### Data Storage
The bot creates a `data/` directory to persist:
- **User memories**: Personality traits, engagement patterns, conversation themes
- **Recent chat**: Recent messages for context
- **Conversation threads**: Ongoing conversation contexts
- **Bot state**: Greeted users, current topics, and other state information

## File Structure

### Required Files

#### `greetings.txt`
Contains greeting messages, one per line. Use `{user}` as a placeholder for the username:
```
🚨 oop te pillé conectada {user} ARRANCA
🚨 venga guapa te pillé dentro {user}
🚨 eh {user} sabía que aparecerías por aquí xdding
```

#### `persona.txt`
Defines the AI's personality and behavior:
```
Eres "jaimitadas_bot", el asistente oficial del canal de Twitch de "JaimeVaRecto".
En stream jugamos a Beat Saber.
Mantén un tono juguetón, cercano y grosero, refierete a todo el mundo en femenino.
Habla siempre en castellano europeo, sin modismos latinoamericanos.
```

## Running the Bot

Start the bot with:
```bash
npm start
```

The bot will:
1. Connect to Twitch IRC
2. Join the configured channel
3. Begin monitoring for new viewers and chat activity
4. Respond to greetings and AI interactions based on configuration

Stop the bot with `Ctrl+C` or `SIGTERM`.

## Token Setup Guide

### Getting OAuth Token for the Bot

1. **Create Twitch Application**:
   - Go to https://dev.twitch.tv/console/apps
   - Create a new application or select existing one
   - Add redirect URL: `http://localhost:3000/auth/twitch`
   - Note your `Client ID` and `Client Secret`

2. **Generate User OAuth Token** (for chat access):
   - Replace `YOUR_CLIENT_ID` in this URL:
   ```
   https://id.twitch.tv/oauth2/authorize?response_type=token&client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:3000/auth/twitch&scope=chat:read+chat:edit
   ```
   - Open URL in private browser tab (logged in as bot account)
   - Authorize the application
   - Copy the `access_token` from the redirect URL fragment
   - Add to config with `oauth:` prefix: `oauth:YOUR_ACCESS_TOKEN`

3. **Generate App Access Token** (for API calls):
   ```bash
   curl -X POST 'https://id.twitch.tv/oauth2/token' \
     -H 'Content-Type: application/x-www-form-urlencoded' \
     -d 'client_id=YOUR_CLIENT_ID' \
     -d 'client_secret=YOUR_CLIENT_SECRET' \
     -d 'grant_type=client_credentials'
   ```
   
   Or use browser console:
   ```javascript
   fetch("https://id.twitch.tv/oauth2/token", {
     method: "POST",
     headers: { "Content-Type": "application/x-www-form-urlencoded" },
     body: new URLSearchParams({
       client_id: "YOUR_CLIENT_ID",
       client_secret: "YOUR_CLIENT_SECRET",
       grant_type: "client_credentials"
     })
   }).then(r => r.json()).then(console.log).catch(console.error);
   ```

### Getting Groq API Key

1. Visit https://console.groq.com/keys
2. Create a new API key
3. Copy the key for use in configuration

**Security Note**: Always keep your tokens and API keys private. Rotate client secrets after exposure and never commit sensitive data to version control.

## Code Architecture

### Class Structure

#### `TwitchChatBot`
Main bot class that handles all functionality:

**Constructor Parameters**:
- `username`: Bot's Twitch username
- `channel`: Target channel to monitor
- `token`: OAuth token for authentication
- `messages`: Array of greeting messages
- `persona`: AI personality configuration
- `groqConfig`: Groq API configuration
- `greeting`: Greeting behavior settings
- `singleWordEchoChance`: Probability of echoing single words
- `ai`: AI response configuration
- `intelligence`: Intelligence and persistence settings

**Key Properties**:
- `client`: TMI.js client instance
- `presentUsers`: Set of currently present users
- `userHasChatted`: Set of users who have written messages (session-only)
- `greetedUsers`: Map tracking greeting timestamps (persistent)
- `conversationHistory`: Per-user conversation context
- `userMemory`: User intelligence and personality tracking
- `recentChat`: Recent channel messages for context
- `conversationThreads`: Threaded conversation management
- `pendingAIRequests`: Set of users with pending AI requests

### Core Methods

#### Connection Management
- `start()`: Initializes connection to Twitch IRC
- `shutdown()`: Gracefully disconnects and cleans up
- `registerHandlers()`: Sets up event listeners

#### User Management
- `handleJoin(channel, username, self)`: Processes user join events
- `handlePart(channel, username, self)`: Processes user leave events (resets chat status)
- `handleInitialNames(channel, users)`: Handles initial user list

#### Greeting System
- `scheduleGreeting(username)`: Determines if user should be greeted (checks if they've chatted)
- `sendGreeting(username)`: Sends greeting message
- `pickGreeting(username)`: Selects random greeting template

#### Intelligence System
- `extractIntelligence(userKey, message)`: Analyzes messages for personality and themes
- `detectTopicChanges()`: Monitors stream topic changes
- `loadPersistedData()`: Loads saved user data and state
- `saveData()`: Saves user memories and conversation data

#### AI Integration
- `handleMention(params)`: Processes mentions and replies
- `respondToMention(params)`: Generates and sends AI responses with full context
- `fetchGroqResponse(messages)`: Communicates with Groq API
- `buildAIChatMessages(params)`: Constructs conversation context with user memory and recent chat

#### Message Handling
- `handleMessage(channel, tags, message, self)`: Main message processor
- `handleSingleWordEcho(message, tags)`: Manages word echoing
- `sendMessage(message, replyToId)`: Sends messages with optional threading

### Utility Functions

#### File Operations
- `readTextFile(filePath, label)`: Safely reads text files
- `loadGreetings(filePath)`: Loads and validates greeting messages
- `loadPersona(filePath)`: Loads AI personality configuration

#### Text Processing
- `normalizeWhitespace(text)`: Cleans and normalizes text
- `clampResponseLength(text, maxChars)`: Truncates responses appropriately

#### Logging
- `log(level, ...args)`: Configurable logging system

### Configuration Object Structure

```javascript
const CONFIG = {
    logLevel: "info",                    // Logging verbosity
    twitch: {
        username: "bot_username",        // Bot account username
        channel: "target_channel",       // Channel to monitor
        oauthToken: "oauth_token"        // Authentication token
    },
    greetings: {
        file: "greetings.txt",           // Greeting messages file
        cooldownSeconds: 1               // Per-user greeting cooldown
    },
    persona: {
        file: "persona.txt"              // AI personality file
    },
    singleWordEchoChance: 0.08,          // Echo probability (0-1)
    singleWordEchoDelayMs: 1500,         // Echo delay in milliseconds
    intelligence: {
        recentChatLimit: 20,             // Recent messages to track
        userMemoryLimit: 100,            // Max users to remember
        conversationThreads: 10,         // Max conversation threads
        engagementTrackingDays: 7,       // Days to track engagement
        topicTrackingMinutes: 30,        // Topic change detection interval
        contextWindowMinutes: 10,        // Context window for messages
        persistence: {
            enabled: true,               // Enable data persistence
            dataDir: "data",             // Data directory
            files: {                     // File mappings
                userMemory: "userMemory.json",
                recentChat: "recentChat.json",
                conversationThreads: "conversationThreads.json",
                botState: "botState.json"
            },
            saveIntervalMinutes: 5       // Auto-save interval
        }
    },
    ai: {
        maxChars: 450,                   // Max response length
        historyLimit: 5,                 // Conversation memory depth
        userCooldownSeconds: 1,          // Per-user AI cooldown
        globalCooldownSeconds: 1,        // Global AI cooldown
        groq: {
            apiKey: "api_key",           // Groq API key
            baseUrl: "api_endpoint",     // API endpoint URL
            models: ["model1", "model2"], // Fallback model list
            temperature: 0.7,            // Response creativity
            timeoutMs: 20000,            // Request timeout
            maxTokens: 10000             // Max tokens per request
        }
    }
};
```

### Event Flow

1. **Startup**:
   - Load configuration files
   - Initialize bot instance
   - Connect to Twitch IRC
   - Request membership capability
   - Enter startup grace period

2. **User Join**:
   - Detect JOIN event
   - Check if user should be greeted (hasn't chatted yet)
   - Apply cooldown rules
   - Send greeting if appropriate
   - Update user tracking

3. **Message Processing**:
   - Receive chat message
   - Update user activity status (add to userHasChatted)
   - Extract personality traits and conversation themes
   - Update user engagement patterns
   - Check for single-word echo opportunity
   - Detect mentions or replies to bot
   - Generate AI response if triggered

4. **User Leave**:
   - Remove from present users
   - Reset chat status (allow re-greeting on rejoin)
   - Preserve user memory data

5. **AI Response**:
   - Build comprehensive conversation context
   - Include user memory, recent chat, and conversation threads
   - Call Groq API with fallback models
   - Process and truncate response
   - Send threaded reply
   - Update conversation history and threads

6. **Data Persistence**:
   - Auto-save user memories every 5 minutes
   - Save conversation threads and recent chat
   - Preserve bot state across restarts
   - Clean up old data automatically

### Dependencies

- **tmi.js**: Twitch IRC client library
- **node-fetch**: HTTP client for API calls  
- **fs**: File system operations
- **path**: File path utilities

### Performance Considerations

- **Memory Management**: Conversation history is limited per user
- **Rate Limiting**: Multiple cooldown systems prevent API abuse
- **Connection Stability**: Auto-reconnect with state preservation
- **Error Recovery**: Graceful degradation on API failures

This architecture provides a robust, scalable foundation for Twitch chat bot functionality with extensible AI integration.

## Bot Behavior

### Greeting System
- **New User Detection**: Monitors JOIN events to detect new viewers
- **Smart Greeting Logic**: 
  - Greets users when they join the channel
  - **Does NOT greet** if the user writes a message before being greeted
  - Users can be **re-greeted** if they leave and rejoin the channel
  - Prevents greeting spam while ensuring returning users are welcomed
- **Cooldown Management**: Prevents greeting the same user too frequently (configurable)
- **Startup Grace Period**: Ignores existing users for 5 seconds after connection to prevent mass greetings
- **Message Rotation**: Randomly selects from available greeting messages
- **User Filtering**: Ignores bot accounts and specified users

### AI Response System
- **Trigger Conditions**: Responds to @mentions or direct replies
- **Context Awareness**: 
  - Maintains conversation history per user
  - Uses recent chat context for better responses
  - Tracks user personality traits and preferences
  - Considers current stream topics and activities
- **User Intelligence**: 
  - Learns user personality (humorous, polite, enthusiastic, curious)
  - Tracks conversation themes (gaming, technology, music)
  - Remembers user engagement patterns and preferences
- **Rate Limiting**: Implements both per-user and global cooldowns
- **Model Fallback**: Tries multiple AI models if one fails
- **Response Threading**: Uses Twitch's reply feature for context
- **Persistent Memory**: Saves user data and conversation context across sessions

### Single Word Echo
- **Random Activation**: Configurable chance to repeat single-word messages
- **Delay System**: Optional delay before echoing
- **Smart Filtering**: Ignores commands (@, !) and bot replies

## API Integration

### Groq AI Integration
The bot integrates with Groq's API for AI responses:

- **Authentication**: Uses API key authentication
- **Model Selection**: Supports multiple models with automatic fallback
- **Error Handling**: Comprehensive error handling with detailed logging
- **Rate Limiting**: Respects API limits and implements backoff strategies

### Twitch IRC Integration
- **TMI.js Library**: Uses the official Twitch IRC library
- **Membership Capability**: Requests membership events for JOIN/PART detection
- **Raw Commands**: Supports raw IRC commands for advanced features
- **Auto-reconnect**: Automatically reconnects on connection loss

## Logging and Monitoring

### Log Levels
- **DEBUG**: Detailed operation information
- **INFO**: General operational messages
- **WARN**: Warning conditions and recoverable errors
- **ERROR**: Error conditions requiring attention

### Monitored Events
- Connection status and reconnections
- User join/part events
- Greeting delivery
- AI response generation
- Error conditions and fallbacks

## Error Handling

### Connection Resilience
- Automatic reconnection on disconnection
- Graceful handling of network timeouts
- State preservation during reconnects

### AI Response Handling
- Model fallback on API failures
- Timeout handling for slow responses
- Rate limit detection and backoff

### User State Management
- Persistent user tracking across reconnects
- Cleanup of stale user data
- Graceful handling of malformed messages

## Security Considerations

### Token Management
- OAuth tokens should be kept private
- Tokens should be rotated regularly
- No sensitive data should be logged

### Rate Limiting
- Implements Twitch's rate limits
- Prevents spam through cooldown systems
- Monitors for unusual activity patterns

## Troubleshooting

### Common Issues
1. **Connection failures**: Check OAuth token validity
2. **No greetings**: Verify channel name and bot permissions
3. **AI not responding**: Check Groq API key and quota
4. **High memory usage**: Reduce history limits and clean up old data

### Debug Mode
Enable debug logging by setting `logLevel: "debug"` in the configuration for detailed operational information.


## SETUP !!!
That endpoint only accepts POST; when you switch it to a raw GET you’ll get a 404. Stay with the POST flow (curl, Postman, Insomnia, or any REST client) and it will work.

If you want to do it right in the browser, you can open the console (F12 → Console tab) and run:

fetch("https://id.twitch.tv/oauth2/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: "***REMOVED-TWITCH-CLIENT-ID***",
    client_secret: "2czlgbx80hdz181045trrg20s7wcaa",
    grant_type: "client_credentials"
  })
}).then(r => r.json()).then(console.log).catch(console.error);
That will print the JSON payload in the console; grab the access_token and drop it into .env.

Because the secret has now been exposed, generate a new one in the Twitch dev console when you’re done and update your .env with that fresh value.

{access_token: '7s8z6zlnv43nlcy7fnq00a6arkd6b7', expires_in: 5666529, token_type: 'bearer'}


Great. Add this to your .env:

TWITCH_APP_ACCESS_TOKEN=7s8z6zlnv43nlcy7fnq00a6arkd6b7
Remember the token expires in about 65 days (expires_in: 5666529 seconds). You’ll need to repeat the client-credentials request when it expires—grab a fresh token and update the .env. Keep both the new access token and your client secret private; once you’re done testing, rotate the secret in the Twitch developer console and update your .env accordingly.

still missing TWITCH_OAUTH_TOKEN


User OAuth Token Steps

Go to https://dev.twitch.tv/console/apps, pick your app, and add a redirect URL you control (for a quick manual flow use http://localhost:3000/auth/twitch). Rotate the client secret afterwards because it’s already been shared.
In a PRIVATE browser tab (so you don’t leak the token), paste this URL with your values:
https://id.twitch.tv/oauth2/authorize?response_type=token&client_id=***REMOVED-TWITCH-CLIENT-ID***&redirect_uri=http://localhost:3000/auth/twitch&scope=chat:read+chat:edit
Log in as the bot account (jaimitadas_bot) and approve. You’ll be redirected to the redirect URI with a fragment like #access_token=...&....
Copy the access_token from that fragment, prefix it with oauth: and store it in .env:
TWITCH_OAUTH_TOKEN=oauth:PASTE_TOKEN_HERE