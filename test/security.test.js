import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySignature, handleVerification } from '../src/webhook.js';
import { createSessionToken, verifySessionToken, parseCookies, sessionCookie } from '../src/auth.js';
import { timingSafeEqual, hmacHex } from '../src/lib/crypto.js';

const SECRET = 'test-app-secret';

test('verifySignature 接受正確簽章、拒絕竄改', async () => {
  const body = JSON.stringify({ object: 'page' });
  const signature = `sha256=${await hmacHex(SECRET, body)}`;

  assert.equal(await verifySignature(body, signature, SECRET), true);
  assert.equal(await verifySignature('tampered', signature, SECRET), false);
  assert.equal(await verifySignature(body, signature, 'wrong-secret'), false);
});

test('verifySignature 拒絕缺少或格式錯誤的標頭', async () => {
  assert.equal(await verifySignature('{}', undefined, SECRET), false);
  assert.equal(await verifySignature('{}', 'sha1=abc', SECRET), false);
  assert.equal(await verifySignature('{}', 'sha256=short', SECRET), false);
  assert.equal(await verifySignature('{}', `sha256=${await hmacHex(SECRET, '{}')}`, ''), false);
});

test('handleVerification 只在 token 正確時回傳 challenge', () => {
  const ok = handleVerification(new URL('https://x/webhook?hub.mode=subscribe&hub.verify_token=t&hub.challenge=C'), 't');
  assert.equal(ok.status, 200);

  assert.equal(handleVerification(new URL('https://x/webhook?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=C'), 't').status, 403);
  assert.equal(handleVerification(new URL('https://x/webhook?hub.mode=subscribe&hub.verify_token=t&hub.challenge=C'), '').status, 403);
});

test('session token 簽發後可驗證,竄改或過期則失敗', async () => {
  const token = await createSessionToken(SECRET);
  assert.equal(await verifySessionToken(token, SECRET), true);
  assert.equal(await verifySessionToken(token, 'other-secret'), false);
  assert.equal(await verifySessionToken(`${token}x`, SECRET), false);
  assert.equal(await verifySessionToken('admin.9999999999999.fake', SECRET), false);
  assert.equal(await verifySessionToken(await createSessionToken(SECRET, -1000), SECRET), false);
  assert.equal(await verifySessionToken(undefined, SECRET), false);
  assert.equal(await verifySessionToken('admin.abc.sig', SECRET), false);
});

test('session cookie 帶 HttpOnly / Secure / SameSite', async () => {
  const cookie = sessionCookie(await createSessionToken(SECRET));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
});

test('parseCookies 解析 cookie 標頭', () => {
  assert.deepEqual(parseCookies('a=1; b=hello%20world'), { a: '1', b: 'hello world' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
});

test('timingSafeEqual 只在完全相同時為真', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
  assert.equal(timingSafeEqual(null, undefined), true);
});
