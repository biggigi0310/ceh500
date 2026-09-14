import { randomId } from './lib/crypto.js';

export const DEFAULT_DM_TEMPLATE =
  '{{name}} 您好,謝謝您的留言 🙏\n' +
  '這是您詢問的物件資料:\n{{link}}\n\n' +
  '有任何問題都可以直接在這裡問我,我會盡快回覆您!';

export const DEFAULT_PUBLIC_REPLY_TEMPLATE = '{{name}} 您好,已私訊物件連結給您囉,麻煩查收訊息 📩';

const DEFAULT_SETTINGS = {
  enabled: true,
  publicReplyEnabled: true,
  skipNestedComments: true,
  skipOwnComments: true,
};

const MAX_LOGS = 500;

function rowToRule(row) {
  let keywords = [];
  try {
    const parsed = JSON.parse(row.keywords ?? '[]');
    if (Array.isArray(parsed)) keywords = parsed;
  } catch {
    keywords = [];
  }
  return {
    id: row.id,
    name: row.name ?? '',
    postId: row.post_id,
    enabled: row.enabled === 1 || row.enabled === true,
    link: row.link ?? '',
    dmTemplate: row.dm_template,
    publicReplyTemplate: row.public_reply_template ?? '',
    keywords,
    keywordMode: row.keyword_mode === 'any' ? 'any' : 'all_comments',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  async getSettings() {
    const { results } = await this.db.prepare('SELECT key, value FROM settings').all();
    const stored = Object.fromEntries((results ?? []).map((row) => [row.key, row.value === '1']));
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  async updateSettings(patch) {
    const statements = Object.entries(patch)
      .filter(([key]) => key in DEFAULT_SETTINGS)
      .map(([key, value]) => this.db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(key, value ? '1' : '0'));
    if (statements.length) await this.db.batch(statements);
    return this.getSettings();
  }

  async listRules() {
    const { results } = await this.db.prepare('SELECT * FROM rules ORDER BY created_at DESC').all();
    return (results ?? []).map(rowToRule);
  }

  async getRule(id) {
    const row = await this.db.prepare('SELECT * FROM rules WHERE id = ?').bind(id).first();
    return row ? rowToRule(row) : null;
  }

  /** 只查這篇貼文的規則和萬用規則,避免每次留言都把整張表撈出來。 */
  async findRuleForPost(postId) {
    const row = await this.db
      .prepare(`SELECT * FROM rules
                WHERE enabled = 1 AND post_id IN (?, '*')
                ORDER BY CASE WHEN post_id = '*' THEN 1 ELSE 0 END
                LIMIT 1`)
      .bind(postId ?? '')
      .first();
    return row ? rowToRule(row) : null;
  }

  async upsertRule(input) {
    const now = new Date().toISOString();
    const existing = input.id ? await this.getRule(input.id) : null;
    const merged = { ...(existing ?? {}), ...input };

    const rule = {
      id: existing?.id ?? randomId(),
      name: merged.name ?? '',
      postId: String(merged.postId ?? '').trim(),
      enabled: merged.enabled !== false,
      link: merged.link ?? '',
      dmTemplate: merged.dmTemplate || DEFAULT_DM_TEMPLATE,
      publicReplyTemplate: merged.publicReplyTemplate ?? DEFAULT_PUBLIC_REPLY_TEMPLATE,
      keywords: Array.isArray(merged.keywords) ? merged.keywords.filter(Boolean) : [],
      keywordMode: merged.keywordMode === 'any' ? 'any' : 'all_comments',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.db
      .prepare(`INSERT INTO rules (id, name, post_id, enabled, link, dm_template, public_reply_template,
                                   keywords, keyword_mode, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  name = excluded.name, post_id = excluded.post_id, enabled = excluded.enabled,
                  link = excluded.link, dm_template = excluded.dm_template,
                  public_reply_template = excluded.public_reply_template, keywords = excluded.keywords,
                  keyword_mode = excluded.keyword_mode, updated_at = excluded.updated_at`)
      .bind(rule.id, rule.name, rule.postId, rule.enabled ? 1 : 0, rule.link, rule.dmTemplate,
        rule.publicReplyTemplate, JSON.stringify(rule.keywords), rule.keywordMode,
        rule.createdAt, rule.updatedAt)
      .run();

    return rule;
  }

  async deleteRule(id) {
    const result = await this.db.prepare('DELETE FROM rules WHERE id = ?').bind(id).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * 用主鍵衝突當作鎖:搶到(真的插入了)才回傳 true。
   * 兩個 webhook 同時進來也只有一個會拿到,所以不會重複私訊。
   */
  async claimComment(commentId, ruleId) {
    const result = await this.db
      .prepare('INSERT OR IGNORE INTO processed_comments (comment_id, status, rule_id, at) VALUES (?, ?, ?, ?)')
      .bind(commentId, 'processing', ruleId ?? null, new Date().toISOString())
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async markProcessed(commentId, { status, ruleId, error }) {
    await this.db
      .prepare('UPDATE processed_comments SET status = ?, rule_id = ?, error = ?, at = ? WHERE comment_id = ?')
      .bind(status, ruleId ?? null, error ?? null, new Date().toISOString(), commentId)
      .run();
  }

  async releaseComment(commentId) {
    await this.db.prepare('DELETE FROM processed_comments WHERE comment_id = ?').bind(commentId).run();
  }

  async getProcessed(commentId) {
    return this.db.prepare('SELECT * FROM processed_comments WHERE comment_id = ?').bind(commentId).first();
  }

  async addLog(entry) {
    await this.db
      .prepare(`INSERT INTO logs (id, at, status, comment_id, post_id, rule_id, rule_name, author, comment,
                                 dm_message, public_reply, public_reply_error, error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(randomId(), new Date().toISOString(), entry.status, entry.commentId ?? null, entry.postId ?? null,
        entry.ruleId ?? null, entry.ruleName ?? null, entry.author ?? null, entry.comment ?? null,
        entry.dmMessage ?? null, entry.publicReply ?? null, entry.publicReplyError ?? null, entry.error ?? null)
      .run();

    // 只留最近的紀錄,免得免費層的資料庫愈長愈大。
    await this.db
      .prepare('DELETE FROM logs WHERE seq NOT IN (SELECT seq FROM logs ORDER BY seq DESC LIMIT ?)')
      .bind(MAX_LOGS)
      .run();
  }

  async getLogs(limit = 100) {
    const { results } = await this.db
      .prepare('SELECT * FROM logs ORDER BY seq DESC LIMIT ?')
      .bind(Math.min(limit, MAX_LOGS))
      .all();
    return (results ?? []).map((row) => ({
      id: row.id,
      at: row.at,
      status: row.status,
      commentId: row.comment_id,
      postId: row.post_id,
      ruleName: row.rule_name,
      author: row.author,
      comment: row.comment,
      dmMessage: row.dm_message,
      publicReply: row.public_reply,
      publicReplyError: row.public_reply_error,
      error: row.error,
    }));
  }

  async stats() {
    const row = await this.db
      .prepare(`SELECT
                  (SELECT COUNT(*) FROM rules)                              AS rules,
                  (SELECT COUNT(*) FROM processed_comments)                 AS processed,
                  (SELECT COUNT(*) FROM logs WHERE status = 'sent')         AS sent,
                  (SELECT COUNT(*) FROM logs WHERE status = 'failed')       AS failed`)
      .first();
    return { rules: row?.rules ?? 0, processed: row?.processed ?? 0, sent: row?.sent ?? 0, failed: row?.failed ?? 0 };
  }
}
