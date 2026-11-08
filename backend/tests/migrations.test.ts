import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appliedMigrations, runMigrations } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations.js';
import { openDatabase, type SqlDb } from '../src/db/sqlite.js';
import { all, run } from '../src/db/sql.js';

const EXPECTED_TABLES = [
  'projects',
  'project_repos',
  'modules',
  'phases',
  'tasks',
  'subtasks',
  'task_dependencies',
  'models',
  'gateways',
  'quotas',
  'agents',
  'runs',
  'run_events',
  'audit_log',
  'settings',
];

function tableNames(db: SqlDb): string[] {
  return all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).map((row) => row.name);
}

describe('migrations', () => {
  it('applies every migration on a fresh in-memory database', () => {
    const db = openDatabase(':memory:');
    const applied = runMigrations(db);
    expect(applied).toEqual(migrations.map((m) => m.id));
    const tables = tableNames(db);
    for (const table of EXPECTED_TABLES) {
      expect(tables).toContain(table);
    }
    expect(appliedMigrations(db)).toEqual([...migrations.map((m) => m.id)].sort());
  });

  it('is idempotent: a second run applies nothing and duplicates no tables', () => {
    const db = openDatabase(':memory:');
    expect(runMigrations(db)).toHaveLength(migrations.length);
    expect(runMigrations(db)).toEqual([]);
    expect(runMigrations(db)).toEqual([]);
    expect(tableNames(db).filter((name) => name === 'projects')).toHaveLength(1);
    expect(appliedMigrations(db)).toHaveLength(migrations.length);
  });

  it('is idempotent across reopen on a file database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'workmesh-migrate-'));
    try {
      const file = path.join(dir, 'test.db');
      const first = openDatabase(file);
      runMigrations(first);
      first.close();

      const second = openDatabase(file);
      expect(runMigrations(second)).toEqual([]);
      expect(tableNames(second)).toEqual(expect.arrayContaining(EXPECTED_TABLES));
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives a lost ledger because every statement is IF NOT EXISTS', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    run(db, 'DELETE FROM schema_migrations');
    expect(() => runMigrations(db)).not.toThrow();
    expect(appliedMigrations(db)).toHaveLength(migrations.length);
    expect(tableNames(db).filter((name) => name === 'tasks')).toHaveLength(1);
  });

  it('enforces foreign keys so bad references fail loudly', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    expect(() =>
      db
        .prepare('INSERT INTO project_repos (id, project_id, repo_full_name) VALUES (?, ?, ?)')
        .run('r1', 'missing-project', 'owner/repo'),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});
