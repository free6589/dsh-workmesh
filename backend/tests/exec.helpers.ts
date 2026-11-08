/**
 * exec 模块测试公共件：内存库 + 种子数据（项目/模块/阶段/任务/子项）+ 服务装配。
 * 全部执行端为 MockExecutor（真实 DSH/Grok Workflow 在本沙箱不可达，见任务报告）。
 */
import { createRepositories, type Repositories } from '../src/db/repositories/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { openDatabase, type SqlDb } from '../src/db/sqlite.js';
import { ExecService } from '../src/exec/service.js';
import { MockExecutor } from '../src/exec/executor.js';
import type { ExecFeedback, Executor } from '../src/exec/types.js';
import type { CreateTask, Module, Phase, Project, Task } from '../src/types/entities.js';

export interface ExecSeed {
  project: Project;
  module: Module;
  phase: Phase;
  task: Task;
}

export function seedTaskTree(repos: Repositories, overrides: Partial<CreateTask> = {}): ExecSeed {
  const project = repos.projects.create({ name: 'exec-test-project', description: '执行平面测试项目' });
  const module = repos.modules.create({ project_id: project.id, name: 'M9' });
  const phase = repos.phases.create({ module_id: module.id, name: 'P4', objective: '执行平面落地' });
  const task = repos.tasks.create({
    project_id: project.id,
    module_id: module.id,
    phase_id: phase.id,
    title: '执行平面集成任务',
    description: '把已授权任务打包并派发给 Grok Workflow，跟踪状态并落库。',
    priority: 5,
    ...overrides,
  });
  repos.subtasks.create({ task_id: task.id, title: '子项一：任务包生成', sort_order: 1 });
  repos.subtasks.create({ task_id: task.id, title: '子项二：事件落库', sort_order: 2 });
  return { project, module, phase, task };
}

export interface ExecTestHandle {
  db: SqlDb;
  repos: Repositories;
  mock: MockExecutor;
  service: ExecService;
  seed: ExecSeed;
  /** onFeedback 钩子收到的调度器反馈序列。 */
  feedback: ExecFeedback[];
}

export function setupExecService(
  options: {
    timeoutMs?: number;
    maxAttempts?: number;
    queueBatchLimit?: number;
    actor?: string;
    executor?: Executor;
  } = {},
): ExecTestHandle {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const repos = createRepositories(db);
  const executor = options.executor ?? new MockExecutor();
  if (!(executor instanceof MockExecutor)) {
    throw new Error('setupExecService expects a MockExecutor');
  }
  const feedback: ExecFeedback[] = [];
  const service = new ExecService({
    db,
    repos,
    executors: [executor],
    timeoutMs: options.timeoutMs,
    maxAttempts: options.maxAttempts,
    queueBatchLimit: options.queueBatchLimit,
    actor: options.actor,
    onFeedback: (item) => {
      feedback.push(item);
    },
  });
  const seed = seedTaskTree(repos);
  return { db, repos, mock: executor, service, seed, feedback };
}

/** 轮询直到断言通过（用于后台运行终态），超时抛错。 */
export async function waitFor(check: () => boolean, options: { tries?: number; intervalMs?: number } = {}): Promise<void> {
  const tries = options.tries ?? 200;
  const intervalMs = options.intervalMs ?? 10;
  for (let i = 0; i < tries; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor: condition not met within budget');
}
