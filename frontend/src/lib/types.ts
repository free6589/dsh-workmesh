/**
 * 前端领域类型。
 * 项目六态与 backend/src/services/projects.ts 的 PROJECT_STATUSES 保持一致。
 */

export const PROJECT_STATUSES = [
  'Planning',
  'Active',
  'Paused',
  'Maintenance',
  'Completed',
  'Archived',
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** 与后端 actions: activate|pause|resume|maintain|complete|archive 对齐。 */
export type ProjectAction =
  | 'activate'
  | 'pause'
  | 'resume'
  | 'maintain'
  | 'complete'
  | 'archive';

/** 项目总览卡片的聚合视图：后端 project + /stats 聚合（演示模式下由本地生成）。 */
export interface ProjectSummary {
  id: string;
  name: string;
  /** 项目目标（对应后端 description）。 */
  goal: string;
  status: ProjectStatus;
  /** 整体进度 0–100 整数。 */
  progress: number;
  moduleCount: number;
  totalTasks: number;
  inProgressTasks: number;
  blockedTasks: number;
  /** 当前阶段（后端 current_phase.name）。 */
  currentStage: string | null;
  /** 下一步计划（前端扩展字段，后端暂未存储）。 */
  nextSteps: string | null;
  /** 最近活动描述（前端扩展字段）。 */
  lastActivity: string | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

/** 新建 / 编辑项目的入参。 */
export interface ProjectInput {
  name: string;
  goal: string;
  status: ProjectStatus;
  progress: number;
  moduleCount: number;
  totalTasks: number;
  inProgressTasks: number;
  blockedTasks: number;
  currentStage: string | null;
  nextSteps: string | null;
}

/** 运行状态指示收敛为三态（后端 /health 的 ok/degraded，加不可达的 offline）。 */
export type RunHealth = 'ok' | 'degraded' | 'offline';

export interface RunStatusSnapshot {
  health: RunHealth;
  detail: string;
  checkedAt: string;
}
