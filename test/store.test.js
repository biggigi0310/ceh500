import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/d1.js';
import { Store, DEFAULT_DM_TEMPLATE } from '../src/store.js';

const newStore = () => new Store(createTestD1());

test('沒有存過設定時回傳預設值', async () => {
  const settings = await newStore().getSettings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.publicReplyEnabled, true);
});

test('設定可以更新並讀回,未知欄位會被忽略', async () => {
  const store = newStore();
  await store.updateSettings({ enabled: false, publicReplyEnabled: false, 惡意欄位: true });
  const settings = await store.getSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.publicReplyEnabled, false);
  assert.equal(settings.skipNestedComments, true);
  assert.equal('惡意欄位' in settings, false);
});

test('規則新增、更新、刪除', async () => {
  const store = newStore();
  const created = await store.upsertRule({ postId: '100', link: 'https://a' });
  assert.equal(created.dmTemplate, DEFAULT_DM_TEMPLATE);

  const updated = await store.upsertRule({ id: created.id, name: '信義區' });
  assert.equal(updated.id, created.id);
  assert.equal(updated.name, '信義區');
  assert.equal(updated.link, 'https://a', '沒帶到的欄位應該保留原值');
  assert.equal((await store.listRules()).length, 1);

  assert.equal(await store.deleteRule(created.id), true);
  assert.equal(await store.deleteRule(created.id), false);
});

test('關鍵字存取為 JSON,讀回仍是陣列', async () => {
  const store = newStore();
  const rule = await store.upsertRule({ postId: '100', dmTemplate: 'x', keywordMode: 'any', keywords: ['詳細', '+1'] });
  assert.deepEqual((await store.getRule(rule.id)).keywords, ['詳細', '+1']);
});

test('findRuleForPost 優先指定貼文,其次萬用,停用的不算', async () => {
  const store = newStore();
  await store.upsertRule({ postId: '*', name: '萬用', dmTemplate: 'x' });
  await store.upsertRule({ postId: '100', name: '指定', dmTemplate: 'x' });
  const disabled = await store.upsertRule({ postId: '200', name: '停用', dmTemplate: 'x', enabled: false });

  assert.equal((await store.findRuleForPost('100')).name, '指定');
  assert.equal((await store.findRuleForPost('999')).name, '萬用');
  assert.equal((await store.findRuleForPost('200')).name, '萬用', '停用的規則不該被選到');

  await store.deleteRule(disabled.id);
});

test('沒有任何規則時 findRuleForPost 回傳 null', async () => {
  assert.equal(await newStore().findRuleForPost('100'), null);
});

test('claimComment 只有第一次會成功', async () => {
  const store = newStore();
  assert.equal(await store.claimComment('100_200', 'r1'), true);
  assert.equal(await store.claimComment('100_200', 'r1'), false);
  assert.equal(await store.claimComment('100_201', 'r1'), true);
});

test('releaseComment 之後可以重新搶到', async () => {
  const store = newStore();
  await store.claimComment('100_200', 'r1');
  await store.releaseComment('100_200');
  assert.equal(await store.claimComment('100_200', 'r1'), true);
});

test('markProcessed 會更新狀態', async () => {
  const store = newStore();
  await store.claimComment('100_200', 'r1');
  await store.markProcessed('100_200', { status: 'failed', ruleId: 'r1', error: '權限不足' });
  const row = await store.getProcessed('100_200');
  assert.equal(row.status, 'failed');
  assert.equal(row.error, '權限不足');
});

test('紀錄最新在前,並統計成功失敗筆數', async () => {
  const store = newStore();
  await store.addLog({ status: 'sent', commentId: 'a', author: '甲' });
  await store.addLog({ status: 'failed', commentId: 'b', author: '乙', error: '錯誤' });

  const logs = await store.getLogs();
  assert.equal(logs[0].commentId, 'b');
  assert.equal(logs[0].error, '錯誤');

  const stats = await store.stats();
  assert.equal(stats.sent, 1);
  assert.equal(stats.failed, 1);
});
