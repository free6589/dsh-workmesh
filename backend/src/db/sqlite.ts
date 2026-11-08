import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqlDb = DatabaseSync;

export interface OpenDatabaseOptions {
  /** 打开时逐条执行的 PRAGMA；默认 WAL + 外键约束 + 忙等待。 */
  pragmas?: string[];
}

const DEFAULT_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
];

/** 打开（必要时创建）SQLite 数据库并应用 PRAGMA。`file` 可为 ':memory:'。 */
export function openDatabase(file: string, options: OpenDatabaseOptions = {}): SqlDb {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
  const pragmas = options.pragmas ?? DEFAULT_PRAGMAS;
  const db = new DatabaseSync(file);
  for (const pragma of pragmas) {
    db.exec(pragma);
  }
  return db;
}

/** 在事务中执行 fn；抛出异常时回滚并原样抛出。 */
export function withTransaction<T>(db: SqlDb, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
