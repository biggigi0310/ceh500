import express from 'express';
import { config, validateConfig } from './config.js';
import { logger } from './logger.js';
import { Store } from './store.js';
import { FacebookClient } from './facebook.js';
import { createProcessor } from './processor.js';
import { createWebhookRouter } from './webhook.js';
import { createAdminRouter } from './admin/routes.js';

export function createApp({ store, fb, processor } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // 保留原始 body,webhook 簽章要用它計算 HMAC
  app.use(express.json({
    limit: '1mb',
    verify: (req, res, buf) => { req.rawBody = buf; },
  }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/healthz', (req, res) => res.json({ ok: true, dryRun: config.dryRun }));
  app.use('/webhook', createWebhookRouter({ config, processor }));
  app.use('/', createAdminRouter({ config, store, fb }));

  app.use((err, req, res, next) => {
    logger.error('未處理的錯誤', { error: err.message, path: req.path });
    if (res.headersSent) return next(err);
    return res.status(500).json({ error: '伺服器錯誤' });
  });

  return app;
}

function main() {
  const { fatal, warnings } = validateConfig();
  for (const warning of warnings) logger.warn(`設定提醒:${warning}`);
  if (fatal.length) {
    for (const problem of fatal) logger.error(`設定錯誤:${problem}`);
    logger.error('請參考 .env.example 補齊設定後再啟動');
    process.exit(1);
  }

  const store = new Store(config.dataFile).load();
  const fb = new FacebookClient({
    accessToken: config.pageAccessToken,
    version: config.graphVersion,
    minInterval: config.minApiIntervalMs,
    dryRun: config.dryRun,
  });
  const processor = createProcessor({ fb, store });

  createApp({ store, fb, processor }).listen(config.port, () => {
    logger.info(`服務已啟動 http://localhost:${config.port}`, { dryRun: config.dryRun });
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
