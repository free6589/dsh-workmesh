/**
 * 执行平面路由（挂载前缀 /exec）。
 *
 * 路由一览：
 *   POST /exec/dispatch           派发（新建 run 或复用 queued run），缺省同步等待终态
 *   GET  /exec/runs               运行列表（task_id/project_id/agent_id/status 过滤）
 *   GET  /exec/runs/:id           完整 run 记录（任务、模型/网关、状态、结果、耗时、事件流）
 *   GET  /exec/runs/:id/events    事件流（after_seq/limit）
 *   POST /exec/runs/:id/cancel    取消
 *   GET  /exec/queue              队列快照（queued/running/active/orphaned）
 *   POST /exec/queue/process      无人值守一轮：孤儿收场 + 重试队列派发
 *   GET  /exec/audit              执行相关审计（按 entity/action/actor 过滤）
 *
 * 挂载方式：本模块属于 backend/src/exec/（任务写入范围不含 backend/src/routes/），
 * 入口集成一行即可：`app.route('/exec', createExecRouter({ service }))`，
 * service 用共享 DB 构造（参考 routes/resources.ts 的惰性共享模式）。
 * 错误信封沿用 createApp 的统一映射：NotFoundError → 404，ValidationError → 400。
 */
import { Hono, type Context } from 'hono';
import { ValidationError } from '../db/errors.js';
import type { ExecService } from './service.js';
import type { DispatchInput } from './types.js';

export const basePath = '/exec';

export interface ExecRouterDeps {
  service: ExecService;
}

async function readJsonObject(c: Context, required: boolean): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    if (!required) return {};
    throw new ValidationError('request body must be valid JSON');
  }
  if (body === null || body === undefined) {
    if (!required) return {};
    throw new ValidationError('request body must be a JSON object');
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`field '${key}' must be a string`);
  return value;
}

function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ValidationError(`field '${key}' must be an array of strings`);
  }
  return value as string[];
}

function optionalPositiveInt(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`field '${key}' must be a positive integer`);
  }
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ValidationError(`field '${key}' must be a boolean`);
  return value;
}

function optionalNullableString(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(`field '${key}' must be a string or null`);
  return value;
}

function parseDispatchInput(body: Record<string, unknown>): DispatchInput {
  return {
    task_id: optionalString(body, 'task_id'),
    run_id: optionalString(body, 'run_id'),
    project_id: optionalString(body, 'project_id'),
    agent_id: optionalString(body, 'agent_id'),
    model: optionalNullableString(body, 'model'),
    gateway: optionalNullableString(body, 'gateway'),
    executor: optionalString(body, 'executor'),
    timeout_ms: optionalPositiveInt(body, 'timeout_ms'),
    objective: optionalString(body, 'objective'),
    expected_output: optionalString(body, 'expected_output'),
    acceptance_criteria: optionalStringArray(body, 'acceptance_criteria'),
    constraints: optionalStringArray(body, 'constraints'),
    writes_paths: optionalStringArray(body, 'writes_paths'),
    context: optionalString(body, 'context'),
    await_completion: optionalBoolean(body, 'await_completion'),
  };
}

function queryInt(c: Context, key: string): number | undefined {
  const raw = c.req.query(key);
  if (raw === undefined || raw === '') return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`query param '${key}' must be a positive integer`);
  }
  return value;
}

function optionalQueryInt(c: Context, key: string): number | undefined {
  const raw = c.req.query(key);
  if (raw === undefined || raw === '') return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`query param '${key}' must be a non-negative integer`);
  }
  return value;
}

export function createExecRouter(deps: ExecRouterDeps): Hono {
  const router = new Hono();
  const service = deps.service;

  router.post('/dispatch', async (c) => {
    const body = await readJsonObject(c, true);
    const result = await service.dispatch(parseDispatchInput(body));
    return c.json({ run: result }, 201);
  });

  router.get('/runs', (c) => {
    const { runs, count } = service.listRuns({
      task_id: c.req.query('task_id') || undefined,
      project_id: c.req.query('project_id') || undefined,
      agent_id: c.req.query('agent_id') || undefined,
      status: c.req.query('status') || undefined,
      limit: queryInt(c, 'limit'),
      offset: optionalQueryInt(c, 'offset'),
    });
    return c.json({ runs, count });
  });

  router.get('/runs/:id', (c) => {
    const includeEvents = c.req.query('include_events');
    const view = service.getRunView(c.req.param('id'), {
      includeEvents: includeEvents === 'false' ? false : undefined,
      eventLimit: queryInt(c, 'event_limit'),
    });
    return c.json({ run: view });
  });

  router.get('/runs/:id/events', (c) => {
    return c.json(
      service.listRunEvents(c.req.param('id'), {
        after_seq: optionalQueryInt(c, 'after_seq'),
        limit: queryInt(c, 'limit'),
      }),
    );
  });

  router.post('/runs/:id/cancel', async (c) => {
    const body = await readJsonObject(c, false);
    const reason = optionalString(body, 'reason');
    return c.json(await service.cancel(c.req.param('id'), reason));
  });

  router.get('/queue', (c) => c.json(service.queueSnapshot()));

  router.post('/queue/process', async (c) => {
    const body = await readJsonObject(c, false);
    const limit = optionalPositiveInt(body, 'limit');
    return c.json({ result: await service.processQueue({ limit }) });
  });

  router.get('/audit', (c) => {
    return c.json(
      service.listAudit({
        actor: c.req.query('actor') || undefined,
        action: c.req.query('action') || undefined,
        entity_type: c.req.query('entity_type') || undefined,
        entity_id: c.req.query('entity_id') || undefined,
        limit: queryInt(c, 'limit'),
      }),
    );
  });

  return router;
}
