/**
 * 项目 API 测试：六态生命周期状态机（合法/非法转换）、CRUD 校验、
 * GitHub 仓库多对多关联（项目≠仓库）、项目统计与级联收缩。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { createApp } from '../src/server.js';
import { bindServices, getServices } from '../src/services/context.js';
import { PROJECT_STATUSES } from '../src/services/projects.js';

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

async function createProject(app: Hono, name: string, description?: string) {
  const res = await api(app, 'POST', '/projects', description === undefined ? { name } : { name, description });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.project; // 形状由 API 契约保证（ProjectView）
}

describe('projects API: 状态机、多仓库、统计', () => {
  it('new projects start in Planning with a coarse active projection', async () => {
    const { app } = await makeApp();
    const project = await createProject(app, 'lifecycle-demo', 'demo');
    expect(project.status).toBe('Planning');
    expect(project.storage_status).toBe('active');
    const fetched = await api(app, 'GET', `/projects/${project.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.project.status).toBe('Planning');
    expect(fetched.body.project.name).toBe('lifecycle-demo');
    expect(fetched.body.project.description).toBe('demo');
  });

  it('reaches all six statuses through legal named transitions', async () => {
    const { app } = await makeApp();
    const seen = new Set<string>(['Planning']);
    const project = await createProject(app, 'lifecycle-full');
    const act = async (action: string, expected: string) => {
      const res = await api(app, 'POST', `/projects/${project.id}/actions/${action}`);
      expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.project.status).toBe(expected);
      seen.add(expected);
    };
    // Planning → Active → Paused → Active → Maintenance → Active → Completed → Archived
    await act('activate', 'Active');
    await act('pause', 'Paused');
    await act('resume', 'Active');
    await act('maintain', 'Maintenance');
    await act('resume', 'Active');
    await act('complete', 'Completed');
    await act('archive', 'Archived');

    // 其余合法直达转换：Planning→Archived、Paused→Archived、Maintenance→Completed、Active→Archived
    const planningArchive = await createProject(app, 'planning-archive');
    const directArchive = await api(app, 'POST', `/projects/${planningArchive.id}/actions/archive`);
    expect(directArchive.body.project.status).toBe('Archived');
    seen.add('Archived');

    const pausedArchive = await createProject(app, 'paused-archive');
    await api(app, 'POST', `/projects/${pausedArchive.id}/actions/activate`);
    await api(app, 'POST', `/projects/${pausedArchive.id}/actions/pause`);
    expect((await api(app, 'POST', `/projects/${pausedArchive.id}/actions/archive`)).body.project.status).toBe('Archived');

    const maintenanceComplete = await createProject(app, 'maintenance-complete');
    await api(app, 'POST', `/projects/${maintenanceComplete.id}/actions/activate`);
    await api(app, 'POST', `/projects/${maintenanceComplete.id}/actions/maintain`);
    expect((await api(app, 'POST', `/projects/${maintenanceComplete.id}/actions/complete`)).body.project.status).toBe('Completed');

    const activeArchive = await createProject(app, 'active-archive');
    await api(app, 'POST', `/projects/${activeArchive.id}/actions/activate`);
    expect((await api(app, 'POST', `/projects/${activeArchive.id}/actions/archive`)).body.project.status).toBe('Archived');

    expect([...seen].sort()).toEqual([...PROJECT_STATUSES].sort());
    // 归档投影同步到 data_layer 的粗粒度 projects.status
    expect((await api(app, 'GET', `/projects/${project.id}`)).body.project.storage_status).toBe('archived');
    // 按六态过滤列表
    const archived = await api(app, 'GET', '/projects?status=Archived');
    expect(archived.body.projects.some((p: { id: string }) => p.id === project.id)).toBe(true);
  });

  it('rejects illegal transitions with 400 and keeps the status untouched', async () => {
    const { app } = await makeApp();
    const project = await createProject(app, 'illegal');
    const status = async () => (await api(app, 'GET', `/projects/${project.id}`)).body.project.status;

    let res = await api(app, 'POST', `/projects/${project.id}/actions/complete`); // Planning → Completed 非法
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('illegal project status transition');
    expect(await status()).toBe('Planning');

    await api(app, 'POST', `/projects/${project.id}/actions/activate`);
    await api(app, 'POST', `/projects/${project.id}/actions/pause`);
    res = await api(app, 'POST', `/projects/${project.id}/actions/complete`); // Paused → Completed 非法
    expect(res.status).toBe(400);
    expect(await status()).toBe('Paused');

    await api(app, 'POST', `/projects/${project.id}/actions/resume`);
    await api(app, 'POST', `/projects/${project.id}/actions/complete`);
    res = await api(app, 'POST', `/projects/${project.id}/actions/pause`); // Completed → Paused 非法
    expect(res.status).toBe(400);
    expect(await status()).toBe('Completed');

    await api(app, 'POST', `/projects/${project.id}/actions/archive`);
    res = await api(app, 'POST', `/projects/${project.id}/actions/resume`); // Archived 是终态
    expect(res.status).toBe(400);
    expect(await status()).toBe('Archived');

    res = await api(app, 'POST', `/projects/${project.id}/actions/frobnicate`); // 未知操作
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('unknown project action');

    res = await api(app, 'PATCH', `/projects/${project.id}`, { status: 'Active' }); // PATCH 不得绕过状态机
    expect(res.status).toBe(400);
    expect(await status()).toBe('Archived');
  });

  it('covers CRUD validation, listing filter and deletion', async () => {
    const { app } = await makeApp();
    expect((await api(app, 'POST', '/projects', {})).status).toBe(400);
    expect((await api(app, 'POST', '/projects', { name: '   ' })).status).toBe(400);
    expect((await api(app, 'POST', '/projects', { name: 'x', description: 42 })).status).toBe(400);
    expect((await api(app, 'POST', '/projects', { name: 'dup' })).status).toBe(201);
    expect((await api(app, 'POST', '/projects', { name: 'dup' })).status).toBe(400);

    expect((await api(app, 'GET', '/projects/nope')).status).toBe(404);
    expect((await api(app, 'PATCH', '/projects/nope', { name: 'y' })).status).toBe(404);
    expect((await api(app, 'DELETE', '/projects/nope')).status).toBe(404);

    const project = await createProject(app, 'crud', 'before');
    const patched = await api(app, 'PATCH', `/projects/${project.id}`, { name: 'crud-renamed', description: 'after' });
    expect(patched.status).toBe(200);
    expect(patched.body.project.name).toBe('crud-renamed');
    expect(patched.body.project.description).toBe('after');
    expect((await api(app, 'PATCH', `/projects/${project.id}`, { bogus: 1 })).status).toBe(400);

    const listed = await api(app, 'GET', '/projects?status=Planning');
    expect(listed.status).toBe(200);
    expect(listed.body.projects.some((p: { id: string }) => p.id === project.id)).toBe(true);
    expect((await api(app, 'GET', '/projects?status=Bogus')).status).toBe(400);

    expect((await api(app, 'DELETE', `/projects/${project.id}`)).status).toBe(204);
    expect((await api(app, 'GET', `/projects/${project.id}`)).status).toBe(404);
  });

  it('links one project to many repos and keeps repos project-independent', async () => {
    const { app } = await makeApp();
    const p1 = await createProject(app, 'repo-host-1');
    const p2 = await createProject(app, 'repo-host-2');

    const first = await api(app, 'POST', `/projects/${p1.id}/repos`, { repo: 'acme/alpha' });
    expect(first.status).toBe(201);
    expect(first.body.repo_link.repo_full_name).toBe('acme/alpha');
    expect(first.body.repo_link.project_id).toBe(p1.id);
    expect((await api(app, 'POST', `/projects/${p1.id}/repos`, { repo: 'acme/beta', default_branch: 'develop' })).status).toBe(201);
    expect((await api(app, 'POST', `/projects/${p1.id}/repos`, { repo: 'gamma.tools/delta' })).status).toBe(201);

    const repos1 = await api(app, 'GET', `/projects/${p1.id}/repos`);
    expect(repos1.body.repos).toHaveLength(3);

    expect((await api(app, 'POST', `/projects/${p1.id}/repos`, { repo: 'acme/alpha' })).status).toBe(400);
    expect((await api(app, 'POST', `/projects/${p1.id}/repos`, { repo: 'justname' })).status).toBe(400);
    expect((await api(app, 'POST', `/projects/${p1.id}/repos`, { repo: '' })).status).toBe(400);
    expect((await api(app, 'GET', '/projects/nope/repos')).status).toBe(404);
    expect((await api(app, 'POST', '/projects/nope/repos', { repo: 'a/b' })).status).toBe(404);

    // 项目≠仓库：同一 GitHub 仓库可关联到第二个项目
    const shared = await api(app, 'POST', `/projects/${p2.id}/repos`, { repo: 'acme/alpha' });
    expect(shared.status).toBe(201);
    expect(shared.body.repo_link.id).not.toBe(first.body.repo_link.id);
    expect((await api(app, 'GET', `/projects/${p2.id}/repos`)).body.repos).toHaveLength(1);

    // 删除整个项目不影响其它项目对同一仓库的关联
    expect((await api(app, 'DELETE', `/projects/${p1.id}`)).status).toBe(204);
    const repos2 = await api(app, 'GET', `/projects/${p2.id}/repos`);
    expect(repos2.body.repos).toHaveLength(1);
    expect(repos2.body.repos[0].repo_full_name).toBe('acme/alpha');

    expect((await api(app, 'DELETE', `/projects/${p2.id}/repos/${shared.body.repo_link.id}`)).status).toBe(204);
    expect((await api(app, 'GET', `/projects/${p2.id}/repos`)).body.repos).toHaveLength(0);
    expect((await api(app, 'DELETE', `/projects/${p2.id}/repos/${shared.body.repo_link.id}`)).status).toBe(404);
  });

  it('project stats match the fixture and react to cascades', async () => {
    const { app } = await makeApp();
    const project = await createProject(app, 'stats-fixture');
    const m1 = (await api(app, 'POST', `/tasks/projects/${project.id}/modules`, { name: 'm1' })).body.module;
    const m2 = (await api(app, 'POST', `/tasks/projects/${project.id}/modules`, { name: 'm2' })).body.module;
    const phaseOne = (await api(app, 'POST', `/tasks/modules/${m1.id}/phases`, { name: 'phase-one' })).body.phase;
    const phaseTwo = (await api(app, 'POST', `/tasks/modules/${m2.id}/phases`, { name: 'phase-two' })).body.phase;
    expect((await api(app, 'PATCH', `/tasks/phases/${phaseOne.id}`, { status: 'in_progress' })).status).toBe(200);

    const makeTask = async (phaseId: string, title: string) =>
      (await api(app, 'POST', `/tasks/phases/${phaseId}/tasks`, { title })).body.task as { id: string };
    const taskA = await makeTask(phaseOne.id, 'A');
    const taskB = await makeTask(phaseOne.id, 'B');
    const taskC = await makeTask(phaseOne.id, 'C');
    const taskD = await makeTask(phaseOne.id, 'D');
    const taskE = await makeTask(phaseTwo.id, 'E');

    expect((await api(app, 'PATCH', `/tasks/${taskA.id}`, { status: 'done' })).status).toBe(200);
    expect((await api(app, 'PATCH', `/tasks/${taskB.id}`, { status: 'in_progress' })).status).toBe(200);
    expect((await api(app, 'PATCH', `/tasks/${taskE.id}`, { status: 'done' })).status).toBe(200);
    // A 已完成但依赖 D（未完成）：不阻塞计数；C 未完成且依赖 D：阻塞
    expect((await api(app, 'POST', `/tasks/${taskA.id}/dependencies`, { depends_on: taskD.id })).status).toBe(201);
    expect((await api(app, 'POST', `/tasks/${taskC.id}/dependencies`, { depends_on: taskD.id })).status).toBe(201);

    const stats = await api(app, 'GET', `/projects/${project.id}/stats`);
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({
      project_id: project.id,
      modules: 2,
      total_tasks: 5,
      completed_tasks: 2,
      in_progress_tasks: 1,
      blocked_tasks: 1,
    });
    expect(stats.body.current_phase).toEqual({ id: phaseOne.id, name: 'phase-one', module_id: m1.id });
    expect(stats.body.progress).toBe(0.4);

    expect((await api(app, 'GET', '/projects/nope/stats')).status).toBe(404);

    const empty = await createProject(app, 'stats-empty');
    const emptyStats = (await api(app, 'GET', `/projects/${empty.id}/stats`)).body;
    expect(emptyStats).toMatchObject({
      modules: 0,
      total_tasks: 0,
      completed_tasks: 0,
      in_progress_tasks: 0,
      blocked_tasks: 0,
      current_phase: null,
      progress: 0,
    });

    // 级联：删除模块 m2 后，其阶段与任务（E）一并消失，统计同步收缩
    expect((await api(app, 'DELETE', `/tasks/modules/${m2.id}`)).status).toBe(204);
    const after = (await api(app, 'GET', `/projects/${project.id}/stats`)).body;
    expect(after).toMatchObject({
      modules: 1,
      total_tasks: 4,
      completed_tasks: 1,
      in_progress_tasks: 1,
      blocked_tasks: 1,
    });
    expect(after.current_phase.id).toBe(phaseOne.id);
    expect(after.progress).toBe(0.25);
  });
});
