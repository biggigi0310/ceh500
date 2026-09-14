import 'dotenv/config';
import path from 'node:path';

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int(process.env.PORT, 3000),
  appSecret: process.env.FB_APP_SECRET ?? '',
  verifyToken: process.env.FB_VERIFY_TOKEN ?? '',
  pageAccessToken: process.env.FB_PAGE_ACCESS_TOKEN ?? '',
  pageId: process.env.FB_PAGE_ID ?? '',
  graphVersion: process.env.FB_GRAPH_VERSION || 'v23.0',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  sessionSecret: process.env.SESSION_SECRET || process.env.FB_APP_SECRET || '',
  dataFile: path.resolve(process.env.DATA_FILE || './data/store.json'),
  dryRun: bool(process.env.DRY_RUN, false),
  minApiIntervalMs: int(process.env.MIN_API_INTERVAL_MS, 1200),
};

/**
 * 回傳設定缺漏的項目。缺 Facebook 憑證時仍可啟動(後台/演練模式可用),
 * 但缺後台密碼或 session secret 會直接讓程式無法安全運作。
 */
export function validateConfig(cfg = config) {
  const fatal = [];
  const warnings = [];

  if (!cfg.adminPassword) fatal.push('ADMIN_PASSWORD 未設定,後台無法登入');
  if (!cfg.sessionSecret) fatal.push('SESSION_SECRET 未設定(或退而求其次的 FB_APP_SECRET 也沒有)');

  if (!cfg.appSecret) warnings.push('FB_APP_SECRET 未設定,無法驗證 Webhook 簽章');
  if (!cfg.verifyToken) warnings.push('FB_VERIFY_TOKEN 未設定,Facebook 無法完成 Webhook 驗證');
  if (!cfg.pageAccessToken && !cfg.dryRun) warnings.push('FB_PAGE_ACCESS_TOKEN 未設定,無法真的送出私訊');
  if (!cfg.pageId) warnings.push('FB_PAGE_ID 未設定,無法過濾粉專自己的留言');

  return { fatal, warnings };
}
