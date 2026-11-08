import type { SqlDb } from '../sqlite.js';
import { all, get, isForeignKeyConstraintError, run, type SqlValue } from '../sql.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { createFlatRepo, type FlatRepo, type ListOptions } from './flat-repo.js';
import type {
  AuditLogEntry,
  CreateAuditLogEntry,
  CreateRun,
  Run,
  RunEvent,
  RunEventLevel,
  RunStatus,
  Setting,
  UpdateRun,
} from '../../types/entities.js';

// ---------- runs ----------
export interface RunFilter
  extends Partial<Pick<Run, 'project_id' | 'task_id' | 'agent_id' | 'status'>>,
  ListOptions {}

export type RunsRepo = FlatRepo<Run, CreateRun, UpdateRun, RunFilter> & {
  /** queued/running -> running，记录 started_at。终态 run 不可再启动。 */
  start(id: string): Run;
  /** 进入终态并记录 finished_at；error 仅在 failed 时有意义。 */
  finish(id: string, result: { status: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'>; error?: string }): Run;
  /** 未结束（queued/running）的 run。 */
  listUnfinished(): Run[];
};

const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];

export function newRunsRepo(db: SqlDb): RunsRepo {
  const flat = createFlatRepo<Run, CreateRun, UpdateRun, RunFilter>(db, {
    table: 'runs',
    required: [],
    createColumns: ['id', 'project_id', 'task_id', 'agent_id', 'status'],
    updateColumns: ['status', 'error'],
    filterColumns: ['project_id', 'task_id', 'agent_id', 'status'],
    missingReferenceMessage: 'referenced project/task/agent does not exist',
  });

  function requireMutable(id: string): Run {
    const existing = flat.getById(id);
    if (!existing) throw new NotFoundError('runs', id);
    if (TERMINAL_RUN_STATUSES.includes(existing.status)) {
      throw new ValidationError(`run '${id}' is already finished (${existing.status})`);
    }
    return existing;
  }

  return {
    ...flat,
    start(id: string): Run {
      requireMutable(id);
      const now = new Date().toISOString();
      run(
        db,
        `UPDATE runs SET status = 'running', started_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued','running')`,
        [now, now, id],
      );
      return flat.getByIdOrThrow(id);
    },

    finish(id, result): Run {
      requireMutable(id);
      const now = new Date().toISOString();
      run(
        db,
        `UPDATE runs SET status = ?, finished_at = ?, error = ?, updated_at = ? WHERE id = ?`,
        [result.status, now, result.error ?? null, now, id],
      );
      return flat.getByIdOrThrow(id);
    },

    listUnfinished(): Run[] {
      return all<Run>(
        db,
        `SELECT * FROM runs WHERE status IN ('queued','running') ORDER BY created_at, id`,
      );
    },
  };
}

// ---------- run_events ----------
export type RunEventsRepo = {
  append(input: { run_id: string; level?: RunEventLevel; type?: string; payload?: unknown }): RunEvent;
  listByRun(runId: string, options?: { afterSeq?: number; limit?: number }): RunEvent[];
  deleteByRun(runId: string): number;
};

export function newRunEventsRepo(db: SqlDb): RunEventsRepo {
  return {
    append(input): RunEvent {
      let payload: string;
      try {
        payload = input.payload === undefined ? '{}' : JSON.stringify(input.payload);
      } catch (error) {
        throw new ValidationError(`run event payload is not JSON-serializable: ${String(error)}`);
      }
      try {
        run(db, 'INSERT INTO run_events (run_id, level, type, payload) VALUES (?, ?, ?, ?)', [
          input.run_id,
          input.level ?? 'info',
          input.type ?? 'log',
          payload,
        ]);
      } catch (error) {
        if (isForeignKeyConstraintError(error)) throw new NotFoundError('runs', input.run_id);
        throw error as Error;
      }
      const row = get<RunEvent>(
        db,
        'SELECT * FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1',
        [input.run_id],
      );
      if (!row) throw new Error('run_events insert did not persist');
      return row;
    },

    listByRun(runId: string, options: { afterSeq?: number; limit?: number } = {}): RunEvent[] {
      const params: SqlValue[] = [runId];
      let sql = 'SELECT * FROM run_events WHERE run_id = ?';
      if (options.afterSeq !== undefined) {
        sql += ' AND seq > ?';
        params.push(options.afterSeq);
      }
      sql += ' ORDER BY seq';
      if (options.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(options.limit);
      }
      return all<RunEvent>(db, sql, params);
    },

    deleteByRun(runId: string): number {
      return Number(run(db, 'DELETE FROM run_events WHERE run_id = ?', [runId]).changes);
    },
  };
}

// ---------- audit_log ----------
export interface AuditLogFilter
  extends Partial<Pick<AuditLogEntry, 'actor' | 'action' | 'entity_type' | 'entity_id'>>,
  ListOptions {}

export type AuditLogRepo = {
  record(input: CreateAuditLogEntry): AuditLogEntry;
  list(filter?: AuditLogFilter): AuditLogEntry[];
};

export function newAuditLogRepo(db: SqlDb): AuditLogRepo {
  return {
    record(input): AuditLogEntry {
      let detail: string;
      try {
        detail = input.detail === undefined ? '{}' : JSON.stringify(input.detail);
      } catch (error) {
        throw new ValidationError(`audit detail is not JSON-serializable: ${String(error)}`);
      }
      const actor = input.actor ?? 'system';
      if (typeof input.action !== 'string' || input.action.trim() === '') {
        throw new ValidationError('audit_log: field \'action\' is required');
      }
      run(db, 'INSERT INTO audit_log (actor, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?)', [
        actor,
        input.action,
        input.entity_type ?? '',
        input.entity_id ?? '',
        detail,
      ]);
      const row = get<AuditLogEntry>(db, 'SELECT * FROM audit_log ORDER BY seq DESC LIMIT 1');
      if (!row) throw new Error('audit_log insert did not persist');
      return row;
    },

    list(filter: AuditLogFilter = {}): AuditLogEntry[] {
      const clauses: string[] = [];
      const params: SqlValue[] = [];
      const filterable: readonly (keyof AuditLogFilter)[] = ['actor', 'action', 'entity_type', 'entity_id'];
      for (const key of filterable) {
        const value = filter[key];
        if (value === undefined) continue;
        clauses.push(`${key} = ?`);
        params.push(value);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      let sql = `SELECT * FROM audit_log${where} ORDER BY seq DESC`;
      if (filter.limit !== undefined) {
        sql += ' LIMIT ?';
        params.push(filter.limit);
      }
      return all<AuditLogEntry>(db, sql, params);
    },
  };
}

// ---------- settings ----------
export type SettingsRepo = {
  get(key: string): string | undefined;
  require(key: string): string;
  /** upsert；返回最新行。 */
  set(key: string, value: string): Setting;
  delete(key: string): boolean;
  keys(): string[];
  list(): Setting[];
};

export function newSettingsRepo(db: SqlDb): SettingsRepo {
  return {
    get(key: string): string | undefined {
      return get<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', [key])?.value;
    },

    require(key: string): string {
      const value = this.get(key);
      if (value === undefined) throw new NotFoundError('settings', key);
      return value;
    },

    set(key: string, value: string): Setting {
      if (typeof key !== 'string' || key.trim() === '') {
        throw new ValidationError('settings: key is required');
      }
      run(
        db,
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value],
      );
      const row = get<Setting>(db, 'SELECT * FROM settings WHERE key = ?', [key]);
      if (!row) throw new Error('settings upsert did not persist');
      return row;
    },

    delete(key: string): boolean {
      return Number(run(db, 'DELETE FROM settings WHERE key = ?', [key]).changes) > 0;
    },

    keys(): string[] {
      return all<{ key: string }>(db, 'SELECT key FROM settings ORDER BY key').map((row) => row.key);
    },

    list(): Setting[] {
      return all<Setting>(db, 'SELECT * FROM settings ORDER BY key');
    },
  };
}
