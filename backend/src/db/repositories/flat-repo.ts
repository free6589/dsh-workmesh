import type { SqlDb } from '../sqlite.js';
import {
  all,
  get,
  isForeignKeyConstraintError,
  isUniqueConstraintError,
  run,
  type SqlValue,
} from '../sql.js';
import { NotFoundError, ValidationError } from '../errors.js';

export interface ListOptions {
  limit?: number;
  offset?: number;
}

export interface FlatRepoConfig {
  table: string;
  /** 创建时必填且必须为非空字符串（或有限数字）的列。 */
  required: readonly string[];
  createColumns: readonly string[];
  updateColumns: readonly string[];
  /** list/count 允许作为等值过滤条件的列。 */
  filterColumns: readonly string[];
  /** 唯一约束冲突时抛出的业务错误消息。 */
  conflictMessage?: string;
  /** 外键约束失败时抛出的业务错误消息。 */
  missingReferenceMessage?: string;
}

export interface FlatRepo<Row extends object, Create, Patch, Filter> {
  create(input: Create): Row;
  getById(id: string): Row | undefined;
  getByIdOrThrow(id: string): Row;
  list(filter?: Filter): Row[];
  count(filter?: Filter): number;
  update(id: string, patch: Patch): Row | undefined;
  delete(id: string): boolean;
}

function toSqlValue(table: string, value: unknown): SqlValue {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  throw new ValidationError(`${table}: unsupported value type '${typeof value}'`);
}

function validateNonNegativeInt(table: string, name: 'limit' | 'offset', value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${table}: ${name} must be a non-negative integer`);
  }
  return value;
}

/**
 * 为"单表 + 自增语义之外的标准 TEXT 主键"的实体生成统一 CRUD。
 * 列名一律来自配置白名单，输入对象中的未知字段直接报错，避免拼写错误静默生效。
 */
export function createFlatRepo<Row extends object, Create extends object, Patch extends object, Filter extends object>(
  db: SqlDb,
  cfg: FlatRepoConfig,
): FlatRepo<Row, Create, Patch, Filter> {
  const { table } = cfg;

  function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], phase: string): void {
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) throw new ValidationError(`${table}: unknown field '${key}' in ${phase}`);
    }
  }

  function assertRequired(record: Record<string, unknown>): void {
    for (const field of cfg.required) {
      const value = record[field];
      const ok =
        (typeof value === 'string' && value.trim() !== '') ||
        (typeof value === 'number' && Number.isFinite(value));
      if (!ok) throw new ValidationError(`${table}: field '${field}' is required`);
    }
  }

  function buildWhere(filter: Record<string, unknown> | undefined): { where: string; params: SqlValue[] } {
    if (!filter) return { where: '', params: [] };
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    for (const key of Object.keys(filter)) {
      if (key === 'limit' || key === 'offset') continue;
      if (!cfg.filterColumns.includes(key)) throw new ValidationError(`${table}: cannot filter by '${key}'`);
      clauses.push(`${key} = ?`);
      params.push(toSqlValue(table, filter[key]));
    }
    return { where: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
  }

  const repo: FlatRepo<Row, Create, Patch, Filter> = {
    create(input: Create): Row {
      const record = input as unknown as Record<string, unknown>;
      assertKnownKeys(record, cfg.createColumns, 'create');
      assertRequired(record);
      const explicitId = record['id'];
      const id = typeof explicitId === 'string' && explicitId !== '' ? explicitId : crypto.randomUUID();
      const columns: string[] = ['id'];
      const values: SqlValue[] = [id];
      for (const column of cfg.createColumns) {
        if (column === 'id') continue;
        const value = record[column];
        if (value === undefined || value === null) continue; // 留给数据库默认值
        columns.push(column);
        values.push(toSqlValue(table, value));
      }
      const placeholders = columns.map(() => '?').join(', ');
      try {
        run(db, `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, values);
      } catch (error) {
        if (isUniqueConstraintError(error) && cfg.conflictMessage) throw new ValidationError(cfg.conflictMessage);
        if (isForeignKeyConstraintError(error) && cfg.missingReferenceMessage) {
          throw new ValidationError(cfg.missingReferenceMessage);
        }
        throw error as Error;
      }
      return repo.getByIdOrThrow(id);
    },

    getById(id: string): Row | undefined {
      return get<Row>(db, `SELECT * FROM ${table} WHERE id = ?`, [id]);
    },

    getByIdOrThrow(id: string): Row {
      const row = repo.getById(id);
      if (!row) throw new NotFoundError(table, id);
      return row;
    },

    list(filter?: Filter): Row[] {
      const record = filter as Record<string, unknown> | undefined;
      const { where, params } = buildWhere(record);
      let sql = `SELECT * FROM ${table}${where} ORDER BY created_at, id`;
      const limit = record?.['limit'];
      const offset = record?.['offset'];
      if (limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(validateNonNegativeInt(table, 'limit', limit));
      }
      if (offset !== undefined) {
        if (limit === undefined) sql += ' LIMIT -1';
        sql += ' OFFSET ?';
        params.push(validateNonNegativeInt(table, 'offset', offset));
      }
      return all<Row>(db, sql, params);
    },

    count(filter?: Filter): number {
      const record = filter as Record<string, unknown> | undefined;
      const { where, params } = buildWhere(record);
      const row = get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}${where}`, params);
      return row?.n ?? 0;
    },

    update(id: string, patch: Patch): Row | undefined {
      const record = patch as unknown as Record<string, unknown>;
      assertKnownKeys(record, cfg.updateColumns, 'update');
      const sets: string[] = [];
      const values: SqlValue[] = [];
      for (const column of cfg.updateColumns) {
        const value = record[column];
        if (value === undefined) continue; // 未提供的字段不动；显式 null 置空
        sets.push(`${column} = ?`);
        values.push(toSqlValue(table, value));
      }
      if (sets.length === 0) return repo.getById(id);
      sets.push('updated_at = ?');
      values.push(new Date().toISOString(), id);
      const changes = run(db, `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, values).changes;
      return Number(changes) > 0 ? repo.getById(id) : undefined;
    },

    delete(id: string): boolean {
      const changes = run(db, `DELETE FROM ${table} WHERE id = ?`, [id]).changes;
      return Number(changes) > 0;
    },
  };
  return repo;
}
