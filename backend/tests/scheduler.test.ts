import { describe, expect, it } from 'vitest';
import {
  canTransitionTask,
  computeDispatchOrder,
  detectBlocking,
  evaluateCandidates,
  isTerminalTaskStatus,
  planNextSteps,
  selectResource,
  assertTaskTransition,
  normalizeGatewayKind,
  normalizeRequirements,
  POLICY_WEIGHTS,
  type GatewayResource,
  type ModelCatalogEntry,
  type QueueTaskSnapshot,
  type ResourceUsage,
  type SchedulingContext,
} from '../src/scheduler/index.js';
import { ValidationError } from '../src/db/errors.js';

// ---------- 测试数据 ----------

const gwA: GatewayResource = {
  id: 'gw-a',
  name: 'bifrost-main',
  kind: 'bifrost',
  enabled: true,
  health: 'healthy',
};
const gwB: GatewayResource = {
  id: 'gw-b',
  name: 'ind-free',
  kind: 'independent',
  enabled: true,
  health: 'healthy',
};

const baseCatalog: ModelCatalogEntry[] = [
  { gatewayId: 'gw-a', modelId: 'model-pro', capabilities: ['tools', 'vision'], contextWindow: 128000 },
  { gatewayId: 'gw-b', modelId: 'model-free', capabilities: ['tools'], contextWindow: 32000 },
];

function makeContext(overrides: Partial<SchedulingContext> = {}): SchedulingContext {
  return {
    request: {
      taskId: 'task-1',
      projectId: 'proj-1',
      taskPriority: 5,
      requirements: { requiredCapabilities: ['tools'] },
    },
    gateways: [gwA, gwB],
    catalog: baseCatalog,
    usage: [],
    projectPriority: 5,
    ...overrides,
  };
}

// ---------- 策略引擎：确定性选择与理由 ----------

describe('policy.selectResource（确定性网关级选择）', () => {
  it('同一输入两次调用输出完全一致，且理由可追溯到候选评估', () => {
    const ctx = makeContext();
    const first = selectResource(ctx);
    const second = selectResource(ctx);
    expect(first).toEqual(second);

    expect(first.selected).toEqual({
      gatewayId: 'gw-a',
      gatewayName: 'bifrost-main',
      gatewayKind: 'bifrost',
      modelId: 'model-pro',
      score: expect.any(Number),
    });
    expect(first.fallbacks).toEqual([
      {
        gatewayId: 'gw-b',
        gatewayName: 'ind-free',
        gatewayKind: 'independent',
        modelId: 'model-free',
        score: expect.any(Number),
      },
    ]);
    expect(first.blocked).toBe(false);
    expect(first.candidates.map((c) => c.reasonCodes)).toEqual([['ok'], ['ok']]);
    // 理由逐条可追溯：输入行、候选统计行、选定行（引用网关/模型与得分构成）
    expect(first.rationale[0]).toContain('任务 task-1');
    expect(first.rationale[0]).toContain('要求能力 [tools]');
    expect(first.rationale[1]).toContain('合格 2 条');
    expect(first.rationale[2]).toContain('选定 gw-a/model-pro');
    expect(first.rationale[2]).toContain(`健康 1.00×${POLICY_WEIGHTS.health}`);
  });

  it('能力缺失的候选被淘汰且理由可追溯', () => {
    const core = selectResource(
      makeContext({ request: { taskId: 'task-1', projectId: 'proj-1', taskPriority: 5, requirements: { requiredCapabilities: ['vision'] } } }),
    );
    expect(core.selected?.modelId).toBe('model-pro');
    const rejected = core.candidates.find((c) => c.modelId === 'model-free');
    expect(rejected?.eligible).toBe(false);
    expect(rejected?.reasonCodes).toContain('missing_capability');
    expect(rejected?.reasons.join('')).toContain('vision');
  });

  it('上下文窗口不足/未知的候选被淘汰；全部淘汰时决策阻塞并给出汇总', () => {
    const narrow = selectResource(
      makeContext({
        request: { taskId: 'task-1', projectId: 'proj-1', taskPriority: 5, requirements: { requiredCapabilities: [], minContextWindow: 64000 } },
      }),
    );
    expect(narrow.selected?.modelId).toBe('model-pro');
    expect(narrow.candidates.find((c) => c.modelId === 'model-free')?.reasonCodes).toContain(
      'context_window_too_small',
    );

    const unknownWindow = evaluateCandidates(
      makeContext({
        request: { taskId: 'task-1', projectId: 'proj-1', taskPriority: 5, requirements: { requiredCapabilities: [], minContextWindow: 1000 } },
        catalog: [{ gatewayId: 'gw-a', modelId: 'model-x', capabilities: [], contextWindow: null }],
      }),
    );
    expect(unknownWindow[0]?.reasonCodes).toContain('context_window_unknown');

    const impossible = selectResource(
      makeContext({
        request: { taskId: 'task-1', projectId: 'proj-1', taskPriority: 5, requirements: { requiredCapabilities: [], minContextWindow: 1_000_000 } },
      }),
    );
    expect(impossible.blocked).toBe(true);
    expect(impossible.selected).toBeNull();
    expect(impossible.rationale.at(-1)).toContain('无可用资源');
    expect(impossible.rationale.at(-1)).toContain('上下文窗口不足 2');
  });

  it('配额耗尽的候选被淘汰（模型级与网关级用量都生效）', () => {
    const modelLevel = selectResource(
      makeContext({ usage: [{ gatewayId: 'gw-a', modelId: 'model-pro', usedRatio: 1 }] }),
    );
    expect(modelLevel.selected?.gatewayId).toBe('gw-b');
    expect(modelLevel.candidates.find((c) => c.modelId === 'model-pro')?.reasonCodes).toContain(
      'quota_exhausted',
    );

    const gatewayLevel = selectResource(
      makeContext({ usage: [{ gatewayId: 'gw-a', usedRatio: 1.2 }] }),
    );
    expect(gatewayLevel.selected?.gatewayId).toBe('gw-b');
  });

  it('degraded 网关扣分；任务声明不允许降级时直接淘汰', () => {
    const degradedB: GatewayResource = { ...gwB, health: 'degraded' };
    const penalized = selectResource(makeContext({ gateways: [gwA, degradedB] }));
    expect(penalized.selected?.gatewayId).toBe('gw-a');

    const onlyDegraded = selectResource(
      makeContext({
        gateways: [degradedB],
        catalog: [baseCatalog[1] as ModelCatalogEntry],
        request: { taskId: 'task-1', projectId: 'proj-1', taskPriority: 5, requirements: { requiredCapabilities: ['tools'], allowDegraded: false } },
      }),
    );
    expect(onlyDegraded.blocked).toBe(true);
    expect(onlyDegraded.candidates[0]?.reasonCodes).toContain('gateway_degraded_not_allowed');
  });

  it('资源不可用时自动降级到备用通道，且理由记录淘汰原因', () => {
    const down: GatewayResource = { ...gwA, health: 'unavailable' };
    const core = selectResource(makeContext({ gateways: [down, gwB] }));
    expect(core.selected?.gatewayId).toBe('gw-b');
    expect(core.selected?.gatewayKind).toBe('independent');
    expect(core.fallbacks).toEqual([]);
    const rejected = core.candidates.find((c) => c.gatewayId === 'gw-a');
    expect(rejected?.eligible).toBe(false);
    expect(rejected?.reasonCodes).toContain('gateway_unavailable');
    expect(core.rationale.join('\n')).toContain('网关不可用 1');
    // 恢复健康后回到原选择（同输入同输出）
    expect(selectResource(makeContext()).selected?.gatewayId).toBe('gw-a');
  });

  it('低优先级任务在高负载网关上让位，高优先级任务不受争用惩罚', () => {
    const shared: Partial<SchedulingContext> = {
      gateways: [gwA, { ...gwB, health: 'degraded' }],
      usage: [{ gatewayId: 'gw-a', usedRatio: 0.95 }],
      catalog: baseCatalog,
    };
    const requirements = { requiredCapabilities: ['tools'], preferredModel: 'model-pro' };

    const lowPriority = selectResource(
      makeContext({
        ...shared,
        request: { taskId: 'task-1', projectId: 'proj-1', taskPriority: 2, requirements },
      }),
    );
    const proCandidate = lowPriority.candidates.find((c) => c.modelId === 'model-pro');
    expect(proCandidate?.scoreBreakdown?.contentionPenalty).toBeCloseTo(0.175, 3);
    expect(lowPriority.selected?.gatewayId).toBe('gw-b');
    expect(lowPriority.rationale.join('\n')).toContain('争用惩罚');

    const highPriority = selectResource(
      makeContext({
        ...shared,
        request: { taskId: 'task-1', projectId: 'proj-1', taskPriority: 9, requirements },
      }),
    );
    expect(highPriority.selected?.gatewayId).toBe('gw-a');
    expect(
      highPriority.candidates.find((c) => c.modelId === 'model-pro')?.scoreBreakdown
        ?.contentionPenalty,
    ).toBe(0);
  });

  it('同分时按网关类型序与 id 字典序打破平局，结果完全确定', () => {
    const gwX: GatewayResource = { id: 'gw-x', name: 'x', kind: 'independent', enabled: true, health: 'healthy' };
    const gwY: GatewayResource = { id: 'gw-y', name: 'y', kind: 'independent', enabled: true, health: 'healthy' };
    const core = selectResource(
      makeContext({
        gateways: [gwY, gwX],
        catalog: [
          { gatewayId: 'gw-y', modelId: 'model-t', capabilities: [], contextWindow: 8000 },
          { gatewayId: 'gw-x', modelId: 'model-t', capabilities: [], contextWindow: 8000 },
        ],
        request: { taskId: 'task-1', projectId: 'proj-1', taskPriority: 0, requirements: { requiredCapabilities: [] } },
      }),
    );
    expect(core.selected?.gatewayId).toBe('gw-x');
    expect(core.fallbacks.map((f) => f.gatewayId)).toEqual(['gw-y']);
  });
});

// ---------- 任务状态机 ----------

describe('state：任务状态机', () => {
  it('允许的迁移与终态判定', () => {
    expect(canTransitionTask('todo', 'in_progress')).toBe(true);
    expect(canTransitionTask('todo', 'blocked')).toBe(true);
    expect(canTransitionTask('in_progress', 'blocked')).toBe(true);
    expect(canTransitionTask('blocked', 'todo')).toBe(true);
    expect(canTransitionTask('todo', 'done')).toBe(false);
    expect(canTransitionTask('done', 'todo')).toBe(false);
    expect(isTerminalTaskStatus('done')).toBe(true);
    expect(isTerminalTaskStatus('cancelled')).toBe(true);
    expect(isTerminalTaskStatus('blocked')).toBe(false);
    expect(() => assertTaskTransition('in_progress', 'blocked')).not.toThrow();
    expect(() => assertTaskTransition('done', 'todo')).toThrow(ValidationError);
    expect(() => assertTaskTransition('todo', 'done')).toThrow(/非法任务状态迁移/);
  });
});

// ---------- 阻塞识别与下一步安排 ----------

describe('state：阻塞识别', () => {
  it('依赖未完成 / 资源不可用 / 人工标记三类原因可叠加且顺序稳定', () => {
    const report = detectBlocking({
      task: { id: 'task-1', status: 'blocked' },
      dependencies: [
        { taskId: 'dep-done', title: '已完成', status: 'done' },
        { taskId: 'dep-open', title: '前置任务', status: 'in_progress' },
      ],
      decision: { blocked: true, rationale: ['输入：…', '无可用资源：网关不可用 1'] },
    });
    expect(report.blocked).toBe(true);
    expect(report.causes.map((c) => c.code)).toEqual([
      'dependency_unmet',
      'resource_unavailable',
      'manually_blocked',
    ]);
    expect(report.causes[0]?.dependsOnTaskId).toBe('dep-open');
    expect(report.causes[0]?.message).toContain('前置任务');
    expect(report.causes[1]?.message).toContain('无可用资源');
  });

  it('无未满足条件时不判定阻塞', () => {
    const report = detectBlocking({
      task: { id: 'task-1', status: 'in_progress' },
      dependencies: [{ taskId: 'dep', title: '前置', status: 'done' }],
      decision: { blocked: false, rationale: ['选定 gw-a/model-pro'] },
    });
    expect(report.blocked).toBe(false);
    expect(report.causes).toEqual([]);
  });

  it('已取消的依赖会点名需要人工处理', () => {
    const report = detectBlocking({
      task: { id: 'task-1', status: 'todo' },
      dependencies: [{ taskId: 'dep-x', title: '被取消', status: 'cancelled' }],
    });
    expect(report.causes[0]?.code).toBe('dependency_unmet');
    expect(report.causes[0]?.message).toContain('已取消');
  });
});

describe('state：无人值守的下一步安排', () => {
  const blockedReport: ReturnType<typeof detectBlocking> = {
    taskId: 'task-1',
    blocked: true,
    causes: [{ code: 'resource_unavailable', message: '无可用资源：网关不可用 1' }],
  };

  it('资源不可用时按尝试次数指数退避并给出 retryAt', () => {
    const now = '2026-11-08T00:00:00.000Z';
    const first = planNextSteps({ task: { id: 'task-1', title: 't' }, blocking: blockedReport, attempts: 0, unattended: true, now });
    expect(first[0]?.action).toBe('requeue_with_backoff');
    expect(first[0]?.automatic).toBe(true);
    expect(first[0]?.willAutoExecute).toBe(true);
    expect(first[0]?.retryDelayMs).toBe(60_000);
    expect(first[0]?.retryAt).toBe('2026-11-08T00:01:00.000Z');

    const second = planNextSteps({ task: { id: 'task-1', title: 't' }, blocking: blockedReport, attempts: 1, unattended: true, now });
    expect(second[0]?.retryDelayMs).toBe(120_000);

    const third = planNextSteps({ task: { id: 'task-1', title: 't' }, blocking: blockedReport, attempts: 2, unattended: true, now });
    expect(third[0]?.retryDelayMs).toBe(240_000);
  });

  it('达到重试上限或人工标记时升级人工（automatic=false）', () => {
    const escalated = planNextSteps({ task: { id: 'task-1', title: 't' }, blocking: blockedReport, attempts: 3, unattended: true, now: '2026-11-08T00:00:00.000Z' });
    expect(escalated[0]?.action).toBe('escalate_human');
    expect(escalated[0]?.automatic).toBe(false);
    expect(escalated[0]?.willAutoExecute).toBe(false);
    expect(escalated[0]?.description).toContain('人工介入');

    const manual = planNextSteps({
      task: { id: 'task-1', title: 't' },
      blocking: { taskId: 'task-1', blocked: true, causes: [{ code: 'manually_blocked', message: '人工标记' }] },
      attempts: 0,
      unattended: true,
      now: '2026-11-08T00:00:00.000Z',
    });
    expect(manual[0]?.action).toBe('escalate_human');
    expect(manual[0]?.description).toContain('blocked');
  });

  it('依赖等待步骤排最前；willAutoExecute 跟随 unattended 开关', () => {
    const mixed = planNextSteps({
      task: { id: 'task-1', title: 't' },
      blocking: {
        taskId: 'task-1',
        blocked: true,
        causes: [
          { code: 'manually_blocked', message: '人工标记' },
          { code: 'dependency_unmet', dependsOnTaskId: 'dep-1', message: '依赖未完成' },
        ],
      },
      attempts: 0,
      unattended: false,
      now: '2026-11-08T00:00:00.000Z',
    });
    expect(mixed.map((s) => s.action)).toEqual(['wait_dependency', 'escalate_human']);
    expect(mixed[0]?.automatic).toBe(true);
    expect(mixed[0]?.willAutoExecute).toBe(false);
    expect(mixed[0]?.payload?.dependsOnTaskId).toBe('dep-1');
  });
});

// ---------- 跨项目协同优先级 ----------

describe('planning.computeDispatchOrder（跨项目协同优先级）', () => {
  function snap(partial: Partial<QueueTaskSnapshot> & { taskId: string; projectId: string }): QueueTaskSnapshot {
    return { title: partial.taskId, status: 'todo', priority: 0, dependsOn: [], ...partial };
  }

  it('高优项目的等待任务会抬升解锁它的跨项目任务', () => {
    const tasks: QueueTaskSnapshot[] = [
      snap({ taskId: 'task-a', projectId: 'proj-1' }),
      snap({ taskId: 'task-b', projectId: 'proj-2' }),
      snap({ taskId: 'task-d', projectId: 'proj-2', dependsOn: ['task-a'] }),
    ];
    const order = computeDispatchOrder(tasks, { 'proj-1': 5, 'proj-2': 9 });
    const entryA = order.find((e) => e.taskId === 'task-a');
    expect(order[0]?.taskId).toBe('task-a');
    expect(entryA?.crossProjectBoost).toBeCloseTo(1.8, 2);
    expect(entryA?.effectivePriority).toBeCloseTo(0.5 + 1.8, 2);
    expect(entryA?.reasons[0]).toContain('跨项目协同');
    expect(entryA?.reasons[0]).toContain('task-d');
  });

  it('同项目依赖不加成；未知上游项目保守跳过；blocked 等待任务仍计入', () => {
    const sameProject = computeDispatchOrder(
      [
        snap({ taskId: 'task-a', projectId: 'proj-1' }),
        snap({ taskId: 'task-d', projectId: 'proj-1', dependsOn: ['task-a'] }),
      ],
      {},
    );
    expect(sameProject[0]?.crossProjectBoost).toBe(0);
    expect(sameProject[0]?.reasons).toEqual([]);

    const ghost = computeDispatchOrder(
      [
        snap({ taskId: 'task-a', projectId: 'proj-1' }),
        snap({ taskId: 'task-d', projectId: 'proj-2', dependsOn: ['ghost'] }),
      ],
      { 'proj-2': 9 },
    );
    expect(ghost[0]?.crossProjectBoost).toBe(0);

    const withBlocked = computeDispatchOrder(
      [
        snap({ taskId: 'task-a', projectId: 'proj-1' }),
        snap({ taskId: 'task-d', projectId: 'proj-2', status: 'blocked', dependsOn: ['task-a'] }),
      ],
      { 'proj-2': 9 },
    );
    expect(withBlocked[0]?.crossProjectBoost).toBeCloseTo(1.8, 2);
  });

  it('加成封顶 3.0（按对方项目去重累计）；平分时按 taskId 字典序', () => {
    const many: QueueTaskSnapshot[] = [
      snap({ taskId: 'task-a', projectId: 'proj-1' }),
      ...['w1', 'w2', 'w3', 'w4'].map((projectId) =>
        snap({ taskId: `waiter-${projectId}`, projectId, dependsOn: ['task-a'] }),
      ),
    ];
    // 4 个不同项目的等待任务（缺省权重 5 → 各 +1.0），累计封顶 3.0
    const capped = computeDispatchOrder(many, {});
    expect(capped[0]?.crossProjectBoost).toBe(3);

    const tied = computeDispatchOrder(
      [snap({ taskId: 'task-b', projectId: 'proj-1' }), snap({ taskId: 'task-a', projectId: 'proj-1' })],
      {},
    );
    expect(tied.map((e) => e.taskId)).toEqual(['task-a', 'task-b']);
  });
});

// ---------- 端口归一化 ----------

describe('ports：配置归一化', () => {
  it('未知 gateway.type 按 independent 处理；非法任务要求显式报错', () => {
    expect(normalizeGatewayKind('agent2api')).toBe('agent2api');
    expect(normalizeGatewayKind('bifrost')).toBe('bifrost');
    expect(normalizeGatewayKind('openai-compatible')).toBe('independent');
    expect(() => normalizeRequirements({ requiredCapabilities: 'tools' })).toThrow(ValidationError);
    expect(() => normalizeRequirements({ requiredCapabilities: ['tools'], minContextWindow: -1 })).toThrow(
      ValidationError,
    );
    expect(normalizeRequirements({})).toEqual({ requiredCapabilities: [] });
    expect(normalizeRequirements({ requiredCapabilities: ['tools'], preferredModel: 'm' })).toEqual({
      requiredCapabilities: ['tools'],
      preferredModel: 'm',
    });
  });
});

// ---------- gateway_adapters 桥（只消费适配器接口） ----------

import { createPortsFromAdapters, mapAdapterHealth } from '../src/scheduler/ports-adapter.js';
import { SchedulerEngine } from '../src/scheduler/engine.js';
import type { GatewayAdapter, HealthReport, ModelCatalogResult } from '../src/adapters/types.js';

function mockAdapter(input: {
  id: string;
  kind: GatewayAdapter['kind'];
  name: string;
  catalog: ModelCatalogResult;
  health: HealthReport;
}): GatewayAdapter {
  return {
    kind: input.kind,
    config: { id: input.id, kind: input.kind, name: input.name, baseUrl: 'http://127.0.0.1:9', timeoutMs: 1000 },
    supportsChat: false,
    listModels: async () => input.catalog,
    getQuota: async () => ({ status: 'not_provided', reason: '网关未提供', fetchedAt: '2026-11-08T00:00:00.000Z' }),
    getHealth: async () => input.health,
  };
}

describe('ports-adapter：GatewayAdapter → SchedulerPorts 桥', () => {
  function health(status: HealthReport['status']): HealthReport {
    return { status, probeEndpoint: '/health', checkedAt: '2026-11-08T00:00:00.000Z' };
  }

  it('健康状态映射诚实：unreachable→unavailable，not_provided 不武断降级', () => {
    expect(mapAdapterHealth(health('ok'))).toBe('healthy');
    expect(mapAdapterHealth(health('degraded'))).toBe('degraded');
    expect(mapAdapterHealth(health('unreachable'))).toBe('unavailable');
    expect(mapAdapterHealth(health('not_provided'))).toBe('healthy');
  });

  it('桥接目录与健康快照；目录读取失败的网关不产生候选', async () => {
    const ports = await createPortsFromAdapters(
      [
        mockAdapter({
          id: 'gw-a',
          kind: 'bifrost',
          name: 'bifrost-main',
          catalog: {
            ok: true,
            models: [
              { id: 'model-pro', contextWindow: 128000, raw: {} },
              { id: 'model-mini', raw: {} },
            ],
          },
          health: health('ok'),
        }),
        mockAdapter({
          id: 'gw-b',
          kind: 'independent',
          name: 'ind-free',
          catalog: { ok: false, endpoint: '/models', error: '401' },
          health: health('degraded'),
        }),
      ],
      { usage: [{ gatewayId: 'gw-a', usedRatio: 0.2 }] },
    );

    expect(ports.listGateways()).toEqual([
      { id: 'gw-a', name: 'bifrost-main', kind: 'bifrost', enabled: true, health: 'healthy' },
      { id: 'gw-b', name: 'ind-free', kind: 'independent', enabled: true, health: 'degraded' },
    ]);
    expect(ports.listCatalog()).toEqual([
      { gatewayId: 'gw-a', modelId: 'model-pro', capabilities: [], contextWindow: 128000 },
      { gatewayId: 'gw-a', modelId: 'model-mini', capabilities: [], contextWindow: null },
    ]);
    expect(ports.listUsage()).toEqual([{ gatewayId: 'gw-a', usedRatio: 0.2 }]);
  });

  it('桥接端口可直接驱动引擎决策（网关类型偏好序打破同分平局）', async () => {
    const { createRepositories, openDatabase, runMigrations } = await import('../src/db/index.js');
    const db = openDatabase(':memory:');
    runMigrations(db);
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: 'proj-adapter' });
    const module = repos.modules.create({ project_id: project.id, name: 'm' });
    const phase = repos.phases.create({ module_id: module.id, name: 'p' });
    const task = repos.tasks.create({
      project_id: project.id,
      module_id: module.id,
      phase_id: phase.id,
      title: 't',
    });
    const ports = await createPortsFromAdapters([
      mockAdapter({
        id: 'gw-ind',
        kind: 'independent',
        name: 'ind',
        catalog: { ok: true, models: [{ id: 'model-a', contextWindow: 8000, raw: {} }] },
        health: health('ok'),
      }),
      mockAdapter({
        id: 'gw-a2a',
        kind: 'agent2api',
        name: 'a2a',
        catalog: { ok: true, models: [{ id: 'model-a', contextWindow: 8000, raw: {} }] },
        health: health('ok'),
      }),
    ]);
    const engine = new SchedulerEngine({ repos, ports });
    const decision = engine.decide(task.id);
    expect(decision.selected?.gatewayId).toBe('gw-a2a');
    expect(decision.selected?.gatewayKind).toBe('agent2api');
    expect(decision.fallbacks.map((f) => f.gatewayId)).toEqual(['gw-ind']);
    expect(repos.tasks.getById(task.id)?.status).toBe('in_progress');
  });
});

// ---------- 用量类型占位引用（保持 import 完整性） ----------

describe('usage 类型', () => {
  it('ResourceUsage 网关级条目不含 modelId', () => {
    const usage: ResourceUsage = { gatewayId: 'gw-a', usedRatio: 0.5 };
    expect(usage.modelId).toBeUndefined();
  });
});
