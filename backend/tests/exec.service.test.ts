/**
 * exec 模块服务级集成测试（内存库 + MockExecutor）。
 * 覆盖：任务包生成、报告解析/脱敏、派发成功/失败/超时、重试队列、阻塞标记、
 * 无人值守处理（含孤儿恢复）、事件流、取消、反馈钩子与输入校验。
 */
import { describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../src/db/errors.js';
import {
  ExecService,
  MockExecutor,
  extractJsonReport,
  mapReportStatusToRunStatus,
  packTaskPackage,
  parseWorkflowReport,
  redactText,
  renderObjective,
} from '../src/exec/index.js';
import { GROK_OBJECTIVE_MAX_CHARS } from '../src/exec/types.js';
import { seedTaskTree, setupExecService, waitFor, type ExecTestHandle } from './exec.helpers.js';

const COMPLETED_REPORT = {
  summary: '全部完成',
  status: 'completed' as const,
  deliverables: [{ description: '实现文件', locator: 'backend/src/exec/service.ts' }],
  evidence: [{ claim: '测试通过', source: 'vitest run' }],
  testsRun: [{ command: 'vitest run', status: 'passed' as const, detail: '72 passed' }],
  filesChanged: ['backend/src/exec/service.ts'],
  uncertainties: [],
};

describe('packTaskPackage / renderObjective（任务打包，纯函数）', () => {
  it('从任务与子项确定性生成任务包，上下文含 workmesh 元数据', () => {
    const { repos, seed } = setupExecService();
    const pkg = packTaskPackage({
      task: seed.task,
      subtasks: repos.subtasks.list({ task_id: seed.task.id }),
      runId: 'run-1',
      attempt: 2,
      model: 'model-a',
      gateway: 'gw-a',
    });
    expect(pkg.objective).toContain(seed.task.title);
    expect(pkg.objective).toContain('派发给 Grok Workflow');
    expect(pkg.acceptanceCriteria).toEqual(['子项一：任务包生成', '子项二：事件落库']);
    expect(pkg.source).toEqual({ runId: 'run-1', taskId: seed.task.id, projectId: seed.project.id, attempt: 2 });
    expect(pkg.context).toContain('workmesh.run_id=run-1');
    expect(pkg.context).toContain('attempt=2');
    expect(pkg.context).toContain('model=model-a');
    expect(pkg.context).toContain('gateway=gw-a');
  });

  it('覆盖项优先生效，acceptanceCriteria 可为空数组', () => {
    const { seed } = setupExecService();
    const pkg = packTaskPackage({
      task: seed.task,
      runId: 'run-1',
      attempt: 1,
      overrides: {
        objective: '自定义目标',
        acceptance_criteria: ['存在集成测试'],
        constraints: ['只写 backend/src/exec'],
        writes_paths: ['backend/src/exec'],
        expected_output: '通过的测试',
        context: '额外上下文',
      },
    });
    expect(pkg.objective).toBe('自定义目标');
    expect(pkg.acceptanceCriteria).toEqual(['存在集成测试']);
    expect(pkg.constraints).toEqual(['只写 backend/src/exec']);
    expect(pkg.writesPaths).toEqual(['backend/src/exec']);
    expect(pkg.expectedOutput).toBe('通过的测试');
    expect(pkg.context).toContain('额外上下文');
  });

  it('空 objective 与超长 objective 直接拒绝（fail fast，不截断事实）', () => {
    const { seed } = setupExecService();
    expect(() =>
      packTaskPackage({ task: seed.task, runId: 'r', attempt: 1, overrides: { objective: '   ' } }),
    ).toThrow(ValidationError);

    // 超长目标在打包阶段即拒绝（不截断、不静默改写事实）
    expect(() =>
      packTaskPackage({
        task: seed.task,
        runId: 'r',
        attempt: 1,
        overrides: { objective: 'x'.repeat(GROK_OBJECTIVE_MAX_CHARS + 1) },
      }),
    ).toThrow(ValidationError);

    // 打包后信封字段把渲染结果顶过上限时，renderObjective 拒绝
    const long = packTaskPackage({
      task: seed.task,
      runId: 'r',
      attempt: 1,
      overrides: { objective: 'x'.repeat(GROK_OBJECTIVE_MAX_CHARS - 1), acceptance_criteria: ['y'.repeat(100)] },
    });
    expect(() => renderObjective(long)).toThrow(ValidationError);
  });

  it('renderObjective 把信封折叠为结构化小节，空小节不渲染', () => {
    const { seed } = setupExecService();
    const pkg = packTaskPackage({
      task: seed.task,
      runId: 'r',
      attempt: 1,
      overrides: { acceptance_criteria: ['AC-1'], constraints: ['C-1'], writes_paths: ['backend/src/exec'] },
    });
    const rendered = renderObjective(pkg);
    expect(rendered).toContain('[验收标准]\n- AC-1');
    expect(rendered).toContain('[约束]\n- C-1');
    expect(rendered).toContain('[写入范围]\n- backend/src/exec');
    expect(rendered).toContain('[期望产出]');
    expect(rendered).toContain('[上下文]');
  });
});

describe('报告解析 / 状态映射 / 脱敏 / JSON 提取（纯函数）', () => {
  it('完整报告解析无告警；畸形字段记 parseWarnings 且 status 置空', () => {
    const parsed = parseWorkflowReport(COMPLETED_REPORT);
    expect(parsed.status).toBe('completed');
    expect(parsed.parseWarnings).toEqual([]);

    const malformed = parseWorkflowReport({
      summary: 42,
      status: 'weird',
      deliverables: [{ nope: true }, 'junk'],
      evidence: 'not-an-array',
      filesChanged: 'also-not',
    });
    expect(malformed.status).toBeUndefined();
    expect(malformed.parseWarnings.length).toBeGreaterThanOrEqual(4);
    expect(malformed.evidence).toEqual([]);
  });

  it('非对象输入返回不可解析报告', () => {
    expect(parseWorkflowReport(null).status).toBeUndefined();
    expect(parseWorkflowReport('text').parseWarnings).toContain('report is not a JSON object');
  });

  it('状态映射：只有 completed 算成功', () => {
    expect(mapReportStatusToRunStatus('completed')).toBe('succeeded');
    expect(mapReportStatusToRunStatus('partial')).toBe('failed');
    expect(mapReportStatusToRunStatus('failed')).toBe('failed');
    expect(mapReportStatusToRunStatus(undefined)).toBe('failed');
  });

  it('redactText 覆盖常见密钥样字符串', () => {
    const input = [
      'key is sk-abcdefABCDEF12345678,',
      'github ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3',
      'Bearer ABCDEF.abcdef1234567890',
      'api_key = "supersecret99"',
      'PASSWORD:hunter2hunter',
    ].join('\n');
    const output = redactText(input);
    expect(output).not.toContain('sk-abcdefABCDEF12345678');
    expect(output).not.toContain('supersecret99');
    expect(output).not.toContain('hunter2hunter');
    expect(output).not.toContain('a1B2c3D4e5F6g7H8i9J0k1L2m3');
    expect(output).toContain('api_key');
    expect(output).toContain('***redacted***');
  });

  it('extractJsonReport 从带前后缀文本中提取最后一个 JSON 对象', () => {
    const text = '日志前缀 {"a":1} 中间 {"summary":"s","status":"completed"} 后缀文字';
    expect(extractJsonReport(text)).toEqual({ summary: 's', status: 'completed' });
    expect(extractJsonReport('no json here')).toBeNull();
  });
});

describe('ExecService.dispatch：成功结局', () => {
  it('run 进入 succeeded，完整事件流与审计落库，模型/网关随派发记录', async () => {
    const h = setupExecService({ maxAttempts: 3 });
    h.mock.enqueue({
      kind: 'success',
      report: { ...COMPLETED_REPORT, summary: 'ok key sk-abcdefABCDEF12345678' },
    });

    const result = await h.service.dispatch({
      task_id: h.seed.task.id,
      model: 'model-x',
      gateway: 'gw-1',
    });

    expect(result.status).toBe('succeeded');
    expect(result.attempt).toBe(1);
    expect(result.timed_out).toBe(false);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.report?.status).toBe('completed');
    // 落库前脱敏
    expect(result.report?.summary).not.toContain('sk-abcdefABCDEF12345678');
    expect(result.report?.summary).toContain('***redacted***');

    const view = h.service.getRunView(result.run_id);
    expect(view.run.status).toBe('succeeded');
    expect(view.run.started_at).not.toBeNull();
    expect(view.run.finished_at).not.toBeNull();
    expect(view.run.duration_ms).toBeGreaterThanOrEqual(0);
    expect(view.task?.id).toBe(h.seed.task.id);
    expect(view.dispatch).toMatchObject({ executor: 'mock', model: 'model-x', gateway: 'gw-1', attempt: 1 });
    expect(view.result.report?.evidence).toEqual(COMPLETED_REPORT.evidence);
    const eventTypes = view.events.map((event) => event.type);
    expect(eventTypes[0]).toBe('dispatch');
    expect(eventTypes).toContain('run_summary');
    expect(eventTypes[eventTypes.length - 1]).toBe('run_summary');

    const audit = h.repos.auditLog.list({ entity_type: 'run', entity_id: result.run_id });
    expect(audit.map((row) => row.action)).toEqual(['run_finished', 'dispatch']);
    expect(h.feedback.map((fb) => fb.kind)).toEqual(['run_finished']);
    expect(h.feedback[0]?.task_id).toBe(h.seed.task.id);
  });

  it('执行端流式事件经 onEvent 落 run_events（exec. 前缀）', async () => {
    const h = setupExecService();
    h.mock.enqueue({ kind: 'hang' });
    const pending = h.service.dispatch({ task_id: h.seed.task.id });
    await waitFor(() => h.mock.callCount === 1);
    h.mock.emitCallEvent(1, { type: 'progress', payload: { step: 'planning' } });
    h.mock.emitCallEvent(1, { type: 'exec.already_prefixed', payload: { step: 'executing' } });
    h.mock.settleCall(1, { report: COMPLETED_REPORT, raw: null });
    const result = await pending;

    expect(result.status).toBe('succeeded');
    const types = h.service.getRunView(result.run_id).events.map((event) => event.type);
    expect(types).toContain('exec.progress');
    expect(types).toContain('exec.already_prefixed');
    // 前缀只加一次
    expect(types).not.toContain('exec.exec.already_prefixed');
  });

  it('MockExecutor 收到的执行上下文携带任务包与资源快照', async () => {
    const h = setupExecService();
    h.mock.enqueue({ kind: 'success' });
    await h.service.dispatch({ task_id: h.seed.task.id, model: 'm1', gateway: 'g1' });
    const call = h.mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.runId).toBe(h.mock.calls[0]?.runId);
    expect(call?.attempt).toBe(1);
    expect(call?.model).toBe('m1');
    expect(call?.gateway).toBe('g1');
    expect(call?.taskPackage.source.taskId).toBe(h.seed.task.id);
    expect(renderObjective(call!.taskPackage)).toContain('[验收标准]');
  });
});

describe('ExecService.dispatch：失败 → 重试队列 → 无人值守继续', () => {
  it('失败后生成 queued 重试 run，processQueue 继续处理至成功', async () => {
    const h = setupExecService({ maxAttempts: 2 });
    h.mock.enqueue({ kind: 'failure', error: '第一步执行失败' });
    h.mock.enqueue({ kind: 'success' });

    const first = await h.service.dispatch({ task_id: h.seed.task.id });
    expect(first.status).toBe('failed');
    expect(first.error).toContain('第一步执行失败');

    // 失败 run 上有 retry_scheduled 事件；重试 run 已入队
    const failedEvents = h.service.getRunView(first.run_id, { includeEvents: false });
    expect(failedEvents.run.status).toBe('failed');
    const failedRunEvents = h.repos.runEvents.listByRun(first.run_id);
    const retryEvent = failedRunEvents.find((event) => event.type === 'retry_scheduled');
    expect(retryEvent).toBeDefined();
    const nextRunId = JSON.parse(retryEvent?.payload ?? '{}') as { next_run_id?: string };
    expect(nextRunId.next_run_id).toBeDefined();
    expect(h.service.listRuns({ task_id: h.seed.task.id }).count).toBe(2);
    expect(h.repos.runs.getById(nextRunId.next_run_id!)?.status).toBe('queued');
    expect(h.feedback.map((fb) => fb.kind)).toEqual(['retry_scheduled']);
    expect(h.repos.auditLog.list({ action: 'retry_scheduled' }).length).toBe(1);

    // 无人值守一轮：处理重试 run 至成功
    const pass = await h.service.processQueue();
    expect(pass.skipped).toEqual([]);
    expect(pass.orphans).toEqual([]);
    expect(pass.runs).toHaveLength(1);
    expect(pass.runs[0]?.status).toBe('succeeded');
    expect(pass.runs[0]?.attempt).toBe(2);
    expect(h.repos.runs.getById(pass.runs[0]?.run_id ?? '')?.status).toBe('succeeded');
    // 任务未被阻塞
    expect(h.repos.tasks.getById(h.seed.task.id)?.status).toBe('todo');
    expect(h.service.queueSnapshot()).toMatchObject({ queued: 0, running: 0 });
  });
});

describe('ExecService.dispatch：失败额度用尽 → 阻塞标记', () => {
  it('maxAttempts=1 时失败直接把任务标记 blocked 并写审计/反馈', async () => {
    const h = setupExecService({ maxAttempts: 1 });
    h.mock.enqueue({ kind: 'failure', error: 'always fails' });

    const result = await h.service.dispatch({ task_id: h.seed.task.id });
    expect(result.status).toBe('failed');
    expect(h.service.listRuns({ task_id: h.seed.task.id }).count).toBe(1);
    expect(h.repos.tasks.getById(h.seed.task.id)?.status).toBe('blocked');
    const blockedEvents = h.repos.runEvents.listByRun(result.run_id);
    expect(blockedEvents.some((event) => event.type === 'task_blocked')).toBe(true);
    const audit = h.repos.auditLog.list({ action: 'task_blocked' });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entity_type).toBe('task');
    expect(audit[0]?.entity_id).toBe(h.seed.task.id);
    expect(h.feedback.map((fb) => fb.kind)).toEqual(['task_blocked']);
    const view = h.service.getRunView(result.run_id, { includeEvents: false });
    expect(view.task?.status).toBe('blocked');
  });
});

describe('ExecService.dispatch：超时 → 重试队列 → 无人值守恢复', () => {
  it('挂起的执行端超时后 run 判 failed(timed_out)，重试后可成功', async () => {
    const h = setupExecService({ timeoutMs: 80, maxAttempts: 2 });
    h.mock.enqueue({ kind: 'hang' });
    h.mock.enqueue({ kind: 'success' });

    const first = await h.service.dispatch({ task_id: h.seed.task.id });
    expect(first.status).toBe('failed');
    expect(first.timed_out).toBe(true);
    expect(first.error).toContain('timed out after 80ms');
    expect(first.duration_ms).toBeGreaterThanOrEqual(75);

    const view = h.service.getRunView(first.run_id, { includeEvents: false });
    expect(view.result.timed_out).toBe(true);
    expect(view.run.error).toContain('timed out');
    // 超时计入重试队列
    expect(h.service.listRuns({ task_id: h.seed.task.id, status: 'queued' }).count).toBe(1);

    const pass = await h.service.processQueue();
    expect(pass.runs[0]?.status).toBe('succeeded');
    expect(pass.runs[0]?.timed_out).toBe(false);
  });
});

describe('无人值守：后台派发与孤儿恢复', () => {
  it('await_completion=false 立即返回，后台继续执行至终态', async () => {
    const h = setupExecService();
    h.mock.enqueue({ kind: 'success', delayMs: 5 });
    const result = await h.service.dispatch({ task_id: h.seed.task.id, await_completion: false });
    expect(result.status).toBe('running');
    expect(result.duration_ms).toBeNull();

    await waitFor(() => h.service.getRunView(result.run_id, { includeEvents: false }).run.status === 'succeeded');
    expect(h.service.getRunView(result.run_id).result.report?.status).toBe('completed');
  });

  it('进程重启遗留的 running run 被识别为孤儿，收场并进入重试队列', async () => {
    const h = setupExecService({ maxAttempts: 2 });
    // 模拟上一个进程遗留：run 已 running 但没有任何活动句柄
    const orphan = h.repos.runs.create({ project_id: h.seed.project.id, task_id: h.seed.task.id, status: 'running' });
    h.repos.runs.start(orphan.id);
    // 孤儿 run 带 attempt=1 的派发事件（模拟重启前已完成一次派发）
    h.repos.runEvents.append({
      run_id: orphan.id,
      type: 'dispatch',
      payload: { executor: 'mock', attempt: 1, model: null, gateway: null, timeout_ms: 1000, objective_chars: 10 },
    });
    h.mock.enqueue({ kind: 'success' });

    const pass = await h.service.processQueue();
    expect(pass.orphans).toHaveLength(1);
    expect(pass.orphans[0]?.status).toBe('failed');
    expect(pass.orphans[0]?.error).toContain('orphaned');
    expect(pass.runs).toHaveLength(1); // 重试 run 已被本轮无人值守处理
    expect(pass.runs[0]?.status).toBe('succeeded');
    expect(pass.runs[0]?.attempt).toBe(2);
    expect(h.repos.auditLog.list({ action: 'orphan_detected' }).length).toBe(1);
    expect(h.service.queueSnapshot().orphaned_run_ids).toEqual([]);
  });

  it('queueSnapshot 反映 queued/running/active/orphaned', async () => {
    const h = setupExecService({ timeoutMs: 5000 });
    h.mock.enqueue({ kind: 'hang' });
    const queuedExtra = h.repos.runs.create({ project_id: h.seed.project.id, task_id: h.seed.task.id, status: 'queued' });

    const result = await h.service.dispatch({ task_id: h.seed.task.id, await_completion: false });
    const snapshot = h.service.queueSnapshot();
    expect(snapshot.running).toBe(1);
    expect(snapshot.active_run_ids).toEqual([result.run_id]);
    expect(snapshot.queued).toBe(1);

    h.mock.settleCall(1, { report: COMPLETED_REPORT, raw: null });
    await waitFor(() => h.service.queueSnapshot().running === 0);
    expect(h.service.queueSnapshot().active_run_ids).toEqual([]);
  });
});

describe('取消', () => {
  it('queued run 可取消；终态 run 拒绝取消', async () => {
    const h = setupExecService();
    const run = h.repos.runs.create({ project_id: h.seed.project.id, task_id: h.seed.task.id, status: 'queued' });
    const cancelled = await h.service.cancel(run.id, 'operator asked');
    expect(cancelled.status).toBe('cancelled');
    expect(h.repos.runs.getById(run.id)?.status).toBe('cancelled');
    expect(h.repos.runs.getById(run.id)?.error).toContain('cancelled: operator asked');
    expect(h.feedback.map((fb) => fb.kind)).toEqual(['run_cancelled']);

    await expect(h.service.cancel(run.id)).rejects.toThrow(ValidationError);
  });

  it('活动中的 run 取消后由跟踪循环收尾为 cancelled', async () => {
    const h = setupExecService();
    h.mock.enqueue({ kind: 'hang' });
    const result = await h.service.dispatch({ task_id: h.seed.task.id, await_completion: false });
    await waitFor(() => h.mock.callCount === 1);
    await h.service.cancel(result.run_id, 'no longer needed');
    await waitFor(() => h.service.getRunView(result.run_id, { includeEvents: false }).run.status === 'cancelled');
    const view = h.service.getRunView(result.run_id, { includeEvents: false });
    expect(view.run.error).toContain('cancelled: no longer needed');
    expect(h.feedback.at(-1)?.kind).toBe('run_cancelled');
  });
});

describe('输入校验与错误', () => {
  it('任务/执行端/run 不存在或状态不符时抛业务错误', async () => {
    const h = setupExecService();
    await expect(h.service.dispatch({ task_id: 'nope' })).rejects.toThrow(NotFoundError);
    await expect(
      h.service.dispatch({ task_id: h.seed.task.id, executor: 'unknown-executor' }),
    ).rejects.toThrow(ValidationError);
    await expect(h.service.dispatch({ run_id: 'nope' })).rejects.toThrow(NotFoundError);
    await expect(h.service.dispatch({})).rejects.toThrow(ValidationError);
    await expect(
      h.service.dispatch({ task_id: h.seed.task.id, timeout_ms: 0 }),
    ).rejects.toThrow(ValidationError);
    await expect(h.service.processQueue({ limit: 0 })).rejects.toThrow(ValidationError);
    expect(() => h.service.listRuns({ status: 'bogus' })).toThrow(ValidationError);

    // 非 queued run 不能再派发
    const run = h.repos.runs.create({ project_id: h.seed.project.id, task_id: h.seed.task.id, status: 'queued' });
    h.repos.runs.start(run.id);
    h.repos.runs.finish(run.id, { status: 'succeeded' });
    await expect(h.service.dispatch({ run_id: run.id })).rejects.toThrow(/must be queued/);
  });

  it('同一个 run 不会被并发重复派发', async () => {
    const h = setupExecService();
    h.mock.enqueue({ kind: 'hang' });
    const run = h.repos.runs.create({ project_id: h.seed.project.id, task_id: h.seed.task.id, status: 'queued' });
    const first = await h.service.dispatch({ run_id: run.id, await_completion: false });
    await waitFor(() => h.mock.callCount === 1);
    await expect(h.service.dispatch({ run_id: run.id })).rejects.toThrow(/must be queued/);
    h.mock.settleCall(1, { report: COMPLETED_REPORT, raw: null });
    await waitFor(() => h.service.getRunView(first.run_id, { includeEvents: false }).run.status === 'succeeded');
  });

  it('没有执行端时构造即失败；默认执行端可显式指定', async () => {
    const { db, repos } = setupExecService();
    expect(() => new ExecService({ db, repos, executors: [] })).toThrow(ValidationError);
    const mock = new MockExecutor('secondary');
    const { service } = setupExecService({ executor: mock });
    await expect(service.dispatch({ task_id: 'nope' })).rejects.toThrow(NotFoundError);
  });
});

describe('调度器决策的 run 复用（run_id 派发路径）', () => {
  it('外部创建的 queued run 可直接派发且 attempt 正确', async () => {
    const h: ExecTestHandle = setupExecService();
    h.mock.enqueue({ kind: 'success' });
    const schedulerRun = h.repos.runs.create({
      project_id: h.seed.project.id,
      task_id: h.seed.task.id,
      status: 'queued',
    });
    const result = await h.service.dispatch({ run_id: schedulerRun.id, await_completion: true });
    expect(result.status).toBe('succeeded');
    expect(result.attempt).toBe(1);
    expect(h.service.getRunView(schedulerRun.id, { includeEvents: false }).dispatch?.executor).toBe('mock');
  });

  it('task_id 与 run 归属不一致时拒绝', async () => {
    const h = setupExecService();
    const run = h.repos.runs.create({ project_id: h.seed.project.id, task_id: h.seed.task.id, status: 'queued' });
    await expect(h.service.dispatch({ run_id: run.id, task_id: 'other-task' })).rejects.toThrow(/belongs to task/);
  });
});
