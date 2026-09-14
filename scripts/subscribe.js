#!/usr/bin/env node
// 讓 App 訂閱粉專的 feed 事件。設定好 .env 之後執行一次即可。
import { config } from '../src/config.js';
import { FacebookClient, explainGraphError } from '../src/facebook.js';

const fb = new FacebookClient({
  accessToken: config.pageAccessToken,
  version: config.graphVersion,
  minInterval: 0,
});

try {
  if (!config.pageId) throw new Error('請先在 .env 設定 FB_PAGE_ID');
  const page = await fb.getPageInfo(config.pageId);
  console.log(`粉專:${page.name} (${page.id})`);

  await fb.subscribePage(config.pageId);
  const subs = await fb.listSubscribedApps(config.pageId);
  console.log('已訂閱欄位:', subs.data?.[0]?.subscribed_fields?.join(', ') ?? '(無)');
  console.log('✅ 完成,現在粉專留言會送到你的 Webhook。');
} catch (err) {
  console.error('❌ 失敗:', explainGraphError(err));
  process.exit(1);
}
