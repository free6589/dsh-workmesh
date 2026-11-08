import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { createApp } from '../src/server.js';

const openApps: { close: () => void }[] = [];

afterEach(() => {
  for (const handle of openApps.splice(0)) {
    handle.close();
  }
});

async function makeApp() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const handle = await createApp({ db });
  openApps.push({ close: () => db.close() });
  return handle;
}

describe('server app', () => {
  it('GET /health returns 200 with ok status and database check', async () => {
    const { app } = await makeApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      service: string;
      checks: { database: string };
      uptime_seconds: number;
    };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('dsh-workmesh-backend');
    expect(body.checks.database).toBe('ok');
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it('returns 404 JSON for unknown paths', async () => {
    const { app } = await makeApp();
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('not_found');
  });

  it('mounts the example route automatically', async () => {
    const { app, routes } = await makeApp();
    expect(routes.map((r) => r.mountPath)).toContain('/ping');
    const res = await app.request('/ping');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pong: boolean }).pong).toBe(true);
  });
});
