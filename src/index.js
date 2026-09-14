import { Router, json } from './lib/router.js';
import { Store } from './store.js';
import { FacebookClient } from './facebook.js';
import { createProcessor } from './core/processor.js';
import { handleVerification, verifySignature } from './webhook.js';
import { registerAdminRoutes } from './admin.js';

function readConfig(env) {
  return {
    appSecret: env.FB_APP_SECRET ?? '',
    verifyToken: env.FB_VERIFY_TOKEN ?? '',
    pageAccessToken: env.FB_PAGE_ACCESS_TOKEN ?? '',
    pageId: env.FB_PAGE_ID ?? '',
    graphVersion: env.FB_GRAPH_VERSION || 'v23.0',
    adminPassword: env.ADMIN_PASSWORD ?? '',
    sessionSecret: env.SESSION_SECRET || env.FB_APP_SECRET || '',
    dryRun: String(env.DRY_RUN ?? '').toLowerCase() === 'true',
  };
}

export function buildRouter() {
  const router = new Router();

  router.get('/healthz', (request, { config }) => json({ ok: true, dryRun: config.dryRun }));

  router.get('/webhook', (request, { config, url }) => handleVerification(url, config.verifyToken));

  router.post('/webhook', async (request, { config, processor, ctx }) => {
    const rawBody = await request.text();
    const signature = request.headers.get('x-hub-signature-256');

    if (!(await verifySignature(rawBody, signature, config.appSecret))) {
      return new Response('Forbidden', { status: 403 });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    if (payload.object !== 'page') return new Response('Not Found', { status: 404 });

    // Facebook 要求 20 秒內回 200,否則會重送;先回應,處理丟到背景。
    const work = processor
      .handleWebhookPayload(payload, { pageId: config.pageId })
      .catch((err) => console.error('處理 webhook 失敗', err?.message ?? err));

    if (ctx?.waitUntil) ctx.waitUntil(work);
    else await work;

    return new Response('EVENT_RECEIVED', { status: 200 });
  });

  return registerAdminRoutes(router);
}

const router = buildRouter();

export default {
  async fetch(request, env, ctx) {
    const config = readConfig(env);

    if (!env.DB) {
      return json({ error: 'D1 資料庫尚未綁定,請檢查 wrangler.toml 的 [[d1_databases]] 設定' }, { status: 500 });
    }

    const store = new Store(env.DB);
    const fb = new FacebookClient({
      accessToken: config.pageAccessToken,
      version: config.graphVersion,
      dryRun: config.dryRun,
    });
    const processor = createProcessor({ fb, store });

    try {
      const response = await router.handle(request, { config, store, fb, processor, ctx });
      if (response) return response;
    } catch (err) {
      console.error('未處理的錯誤', err?.stack ?? err);
      return json({ error: '伺服器錯誤' }, { status: 500 });
    }

    // 沒對上的 /api 路徑直接回 404,不要把後台網頁當成 API 回應丟回去。
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return json({ error: '找不到這個 API' }, { status: 404 });
    }

    // 其餘路徑交給靜態檔案(後台網頁)。
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not Found', { status: 404 });
  },
};
