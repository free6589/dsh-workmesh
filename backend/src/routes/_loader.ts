import { readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';

/**
 * 路由自动加载约定
 * =================
 * backend/src/routes/ 下每个顶层文件必须 default export（或命名导出 `router`）
 * 一个 Hono router；入口在启动时扫描该目录并自动挂载，无需修改任何注册代码。
 *
 * - 挂载前缀 = 文件名（不含扩展名），即 routes/projects.ts 里的 router.get('/list')
 *   对外暴露为 GET /projects/list；
 * - 文件可命名导出 `basePath`（以 '/' 开头的字符串）覆盖挂载前缀；
 * - 以下文件会被跳过：`index.*`、以 `_` 或 `.` 开头、`*.d.ts`、`*.test.ts`、
 *   `*.spec.ts`、非 .ts/.mts/.js/.mjs 文件、子目录；
 * - 新增或删除路由文件后重启服务即可生效。
 */

export interface LoadedRoute {
  /** 绝对路径。 */
  file: string;
  /** 文件名（不含扩展名），缺省挂载前缀的来源。 */
  name: string;
  /** 实际挂载前缀，以 '/' 开头。 */
  mountPath: string;
  router: Hono;
}

const ROUTE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);
const SKIP_SUFFIXES = ['.d.ts', '.test.ts', '.test.mts', '.spec.ts', '.spec.mts'];

export function isRouteFile(fileName: string): boolean {
  const ext = extname(fileName);
  if (!ROUTE_EXTENSIONS.has(ext)) return false;
  if (SKIP_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) return false;
  const base = basename(fileName, ext);
  if (base === 'index' || base.startsWith('_') || base.startsWith('.')) return false;
  return true;
}

export async function loadRoutes(dir: string): Promise<LoadedRoute[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && isRouteFile(entry.name))
    .map((entry) => entry.name)
    .sort();

  const loaded: LoadedRoute[] = [];
  for (const fileName of fileNames) {
    const file = join(dir, fileName);
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const router = (mod['default'] ?? mod['router']) as Hono | undefined;
    if (!router || typeof (router as { fetch?: unknown }).fetch !== 'function') {
      throw new Error(`route file '${fileName}' must default-export (or export 'router') a Hono router`);
    }
    const name = basename(fileName, extname(fileName));
    const exportedBase = mod['basePath'];
    const mountPath =
      typeof exportedBase === 'string' && exportedBase.startsWith('/')
        ? exportedBase
        : `/${name}`;
    loaded.push({ file, name, mountPath, router });
  }

  const seen = new Map<string, string>();
  for (const route of loaded) {
    const previous = seen.get(route.mountPath);
    if (previous) {
      throw new Error(`duplicate route mount path '${route.mountPath}' (${previous} vs ${route.file})`);
    }
    seen.set(route.mountPath, route.file);
  }
  return loaded;
}

export function mountRoutes(app: Hono, routes: LoadedRoute[]): void {
  for (const route of routes) {
    app.route(route.mountPath, route.router);
  }
}

/** 扫描 dir 并把全部路由挂载到 app，返回加载清单（用于日志与测试）。 */
export async function registerAutoRoutes(app: Hono, dir: string): Promise<LoadedRoute[]> {
  const routes = await loadRoutes(dir);
  mountRoutes(app, routes);
  return routes;
}
