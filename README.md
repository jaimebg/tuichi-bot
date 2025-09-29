# jaimitadas_bot

Node.js-based Twitch chat bot that greets viewers who join `jaimevarecto` while the channel is live. Greetings rotate through configurable messages and respect a per-user cooldown to avoid spamming chat.

## Prerequisites
- Node.js 16+
- A Twitch account for the bot (e.g. `jaimitadas_bot`)
- OAuth token for the bot account (generate at https://twitchapps.com/tmi/)
- (Optional but recommended) Twitch application client ID and app access token so the bot can confirm whether the channel is live before greeting

## Setup
1. Clone/download this repository on the machine that will run the bot.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and populate the values:
   - `TWITCH_BOT_USERNAME`: Twitch username of the bot account
   - `TWITCH_CHANNEL`: Channel to monitor (e.g. `jaimevarecto`)
   - `TWITCH_OAUTH_TOKEN`: Chat OAuth token for the bot; include the `oauth:` prefix
   - `TWITCH_CLIENT_ID` / `TWITCH_APP_ACCESS_TOKEN` (optional): supply both if you want the bot to poll Twitch Helix to verify the channel is live before sending greetings

   To generate an app access token with your client ID and client secret:
   ```bash
   curl -X POST \
     'https://id.twitch.tv/oauth2/token' \
     -H 'Content-Type: application/x-www-form-urlencoded' \
     -d 'client_id=YOUR_CLIENT_ID' \
     -d 'client_secret=YOUR_CLIENT_SECRET' \
     -d 'grant_type=client_credentials'
   ```
   Copy the `access_token` value into `TWITCH_APP_ACCESS_TOKEN`.

## Running the bot
```bash
npm start
```

The bot will:
- Connect to Twitch IRC with membership capability so JOIN events are delivered
- Track which users have been greeted and respect the configured cooldown (`TWITCH_GREETING_COOLDOWN`, default 300 seconds)
- Randomly choose a message from `TWITCH_GREETING_MESSAGES` (pipe-delimited string); `{user}` is replaced with the viewer's name
- Optionally skip greetings unless the channel is live (requires `TWITCH_CLIENT_ID` and `TWITCH_APP_ACCESS_TOKEN`)
- Reply to chat mentions of `@jaimitadas_bot` (or replies to the bot) with an LLM-generated answer when configured

Stop the bot with `Ctrl+C`.

## Customisation
- Adjust the greetings by editing `TWITCH_GREETING_MESSAGES` in your `.env`.
- Modify timing behaviour with `TWITCH_GREETING_COOLDOWN` and `TWITCH_LIVE_CHECK_INTERVAL`.
- Use `TWITCH_BOT_LOG_LEVEL` (e.g. `DEBUG`) for more verbose logging during troubleshooting.
- Tweak `persona.txt` (or point `TWITCH_PERSONA_FILE` to your own file) to define how the bot habla en el chat.

## AI mention replies
Set up the AI response feature if you want the bot to answer whenever someone mentions `@jaimitadas_bot` or replies to the bot in chat.

When enabled, TuichiBot replies directly to the triggering message (Twitch threaded reply) instead of dropping a generic chat line.

### Option 1: Groq (hosted, free tier available)
1. Create an API key at https://console.groq.com/keys (the free tier is usually enough for casual usage).
2. Add these values to your `.env`:
   - `TWITCH_AI_PROVIDER=groq`
   - `GROQ_API_KEY=your_api_key_here`
   - (Optional) `GROQ_MODEL` to override the default `llama3-8b-8192`
3. Start the bot. You should see a log line confirming `AI replies enabled using provider groq`.

### Option 2: Ollama (local, zero cost)
1. Install and start Ollama from https://ollama.com/.
2. Pull a compatible chat model, for example `ollama pull phi3:mini`.
3. Update `.env` (or rely on defaults):
   - `TWITCH_AI_PROVIDER=ollama`
   - `OLLAMA_URL=http://127.0.0.1:11434`
   - `OLLAMA_MODEL=phi3:mini`
4. Run the bot with Ollama running in the background.

### Extra tuning
- `TWITCH_MENTION_COOLDOWN` (seconds, default 30) controls how often the bot will answer the same viewer.
- `TWITCH_GLOBAL_MENTION_COOLDOWN` (seconds, default 5) is a global throttle between AI replies.
- `TWITCH_MENTION_MAX_CHARS` caps the length of the generated reply (default 350 characters).
- `AI_REQUEST_TIMEOUT_MS` overrides the network timeout for the LLM call (falls back to 20000 ms).
- `GROQ_MODELS` (comma-separated) or `OLLAMA_MODELS` lets you define fallback models; the bot automatically tries the next model if one hits its rate limit or errors.

## Notes
- Ensure the bot account has followed the target channel so it can chat immediately when the stream is live.
- Run the bot only while you are streaming if you do not configure the live status check.
- Keep your OAuth and app tokens private. Do not commit them to source control.


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
