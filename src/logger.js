const LOG_PRIORITIES = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel = "info";
let currentPriority = LOG_PRIORITIES[currentLevel];

function setLogLevel(level) {
    if (!level) {
        currentLevel = "info";
    } else {
        const normalized = String(level).toLowerCase();
        currentLevel = Object.prototype.hasOwnProperty.call(LOG_PRIORITIES, normalized) ? normalized : "info";
    }
    currentPriority = LOG_PRIORITIES[currentLevel];
}

function log(level, ...args) {
    const priority = LOG_PRIORITIES[level];
    if (priority === undefined || priority < currentPriority) {
        return;
    }
    const method = level === "debug" ? "debug" : level === "error" ? "error" : level === "warn" ? "warn" : "log";
    console[method](`[${level.toUpperCase()}]`, ...args);
}

setLogLevel(currentLevel);

module.exports = {
    log,
    setLogLevel,
    LOG_PRIORITIES,
    getLogLevel: () => currentLevel,
    isDebugEnabled: () => currentLevel === "debug"
};
