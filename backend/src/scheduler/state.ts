/**
 * 任务状态机、阻塞识别与无人值守的下一步安排。
 *
 * 状态机直接建立在数据层 tasks.status 的五态之上：
 *   todo → in_progress → done / blocked / cancelled；blocked 可回到 todo / in_progress；
 *   done 与 cancelled 为终态（重开需显式回 todo 之外的人工操作）。
 * 阻塞识别覆盖三类原因：人工标记、DAG 依赖未完成、无可用模型资源（由调度决策给出）。
 * 下一步安排面向无人值守场景：每一步都标注能否自动执行与预计重试时间。
 */
import { ValidationError } from '../db/errors.js';
import type { SchedulingDecision } from './types.js';
import type { TaskStatus } from '../types/entities.js';

export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = ['done', 'cancelled'];

export const ALLOWED_TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['blocked', 'done', 'cancelled'],
  blocked: ['todo', 'in_progress', 'cancelled'],
  done: [],
  cancelled: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TASK_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new ValidationError(
      `非法任务状态迁移 ${from} -> ${to}；允许的迁移：[${ALLOWED_TASK_TRANSITIONS[from].join(', ')}]`,
    );
  }
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TASK_TERMINAL_STATUSES.includes(status);
}

// ---------- 阻塞识别 ----------

export interface DependencySnapshot {
  taskId: string;
  title: string;
  status: TaskStatus;
}

export type BlockingCauseCode = 'manually_blocked' | 'dependency_unmet' | 'resource_unavailable';

export interface BlockingCause {
  code: BlockingCauseCode;
  message: string;
  /** code = dependency_unmet 时给出具体依赖任务。 */
  dependsOnTaskId?: string;
}

export interface BlockingReport {
  taskId: string;
  blocked: boolean;
  causes: BlockingCause[];
}

export interface DetectBlockingInput {
  task: { id: string; status: TaskStatus };
  dependencies: DependencySnapshot[];
  /** 最近一次调度决策（可选）：blocked 时生成 resource_unavailable 原因。 */
  decision?: { blocked: boolean; rationale: string[] } | null;
}

/**
 * 阻塞识别：人工标记 + 依赖未完成 + 资源不可用三类原因可叠加；
 * 原因按「依赖 → 资源 → 人工」排序，保证同一输入输出顺序稳定。
 */
export function detectBlocking(input: DetectBlockingInput): BlockingReport {
  const causes: BlockingCause[] = [];
  for (const dep of input.dependencies) {
    if (dep.status === 'done') continue;
    causes.push({
      code: 'dependency_unmet',
      dependsOnTaskId: dep.taskId,
      message:
        dep.status === 'cancelled'
          ? `依赖任务 ${dep.taskId}（${dep.title}）已取消，需人工处理`
          : `依赖任务 ${dep.taskId}（${dep.title}）尚未完成（当前状态 ${dep.status}）`,
    });
  }
  if (input.decision?.blocked === true) {
    const last = input.decision.rationale[input.decision.rationale.length - 1];
    causes.push({
      code: 'resource_unavailable',
      message: typeof last === 'string' ? last : '调度未找到可用的模型资源入口',
    });
  }
  if (input.task.status === 'blocked') {
    causes.push({ code: 'manually_blocked', message: '任务当前处于 blocked 状态（人工或上游标记）' });
  }
  return { taskId: input.task.id, blocked: causes.length > 0, causes };
}

// ---------- 下一步安排（无人值守） ----------

export type NextStepAction = 'wait_dependency' | 'requeue_with_backoff' | 'escalate_human';

export interface NextStep {
  seq: number;
  action: NextStepAction;
  /** 该步骤本身是否可无人值守自动执行（escalate_human 恒为 false）。 */
  automatic: boolean;
  /** 在当前 unattended 配置下是否会被自动执行。 */
  willAutoExecute: boolean;
  description: string;
  /** action = requeue_with_backoff 时的建议等待时长。 */
  retryDelayMs?: number;
  /** action = requeue_with_backoff 时的预计重试时刻（ISO）。 */
  retryAt?: string;
  payload?: Record<string, unknown>;
}

/** 自动重试基础间隔：60s 起步，按尝试次数指数退避。 */
export const BASE_RETRY_DELAY_MS = 60_000;
/** 自动重试间隔上限 30 分钟。 */
export const MAX_RETRY_DELAY_MS = 1_800_000;
/** 资源类阻塞的最大自动重试次数，超过后升级人工。 */
export const DEFAULT_MAX_ATTEMPTS = 3;

export function retryDelayForAttempts(attempts: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempts), MAX_RETRY_DELAY_MS);
}

export interface PlanNextStepsInput {
  task: { id: string; title: string };
  blocking: BlockingReport;
  /** 已发生的历史调度尝试次数（决定退避与是否升级）。 */
  attempts: number;
  maxAttempts?: number;
  unattended: boolean;
  /** 当前时刻（ISO），用于计算 retryAt。 */
  now: string;
}

/**
 * 为阻塞任务生成有序的下一步安排：
 * - 依赖未完成 → 等待依赖（自动，下一轮重查）；
 * - 资源不可用且未达重试上限 → 指数退避自动重试；
 * - 资源不可用且已达上限 / 人工标记 → 升级人工处理（附具体处理建议）。
 */
export function planNextSteps(input: PlanNextStepsInput): NextStep[] {
  const steps: NextStep[] = [];
  const max = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const causeOrder: readonly BlockingCauseCode[] = [
    'dependency_unmet',
    'resource_unavailable',
    'manually_blocked',
  ];
  const causes = [...input.blocking.causes].sort(
    (a, b) => causeOrder.indexOf(a.code) - causeOrder.indexOf(b.code),
  );
  let seq = 1;
  for (const cause of causes) {
    if (cause.code === 'dependency_unmet') {
      steps.push({
        seq: seq++,
        action: 'wait_dependency',
        automatic: true,
        willAutoExecute: input.unattended,
        description: `${cause.message}；等待其完成后在下一轮调度自动重查`,
        payload: { dependsOnTaskId: cause.dependsOnTaskId ?? null },
      });
      continue;
    }
    if (cause.code === 'resource_unavailable') {
      if (input.attempts < max) {
        const delay = retryDelayForAttempts(input.attempts);
        const base = Date.parse(input.now);
        const retryAt = new Date((Number.isNaN(base) ? 0 : base) + delay).toISOString();
        steps.push({
          seq: seq++,
          action: 'requeue_with_backoff',
          automatic: true,
          willAutoExecute: input.unattended,
          description: `当前无可用模型资源（第 ${input.attempts + 1} 次/${max + 1} 次尝试机会）；${Math.round(delay / 1000)}s 后自动重试调度`,
          retryDelayMs: delay,
          retryAt,
          payload: { attempts: input.attempts + 1 },
        });
      } else {
        steps.push({
          seq: seq++,
          action: 'escalate_human',
          automatic: false,
          willAutoExecute: false,
          description: `资源不可用且自动重试已达上限（${max} 次），需人工介入：检查网关健康状态与配额，注册备用网关，或放宽任务的模型要求`,
          payload: { attempts: input.attempts },
        });
      }
      continue;
    }
    steps.push({
      seq: seq++,
      action: 'escalate_human',
      automatic: false,
      willAutoExecute: false,
      description: '任务被人工标记为 blocked，需人工确认后恢复（改回 todo 或 in_progress）',
      payload: {},
    });
  }
  return steps;
}
