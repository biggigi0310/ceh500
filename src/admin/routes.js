import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { COOKIE_NAME, SESSION_TTL_MS, createSessionToken, parseCookies, safeEqual, verifySessionToken } from './auth.js';
import { explainGraphError } from '../facebook.js';
import { renderTemplate } from '../processor.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

export function createAdminRouter({ config, store, fb }) {
  const router = express.Router();

  router.use(express.static(publicDir));

  router.post('/api/login', (req, res) => {
    const password = req.body?.password ?? '';
    if (!config.adminPassword || !safeEqual(password, config.adminPassword)) {
      return res.status(401).json({ error: '密碼錯誤' });
    }
    const token = createSessionToken(config.sessionSecret);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
      secure: req.protocol === 'https' || req.get('x-forwarded-proto') === 'https',
    });
    return res.json({ ok: true });
  });

  router.post('/api/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.json({ ok: true });
  });

  // 以下所有 API 都需要登入
  router.use('/api', (req, res, next) => {
    const cookies = parseCookies(req.get('cookie') ?? '');
    if (!verifySessionToken(cookies[COOKIE_NAME], config.sessionSecret)) {
      return res.status(401).json({ error: '尚未登入' });
    }
    return next();
  });

  router.get('/api/state', (req, res) => {
    res.json({
      settings: store.settings,
      rules: store.rules,
      stats: store.stats(),
      env: {
        dryRun: config.dryRun,
        pageId: config.pageId,
        hasToken: Boolean(config.pageAccessToken),
        hasAppSecret: Boolean(config.appSecret),
        graphVersion: config.graphVersion,
      },
    });
  });

  router.put('/api/settings', (req, res) => {
    const body = req.body ?? {};
    const patch = {};
    for (const key of ['enabled', 'publicReplyEnabled', 'skipNestedComments', 'skipOwnComments']) {
      if (key in body) patch[key] = Boolean(body[key]);
    }
    res.json(store.updateSettings(patch));
  });

  router.get('/api/rules', (req, res) => res.json(store.rules));

  router.post('/api/rules', (req, res) => {
    const error = validateRule(req.body ?? {});
    if (error) return res.status(400).json({ error });
    return res.status(201).json(store.upsertRule(req.body));
  });

  router.put('/api/rules/:id', (req, res) => {
    if (!store.getRule(req.params.id)) return res.status(404).json({ error: '找不到這條設定' });
    const error = validateRule({ ...store.getRule(req.params.id), ...req.body });
    if (error) return res.status(400).json({ error });
    return res.json(store.upsertRule({ ...req.body, id: req.params.id }));
  });

  router.delete('/api/rules/:id', (req, res) => {
    if (!store.deleteRule(req.params.id)) return res.status(404).json({ error: '找不到這條設定' });
    return res.json({ ok: true });
  });

  /** 預覽:把樣板變數換成範例值,讓她按「儲存」前先看到實際內容。 */
  router.post('/api/preview', (req, res) => {
    const vars = {
      name: '王小明',
      link: req.body?.link || 'https://example.com/house/123',
      comment: '這間還在嗎?',
      post_id: '123456_789',
    };
    res.json({
      dm: renderTemplate(req.body?.dmTemplate ?? '', vars),
      publicReply: renderTemplate(req.body?.publicReplyTemplate ?? '', vars),
    });
  });

  router.get('/api/logs', (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit ?? '100', 10) || 100, 500);
    res.json(store.getLogs(limit));
  });

  router.get('/api/posts', async (req, res) => {
    if (!config.pageId) return res.status(400).json({ error: '尚未設定 FB_PAGE_ID' });
    try {
      const result = await fb.listPosts(config.pageId, 25);
      res.json(result.data ?? []);
    } catch (err) {
      res.status(502).json({ error: explainGraphError(err) });
    }
  });

  /** 檢查 Token、粉專、以及粉專是否已訂閱 feed 事件。 */
  router.get('/api/diagnose', async (req, res) => {
    const report = { page: null, subscribedFields: null, errors: [] };
    if (!config.pageId || !config.pageAccessToken) {
      report.errors.push('尚未設定 FB_PAGE_ID 或 FB_PAGE_ACCESS_TOKEN');
      return res.json(report);
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
        report.errors.push('粉專尚未訂閱 feed 事件,請執行 npm run subscribe');
      }
    } catch (err) {
      report.errors.push(`讀取訂閱狀態失敗:${explainGraphError(err)}`);
    }
    return res.json(report);
  });

  return router;
}

function validateRule(rule) {
  if (!rule.postId || !String(rule.postId).trim()) return '請填貼文 ID(或填 * 代表套用到所有貼文)';
  if (!rule.dmTemplate || !String(rule.dmTemplate).trim()) return '私訊內容不能空白';
  if (rule.link && !/^https?:\/\//i.test(rule.link)) return '物件連結必須以 http:// 或 https:// 開頭';
  if (rule.keywordMode === 'any' && !(rule.keywords ?? []).filter((k) => String(k).trim()).length) {
    return '選了「只有含關鍵字才回覆」就至少要填一個關鍵字';
  }
  return null;
}
