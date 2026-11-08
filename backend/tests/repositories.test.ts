import { beforeEach, describe, expect, it } from 'vitest';
import { createRepositories, type Repositories } from '../src/db/repositories/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { openDatabase, type SqlDb } from '../src/db/sqlite.js';
import { NotFoundError, ValidationError } from '../src/db/errors.js';

let db: SqlDb;
let repos: Repositories;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  repos = createRepositories(db);
});

describe('projects (CRUD)', () => {
  it('creates, reads, updates, lists and deletes', () => {
    const created = repos.projects.create({ name: 'alpha', description: 'first' });
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('active');
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(repos.projects.getById(created.id)?.name).toBe('alpha');
    expect(repos.projects.getByName('alpha')?.id).toBe(created.id);

    const updated = repos.projects.update(created.id, { description: 'changed', status: 'archived' });
    expect(updated).toBeDefined();
    expect(updated!.description).toBe('changed');
    expect(updated!.status).toBe('archived');
    expect(updated!.updated_at >= updated!.created_at).toBe(true);

    expect(repos.projects.list({ status: 'archived' })).toHaveLength(1);
    expect(repos.projects.list({ status: 'active' })).toHaveLength(0);
    expect(repos.projects.count()).toBe(1);

    expect(repos.projects.delete(created.id)).toBe(true);
    expect(repos.projects.getById(created.id)).toBeUndefined();
    expect(repos.projects.delete(created.id)).toBe(false);
  });

  it('rejects duplicate names and unknown fields', () => {
    repos.projects.create({ name: 'dup' });
    expect(() => repos.projects.create({ name: 'dup' })).toThrow(ValidationError);
    expect(() => repos.projects.create({ name: 'x', bogus: 1 } as never)).toThrow(/unknown field/);
    expect(() => repos.projects.getByIdOrThrow('missing')).toThrow(NotFoundError);
  });
});

describe('project_repos (project -> github repos, one to many)', () => {
  it('links multiple repos with uniqueness per (project, repo)', () => {
    const project = repos.projects.create({ name: 'proj' });
    const a = repos.projectRepos.create({ project_id: project.id, repo_full_name: 'me/one' });
    const b = repos.projectRepos.create({ project_id: project.id, repo_full_name: 'me/two', enabled: false });

    expect(repos.projectRepos.list({ project_id: project.id })).toHaveLength(2);
    expect(b.enabled).toBe(0);
    expect(repos.projectRepos.findByProjectAndRepo(project.id, 'me/one')?.id).toBe(a.id);
    expect(() =>
      repos.projectRepos.create({ project_id: project.id, repo_full_name: 'me/one' }),
    ).toThrow(/already linked/);

    expect(repos.projectRepos.update(a.id, { default_branch: 'develop' })?.default_branch).toBe('develop');
  });

  it('cascades when the project is deleted', () => {
    const project = repos.projects.create({ name: 'gone' });
    repos.projectRepos.create({ project_id: project.id, repo_full_name: 'me/repo' });
    repos.projects.delete(project.id);
    expect(repos.projectRepos.count()).toBe(0);
  });
});

describe('module / phase / task / subtask hierarchy', () => {
  function buildHierarchy() {
    const project = repos.projects.create({ name: 'h' });
    const module = repos.modules.create({ project_id: project.id, name: 'core' });
    const phase = repos.phases.create({ module_id: module.id, name: 'p1' });
    return { project, module, phase };
  }

  it('CRUD through the whole hierarchy with filters', () => {
    const { project, module, phase } = buildHierarchy();

    const task = repos.tasks.create({
      project_id: project.id,
      module_id: module.id,
      phase_id: phase.id,
      title: 'write code',
      priority: 2,
    });
    const subtask = repos.subtasks.create({ task_id: task.id, title: 'step 1' });

    expect(repos.tasks.list({ phase_id: phase.id })).toHaveLength(1);
    expect(repos.tasks.list({ status: 'todo' })).toHaveLength(1);
    expect(repos.tasks.update(task.id, { status: 'in_progress' })?.status).toBe('in_progress');
    expect(repos.subtasks.update(subtask.id, { done: true })?.done).toBe(1);
    expect(repos.subtasks.list({ task_id: task.id, done: 1 })).toHaveLength(1);

    expect(() => repos.phases.create({ module_id: module.id, name: 'p1' })).toThrow(/already exists/);
    expect(() =>
      repos.tasks.create({
        project_id: project.id,
        module_id: module.id,
        phase_id: 'missing-phase',
        title: 'broken',
      }),
    ).toThrow(/does not exist/);
  });

  it('cascades deletes down the hierarchy', () => {
    const { project, module, phase } = buildHierarchy();
    const task = repos.tasks.create({
      project_id: project.id,
      module_id: module.id,
      phase_id: phase.id,
      title: 't',
    });
    repos.subtasks.create({ task_id: task.id, title: 's' });

    repos.modules.delete(module.id);
    expect(repos.phases.count()).toBe(0);
    expect(repos.tasks.count()).toBe(0);
    expect(repos.subtasks.count()).toBe(0);
  });
});

describe('task_dependencies (DAG)', () => {
  it('records edges, prevents cycles and orders topologically', () => {
    const project = repos.projects.create({ name: 'dag' });
    const module = repos.modules.create({ project_id: project.id, name: 'm' });
    const phase = repos.phases.create({ module_id: module.id, name: 'p' });
    const mk = (title: string) =>
      repos.tasks.create({ project_id: project.id, module_id: module.id, phase_id: phase.id, title }).id;
    const a = mk('a');
    const b = mk('b');
    const c = mk('c');
    const d = mk('d');

    const deps = repos.taskDependencies;
    expect(deps.add(b, a).depends_on_task_id).toBe(a); // b depends on a
    expect(deps.add(c, b)).toBeTruthy(); // c depends on b
    expect(deps.add(d, a)).toBeTruthy();

    expect(deps.listByTask(c).map((e) => e.depends_on_task_id)).toEqual([b]);
    expect(deps.listDependents(a).map((e) => e.task_id).sort()).toEqual([b, d].sort());

    // 自环、直接重复、传递环都被拒绝
    expect(() => deps.add(a, a)).toThrow(/cannot depend on itself/);
    expect(() => deps.add(b, a)).toThrow(/already exists/);
    expect(() => deps.add(a, c)).toThrow(/circular dependency/);

    expect(deps.topologicalOrder().slice(0, 1)).toEqual([a]);
    const order = deps.topologicalOrder([a, b, c]);
    expect(order.indexOf(a)).toBeLessThan(order.indexOf(c));
    expect(order.indexOf(b)).toBeLessThan(order.indexOf(c));
    expect(order.slice(-1)[0]).toBe(c);

    expect(deps.remove(d, a)).toBe(true);
    expect(deps.remove(d, a)).toBe(false);
    expect(() => deps.add('missing', a)).toThrow(NotFoundError);
  });

  it('cascade-deletes edges when a task is removed', () => {
    const project = repos.projects.create({ name: 'dag2' });
    const module = repos.modules.create({ project_id: project.id, name: 'm' });
    const phase = repos.phases.create({ module_id: module.id, name: 'p' });
    const mk = (title: string) =>
      repos.tasks.create({ project_id: project.id, module_id: module.id, phase_id: phase.id, title }).id;
    const a = mk('a');
    const b = mk('b');
    repos.taskDependencies.add(b, a);
    repos.tasks.delete(a);
    expect(repos.taskDependencies.listAll()).toHaveLength(0);
  });
});

describe('gateways (CRUD)', () => {
  it('creates, updates, filters and rejects duplicate names', () => {
    const gw = repos.gateways.create({ name: 'main', type: 'openai-compatible', base_url: 'https://api.example.com' });
    expect(repos.gateways.getById(gw.id)?.name).toBe('main');
    expect(repos.gateways.update(gw.id, { enabled: false })?.enabled).toBe(0);
    expect(repos.gateways.list({ enabled: 0 })).toHaveLength(1);
    expect(repos.gateways.list({ type: 'openai-compatible' })).toHaveLength(1);
    expect(() => repos.gateways.create({ name: 'main' })).toThrow(/already exists/);
    expect(repos.gateways.getByName('main')?.id).toBe(gw.id);
  });
});

describe('models, quotas and agents', () => {
  it('wires model -> agent and gateway/model -> quota', () => {
    const model = repos.models.create({ name: 'gpt-x', provider: 'openai', context_window: 128000 });
    const gw = repos.gateways.create({ name: 'gw1' });
    const quota = repos.quotas.create({
      gateway_id: gw.id,
      model_id: model.id,
      metric: 'tokens',
      limit_value: 1_000_000,
      window_type: 'day',
    });
    const agent = repos.agents.create({ name: 'worker', role: 'coder', model_id: model.id });

    expect(repos.models.getByName('gpt-x')?.context_window).toBe(128000);
    expect(repos.quotas.list({ gateway_id: gw.id })).toHaveLength(1);
    expect(repos.quotas.getById(quota.id)?.window_type).toBe('day');
    expect(repos.agents.getByName('worker')?.model_id).toBe(model.id);

    // 删除 model 后：quota 级联消失，agent.model_id 置空
    repos.models.delete(model.id);
    expect(repos.quotas.count()).toBe(0);
    expect(repos.agents.getById(agent.id)?.model_id).toBeNull();
  });

  it('validates quota fields', () => {
    expect(() =>
      repos.quotas.create({ metric: 'tokens', limit_value: 10, window_type: 'week' as never }),
    ).toThrow();
    expect(() => repos.quotas.create({ metric: 'bogus' as never, limit_value: 10, window_type: 'day' })).toThrow();
  });
});

describe('runs and run_events', () => {
  it('walks the run lifecycle with state guards', () => {
    const run = repos.runs.create({ status: 'queued' });
    expect(run.started_at).toBeNull();

    const started = repos.runs.start(run.id);
    expect(started.status).toBe('running');
    expect(started.started_at).toBeTruthy();

    const finished = repos.runs.finish(run.id, { status: 'failed', error: 'boom' });
    expect(finished.status).toBe('failed');
    expect(finished.error).toBe('boom');
    expect(finished.finished_at).toBeTruthy();

    expect(repos.runs.listUnfinished()).toHaveLength(0);
    expect(() => repos.runs.start(run.id)).toThrow(/already finished/);
    expect(() => repos.runs.finish(run.id, { status: 'succeeded' })).toThrow(/already finished/);
    expect(() => repos.runs.start('missing')).toThrow(NotFoundError);
  });

  it('appends and streams events per run', () => {
    const run = repos.runs.create({});
    const first = repos.runEvents.append({ run_id: run.id, type: 'start', payload: { step: 1 } });
    expect(first.seq).toBeGreaterThan(0);
    expect(JSON.parse(first.payload)).toEqual({ step: 1 });

    repos.runEvents.append({ run_id: run.id, level: 'warn', type: 'retry' });
    const events = repos.runEvents.listByRun(run.id);
    expect(events).toHaveLength(2);
    expect(events[0]!.seq).toBeLessThan(events[1]!.seq);

    expect(repos.runEvents.listByRun(run.id, { afterSeq: first.seq })).toHaveLength(1);
    expect(repos.runEvents.listByRun(run.id, { limit: 1 })).toHaveLength(1);
    expect(() => repos.runEvents.append({ run_id: 'missing' })).toThrow(NotFoundError);

    // run 删除级联清空事件
    repos.runs.delete(run.id);
    expect(repos.runEvents.deleteByRun(run.id)).toBe(0);
  });
});

describe('audit_log and settings', () => {
  it('records audit entries with filters and ordering', () => {
    repos.auditLog.record({ actor: 'alice', action: 'project.create', entity_type: 'project', entity_id: 'p1' });
    repos.auditLog.record({ actor: 'bob', action: 'run.start', entity_type: 'run', entity_id: 'r1', detail: { ok: true } });

    const all = repos.auditLog.list();
    expect(all).toHaveLength(2);
    expect(all[0]!.action).toBe('run.start'); // seq DESC
    expect(JSON.parse(all[0]!.detail)).toEqual({ ok: true });

    expect(repos.auditLog.list({ actor: 'alice' })).toHaveLength(1);
    expect(repos.auditLog.list({ action: 'run.start' })).toHaveLength(1);
    expect(repos.auditLog.list({ limit: 1 })).toHaveLength(1);
    expect(() => repos.auditLog.record({ action: '' })).toThrow(ValidationError);
  });

  it('upserts settings and deletes them', () => {
    expect(repos.settings.get('theme')).toBeUndefined();
    expect(() => repos.settings.require('theme')).toThrow(NotFoundError);

    repos.settings.set('theme', 'dark');
    expect(repos.settings.get('theme')).toBe('dark');
    repos.settings.set('theme', 'light');
    expect(repos.settings.get('theme')).toBe('light');
    expect(repos.settings.keys()).toEqual(['theme']);
    expect(repos.settings.list()).toHaveLength(1);

    expect(repos.settings.delete('theme')).toBe(true);
    expect(repos.settings.keys()).toEqual([]);
    expect(() => repos.settings.set('', 'x')).toThrow(ValidationError);
  });
});
