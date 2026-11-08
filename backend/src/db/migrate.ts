import type { SqlDb } from './sqlite.js';
import type { Migration } from './migrations.js';
import { migrations } from './migrations.js';

const LEDGER_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;

/** 已应用迁移的 id 列表（按 id 排序）。首次调用会顺带创建账本表。 */
export function appliedMigrations(db: SqlDb): string[] {
  db.exec(LEDGER_SQL);
  const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as unknown as {
    id: string;
  }[];
  return rows.map((row) => row.id);
}

/**
 * 幂等迁移：按迁移清单顺序，跳过账本中已记录的迁移，其余在事务内执行。
 * 返回本次新应用的迁移 id。所有语句均为 IF NOT EXISTS，即使账本与库状态
 * 不一致（例如账本被清空），重复执行也不会破坏既有结构。
 */
export function runMigrations(db: SqlDb, list: Migration[] = migrations): string[] {
  const applied = new Set(appliedMigrations(db));
  const newlyApplied: string[] = [];
  for (const migration of list) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migration.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`migration ${migration.id} failed: ${detail}`);
    }
    newlyApplied.push(migration.id);
    applied.add(migration.id);
  }
  return newlyApplied;
}
