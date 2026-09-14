import { json, readJson } from './lib/router.js';
import { timingSafeEqual } from './lib/crypto.js';
import { clearCookie, createSessionToken, isAuthenticated, sessionCookie } from './auth.js';
import { explainGraphError } from './facebook.js';
import { renderTemplate } from './core/templates.js';

function validateRule(rule) {
  if (!rule.postId || !String(rule.postId).trim()) return '請填貼文 ID(或填 * 代表套用到所有貼文)';
  if (!rule.dmTemplate || !String(rule.dmTemplate).trim()) return '私訊內容不能空白';
  if (rule.link && !/^https?:\/\//i.test(rule.link)) return '物件連結必須以 http:// 或 https:// 開頭';
  if (rule.keywordMode === 'any' && !(rule.keywords ?? []).filter((k) => String(k).trim()).length) {
    return '選了「只有含關鍵字才回覆」就至少要填一個關鍵字';
  }
  return null;
}

export function registerAdminRoutes(router) {
  router.post('/api/login', async (request, { config }) => {
    const { password } = await readJson(request);
    if (!config.adminPassword || !timingSafeEqual(password ?? '', config.adminPassword)) {
      return json({ error: '密碼錯誤' }, { status: 401 });
    }
    const token = await createSessionToken(config.sessionSecret);
    return json({ ok: true }, { headers: { 'set-cookie': sessionCookie(token) } });
  });

  router.post('/api/logout', () => json({ ok: true }, { headers: { 'set-cookie': clearCookie() } }));

  // 除了登入/登出,其他 /api 路徑都要先通過這關。
  router.use('/api', async (request, { config, url }) => {
    if (url.pathname === '/api/login' || url.pathname === '/api/logout') return null;
    if (await isAuthenticated(request, config.sessionSecret)) return null;
    return json({ error: '尚未登入' }, { status: 401 });
  });

  router.get('/api/state', async (request, { store, config }) => json({
    settings: await store.getSettings(),
    rules: await store.listRules(),
    stats: await store.stats(),
    env: {
      dryRun: config.dryRun,
      pageId: config.pageId,
      hasToken: Boolean(config.pageAccessToken),
      hasAppSecret: Boolean(config.appSecret),
      graphVersion: config.graphVersion,
    },
  }));

  router.put('/api/settings', async (request, { store }) => {
    const body = await readJson(request);
    const patch = {};
    for (const key of ['enabled', 'publicReplyEnabled', 'skipNestedComments', 'skipOwnComments']) {
      if (key in body) patch[key] = Boolean(body[key]);
    }
    return json(await store.updateSettings(patch));
  });

  router.get('/api/rules', async (request, { store }) => json(await store.listRules()));

  router.post('/api/rules', async (request, { store }) => {
    const body = await readJson(request);
    const error = validateRule(body);
    if (error) return json({ error }, { status: 400 });
    return json(await store.upsertRule(body), { status: 201 });
  });

  router.put('/api/rules/:id', async (request, { store, params }) => {
    const existing = await store.getRule(params.id);
    if (!existing) return json({ error: '找不到這條設定' }, { status: 404 });

    const body = await readJson(request);
    const error = validateRule({ ...existing, ...body });
    if (error) return json({ error }, { status: 400 });
    return json(await store.upsertRule({ ...body, id: params.id }));
  });

  router.delete('/api/rules/:id', async (request, { store, params }) => {
    if (!(await store.deleteRule(params.id))) return json({ error: '找不到這條設定' }, { status: 404 });
    return json({ ok: true });
  });

  /** 存檔前先看到實際送出去長什麼樣。 */
  router.post('/api/preview', async (request) => {
    const body = await readJson(request);
    const vars = {
      name: '王小明',
      link: body.link || 'https://example.com/house/123',
      comment: '這間還在嗎?',
      post_id: '123456_789',
    };
    return json({
      dm: renderTemplate(body.dmTemplate ?? '', vars),
      publicReply: renderTemplate(body.publicReplyTemplate ?? '', vars),
    });
  });

  router.get('/api/logs', async (request, { store, url }) => {
    const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500);
    return json(await store.getLogs(limit));
  });

  router.get('/api/posts', async (request, { fb, config }) => {
    if (!config.pageId) return json({ error: '尚未設定 FB_PAGE_ID' }, { status: 400 });
    try {
      const result = await fb.listPosts(config.pageId, 25);
      return json(result.data ?? []);
    } catch (err) {
      return json({ error: explainGraphError(err) }, { status: 502 });
    }
  });

  /** 檢查 Token 有沒有效、粉專有沒有訂閱 feed。 */
  router.get('/api/diagnose', async (request, { fb, config }) => {
    const report = { page: null, subscribedFields: null, errors: [] };
    if (!config.pageId || !config.pageAccessToken) {
      report.errors.push('尚未設定 FB_PAGE_ID 或 FB_PAGE_ACCESS_TOKEN');
      return json(report);
    }
    try {
      report.page = await fb.getPageInfo(config.pageId);
    } catch (err) {
      report.errors.push(`讀取粉專資訊失敗:${explainGraphError(err)}`);
    }
    try {
      const subs = await fb.listSubscribedApps(config.pageId);
      report.subscribedFields = subs.data?.[0]?.subscribed_fields ?? [];
      if (!report.subscribedFields.includes('feed')) {
        report.errors.push('粉專尚未訂閱 feed 事件,請按下面的「訂閱粉專留言事件」');
      }
    } catch (err) {
      report.errors.push(`讀取訂閱狀態失敗:${explainGraphError(err)}`);
    }
    return json(report);
  });

  /** 從後台直接訂閱,不用另外跑指令。 */
  router.post('/api/subscribe', async (request, { fb, config }) => {
    if (!config.pageId) return json({ error: '尚未設定 FB_PAGE_ID' }, { status: 400 });
    try {
      await fb.subscribePage(config.pageId);
      const subs = await fb.listSubscribedApps(config.pageId);
      return json({ ok: true, subscribedFields: subs.data?.[0]?.subscribed_fields ?? [] });
    } catch (err) {
      return json({ error: explainGraphError(err) }, { status: 502 });
    }
  });

  return router;
}
