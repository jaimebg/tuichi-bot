import http from 'node:http';
import { log } from '../logger.js';
import { normalizeWhitespace, clampResponseLength } from '../utils/text.js';

export class HealthServer {
  constructor({ port, apiKey, bot, metrics }) {
    this.port = port;
    this.apiKey = apiKey;
    this.bot = bot;
    this.metrics = metrics;
    this._server = null;
    this._sayCount = 0;
    this._sayWindowStart = Date.now();
  }

  isSystemHealthy() {
    try {
      const chatOk = this.bot.chat.isHealthy(this.bot.streamMonitor?.isOnline ?? false);
      const dbOk = !!this.bot.db.raw.prepare('SELECT 1 as v').get();
      return chatOk && dbOk;
    } catch { return false; }
  }

  async start() {
    this._server = http.createServer((req, res) => this._route(req, res));
    return new Promise((resolve) => {
      this._server.listen(this.port, () => {
        log('info', `Health server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop() {
    if (!this._server) return;
    return new Promise((resolve) => {
      this._server.close(() => {
        log('info', 'Health server stopped');
        resolve();
      });
    });
  }

  _checkAuth(req) {
    if (!this.apiKey) return false;
    const header = req.headers.authorization || '';
    return header === `Bearer ${this.apiKey}`;
  }

  _json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  _route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method;

    // Route table: [method, path, requiresAuth, handler]
    const routes = {
      '/health':      { methods: ['GET'], auth: false, handler: () => this._handleHealth(res) },
      '/metrics':     { methods: ['GET'], auth: true,  handler: () => this._handleMetrics(res) },
      '/api/status':  { methods: ['GET'], auth: false, handler: () => this._handleStatus(res) },
      '/api/users':   { methods: ['GET'], auth: true,  handler: () => this._handleUsers(res) },
      '/api/say':     { methods: ['POST'], auth: true, handler: () => this._handleSay(req, res) },
    };

    const route = routes[path];
    if (!route) { this._json(res, 404, { error: 'not found' }); return; }
    if (!route.methods.includes(method)) { this._json(res, 405, { error: 'method not allowed' }); return; }
    if (route.auth && !this._checkAuth(req)) { this._json(res, 401, { error: 'unauthorized' }); return; }
    route.handler();
  }

  _handleHealth(res) {
    const chatOk = this.bot.chat.isHealthy(this.bot.streamMonitor?.isOnline ?? false);
    let dbOk = false;
    try { dbOk = !!this.bot.db.raw.prepare('SELECT 1 as v').get(); } catch { /* db unavailable */ }
    const healthy = chatOk && dbOk;
    const status = healthy ? 200 : 503;
    this._json(res, status, {
      status: healthy ? 'ok' : 'unhealthy',
      uptime: Math.floor((Date.now() - this.metrics.startedAt) / 1000),
      chat: chatOk ? 'connected' : 'disconnected',
      db: dbOk ? 'ok' : 'error'
    });
  }

  _handleMetrics(res) {
    const snapshot = this.metrics.getSnapshot();
    const schedulerStatus = this.bot.scheduler?.getStatus();
    if (schedulerStatus) {
      snapshot.scheduler = Object.fromEntries(schedulerStatus);
    }
    snapshot.circuit = this.bot.ai?.getCircuitState?.() ?? 'unknown';
    this._json(res, 200, snapshot);
  }

  _handleStatus(res) {
    this._json(res, 200, {
      online: this.bot.streamMonitor?.isOnline ?? false,
      game: this.bot.streamMonitor?.currentGame ?? null,
      title: this.bot.streamMonitor?.currentTitle ?? null,
      users: this.bot.chatterPresence?.getPresentCount() ?? 0,
      tracked: this.bot.userMemory?.memories?.size ?? 0
    });
  }

  _handleUsers(res) {
    const top = this.bot.messageLogger?.getTopUsers(20) ?? [];
    this._json(res, 200, { users: top });
  }

  _handleSay(req, res) {
    // Rate limit: 5/min
    const now = Date.now();
    if (now - this._sayWindowStart > 60_000) { this._sayCount = 0; this._sayWindowStart = now; }
    if (this._sayCount >= 5) { this._json(res, 429, { error: 'rate limited (5/min)' }); return; }

    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.message || typeof data.message !== 'string') {
          this._json(res, 400, { error: 'missing message field' }); return;
        }
        const text = clampResponseLength(normalizeWhitespace(data.message), 500);
        if (!text) { this._json(res, 400, { error: 'empty message after normalization' }); return; }
        this._sayCount++;
        this.bot.chat.sendMessage(text).then(() => {
          this._json(res, 200, { sent: text });
        }).catch((err) => {
          this._json(res, 500, { error: err.message });
        });
      } catch {
        this._json(res, 400, { error: 'invalid JSON body' });
      }
    });
  }
}
