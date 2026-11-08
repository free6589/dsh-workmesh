/**
 * 任务编排 API 测试：模块/阶段/任务/子任务 CRUD 与层级、依赖 DAG
 * （建立/环检测拒绝/无残留）、Kahn 拓扑排序、就绪任务查询。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { createApp } from '../src/server.js';
import { bindServices, getServices } from '../src/services/context.js';

interface ApiResponse {
  status: number;
  body: any;
}

const openDbs: { close: () => void }[] = [];

afterEach(() => {
  for (const handle of openDbs.splice(0)) handle.close();
});

async function makeApp(): Promise<{ app: Hono }> {
  const db = openDatabase(':memory:');
  runMigrations(db);
  openDbs.push({ close: () => db.close() });
  bindServices(db);
  const handle = await createApp({ db });
  return { app: handle.app };
}

async function api(app: Hono, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const res = await app.request(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

async function createProject(app: Hono, name: string) {
  const res = await api(app, 'POST', '/projects', { name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.project as { id: string };
}

async function makeTaskTree(app: Hono, projectId: string, titles: string[]) {
  const module = (await api(app, 'POST', `/tasks/projects/${projectId}/modules`, { name: 'module' })).body.module;
  const phase = (await api(app, 'POST', `/tasks/modules/${module.id}/phases`, { name: 'phase' })).body.phase;
  const tasks: Record<string, string> = {};
  for (const title of titles) {
    const res = await api(app, 'POST', `/tasks/phases/${phase.id}/tasks`, { title });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    tasks[title] = res.body.task.id;
  }
  return { moduleId: module.id as string, phaseId: phase.id as string, tasks };
}

/** 断言响应为 4xx（环依赖等冲突按数据层约定映射为 400）。 */
function expect4xx(status: number): void {
  expect(status).toBeGreaterThanOrEqual(400);
  expect(status).toBeLessThan(500);
}

describe('tasks API: 层级 CRUD、依赖 DAG、拓扑与就绪', () => {
  it('covers module/phase/task/subtask CRUD and hierarchy', async () => {
    const { app } = await makeApp();
    const project = await createProject(app, 'hierarchy');

    // 模块
    expect((await api(app, 'POST', '/tasks/projects/nope/modules', { name: 'x' })).status).toBe(404);
    expect((await api(app, 'POST', `/tasks/projects/${project.id}/modules`, {})).status).toBe(400);
    const module = (
      await api(app, 'POST', `/tasks/projects/${project.id}/modules`, { name: 'core', description: 'd', sort_order: 1 })
    ).body.module;
    expect(module.project_id).toBe(project.id);
    expect(module.sort_order).toBe(1);
    expect((await api(app, 'POST', `/tasks/projects/${project.id}/modules`, { name: 'core' })).status).toBe(400);
    expect((await api(app, 'GET', `/tasks/projects/${project.id}/modules`)).body.modules).toHaveLength(1);
    expect((await api(app, 'GET', '/tasks/modules/nope')).status).toBe(404);
    const renamed = await api(app, 'PATCH', `/tasks/modules/${module.id}`, { name: 'core-renamed' });
    expect(renamed.body.module.name).toBe('core-renamed');
    expect((await api(app, 'PATCH', `/tasks/modules/${module.id}`, { status: 'bogus' })).status).toBe(400);

    // 阶段
    expect((await api(app, 'POST', '/tasks/modules/nope/phases', { name: 'x' })).status).toBe(404);
    const phase1 = (await api(app, 'POST', `/tasks/modules/${module.id}/phases`, { name: 'build' })).body.phase;
    expect(phase1.module_id).toBe(module.id);
    expect(phase1.status).toBe('pending');
    expect((await api(app, 'POST', `/tasks/modules/${module.id}/phases`, { name: 'build' })).status).toBe(400);
    const phase2 = (await api(app, 'POST', `/tasks/modules/${module.id}/phases`, { name: 'build2' })).body.phase;
    // 同一项目同时只有一个进行中的阶段
    await api(app, 'PATCH', `/tasks/phases/${phase1.id}`, { status: 'in_progress' });
    await api(app, 'PATCH', `/tasks/phases/${phase2.id}`, { status: 'in_progress' });
    expect((await api(app, 'GET', `/tasks/phases/${phase1.id}`)).body.phase.status).toBe('pending');
    expect((await api(app, 'GET', `/tasks/phases/${phase2.id}`)).body.phase.status).toBe('in_progress');
    expect((await api(app, 'PATCH', `/tasks/phases/${phase2.id}`, { status: 'bogus' })).status).toBe(400);

    // 任务
    expect((await api(app, 'POST', '/tasks/phases/nope/tasks', { title: 'x' })).status).toBe(404);
    expect((await api(app, 'POST', `/tasks/phases/${phase2.id}/tasks`, {})).status).toBe(400);
    const task = (
      await api(app, 'POST', `/tasks/phases/${phase2.id}/tasks`, { title: 'wire-db', description: 'd', priority: 2 })
    ).body.task;
    expect(task.phase_id).toBe(phase2.id);
    expect(task.module_id).toBe(module.id);
    expect(task.project_id).toBe(project.id);
    expect(task.status).toBe('todo');
    const detail = (await api(app, 'GET', `/tasks/${task.id}`)).body.task;
    expect(detail.subtasks).toEqual([]);
    expect(detail.dependencies).toEqual([]);
    expect(detail.dependents).toEqual([]);
    const done = await api(app, 'PATCH', `/tasks/${task.id}`, { status: 'done' });
    expect(done.body.task.status).toBe('done');
    expect((await api(app, 'PATCH', `/tasks/${task.id}`, { status: 'bogus' })).status).toBe(400);
    expect((await api(app, 'GET', `/tasks/phases/${phase2.id}/tasks`)).body.tasks).toHaveLength(1);

    // GET /tasks 过滤
    expect((await api(app, 'GET', `/tasks?project_id=${project.id}`)).body.tasks).toHaveLength(1);
    expect(
      (await api(app, 'GET', '/tasks?status=done')).body.tasks.map((t: { id: string }) => t.id),
    ).toContain(task.id);
    expect((await api(app, 'GET', '/tasks?status=bogus')).status).toBe(400);

    // 子任务
    expect((await api(app, 'POST', '/tasks/nope/subtasks', { title: 'x' })).status).toBe(404);
    const sub1 = (await api(app, 'POST', `/tasks/${task.id}/subtasks`, { title: 'sub-one' })).body.subtask;
    const sub2 = (await api(app, 'POST', `/tasks/${task.id}/subtasks`, { title: 'sub-two', sort_order: 2 })).body.subtask;
    expect(sub1.done).toBe(0);
    const toggled = await api(app, 'PATCH', `/tasks/subtasks/${sub1.id}`, { done: true });
    expect(toggled.body.subtask.done).toBe(1);
    expect((await api(app, 'PATCH', `/tasks/subtasks/${sub1.id}`, { done: 'yes' })).status).toBe(400);
    expect((await api(app, 'PATCH', '/tasks/subtasks/nope', { done: true })).status).toBe(404);
    expect((await api(app, 'GET', `/tasks/${task.id}/subtasks`)).body.subtasks).toHaveLength(2);
    expect((await api(app, 'DELETE', `/tasks/subtasks/${sub2.id}`)).status).toBe(204);
    expect((await api(app, 'GET', `/tasks/${task.id}/subtasks`)).body.subtasks).toHaveLength(1);
    expect((await api(app, 'DELETE', `/tasks/subtasks/${sub2.id}`)).status).toBe(404);

    // 级联与 404
    expect((await api(app, 'DELETE', `/tasks/modules/${module.id}`)).status).toBe(204);
    expect((await api(app, 'GET', `/tasks/phases/${phase2.id}`)).status).toBe(404);
    expect((await api(app, 'GET', `/tasks/${task.id}`)).status).toBe(404);
    expect((await api(app, 'GET', `/tasks/projects/${project.id}/modules`)).body.modules).toHaveLength(0);
    expect((await api(app, 'DELETE', '/tasks/modules/nope')).status).toBe(404);
    expect((await api(app, 'DELETE', '/tasks/phases/nope')).status).toBe(404);
  });

  it('manages dependencies: create, list, duplicate, unknown and self references', async () => {
    const { app } = await makeApp();
    const project = await createProject(app, 'deps');
    const { tasks } = await makeTaskTree(app, project.id, ['A', 'B']);

    const created = await api(app, 'POST', `/tasks/${tasks.A}/dependencies`, { depends_on: tasks.B });
    expect(created.status).toBe(201);
    expect(created.body.dependency.task_id).toBe(tasks.A);
    expect(created.body.dependency.depends_on_task_id).toBe(tasks.B);
    expect(created.body.dependency.depends_on_title).toBe('B');

    const detailA = (await api(app, 'GET', `/tasks/${tasks.A}`)).body.task;
    expect(detailA.dependencies).toHaveLength(1);
    const detailB = (await api(app, 'GET', `/tasks/${tasks.B}`)).body.task;
    expect(detailB.dependents).toHaveLength(1);
    expect(detailB.dependents[0].dependent_title).toBe('A');

    expect((await api(app, 'POST', `/tasks/${tasks.A}/dependencies`, { depends_on: tasks.B })).status).toBe(400);
    expect((await api(app, 'POST', `/tasks/${tasks.A}/dependencies`, { depends_on: 'nope' })).status).toBe(404);
    expect((await api(app, 'POST', '/tasks/nope/dependencies', { depends_on: tasks.B })).status).toBe(404);
    expect((await api(app, 'POST', `/tasks/${tasks.A}/dependencies`, { depends_on: tasks.A })).status).toBe(400);
    expect((await api(app, 'POST', `/tasks/${tasks.A}/dependencies`, {})).status).toBe(400);

    expect((await api(app, 'GET', `/tasks/${tasks.A}/dependencies`)).body.dependencies).toHaveLength(1);
    expect((await api(app, 'DELETE', `/tasks/${tasks.A}/dependencies/${tasks.B}`)).status).toBe(204);
    expect((await api(app, 'GET', `/tasks/${tasks.A}/dependencies`)).body.dependencies).toEqual([]);
    expect((await api(app, 'DELETE', `/tasks/${tasks.A}/dependencies/${tasks.B}`)).status).toBe(404);
  });

  it('rejects cyclic dependencies with 4xx and leaves no residue', async () => {
    const { app } = await makeApp();
    const services = getServices();
    const project = await createProject(app, 'cycle');
    const { tasks } = await makeTaskTree(app, project.id, ['A', 'B', 'C', 'D', 'E']);
    const edgeCount = () => services.repos.taskDependencies.listAll().length;

    expect((await api(app, 'POST', `/tasks/${tasks.A}/dependencies`, { depends_on: tasks.B })).status).toBe(201);
    expect((await api(app, 'POST', `/tasks/${tasks.B}/dependencies`, { depends_on: tasks.C })).status).toBe(201);
    expect(edgeCount()).toBe(2);

    // 传递环：C -> A（A 已经由 A→B→C 传递依赖 C）
    let res = await api(app, 'POST', `/tasks/${tasks.C}/dependencies`, { depends_on: tasks.A });
    expect4xx(res.status);
    expect(res.body.message).toContain('circular dependency');
    expect(edgeCount()).toBe(2);
    expect((await api(app, 'GET', `/tasks/${tasks.C}/dependencies`)).body.dependencies).toEqual([]);

    // 两节点环：D -> E 成功，E -> D 被拒
    expect((await api(app, 'POST', `/tasks/${tasks.D}/dependencies`, { depends_on: tasks.E })).status).toBe(201);
    res = await api(app, 'POST', `/tasks/${tasks.E}/dependencies`, { depends_on: tasks.D });
    expect4xx(res.status);
    expect((await api(app, 'GET', `/tasks/${tasks.E}/dependencies`)).body.dependencies).toEqual([]);
    expect(edgeCount()).toBe(3);

    // 更深的环：D -> A 合法，随后 C -> D 将闭合 D→A→B→C→D
    expect((await api(app, 'POST', `/tasks/${tasks.D}/dependencies`, { depends_on: tasks.A })).status).toBe(201);
    res = await api(app, 'POST', `/tasks/${tasks.C}/dependencies`, { depends_on: tasks.D });
    expect4xx(res.status);
    expect(edgeCount()).toBe(4);

    // 图仍然健康：拓扑可覆盖全部 5 个任务
    const topo = (await api(app, 'GET', `/tasks/projects/${project.id}/topology`)).body;
    expect(topo.order).toHaveLength(5);
  });

  it('topological sort puts dependencies before dependents', async () => {
    const { app } = await makeApp();
    const project = await createProject(app, 'topology');
    const { tasks } = await makeTaskTree(app, project.id, ['A', 'B', 'C', 'D', 'E']);
    // A 为根；B、C 依赖 A；D 依赖 B 与 C；E 独立
    await api(app, 'POST', `/tasks/${tasks.B}/dependencies`, { depends_on: tasks.A });
    await api(app, 'POST', `/tasks/${tasks.C}/dependencies`, { depends_on: tasks.A });
    await api(app, 'POST', `/tasks/${tasks.D}/dependencies`, { depends_on: tasks.B });
    await api(app, 'POST', `/tasks/${tasks.D}/dependencies`, { depends_on: tasks.C });

    const topo = (await api(app, 'GET', `/tasks/projects/${project.id}/topology`)).body;
    expect(topo.project_id).toBe(project.id);
    expect(topo.order).toHaveLength(5);
    // tasks 来自 Record 索引访问（noUncheckedIndexedAccess 下为 string | undefined），
    // 缺失时 indexOf 返回 -1，断言会显式失败
    const index = (id: string | undefined) => topo.order.indexOf(id);
    expect(index(tasks.A)).toBeLessThan(index(tasks.B));
    expect(index(tasks.A)).toBeLessThan(index(tasks.C));
    expect(index(tasks.B)).toBeLessThan(index(tasks.D));
    expect(index(tasks.C)).toBeLessThan(index(tasks.D));
    expect([...topo.order].sort()).toEqual(Object.values(tasks).sort());
    expect(topo.tasks.map((t: { id: string }) => t.id)).toEqual(topo.order);

    // 链式依赖的顺序唯一
    const chain = await createProject(app, 'topology-chain');
    const chainTree = await makeTaskTree(app, chain.id, ['X1', 'X2', 'X3']);
    await api(app, 'POST', `/tasks/${chainTree.tasks.X2}/dependencies`, { depends_on: chainTree.tasks.X1 });
    await api(app, 'POST', `/tasks/${chainTree.tasks.X3}/dependencies`, { depends_on: chainTree.tasks.X2 });
    const chainTopo = (await api(app, 'GET', `/tasks/projects/${chain.id}/topology`)).body;
    expect(chainTopo.order).toEqual([chainTree.tasks.X1, chainTree.tasks.X2, chainTree.tasks.X3]);

    expect((await api(app, 'GET', '/tasks/projects/nope/topology')).status).toBe(404);
    expect((await api(app, 'GET', '/tasks/projects/nope/ready')).status).toBe(404);
  });

  it('ready tasks follow completed dependencies and exclude terminal tasks', async () => {
    const { app } = await makeApp();
    const project = await createProject(app, 'ready');
    const { tasks } = await makeTaskTree(app, project.id, ['A', 'B', 'C', 'D', 'E']);
    await api(app, 'POST', `/tasks/${tasks.B}/dependencies`, { depends_on: tasks.A });
    await api(app, 'POST', `/tasks/${tasks.C}/dependencies`, { depends_on: tasks.A });
    await api(app, 'POST', `/tasks/${tasks.D}/dependencies`, { depends_on: tasks.B });

    const readyIds = async () =>
      (await api(app, 'GET', `/tasks/projects/${project.id}/ready`)).body.tasks.map((t: { id: string }) => t.id);

    // 尚无完成任务：只有无依赖的 A 与 E 就绪
    let ready = await readyIds();
    expect(ready).toHaveLength(2);
    expect(ready).toContain(tasks.A);
    expect(ready).toContain(tasks.E);

    // A 完成后释放 B 与 C
    await api(app, 'PATCH', `/tasks/${tasks.A}`, { status: 'done' });
    ready = await readyIds();
    expect(ready).toHaveLength(3);
    expect(ready).toContain(tasks.B);
    expect(ready).toContain(tasks.C);
    expect(ready).toContain(tasks.E);
    expect(ready).not.toContain(tasks.A);

    // B 完成后释放 D
    await api(app, 'PATCH', `/tasks/${tasks.B}`, { status: 'done' });
    ready = await readyIds();
    expect(ready).toHaveLength(3);
    expect(ready).toContain(tasks.C);
    expect(ready).toContain(tasks.D);
    expect(ready).toContain(tasks.E);

    // 取消的任务不再就绪
    await api(app, 'PATCH', `/tasks/${tasks.C}`, { status: 'cancelled' });
    ready = await readyIds();
    expect(ready).toHaveLength(2);
    expect(ready).not.toContain(tasks.C);
    expect(ready).not.toContain(tasks.A);
    expect(ready).not.toContain(tasks.B);
  });
});
