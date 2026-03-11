import { setLogLevel, log } from './logger.js';
import { buildConfig } from './config.js';
import { Bot } from './bot/bot.js';

const config = buildConfig();
setLogLevel(config.logLevel);

const bot = new Bot(config);

bot.start().catch((err) => {
  log('error', `Bot terminated unexpectedly: ${err.message}`);
  log('debug', err.stack);
  process.exitCode = 1;
});

const shutdown = async () => {
  log('info', 'Shutting down bot...');
  await bot.shutdown();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
