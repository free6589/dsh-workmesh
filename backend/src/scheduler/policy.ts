/**
 * 模型调度策略引擎（纯函数、确定性、无 IO）。
 *
 * 输入：任务要求（能力/上下文/偏好）、模型目录、网关资源状态（健康/配额/负载）、项目与任务优先级。
 * 输出：确定性的网关级选择（选定 + 降级链）与逐条可追溯的决策理由。
 *
 * 评分模型（固定权重常量，保证「同输入 → 同输出」）：
 *   score = 健康×0.35 + 配额余量×0.30 + 上下文契合×0.15 + 模型偏好×0.20 − 争用惩罚
 * 硬性淘汰：网关未注册/禁用/unavailable、能力缺失、上下文不满足、配额耗尽、
 *            degraded 且任务声明不允许降级。
 * 争用惩罚：网关使用率 > 0.6 且归一化优先级 < 0.7 时，低优任务让出高负载网关；
 *            高优任务（大任务优先级或大项目优先级）不受影响。
 */
import type {
  CandidateEvaluation,
  GatewayResource,
  ResourceUsage,
  SchedulingContext,
  SchedulingDecisionCore,
  SelectedResource,
} from './types.js';

/** 评分权重（固定常量；调整需同步单元测试）。 */
export const POLICY_WEIGHTS = {
  health: 0.35,
  quota: 0.3,
  context: 0.15,
  preferredModel: 0.2,
} as const;

/** degraded 网关的健康因子（healthy = 1）。 */
export const DEGRADED_HEALTH_FACTOR = 0.4;
/** 上下文契合因子在窗口达到最小要求的该倍数时记满分（避免为小任务浪费超大窗口）。 */
export const CONTEXT_HEADROOM_MULTIPLIER = 2;
/** 任务未声明最小上下文时的中性契合因子。 */
export const NEUTRAL_CONTEXT_FACTOR = 0.5;
/** 网关使用率超过该阈值视为争用。 */
export const CONTENTION_USAGE_THRESHOLD = 0.6;
/** 归一化优先级（(任务优先级+项目优先级)/20）低于该值的任务受争用惩罚。 */
export const CONTENTION_PRIORITY_FLOOR = 0.7;
/** 争用惩罚系数：超出阈值的用量 × 该系数 计入扣分。 */
export const CONTENTION_PENALTY_FACTOR = 0.5;

/** 同分时的网关类型偏好序（账号池网关 → 共享聚合网关 → 独立注册端点）。 */
export const GATEWAY_KIND_ORDER = ['agent2api', 'bifrost', 'independent'] as const;

const REJECT_LABELS: Record<string, string> = {
  gateway_unknown: '网关未注册',
  gateway_disabled: '网关已禁用',
  gateway_unavailable: '网关不可用',
  gateway_degraded_not_allowed: '任务不接受降级网关',
  missing_capability: '能力缺失',
  context_window_unknown: '上下文窗口未知',
  context_window_too_small: '上下文窗口不足',
  quota_exhausted: '配额已耗尽',
};

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 优先级统一压到 0..10（tasks.priority 与 settings 项目权重同尺度）。 */
export function clampPriority(value: number): number {
  return Math.min(10, Math.max(0, value));
}

/** 归一化优先级：任务与项目优先级（各 0..10）合并到 0..1。 */
export function normalizedPriority(taskPriority: number, projectPriority: number): number {
  return clamp01((clampPriority(taskPriority) + clampPriority(projectPriority)) / 20);
}

export function gatewayKindRank(kind: string): number {
  const index = GATEWAY_KIND_ORDER.indexOf(kind as (typeof GATEWAY_KIND_ORDER)[number]);
  return index === -1 ? GATEWAY_KIND_ORDER.length : index;
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 取该 (网关, 模型) 相关的最大使用率：模型级条目优先，网关级条目兜底。 */
function maxUsageRatio(usage: ResourceUsage[], gatewayId: string, modelId: string): number {
  let ratio = 0;
  for (const entry of usage) {
    if (entry.gatewayId !== gatewayId) continue;
    if (entry.modelId !== undefined && entry.modelId !== modelId) continue;
    if (entry.usedRatio > ratio) ratio = entry.usedRatio;
  }
  return Math.max(0, ratio);
}

/**
 * 逐条评估目录候选：硬性淘汰记录原因码，合格者按固定权重打分。
 * 输出保持目录输入顺序（排序只发生在 selectResource），保证可追溯。
 */
export function evaluateCandidates(ctx: SchedulingContext): CandidateEvaluation[] {
  const gateways = new Map<string, GatewayResource>(ctx.gateways.map((g) => [g.id, g]));
  const req = ctx.request.requirements;
  const allowDegraded = req.allowDegraded ?? true;
  const priority = normalizedPriority(ctx.request.taskPriority, ctx.projectPriority);

  const evaluations: CandidateEvaluation[] = [];
  for (const entry of ctx.catalog) {
    const reasons: string[] = [];
    const codes: string[] = [];
    const gateway = gateways.get(entry.gatewayId);

    if (!gateway) {
      codes.push('gateway_unknown');
      reasons.push(`目录条目 ${entry.modelId} 引用的网关 ${entry.gatewayId} 未注册`);
    } else {
      if (!gateway.enabled) {
        codes.push('gateway_disabled');
        reasons.push(`网关 ${gateway.name}(${gateway.id}) 已禁用`);
      }
      if (gateway.health === 'unavailable') {
        codes.push('gateway_unavailable');
        reasons.push(`网关 ${gateway.name}(${gateway.id}) 健康状态为 unavailable`);
      }
      if (gateway.health === 'degraded' && !allowDegraded) {
        codes.push('gateway_degraded_not_allowed');
        reasons.push(`网关 ${gateway.name}(${gateway.id}) 处于 degraded 且任务不允许使用降级网关`);
      }
    }

    const missing = req.requiredCapabilities.filter((cap) => !entry.capabilities.includes(cap));
    if (missing.length > 0) {
      codes.push('missing_capability');
      reasons.push(`模型缺少任务要求的能力：${missing.join('、')}`);
    }

    if (req.minContextWindow !== undefined) {
      if (entry.contextWindow === null) {
        codes.push('context_window_unknown');
        reasons.push(`模型未上报上下文窗口，无法确认满足最小 ${req.minContextWindow} tokens 的要求`);
      } else if (entry.contextWindow < req.minContextWindow) {
        codes.push('context_window_too_small');
        reasons.push(`上下文窗口 ${entry.contextWindow} tokens 小于任务要求的 ${req.minContextWindow} tokens`);
      }
    }

    const usageRatio = gateway !== undefined ? maxUsageRatio(ctx.usage, entry.gatewayId, entry.modelId) : 0;
    if (usageRatio >= 1) {
      codes.push('quota_exhausted');
      reasons.push(`资源使用率 ${Math.min(usageRatio, 9.99).toFixed(2)} 已达上限`);
    }

    if (codes.length > 0 || gateway === undefined) {
      evaluations.push({
        gatewayId: entry.gatewayId,
        gatewayKind: gateway?.kind ?? 'independent',
        modelId: entry.modelId,
        eligible: false,
        score: null,
        reasonCodes: codes,
        reasons,
      });
      continue;
    }

    const healthFactor = gateway.health === 'healthy' ? 1 : DEGRADED_HEALTH_FACTOR;
    const quotaFactor = clamp01(1 - usageRatio);
    let contextFactor = NEUTRAL_CONTEXT_FACTOR;
    if (req.minContextWindow !== undefined && entry.contextWindow !== null) {
      contextFactor = clamp01(entry.contextWindow / (req.minContextWindow * CONTEXT_HEADROOM_MULTIPLIER));
    }
    const preferFactor =
      req.preferredModel !== undefined && entry.modelId === req.preferredModel ? 1 : 0;
    const contentionPenalty =
      usageRatio > CONTENTION_USAGE_THRESHOLD && priority < CONTENTION_PRIORITY_FLOOR
        ? (usageRatio - CONTENTION_USAGE_THRESHOLD) * CONTENTION_PENALTY_FACTOR
        : 0;
    const score = round3(
      POLICY_WEIGHTS.health * healthFactor +
        POLICY_WEIGHTS.quota * quotaFactor +
        POLICY_WEIGHTS.context * contextFactor +
        POLICY_WEIGHTS.preferredModel * preferFactor -
        contentionPenalty,
    );
    evaluations.push({
      gatewayId: entry.gatewayId,
      gatewayKind: gateway.kind,
      modelId: entry.modelId,
      eligible: true,
      score,
      reasonCodes: ['ok'],
      reasons: ['满足全部硬性要求'],
      scoreBreakdown: {
        healthFactor,
        quotaFactor,
        contextFactor,
        preferFactor,
        contentionPenalty: round3(contentionPenalty),
      },
    });
  }
  return evaluations;
}

/**
 * 从候选中选出资源：得分降序，同分按网关类型偏好序、网关 id、模型 id 字典序
 * 逐级打破平局 —— 全程确定性。首个为 selected，其余构成降级链。
 */
export function selectResource(ctx: SchedulingContext): SchedulingDecisionCore {
  const evaluations = evaluateCandidates(ctx);
  const gateways = new Map<string, GatewayResource>(ctx.gateways.map((g) => [g.id, g]));
  const eligible = evaluations
    .filter((e) => e.eligible && e.score !== null)
    .sort(
      (a, b) =>
        b.score! - a.score! ||
        gatewayKindRank(a.gatewayKind) - gatewayKindRank(b.gatewayKind) ||
        (a.gatewayId < b.gatewayId ? -1 : a.gatewayId > b.gatewayId ? 1 : 0) ||
        (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0),
    );

  function toSelected(evaluation: CandidateEvaluation): SelectedResource {
    return {
      gatewayId: evaluation.gatewayId,
      gatewayName: gateways.get(evaluation.gatewayId)?.name ?? evaluation.gatewayId,
      gatewayKind: evaluation.gatewayKind,
      modelId: evaluation.modelId,
      score: evaluation.score ?? 0,
    };
  }

  const best = eligible[0];
  const selected = best !== undefined ? toSelected(best) : null;
  const fallbacks = eligible.slice(1).map(toSelected);

  const req = ctx.request.requirements;
  const rationale: string[] = [];
  rationale.push(
    `输入：任务 ${ctx.request.taskId}（项目 ${ctx.request.projectId}）｜任务优先级 ${ctx.request.taskPriority}｜项目优先级 ${ctx.projectPriority}｜要求能力 [${req.requiredCapabilities.join('、') || '无'}]` +
      (req.minContextWindow !== undefined ? `｜最小上下文 ${req.minContextWindow} tokens` : '') +
      (req.preferredModel !== undefined ? `｜偏好模型 ${req.preferredModel}` : ''),
  );

  const rejected = evaluations.filter((e) => !e.eligible);
  const counts = new Map<string, number>();
  for (const e of rejected) {
    const label = REJECT_LABELS[e.reasonCodes[0] ?? ''] ?? e.reasonCodes[0] ?? '其他';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([label, n]) => `${label} ${n}`).join('、');
  rationale.push(
    `候选：评估目录条目 ${evaluations.length} 条，合格 ${eligible.length} 条，落选 ${rejected.length} 条${summary !== '' ? `（${summary}）` : ''}`,
  );

  if (best !== undefined && selected !== null) {
    const breakdown = best.scoreBreakdown;
    if (breakdown !== undefined) {
      const parts = [
        `健康 ${breakdown.healthFactor.toFixed(2)}×${POLICY_WEIGHTS.health}`,
        `配额余量 ${breakdown.quotaFactor.toFixed(2)}×${POLICY_WEIGHTS.quota}`,
        `上下文契合 ${breakdown.contextFactor.toFixed(2)}×${POLICY_WEIGHTS.context}`,
        `模型偏好 ${breakdown.preferFactor.toFixed(2)}×${POLICY_WEIGHTS.preferredModel}`,
      ];
      if (breakdown.contentionPenalty > 0) {
        parts.push(`争用惩罚 -${breakdown.contentionPenalty.toFixed(3)}`);
      }
      rationale.push(
        `选定 ${selected.gatewayId}/${selected.modelId}（${selected.gatewayKind}）：得分 ${selected.score.toFixed(3)} ＝ ${parts.join(' ＋ ')}`,
      );
    }
    fallbacks.forEach((f, i) =>
      rationale.push(`降级备选 ${i + 1}：${f.gatewayId}/${f.modelId}（${f.gatewayKind}，得分 ${f.score.toFixed(3)}）`),
    );
    const contended = eligible.filter((e) => (e.scoreBreakdown?.contentionPenalty ?? 0) > 0);
    if (contended.length > 0) {
      rationale.push(
        `争用惩罚：${contended
          .map((e) => `${e.gatewayId}/${e.modelId} -${e.scoreBreakdown?.contentionPenalty.toFixed(3)}`)
          .join('、')}（网关高负载，低优任务让位，详见候选评估）`,
      );
    }
  } else {
    rationale.push(`无可用资源：${summary || '模型目录为空，无任何候选'}`);
  }

  return {
    taskId: ctx.request.taskId,
    projectId: ctx.request.projectId,
    selected,
    fallbacks,
    candidates: evaluations,
    rationale,
    blocked: selected === null,
    taskPriority: ctx.request.taskPriority,
    projectPriority: ctx.projectPriority,
    requirements: { ...ctx.request.requirements },
  };
}
