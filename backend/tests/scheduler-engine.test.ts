import { beforeEach, describe, expect, it } from 'vitest';
import {
  createRepositories,
  NotFoundError,
  openDatabase,
  runMigrations,
  ValidationError,
  type Repositories,
} from '../src/db/index.js';
import type { SqlDb } from '../src/db/sqlite.js';
import type { Gateway, Project, Task } from '../src/types/entities.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  SCHEDULER_SETTINGS_KEYS,
  SchedulerEngine,
  type BlockedReportDetail,
  type StoredDecisionRecord,
} from '../src/scheduler/index.js';

let db: SqlDb;
let repos: Repositories;
let engine: SchedulerEngine;
let nowMs: number;
let idSeq: number;

const BASE_MS = Date.parse('2026-11-08T00:00:00.000Z');

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  repos = createRepositories(db);
  nowMs = BASE_MS;
  idSeq = 0;
  engine = new SchedulerEngine({
    repos,
    now: () => new Date(nowMs),
    newId: () => `dec-${String(++idSeq).padStart(3, '0')}`,
  });
});

interface SeededProject {
  project: Project;
  moduleId: string;
  phaseId: string;
}

function seedProject(name: string): SeededProject {
  const project = repos.projects.create({ name });
  const module = repos.modules.create({ project_id: project.id, name: `${name}-mod` });
  const phase = repos.phases.create({ module_id: module.id, name: `${name}-phase` });
  return { project, moduleId: module.id, phaseId: phase.id };
}

function seedTask(seeded: SeededProject, title: string, priority = 0): Task {
  return repos.tasks.create({
    project_id: seeded.project.id,
    module_id: seeded.moduleId,
    phase_id: seeded.phaseId,
    title,
    priority,
  });
}

function seedGateways(): { gwA: Gateway; gwB: Gateway } {
  const gwA = repos.gateways.create({ id: 'gw-a', name: 'bifrost-main', type: 'bifrost' });
  const gwB = repos.gateways.create({ id: 'gw-b', name: 'ind-free', type: 'independent' });
  return { gwA, gwB };
}

function setSetting(key: string, value: unknown): void {
  repos.settings.set(key, JSON.stringify(value));
}

function seedCatalog(): void {
  setSetting(SCHEDULER_SETTINGS_KEYS.modelCatalog, [
    { gatewayId: 'gw-a', modelId: 'model-pro', capabilities: ['tools', 'vision'], contextWindow: 128000 },
    { gatewayId: 'gw-b', modelId: 'model-free', capabilities: ['tools'], contextWindow: 32000 },
  ]);
}

function decisionAudits(taskId: string): StoredDecisionRecord[] {
  return repos.auditLog
    .list({ action: 'scheduler_decision', entity_id: taskId })
    .map((row) => JSON.parse(row.detail) as StoredDecisionRecord);
}

function blockedReports(taskId: string): BlockedReportDetail[] {
  return repos.auditLog
    .list({ action: 'scheduler_blocked', entity_id: taskId })
    .map((row) => JSON.parse(row.detail) as BlockedReportDetail);
}

// ---------- decide：决策落库与派发 ----------

describe('engine.decide：决策落库、runs 创建与状态推进', () => {
  it('合格决策写入 audit_log + run_events，创建 queued run 并推进任务状态', () => {
    const { gwA } = seedGateways();
    seedCatalog();
    const project = seedProject('proj-one');
    const task = seedTask(project, '实现调度器');
    setSetting(SCHEDULER_SETTINGS_KEYS.taskRequirements, {
      [task.id]: { requiredCapabilities: ['tools'], minContextWindow: 64000, preferredModel: 'model-pro' },
    });

    const decision = engine.decide(task.id);
    expect(decision.decisionId).toBe('dec-001');
    expect(decision.selected?.gatewayId).toBe('gw-a');
    expect(decision.selected?.modelId).toBe('model-pro');
    // 128000 = 64000 × 2 → 上下文契合满分，总分 = 0.35+0.30+0.15+0.20 = 1.0
    expect(decision.selected?.score).toBeCloseTo(1, 3);
    expect(decision.fallbacks).toEqual([]);
    expect(decision.runId).toBeTruthy();

    const run = repos.runs.getById(decision.runId!);
    expect(run?.status).toBe('queued');
    expect(run?.project_id).toBe(project.project.id);
    expect(run?.task_id).toBe(task.id);

    const events = repos.runEvents.listByRun(decision.runId!);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('scheduler_decision');
    const eventPayload = JSON.parse(events[0]?.payload ?? '{}') as { decisionId?: string };
    expect(eventPayload.decisionId).toBe(decision.decisionId);

    expect(repos.tasks.getById(task.id)?.status).toBe('in_progress');

    const audits = decisionAudits(task.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.decisionId).toBe(decision.decisionId);
    expect(audits[0]?.attempts).toBe(0);
    expect(audits[0]?.taskStatusBefore).toBe('todo');
    expect(audits[0]?.taskStatusAfter).toBe('in_progress');
    expect(audits[0]?.runId).toBe(decision.runId);
    expect(gwA.id).toBe('gw-a');
  });

  it('重复决策不会重复派发（存在未完成 run 时只记录决策）', () => {
    seedGateways();
    seedCatalog();
    const project = seedProject('proj-one');
    const task = seedTask(project, 't');
    const first = engine.decide(task.id);
    expect(first.runId).toBeDefined();
    const second = engine.decide(task.id);
    expect(second.runId).toBeUndefined();
    expect(repos.runs.list({ task_id: task.id })).toHaveLength(1);
    expect(decisionAudits(task.id)).toHaveLength(2);
    // audit_log 按 seq 降序返回：最新一条（第二次决策）attempts = 1
    expect(decisionAudits(task.id)[0]?.attempts).toBe(1);
  });

  it('无可用资源时标记 blocked、写入 scheduler_blocked 审计与下一步安排，不创建 run', () => {
    seedGateways();
    seedCatalog();
    const project = seedProject('proj-one');
    const task = seedTask(project, 't');
    setSetting(SCHEDULER_SETTINGS_KEYS.taskRequirements, {
      [task.id]: { requiredCapabilities: ['image'] },
    });

    const decision = engine.decide(task.id);
    expect(decision.blocked).toBe(true);
    expect(decision.selected).toBeNull();
    expect(decision.runId).toBeUndefined();
    expect(repos.runs.count()).toBe(0);
    expect(repos.tasks.getById(task.id)?.status).toBe('blocked');

    const reports = blockedReports(task.id);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.causes[0]?.code).toBe('resource_unavailable');
    const plan = reports[0]?.plan ?? [];
    expect(plan[0]?.action).toBe('requeue_with_backoff');
    expect(plan[0]?.retryDelayMs).toBe(60_000);
    expect(plan[0]?.retryAt).toBe(new Date(BASE_MS + 60_000).toISOString());
    expect(reports[0]?.retryAt).toBe(new Date(BASE_MS + 60_000).toISOString());
  });
});

// ---------- 降级：备用通道 ----------

describe('engine.decide：资源不可用时自动降级到备用通道', () => {
  it('主网关不可用 → 派发到独立 API 网关；恢复后回到主网关', () => {
    seedGateways();
    seedCatalog();
    const project = seedProject('proj-one');
    const taskA = seedTask(project, 'a');
    const taskB = seedTask(project, 'b');
    const taskC = seedTask(project, 'c');
    setSetting(SCHEDULER_SETTINGS_KEYS.taskRequirements, {
      [taskA.id]: { requiredCapabilities: ['tools'], preferredModel: 'model-pro' },
      [taskB.id]: { requiredCapabilities: ['tools'], preferredModel: 'model-pro' },
      [taskC.id]: { requiredCapabilities: ['tools'], preferredModel: 'model-pro' },
    });

    // 基线：主网关 healthy，选中 model-pro，model-free 作为降级备选
    const healthy = engine.decide(taskA.id);
    expect(healthy.selected?.gatewayId).toBe('gw-a');
    expect(healthy.fallbacks.map((f) => f.gatewayId)).toEqual(['gw-b']);

    // 主网关 unavailable → 备用通道（独立 API 网关）接管并真实派发
    setSetting(SCHEDULER_SETTINGS_KEYS.gatewayHealth, { 'gw-a': 'unavailable' });
    const degraded = engine.decide(taskB.id);
    expect(degraded.selected?.gatewayId).toBe('gw-b');
    expect(degraded.selected?.gatewayKind).toBe('independent');
    expect(degraded.selected?.modelId).toBe('model-free');
    expect(degraded.runId).toBeDefined();
    const rejected = degraded.candidates.find((c) => c.gatewayId === 'gw-a');
    expect(rejected?.reasonCodes).toContain('gateway_unavailable');
    expect(degraded.rationale.join('\n')).toContain('网关不可用');

    // 恢复健康 → 新任务回到主网关（同输入同输出）
    setSetting(SCHEDULER_SETTINGS_KEYS.gatewayHealth, {});
    const recovered = engine.decide(taskC.id);
    expect(recovered.selected?.gatewayId).toBe('gw-a');
    expect(recovered.runId).toBeDefined();
  });
});

// ---------- 决策查询 ----------

describe('engine：决策查询', () => {
  it('listDecisions 支持按任务/项目/网关过滤，getDecisionById 支持主键查询', () => {
    seedGateways();
    seedCatalog();
    const p1 = seedProject('proj-one');
    const p2 = seedProject('proj-two');
    const t1 = seedTask(p1, 't1');
    const t2 = seedTask(p2, 't2');
    setSetting(SCHEDULER_SETTINGS_KEYS.gatewayHealth, { 'gw-a': 'unavailable' });
    engine.decide(t1.id);
    engine.decide(t2.id);

    const all = engine.listDecisions();
    expect(all).toHaveLength(2);
    expect(engine.listDecisions({ taskId: t1.id })).toHaveLength(1);
    expect(engine.listDecisions({ projectId: p2.project.id })[0]?.decision.taskId).toBe(t2.id);
    // 两轮决策都降级到 gw-b
    expect(engine.listDecisions({ gatewayId: 'gw-b' })).toHaveLength(2);
    expect(engine.listDecisions({ gatewayId: 'gw-a' })).toHaveLength(0);

    const first = all[0]?.decision;
    expect(first).toBeDefined();
    const fetched = engine.getDecisionById(first!.decisionId);
    expect(fetched.taskId).toBe(first!.taskId);
    expect(() => engine.getDecisionById('dec-zzz')).toThrow(NotFoundError);
  });
});

// ---------- 无人值守 tick ----------

describe('engine.tick：无人值守调度循环', () => {
  it('按跨项目协同优先级派发；依赖阻塞自动标记并在依赖完成后自动恢复', () => {
    seedGateways();
    seedCatalog();
    const p1 = seedProject('proj-one');
    const p2 = seedProject('proj-two');
    const taskA = seedTask(p1, 'a');
    const taskB = seedTask(p2, 'b');
    const taskD = seedTask(p2, 'd');
    repos.taskDependencies.add(taskD.id, taskA.id);
    setSetting(SCHEDULER_SETTINGS_KEYS.taskRequirements, {
      [taskA.id]: { requiredCapabilities: ['tools'] },
      [taskB.id]: { requiredCapabilities: ['tools'] },
    });
    setSetting(SCHEDULER_SETTINGS_KEYS.projectPriorities, {
      [p1.project.id]: 5,
      [p2.project.id]: 9,
    });
    setSetting(SCHEDULER_SETTINGS_KEYS.unattended, true);

    const summary1 = engine.tick();
    expect(summary1.mode).toBe('unattended');
    // task-d 依赖未完成 → 标记 blocked + wait_dependency 安排
    expect(summary1.newlyBlocked.map((b) => b.taskId)).toEqual([taskD.id]);
    expect(summary1.newlyBlocked[0]?.plan[0]?.action).toBe('wait_dependency');
    expect(summary1.newlyBlocked[0]?.plan[0]?.willAutoExecute).toBe(true);
    const blockedReport = blockedReports(taskD.id)[0];
    expect(blockedReport?.causes[0]?.code).toBe('dependency_unmet');
    expect(blockedReport?.causes[0]?.dependsOnTaskId).toBe(taskA.id);
    // 派发顺序：task-a（0.5 + 跨项目加成 1.8 = 2.3）> task-b（0.9）
    expect(summary1.dispatchOrder).toEqual([taskA.id, taskB.id]);
    expect(summary1.dispatched.map((d) => d.taskId)).toEqual([taskA.id, taskB.id]);
    expect(summary1.dispatched[0]?.gatewayId).toBe('gw-a');
    expect(summary1.dispatched[0]?.modelId).toBe('model-pro');
    expect(summary1.requeued).toEqual([]);

    // 模拟 task-a 执行完成 → 下一轮 tick 自动恢复 task-d
    repos.tasks.update(taskA.id, { status: 'done' });
    const summary2 = engine.tick();
    expect(summary2.requeued).toEqual([{ taskId: taskD.id, reason: '依赖已完成，自动回队' }]);
    expect(summary2.dispatched.map((d) => d.taskId)).toEqual([taskD.id]);
    expect(repos.tasks.getById(taskD.id)?.status).toBe('in_progress');
    expect(repos.runs.list({ task_id: taskD.id })).toHaveLength(1);
  });

  it('资源不可用时按退避计划自动重试，达到上限后升级人工并不再自动重试', () => {
    seedGateways();
    seedCatalog();
    const project = seedProject('proj-one');
    const task = seedTask(project, 't');
    setSetting(SCHEDULER_SETTINGS_KEYS.taskRequirements, {
      [task.id]: { requiredCapabilities: ['tools'], minContextWindow: 64000 },
    });
    setSetting(SCHEDULER_SETTINGS_KEYS.gatewayHealth, { 'gw-a': 'unavailable' });
    setSetting(SCHEDULER_SETTINGS_KEYS.unattended, true);

    // 第 1 轮：直接派发失败 → blocked，60s 后重试
    const tick1 = engine.tick();
    expect(tick1.resourceBlocked.map((b) => b.taskId)).toEqual([task.id]);
    expect(repos.tasks.getById(task.id)?.status).toBe('blocked');
    expect(blockedReports(task.id)[0]?.plan[0]?.retryDelayMs).toBe(60_000);

    // 未到重试时间 → 跳过
    nowMs += 30_000;
    const tickTooEarly = engine.tick();
    expect(tickTooEarly.requeued).toEqual([]);
    expect(tickTooEarly.skipped[0]?.reason).toContain('未到自动重试时间');

    // 到达重试时间但资源仍不可用 → 重试一次，退避翻倍
    nowMs += 31_000; // BASE+61s
    const tick2 = engine.tick();
    expect(tick2.requeued).toEqual([{ taskId: task.id, reason: '到达重试时间，自动回队' }]);
    expect(tick2.resourceBlocked).toHaveLength(1);
    expect(decisionAudits(task.id)).toHaveLength(2);
    expect(blockedReports(task.id)[0]?.plan[0]?.retryDelayMs).toBe(120_000);

    // 继续重试到上限
    nowMs += 121_000; // BASE+182s
    const tick3 = engine.tick();
    expect(tick3.resourceBlocked).toHaveLength(1);
    expect(blockedReports(task.id)[0]?.plan[0]?.retryDelayMs).toBe(240_000);
    nowMs += 241_000; // BASE+423s
    const tick4 = engine.tick();
    expect(tick4.resourceBlocked).toHaveLength(1);
    // 第 4 次决策（attempts=3 >= maxAttempts）→ 升级人工
    expect(decisionAudits(task.id)).toHaveLength(4);
    const finalPlan = blockedReports(task.id)[0]?.plan ?? [];
    expect(finalPlan[0]?.action).toBe('escalate_human');
    expect(finalPlan[0]?.automatic).toBe(false);

    // 升级后的任务不再自动重试
    const tick5 = engine.tick();
    expect(tick5.requeued).toEqual([]);
    expect(tick5.skipped[0]?.reason).toContain('已升级为人工介入');
    expect(decisionAudits(task.id)).toHaveLength(4);
    expect(repos.runs.count()).toBe(0);
    expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
  });

  it('人工标记阻塞的任务在无人值守下不会被自动恢复', () => {
    seedGateways();
    seedCatalog();
    const project = seedProject('proj-one');
    const task = seedTask(project, 't');
    setSetting(SCHEDULER_SETTINGS_KEYS.unattended, true);
    repos.tasks.update(task.id, { status: 'blocked' });

    const summary = engine.tick();
    expect(summary.requeued).toEqual([]);
    expect(summary.skipped).toEqual([
      { taskId: task.id, reason: 'blocked 但无调度器阻塞记录（视为人工标记），等待人工处理' },
    ]);
    expect(repos.tasks.getById(task.id)?.status).toBe('blocked');
  });

  it('attended 模式只做阻塞识别与标记，不自动派发', () => {
    seedGateways();
    seedCatalog();
    const p1 = seedProject('proj-one');
    const p2 = seedProject('proj-two');
    const taskA = seedTask(p1, 'a');
    const taskB = seedTask(p2, 'b');
    repos.taskDependencies.add(taskB.id, taskA.id);

    const summary = engine.tick();
    expect(summary.mode).toBe('attended');
    expect(summary.newlyBlocked.map((b) => b.taskId)).toEqual([taskB.id]);
    expect(repos.tasks.getById(taskB.id)?.status).toBe('blocked');
    expect(summary.dispatched).toEqual([]);
    expect(repos.runs.count()).toBe(0);
    expect(repos.tasks.getById(taskA.id)?.status).toBe('todo');
  });
});

// ---------- 派发顺序预览与 settings ----------

describe('engine：派发顺序预览与 settings 校验', () => {
  it('dispatchOrderPreview 输出协同加成且不产生任何落库副作用', () => {
    seedGateways();
    seedCatalog();
    const p1 = seedProject('proj-one');
    const p2 = seedProject('proj-two');
    const taskA = seedTask(p1, 'a');
    const taskB = seedTask(p2, 'b');
    const taskD = seedTask(p2, 'd');
    repos.taskDependencies.add(taskD.id, taskA.id);
    setSetting(SCHEDULER_SETTINGS_KEYS.projectPriorities, { [p2.project.id]: 9 });

    const order = engine.dispatchOrderPreview();
    expect(order.map((e) => e.taskId)).toEqual([taskA.id, taskB.id]);
    expect(order[0]?.crossProjectBoost).toBeCloseTo(1.8, 2);
    expect(repos.auditLog.list().length).toBe(0);
    expect(repos.runs.count()).toBe(0);
    expect(taskB.id).toBeTruthy();
    expect(taskD.id).toBeTruthy();
  });

  it('非法 settings 值显式报错，不静默回退', () => {
    repos.settings.set(SCHEDULER_SETTINGS_KEYS.unattended, 'maybe');
    expect(() => engine.settings()).toThrow(ValidationError);
    repos.settings.set(SCHEDULER_SETTINGS_KEYS.unattended, 'true');
    expect(engine.isUnattended()).toBe(true);
    repos.settings.set(SCHEDULER_SETTINGS_KEYS.unattended, 'false');
    expect(engine.isUnattended()).toBe(false);
  });
});
