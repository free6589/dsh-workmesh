import type { SqlDb } from './sqlite.js';

export { isUniqueConstraintError, isForeignKeyConstraintError } from './errors.js';

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export function run(db: SqlDb, sql: string, params: SqlValue[] = []): RunResult {
  return db.prepare(sql).run(...params);
}

export function get<T>(db: SqlDb, sql: string, params: SqlValue[] = []): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function all<T>(db: SqlDb, sql: string, params: SqlValue[] = []): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function countRows(db: SqlDb, sql: string, params: SqlValue[] = []): number {
  const row = get<{ n: number }>(db, sql, params);
  return row?.n ?? 0;
}
