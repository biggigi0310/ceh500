import crypto from 'node:crypto';
import express from 'express';
import { logger } from './logger.js';

/** 驗證 Facebook 的 X-Hub-Signature-256,確保請求真的來自 Facebook。 */
export function verifySignature(rawBody, headerValue, appSecret) {
  if (!appSecret) return false;
  if (typeof headerValue !== 'string' || !headerValue.startsWith('sha256=')) return false;

  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const received = headerValue.slice('sha256='.length);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(received, 'utf8');
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

export function createWebhookRouter({ config, processor }) {
  const router = express.Router();

  // Facebook 設定 Webhook 時會先打這支做驗證
  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.verifyToken && config.verifyToken) {
      logger.info('Webhook 驗證成功');
      return res.status(200).send(String(challenge ?? ''));
    }
    logger.warn('Webhook 驗證失敗', { mode });
    return res.sendStatus(403);
  });

  router.post('/', (req, res) => {
    if (!verifySignature(req.rawBody ?? Buffer.alloc(0), req.get('x-hub-signature-256'), config.appSecret)) {
      logger.warn('Webhook 簽章驗證失敗,已拒絕');
      return res.sendStatus(403);
    }

    const payload = req.body ?? {};
    if (payload.object !== 'page') return res.sendStatus(404);

    // Facebook 要求 20 秒內回 200,否則會重送;所以先回應再慢慢處理。
    res.sendStatus(200);

    processor
      .handleWebhookPayload(payload, { pageId: config.pageId })
      .catch((err) => logger.error('處理 webhook 時發生未預期錯誤', { error: err.message }));
  });

  return router;
}
