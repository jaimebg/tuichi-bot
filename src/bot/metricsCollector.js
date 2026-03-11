const VALID_COUNTERS = new Set([
  'messagesReceived', 'messagesSent', 'aiRequests', 'aiErrors',
  'aiLatencySum', 'aiLatencyCount', 'modelFallbacks', 'gamesPlayed', 'circuitOpens'
]);

const MAX_ERRORS = 100;

export class MetricsCollector {
  constructor() {
    this.startedAt = Date.now();
    this.counters = {
      messagesReceived: 0, messagesSent: 0,
      aiRequests: 0, aiErrors: 0,
      aiLatencySum: 0, aiLatencyCount: 0,
      modelFallbacks: 0, gamesPlayed: 0, circuitOpens: 0
    };
    this.errors = [];
  }

  increment(key) {
    if (VALID_COUNTERS.has(key)) this.counters[key]++;
  }

  recordAiLatency(ms) {
    this.counters.aiLatencySum += ms;
    this.counters.aiLatencyCount++;
  }

  recordError(message) {
    if (this.errors.length >= MAX_ERRORS) this.errors.shift();
    this.errors.push({ timestamp: Date.now(), message });
  }

  getSnapshot() {
    const now = Date.now();
    const mem = process.memoryUsage();
    const hourAgo = now - 3600_000;
    const dayAgo = now - 86400_000;
    return {
      uptimeMs: now - this.startedAt,
      memory: { heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, rss: mem.rss },
      counters: { ...this.counters },
      avgAiLatencyMs: this.counters.aiLatencyCount > 0
        ? Math.round(this.counters.aiLatencySum / this.counters.aiLatencyCount) : 0,
      errors: [...this.errors],
      errorsLastHour: this.errors.filter(e => e.timestamp > hourAgo).length,
      errorsLast24h: this.errors.filter(e => e.timestamp > dayAgo).length
    };
  }
}
