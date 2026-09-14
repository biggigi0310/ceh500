import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/d1.js';
import { Store } from '../src/store.js';
import { createProcessor } from '../src/core/processor.js';
import { renderTemplate, matchesKeywords, shouldHandle, isTopLevelComment } from '../src/core/templates.js';
import { GraphError } from '../src/facebook.js';

const SETTINGS = { enabled: true, publicReplyEnabled: true, skipNestedComments: true, skipOwnComments: true };

function fakeFb(overrides = {}) {
  const calls = { dm: [], reply: [] };
  return {
    calls,
    async sendPrivateReply(commentId, message) {
      calls.dm.push({ commentId, message });
      if (overrides.dmError) throw overrides.dmError;
      return { id: 'mid.1' };
    },
    async replyToComment(commentId, message) {
      calls.reply.push({ commentId, message });
      if (overrides.replyError) throw overrides.replyError;
      return { id: 'cid.1' };
    },
  };
}

function commentEvent(overrides = {}) {
  return {
    item: 'comment',
    verb: 'add',
    comment_id: '100_200',
    post_id: '100',
    parent_id: '100',
    from: { id: 'user-1', name: '王小明' },
    message: '這間還在嗎?',
    ...overrides,
  };
}

const newStore = () => new Store(createTestD1());

test('renderTemplate 置換變數,未知變數留空', () => {
  assert.equal(renderTemplate('{{name}} 你好 {{link}} {{unknown}}', { name: '小明', link: 'https://a' }), '小明 你好 https://a ');
  assert.equal(renderTemplate('', { name: 'x' }), '');
  assert.equal(renderTemplate(undefined, {}), '');
});

test('matchesKeywords 只在 any 模式比對,不分大小寫', () => {
  assert.equal(matchesKeywords({ keywordMode: 'all_comments', keywords: ['詳細'] }, '隨便'), true);
  const rule = { keywordMode: 'any', keywords: ['詳細', 'Info'] };
  assert.equal(matchesKeywords(rule, '想看詳細資料'), true);
  assert.equal(matchesKeywords(rule, 'give me INFO'), true);
  assert.equal(matchesKeywords(rule, '好漂亮'), false);
  assert.equal(matchesKeywords(rule, undefined), false);
});

test('isTopLevelComment 以 parent_id 判斷', () => {
  assert.equal(isTopLevelComment({ post_id: '100', parent_id: '100' }), true);
  assert.equal(isTopLevelComment({ post_id: '100', parent_id: '100_200' }), false);
  assert.equal(isTopLevelComment({ post_id: '100' }), true);
});

test('shouldHandle 擋掉非新增留言、粉專自己的留言與子留言', () => {
  const ctx = { pageId: 'page-1', settings: SETTINGS };
  assert.equal(shouldHandle(commentEvent(), ctx).ok, true);
  assert.equal(shouldHandle(commentEvent({ item: 'post' }), ctx).ok, false);
  assert.equal(shouldHandle(commentEvent({ verb: 'remove' }), ctx).ok, false);
  assert.equal(shouldHandle(commentEvent({ from: { id: 'page-1' } }), ctx).ok, false);
  assert.equal(shouldHandle(commentEvent({ parent_id: '100_199' }), ctx).ok, false);
});

test('符合規則時會私訊並公開回覆', async () => {
  const store = newStore();
  await store.upsertRule({ postId: '100', link: 'https://house/1', dmTemplate: '{{name}} 連結:{{link}}', publicReplyTemplate: '{{name}} 已私訊' });
  const fb = fakeFb();

  const result = await createProcessor({ fb, store }).handleChange(commentEvent(), { pageId: 'page-1' });

  assert.equal(result.status, 'sent');
  assert.deepEqual(fb.calls.dm, [{ commentId: '100_200', message: '王小明 連結:https://house/1' }]);
  assert.deepEqual(fb.calls.reply, [{ commentId: '100_200', message: '王小明 已私訊' }]);
  assert.equal((await store.getLogs())[0].status, 'sent');
});

test('同一則留言不會被處理兩次', async () => {
  const store = newStore();
  await store.upsertRule({ postId: '100', dmTemplate: 'hi' });
  const fb = fakeFb();
  const processor = createProcessor({ fb, store });

  await processor.handleChange(commentEvent(), { pageId: 'page-1' });
  const second = await processor.handleChange(commentEvent(), { pageId: 'page-1' });

  assert.equal(second.status, 'skipped');
  assert.equal(fb.calls.dm.length, 1);
});

test('同時湧入的重複事件只會私訊一次', async () => {
  const store = newStore();
  await store.upsertRule({ postId: '100', dmTemplate: 'hi' });
  const fb = fakeFb();
  const processor = createProcessor({ fb, store });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => processor.handleChange(commentEvent(), { pageId: 'page-1' })),
  );

  assert.equal(results.filter((r) => r.status === 'sent').length, 1);
  assert.equal(fb.calls.dm.length, 1);
});

test('私訊失敗時不會公開回覆「已私訊」', async () => {
  const store = newStore();
  await store.upsertRule({ postId: '100', dmTemplate: 'hi', publicReplyTemplate: '已私訊' });
  const fb = fakeFb({ dmError: new GraphError('已私訊過', { code: 10903 }) });

  const result = await createProcessor({ fb, store }).handleChange(commentEvent(), { pageId: 'page-1' });

  assert.equal(result.status, 'failed');
  assert.equal(fb.calls.reply.length, 0);
  assert.match((await store.getLogs())[0].error, /只能私訊一次/);
});

test('暫時性失敗會放掉佔位,讓 Facebook 重送時能補送', async () => {
  const store = newStore();
  await store.upsertRule({ postId: '100', dmTemplate: 'hi' });
  const failing = fakeFb({ dmError: new GraphError('限流', { code: 4 }) });

  const first = await createProcessor({ fb: failing, store }).handleChange(commentEvent(), { pageId: 'page-1' });
  assert.equal(first.status, 'retryable');

  const recovered = fakeFb();
  const second = await createProcessor({ fb: recovered, store }).handleChange(commentEvent(), { pageId: 'page-1' });
  assert.equal(second.status, 'sent', '重送時應該要能成功補發');
});

test('公開回覆失敗仍算私訊成功', async () => {
  const store = newStore();
  await store.upsertRule({ postId: '100', dmTemplate: 'hi', publicReplyTemplate: '已私訊' });
  const fb = fakeFb({ replyError: new GraphError('權限不足', { code: 200 }) });

  const result = await createProcessor({ fb, store }).handleChange(commentEvent(), { pageId: 'page-1' });

  assert.equal(result.status, 'sent');
  assert.ok(result.publicReplyError);
});

test('關掉公開回覆後只私訊', async () => {
  const store = newStore();
  await store.updateSettings({ publicReplyEnabled: false });
  await store.upsertRule({ postId: '100', dmTemplate: 'hi', publicReplyTemplate: '已私訊' });
  const fb = fakeFb();

  await createProcessor({ fb, store }).handleChange(commentEvent(), { pageId: 'page-1' });
  assert.equal(fb.calls.reply.length, 0);
});

test('總開關關閉時完全不動作', async () => {
  const store = newStore();
  await store.updateSettings({ enabled: false });
  await store.upsertRule({ postId: '100', dmTemplate: 'hi' });
  const fb = fakeFb();

  const result = await createProcessor({ fb, store }).handleChange(commentEvent(), { pageId: 'page-1' });
  assert.equal(result.status, 'skipped');
  assert.equal(fb.calls.dm.length, 0);
});

test('關鍵字不符時不私訊', async () => {
  const store = newStore();
  await store.upsertRule({ postId: '100', dmTemplate: 'hi', keywordMode: 'any', keywords: ['詳細'] });
  const fb = fakeFb();

  const result = await createProcessor({ fb, store }).handleChange(commentEvent({ message: '好美' }), { pageId: 'page-1' });
  assert.equal(result.status, 'skipped');
  assert.equal(fb.calls.dm.length, 0);
});

test('handleWebhookPayload 處理整包事件並略過非 feed 欄位', async () => {
  const store = newStore();
  await store.upsertRule({ postId: '100', dmTemplate: 'hi' });
  const fb = fakeFb();

  const results = await createProcessor({ fb, store }).handleWebhookPayload({
    object: 'page',
    entry: [{
      id: 'page-1',
      changes: [
        { field: 'feed', value: commentEvent() },
        { field: 'ratings', value: {} },
        { field: 'feed', value: commentEvent({ comment_id: '100_201', from: { id: 'u2', name: '李小美' } }) },
      ],
    }],
  }, { pageId: 'page-1' });

  assert.equal(results.filter((r) => r.status === 'sent').length, 2);
  assert.equal(fb.calls.dm.length, 2);
});
