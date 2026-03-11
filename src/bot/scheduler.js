import { log } from '../logger.js';

export class Scheduler {
  constructor() {
    this._tasks = new Map();
  }

  register(name, fn, intervalMs, { runImmediately = false } = {}) {
    if (this._tasks.has(name)) this.unregister(name);
    const task = {
      name, fn, intervalMs,
      timer: null,
      lastRun: null,
      runCount: 0,
      lastError: null
    };
    const execute = async () => {
      try {
        await fn();
        task.runCount++;
        task.lastRun = Date.now();
      } catch (err) {
        task.lastError = err.message;
        log('warn', `Scheduler task '${name}' failed: ${err.message}`);
      }
    };
    task.timer = setInterval(execute, intervalMs);
    this._tasks.set(name, task);
    if (runImmediately) execute();
  }

  unregister(name) {
    const task = this._tasks.get(name);
    if (!task) return;
    clearInterval(task.timer);
    this._tasks.delete(name);
  }

  getStatus() {
    const status = new Map();
    for (const [name, task] of this._tasks) {
      status.set(name, {
        lastRun: task.lastRun,
        runCount: task.runCount,
        lastError: task.lastError,
        intervalMs: task.intervalMs
      });
    }
    return status;
  }

  stopAll() {
    for (const [name] of this._tasks) this.unregister(name);
  }
}
