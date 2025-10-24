const fetch = require("node-fetch");
const WebSocket = require("ws");
const { log } = require("../logger");

class ChannelPointsWatcher {
    constructor(config = {}, onRedeem) {
        this.clientId = config.clientId;
        this.accessToken = config.accessToken;
        this.accessTokenProvider = typeof config.getAccessToken === "function" ? config.getAccessToken : null;
        this.accessTokenRefresher = typeof config.refreshAccessToken === "function" ? config.refreshAccessToken : null;
        this.channelLogin = config.channelLogin;
        this.reconnectBaseMs = Number.isFinite(config.reconnectBaseMs) ? Number(config.reconnectBaseMs) : 5000;
        this.maxReconnectMs = Number.isFinite(config.maxReconnectMs) ? Number(config.maxReconnectMs) : 60000;
        this.keepaliveGraceMs = Number.isFinite(config.keepaliveGraceMs) ? Number(config.keepaliveGraceMs) : 15000;
        this.onRedeem = typeof onRedeem === "function" ? onRedeem : null;

        this.socketUrl = "wss://eventsub.wss.twitch.tv/ws";
        this.ws = null;
        this.started = false;
        this.broadcasterId = null;
        this.sessionId = null;
        this.keepaliveTimeoutMs = 0;
        this.keepaliveTimer = null;
        this.reconnectTimer = null;
        this.reconnectUrl = null;
        this.currentReconnectDelay = this.reconnectBaseMs;
        this.subscriptionCreated = false;
        this.pendingSubscription = false;
    }

    async resolveAccessToken() {
        if (typeof this.accessTokenProvider === "function") {
            try {
                const provided = this.accessTokenProvider();
                const token = provided instanceof Promise ? await provided : provided;
                if (typeof token === "string" && token.trim()) {
                    this.accessToken = token.trim();
                    return this.accessToken;
                }
            } catch (err) {
                log("warn", `Channel points watcher failed to get access token: ${err.message}`);
            }
        }
        if (typeof this.accessToken === "string" && this.accessToken.trim()) {
            this.accessToken = this.accessToken.trim();
            return this.accessToken;
        }
        return null;
    }

    async refreshAccessTokenIfAvailable() {
        if (typeof this.accessTokenRefresher !== "function") {
            return false;
        }
        try {
            const result = await this.accessTokenRefresher();
            if (typeof result === "string" && result.trim()) {
                this.accessToken = result.trim();
                return true;
            }
            if (result) {
                const token = await this.resolveAccessToken();
                return typeof token === "string" && token.length > 0;
            }
        } catch (err) {
            log("warn", `Channel points watcher failed to refresh access token: ${err.message}`);
        }
        return false;
    }

    async fetchWithAuthRetry(makeRequest) {
        let token = await this.resolveAccessToken();
        if (!token) {
            log("warn", "Channel points watcher has no access token available.");
            return null;
        }
        let response = await makeRequest(token);
        if (response?.status === 429) {
            log("warn", "Received 429 (Too Many Requests) from Twitch API - rate limited");
            return response;
        }
        if (response?.status === 401) {
            const refreshed = await this.refreshAccessTokenIfAvailable();
            if (!refreshed) {
                return response;
            }
            token = await this.resolveAccessToken();
            if (!token) {
                return response;
            }
            response = await makeRequest(token);
        }
        return response;
    }

    async start() {
        if (this.started) {
            return;
        }
        const token = await this.resolveAccessToken();
        if (!token) {
            log("warn", "Channel points watcher is enabled but twitch.apiToken was not provided.");
            return;
        }
        if (!this.clientId) {
            log("warn", "Channel points watcher requires a Twitch clientId.");
            return;
        }
        this.started = true;
        this.currentReconnectDelay = this.reconnectBaseMs;
        try {
            await this.ensureBroadcasterId();
            if (!this.broadcasterId) {
                log("warn", "Unable to resolve broadcaster ID; channel points watcher not started.");
                this.started = false;
                return;
            }
            this.connect();
        } catch (err) {
            this.started = false;
            log("warn", `Failed to start channel points watcher: ${err.message}`);
        }
    }

    async stop() {
        this.started = false;
        this.sessionId = null;
        this.subscriptionCreated = false;
        this.pendingSubscription = false;
        this.reconnectUrl = null;
        this.currentReconnectDelay = this.reconnectBaseMs;
        this.clearKeepaliveTimer();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.terminate();
            } catch (_) {
                // ignore transport errors on shutdown
            }
            this.ws = null;
        }
    }

    async ensureBroadcasterId() {
        if (this.broadcasterId) {
            return this.broadcasterId;
        }
        const response = await this.fetchWithAuthRetry((token) =>
            fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(this.channelLogin)}`, {
                headers: {
                    "Client-Id": this.clientId,
                    Authorization: `Bearer ${token}`
                }
            })
        );
        if (!response) {
            throw new Error("Helix users request failed: missing access token");
        }
        if (!response.ok) {
            throw new Error(`Helix users request failed with status ${response.status}`);
        }
        const payload = await response.json();
        this.broadcasterId = payload?.data?.[0]?.id || null;
        return this.broadcasterId;
    }

    connect(url = null) {
        if (!this.started || !this.broadcasterId) {
            return;
        }
        if (this.ws) {
            try {
                this.ws.terminate();
            } catch (_) {
                // ignore
            }
            this.ws = null;
        }
        const targetUrl = url || this.socketUrl;
        log("info", `Connecting to Twitch EventSub at ${targetUrl}`);
        const ws = new WebSocket(targetUrl);
        this.ws = ws;

        ws.on("open", () => {
            log("info", "Connected to Twitch EventSub WebSocket.");
            this.currentReconnectDelay = this.reconnectBaseMs;
        });

        ws.on("message", (data) => {
            this.handleMessage(data);
        });

        ws.on("close", (code) => {
            this.handleSocketClose(code);
        });

        ws.on("error", (err) => {
            log("warn", `EventSub WebSocket error: ${err.message}`);
            // Log additional error codes for better diagnostics
            if (err.code === 'ECONNREFUSED') {
                log("warn", "Connection refused - Twitch EventSub server may be temporarily unavailable");
            } else if (err.code === 'ENOTFOUND') {
                log("warn", "DNS resolution failed - check network connectivity");
            }
        });
    }

    handleSocketClose(code) {
        this.clearKeepaliveTimer();
        this.ws = null;
        if (!this.started) {
            return;
        }

        // Map WebSocket close codes to meaningful messages
        let closeMessage = `EventSub WebSocket closed (code ${code ?? 0})`;
        let is429 = false;

        switch (code) {
            case 1000:
                closeMessage += " - Normal closure";
                break;
            case 1001:
                closeMessage += " - Going away";
                break;
            case 1002:
                closeMessage += " - Protocol error";
                break;
            case 1003:
                closeMessage += " - Unsupported data";
                break;
            case 4000:
                closeMessage += " - Unknown error";
                break;
            case 4001:
                closeMessage += " - Invalid message";
                break;
            case 4002:
                closeMessage += " - Session ID invalid";
                is429 = true; // Treat as rate limit to force longer wait
                break;
            case 4007:
                closeMessage += " - Policy violation (too many reconnects)";
                is429 = true; // Definitely rate limited
                break;
            case 4008:
                closeMessage += " - Message retry limit exceeded";
                break;
            case 4009:
                closeMessage += " - Connection unused";
                break;
            case 4010:
                closeMessage += " - Authorization failed";
                break;
            case 4011:
                closeMessage += " - Internal server error";
                break;
            case 4012:
                closeMessage += " - Stream temporarily unavailable";
                break;
            case 4013:
                closeMessage += " - Subscription version invalid";
                break;
            case 4014:
                closeMessage += " - User removed";
                break;
            case 4015:
                closeMessage += " - User authorization revoked";
                break;
            case 4016:
                closeMessage += " - Platform disconnected";
                break;
            case 4017:
                closeMessage += " - User account closed";
                break;
            case 4018:
                closeMessage += " - Client sent inbound traffic";
                break;
            case 4019:
                closeMessage += " - Client failed ping-pong";
                is429 = true; // Timeout, likely due to connection issues
                break;
            case 4020:
                closeMessage += " - Subscription query limit exceeded";
                is429 = true;
                break;
            case 4021:
                closeMessage += " - User account not allowed";
                break;
            default:
                break;
        }

        log("warn", `${closeMessage}. Scheduling reconnect.`);
        this.scheduleReconnect(is429);
    }

    handleMessage(message) {
        const text = typeof message === "string" ? message : message.toString("utf8");
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            log("debug", `Failed to parse EventSub message: ${err.message}`);
            return;
        }

        const messageType = parsed.metadata?.message_type;
        switch (messageType) {
            case "session_welcome":
                this.handleSessionWelcome(parsed.payload?.session);
                break;
            case "session_keepalive":
                this.resetKeepaliveTimer();
                break;
            case "session_reconnect":
                this.handleSessionReconnect(parsed.payload?.session?.reconnect_url);
                break;
            case "notification":
                this.handleNotification(parsed);
                break;
            case "revocation":
                this.handleRevocation(parsed);
                break;
            default:
                break;
        }
    }

    handleSessionWelcome(session) {
        if (!session) {
            return;
        }
        this.sessionId = session.id;
        this.reconnectUrl = null;
        this.subscriptionCreated = false;
        this.pendingSubscription = false;
        this.keepaliveTimeoutMs = Number.isFinite(session.keepalive_timeout_seconds)
            ? session.keepalive_timeout_seconds * 1000
            : 0;
        this.resetKeepaliveTimer();
        this.ensureSubscription();
    }

    handleSessionReconnect(reconnectUrl) {
        if (!reconnectUrl) {
            log("warn", "Received session_reconnect without URL; falling back to default endpoint.");
            this.scheduleReconnect();
            return;
        }
        log("info", `EventSub session requested reconnect to ${reconnectUrl}`);
        this.reconnectUrl = reconnectUrl;
        this.reconnect(true);
    }

    handleNotification(message) {
        const subscriptionType = message.payload?.subscription?.type;
        const event = message.payload?.event;
        if (subscriptionType !== "channel.channel_points_custom_reward_redemption.add" || !event) {
            return;
        }
        this.resetKeepaliveTimer();
        if (!this.onRedeem) {
            return;
        }
        const normalized = {
            id: event.id,
            reward: event.reward || {},
            user: {
                display_name: event.user_name || event.user_login || "",
                login: event.user_login || "",
                id: event.user_id || ""
            },
            user_input: event.user_input || "",
            redeemed_at: event.redeemed_at,
            status: event.status,
            originalEvent: event
        };
        try {
            this.onRedeem(normalized);
        } catch (err) {
            log("warn", `Error processing channel points redemption: ${err.message}`);
        }
    }

    handleRevocation(message) {
        const type = message.payload?.subscription?.type;
        const reason = message.payload?.subscription?.status;
        log("warn", `EventSub subscription revoked (${type || "unknown"}): ${reason || "no reason provided"}`);
        this.subscriptionCreated = false;
        this.ensureSubscription();
    }

    resetKeepaliveTimer() {
        this.clearKeepaliveTimer();
        if (!this.keepaliveTimeoutMs) {
            return;
        }
        const timeout = this.keepaliveTimeoutMs + this.keepaliveGraceMs;
        this.keepaliveTimer = setTimeout(() => {
            log("warn", "EventSub keepalive missed; reconnecting channel points watcher.");
            this.reconnect();
        }, timeout);
    }

    clearKeepaliveTimer() {
        if (this.keepaliveTimer) {
            clearTimeout(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
    }

    scheduleReconnect(is429Error = false) {
        if (!this.started) {
            return;
        }
        if (this.reconnectTimer) {
            return;
        }
        // If it's a 429 rate limit error, use a much longer delay
        let delay = Math.min(this.currentReconnectDelay, this.maxReconnectMs);
        if (is429Error) {
            delay = Math.max(delay, 30000); // At least 30 seconds for rate limit errors
            log("warn", `EventSub received 429 (rate limit). Waiting ${Math.round(delay / 1000)}s before reconnecting.`);
        } else {
            log("info", `Reconnecting to Twitch EventSub in ${Math.round(delay / 1000)}s`);
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            const target = this.reconnectUrl || this.socketUrl;
            this.connect(target);
        }, delay);

        // Use gentler exponential backoff (1.5x instead of 2x) to avoid aggressive reconnection
        this.currentReconnectDelay = Math.min(this.currentReconnectDelay * 1.5, this.maxReconnectMs);
    }

    reconnect(immediate = false) {
        this.clearKeepaliveTimer();
        if (this.ws) {
            try {
                this.ws.terminate();
            } catch (_) {
                // ignore
            }
            this.ws = null;
        }
        if (!this.started) {
            return;
        }
        this.subscriptionCreated = false;
        this.pendingSubscription = false;
        if (immediate) {
            this.currentReconnectDelay = this.reconnectBaseMs;
            const target = this.reconnectUrl || this.socketUrl;
            this.connect(target);
        } else {
            this.scheduleReconnect();
        }
    }

    async ensureSubscription() {
        if (!this.started || this.subscriptionCreated || this.pendingSubscription) {
            return;
        }
        if (!this.sessionId || !this.broadcasterId) {
            return;
        }
        this.pendingSubscription = true;
        try {
            const response = await this.fetchWithAuthRetry((token) =>
                fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
                    method: "POST",
                    headers: {
                        "Client-Id": this.clientId,
                        Authorization: `Bearer ${token}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        type: "channel.channel_points_custom_reward_redemption.add",
                        version: "1",
                        condition: {
                            broadcaster_user_id: this.broadcasterId
                        },
                        transport: {
                            method: "websocket",
                            session_id: this.sessionId
                        }
                    })
                })
            );

            if (!response) {
                throw new Error("Subscription request failed: missing access token");
            }

            if (response.status === 429) {
                log("warn", "Subscription request rate limited (429). Scheduling reconnect with longer delay.");
                this.pendingSubscription = false;
                this.scheduleReconnect(true);
                return;
            }

            if (response.status === 401) {
                log("warn", "Subscription failed with 401 - token may have expired. Attempting to refresh and reconnect.");
                this.pendingSubscription = false;
                this.subscriptionCreated = false;
                this.reconnect();
                return;
            }

            if (response.status === 409) {
                log("info", "Channel points EventSub subscription already exists for this session.");
                this.subscriptionCreated = true;
                return;
            }

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Subscription request failed (${response.status}): ${errorText}`);
            }

            const payload = await response.json();
            const subscriptionId = payload?.data?.[0]?.id;
            if (subscriptionId) {
                log("info", `EventSub channel points subscription ready (${subscriptionId}).`);
            } else {
                log("info", "EventSub channel points subscription accepted.");
            }
            this.subscriptionCreated = true;
        } catch (err) {
            log("warn", `Failed to create EventSub subscription: ${err.message}`);
            this.scheduleReconnect();
        } finally {
            this.pendingSubscription = false;
        }
    }
}

module.exports = ChannelPointsWatcher;
