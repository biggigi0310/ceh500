import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_LOGS = 500;
const MAX_PROCESSED = 5000;

export const DEFAULT_DM_TEMPLATE =
  '{{name}} 您好,謝謝您的留言 🙏\n' +
  '這是您詢問的物件資料:\n{{link}}\n\n' +
  '有任何問題都可以直接在這裡問我,我會盡快回覆您!';

export const DEFAULT_PUBLIC_REPLY_TEMPLATE = '{{name}} 您好,已私訊物件連結給您囉,麻煩查收訊息 📩';

function emptyData() {
  return {
    version: 1,
    settings: {
      enabled: true,
      publicReplyEnabled: true,
      skipNestedComments: true,
      skipOwnComments: true,
    },
    rules: [],
    processed: {},
    logs: [],
  };
}

/** 補齊缺少的欄位,讓舊檔案或手動編輯過的檔案也能安全載入。 */
function normalize(raw) {
  const base = emptyData();
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: base.version,
    settings: { ...base.settings, ...(raw.settings ?? {}) },
    rules: Array.isArray(raw.rules) ? raw.rules.map(normalizeRule) : [],
    processed: raw.processed && typeof raw.processed === 'object' ? raw.processed : {},
    logs: Array.isArray(raw.logs) ? raw.logs : [],
  };
}

function normalizeRule(rule) {
  return {
    id: rule.id || crypto.randomUUID(),
    name: rule.name ?? '',
    postId: String(rule.postId ?? '').trim(),
    enabled: rule.enabled !== false,
    link: rule.link ?? '',
    dmTemplate: rule.dmTemplate || DEFAULT_DM_TEMPLATE,
    publicReplyTemplate: rule.publicReplyTemplate ?? DEFAULT_PUBLIC_REPLY_TEMPLATE,
    keywords: Array.isArray(rule.keywords) ? rule.keywords.filter(Boolean) : [],
    keywordMode: rule.keywordMode === 'any' ? 'any' : 'all_comments',
    createdAt: rule.createdAt || new Date().toISOString(),
    updatedAt: rule.updatedAt || rule.createdAt || new Date().toISOString(),
  };
}

export class Store {
  #file;
  #data;
  #writeChain = Promise.resolve();

  constructor(file) {
    this.#file = file;
    this.#data = emptyData();
  }

  load() {
    try {
      const text = fs.readFileSync(this.#file, 'utf8');
      this.#data = normalize(JSON.parse(text));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.#data = emptyData();
    }
    return this;
  }

  /** 以「寫暫存檔再 rename」的方式落盤,避免程式中斷時檔案毀損。 */
  save() {
    const snapshot = JSON.stringify(this.#data, null, 2);
    this.#writeChain = this.#writeChain.then(async () => {
      await fsp.mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, this.#file);
    }).catch(() => {});
    return this.#writeChain;
  }

  get settings() {
    return { ...this.#data.settings };
  }

  updateSettings(patch) {
    this.#data.settings = { ...this.#data.settings, ...patch };
    this.save();
    return this.settings;
  }

  get rules() {
    return this.#data.rules.map((r) => ({ ...r }));
  }

  getRule(id) {
    const found = this.#data.rules.find((r) => r.id === id);
    return found ? { ...found } : null;
  }

  upsertRule(input) {
    const now = new Date().toISOString();
    const existingIndex = input.id ? this.#data.rules.findIndex((r) => r.id === input.id) : -1;
    if (existingIndex >= 0) {
      const merged = normalizeRule({ ...this.#data.rules[existingIndex], ...input, updatedAt: now });
      this.#data.rules[existingIndex] = merged;
      this.save();
      return { ...merged };
    }
    const created = normalizeRule({ ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now });
    this.#data.rules.push(created);
    this.save();
    return { ...created };
  }

  deleteRule(id) {
    const before = this.#data.rules.length;
    this.#data.rules = this.#data.rules.filter((r) => r.id !== id);
    const removed = before !== this.#data.rules.length;
    if (removed) this.save();
    return removed;
  }

  isProcessed(commentId) {
    return Boolean(this.#data.processed[commentId]);
  }

  getProcessed(commentId) {
    const entry = this.#data.processed[commentId];
    return entry ? { ...entry } : null;
  }

  markProcessed(commentId, entry) {
    this.#data.processed[commentId] = { ...entry, at: new Date().toISOString() };
    const keys = Object.keys(this.#data.processed);
    if (keys.length > MAX_PROCESSED) {
      for (const key of keys.slice(0, keys.length - MAX_PROCESSED)) {
        delete this.#data.processed[key];
      }
    }
    this.save();
  }

  addLog(entry) {
    this.#data.logs.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
    if (this.#data.logs.length > MAX_LOGS) this.#data.logs.length = MAX_LOGS;
    this.save();
  }

  getLogs(limit = 100) {
    return this.#data.logs.slice(0, limit).map((l) => ({ ...l }));
  }

  stats() {
    const logs = this.#data.logs;
    return {
      rules: this.#data.rules.length,
      processed: Object.keys(this.#data.processed).length,
      sent: logs.filter((l) => l.status === 'sent').length,
      failed: logs.filter((l) => l.status === 'failed').length,
    };
  }
}
