/**
 * 执行平面服务：派发、状态跟踪、结果/事件落库、重试队列与阻塞标记、无人值守处理。
 *
 * 边界声明（验收标准 4）：
 * - 本服务把已授权任务打包为 grok_workflow 任务包并交给执行端（Executor），
 *   之后只做：跟踪 promise/超时 → 落 run 状态与事件 → 失败/超时进入重试队列
 *   或阻塞标记 → 反馈调度器；
 * - 规划 → 执行 → 验证 → 有界重试 → 汇总全部发生在 Grok Workflow（执行端进程）内部，
 *   本模块不实现其中的任何环节；这里的 run 级重试是队列管理（为失败任务重派一份
 *   新 run），与工作流内部对子任务的验证/重试是两层机制；
 * - 事件与审计统一落 runs/run_events/audit_log，复用既有表结构，不改表。
 *
 * 状态机（runs 表既有取值）：queued → running → succeeded | failed | cancelled。
 * failed（含超时）在尝试额度内产生新的 queued run（重试队列）；
 * 超出额度把 tasks.status 置为 blocked（阻塞标记）并写审计。
 */
import { NotFoundError, ValidationError } from '../db/errors.js';
import type { Repositories } from '../db/repositories/index.js';
import type { RunFilter } from '../db/repositories/runtime-repos.js';
import type { SqlDb } from '../db/sqlite.js';
import { withTransaction } from '../db/sqlite.js';
import type { Run, RunEventLevel, RunStatus, Task } from '../types/entities.js';
import type { Executor } from './types.js';
import { packTaskPackage, renderObjective, type PackOverrides } from './pack.js';
import { mapReportStatusToRunStatus, parseWorkflowReport, redactReport } from './report.js';
import type { ParsedReport, TerminalRunStatus } from './types.js';
import type {
  DispatchInput,
  DispatchMeta,
  DispatchResult,
  ExecEventInput,
  ExecExecution,
  ExecFeedback,
  ExecHandle,
  ExecRawResult,
  ExecRunView,
  ProcessQueueResult,
  QueueSnapshot,
  TaskPackage,
} from './types.js';
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_QUEUE_BATCH_LIMIT, DEFAULT_RUN_TIMEOUT_MS } from './types.js';

const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];
const RUN_STATUSES: readonly string[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];

export interface ExecServiceOptions {
  db: SqlDb;
  repos: Repositories;
  /** 可用执行端（至少一个）；缺省取第一个为默认执行端。 */
  executors: Executor[];
  defaultExecutorId?: string;
  /** 单次运行超时（毫秒）。 */
  timeoutMs?: number;
  /** 同一任务的最大派发次数（含首次）；超出后标记阻塞。 */
  maxAttempts?: number;
  /** 无人值守单轮处理的批量上限。 */
  queueBatchLimit?: number;
  /** audit_log actor，缺省 'exec'。 */
  actor?: string;
  /** 调度器反馈钩子（run_finished / retry_scheduled / task_blocked / run_cancelled）。 */
  onFeedback?: (feedback: ExecFeedback) => void;
}

/** run_summary 事件载荷（终态摘要）。 */
interface RunSummaryPayload {
  status?: string;
  error?: string | null;
  duration_ms?: number | null;
  timed_out?: boolean;
  report?: ParsedReport | null;
}

export class ExecService {
  private readonly db: SqlDb;
  private readonly repos: Repositories;
  private readonly executors: Map<string, Executor>;
  private readonly defaultExecutorId: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly queueBatchLimit: number;
  private readonly actor: string;
  private readonly onFeedback: ((feedback: ExecFeedback) => void) | null;
  /** 活动中的执行句柄（runId → handle）；也是孤儿检测与重复派发的依据。 */
  private readonly active = new Map<string, { handle: ExecHandle; attempt: number }>();

  constructor(options: ExecServiceOptions) {
    this.db = options.db;
    this.repos = options.repos;
    this.executors = new Map(options.executors.map((executor) => [executor.id, executor]));
    this.defaultExecutorId = options.defaultExecutorId ?? options.executors[0]?.id;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.queueBatchLimit = options.queueBatchLimit ?? DEFAULT_QUEUE_BATCH_LIMIT;
    this.actor = options.actor ?? 'exec';
    this.onFeedback = options.onFeedback ?? null;
    if (this.executors.size === 0) {
      throw new ValidationError('ExecService requires at least one executor');
    }
    for (const value of [this.timeoutMs]) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new ValidationError(`timeoutMs must be a positive integer (got ${String(value)})`);
      }
    }
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new ValidationError(`maxAttempts must be a positive integer (got ${String(this.maxAttempts)})`);
    }
  }

  // ---------- 派发 ----------

  /**
   * 把已授权任务派发给执行端。task_id（新建 run）或 run_id（复用 queued run）二选一；
   * await_completion=false 时立即返回，运行由无人值守流程继续跟踪。
   */
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    if (input.task_id === undefined && input.run_id === undefined) {
      throw new ValidationError('dispatch requires task_id or run_id');
    }
    let run: Run;
    let task: Task;
    let attempt: number;
    if (input.run_id !== undefined) {
      const existing = this.repos.runs.getById(input.run_id);
      if (!existing) throw new NotFoundError('runs', input.run_id);
      run = existing;
      if (run.status !== 'queued') {
        throw new ValidationError(`run '${run.id}' must be queued to dispatch (current: ${run.status})`);
      }
      const taskForRun = run.task_id === null ? undefined : this.repos.tasks.getById(run.task_id);
      if (!taskForRun) throw new NotFoundError('tasks', run.task_id ?? '');
      task = taskForRun;
      if (input.task_id !== undefined && input.task_id !== task.id) {
        throw new ValidationError(`run '${run.id}' belongs to task '${task.id}', not '${input.task_id}'`);
      }
      attempt = this.runAttempt(run);
    } else {
      const taskId = input.task_id as string;
      const found = this.repos.tasks.getById(taskId);
      if (!found) throw new NotFoundError('tasks', taskId);
      task = found;
      const agentId = input.agent_id ?? null;
      if (agentId !== null && !this.repos.agents.getById(agentId)) {
        throw new NotFoundError('agents', agentId);
      }
      attempt = this.repos.runs.count({ task_id: task.id }) + 1;
      run = this.repos.runs.create({
        project_id: input.project_id ?? task.project_id,
        task_id: task.id,
        agent_id: agentId,
        status: 'queued',
      });
    }

    const executor = this.resolveExecutor(input.executor);
    const timeoutMs = input.timeout_ms ?? this.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new ValidationError(`timeout_ms must be a positive integer (got ${String(input.timeout_ms)})`);
    }
    const model = input.model ?? null;
    const gateway = input.gateway ?? null;
    const overrides: PackOverrides = {
      objective: input.objective,
      expected_output: input.expected_output,
      acceptance_criteria: input.acceptance_criteria,
      constraints: input.constraints,
      writes_paths: input.writes_paths,
      context: input.context,
    };
    const taskPackage = packTaskPackage({
      task,
      subtasks: this.repos.subtasks.list({ task_id: task.id }),
      runId: run.id,
      attempt,
      model,
      gateway,
      overrides,
    });
    const objective = renderObjective(taskPackage);

    this.appendEvent(run.id, 'dispatch', {
      executor: executor.id,
      model,
      gateway,
      attempt,
      timeout_ms: timeoutMs,
      objective_chars: objective.length,
    });
    this.recordAudit('dispatch', 'run', run.id, {
      task_id: task.id,
      attempt,
      executor: executor.id,
      model,
      gateway,
    });
    const started = this.repos.runs.start(run.id);

    if (input.await_completion === false) {
      void this.executeRun({ run: started, task, attempt, taskPackage, executor, timeoutMs, model, gateway }).catch(
        (error: unknown) => {
          console.error('[exec] background run failed to finalize:', error);
        },
      );
      return {
        run_id: run.id,
        status: started.status,
        attempt,
        report: null,
        error: null,
        timed_out: false,
        duration_ms: null,
      };
    }
    return this.executeRun({ run: started, task, attempt, taskPackage, executor, timeoutMs, model, gateway });
  }

  // ---------- 无人值守处理 ----------

  /**
   * 无人值守一轮：
   * - 孤儿 run（running 但无活动句柄，如进程重启遗留）按失败收场并走重试/阻塞路径；
   * - queued run（含重试队列里的新 run）按序派发执行；
   * 单轮最多处理 limit 条 queued（重试产生的新 run 留给下一轮）。
   */
  async processQueue(options: { limit?: number } = {}): Promise<ProcessQueueResult> {
    const limit = options.limit ?? this.queueBatchLimit;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ValidationError(`limit must be a positive integer (got ${String(options.limit)})`);
    }
    const unfinished = this.repos.runs.listUnfinished();
    const orphans: DispatchResult[] = [];
    for (const run of unfinished) {
      if (run.status === 'running' && !this.active.has(run.id)) {
        orphans.push(this.finalizeOrphan(run));
      }
    }
    // 孤儿收场会为失败任务产生新的重试 run，因此重新读取队列再按限额处理。
    const queued = this.repos.runs
      .listUnfinished()
      .filter((item) => item.status === 'queued')
      .slice(0, limit);
    const runs: DispatchResult[] = [];
    const skipped: Array<{ run_id: string; error: string }> = [];
    for (const run of queued) {
      try {
        runs.push(await this.dispatch({ run_id: run.id, await_completion: true }));
      } catch (error) {
        skipped.push({ run_id: run.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { runs, orphans, skipped };
  }

  /** 队列快照：无人值守/监控用。 */
  queueSnapshot(): QueueSnapshot {
    const unfinished = this.repos.runs.listUnfinished();
    return {
      queued: unfinished.filter((run) => run.status === 'queued').length,
      running: unfinished.filter((run) => run.status === 'running').length,
      active_run_ids: [...this.active.keys()],
      orphaned_run_ids: unfinished
        .filter((run) => run.status === 'running' && !this.active.has(run.id))
        .map((run) => run.id),
    };
  }

  // ---------- 取消 ----------

  /** 取消 queued/running run。终态 run 拒绝取消。 */
  async cancel(runId: string, reason?: string): Promise<{ run_id: string; status: RunStatus }> {
    const run = this.repos.runs.getById(runId);
    if (!run) throw new NotFoundError('runs', runId);
    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      throw new ValidationError(`run '${runId}' already finished (${run.status})`);
    }
    const cancelReason = `cancelled: ${reason ?? 'cancelled by operator'}`;
    const active = this.active.get(runId);
    if (active) {
      // 跟踪循环负责收尾（cancelled）。
      active.handle.cancel(cancelReason);
      this.appendEvent(runId, 'cancel_requested', { reason: reason ?? null }, 'warn');
      this.recordAudit('cancel_requested', 'run', runId, { reason: reason ?? null });
      return { run_id: runId, status: run.status };
    }
    if (run.status === 'running') {
      // running 但无活动句柄：执行端已失联，直接按取消收场（幂等：与跟踪循环竞态时已终态则直接返回）。
      const fresh = this.repos.runs.getById(runId) ?? run;
      if (TERMINAL_RUN_STATUSES.includes(fresh.status)) {
        return { run_id: runId, status: fresh.status };
      }
      this.finalizeNow({
        run,
        status: 'cancelled',
        error: `${cancelReason} (no active executor handle)`,
        durationMs: null,
        timedOut: false,
        report: null,
      });
      return { run_id: runId, status: 'cancelled' };
    }
    this.finalizeNow({
      run,
      status: 'cancelled',
      error: cancelReason,
      durationMs: null,
      timedOut: false,
      report: null,
    });
    return { run_id: runId, status: 'cancelled' };
  }

  // ---------- 查询 ----------

  /** 完整 run 记录：任务、模型/网关（派发事件）、状态、结果报告、耗时、事件流。 */
  getRunView(
    runId: string,
    options: { includeEvents?: boolean; eventLimit?: number } = {},
  ): ExecRunView {
    const run = this.repos.runs.getById(runId);
    if (!run) throw new NotFoundError('runs', runId);
    const meta = this.runMeta(run);
    const durationMs = meta.summary?.duration_ms ?? diffMs(run.started_at, run.finished_at);
    const events =
      options.includeEvents === false
        ? []
        : this.repos.runEvents.listByRun(runId, { limit: options.eventLimit ?? 200 });
    const task = run.task_id === null ? undefined : this.repos.tasks.getById(run.task_id);
    const agent = run.agent_id === null ? undefined : this.repos.agents.getById(run.agent_id);
    return {
      run: { ...run, duration_ms: durationMs },
      task: task ? { id: task.id, title: task.title, status: task.status, priority: task.priority } : null,
      agent: agent ? { id: agent.id, name: agent.name } : null,
      dispatch: meta.dispatch,
      result: {
        status: run.status,
        error: run.error,
        duration_ms: durationMs,
        timed_out: meta.summary?.timed_out ?? false,
        report: meta.summary?.report ?? null,
      },
      events,
    };
  }

  listRuns(filter: { task_id?: string; project_id?: string; agent_id?: string; status?: string; limit?: number; offset?: number } = {}): {
    runs: Run[];
    count: number;
  } {
    const repoFilter: RunFilter = {};
    if (filter.task_id !== undefined) repoFilter.task_id = filter.task_id;
    if (filter.project_id !== undefined) repoFilter.project_id = filter.project_id;
    if (filter.agent_id !== undefined) repoFilter.agent_id = filter.agent_id;
    if (filter.status !== undefined) {
      if (!RUN_STATUSES.includes(filter.status)) {
        throw new ValidationError(`unknown run status '${filter.status}'`);
      }
      repoFilter.status = filter.status as RunStatus;
    }
    const limit = filter.limit ?? 50;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ValidationError(`limit must be a positive integer (got ${String(filter.limit)})`);
    }
    repoFilter.limit = limit;
    if (filter.offset !== undefined) repoFilter.offset = filter.offset;
    const countFilter: RunFilter = { ...repoFilter };
    delete countFilter.limit;
    delete countFilter.offset;
    return { runs: this.repos.runs.list(repoFilter), count: this.repos.runs.count(countFilter) };
  }

  listRunEvents(runId: string, options: { after_seq?: number; limit?: number } = {}): {
    run_id: string;
    events: ReturnType<Repositories['runEvents']['listByRun']>;
  } {
    if (!this.repos.runs.getById(runId)) throw new NotFoundError('runs', runId);
    return {
      run_id: runId,
      events: this.repos.runEvents.listByRun(runId, {
        afterSeq: options.after_seq,
        limit: options.limit,
      }),
    };
  }

  listAudit(filter: { actor?: string; action?: string; entity_type?: string; entity_id?: string; limit?: number } = {}) {
    return {
      audit: this.repos.auditLog.list({
        actor: filter.actor,
        action: filter.action,
        entity_type: filter.entity_type,
        entity_id: filter.entity_id,
        limit: filter.limit,
      }),
    };
  }

  // ---------- 内部：执行跟踪 ----------

  private async executeRun(ctx: {
    run: Run;
    task: Task;
    attempt: number;
    taskPackage: TaskPackage;
    executor: Executor;
    timeoutMs: number;
    model: string | null;
    gateway: string | null;
  }): Promise<DispatchResult> {
    const { run } = ctx;
    const startedAtMs = Date.now();
    const execution: ExecExecution = {
      runId: run.id,
      attempt: ctx.attempt,
      taskPackage: ctx.taskPackage,
      model: ctx.model,
      gateway: ctx.gateway,
      onEvent: (event) => this.appendExecutorEvent(run.id, event),
    };

    let handle: ExecHandle;
    try {
      handle = ctx.executor.start(execution);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startedAtMs;
      const failError = `executor failed to start: ${message}`;
      this.finalizeNow({ run, status: 'failed', error: failError, durationMs, timedOut: false, report: null });
      return {
        run_id: run.id,
        status: 'failed',
        attempt: ctx.attempt,
        report: null,
        error: failError,
        timed_out: false,
        duration_ms: durationMs,
      };
    }

    this.active.set(run.id, { handle, attempt: ctx.attempt });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      handle.cancel(`timeout after ${ctx.timeoutMs}ms`);
    }, ctx.timeoutMs);
    timer.unref?.();

    let raw: ExecRawResult;
    try {
      raw = await handle.promise;
    } finally {
      clearTimeout(timer);
      this.active.delete(run.id);
    }

    const parsed = raw.report ? parseWorkflowReport(raw.report) : null;
    const report = parsed !== null && parsed.status !== undefined ? redactReport(parsed) : null;
    const rawError = raw.error ?? null;
    let status: TerminalRunStatus;
    let error: string | null;
    if (timedOut) {
      status = 'failed';
      error =
        rawError !== null && !rawError.startsWith('cancelled')
          ? `run timed out after ${ctx.timeoutMs}ms: ${rawError}`
          : `run timed out after ${ctx.timeoutMs}ms`;
    } else if (rawError !== null && rawError.startsWith('cancelled')) {
      status = 'cancelled';
      error = rawError;
    } else if (parsed !== null && parsed.status !== undefined) {
      status = mapReportStatusToRunStatus(parsed.status);
      error =
        status === 'failed' ? (rawError ?? `grok workflow reported status '${parsed.status}'`) : null;
      if (status === 'succeeded' && rawError !== null) {
        this.appendEvent(run.id, 'exec.warning', { raw_error: rawError }, 'warn');
      }
    } else {
      status = 'failed';
      error = rawError ?? 'executor returned no parsable report';
      if (raw.raw !== undefined && raw.raw !== null) {
        this.appendEvent(run.id, 'exec.raw_output', { output: truncateText(raw.raw, 8000) }, 'warn');
      }
    }
    const durationMs = Date.now() - startedAtMs;
    this.finalizeNow({ run, status, error, durationMs, timedOut, report });
    return { run_id: run.id, status, attempt: ctx.attempt, report, error, timed_out: timedOut, duration_ms: durationMs };
  }

  /** 终态落库（runs + run_events + audit_log 单事务），失败时继续走重试/阻塞。 */
  private finalizeNow(params: {
    run: Run;
    status: TerminalRunStatus;
    error: string | null;
    durationMs: number | null;
    timedOut: boolean;
    report: ParsedReport | null;
  }): void {
    const runId = params.run.id;
    withTransaction(this.db, () => {
      this.repos.runs.finish(runId, { status: params.status, error: params.error ?? undefined });
      this.appendEvent(
        runId,
        'run_summary',
        {
          status: params.status,
          error: params.error,
          duration_ms: params.durationMs,
          timed_out: params.timedOut,
          report: params.report,
        },
        params.status === 'failed' ? 'error' : 'info',
      );
      this.recordAudit('run_finished', 'run', runId, {
        task_id: params.run.task_id,
        status: params.status,
        error: params.error,
        duration_ms: params.durationMs,
        timed_out: params.timedOut,
      });
    });
    const attempt = this.runAttempt(params.run);
    if (params.status === 'failed' && params.run.task_id !== null) {
      this.handleFailureAftermath(params.run, params.run.task_id, attempt, params.error);
      return;
    }
    if (params.run.task_id !== null) {
      this.emitFeedback({
        kind: params.status === 'cancelled' ? 'run_cancelled' : 'run_finished',
        run_id: runId,
        task_id: params.run.task_id,
        attempt,
        status: params.status,
        error: params.error,
      });
    }
  }

  /**
   * 失败（含超时）后的队列管理：额度内重试入队（新 queued run），额度用尽
   * 把任务标记 blocked。这是 Workmesh 的重派队列，不是 Grok Workflow 的
   * 工作流内部重试。
   */
  private handleFailureAftermath(run: Run, taskId: string, attempt: number, error: string | null): void {
    const task = this.repos.tasks.getById(taskId);
    if (!task) return; // 任务已删除：仅保留 run 级失败记录
    if (attempt < this.maxAttempts) {
      const retry = this.repos.runs.create({
        project_id: run.project_id,
        task_id: taskId,
        agent_id: run.agent_id,
        status: 'queued',
      });
      this.appendEvent(
        run.id,
        'retry_scheduled',
        { next_run_id: retry.id, next_attempt: attempt + 1, max_attempts: this.maxAttempts, reason: error ?? 'failed' },
        'warn',
      );
      this.recordAudit('retry_scheduled', 'run', retry.id, {
        from_run_id: run.id,
        task_id: taskId,
        attempt: attempt + 1,
        reason: error ?? 'failed',
      });
      this.emitFeedback({
        kind: 'retry_scheduled',
        run_id: retry.id,
        task_id: taskId,
        attempt: attempt + 1,
        status: 'queued',
        error,
        next_run_id: retry.id,
      });
      return;
    }
    this.repos.tasks.update(taskId, { status: 'blocked' });
    this.appendEvent(
      run.id,
      'task_blocked',
      { reason: error ?? 'failed', attempts: attempt, max_attempts: this.maxAttempts },
      'warn',
    );
    this.recordAudit('task_blocked', 'task', taskId, {
      run_id: run.id,
      attempts: attempt,
      reason: error ?? 'failed',
    });
    this.emitFeedback({ kind: 'task_blocked', run_id: run.id, task_id: taskId, attempt, error });
  }

  /** 孤儿 run 收场：failed + 事件 + 审计 + 重试/阻塞路径。 */
  private finalizeOrphan(run: Run): DispatchResult {
    const attempt = this.runAttempt(run);
    const error = 'orphaned: run was running without an active executor handle (likely process restart)';
    withTransaction(this.db, () => {
      this.repos.runs.finish(run.id, { status: 'failed', error });
      this.appendEvent(run.id, 'orphan_detected', { reason: error, attempt }, 'warn');
      this.recordAudit('orphan_detected', 'run', run.id, { task_id: run.task_id, attempt });
    });
    if (run.task_id !== null) {
      this.handleFailureAftermath(run, run.task_id, attempt, error);
    }
    return { run_id: run.id, status: 'failed', attempt, report: null, error, timed_out: false, duration_ms: null };
  }

  // ---------- 内部：辅助 ----------

  private resolveExecutor(id: string | undefined): Executor {
    const wanted = id ?? this.defaultExecutorId;
    const executor = wanted === undefined ? undefined : this.executors.get(wanted);
    if (!executor) {
      const available = [...this.executors.keys()].join(', ');
      throw new ValidationError(`unknown executor '${wanted ?? ''}' (available: ${available})`);
    }
    return executor;
  }

  private appendEvent(runId: string, type: string, payload: unknown, level: RunEventLevel = 'info'): void {
    this.repos.runEvents.append({ run_id: runId, level, type, payload });
  }

  private appendExecutorEvent(runId: string, event: ExecEventInput): void {
    const type = event.type.startsWith('exec.') ? event.type : `exec.${event.type}`;
    this.appendEvent(runId, type, event.payload ?? {}, event.level ?? 'info');
  }

  private recordAudit(action: string, entityType: string, entityId: string, detail: unknown): void {
    this.repos.auditLog.record({ actor: this.actor, action, entity_type: entityType, entity_id: entityId, detail });
  }

  private emitFeedback(feedback: ExecFeedback): void {
    if (this.onFeedback === null) return;
    try {
      this.onFeedback(feedback);
    } catch (error) {
      console.error('[exec] feedback observer failed:', error);
    }
  }

  /** run 的尝试序号：优先取 dispatch 事件里的 attempt，否则按任务 run 计数。 */
  private runAttempt(run: Run): number {
    const events = this.repos.runEvents.listByRun(run.id, { limit: 500 });
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (!event || event.type !== 'dispatch') continue;
      const payload = parseJsonObject(event.payload);
      const attempt = payload === null ? undefined : payload['attempt'];
      if (typeof attempt === 'number') return attempt;
    }
    return run.task_id === null ? 1 : this.repos.runs.count({ task_id: run.task_id });
  }

  private runMeta(run: Run): { dispatch: DispatchMeta | null; summary: RunSummaryPayload | null } {
    const events = this.repos.runEvents.listByRun(run.id, { limit: 500 });
    let dispatch: DispatchMeta | null = null;
    let summary: RunSummaryPayload | null = null;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (!event) continue;
      if (dispatch === null && event.type === 'dispatch') {
        const payload = parseJsonObject(event.payload);
        if (payload !== null) {
          dispatch = {
            executor: typeof payload['executor'] === 'string' ? payload['executor'] : 'unknown',
            model: typeof payload['model'] === 'string' ? payload['model'] : null,
            gateway: typeof payload['gateway'] === 'string' ? payload['gateway'] : null,
            attempt: typeof payload['attempt'] === 'number' ? payload['attempt'] : 1,
            timeout_ms: typeof payload['timeout_ms'] === 'number' ? payload['timeout_ms'] : null,
            objective_chars: typeof payload['objective_chars'] === 'number' ? payload['objective_chars'] : null,
          };
        }
      }
      if (summary === null && event.type === 'run_summary') {
        const payload = parseJsonObject(event.payload);
        if (payload !== null) summary = payload as RunSummaryPayload;
      }
      if (dispatch !== null && summary !== null) break;
    }
    return { dispatch, summary };
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function diffMs(startedAt: string | null, finishedAt: string | null): number | null {
  if (startedAt === null || finishedAt === null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}
