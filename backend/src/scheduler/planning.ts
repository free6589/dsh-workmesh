/**
 * 跨项目协同优先级与全局派发顺序。
 *
 * 有效优先级 = 任务优先级 + 项目权重×0.1 + 跨项目协同加成：
 * - 项目权重来自 settings（0..10，缺省 5），让高优项目在全局队列中自然靠前；
 * - 跨项目协同加成：本任务完成后能直接解锁的其他项目等待任务，按对方项目权重
 *   计 0.2 权重/条，累计上限 3.0 —— 让「解锁高优项目」的任务提前；
 * - 排序完全确定：有效优先级降序，平分时按 taskId 字典序。
 */
import type { TaskStatus } from '../types/entities.js';
import { clampPriority } from './policy.js';

/** 项目权重缺省值（settings 未登记该项目时）。 */
export const NEUTRAL_PROJECT_PRIORITY = 5;
/** 项目权重折算到有效优先级的系数（0..10 → 0..1）。 */
export const PROJECT_WEIGHT_FACTOR = 0.1;
/** 每个可解锁的跨项目等待任务带来的加成系数。 */
export const CROSS_PROJECT_BOOST_FACTOR = 0.2;
/** 跨项目协同加成上限。 */
export const CROSS_PROJECT_BOOST_CAP = 3;

export interface QueueTaskSnapshot {
  taskId: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  priority: number;
  /** 该任务依赖的任务 id 列表（DAG 上游）。 */
  dependsOn: string[];
}

export interface DispatchOrderEntry {
  taskId: string;
  projectId: string;
  basePriority: number;
  projectWeight: number;
  crossProjectBoost: number;
  effectivePriority: number;
  /** 加成理由（可追溯）；无加成时为空数组。 */
  reasons: string[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 计算全局派发顺序。
 * - 候选：status = todo 的任务（in_progress 已在执行，blocked 需先解除阻塞）；
 * - 协同加成的「等待任务」：status ∈ {todo, blocked} 且直接依赖本任务、且项目不同；
 * - 同一 (本任务, 对方项目) 只计一次加成，避免同项目多条依赖重复抬分。
 */
export function computeDispatchOrder(
  tasks: QueueTaskSnapshot[],
  projectPriorities: Record<string, number> = {},
): DispatchOrderEntry[] {
  const waiting = tasks.filter((t) => t.status === 'todo' || t.status === 'blocked');
  const projectOf = new Map<string, string>(tasks.map((t) => [t.taskId, t.projectId]));

  // taskId -> 依赖它的跨项目等待任务（按对方项目去重，取该项目权重代表）
  const crossProjectDependents = new Map<string, Map<string, QueueTaskSnapshot>>();
  for (const waiter of waiting) {
    for (const dep of waiter.dependsOn) {
      const upstreamProject = projectOf.get(dep);
      // 上游任务不在快照内时无法判定项目归属，保守不计加成
      if (upstreamProject === undefined || upstreamProject === waiter.projectId) continue;
      let byProject = crossProjectDependents.get(dep);
      if (byProject === undefined) {
        byProject = new Map<string, QueueTaskSnapshot>();
        crossProjectDependents.set(dep, byProject);
      }
      if (!byProject.has(waiter.projectId)) byProject.set(waiter.projectId, waiter);
    }
  }

  const entries = tasks
    .filter((t) => t.status === 'todo')
    .map((task) => {
      const base = clampPriority(task.priority);
      const projectWeight = clampPriority(projectPriorities[task.projectId] ?? NEUTRAL_PROJECT_PRIORITY);
      const reasons: string[] = [];
      let boost = 0;
      const byProject = crossProjectDependents.get(task.taskId);
      if (byProject !== undefined) {
        for (const waiter of byProject.values()) {
          const weight = clampPriority(projectPriorities[waiter.projectId] ?? NEUTRAL_PROJECT_PRIORITY);
          const add = weight * CROSS_PROJECT_BOOST_FACTOR;
          boost = Math.min(boost + add, CROSS_PROJECT_BOOST_CAP);
          reasons.push(
            `跨项目协同：完成后可解锁项目 ${waiter.projectId} 的任务 ${waiter.taskId}（项目权重 ${weight}，+${round2(add)}）`,
          );
        }
      }
      return {
        taskId: task.taskId,
        projectId: task.projectId,
        basePriority: base,
        projectWeight,
        crossProjectBoost: round2(boost),
        effectivePriority: round2(base + projectWeight * PROJECT_WEIGHT_FACTOR + boost),
        reasons,
      };
    });

  return entries.sort(
    (a, b) =>
      b.effectivePriority - a.effectivePriority ||
      (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
  );
}
