const LOG_PRIORITIES = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel = 'info';
let currentPriority = LOG_PRIORITIES[currentLevel];
let errorObserver = null;

export function setErrorObserver(fn) { errorObserver = typeof fn === 'function' ? fn : null; }

export function setLogLevel(level) {
  if (!level) {
    currentLevel = 'info';
  } else {
    const normalized = String(level).toLowerCase();
    currentLevel = Object.hasOwn(LOG_PRIORITIES, normalized) ? normalized : 'info';
  }
  currentPriority = LOG_PRIORITIES[currentLevel];
}

export function log(level, ...args) {
  const priority = LOG_PRIORITIES[level];
  if (priority === undefined || priority < currentPriority) return;
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'log';
  console[method](`[${level.toUpperCase()}]`, ...args);
  if (level === 'error' && errorObserver) {
    try { errorObserver(args.join(' ')); } catch (_) {}
  }
}

export function getLogLevel() { return currentLevel; }
export function isDebugEnabled() { return currentLevel === 'debug'; }
