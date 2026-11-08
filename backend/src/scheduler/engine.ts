/**
 * 调度引擎：把策略输出落到数据层，并驱动无人值守的调度循环。
 *
 * 每次决策（decide）：
 * 1. 组装调度上下文（任务要求 ← settings 覆盖、项目优先级 ← settings、资源数据 ← 端口）；
 * 2. 调用策略引擎得到确定性选择与理由；
 * 3. 完整决策写入 audit_log（action = scheduler_decision），派发时创建 queued run 并
 *    把决策挂到 run_events（type = scheduler_decision），供执行平面消费；
 * 4. 阻塞时按状态机标记任务并生成下一步安排（audit_log action = scheduler_blocked）。
 *
 * tick（无人值守一轮）：
 * 1. 依赖阻塞识别：todo 任务依赖未完成 → 标记 blocked（两种模式都执行）；
 * 2. 阻塞恢复（仅 unattended）：依赖完成或到达退避重试时刻 → 自动回队重调度，
 *    达到重试上限或人工标记的任务升级人工、不再自动重试；
 * 3. 全局派发（仅 unattended）：按跨项目协同优先级取队列前 N 个任务逐个决策。
 *
 * 边界：引擎只创建/查询 run 记录与做状态迁移，不执行任何模型推理，
 * 不实现 Grok Workflow 的执行引擎，也不做 Agent2API 内部账户轮换。
 */
import { NotFoundError, ValidationError } from '../db/errors.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AuditLogEntry, Task, TaskStatus } from '../types/entities.js';
import { selectResource } from './policy.js';
import {
  computeDispatchOrder,
  NEUTRAL_PROJECT_PRIORITY,
  type DispatchOrderEntry,
  type QueueTaskSnapshot,
} from './planning.js';
import {
  DbSchedulerPorts,
  readSettingsSnapshot,
  SCHEDULER_SETTINGS_KEYS,
  type SchedulerPorts,
  type SchedulerSettingsSnapshot,
} from './ports.js';
import {
  assertTaskTransition,
  canTransitionTask,
  detectBlocking,
  isTerminalTaskStatus,
  planNextSteps,
  DEFAULT_MAX_ATTEMPTS,
  type BlockingCause,
  type BlockingReport,
  type DependencySnapshot,
  type NextStep,
} from './state.js';
import type { SchedulingContext, SchedulingDecision, StoredDecisionRecord } from './types.js';

/** audit_log 中调度器记录的统一 actor。 */
export const SCHEDULER_ACTOR = 'scheduler';
/** tick 单轮默认派发上限。 */
export const DEFAULT_TICK_LIMIT = 10;
/** 决策审计扫描上限（audit_log 无 decisionId 列，v0.1 采用线性扫描，规模可控）。 */
const AUDIT_SCAN_LIMIT = 2000;
const DEFAULT_DECISIONS_LIMIT = 50;

export interface BlockedReportDetail {
  decisionId: string | null;
  taskId: string;
  causes: BlockingCause[];
  plan: NextStep[];
  taskStatusBefore: TaskStatus;
  taskStatusAfter: TaskStatus;
  retryAt: string | null;
}

export interface BlockedTaskRecord {
  taskId: string;
  title: string;
  projectId: string;
  status: TaskStatus;
  updatedAt: string;
  causes: BlockingCause[];
  plan: NextStep[];
}

export interface TickSummary {
  mode: 'unattended' | 'attended';
  scanned: number;
  /** 依赖阻塞识别后新标记 blocked 的任务（含下一步安排）。 */
  newlyBlocked: { taskId: string; causes: BlockingCause[]; plan: NextStep[] }[];
  /** 从 blocked 自动回队的任务。 */
  requeued: { taskId: string; reason: string }[];
  /** 本轮成功派发（创建 queued run）的任务。 */
  dispatched: { taskId: string; decisionId: string; runId: string; gatewayId: string; modelId: string }[];
  /** 派发时发现资源不可用而被标记阻塞的任务。 */
  resourceBlocked: { taskId: string; decisionId: string }[];
  skipped: { taskId: string; reason: string }[];
  /** 本轮实际尝试派发的顺序（按有效优先级）。 */
  dispatchOrder: string[];
}

export interface DecisionListItem {
  seq: number;
  createdAt: string;
  decision: StoredDecisionRecord;
}

export interface SchedulerEngineOptions {
  repos: Repositories;
  /** 缺省为 DbSchedulerPorts（数据层 + settings 快照）。 */
  ports?: SchedulerPorts;
  /** 时钟注入（测试用）。 */
  now?: () => Date;
  /** id 生成注入（测试用）。 */
  newId?: () => string;
  /** 资源类阻塞的最大自动重试次数。 */
  maxAttempts?: number;
}

export class SchedulerEngine {
  private readonly repos: Repositories;
  private readonly ports: SchedulerPorts;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly maxAttempts: number;

  constructor(options: SchedulerEngineOptions) {
    this.repos = options.repos;
    this.ports = options.ports ?? new DbSchedulerPorts(options.repos);
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  settings(): SchedulerSettingsSnapshot {
    return readSettingsSnapshot(this.repos);
  }

  isUnattended(): boolean {
    return this.settings().unattended;
  }

  // ---------- 决策 ----------

  /** 对单个任务执行一次调度决策并落库（audit_log + 视情况 runs/run_events）。 */
  decide(taskId: string): SchedulingDecision {
    const task = this.repos.tasks.getByIdOrThrow(taskId);
    const settings = this.settings();
    const requirements = settings.taskRequirements[taskId] ?? { requiredCapabilities: [] };
    const projectPriority = settings.projectPriorities[task.project_id] ?? NEUTRAL_PROJECT_PRIORITY;
    const attempts = this.priorAttempts(task.id);

    const context: SchedulingContext = {
      request: {
        taskId: task.id,
        projectId: task.project_id,
        taskPriority: task.priority,
        requirements,
      },
      gateways: this.ports.listGateways(),
      catalog: this.ports.listCatalog(),
      usage: this.ports.listUsage(),
      projectPriority,
    };
    const core = selectResource(context);
    const decision: SchedulingDecision = {
      ...core,
      decisionId: this.newId(),
      createdAt: this.now().toISOString(),
    };

    const statusBefore = task.status;
    const terminal = isTerminalTaskStatus(task.status);
    const dependencies = this.dependencySnapshots(task.id);
    const blocking = detectBlocking({
      task: { id: task.id, status: task.status },
      dependencies,
      decision: { blocked: decision.blocked, rationale: decision.rationale },
    });
    const plan =
      !terminal && blocking.blocked
        ? planNextSteps({
            task: { id: task.id, title: task.title },
            blocking,
            attempts,
            maxAttempts: this.maxAttempts,
            unattended: settings.unattended,
            now: decision.createdAt,
          })
        : [];

    // 派发：只在无阻塞、任务状态允许、且没有排队/执行中的 run 时创建新的 queued run。
    const dispatchable =
      !blocking.blocked &&
      decision.selected !== null &&
      !terminal &&
      canTransitionTask(task.status, 'in_progress') &&
      !this.hasPendingRun(task.id);
    let runId: string | undefined;
    if (dispatchable) {
      const run = this.repos.runs.create({
        project_id: task.project_id,
        task_id: task.id,
        status: 'queued',
      });
      this.repos.runEvents.append({ run_id: run.id, type: 'scheduler_decision', payload: decision });
      runId = run.id;
    }

    let statusAfter = statusBefore;
    if (!terminal && blocking.blocked && task.status !== 'blocked') {
      assertTaskTransition(task.status, 'blocked');
      const updated = this.repos.tasks.update(task.id, { status: 'blocked' });
      if (updated !== undefined) statusAfter = updated.status;
    } else if (dispatchable && task.status !== 'in_progress') {
      assertTaskTransition(task.status, 'in_progress');
      const updated = this.repos.tasks.update(task.id, { status: 'in_progress' });
      if (updated !== undefined) statusAfter = updated.status;
    }

    const stored: StoredDecisionRecord = {
      ...decision,
      runId,
      taskStatusBefore: statusBefore,
      taskStatusAfter: statusAfter,
      attempts,
    };
    this.repos.auditLog.record({
      actor: SCHEDULER_ACTOR,
      action: 'scheduler_decision',
      entity_type: 'task',
      entity_id: task.id,
      detail: stored,
    });
    if (blocking.blocked && !terminal) {
      const record: BlockedReportDetail = {
        decisionId: decision.decisionId,
        taskId: task.id,
        causes: blocking.causes,
        plan,
        taskStatusBefore: statusBefore,
        taskStatusAfter: statusAfter,
        retryAt: plan.find((s) => s.action === 'requeue_with_backoff')?.retryAt ?? null,
      };
      this.repos.auditLog.record({
        actor: SCHEDULER_ACTOR,
        action: 'scheduler_blocked',
        entity_type: 'task',
        entity_id: task.id,
        detail: record,
      });
    }
    return runId === undefined ? decision : { ...decision, runId };
  }

  // ---------- 无人值守 tick ----------

  tick(options: { limit?: number } = {}): TickSummary {
    const settings = this.settings();
    const unattended = settings.unattended;
    const summary: TickSummary = {
      mode: unattended ? 'unattended' : 'attended',
      scanned: 0,
      newlyBlocked: [],
      requeued: [],
      dispatched: [],
      resourceBlocked: [],
      skipped: [],
      dispatchOrder: [],
    };

    // 1) 依赖阻塞识别与标记（两种模式都执行；标记结果进审计，便于看板与追溯）。
    const tasks = this.repos.tasks.list();
    summary.scanned = tasks.length;
    const byId = new Map<string, Task>(tasks.map((t) => [t.id, t]));
    const edges = this.repos.taskDependencies.listAll();
    const depsByTask = new Map<string, string[]>();
    for (const edge of edges) {
      const list = depsByTask.get(edge.task_id) ?? [];
      list.push(edge.depends_on_task_id);
      depsByTask.set(edge.task_id, list);
    }
    for (const task of tasks) {
      if (task.status !== 'todo') continue;
      const deps = (depsByTask.get(task.id) ?? []).flatMap((depId) => {
        const dep = byId.get(depId);
        return dep !== undefined
          ? [{ taskId: dep.id, title: dep.title, status: dep.status } satisfies DependencySnapshot]
          : [];
      });
      const unmet = deps.filter((d) => d.status !== 'done');
      if (unmet.length === 0) continue;
      const blocking = detectBlocking({ task: { id: task.id, status: task.status }, dependencies: deps });
      const plan = planNextSteps({
        task: { id: task.id, title: task.title },
        blocking,
        attempts: this.priorAttempts(task.id),
        maxAttempts: this.maxAttempts,
        unattended,
        now: this.now().toISOString(),
      });
      assertTaskTransition(task.status, 'blocked');
      const updated = this.repos.tasks.update(task.id, { status: 'blocked' });
      if (updated !== undefined) byId.set(task.id, updated);
      const record: BlockedReportDetail = {
        decisionId: null,
        taskId: task.id,
        causes: blocking.causes,
        plan,
        taskStatusBefore: 'todo',
        taskStatusAfter: 'blocked',
        retryAt: null,
      };
      this.repos.auditLog.record({
        actor: SCHEDULER_ACTOR,
        action: 'scheduler_blocked',
        entity_type: 'task',
        entity_id: task.id,
        detail: record,
      });
      summary.newlyBlocked.push({ taskId: task.id, causes: blocking.causes, plan });
    }

    // 2) 阻塞恢复（仅无人值守）：依赖完成或到达退避时刻 → 回队；升级/人工标记 → 跳过。
    if (unattended) {
      const blockedTasks = this.repos.tasks.list({ status: 'blocked' });
      for (const task of blockedTasks) {
        const report = this.latestBlockedReport(task.id);
        if (report === undefined) {
          summary.skipped.push({
            taskId: task.id,
            reason: 'blocked 但无调度器阻塞记录（视为人工标记），等待人工处理',
          });
          continue;
        }
        if (report.causes.some((c) => c.code === 'manually_blocked')) {
          summary.skipped.push({ taskId: task.id, reason: '人工标记阻塞，等待人工处理' });
          continue;
        }
        const depsDone = this.repos.taskDependencies
          .listByTask(task.id)
          .every((edge) => this.repos.tasks.getById(edge.depends_on_task_id)?.status === 'done');
        if (!depsDone) {
          summary.skipped.push({ taskId: task.id, reason: '依赖任务未完成，继续等待' });
          continue;
        }
        const escalate = report.plan.some((s) => s.action === 'escalate_human');
        const requeue = report.plan.find((s) => s.action === 'requeue_with_backoff');
        if (escalate && requeue === undefined) {
          summary.skipped.push({ taskId: task.id, reason: '自动处理已升级为人工介入，不再自动重试' });
          continue;
        }
        if (
          requeue?.retryAt !== undefined &&
          this.now().getTime() < Date.parse(requeue.retryAt)
        ) {
          summary.skipped.push({ taskId: task.id, reason: `未到自动重试时间（${requeue.retryAt}）` });
          continue;
        }
        assertTaskTransition('blocked', 'todo');
        this.repos.tasks.update(task.id, { status: 'todo' });
        summary.requeued.push({
          taskId: task.id,
          reason: report.causes.some((c) => c.code === 'dependency_unmet')
            ? '依赖已完成，自动回队'
            : '到达重试时间，自动回队',
        });
      }
    }

    // 3) 全局派发（仅无人值守）：todo 队列按跨项目协同优先级取前 N 个逐个决策。
    if (unattended) {
      const fresh = this.repos.tasks.list();
      const snapshots: QueueTaskSnapshot[] = fresh.map((t) => ({
        taskId: t.id,
        projectId: t.project_id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        dependsOn: depsByTask.get(t.id) ?? [],
      }));
      const order = computeDispatchOrder(snapshots, settings.projectPriorities);
      const limit = options.limit ?? DEFAULT_TICK_LIMIT;
      for (const entry of order.slice(0, limit)) {
        summary.dispatchOrder.push(entry.taskId);
        const decision = this.decide(entry.taskId);
        if (decision.runId !== undefined && decision.selected !== null) {
          summary.dispatched.push({
            taskId: entry.taskId,
            decisionId: decision.decisionId,
            runId: decision.runId,
            gatewayId: decision.selected.gatewayId,
            modelId: decision.selected.modelId,
          });
        } else if (decision.blocked) {
          summary.resourceBlocked.push({ taskId: entry.taskId, decisionId: decision.decisionId });
        } else {
          summary.skipped.push({
            taskId: entry.taskId,
            reason: '调度成功但未派发（任务状态不允许或已有未完成的 run）',
          });
        }
      }
    }

    return summary;
  }

  // ---------- 查询 ----------

  /** 按条件列出历史调度决策（来自 audit_log，seq 降序）。 */
  listDecisions(
    filter: { taskId?: string; projectId?: string; gatewayId?: string; limit?: number } = {},
  ): DecisionListItem[] {
    const rows = this.repos.auditLog.list({
      action: 'scheduler_decision',
      ...(filter.taskId !== undefined ? { entity_id: filter.taskId } : {}),
      limit: AUDIT_SCAN_LIMIT,
    });
    const limit = filter.limit ?? DEFAULT_DECISIONS_LIMIT;
    const items: DecisionListItem[] = [];
    for (const row of rows) {
      const decision = parseDecisionDetail(row);
      if (filter.projectId !== undefined && decision.projectId !== filter.projectId) continue;
      if (
        filter.gatewayId !== undefined &&
        decision.selected?.gatewayId !== filter.gatewayId &&
        !decision.fallbacks.some((f) => f.gatewayId === filter.gatewayId)
      ) {
        continue;
      }
      items.push({ seq: row.seq, createdAt: row.created_at, decision });
      if (items.length >= limit) break;
    }
    return items;
  }

  /** 按 decisionId 取单条决策（NotFound 时抛业务错误，由路由映射 404）。 */
  getDecisionById(decisionId: string): StoredDecisionRecord {
    const rows = this.repos.auditLog.list({ action: 'scheduler_decision', limit: AUDIT_SCAN_LIMIT });
    for (const row of rows) {
      const decision = parseDecisionDetail(row);
      if (decision.decisionId === decisionId) return decision;
    }
    throw new NotFoundError('scheduler_decisions', decisionId);
  }

  /** 当前 blocked 任务清单（附最近一次阻塞原因与下一步安排）。 */
  listBlocked(): BlockedTaskRecord[] {
    return this.repos.tasks.list({ status: 'blocked' }).map((task) => {
      const report = this.latestBlockedReport(task.id);
      return {
        taskId: task.id,
        title: task.title,
        projectId: task.project_id,
        status: task.status,
        updatedAt: task.updated_at,
        causes:
          report?.causes ??
          [{ code: 'manually_blocked', message: '无调度器阻塞记录（可能为人工标记或历史数据）' }],
        plan: report?.plan ?? [],
      };
    });
  }

  /** 全局派发顺序预览（不落库、不产生决策）。 */
  dispatchOrderPreview(limit = 20): DispatchOrderEntry[] {
    const settings = this.settings();
    const tasks = this.repos.tasks.list();
    const edges = this.repos.taskDependencies.listAll();
    const depsByTask = new Map<string, string[]>();
    for (const edge of edges) {
      const list = depsByTask.get(edge.task_id) ?? [];
      list.push(edge.depends_on_task_id);
      depsByTask.set(edge.task_id, list);
    }
    const snapshots: QueueTaskSnapshot[] = tasks.map((t) => ({
      taskId: t.id,
      projectId: t.project_id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dependsOn: depsByTask.get(t.id) ?? [],
    }));
    // 与 tick 语义一致：依赖未完成的 todo 任务不具备派发资格，只作上游信息参与协同加成
    const statusById = new Map<string, TaskStatus>(tasks.map((t) => [t.id, t.status]));
    const dispatchableIds = new Set(
      tasks
        .filter(
          (t) =>
            t.status === 'todo' &&
            (depsByTask.get(t.id) ?? []).every((depId) => statusById.get(depId) === 'done'),
        )
        .map((t) => t.id),
    );
    return computeDispatchOrder(snapshots, settings.projectPriorities)
      .filter((entry) => dispatchableIds.has(entry.taskId))
      .slice(0, limit);
  }

  // ---------- 内部 ----------

  private priorAttempts(taskId: string): number {
    return this.repos.auditLog.list({ action: 'scheduler_decision', entity_id: taskId }).length;
  }

  private hasPendingRun(taskId: string): boolean {
    return this.repos.runs
      .list({ task_id: taskId })
      .some((r) => r.status === 'queued' || r.status === 'running');
  }

  private dependencySnapshots(taskId: string): DependencySnapshot[] {
    return this.repos.taskDependencies.listByTask(taskId).flatMap((edge) => {
      const dep = this.repos.tasks.getById(edge.depends_on_task_id);
      return dep !== undefined ? [{ taskId: dep.id, title: dep.title, status: dep.status }] : [];
    });
  }

  /** 最近一次 scheduler_blocked 审计记录（seq 降序取第一条）。 */
  private latestBlockedReport(taskId: string): { causes: BlockingCause[]; plan: NextStep[] } | undefined {
    const rows = this.repos.auditLog.list({
      action: 'scheduler_blocked',
      entity_id: taskId,
      limit: 1,
    });
    const row = rows[0];
    if (row === undefined) return undefined;
    let detail: unknown;
    try {
      detail = JSON.parse(row.detail) as unknown;
    } catch (error) {
      throw new ValidationError(`audit_log seq=${row.seq} 的 detail 不是合法 JSON：${String(error)}`);
    }
    if (typeof detail !== 'object' || detail === null) {
      throw new ValidationError(`audit_log seq=${row.seq} 的 scheduler_blocked 记录格式不正确`);
    }
    const record = detail as Partial<BlockedReportDetail>;
    return { causes: record.causes ?? [], plan: record.plan ?? [] };
  }
}

function parseDecisionDetail(row: AuditLogEntry): StoredDecisionRecord {
  let detail: unknown;
  try {
    detail = JSON.parse(row.detail) as unknown;
  } catch (error) {
    throw new ValidationError(`audit_log seq=${row.seq} 的 detail 不是合法 JSON：${String(error)}`);
  }
  if (
    typeof detail !== 'object' ||
    detail === null ||
    typeof (detail as { decisionId?: unknown }).decisionId !== 'string' ||
    typeof (detail as { taskId?: unknown }).taskId !== 'string'
  ) {
    throw new ValidationError(`audit_log seq=${row.seq} 的 scheduler_decision 记录格式不正确`);
  }
  return detail as StoredDecisionRecord;
}

/** settings 键名再导出，方便调用方写入优先级与目录快照。 */
export { SCHEDULER_SETTINGS_KEYS };
