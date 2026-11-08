import { Hono } from 'hono';
import type { SqlDb } from './db/sqlite.js';

export interface HealthDeps {
  db: SqlDb;
  version?: string;
  startedAt?: number;
}

/** GET /health：数据库可 ping 则 200（status=ok），否则 503（status=degraded）。 */
export function createHealthRouter(deps: HealthDeps) {
  const startedAt = deps.startedAt ?? Date.now();
  const router = new Hono();

  router.get('/', (c) => {
    let database: 'ok' | 'error' = 'ok';
    try {
      deps.db.prepare('SELECT 1').get();
    } catch {
      database = 'error';
    }
    const healthy = database === 'ok';
    return c.json(
      {
        status: healthy ? 'ok' : 'degraded',
        service: 'dsh-workmesh-backend',
        version: deps.version ?? '0.0.0',
        uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString(),
        checks: { database },
      },
      healthy ? 200 : 503,
    );
  });

  return router;
}
