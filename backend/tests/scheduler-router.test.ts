import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { createRepositories, type Repositories } from '../src/db/repositories/index.js';
import type { SqlDb } from '../src/db/sqlite.js';
import { createApp, type AppHandle } from '../src/server.js';
import { createSchedulerRouter, SCHEDULER_SETTINGS_KEYS } from '../src/scheduler/index.js';

let db: SqlDb;
let repos: Repositories;
let handle: AppHandle;

beforeEach(async () => {
  db = openDatabase(':memory:');
  runMigrations(db);
  repos = createRepositories(db);
  handle = await createApp({ db });
  // 装配方式与 routes 模块将来的接线一致：一行 app.route 挂载
  handle.app.route('/scheduler', createSchedulerRouter({ repos }));
});

function seedWorld(): { taskId: string; projectId: string } {
  const project = repos.projects.create({ name: 'proj-one' });
  const module = repos.modules.create({ project_id: project.id, name: 'mod' });
  const phase = repos.phases.create({ module_id: module.id, name: 'phase' });
  const task = repos.tasks.create({
    project_id: project.id,
    module_id: module.id,
    phase_id: phase.id,
    title: '接入调度 API',
    priority: 3,
  });
  repos.gateways.create({ id: 'gw-a', name: 'bifrost-main', type: 'bifrost' });
  repos.gateways.create({ id: 'gw-b', name: 'ind-free', type: 'independent' });
  repos.settings.set(
    SCHEDULER_SETTINGS_KEYS.modelCatalog,
    JSON.stringify([
      { gatewayId: 'gw-a', modelId: 'model-pro', capabilities: ['tools'], contextWindow: 128000 },
      { gatewayId: 'gw-b', modelId: 'model-free', capabilities: ['tools'], contextWindow: 32000 },
    ]),
  );
  repos.settings.set(
    SCHEDULER_SETTINGS_KEYS.taskRequirements,
    JSON.stringify({ [task.id]: { requiredCapabilities: ['tools'], preferredModel: 'model-pro' } }),
  );
  return { taskId: task.id, projectId: project.id };
}

describe('scheduler API（决策查询与调度触发）', () => {
  it('POST /decide 返回决策并派发；GET /decisions 可按任务查询', async () => {
    const { taskId } = seedWorld();
    const postRes = await handle.app.request('/scheduler/decide', {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId }),
      headers: { 'content-type': 'application/json' },
    });
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as {
      decision: { decisionId: string; runId?: string; selected: { gatewayId: string } | null };
    };
    expect(postBody.decision.selected?.gatewayId).toBe('gw-a');
    expect(postBody.decision.runId).toBeTruthy();

    const listRes = await handle.app.request(`/scheduler/decisions?task_id=${taskId}`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { decisions: { decision: { decisionId: string } }[] };
    expect(listBody.decisions).toHaveLength(1);
    expect(listBody.decisions[0]?.decision.decisionId).toBe(postBody.decision.decisionId);

    const oneRes = await handle.app.request(`/scheduler/decisions/${postBody.decision.decisionId}`);
    expect(oneRes.status).toBe(200);
    const oneBody = (await oneRes.json()) as { decision: { taskId: string; rationale: string[] } };
    expect(oneBody.decision.taskId).toBe(taskId);
    expect(oneBody.decision.rationale.length).toBeGreaterThan(0);
  });

  it('GET /decisions/:id 对未知决策返回 404 错误信封', async () => {
    seedWorld();
    const res = await handle.app.request('/scheduler/decisions/dec-zzz');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('not_found');
    expect(body.message).toContain('dec-zzz');
  });

  it('请求校验：缺 task_id / 非法 JSON / 未知任务分别返回 400 或 404', async () => {
    seedWorld();
    const noTask = await handle.app.request('/scheduler/decide', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(noTask.status).toBe(400);
    expect(((await noTask.json()) as { error: string }).error).toBe('validation_error');

    const badJson = await handle.app.request('/scheduler/decide', {
      method: 'POST',
      body: 'not-json',
      headers: { 'content-type': 'application/json' },
    });
    expect(badJson.status).toBe(400);

    const missing = await handle.app.request('/scheduler/decide', {
      method: 'POST',
      body: JSON.stringify({ task_id: 'task-zzz' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(missing.status).toBe(404);

    const badLimit = await handle.app.request('/scheduler/decisions?limit=zero');
    expect(badLimit.status).toBe(400);
  });

  it('GET /blocked 返回阻塞任务与下一步安排；POST /tick 返回调度摘要', async () => {
    const { taskId } = seedWorld();
    // 让任务无资源可用：要求 image 能力
    repos.settings.set(
      SCHEDULER_SETTINGS_KEYS.taskRequirements,
      JSON.stringify({ [taskId]: { requiredCapabilities: ['image'] } }),
    );
    const decideRes = await handle.app.request('/scheduler/decide', {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId }),
      headers: { 'content-type': 'application/json' },
    });
    const { decision } = (await decideRes.json()) as { decision: { blocked: boolean } };
    expect(decision.blocked).toBe(true);

    const blockedRes = await handle.app.request('/scheduler/blocked');
    expect(blockedRes.status).toBe(200);
    const blockedBody = (await blockedRes.json()) as {
      blocked: { taskId: string; causes: { code: string }[]; plan: { action: string }[] }[];
    };
    expect(blockedBody.blocked).toHaveLength(1);
    expect(blockedBody.blocked[0]?.taskId).toBe(taskId);
    expect(blockedBody.blocked[0]?.causes[0]?.code).toBe('resource_unavailable');
    expect(blockedBody.blocked[0]?.plan[0]?.action).toBe('requeue_with_backoff');

    const tickRes = await handle.app.request('/scheduler/tick', {
      method: 'POST',
      body: JSON.stringify({ limit: 5 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(tickRes.status).toBe(200);
    const tickBody = (await tickRes.json()) as { summary: { mode: string; scanned: number } };
    expect(tickBody.summary.mode).toBe('attended');
    expect(tickBody.summary.scanned).toBe(1);
  });

  it('GET /dispatch-order 返回派发顺序预览且不落库', async () => {
    const { taskId } = seedWorld();
    const res = await handle.app.request('/scheduler/dispatch-order');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: { taskId: string; effectivePriority: number }[] };
    expect(body.order.map((e) => e.taskId)).toEqual([taskId]);
    expect(repos.auditLog.list().length).toBe(0);
    expect(repos.runs.count()).toBe(0);
  });

  it('未传 engine 与 repos 时路由工厂报错', () => {
    expect(() => createSchedulerRouter({})).toThrow(/engine 或 repos/);
  });
});
