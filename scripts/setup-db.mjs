#!/usr/bin/env node
// 一次做完:建立 D1 資料庫 → 把 database_id 寫進 wrangler.toml → 建立資料表。
// 用法:npm run setup:db
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'wrangler.toml');
const DB_NAME = 'fb-autoreply';

const say = (message) => console.log(message);
const fail = (message) => { console.error(`\n❌ ${message}\n`); process.exit(1); };

/** 執行 wrangler 並取得輸出;quiet = 失敗時不要把錯誤印出來嚇人。 */
function wrangler(args, { capture = false, quiet = false } = {}) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', quiet ? 'pipe' : 'inherit'] : 'inherit',
  });
}

function requireLogin() {
  // 注意:未登入時 wrangler whoami 仍然回傳成功,所以要看輸出內容判斷,不能只看有沒有拋錯。
  let output = '';
  try {
    output = wrangler(['whoami'], { capture: true, quiet: true });
  } catch (err) {
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }

  if (/not authenticated|wrangler login/i.test(output)) {
    fail('還沒登入 Cloudflare。請先執行:\n\n   npx wrangler login\n\n瀏覽器會跳出授權畫面,按「Allow」之後回到終端機,再執行一次 npm run setup:db');
  }

  const email = output.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
  say(`✅ 已登入 Cloudflare${email ? `(${email})` : ''}`);
}

function createDatabase() {
  say(`\n▶ 建立資料庫 ${DB_NAME}…`);
  try {
    // location apac = 資料放在亞太區,台灣連線比較快
    wrangler(['d1', 'create', DB_NAME, '--location', 'apac'], { capture: true, quiet: true });
    say('✅ 資料庫建立完成');
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (/already exists/i.test(output)) {
      say('ℹ️  這個資料庫已經存在,直接沿用');
      return;
    }
    fail(`建立資料庫失敗:\n${output.trim() || err.message}`);
  }
}

function findDatabaseId() {
  let databases;
  try {
    databases = JSON.parse(wrangler(['d1', 'list', '--json'], { capture: true, quiet: true }));
  } catch (err) {
    fail(`讀取資料庫清單失敗:${err.message}`);
  }

  const found = databases.find((db) => db.name === DB_NAME);
  if (!found) fail(`在你的帳號裡找不到名為 ${DB_NAME} 的資料庫`);

  const id = found.uuid ?? found.database_id ?? found.id;
  if (!id) fail(`找到資料庫但拿不到 ID,原始資料:${JSON.stringify(found)}`);
  return id;
}

function writeDatabaseId(databaseId) {
  const config = fs.readFileSync(CONFIG, 'utf8');
  const line = `database_id = "${databaseId}"`;

  if (config.includes(line)) {
    say('ℹ️  wrangler.toml 裡的 database_id 已經是正確的');
    return;
  }
  if (!/^database_id\s*=.*$/m.test(config)) {
    fail(`wrangler.toml 裡找不到 database_id 這一行,請手動加上:\n\n   ${line}`);
  }

  fs.writeFileSync(CONFIG, config.replace(/^database_id\s*=.*$/m, line));
  say(`✅ 已把 database_id 寫進 wrangler.toml`);
}

function createTables() {
  say('\n▶ 建立資料表…');
  try {
    wrangler(['d1', 'execute', DB_NAME, '--remote', '--file=./schema.sql'], { capture: true, quiet: true });
    say('✅ 資料表建立完成');
  } catch (err) {
    fail(`建立資料表失敗:\n${`${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message}`);
  }
}

say('── 設定 Cloudflare D1 資料庫 ──\n');
requireLogin();
createDatabase();
writeDatabaseId(findDatabaseId());
createTables();

say(`
🎉 第 2 步完成!

接下來是第 3 步,設定 6 組機密資料(每一行執行後會請你貼上內容):

   npx wrangler secret put FB_APP_SECRET
   npx wrangler secret put FB_VERIFY_TOKEN
   npx wrangler secret put FB_PAGE_ACCESS_TOKEN
   npx wrangler secret put FB_PAGE_ID
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET

還沒有 Facebook 的那幾組沒關係,可以先設 ADMIN_PASSWORD 和 SESSION_SECRET,
之後拿到再補設定即可。
`);
