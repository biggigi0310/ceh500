-- 建立資料表:wrangler d1 execute fb-autoreply --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL DEFAULT '',
  post_id               TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  link                  TEXT NOT NULL DEFAULT '',
  dm_template           TEXT NOT NULL,
  public_reply_template TEXT NOT NULL DEFAULT '',
  keywords              TEXT NOT NULL DEFAULT '[]',
  keyword_mode          TEXT NOT NULL DEFAULT 'all_comments',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rules_lookup ON rules (post_id, enabled);

-- comment_id 是主鍵,靠 INSERT OR IGNORE 做到「同一則留言只會被處理一次」
CREATE TABLE IF NOT EXISTS processed_comments (
  comment_id TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  rule_id    TEXT,
  error      TEXT,
  at         TEXT NOT NULL
);

-- seq 是自動遞增的,用它排序才不會因為同一毫秒寫入兩筆而順序錯亂
CREATE TABLE IF NOT EXISTS logs (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL,
  at                 TEXT NOT NULL,
  status             TEXT NOT NULL,
  comment_id         TEXT,
  post_id            TEXT,
  rule_id            TEXT,
  rule_name          TEXT,
  author             TEXT,
  comment            TEXT,
  dm_message         TEXT,
  public_reply       TEXT,
  public_reply_error TEXT,
  error              TEXT
);

