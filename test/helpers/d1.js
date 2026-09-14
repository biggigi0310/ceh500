// 用 node:sqlite 做出一個和 Cloudflare D1 介面相容的假資料庫,
// 這樣測試跑到的是真正的 SQL,而不是被 mock 掉的行為。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../schema.sql');

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }

  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

export function createTestD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  return {
    prepare: (sql) => new FakeStatement(db, sql),
    batch: (statements) => Promise.all(statements.map((s) => s.run())),
    _raw: db,
  };
}
