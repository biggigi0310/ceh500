import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySignature } from '../src/webhook.js';
import { createSessionToken, verifySessionToken, parseCookies, safeEqual } from '../src/admin/auth.js';

const SECRET = 'test-app-secret';

function sign(body, secret = SECRET) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

test('verifySignature 接受正確簽章、拒絕竄改', () => {
  const body = Buffer.from(JSON.stringify({ object: 'page' }));
  assert.equal(verifySignature(body, sign(body), SECRET), true);
  assert.equal(verifySignature(body, sign(body, 'wrong'), SECRET), false);
  assert.equal(verifySignature(Buffer.from('tampered'), sign(body), SECRET), false);
});

test('verifySignature 拒絕缺少或格式錯誤的標頭', () => {
  const body = Buffer.from('{}');
  assert.equal(verifySignature(body, undefined, SECRET), false);
  assert.equal(verifySignature(body, 'sha1=abc', SECRET), false);
  assert.equal(verifySignature(body, 'sha256=short', SECRET), false);
  assert.equal(verifySignature(body, sign(body), ''), false);
});

test('session token 簽發後可驗證,竄改或過期則失敗', () => {
  const token = createSessionToken(SECRET);
  assert.equal(verifySessionToken(token, SECRET), true);
  assert.equal(verifySessionToken(token, 'other-secret'), false);
  assert.equal(verifySessionToken(`${token}x`, SECRET), false);
  assert.equal(verifySessionToken('admin.9999999999999.fake', SECRET), false);
  assert.equal(verifySessionToken(createSessionToken(SECRET, -1000), SECRET), false);
  assert.equal(verifySessionToken(undefined, SECRET), false);
});

test('parseCookies 解析 cookie 標頭', () => {
  assert.deepEqual(parseCookies('a=1; b=hello%20world'), { a: '1', b: 'hello world' });
  assert.deepEqual(parseCookies(''), {});
});

test('safeEqual 只在完全相同時為真', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});
