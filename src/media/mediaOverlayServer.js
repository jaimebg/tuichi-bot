const fs = require("fs");
const path = require("path");
const http = require("http");
const { log } = require("../logger");

class MediaOverlayServer {
    constructor(config = {}) {
        this.enabled = !!config.enabled;
        this.host = config.host || "127.0.0.1";
        this.port = Number.isFinite(config.port) ? Number(config.port) : 8910;
        this.displayDurationMs = Number.isFinite(config.displayDurationMs) ? Number(config.displayDurationMs) : 12000;
        this.keepLastFrame = !!config.keepLastFrame;
        this.rewardIdMap = {};
        this.server = null;
        this.clients = new Set();
        this.keepAliveInterval = null;
        this.currentClearTimer = null;
        this.started = false;

        this.loadRewardConfig(config);
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

        // Removed name-based mapping, using only ID-based mapping
    }

    normalizeAction(action) {
        if (!action || typeof action !== "object" || !action.url) {
            return null;
        }
        const mediaType = typeof action.type === "string" ? action.type.toLowerCase() : null;
        const normalizedType = mediaType === "audio" ? "audio" : mediaType === "image" ? "image" : "video";
        const durationMs = Number.isFinite(action.durationMs) && action.durationMs > 0 ? Number(action.durationMs) : this.displayDurationMs;
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
            res.writeHead(200, {
                "Content-Type": "text/html",
                "Cache-Control": "no-cache",
                "Access-Control-Allow-Origin": "*"
            });
            res.end(this.buildOverlayHtml());
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

    scheduleClear(durationMs, shouldKeepVisible) {
        if (shouldKeepVisible) {
            return;
        }
        if (this.currentClearTimer) {
            clearTimeout(this.currentClearTimer);
        }
        const timeout = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : this.displayDurationMs;
        this.currentClearTimer = setTimeout(() => {
            this.clearDisplay();
        }, timeout);
    }

    clearDisplay() {
        this.currentClearTimer = null;
        this.broadcast({ type: "clear", timestamp: Date.now() });
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

        const payload = {
            type: "media",
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

        this.broadcast(payload);
        if (action.mediaType === 'image' || action.loop || persist) {
            this.scheduleClear(action.durationMs, action.loop || persist);
        }
        return true;
    }

    buildOverlayHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Media Overlay</title>
<style>
body { margin: 0; background: transparent; overflow: hidden; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; }
.media-container { position: relative; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
.media-container.hidden { display: none !important; }
.media-container.visible { display: flex; }
.media-element { max-width: 100%; max-height: 100%; object-fit: contain; }
#media-video { background: transparent; }
#media-image { background: transparent; }
#caption { position: absolute; bottom: 4vh; width: 100%; text-align: center; color: #fff; font-size: 2.2vw; text-shadow: 0 0 12px rgba(0,0,0,0.85); padding: 0 2vw; box-sizing: border-box; }
.hidden { display: none !important; }
audio { display: none; }
</style>
</head>
<body>
<div id="media-container" class="media-container hidden">
    <video id="media-video" class="media-element hidden" playsinline></video>
    <img id="media-image" class="media-element hidden" alt="">
    <audio id="media-audio"></audio>
    <div id="caption" class="hidden"></div>
</div>
<script>
(function() {
    const container = document.getElementById('media-container');
    const video = document.getElementById('media-video');
    const image = document.getElementById('media-image');
    const audio = document.getElementById('media-audio');
    const caption = document.getElementById('caption');
    let hideTimer = null;

    function reset() {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.loop = false;
        video.muted = false;
        video.volume = 1;
        video.classList.add('hidden');
        video.onended = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio.loop = false;
        audio.muted = false;
        audio.volume = 1;
        image.src = '';
        image.classList.add('hidden');
        caption.textContent = '';
        caption.classList.add('hidden');
        container.className = 'media-container hidden';
    }

    function applyCaptionTemplate(text, context) {
        return text
            .replace('{user}', context.userDisplayName || '')
            .replace('{reward}', context.rewardTitle || '')
            .replace('{input}', context.userInput || '');
    }

    function showContainer(cssClass) {
        container.className = 'media-container visible';
        if (cssClass) {
            cssClass.split(/\\s+/).forEach(cls => {
                if (cls) {
                    container.classList.add(cls);
                }
            });
        }
    }

    function scheduleHide(durationMs, keepVisible) {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
        if (keepVisible) {
            return;
        }
        hideTimer = setTimeout(() => {
            reset();
        }, durationMs > 0 ? durationMs : 5000);
    }

    function handleMedia(update) {
        const action = update.action || {};
        const context = update.context || {};
        const duration = Number(action.durationMs) > 0 ? Number(action.durationMs) : 5000;
        const persist = Boolean(action.persist || update.keepVisible);
        const keepVisible = Boolean(action.loop || persist);

        reset();
        showContainer(action.cssClass || '');

        if (action.caption) {
            caption.textContent = applyCaptionTemplate(action.caption, context);
            caption.classList.remove('hidden');
        }

        if (action.mediaType === 'audio') {
            audio.src = action.url;
            if (typeof action.volume === 'number') {
                audio.volume = action.volume;
            }
            audio.loop = !!action.loop;
            audio.muted = !!action.muted;
            audio.play().catch(() => {});
            audio.onended = () => {
                if (!keepVisible) {
                    reset();
                }
            };
        } else if (action.mediaType === 'image') {
            image.src = action.url;
            image.classList.remove('hidden');
            scheduleHide(duration, keepVisible);
        } else {
            video.src = action.url;
            video.loop = !!action.loop;
            video.muted = !!action.muted;
            if (typeof action.volume === 'number') {
                video.volume = action.volume;
            }
            video.autoplay = true;
            video.preload = 'auto';
            if (action.muted) {
                video.setAttribute('muted', '');
            } else {
                video.removeAttribute('muted');
            }
            video.setAttribute('playsinline', '');
            video.setAttribute('autoplay', '');
            video.classList.remove('hidden');
            const playPromise = video.play();
            if (playPromise && typeof playPromise.catch === 'function') {
                playPromise.catch((err) => {
                    console.warn('Failed to autoplay reward video:', err);
                });
            }
            video.onended = () => {
                if (!keepVisible) {
                    reset();
                }
            };
        }

        // scheduleHide(duration, keepVisible); // Removed, now handled per type
    }

    const source = new EventSource('events');

    source.onmessage = (event) => {
        if (!event.data) {
            return;
        }
        try {
            const payload = JSON.parse(event.data);
            if (payload.type === 'media') {
                handleMedia(payload);
            } else if (payload.type === 'clear') {
                reset();
            }
        } catch (_) {
            // ignore
        }
    };

    source.addEventListener('keepalive', () => {});
})();
</script>
</body>
</html>`;
    }
}

module.exports = MediaOverlayServer;
