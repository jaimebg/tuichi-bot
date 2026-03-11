import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { log } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = path.join(__dirname, 'overlay');

class MediaOverlayServer {
    constructor(config = {}) {
        this.enabled = !!config.enabled;
        this.host = config.host || "127.0.0.1";
        this.port = Number.isFinite(config.port) ? Number(config.port) : 8910;
        this.displayDurationMs = Number.isFinite(config.displayDurationMs) ? Number(config.displayDurationMs) : 12000;
        this.keepLastFrame = !!config.keepLastFrame;
        this.rewardIdMap = {};
        this.rewardNameMap = {};
        this.server = null;
        this.clients = new Set();
        this.keepAliveInterval = null;
        this.currentClearTimer = null;
        this.started = false;
        this.queue = [];
        this.isPlaying = false;
        this.activePlaybackId = null;
        this.playbackCounter = 0;
        this.activeKeepVisible = false;
        this.activeMediaType = null;

        this.loadRewardConfig(config);
    }

    generatePlaybackId() {
        if (typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
        }
        this.playbackCounter += 1;
        if (this.playbackCounter > Number.MAX_SAFE_INTEGER) {
            this.playbackCounter = 1;
        }
        return `${Date.now()}-${this.playbackCounter}`;
    }

    setRewardMap(map) {
        if (!map || typeof map !== "object") {
            return;
        }
        const target = this.rewardIdMap;
        for (const [key, value] of Object.entries(map)) {
            const normalizedAction = this.normalizeAction(value);
            if (!key || !normalizedAction) {
                continue;
            }
            target[key] = normalizedAction;
        }
    }

    loadRewardConfig(config) {
        if (!config || typeof config !== "object") {
            return;
        }

        if (config.rewardMap) {
            this.setRewardMap(config.rewardMap);
        }

        const rewardEntries = [];

        if (Array.isArray(config.rewards)) {
            rewardEntries.push(...config.rewards);
        }

        if (typeof config.rewardsFile === "string" && config.rewardsFile.trim()) {
            const resolved = path.resolve(config.rewardsFile);
            try {
                const fileContents = fs.readFileSync(resolved, "utf8");
                if (!fileContents.trim()) {
                    log("warn", `Rewards file ${resolved} is empty.`);
                } else {
                    const parsed = JSON.parse(fileContents);
                    if (Array.isArray(parsed)) {
                        rewardEntries.push(...parsed);
                    } else if (parsed && Array.isArray(parsed.rewards)) {
                        rewardEntries.push(...parsed.rewards);
                    } else {
                        log("warn", `Rewards file ${resolved} must export an array or an object with a rewards array.`);
                    }
                }
            } catch (err) {
                log("warn", `Failed to load rewards file ${resolved}: ${err.message}`);
            }
        }

        if (!rewardEntries.length) {
            return;
        }

        for (const entry of rewardEntries) {
            this.registerRewardEntry(entry);
        }
    }

    registerRewardEntry(entry) {
        if (!entry || typeof entry !== "object") {
            return;
        }

        const actionConfig = entry.action || entry.media || entry.overlay;
        const normalizedAction = this.normalizeAction(actionConfig);
        if (!normalizedAction) {
            return;
        }

        const rewardId = typeof entry.id === "string" && entry.id.trim()
            ? entry.id.trim()
            : typeof entry.rewardId === "string" && entry.rewardId.trim()
                ? entry.rewardId.trim()
                : null;
        if (rewardId) {
            this.rewardIdMap[rewardId] = normalizedAction;
        }

        const title = typeof entry.title === "string" && entry.title.trim()
            ? entry.title.trim().toLowerCase()
            : null;
        if (title) {
            this.rewardNameMap[title] = normalizedAction;
        }
    }

    normalizeAction(action) {
        if (!action || typeof action !== "object" || !action.url) {
            return null;
        }
        const mediaType = typeof action.type === "string" ? action.type.toLowerCase() : null;
        const normalizedType = mediaType === "audio" ? "audio" : mediaType === "image" ? "image" : "video";
        const hasExplicitDuration = Number.isFinite(action.durationMs) && action.durationMs > 0;
        let durationMs = hasExplicitDuration ? Number(action.durationMs) : null;
        if (!hasExplicitDuration && normalizedType === "image") {
            durationMs = this.displayDurationMs;
        }
        const hasVolume = Number.isFinite(action.volume);
        const volume = hasVolume
            ? Math.min(Math.max(action.volume, 0), 1)
            : normalizedType === "audio" || normalizedType === "video"
                ? 1
                : null;

        return {
            mediaType: normalizedType,
            url: action.url,
            durationMs,
            loop: !!action.loop,
            muted: !!action.muted,
            volume,
            cssClass: typeof action.cssClass === "string" ? action.cssClass : "",
            caption: typeof action.caption === "string" ? action.caption : "",
            persist: !!(action.keepVisible || action.persist)
        };
    }

    async start() {
        if (!this.enabled || this.started) {
            return;
        }
        await new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => this.handleRequest(req, res));
            const onError = (err) => {
                if (!this.started) {
                    reject(err);
                } else {
                    log("warn", `Media overlay server error: ${err.message}`);
                }
            };
            server.once("error", onError);
            server.listen(this.port, this.host, () => {
                server.off("error", onError);
                this.server = server;
                this.started = true;
                this.startKeepAlive();
                log("info", `Media overlay server ready at http://${this.host}:${this.port}/overlay`);
                resolve();
            });
        }).catch((err) => {
            log("warn", `Failed to start media overlay server: ${err.message}`);
        });
    }

    async stop() {
        this.stopKeepAlive();
        if (this.currentClearTimer) {
            clearTimeout(this.currentClearTimer);
            this.currentClearTimer = null;
        }
        for (const client of this.clients) {
            try {
                client.end();
            } catch (err) {
                log("debug", `Error closing overlay client: ${err.message}`);
            }
        }
        this.clients.clear();
        if (this.server) {
            await new Promise((resolve) => this.server.close(resolve));
            this.server = null;
        }
        this.started = false;
    }

    handleRequest(req, res) {
        const url = new URL(req.url, `http://${req.headers.host || `${this.host}:${this.port}`}`);
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/overlay")) {
            const html = fs.readFileSync(path.join(OVERLAY_DIR, 'index.html'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
            res.end(html);
            return;
        }
        if (req.method === "GET" && url.pathname === "/overlay.css") {
            const css = fs.readFileSync(path.join(OVERLAY_DIR, 'overlay.css'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/css', 'Access-Control-Allow-Origin': '*' });
            res.end(css);
            return;
        }
        if (req.method === "GET" && url.pathname === "/overlay.js") {
            const js = fs.readFileSync(path.join(OVERLAY_DIR, 'overlay.js'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' });
            res.end(js);
            return;
        }
        if (req.method === "POST" && url.pathname === "/events") {
            this.handleOverlayEvent(req, res);
            return;
        }
        if (req.method === "GET" && url.pathname === "/events") {
            this.startEventStream(req, res);
            return;
        }
        if (req.method === "GET" && url.pathname === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
    }

    startEventStream(req, res) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*"
        });
        res.write("\n");
        this.clients.add(res);

        const removeClient = () => {
            this.clients.delete(res);
        };

        req.on("close", removeClient);
        res.on("close", removeClient);

        this.broadcast({ type: "ready", timestamp: Date.now() });
    }

    startKeepAlive() {
        if (this.keepAliveInterval) {
            return;
        }
        this.keepAliveInterval = setInterval(() => {
            if (!this.clients.size) {
                return;
            }
            this.broadcast({}, "keepalive");
        }, 20000);
    }

    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    broadcast(payload, eventName = null) {
        if (!this.clients.size) {
            return;
        }
        let serialized;
        try {
            serialized = JSON.stringify(payload);
        } catch (err) {
            log("warn", `Failed to serialize overlay payload: ${err.message}`);
            return;
        }
        const data = eventName ? `event: ${eventName}\ndata: ${serialized}\n\n` : `data: ${serialized}\n\n`;
        for (const client of Array.from(this.clients)) {
            try {
                client.write(data);
            } catch (err) {
                this.clients.delete(client);
                try {
                    client.end();
                } catch (_) {
                    // ignore
                }
            }
        }
    }

    scheduleFallbackClear(playbackId, durationMs, shouldKeepVisible, mediaType = null) {
        if (shouldKeepVisible) {
            return;
        }
        if (this.currentClearTimer) {
            clearTimeout(this.currentClearTimer);
        }
        let timeout = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
        if (!timeout) {
            if (mediaType === "image") {
                timeout = this.displayDurationMs;
            } else {
                const longFallback = this.displayDurationMs * 10;
                timeout = Number.isFinite(longFallback) && longFallback > 0 ? Math.max(longFallback, 300000) : 300000;
            }
        }
        this.currentClearTimer = setTimeout(() => {
            this.handlePlaybackTimeout(playbackId);
        }, timeout);
    }

    handlePlaybackTimeout(playbackId) {
        if (!this.isPlaying) {
            return;
        }
        if (this.activePlaybackId && playbackId && playbackId !== this.activePlaybackId) {
            return;
        }
        log("debug", `Media overlay playback ${playbackId || "unknown"} reached fallback timeout.`);
        this.clearDisplay("timeout");
    }

    clearDisplay(reason = "clear") {
        if (this.currentClearTimer) {
            clearTimeout(this.currentClearTimer);
            this.currentClearTimer = null;
        }
        const shouldBroadcastClear = !this.activeKeepVisible || reason !== "complete";
        if (shouldBroadcastClear) {
            const payload = {
                type: "clear",
                timestamp: Date.now(),
                reason
            };
            if (this.activePlaybackId) {
                payload.playbackId = this.activePlaybackId;
            }
            this.broadcast(payload);
        }
        this.isPlaying = false;
        this.activePlaybackId = null;
        this.activeKeepVisible = false;
        this.activeMediaType = null;
        this.processQueue();
    }

    processQueue() {
        if (this.isPlaying || this.queue.length === 0) {
            return;
        }
        const item = this.queue.shift();
        if (!item.id) {
            item.id = this.generatePlaybackId();
        }
        const action = item.action || {};
        this.isPlaying = true;
        this.activePlaybackId = item.id;
        this.activeKeepVisible = Boolean(action?.loop || item.keepVisible);
        this.activeMediaType = action.mediaType || null;
        this.broadcast(item);
        this.scheduleFallbackClear(item.id, action.durationMs, action.loop || item.keepVisible, this.activeMediaType);
    }

    handlePlaybackComplete(playbackId) {
        if (!this.isPlaying) {
            return false;
        }
        if (this.activePlaybackId && playbackId && playbackId !== this.activePlaybackId) {
            log("debug", `Received playbackComplete for stale playback ${playbackId}`);
            return false;
        }
        this.clearDisplay("complete");
        return true;
    }

    handlePlaybackInfo(playbackId, info = {}) {
        if (!this.isPlaying) {
            return false;
        }
        if (this.activePlaybackId && playbackId && playbackId !== this.activePlaybackId) {
            return false;
        }
        const durationMs = Number(info.durationMs);
        if (!Number.isFinite(durationMs) || durationMs <= 0) {
            return false;
        }
        const bufferMs = Number.isFinite(info.bufferMs) ? Number(info.bufferMs) : 750;
        this.scheduleFallbackClear(playbackId || this.activePlaybackId, durationMs + bufferMs, this.activeKeepVisible, this.activeMediaType);
        return true;
    }

    handleOverlayEvent(req, res) {
        let rawBody = "";
        req.on("data", (chunk) => {
            rawBody += chunk.toString("utf8");
            if (rawBody.length > 1_048_576) {
                rawBody = "";
                try {
                    res.writeHead(413, {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*"
                    });
                    res.end(JSON.stringify({ error: "Payload too large" }));
                } catch (_) {
                    // ignore
                } finally {
                    req.destroy();
                }
            }
        });
        req.on("end", () => {
            if (!res.writableEnded) {
                let payload = null;
                if (rawBody.trim()) {
                    try {
                        payload = JSON.parse(rawBody);
                    } catch (err) {
                        res.writeHead(400, {
                            "Content-Type": "application/json",
                            "Access-Control-Allow-Origin": "*"
                        });
                        res.end(JSON.stringify({ error: "Invalid JSON body" }));
                        return;
                    }
                } else {
                    payload = {};
                }

                const type = payload?.type;
                if (type === "playbackComplete") {
                    this.handlePlaybackComplete(payload?.id || null);
                    res.writeHead(204, {
                        "Access-Control-Allow-Origin": "*"
                    });
                    res.end();
                    return;
                }
                if (type === "playbackInfo") {
                    const applied = this.handlePlaybackInfo(payload?.id || null, payload || {});
                    res.writeHead(applied ? 204 : 202, {
                        "Access-Control-Allow-Origin": "*"
                    });
                    res.end();
                    return;
                }

                res.writeHead(400, {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                });
                res.end(JSON.stringify({ error: "Unsupported overlay event type" }));
            }
        });
        req.on("error", (err) => {
            log("debug", `Overlay event request error: ${err.message}`);
            if (!res.writableEnded) {
                res.writeHead(500, {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                });
                res.end(JSON.stringify({ error: "Server error" }));
            }
        });
    }

    getActionForRedemption(redemption) {
        if (!redemption || !redemption.reward) {
            return null;
        }
        if (redemption.reward.id && this.rewardIdMap[redemption.reward.id]) {
            return this.rewardIdMap[redemption.reward.id];
        }
        const title = typeof redemption.reward.title === "string" ? redemption.reward.title.toLowerCase() : null;
        if (title && this.rewardNameMap[title]) {
            return this.rewardNameMap[title];
        }
        return null;
    }

    triggerReward(redemption) {
        if (!this.enabled) {
            return false;
        }
        const action = this.getActionForRedemption(redemption);
        if (!action) {
            return false;
        }

        const persist = action.persist || this.keepLastFrame;
        const actionPayload = {
            ...action,
            persist
        };
        const playbackId = this.generatePlaybackId();

        const payload = {
            type: "media",
            id: playbackId,
            action: actionPayload,
            context: {
                rewardId: redemption.reward?.id || null,
                rewardTitle: redemption.reward?.title || null,
                userDisplayName: redemption.user?.display_name || redemption.user?.login || null,
                userInput: redemption.user_input || "",
                redeemedAt: redemption.redeemed_at || new Date().toISOString()
            },
            keepVisible: persist,
            timestamp: Date.now()
        };

        this.queue.push(payload);
        this.processQueue();
        return true;
    }

    triggerByTitle(title, userDisplayName = null) {
        if (!this.enabled || !title) {
            return false;
        }
        const action = this.rewardNameMap[title.toLowerCase()];
        if (!action) {
            return false;
        }

        const persist = action.persist || this.keepLastFrame;
        const actionPayload = {
            ...action,
            persist
        };
        const playbackId = this.generatePlaybackId();

        const payload = {
            type: "media",
            id: playbackId,
            action: actionPayload,
            context: {
                rewardId: null,
                rewardTitle: title,
                userDisplayName,
                userInput: "",
                redeemedAt: new Date().toISOString()
            },
            keepVisible: persist,
            timestamp: Date.now()
        };

        this.queue.push(payload);
        this.processQueue();
        return true;
    }

}

export { MediaOverlayServer };
