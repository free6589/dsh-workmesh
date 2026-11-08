/**
 * 服务装配上下文
 * ==============
 * 路由自动加载约定（src/routes/_loader.ts）在 import 路由文件时不传入任何上下文，
 * 数据库句柄无法从入口注入；同时入口 server.ts 归 data_layer 所有、不可修改。
 * 本模块提供进程级装配：
 *
 * - 测试：bindServices(db) 注入既有句柄，让自动加载的路由与测试共用同一个库；
 * - 生产：首次请求时按 config.dbPath 打开数据库并补齐幂等迁移，随后缓存复用。
 *
 * 本任务自有表 project_lifecycle 也在这里幂等建表：data_layer 的迁移清单不可
 * 修改，且 projects.status 被 CHECK 限定为 ('active','archived')，而项目 API 的
 * 六态生命周期（Planning/Active/Paused/Maintenance/Completed/Archived）需要更细
 * 的状态存储——明细落在本表，projects.status 仅作粗粒度投影
 * （Archived → 'archived'，其余 → 'active'），保持 data_layer 视角一致。
 */
import { loadConfig } from '../config.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { runMigrations } from '../db/migrate.js';
import { run } from '../db/sql.js';
import { openDatabase, type SqlDb } from '../db/sqlite.js';
import { ProjectsService } from './projects.js';
import { TasksService } from './tasks.js';

export const PROJECT_LIFECYCLE_DDL = `
  CREATE TABLE IF NOT EXISTS project_lifecycle (
    project_id TEXT NOT NULL PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'Planning' CHECK (
      status IN ('Planning','Active','Paused','Maintenance','Completed','Archived')
    ),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
`;

const schemaReady = new WeakSet<SqlDb>();

/** 幂等确保本任务自有表存在（每个数据库句柄只执行一次）。 */
export function ensureProjectsSchema(db: SqlDb): void {
  if (schemaReady.has(db)) return;
  run(db, PROJECT_LIFECYCLE_DDL);
  schemaReady.add(db);
}

export interface Services {
  db: SqlDb;
  repos: Repositories;
  projects: ProjectsService;
  tasks: TasksService;
}

function buildServices(db: SqlDb): Services {
  ensureProjectsSchema(db);
  const repos = createRepositories(db);
  return {
    db,
    repos,
    projects: new ProjectsService({ db, repos }),
    tasks: new TasksService({ db, repos }),
  };
}

let current: Services | null = null;

/** 测试注入：绑定后 getServices() 返回同一份装配（同一数据库句柄）。 */
export function bindServices(db: SqlDb): Services {
  current = buildServices(db);
  return current;
}

/** 生产回退：首次请求按配置打开数据库（幂等迁移）并缓存到进程。 */
export function getServices(): Services {
  if (!current) {
    const db = openDatabase(loadConfig().dbPath);
    runMigrations(db);
    current = buildServices(db);
  }
  return current;
}
