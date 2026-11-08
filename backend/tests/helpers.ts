/**
 * 测试公共件：可编程 mock fetch、内存库 + 服务、带统一错误映射的 Hono 测试应用。
 * 全部凭据均为虚构占位值，仅经 secretResolver 注入。
 */

import { createResourcesRouter } from '../src/routes/resources.js';
import { NotFoundError, ValidationError } from '../src/db/errors.js';
import { createRepositories } from '../src/db/repositories/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { openDatabase, type SqlDb } from '../src/db/sqlite.js';
import type { FetchImpl } from '../src/adapters/http.js';
import { ResourcesService } from '../src/services/resources.js';
import { Hono } from 'hono';

export interface MockReply {
  status?: number;
  body?: unknown;
  text?: string;
}

export interface MockRoute {
  method: 'GET' | 'POST';
  match: (url: string) => boolean;
  reply: (ctx: { url: string; headers: Headers; bodyText: string }) => MockReply;
}

export interface MockCall {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string;
}

export interface MockFetch {
  fetchImpl: FetchImpl;
  calls: MockCall[];
}

/** 网络层不可达的 fetch：直接 reject（模拟连接拒绝 / DNS 失败 / 断网）。 */
export function createRejectingFetch(): FetchImpl {
  return async () => {
    throw new TypeError('fetch failed: connection refused');
  };
}

export function createMockFetch(routes: MockRoute[]): MockFetch {
  const calls: MockCall[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const headers = new Headers(init?.headers);
    const call: MockCall = {
      url: String(url),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      bodyText: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(call);
    for (const route of routes) {
      if (route.method === call.method && route.match(call.url)) {
        const reply = route.reply({ url: call.url, headers: call.headers, bodyText: call.bodyText });
        const text = reply.text ?? JSON.stringify(reply.body ?? null);
        return new Response(text, {
          status: reply.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: 'no mock route matched' }), { status: 599 });
  };
  return { fetchImpl, calls };
}

export interface TestServiceHandle {
  service: ResourcesService;
  mock: MockFetch;
  db: SqlDb;
  secrets: Record<string, string>;
}

export function createTestService(routes: MockRoute[], secrets: Record<string, string> = {}): TestServiceHandle {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const repos = createRepositories(db);
  const mock = createMockFetch(routes);
  const service = new ResourcesService({
    db,
    repos,
    fetchImpl: mock.fetchImpl,
    secretResolver: (name) => secrets[name],
  });
  return { service, mock, db, secrets };
}

/** 与 server.ts createApp 相同的错误映射，供路由级测试独立复现。 */
export function appWithResources(service: ResourcesService): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof NotFoundError) {
      return c.json({ error: 'not_found', message: error.message }, 404);
    }
    if (error instanceof ValidationError) {
      return c.json({ error: 'validation_error', message: error.message }, 400);
    }
    return c.json({ error: 'internal_error', message: 'internal server error' }, 500);
  });
  app.route('/resources', createResourcesRouter({ service }));
  return app;
}
