/**
 * 调度器领域类型。
 *
 * 职责边界（重要，见 docs/ARCHITECTURE.md §3.2）：
 * - 调度器只做「网关级」模型/资源入口选择（在 Agent2API / Bifrost / 独立 API 之间），
 *   不实现 Agent2API 内部账户轮换，也不实现 Grok Workflow 的执行引擎逻辑；
 * - 调度器不直接调用模型 API 发起推理，决策结果（选定资源 + 降级链）由执行平面消费。
 */
import type { TaskStatus } from '../types/entities.js';

export type { TaskStatus };

/** 资源入口类型，与 gateways.type 对应；未识别的 type 一律按 independent 处理。 */
export type GatewayKind = 'agent2api' | 'bifrost' | 'independent';

export type GatewayHealthState = 'healthy' | 'degraded' | 'unavailable';

/** 任务对模型资源的要求（来自任务数据或 settings 中的覆盖配置）。 */
export interface TaskRequirements {
  /** 必须全部具备的模型能力标签，如 ['tools','vision']；空数组表示无能力要求。 */
  requiredCapabilities: string[];
  /** 任务上下文所需最小窗口（tokens）。 */
  minContextWindow?: number;
  /** 期望模型 ID（提示性偏好，非强制，参与评分）。 */
  preferredModel?: string;
  /** 是否允许使用 degraded 健康状态的网关，缺省允许（评分时打折）。 */
  allowDegraded?: boolean;
}

/** 网关资源入口（消费 gateway_adapters 提供的注册与健康数据）。 */
export interface GatewayResource {
  id: string;
  name: string;
  kind: GatewayKind;
  enabled: boolean;
  health: GatewayHealthState;
}

/** 模型目录条目：哪个网关提供哪个模型（来自 gateway_adapters 的目录快照）。 */
export interface ModelCatalogEntry {
  gatewayId: string;
  modelId: string;
  capabilities: string[];
  contextWindow: number | null;
}

/** 资源用量：配额/负载使用率（0..1+，>=1 视为耗尽）。 */
export interface ResourceUsage {
  gatewayId: string;
  /** 缺省表示网关级用量；指定时为模型级用量。 */
  modelId?: string;
  usedRatio: number;
}

/** 一次调度请求。 */
export interface SchedulingRequest {
  taskId: string;
  projectId: string;
  /** 任务自身优先级（tasks.priority，0..10 参与评分）。 */
  taskPriority: number;
  requirements: TaskRequirements;
}

/** 调度上下文：策略引擎的全部输入。 */
export interface SchedulingContext {
  request: SchedulingRequest;
  gateways: GatewayResource[];
  catalog: ModelCatalogEntry[];
  usage: ResourceUsage[];
  /** 项目优先级（0..10，settings 提供，缺省 5）。 */
  projectPriority: number;
}

/** 单个候选的评估记录（审计与追溯的最小单元）。 */
export interface CandidateEvaluation {
  gatewayId: string;
  gatewayKind: GatewayKind;
  modelId: string;
  eligible: boolean;
  /** null 表示被硬性条件淘汰，不参与打分。 */
  score: number | null;
  /**
   * 机器可读原因码：ok / gateway_unknown / gateway_disabled / gateway_unavailable /
   * gateway_degraded_not_allowed / missing_capability / context_window_unknown /
   * context_window_too_small / quota_exhausted
   */
  reasonCodes: string[];
  /** 人读理由（中文），与 reasonCodes 顺序对应。 */
  reasons: string[];
  /** 得分构成（仅合格候选有）。 */
  scoreBreakdown?: {
    healthFactor: number;
    quotaFactor: number;
    contextFactor: number;
    preferFactor: number;
    contentionPenalty: number;
  };
}

export interface SelectedResource {
  gatewayId: string;
  gatewayName: string;
  gatewayKind: GatewayKind;
  modelId: string;
  score: number;
}

/** 策略引擎输出（不含主键/时间戳，由引擎补齐后落库）。 */
export interface SchedulingDecisionCore {
  taskId: string;
  projectId: string;
  selected: SelectedResource | null;
  /** 降级链（不含 selected），按得分降序；资源不可用时按序启用。 */
  fallbacks: SelectedResource[];
  /** 全部候选评估记录（含落选），保持目录评估顺序。 */
  candidates: CandidateEvaluation[];
  /** 决策理由（有序、可追溯，逐条引用输入与候选评估）。 */
  rationale: string[];
  /** true 表示无可用资源，任务应标记阻塞。 */
  blocked: boolean;
  taskPriority: number;
  projectPriority: number;
  requirements: TaskRequirements;
}

export interface SchedulingDecision extends SchedulingDecisionCore {
  decisionId: string;
  createdAt: string;
  /** 决策落地后创建的执行 run（queued），由执行平面消费；blocked 或未派发时缺省。 */
  runId?: string;
}

/** 落库到 audit_log 的决策记录（在 SchedulingDecision 上补充状态与尝试次数快照）。 */
export interface StoredDecisionRecord extends SchedulingDecision {
  taskStatusBefore: TaskStatus;
  taskStatusAfter: TaskStatus;
  /** 本次决策之前已发生的历史决策次数（用于退避与升级判断）。 */
  attempts: number;
}
