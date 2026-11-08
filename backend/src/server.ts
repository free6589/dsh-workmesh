import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, type BackendConfig } from './config.js';
import { NotFoundError, ValidationError } from './db/errors.js';
import { runMigrations } from './db/migrate.js';
import { createRepositories, type Repositories } from './db/repositories/index.js';
import { openDatabase, type SqlDb } from './db/sqlite.js';
import { createHealthRouter } from './health.js';
import { registerAutoRoutes, type LoadedRoute } from './routes/_loader.js';

export interface AppHandle {
  app: Hono;
  db: SqlDb;
  repos: Repositories;
  config: BackendConfig;
  routes: LoadedRoute[];
}

export interface CreateAppOptions {
  db: SqlDb;
  config?: BackendConfig;
  /** 缺省为 backend/src/routes；测试可指向临时目录。 */
  routesDir?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const defaultRoutesDir = join(here, 'routes');

/**
 * 组装 Hono 应用：显式挂载 /health，然后按约定自动挂载
 * backend/src/routes/ 下全部路由文件。业务错误在此统一映射：
 * NotFoundError -> 404，ValidationError -> 400，其余 -> 500。
 */
export async function createApp(options: CreateAppOptions): Promise<AppHandle> {
  const config = options.config ?? loadConfig();
  const db = options.db;
  const repos = createRepositories(db);

  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof NotFoundError) {
      return c.json({ error: 'not_found', message: error.message }, 404);
    }
    if (error instanceof ValidationError) {
      return c.json({ error: 'validation_error', message: error.message }, 400);
    }
    console.error('[server] unhandled error:', error);
    return c.json({ error: 'internal_error', message: 'internal server error' }, 500);
  });

  app.route('/health', createHealthRouter({ db, version: config.version }));

  const routes = await registerAutoRoutes(app, options.routesDir ?? defaultRoutesDir);

  app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404));

  return { app, db, repos, config, routes };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const applied = runMigrations(db);
  if (applied.length > 0) {
    console.log(`[migrate] applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }
  const { app, routes } = await createApp({ db, config });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`[server] dsh-workmesh backend listening on http://${config.host}:${info.port}`);
    console.log(`[server] db=${config.dbPath}, mounted routes: ${routes.map((r) => r.mountPath).join(' ')}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[server] received ${signal}, shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // 兜底：有未关闭连接时不无限等待
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}
