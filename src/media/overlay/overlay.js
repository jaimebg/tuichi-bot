(function() {
    const DEFAULT_MEDIA_TIMEOUT_MS = 10 * 60 * 1000;
    const container = document.getElementById('media-container');
    const video = document.getElementById('media-video');
    const image = document.getElementById('media-image');
    const audio = document.getElementById('media-audio');
    const caption = document.getElementById('caption');
    let hideTimer = null;
    let completionTimer = null;
    let currentPlaybackId = null;
    let hasNotifiedCompletion = false;
    let keepVisibleCurrent = false;
    let metadataFallbackTimer = null;
    let activeMediaType = null;

    function clearHideTimer() {
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    }

    function clearCompletionTimer() {
        if (completionTimer) {
            clearTimeout(completionTimer);
            completionTimer = null;
        }
    }

    function clearMetadataFallback() {
        if (metadataFallbackTimer) {
            clearTimeout(metadataFallbackTimer);
            metadataFallbackTimer = null;
        }
    }

    function reset() {
        clearHideTimer();
        clearCompletionTimer();
        clearMetadataFallback();
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.loop = false;
        video.muted = false;
        video.volume = 1;
        video.classList.add('hidden');
        video.onended = null;
        video.onloadedmetadata = null;
        video.onerror = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio.loop = false;
        audio.muted = false;
        audio.volume = 1;
        audio.onended = null;
        audio.onloadedmetadata = null;
        audio.onerror = null;
        image.src = '';
        image.classList.add('hidden');
        caption.textContent = '';
        caption.classList.add('hidden');
        container.className = 'media-container hidden';
        currentPlaybackId = null;
        hasNotifiedCompletion = false;
        keepVisibleCurrent = false;
        activeMediaType = null;
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
            cssClass.split(/\s+/).forEach(cls => {
                if (cls) {
                    container.classList.add(cls);
                }
            });
        }
    }

    function scheduleHide(durationMs) {
        clearHideTimer();
        if (keepVisibleCurrent) {
            return;
        }
        const timeout = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 5000;
        hideTimer = setTimeout(() => {
            if (!hasNotifiedCompletion) {
                notifyPlaybackComplete('timeout');
            }
            reset();
        }, timeout);
    }

    function scheduleCompletion(durationMs) {
        if (!currentPlaybackId) {
            return;
        }
        clearCompletionTimer();
        const timeout = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 5000;
        completionTimer = setTimeout(() => {
            notifyPlaybackComplete('timeout');
        }, timeout + 250);
    }

    function scheduleMetadataFallback(fallbackDurationMs) {
        clearMetadataFallback();
        if (!Number.isFinite(fallbackDurationMs) || fallbackDurationMs <= 0) {
            return;
        }
        metadataFallbackTimer = setTimeout(() => {
            metadataFallbackTimer = null;
            if (!hasNotifiedCompletion) {
                notifyPlaybackInfo(fallbackDurationMs);
                scheduleCompletion(fallbackDurationMs);
            }
        }, 1500);
    }

    function postOverlayEvent(payload) {
        if (!payload || typeof payload !== 'object') {
            return;
        }
        fetch('events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true
        }).catch(() => {});
    }

    function notifyPlaybackComplete(reason) {
        if (!currentPlaybackId || hasNotifiedCompletion) {
            return;
        }
        hasNotifiedCompletion = true;
        clearCompletionTimer();
        clearMetadataFallback();
        const payload = { type: 'playbackComplete', id: currentPlaybackId };
        if (reason) {
            payload.reason = reason;
        }
        postOverlayEvent(payload);
    }

    function notifyPlaybackInfo(durationMs) {
        if (!currentPlaybackId) {
            return;
        }
        if (!Number.isFinite(durationMs) || durationMs <= 0) {
            return;
        }
        postOverlayEvent({
            type: 'playbackInfo',
            id: currentPlaybackId,
            durationMs: durationMs,
            bufferMs: 750
        });
    }

    function handleMedia(update) {
        const action = update.action || {};
        const context = update.context || {};
        const configuredDuration = Number(action.durationMs);
        const duration = Number.isFinite(configuredDuration) && configuredDuration > 0 ? configuredDuration : null;
        const persist = Boolean(action.persist || update.keepVisible);
        const keepVisible = Boolean(action.loop || persist);

        reset();
        currentPlaybackId = update.id || null;
        hasNotifiedCompletion = false;
        activeMediaType = action.mediaType || null;
        const isTimedMedia = activeMediaType === 'audio' || activeMediaType === 'video';
        keepVisibleCurrent = keepVisible || isTimedMedia;
        showContainer(action.cssClass || '');

        if (action.caption) {
            caption.textContent = applyCaptionTemplate(action.caption, context);
            caption.classList.remove('hidden');
        }

        if (action.mediaType === 'audio') {
            scheduleMetadataFallback(DEFAULT_MEDIA_TIMEOUT_MS);
            audio.onended = () => {
                notifyPlaybackComplete('ended');
            };
            audio.onerror = () => {
                notifyPlaybackComplete('error');
                reset();
            };
            audio.onloadedmetadata = () => {
                clearMetadataFallback();
                const mediaDuration = Number.isFinite(audio.duration) && audio.duration > 0
                    ? audio.duration * 1000
                    : DEFAULT_MEDIA_TIMEOUT_MS;
                scheduleCompletion(mediaDuration);
                notifyPlaybackInfo(mediaDuration);
            };
            audio.src = action.url;
            if (typeof action.volume === 'number') {
                audio.volume = action.volume;
            }
            audio.loop = !!action.loop;
            audio.muted = !!action.muted;
            audio.play().catch(() => {
                notifyPlaybackComplete('playRejected');
                reset();
            });
        } else if (action.mediaType === 'image') {
            image.src = action.url;
            image.classList.remove('hidden');
            const imageDuration = Number.isFinite(duration) && duration > 0 ? duration : 5000;
            scheduleHide(imageDuration);
            scheduleCompletion(imageDuration);
            notifyPlaybackInfo(imageDuration);
        } else {
            scheduleMetadataFallback(DEFAULT_MEDIA_TIMEOUT_MS);
            video.onended = () => {
                notifyPlaybackComplete('ended');
            };
            video.onerror = () => {
                notifyPlaybackComplete('error');
                reset();
            };
            video.onloadedmetadata = () => {
                clearMetadataFallback();
                const mediaDuration = Number.isFinite(video.duration) && video.duration > 0
                    ? video.duration * 1000
                    : DEFAULT_MEDIA_TIMEOUT_MS;
                scheduleCompletion(mediaDuration);
                notifyPlaybackInfo(mediaDuration);
            };
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
                    notifyPlaybackComplete('playRejected');
                    reset();
                });
            }
        }
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
