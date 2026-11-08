import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { createApp } from '../src/server.js';
import { isRouteFile, loadRoutes, mountRoutes } from '../src/routes/_loader.js';
import { Hono } from 'hono';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realRoutesDir = path.join(repoRoot, 'src', 'routes');

// 每个测试用例的临时路由目录放在 backend/ 内，保证动态 import 能解析到 hono
const tempDirs: string[] = [];

function makeTempRoutesDir(): string {
  const dir = mkdtempSync(path.join(repoRoot, '.tmp-routes-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function validRouteFile(body: string): string {
  return `import { Hono } from 'hono';\nconst router = new Hono();\n${body}\nexport default router;\n`;
}

describe('route auto-loading convention', () => {
  it('loads a file added to a routes directory without touching any entry point', async () => {
    const dir = makeTempRoutesDir();
    writeFileSync(path.join(dir, 'alpha.ts'), validRouteFile(`router.get('/hello', (c) => c.json({ who: 'alpha' }));`));

    const db = openDatabase(':memory:');
    runMigrations(db);
    const before = await createApp({ db, routesDir: dir });
    expect(before.routes.map((r) => r.mountPath)).toEqual(['/alpha']);
    expect(((await (await before.app.request('/alpha/hello')).json()) as { who: string }).who).toBe('alpha');
    db.close();

    // 关键场景：新任务只需“新增一个路由文件”，入口与既有文件零改动
    writeFileSync(path.join(dir, 'beta.ts'), validRouteFile(`router.get('/ok', (c) => c.json({ ok: true }));`));

    const db2 = openDatabase(':memory:');
    runMigrations(db2);
    const after = await createApp({ db: db2, routesDir: dir });
    expect(after.routes.map((r) => r.mountPath).sort()).toEqual(['/alpha', '/beta']);
    const res = await after.app.request('/beta/ok');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    db2.close();
  });

  it('mounts a route file dropped into the real backend/src/routes/ directory', async () => {
    const probeName = `zzz-autoload-probe-${Date.now()}-${process.pid}`;
    const probeFile = path.join(realRoutesDir, `${probeName}.ts`);
    writeFileSync(
      probeFile,
      validRouteFile(`router.get('/probe', (c) => c.json({ probe: '${probeName}' }));`),
    );
    try {
      const db = openDatabase(':memory:');
      runMigrations(db);
      const { app, routes } = await createApp({ db });
      expect(routes.map((r) => r.mountPath)).toContain(`/${probeName}`);
      const res = await app.request(`/${probeName}/probe`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { probe: string }).probe).toBe(probeName);
      db.close();
    } finally {
      rmSync(probeFile, { force: true });
    }
  });

  it('skips index, underscore-prefixed, test and non-route files', () => {
    expect(isRouteFile('projects.ts')).toBe(true);
    expect(isRouteFile('index.ts')).toBe(false);
    expect(isRouteFile('_internal.ts')).toBe(false);
    expect(isRouteFile('.hidden.ts')).toBe(false);
    expect(isRouteFile('projects.test.ts')).toBe(false);
    expect(isRouteFile('types.d.ts')).toBe(false);
    expect(isRouteFile('README.md')).toBe(false);
    expect(isRouteFile('note.txt')).toBe(false);
  });

  it('supports named `router` export, basePath override, and rejects invalid modules', async () => {
    const dir = makeTempRoutesDir();
    writeFileSync(
      path.join(dir, 'named.ts'),
      [
        `import { Hono } from 'hono';`,
        `export const router = new Hono();`,
        `router.get('/n', (c) => c.json({ via: 'named' }));`,
      ].join('\n'),
    );
    writeFileSync(
      path.join(dir, 'custom.ts'),
      [
        `import { Hono } from 'hono';`,
        `export const basePath = '/aliased';`,
        `export const router = new Hono();`,
        `router.get('/c', (c) => c.json({ via: 'basePath' }));`,
      ].join('\n'),
    );
    const loaded = await loadRoutes(dir);
    expect(loaded.map((r) => r.mountPath).sort()).toEqual(['/aliased', '/named']);
    const app = new Hono();
    mountRoutes(app, loaded);
    expect(((await (await app.request('/named/n')).json()) as { via: string }).via).toBe('named');
    expect(((await (await app.request('/aliased/c')).json()) as { via: string }).via).toBe('basePath');

    // 缺少 router 导出的文件必须显式报错，而不是被静默忽略
    const bad = makeTempRoutesDir();
    writeFileSync(path.join(bad, 'broken.ts'), `export const notARouter = true;`);
    await expect(loadRoutes(bad)).rejects.toThrow(/must default-export/);
  });

  it('rejects duplicate mount paths deterministically', async () => {
    const dir = makeTempRoutesDir();
    writeFileSync(path.join(dir, 'a.ts'), validRouteFile(`router.get('/x', (c) => c.text('x'));`));
    writeFileSync(
      path.join(dir, 'b.ts'),
      [`import { Hono } from 'hono';`, `export const basePath = '/a';`, `export const router = new Hono();`].join('\n'),
    );
    await expect(loadRoutes(dir)).rejects.toThrow(/duplicate route mount path/);
  });
});
