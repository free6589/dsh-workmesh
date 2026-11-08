/**
 * exec 模块 HTTP API 集成测试（MockExecutor + Hono 路由级）。
 * 覆盖验收标准 1/2/3 的接口面：dispatch 三种结局、完整 run 记录查询、
 * 事件流查询、无人值守队列处理、取消与审计查询。
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { NotFoundError, ValidationError } from '../src/db/errors.js';
import { createExecRouter } from '../src/exec/router.js';
import type { ExecRunView } from '../src/exec/types.js';
import { setupExecService, waitFor, type ExecTestHandle } from './exec.helpers.js';

function buildApp(handle: ExecTestHandle): Hono {
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
  app.route('/exec', createExecRouter({ service: handle.service }));
  return app;
}

async function post(app: Hono, path: string, body?: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function getJson<T>(app: Hono, path: string): Promise<T> {
  const response = await app.request(path);
  return (await response.json()) as T;
}

const COMPLETED_REPORT = {
  summary: '接口测试通过',
  status: 'completed' as const,
  deliverables: [{ description: 'API', locator: 'backend/src/exec/router.ts' }],
  evidence: [{ claim: '201 响应', source: 'app.request' }],
  testsRun: [{ command: 'vitest run', status: 'passed' as const, detail: 'ok' }],
  filesChanged: ['backend/src/exec/router.ts'],
  uncertainties: [],
};

describe('POST /exec/dispatch：三种结局（验收标准 1）', () => {
  it('成功：201 + run.succeeded，完整 run 记录可查询（验收标准 2）', async () => {
    const h = setupExecService();
    h.mock.enqueue({ kind: 'success', report: COMPLETED_REPORT });
    const app = buildApp(h);

    const response = await post(app, '/exec/dispatch', {
      task_id: h.seed.task.id,
      model: 'model-x',
      gateway: 'gw-1',
      agent_id: undefined,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { run: { run_id: string; status: string; attempt: number; timed_out: boolean; duration_ms: number | null } };
    expect(body.run.status).toBe('succeeded');
    expect(body.run.attempt).toBe(1);
    expect(body.run.timed_out).toBe(false);
    expect(body.run.duration_ms).not.toBeNull();

    // 完整 run 记录：任务、模型、网关、状态、结果、耗时、事件流
    const viewResponse = await app.request(`/exec/runs/${body.run.run_id}`);
    expect(viewResponse.status).toBe(200);
    const { run } = (await viewResponse.json()) as { run: ExecRunView };
    expect(run.run.status).toBe('succeeded');
    expect(run.run.duration_ms).toBeGreaterThanOrEqual(0);
    expect(run.task?.id).toBe(h.seed.task.id);
    expect(run.agent).toBeNull();
    expect(run.dispatch).toMatchObject({ executor: 'mock', model: 'model-x', gateway: 'gw-1', attempt: 1, timeout_ms: 300000 });
    expect(run.result.report?.summary).toBe('接口测试通过');
    expect(run.result.report?.evidence).toHaveLength(1);
    const types = run.events.map((event) => event.type);
    expect(types[0]).toBe('dispatch');
    expect(types).toContain('run_summary');
  });

  it('失败：201 + run.failed，进入重试队列，无人值守处理后成功（验收标准 3）', async () => {
    const h = setupExecService({ maxAttempts: 2 });
    h.mock.enqueue({ kind: 'failure', error: 'boom' });
    h.mock.enqueue({ kind: 'success' });
    const app = buildApp(h);

    const first = (await (await post(app, '/exec/dispatch', { task_id: h.seed.task.id })).json()) as {
      run: { run_id: string; status: string; error: string | null };
    };
    expect(first.run.status).toBe('failed');
    expect(first.run.error).toContain('boom');

    const queue = (await getJson(app, '/exec/queue')) as { queued: number };
    expect(queue.queued).toBe(1);

    const processResponse = await post(app, '/exec/queue/process');
    expect(processResponse.status).toBe(200);
    const pass = (await processResponse.json()) as {
      result: { runs: Array<{ run_id: string; status: string; attempt: number }>; orphans: unknown[]; skipped: unknown[] };
    };
    expect(pass.result.skipped).toEqual([]);
    expect(pass.result.orphans).toEqual([]);
    expect(pass.result.runs).toHaveLength(1);
    expect(pass.result.runs[0]?.status).toBe('succeeded');
    expect(pass.result.runs[0]?.attempt).toBe(2);

    const afterQueue = (await getJson(app, '/exec/queue')) as { queued: number; running: number };
    expect(afterQueue).toMatchObject({ queued: 0, running: 0 });
  });

  it('超时：201 + run.failed + timed_out=true，重试队列可继续', async () => {
    const h = setupExecService({ timeoutMs: 80, maxAttempts: 2 });
    h.mock.enqueue({ kind: 'hang' });
    h.mock.enqueue({ kind: 'success' });
    const app = buildApp(h);

    const first = (await (await post(app, '/exec/dispatch', { task_id: h.seed.task.id, timeout_ms: 80 })).json()) as {
      run: { run_id: string; status: string; timed_out: boolean; error: string | null; duration_ms: number | null };
    };
    expect(first.run.status).toBe('failed');
    expect(first.run.timed_out).toBe(true);
    expect(first.run.error).toContain('timed out after 80ms');

    const view = (await getJson(app, `/exec/runs/${first.run.run_id}`)) as { run: ExecRunView };
    expect(view.run.result.timed_out).toBe(true);

    const pass = (await (await post(app, '/exec/queue/process')).json()) as {
      result: { runs: Array<{ status: string }> };
    };
    expect(pass.result.runs[0]?.status).toBe('succeeded');
  });
});

describe('GET /exec/runs*：列表、过滤与事件流', () => {
  it('按任务/状态过滤列表并返回 count', async () => {
    const h = setupExecService();
    h.mock.enqueue({ kind: 'success' });
    const app = buildApp(h);
    const dispatchBody = (await (await post(app, '/exec/dispatch', { task_id: h.seed.task.id })).json()) as {
      run: { run_id: string };
    };

    const all = (await getJson(app, `/exec/runs?task_id=${h.seed.task.id}`)) as {
      runs: Array<{ id: string; status: string }>;
      count: number;
    };
    expect(all.count).toBe(1);
    expect(all.runs[0]?.id).toBe(dispatchBody.run.run_id);

    const succeeded = (await getJson(app, `/exec/runs?status=succeeded`)) as { count: number };
    expect(succeeded.count).toBe(1);
    const failed = (await getJson(app, `/exec/runs?status=failed`)) as { count: number };
    expect(failed.count).toBe(0);
  });

  it('事件流支持 after_seq 增量读取；include_events=false 省略事件', async () => {
    const h = setupExecService();
    h.mock.enqueue({ kind: 'success', report: COMPLETED_REPORT });
    const app = buildApp(h);
    const { run } = (await (await post(app, '/exec/dispatch', { task_id: h.seed.task.id })).json()) as {
      run: { run_id: string };
    };

    const all = (await getJson(app, `/exec/runs/${run.run_id}/events`)) as {
      run_id: string;
      events: Array<{ seq: number; type: string }>;
    };
    expect(all.run_id).toBe(run.run_id);
    expect(all.events.length).toBeGreaterThanOrEqual(2);
    const lastSeq = all.events[all.events.length - 1]?.seq ?? 0;

    const tail = (await getJson(app, `/exec/runs/${run.run_id}/events?after_seq=${lastSeq}`)) as {
      events: unknown[];
    };
    expect(tail.events).toEqual([]);

    const withoutEvents = (await getJson(app, `/exec/runs/${run.run_id}?include_events=false`)) as {
      run: ExecRunView;
    };
    expect(withoutEvents.run.events).toEqual([]);
    expect(withoutEvents.run.result.status).toBe('succeeded');
  });

  it('未知 run 返回 404；非法过滤返回 400', async () => {
    const h = setupExecService();
    const app = buildApp(h);
    expect((await app.request('/exec/runs/nope')).status).toBe(404);
    expect((await app.request('/exec/runs/nope/events')).status).toBe(404);
    expect((await app.request('/exec/runs?status=bogus')).status).toBe(400);
    expect((await app.request('/exec/runs?limit=0')).status).toBe(400);
  });
});

describe('POST /exec/runs/:id/cancel 与审计查询', () => {
  it('可取消 queued run，并经 /exec/audit 查到审计记录', async () => {
    const h = setupExecService();
    const run = h.repos.runs.create({ project_id: h.seed.project.id, task_id: h.seed.task.id, status: 'queued' });
    const app = buildApp(h);

    const cancelResponse = await post(app, `/exec/runs/${run.id}/cancel`, { reason: '手动取消' });
    expect(cancelResponse.status).toBe(200);
    const cancelled = (await cancelResponse.json()) as { run_id: string; status: string };
    expect(cancelled).toEqual({ run_id: run.id, status: 'cancelled' });

    const view = (await getJson(app, `/exec/runs/${run.id}`)) as { run: ExecRunView };
    expect(view.run.run.status).toBe('cancelled');

    // 终态再取消 → 400
    expect((await post(app, `/exec/runs/${run.id}/cancel`)).status).toBe(400);

    const audit = (await getJson(app, `/exec/audit?entity_type=run&entity_id=${run.id}`)) as {
      audit: Array<{ action: string; detail: string }>;
    };
    expect(audit.audit.some((row) => row.action === 'run_finished')).toBe(true);
    expect(JSON.stringify(audit.audit)).toContain('手动取消');
  });

  it('取消活动中的 run → 收尾为 cancelled', async () => {
    const h = setupExecService();
    h.mock.enqueue({ kind: 'hang' });
    const app = buildApp(h);
    const { run } = (await (await post(app, '/exec/dispatch', { task_id: h.seed.task.id, await_completion: false })).json()) as {
      run: { run_id: string };
    };
    await waitFor(() => h.mock.callCount === 1);
    const cancelResponse = await post(app, `/exec/runs/${run.run_id}/cancel`, { reason: 'stop' });
    expect(cancelResponse.status).toBe(200);
    await waitFor(() => h.service.getRunView(run.run_id, { includeEvents: false }).run.status === 'cancelled');
  });
});

describe('输入与错误映射', () => {
  it('缺 task_id/run_id → 400；未知任务 → 404；非法字段类型 → 400', async () => {
    const h = setupExecService();
    const app = buildApp(h);
    const empty = await post(app, '/exec/dispatch', {});
    expect(empty.status).toBe(400);
    const emptyBody = (await empty.json()) as { error: string };
    expect(emptyBody.error).toBe('validation_error');

    const unknownTask = await post(app, '/exec/dispatch', { task_id: 'nope' });
    expect(unknownTask.status).toBe(404);

    const badTimeout = await post(app, '/exec/dispatch', { task_id: h.seed.task.id, timeout_ms: -1 });
    expect(badTimeout.status).toBe(400);

    const badArray = await post(app, '/exec/dispatch', { task_id: h.seed.task.id, acceptance_criteria: 'x' });
    expect(badArray.status).toBe(400);

    const notJson = await app.request('/exec/dispatch', { method: 'POST', body: 'not-json', headers: { 'content-type': 'application/json' } });
    expect(notJson.status).toBe(400);
  });

  it('await_completion=false 立即返回 running，随后可查询终态', async () => {
    const h = setupExecService();
    h.mock.enqueue({ kind: 'success', delayMs: 5 });
    const app = buildApp(h);
    const { run } = (await (await post(app, '/exec/dispatch', { task_id: h.seed.task.id, await_completion: false })).json()) as {
      run: { run_id: string; status: string; duration_ms: number | null };
    };
    expect(run.status).toBe('running');
    expect(run.duration_ms).toBeNull();

    await waitFor(() => h.service.getRunView(run.run_id, { includeEvents: false }).run.status === 'succeeded');
    const view = (await getJson(app, `/exec/runs/${run.run_id}`)) as { run: ExecRunView };
    expect(view.run.run.status).toBe('succeeded');
    expect(view.run.result.report?.status).toBe('completed');
  });

  it('POST /exec/queue/process 允许空请求体', async () => {
    const h = setupExecService();
    const app = buildApp(h);
    const response = await app.request('/exec/queue/process', { method: 'POST' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { runs: unknown[]; orphans: unknown[]; skipped: unknown[] } };
    expect(body.result).toEqual({ runs: [], orphans: [], skipped: [] });
  });
});
