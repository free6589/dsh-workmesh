/**
 * 执行端实现。
 *
 * - MockExecutor：可编程脚本化结局（成功/失败/挂起），供集成测试与
 *   真实 DSH 不可达的环境使用；会完整记录收到的任务包供断言。
 * - DshHeadlessExecutor：真实接入适配器——把任务包渲染为根目标后经
 *   `dsh headless <objective>` 派发（grok_workflow 的 plan–execute–verify–
 *   retry–synthesize 在 DSH 进程内完成），这里只负责 spawn、超时兜底与
 *   报告文本提取。注意：本沙箱内 `dsh` 启动 headless profile 受文件系统
 *   只读限制（EROFS），真实链路未经联调验证，见任务验收报告。
 *
 * 两个实现都不得出现规划/验证/重试逻辑。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { extractJsonReport } from './report.js';
import { renderObjective } from './pack.js';
import type {
  ExecEventInput,
  ExecExecution,
  ExecHandle,
  ExecRawResult,
  Executor,
  WorkflowReport,
} from './types.js';

// ---------- MockExecutor ----------

export type MockOutcome =
  | { kind: 'success'; report?: Partial<WorkflowReport>; delayMs?: number }
  | { kind: 'failure'; error?: string; report?: Partial<WorkflowReport> | null; delayMs?: number }
  /** 挂起直到 cancel() 或测试经 settleCall/failCall 显式落定（用于超时/事件流场景）。 */
  | { kind: 'hang' };

const MOCK_COMPLETED: WorkflowReport = {
  summary: 'mock run completed',
  status: 'completed',
  deliverables: [],
  evidence: [],
  testsRun: [],
  filesChanged: [],
  uncertainties: [],
};

const MOCK_FAILED: WorkflowReport = {
  summary: 'mock run failed',
  status: 'failed',
  deliverables: [],
  evidence: [],
  testsRun: [],
  filesChanged: [],
  uncertainties: [],
};

function mergeReport(base: WorkflowReport, patch?: Partial<WorkflowReport>): WorkflowReport {
  return patch === undefined ? { ...base } : { ...base, ...patch };
}

export class MockExecutor implements Executor {
  readonly id: string;
  /** 按派发顺序记录的全部执行上下文（1-based 下标与 callCount 对应）。 */
  readonly calls: ExecExecution[] = [];
  private outcomes: MockOutcome[] = [];
  private pending = new Map<number, { settle: (result: ExecRawResult) => void; done: boolean }>();

  constructor(id = 'mock') {
    this.id = id;
  }

  /** 预置脚本化结局，按派发顺序消耗；未预置时默认失败（fail loud）。 */
  enqueue(...items: MockOutcome[]): void {
    this.outcomes.push(...items);
  }

  get callCount(): number {
    return this.calls.length;
  }

  start(execution: ExecExecution): ExecHandle {
    const index = this.calls.push(execution);
    const outcome = this.outcomes.shift() ?? {
      kind: 'failure' as const,
      error: 'mock executor: no scripted outcome enqueued (default failure)',
    };
    let settle!: (result: ExecRawResult) => void;
    const promise = new Promise<ExecRawResult>((resolve) => {
      settle = resolve;
    });
    const slot = { settle, done: false };
    this.pending.set(index, slot);
    const settleOnce = (result: ExecRawResult): void => {
      if (slot.done) return;
      slot.done = true;
      this.pending.delete(index);
      settle(result);
    };

    if (outcome.kind !== 'hang') {
      const timer = setTimeout(() => {
        if (outcome.kind === 'success') {
          settleOnce({ report: mergeReport(MOCK_COMPLETED, outcome.report), raw: null });
        } else if (outcome.kind === 'failure') {
          settleOnce({
            report: outcome.report === undefined ? { ...MOCK_FAILED } : outcome.report === null ? null : mergeReport(MOCK_FAILED, outcome.report),
            raw: null,
            error: outcome.error ?? 'mock failure',
          });
        }
      }, Math.max(0, outcome.delayMs ?? 0));
      timer.unref?.();
    }

    return {
      promise,
      cancel: (reason?: string) => {
        settleOnce({ report: null, raw: null, error: `cancelled: ${reason ?? 'cancelled by caller'}` });
      },
    };
  }

  /** 显式落定第 index（1-based）次挂起中的调用。 */
  settleCall(index: number, result: ExecRawResult): void {
    const slot = this.pending.get(index);
    if (slot) slot.settle(result);
  }

  /** 显式让第 index（1-based）次调用以错误收场。 */
  failCall(index: number, error: string): void {
    this.settleCall(index, { report: null, raw: null, error });
  }

  /** 模拟执行端流式事件（走真实 onEvent 通道）。 */
  emitCallEvent(index: number, event: ExecEventInput): void {
    const call = this.calls[index - 1];
    if (call) call.onEvent(event);
  }
}

// ---------- DshHeadlessExecutor（真实接入适配器） ----------

export interface DshHeadlessExecutorOptions {
  /** dsh 可执行文件；缺省 'dsh'（依赖 PATH）。 */
  command?: string;
  /** 透传 --profile <name>（headless profile）。 */
  profile?: string;
  /** 子进程工作目录。 */
  cwd?: string;
  /** 执行端兜底硬超时（毫秒）；应大于 run 级 timeout_ms。缺省不设。 */
  timeoutMs?: number;
  /** 测试注入点；缺省 node:child_process.spawn。 */
  spawnImpl?: typeof spawn;
}

/**
 * 经 DSH CLI 的 headless 模式派发：`dsh [--profile X] headless <objective>`。
 * 结构化报告按 JSON 从 stdout 提取（extractJsonReport），退出码非 0 时
 * 仍优先采用可解析报告（failed 状态的工作流也可能正常退出打印报告）。
 */
export class DshHeadlessExecutor implements Executor {
  readonly id = 'dsh-headless';
  private readonly options: DshHeadlessExecutorOptions;

  constructor(options: DshHeadlessExecutorOptions = {}) {
    this.options = options;
  }

  start(execution: ExecExecution): ExecHandle {
    const command = this.options.command ?? 'dsh';
    const objective = renderObjective(execution.taskPackage);
    const args: string[] = [];
    if (this.options.profile !== undefined) args.push('--profile', this.options.profile);
    args.push('headless', objective);
    execution.onEvent({
      type: 'exec.spawn',
      payload: { command, profile: this.options.profile ?? null, objective_chars: objective.length },
    });

    const child: ChildProcess = (this.options.spawnImpl ?? spawn)(command, args, {
      cwd: this.options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    if (this.options.timeoutMs !== undefined) {
      hardTimer = setTimeout(() => child.kill('SIGKILL'), this.options.timeoutMs);
      hardTimer.unref?.();
    }

    let settled = false;
    let settle!: (result: ExecRawResult) => void;
    const promise = new Promise<ExecRawResult>((resolve) => {
      settle = resolve;
    });
    const settleOnce = (result: ExecRawResult): void => {
      if (settled) return;
      settled = true;
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      settle(result);
    };

    child.on('error', (error: Error) => {
      settleOnce({
        report: null,
        raw: stderr || null,
        error: `dsh headless spawn failed: ${error.message}`,
      });
    });
    child.on('close', (code, signal) => {
      const parsed = extractJsonReport(stdout);
      const report =
        parsed !== null && parsed !== undefined && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as WorkflowReport)
          : null;
      settleOnce({
        report,
        raw: stdout,
        error:
          code === 0
            ? undefined
            : `dsh headless exited with code ${String(code)}${signal ? ` (signal ${signal})` : ''}`,
      });
    });

    return {
      promise,
      cancel: (reason?: string) => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
        // close 事件会最终落定；此处仅兜底防止进程不退出。
        setTimeout(() => {
          settleOnce({ report: null, raw: stdout || null, error: `cancelled: ${reason ?? 'cancelled by caller'}` });
        }, 5000).unref?.();
      },
    };
  }
}
