// 直接打 Worker 的 fetch handler,把路由、登入、簽章驗證串起來測一遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/d1.js';
import worker from '../src/index.js';
import { hmacHex } from '../src/lib/crypto.js';

const APP_SECRET = 'test-app-secret';

function createEnv(overrides = {}) {
  return {
    DB: createTestD1(),
    ASSETS: { fetch: async () => new Response('<html>後台</html>', { headers: { 'content-type': 'text/html' } }) },
    FB_APP_SECRET: APP_SECRET,
    FB_VERIFY_TOKEN: 'verify-me',
    FB_PAGE_ID: 'page-1',
    FB_PAGE_ACCESS_TOKEN: 'token',
    ADMIN_PASSWORD: 'pw123',
    SESSION_SECRET: 'session-secret',
    DRY_RUN: 'true',
    ...overrides,
  };
}

const ctx = { waitUntil: (promise) => promise };

function call(env, path, init = {}) {
  return worker.fetch(new Request(`https://example.workers.dev${path}`, init), env, ctx);
}

async function login(env) {
  const response = await call(env, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw123' }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return { cookie: { cookie } };
}

async function signedWebhook(env, payload) {
  const body = JSON.stringify(payload);
  return call(env, '/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${await hmacHex(APP_SECRET, body)}`,
    },
    body,
  });
}

const commentPayload = (overrides = {}) => ({
  object: 'page',
  entry: [{
    id: 'page-1',
    changes: [{
      field: 'feed',
      value: {
        item: 'comment',
        verb: 'add',
        comment_id: '100_200',
        post_id: '100',
        parent_id: '100',
        from: { id: 'u1', name: '王小明' },
        message: '有興趣',
        ...overrides,
      },
    }],
  }],
});

test('healthz 可用', async () => {
  const response = await call(createEnv(), '/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, dryRun: true, ready: true, missing: [] });
});

test('沒有綁 D1 時回報設定錯誤而不是 500 崩潰', async () => {
  const response = await call(createEnv({ DB: undefined }), '/healthz');
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /D1/);
});

test('未知路徑交給靜態檔案(後台網頁)', async () => {
  const response = await call(createEnv(), '/');
  assert.equal(await response.text(), '<html>後台</html>');
});

test('webhook 驗證握手只接受正確的 verify token', async () => {
  const env = createEnv();
  const ok = await call(env, '/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=CHAL');
  assert.equal(await ok.text(), 'CHAL');

  const bad = await call(env, '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHAL');
  assert.equal(bad.status, 403);
});

test('簽章錯誤的 webhook 一律拒絕', async () => {
  const response = await call(createEnv(), '/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
    body: JSON.stringify(commentPayload()),
  });
  assert.equal(response.status, 403);
});

test('沒有簽章標頭的 webhook 也拒絕', async () => {
  const response = await call(createEnv(), '/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(commentPayload()),
  });
  assert.equal(response.status, 403);
});

test('未登入不能讀寫任何設定', async () => {
  const env = createEnv();
  for (const [path, init] of [
    ['/api/state', {}],
    ['/api/rules', {}],
    ['/api/logs', {}],
    ['/api/rules', { method: 'POST', body: '{}' }],
    ['/api/settings', { method: 'PUT', body: '{}' }],
  ]) {
    const response = await call(env, path, init);
    assert.equal(response.status, 401, `${path} 應該要擋下來`);
  }
});

test('密碼錯誤不發 cookie', async () => {
  const response = await call(createEnv(), '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('別的密鑰簽出來的 cookie 無效', async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const otherEnv = createEnv({ SESSION_SECRET: 'different-secret', DB: env.DB });
  const response = await call(otherEnv, '/api/state', { headers: cookie });
  assert.equal(response.status, 401);
});

test('登入後可以建立規則,壞資料會被擋下', async () => {
  const env = createEnv();
  const { cookie } = await login(env);

  const bad = await call(env, '/api/rules', {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ postId: '', dmTemplate: 'x' }),
  });
  assert.equal(bad.status, 400);

  const badLink = await call(env, '/api/rules', {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ postId: '100', dmTemplate: 'x', link: 'javascript:alert(1)' }),
  });
  assert.equal(badLink.status, 400);

  const good = await call(env, '/api/rules', {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: '信義區', postId: '100', link: 'https://example.com/h/1', dmTemplate: '{{name}} 看這裡:{{link}}' }),
  });
  assert.equal(good.status, 201);
  assert.equal((await good.json()).name, '信義區');
});

test('完整流程:建規則 → 收到留言 → 紀錄寫入 → 重送不重複', async () => {
  const env = createEnv();
  const { cookie } = await login(env);

  await call(env, '/api/rules', {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ postId: '100', link: 'https://example.com/h/1', dmTemplate: '{{name}},物件:{{link}}' }),
  });

  assert.equal((await signedWebhook(env, commentPayload())).status, 200);

  const logs = await (await call(env, '/api/logs', { headers: cookie })).json();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'sent');
  assert.equal(logs[0].dmMessage, '王小明,物件:https://example.com/h/1');

  // Facebook 重送同一筆事件
  assert.equal((await signedWebhook(env, commentPayload())).status, 200);
  const afterReplay = await (await call(env, '/api/logs', { headers: cookie })).json();
  assert.equal(afterReplay.length, 1, '重送不應該產生第二筆紀錄');
});

test('預覽會帶入範例值', async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const response = await call(env, '/api/preview', {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ dmTemplate: '{{name}} 您好 {{link}}', link: 'https://x.tw/a', publicReplyTemplate: '已私訊' }),
  });
  const preview = await response.json();
  assert.equal(preview.dm, '王小明 您好 https://x.tw/a');
  assert.equal(preview.publicReply, '已私訊');
});

test('登出後 cookie 失效', async () => {
  const env = createEnv();
  const { cookie } = await login(env);
  const response = await call(env, '/api/logout', { method: 'POST', headers: cookie });
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
});

test('不存在的 API 路徑回 404 JSON,而不是後台網頁', async () => {
  const response = await call(createEnv(), '/api/does-not-exist');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('沒設 ADMIN_PASSWORD 時,登入回傳看得懂的說明而不是伺服器錯誤', async () => {
  const response = await call(createEnv({ ADMIN_PASSWORD: '' }), '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'anything' }),
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /ADMIN_PASSWORD/);
});

test('沒設 SESSION_SECRET 時,登入回傳看得懂的說明', async () => {
  const env = createEnv({ SESSION_SECRET: '', FB_APP_SECRET: '' });
  const response = await call(env, '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw123' }),
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /SESSION_SECRET/);
});

test('healthz 會列出還沒設定的項目', async () => {
  const response = await call(createEnv({ FB_PAGE_ID: '', ADMIN_PASSWORD: '' }), '/healthz');
  const body = await response.json();
  assert.equal(body.ready, false);
  assert.deepEqual(body.missing.sort(), ['ADMIN_PASSWORD', 'FB_PAGE_ID']);
  assert.equal((await (await call(createEnv(), '/healthz')).json()).ready, true);
});
