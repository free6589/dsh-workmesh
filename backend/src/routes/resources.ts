/**
 * 资源平面路由（网关配置 + 模型逻辑目录 + 额度/健康监控端点）。
 *
 * 挂载约定：本文件位于 backend/src/routes/，被入口自动加载并挂载到
 * `/resources`（见 routes/_loader.ts；basePath 显式声明同值）。
 *
 * 路由一览：
 *   GET|POST         /resources/gateways
 *   GET|PATCH|DELETE /resources/gateways/:id
 *   GET              /resources/gateways/:id/models     实时模型目录（网关探测）
 *   GET              /resources/gateways/:id/quota      额度/账户用量（网关未提供 → status='not_provided'）
 *   GET              /resources/gateways/:id/health     健康探测
 *   GET|POST         /resources/models
 *   GET|PATCH|DELETE /resources/models/:id
 *   GET|PUT          /resources/models/:id/bindings     逻辑模型 → 网关绑定（整体替换语义）
 *   GET              /resources/models/:id/catalog      模型 + 绑定 + 网关配置拼接（数据视图）
 *   GET              /resources/monitoring/health       全局健康巡检（仅启用网关）
 *   GET              /resources/monitoring/quota        全局额度巡检（仅启用网关）
 *
 * 错误信封沿用 createApp 的统一映射：NotFoundError → 404，ValidationError → 400。
 * 响应中永远只有 api_key_env（环境变量名），不含任何密钥材料。
 */

import { loadConfig } from '../config.js';
import { ValidationError } from '../db/errors.js';
import { runMigrations } from '../db/migrate.js';
import { createRepositories } from '../db/repositories/index.js';
import { openDatabase } from '../db/sqlite.js';
import {
  ResourcesService,
  type BindingInput,
  type CreateGatewayInput,
  type CreateModelInput,
  type UpdateGatewayInput,
  type UpdateModelInput,
} from '../services/resources.js';
import { Hono, type Context } from 'hono';

export const basePath = '/resources';

export interface ResourcesRouterDeps {
  service: ResourcesService;
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('request body must be valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export function createResourcesRouter(deps: ResourcesRouterDeps): Hono {
  const router = new Hono();
  const service = deps.service;

  // ---- 网关配置 CRUD ----

  router.get('/gateways', (c) => c.json({ gateways: service.listGateways() }));

  router.post('/gateways', async (c) => {
    const body = await readJsonObject(c);
    return c.json({ gateway: service.createGateway(body as unknown as CreateGatewayInput) }, 201);
  });

  router.get('/gateways/:id', (c) => c.json({ gateway: service.getGateway(c.req.param('id')) }));

  router.patch('/gateways/:id', async (c) => {
    const body = await readJsonObject(c);
    return c.json({ gateway: service.updateGateway(c.req.param('id'), body as UpdateGatewayInput) });
  });

  router.delete('/gateways/:id', (c) => {
    service.deleteGateway(c.req.param('id'));
    return c.body(null, 204);
  });

  // ---- 网关级探测（结果即数据，失败也以 200 返回结构化状态） ----

  router.get('/gateways/:id/models', async (c) => c.json(await service.gatewayModels(c.req.param('id'))));

  router.get('/gateways/:id/quota', async (c) => c.json(await service.gatewayQuota(c.req.param('id'))));

  router.get('/gateways/:id/health', async (c) => c.json(await service.gatewayHealth(c.req.param('id'))));

  // ---- 模型逻辑目录 CRUD ----

  router.get('/models', (c) => c.json({ models: service.listModels() }));

  router.post('/models', async (c) => {
    const body = await readJsonObject(c);
    return c.json({ model: service.createModel(body as unknown as CreateModelInput) }, 201);
  });

  router.get('/models/:id', (c) => c.json({ model: service.getModel(c.req.param('id')) }));

  router.patch('/models/:id', async (c) => {
    const body = await readJsonObject(c);
    return c.json({ model: service.updateModel(c.req.param('id'), body as UpdateModelInput) });
  });

  router.delete('/models/:id', (c) => {
    service.deleteModel(c.req.param('id'));
    return c.body(null, 204);
  });

  // ---- 逻辑模型 → 网关绑定 ----

  router.get('/models/:id/bindings', (c) => c.json({ bindings: service.listBindings(c.req.param('id')) }));

  router.put('/models/:id/bindings', async (c) => {
    const body = await readJsonObject(c);
    const bindings = service.setBindings(c.req.param('id'), body['bindings'] as BindingInput[]);
    return c.json({ bindings });
  });

  router.get('/models/:id/catalog', (c) => c.json(service.getModelCatalog(c.req.param('id'))));

  // ---- 全局监控 ----

  router.get('/monitoring/health', async (c) => c.json(await service.overviewHealth()));

  router.get('/monitoring/quota', async (c) => c.json(await service.overviewQuota()));

  return router;
}

// ---- 自动挂载用缺省路由：共享服务在首个请求时惰性初始化 ----

let sharedService: ResourcesService | undefined;

export function getSharedResourcesService(): ResourcesService {
  if (!sharedService) {
    const config = loadConfig();
    const db = openDatabase(config.dbPath);
    runMigrations(db);
    sharedService = new ResourcesService({ db, repos: createRepositories(db) });
  }
  return sharedService;
}

export default createResourcesRouter({
  get service() {
    return getSharedResourcesService();
  },
});
