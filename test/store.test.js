import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, DEFAULT_DM_TEMPLATE } from '../src/store.js';

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fbauto-store-')), 'store.json');
}

test('新檔案會使用預設值', () => {
  const store = new Store(tempFile()).load();
  assert.equal(store.settings.enabled, true);
  assert.deepEqual(store.rules, []);
});

test('規則新增、更新、刪除', () => {
  const store = new Store(tempFile()).load();
  const created = store.upsertRule({ postId: '100', link: 'https://a' });
  assert.equal(created.dmTemplate, DEFAULT_DM_TEMPLATE);

  const updated = store.upsertRule({ id: created.id, name: '信義區' });
  assert.equal(updated.id, created.id);
  assert.equal(updated.name, '信義區');
  assert.equal(store.rules.length, 1);

  assert.equal(store.deleteRule(created.id), true);
  assert.equal(store.deleteRule(created.id), false);
});

test('處理過的留言會被記住並可重新載入', async () => {
  const file = tempFile();
  const store = new Store(file).load();
  store.markProcessed('100_200', { status: 'sent' });
  await store.save();

  const reloaded = new Store(file).load();
  assert.equal(reloaded.isProcessed('100_200'), true);
  assert.equal(reloaded.getProcessed('100_200').status, 'sent');
  assert.equal(reloaded.isProcessed('100_999'), false);
});

test('毀損的 JSON 會拋錯而不是安靜吃掉', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => new Store(file).load());
});

test('紀錄以最新在前,並限制筆數', () => {
  const store = new Store(tempFile()).load();
  store.addLog({ status: 'sent', commentId: 'a' });
  store.addLog({ status: 'failed', commentId: 'b' });
  const logs = store.getLogs();
  assert.equal(logs[0].commentId, 'b');
  assert.equal(store.stats().sent, 1);
  assert.equal(store.stats().failed, 1);
});
