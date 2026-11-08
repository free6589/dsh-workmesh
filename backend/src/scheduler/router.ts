/**
 * 调度器 API 路由工厂（决策查询 / 手动决策 / 无人值守 tick / 阻塞清单 / 派发顺序预览）。
 *
 * 挂载方式：路由文件属于 routes 模块（本模块不越界写入）。装配方只需一行：
 *   app.route('/scheduler', createSchedulerRouter({ repos }));
 * 其中 repos 来自 createApp 组装的数据层（亦可直接传入已构建的 engine）。
 * 业务错误（NotFoundError → 404 / ValidationError → 400）由应用级 onError 统一映射。
 */
import { Hono } from 'hono';
import { ValidationError } from '../db/errors.js';
import type { Repositories } from '../db/repositories/index.js';
import { SchedulerEngine, type SchedulerEngineOptions } from './engine.js';
import type { SchedulerPorts } from './ports.js';

export interface SchedulerRouterDeps {
  /** 已构建的引擎（优先）。 */
  engine?: SchedulerEngine;
  /** 未传 engine 时用 repos 现场构建。 */
  repos?: Repositories;
  ports?: SchedulerPorts;
  maxAttempts?: number;
}

export function createSchedulerRouter(deps: SchedulerRouterDeps): Hono {
  if (deps.engine === undefined && deps.repos === undefined) {
    throw new ValidationError('createSchedulerRouter 需要 engine 或 repos 之一');
  }
  const options: SchedulerEngineOptions = {
    repos: deps.repos as Repositories,
    ...(deps.ports !== undefined ? { ports: deps.ports } : {}),
    ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
  };
  const engine = deps.engine ?? new SchedulerEngine(options);
  const router = new Hono();

  async function readJsonBody(c: { req: { text(): Promise<string> } }): Promise<Record<string, unknown>> {
    const text = await c.req.text();
    if (text.trim() === '') return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new ValidationError(`request body must be valid JSON: ${String(error)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError('request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  }

  function parseLimit(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw === '') return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value <= 0) {
      throw new ValidationError(`limit 必须是正整数，收到 '${raw}'`);
    }
    return Math.min(value, 500);
  }

  router.get('/decisions', (c) => {
    const query = c.req.query();
    const decisions = engine.listDecisions({
      ...(query['task_id'] !== undefined ? { taskId: query['task_id'] } : {}),
      ...(query['project_id'] !== undefined ? { projectId: query['project_id'] } : {}),
      ...(query['gateway_id'] !== undefined ? { gatewayId: query['gateway_id'] } : {}),
      limit: parseLimit(query['limit'], 50),
    });
    return c.json({ decisions });
  });

  router.get('/decisions/:decisionId', (c) => {
    const decision = engine.getDecisionById(c.req.param('decisionId'));
    return c.json({ decision });
  });

  router.post('/decide', async (c) => {
    const body = await readJsonBody(c);
    const taskId = body['task_id'];
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new ValidationError("body 字段 'task_id' 是必填字符串");
    }
    const decision = engine.decide(taskId);
    return c.json({ decision });
  });

  router.post('/tick', async (c) => {
    const body = await readJsonBody(c);
    const rawLimit = body['limit'];
    let limit: number | undefined;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit <= 0) {
        throw new ValidationError("body 字段 'limit' 必须是正整数");
      }
      limit = rawLimit;
    }
    const summary = engine.tick(limit !== undefined ? { limit } : {});
    return c.json({ summary });
  });

  router.get('/blocked', (c) => {
    return c.json({ blocked: engine.listBlocked() });
  });

  router.get('/dispatch-order', (c) => {
    const order = engine.dispatchOrderPreview(parseLimit(c.req.query()['limit'], 20));
    return c.json({ order });
  });

  return router;
}
