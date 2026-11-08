/**
 * 执行平面领域类型（backend/src/exec）。
 *
 * 职责边界（docs/ARCHITECTURE.md §3.2 / 任务 exec_integration）：
 * - Workmesh 执行平面只做：任务打包 → 派发 → 状态跟踪 → 结果/事件落库
 *   → 失败/超时的重试排队或阻塞标记 → 反馈调度器；
 * - 规划 → 执行 → 验证 → 有界重试 → 汇总（plan–execute–verify–retry–synthesize）
 *   全部由 Grok Workflow（DSH grok_workflow 工具 / dsh headless）完成，
 *   本模块不复制、不重新实现其中任何一环。
 * - 这里的 run 级重试排队属于队列管理（重派一份新 run），与 Grok Workflow
 *   工作流内部对子任务的验证/重试是两层不同的机制。
 */
import type { RunEventLevel, RunStatus, Task } from '../types/entities.js';
import type { Run, RunEvent } from '../types/entities.js';

export type { RunStatus };

/** grok_workflow 根目标长度上限（与 dsh-grok-workflow TASK_LIMITS.objectiveChars 对齐）。 */
export const GROK_OBJECTIVE_MAX_CHARS = 32_000;

/** 派发缺省参数。 */
export const DEFAULT_RUN_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_QUEUE_BATCH_LIMIT = 8;

// ---------- 任务包（与 grok_workflow 输入契约对齐） ----------

/** Workmesh 侧任务包信封：字段名与 dsh-grok-workflow 工具入参/文档一致。 */
export interface TaskPackage {
  /** 任务主目标（根目标）。 */
  objective: string;
  /** 可测试的验收标准；空数组表示任务数据未声明。 */
  acceptanceCriteria: string[];
  /** 约束与非目标。 */
  constraints: string[];
  /** 声明的写入路径。 */
  writesPaths: string[];
  /** 派发上下文（含 workmesh 元数据行）。 */
  context: string;
  /** 期望产出提示。 */
  expectedOutput: string;
  /** 派发溯源信息。 */
  source: {
    runId: string;
    taskId: string;
    projectId: string;
    attempt: number;
  };
}

// ---------- grok_workflow 结构化报告（契约见 dsh-grok-workflow src/types.ts） ----------

export interface WorkflowReportEvidence {
  claim: string;
  source: string;
}

export interface WorkflowReportTest {
  command: string;
  status: 'passed' | 'failed' | 'not_run';
  detail: string;
}

export interface WorkflowReportDeliverable {
  description: string;
  locator: string;
}

/** grok_workflow 工具产出的规范化报告形状（宽松解析，缺字段记 parseWarnings）。 */
export interface WorkflowReport {
  summary: string;
  status: 'completed' | 'partial' | 'failed';
  deliverables: WorkflowReportDeliverable[];
  evidence: WorkflowReportEvidence[];
  testsRun: WorkflowReportTest[];
  filesChanged: string[];
  uncertainties: string[];
}

/** run 终态（finalize 可落入的状态）。 */
export type TerminalRunStatus = Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled'>;

/** 解析后的报告：报告本体 + 解析告警（不静默丢弃畸形字段）。 */
export type ParsedReport = Omit<WorkflowReport, 'status'> & {
  /** undefined 表示报告不可解析（调用方按 failed 处理）。 */
  status: WorkflowReportStatus;
  parseWarnings: string[];
};

/** status 缺省表示报告不可解析（调用方按 failed 处理）。 */
export type WorkflowReportStatus = WorkflowReport['status'] | undefined;

// ---------- 执行端（Executor）契约 ----------

/** 执行端事件：经 onEvent 流式落到 run_events（type 统一加 exec. 前缀）。 */
export interface ExecEventInput {
  level?: RunEventLevel;
  type: string;
  payload?: unknown;
}

/** 单次派发给执行端的执行上下文。 */
export interface ExecExecution {
  runId: string;
  attempt: number;
  taskPackage: TaskPackage;
  /** 选定资源（来自调度决策），缺省 null。 */
  model: string | null;
  gateway: string | null;
  onEvent(event: ExecEventInput): void;
}

/** 执行端原始结果：报告可能缺省，错误/原始输出保留用于审计。 */
export interface ExecRawResult {
  report: WorkflowReport | null;
  raw?: string | null;
  error?: string;
}

export interface ExecHandle {
  promise: Promise<ExecRawResult>;
  cancel(reason?: string): void;
}

/**
 * 执行端抽象。真实接入 = DshHeadlessExecutor（dsh headless / grok_workflow）；
 * 测试与环境不可达时 = MockExecutor。执行端实现内部不得出现
 * 规划/验证/重试逻辑——那是 Grok Workflow 的职责。
 */
export interface Executor {
  readonly id: string;
  start(execution: ExecExecution): ExecHandle;
}

// ---------- 派发输入/输出（字段名与 HTTP body 对齐，snake_case） ----------

export interface DispatchInput {
  /** 任务 ID（tasks 表）。给出 run_id 时可省略（从 run 反查）。 */
  task_id?: string;
  /** 已存在的 queued run（调度器或重试队列创建）；缺省则新建 run。 */
  run_id?: string;
  project_id?: string;
  agent_id?: string;
  /** 选定资源快照（来自调度器决策），随事件与审计落库。 */
  model?: string | null;
  gateway?: string | null;
  /** 执行端 id；缺省用服务默认执行端。 */
  executor?: string;
  /** 单次运行超时（毫秒），到时取消执行端并把 run 判为 failed(timed_out)。 */
  timeout_ms?: number;
  /** 任务包覆盖项；缺省从 tasks/subtasks 数据确定性生成。 */
  objective?: string;
  expected_output?: string;
  acceptance_criteria?: string[];
  constraints?: string[];
  writes_paths?: string[];
  context?: string;
  /** true（缺省）等待运行结束后返回；false 立即返回，由无人值守流程继续。 */
  await_completion?: boolean;
}

export interface DispatchResult {
  run_id: string;
  status: RunStatus;
  attempt: number;
  report: ParsedReport | null;
  error: string | null;
  timed_out: boolean;
  /** await_completion=false 时为 null，经 GET /exec/runs/:id 继续跟踪。 */
  duration_ms: number | null;
}

export interface ProcessQueueResult {
  /** 本次处理的 queued run 结果（含重试链）。 */
  runs: DispatchResult[];
  /** 检测到的孤儿 run（running 但无活动执行句柄，如进程重启遗留）。 */
  orphans: DispatchResult[];
  /** 处理时因状态变化等原因跳过的 run。 */
  skipped: Array<{ run_id: string; error: string }>;
}

export interface QueueSnapshot {
  queued: number;
  running: number;
  active_run_ids: string[];
  orphaned_run_ids: string[];
}

// ---------- 运行视图（API 返回的完整 run 记录） ----------

export interface DispatchMeta {
  executor: string;
  model: string | null;
  gateway: string | null;
  attempt: number;
  timeout_ms: number | null;
  objective_chars: number | null;
}

export interface ExecRunResult {
  status: RunStatus;
  error: string | null;
  duration_ms: number | null;
  timed_out: boolean;
  report: ParsedReport | null;
}

export interface ExecRunView {
  run: Run & { duration_ms: number | null };
  task: Pick<Task, 'id' | 'title' | 'status' | 'priority'> | null;
  agent: { id: string; name: string } | null;
  dispatch: DispatchMeta | null;
  result: ExecRunResult;
  events: RunEvent[];
}

// ---------- 反馈调度器 ----------
export type ExecFeedbackKind = 'run_finished' | 'run_cancelled' | 'retry_scheduled' | 'task_blocked';

export interface ExecFeedback {
  kind: ExecFeedbackKind;
  run_id: string;
  task_id: string;
  attempt: number;
  status?: RunStatus;
  error?: string | null;
  next_run_id?: string;
}
