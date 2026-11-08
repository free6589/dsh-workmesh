/**
 * 调度器的数据端口与 settings 读取。
 *
 * 端口契约：调度器只消费 gateway_adapters 的「接口」（模型目录 / 额度用量 / 健康状态），
 * 不 import、不修改任何适配器实现。M8 适配器落地后应实现 SchedulerPorts 注入引擎；
 * 在那之前，DbSchedulerPorts 提供基于数据层 + settings 快照的默认数据通道：
 * - gateways 表 → 资源入口（type 即资源类型；健康状态走 settings 覆盖，缺省 healthy）；
 * - settings 'scheduler.model_catalog' → 目录快照（适配器同步写入）；
 *   另以 quotas 表的 (gateway_id, model_id) 绑定作兜底目录（能力为空，只能匹配无能力要求的任务）；
 * - settings 'scheduler.resource_usage' → 用量快照（适配器上报）。
 */
import { ValidationError } from '../db/errors.js';
import type { Repositories, SettingsRepo } from '../db/repositories/index.js';
import type {
  GatewayHealthState,
  GatewayKind,
  GatewayResource,
  ModelCatalogEntry,
  ResourceUsage,
  TaskRequirements,
} from './types.js';

export const SCHEDULER_SETTINGS_KEYS = {
  /** 'true'/'false'：无人值守模式总开关。 */
  unattended: 'scheduler.unattended',
  /** JSON Record<projectId, number 0..10>：项目优先级权重。 */
  projectPriorities: 'scheduler.project_priorities',
  /** JSON Record<taskId, TaskRequirements>：任务级模型要求覆盖。 */
  taskRequirements: 'scheduler.task_requirements',
  /** JSON Record<gatewayId, 'healthy'|'degraded'|'unavailable'>：健康状态覆盖。 */
  gatewayHealth: 'scheduler.gateway_health',
  /** JSON ModelCatalogEntry[]：适配器同步的模型目录快照。 */
  modelCatalog: 'scheduler.model_catalog',
  /** JSON ResourceUsage[]：适配器上报的用量快照。 */
  resourceUsage: 'scheduler.resource_usage',
} as const;

export const DEFAULT_UNATTENDED = false;

export interface SchedulerSettingsSnapshot {
  unattended: boolean;
  projectPriorities: Record<string, number>;
  taskRequirements: Record<string, TaskRequirements>;
  gatewayHealth: Record<string, GatewayHealthState>;
  modelCatalog: ModelCatalogEntry[];
  resourceUsage: ResourceUsage[];
}

/** gateway_adapters 需要实现的端口；调度器只依赖该接口，不依赖适配器实现。 */
export interface SchedulerPorts {
  listGateways(): GatewayResource[];
  listCatalog(): ModelCatalogEntry[];
  listUsage(): ResourceUsage[];
}

const GATEWAY_KINDS: readonly GatewayKind[] = ['agent2api', 'bifrost', 'independent'];
const HEALTH_STATES: readonly GatewayHealthState[] = ['healthy', 'degraded', 'unavailable'];

export function normalizeGatewayKind(type: string): GatewayKind {
  return GATEWAY_KINDS.includes(type as GatewayKind) ? (type as GatewayKind) : 'independent';
}

/** 归一化并校验任务要求；非法类型直接报错（配置错误要显式暴露，不静默吞掉）。 */
export function normalizeRequirements(input: unknown): TaskRequirements {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('scheduler.task_requirements 条目必须是对象');
  }
  const record = input as Record<string, unknown>;
  const rawCaps = record['requiredCapabilities'];
  if (rawCaps !== undefined && !Array.isArray(rawCaps)) {
    throw new ValidationError('scheduler.task_requirements.requiredCapabilities 必须是字符串数组');
  }
  const requiredCapabilities = (rawCaps ?? []).map((cap) => {
    if (typeof cap !== 'string') {
      throw new ValidationError('scheduler.task_requirements.requiredCapabilities 必须是字符串数组');
    }
    return cap;
  });
  const minContextWindow = record['minContextWindow'];
  if (minContextWindow !== undefined && (typeof minContextWindow !== 'number' || !Number.isFinite(minContextWindow) || minContextWindow < 0)) {
    throw new ValidationError('scheduler.task_requirements.minContextWindow 必须是非负有限数字');
  }
  const preferredModel = record['preferredModel'];
  if (preferredModel !== undefined && typeof preferredModel !== 'string') {
    throw new ValidationError('scheduler.task_requirements.preferredModel 必须是字符串');
  }
  const allowDegraded = record['allowDegraded'];
  if (allowDegraded !== undefined && typeof allowDegraded !== 'boolean') {
    throw new ValidationError('scheduler.task_requirements.allowDegraded 必须是布尔值');
  }
  const requirements: TaskRequirements = { requiredCapabilities };
  if (minContextWindow !== undefined) requirements.minContextWindow = minContextWindow;
  if (preferredModel !== undefined) requirements.preferredModel = preferredModel;
  if (allowDegraded !== undefined) requirements.allowDegraded = allowDegraded;
  return requirements;
}

function parseJsonSetting(settings: SettingsRepo, key: string): unknown {
  const raw = settings.get(key);
  if (raw === undefined || raw === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ValidationError(`settings '${key}' 不是合法 JSON：${String(error)}`);
  }
}

function parseRecord<T>(value: unknown, key: string, normalizeItem: (item: unknown) => T): Record<string, T> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`settings '${key}' 必须是对象`);
  }
  const result: Record<string, T> = {};
  for (const [id, item] of Object.entries(value as Record<string, unknown>)) {
    result[id] = normalizeItem(item);
  }
  return result;
}

function parseArray<T>(value: unknown, key: string, normalizeItem: (item: unknown) => T): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError(`settings '${key}' 必须是数组`);
  }
  return value.map(normalizeItem);
}

function parseProjectPriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError('scheduler.project_priorities 的权重必须是有限数字');
  }
  return value;
}

function parseGatewayHealth(value: unknown): GatewayHealthState {
  if (typeof value !== 'string' || !HEALTH_STATES.includes(value as GatewayHealthState)) {
    throw new ValidationError(`scheduler.gateway_health 的取值必须是 ${HEALTH_STATES.join('/')}`);
  }
  return value as GatewayHealthState;
}

function parseModelCatalogEntry(value: unknown): ModelCatalogEntry {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError('scheduler.model_catalog 条目必须是对象');
  }
  const record = value as Record<string, unknown>;
  const gatewayId = record['gatewayId'];
  const modelId = record['modelId'];
  if (typeof gatewayId !== 'string' || gatewayId === '') {
    throw new ValidationError('scheduler.model_catalog 条目缺少 gatewayId');
  }
  if (typeof modelId !== 'string' || modelId === '') {
    throw new ValidationError('scheduler.model_catalog 条目缺少 modelId');
  }
  const rawCaps = record['capabilities'];
  const capabilities = Array.isArray(rawCaps) ? rawCaps.map(String) : [];
  const contextWindow = record['contextWindow'];
  const normalizedContext =
    typeof contextWindow === 'number' && Number.isFinite(contextWindow) ? contextWindow : null;
  return { gatewayId, modelId, capabilities, contextWindow: normalizedContext };
}

function parseResourceUsage(value: unknown): ResourceUsage {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError('scheduler.resource_usage 条目必须是对象');
  }
  const record = value as Record<string, unknown>;
  const gatewayId = record['gatewayId'];
  const usedRatio = record['usedRatio'];
  if (typeof gatewayId !== 'string' || gatewayId === '') {
    throw new ValidationError('scheduler.resource_usage 条目缺少 gatewayId');
  }
  if (typeof usedRatio !== 'number' || !Number.isFinite(usedRatio) || usedRatio < 0) {
    throw new ValidationError('scheduler.resource_usage.usedRatio 必须是非负有限数字');
  }
  const modelId = record['modelId'];
  const usage: ResourceUsage = { gatewayId, usedRatio };
  if (typeof modelId === 'string' && modelId !== '') usage.modelId = modelId;
  return usage;
}

/** 读取并校验全部调度相关 settings；未设置的键取缺省值。 */
export function readSettingsSnapshot(repos: Repositories): SchedulerSettingsSnapshot {
  const settings = repos.settings;
  const rawUnattended = settings.get(SCHEDULER_SETTINGS_KEYS.unattended);
  let unattended = DEFAULT_UNATTENDED;
  if (rawUnattended !== undefined && rawUnattended !== '') {
    if (rawUnattended === 'true') unattended = true;
    else if (rawUnattended === 'false') unattended = false;
    else throw new ValidationError("settings 'scheduler.unattended' 必须是 'true' 或 'false'");
  }
  return {
    unattended,
    projectPriorities: parseRecord(
      parseJsonSetting(settings, SCHEDULER_SETTINGS_KEYS.projectPriorities),
      SCHEDULER_SETTINGS_KEYS.projectPriorities,
      parseProjectPriority,
    ),
    taskRequirements: parseRecord(
      parseJsonSetting(settings, SCHEDULER_SETTINGS_KEYS.taskRequirements),
      SCHEDULER_SETTINGS_KEYS.taskRequirements,
      normalizeRequirements,
    ),
    gatewayHealth: parseRecord(
      parseJsonSetting(settings, SCHEDULER_SETTINGS_KEYS.gatewayHealth),
      SCHEDULER_SETTINGS_KEYS.gatewayHealth,
      parseGatewayHealth,
    ),
    modelCatalog: parseArray(
      parseJsonSetting(settings, SCHEDULER_SETTINGS_KEYS.modelCatalog),
      SCHEDULER_SETTINGS_KEYS.modelCatalog,
      parseModelCatalogEntry,
    ),
    resourceUsage: parseArray(
      parseJsonSetting(settings, SCHEDULER_SETTINGS_KEYS.resourceUsage),
      SCHEDULER_SETTINGS_KEYS.resourceUsage,
      parseResourceUsage,
    ),
  };
}

/**
 * 默认数据通道：从数据层 + settings 快照组装端口数据。
 * 目录合并规则：settings 快照优先，quotas 绑定兜底（去重键 gatewayId + modelId）。
 */
export class DbSchedulerPorts implements SchedulerPorts {
  private readonly repos: Repositories;

  constructor(repos: Repositories) {
    this.repos = repos;
  }

  listGateways(): GatewayResource[] {
    const { gatewayHealth } = readSettingsSnapshot(this.repos);
    return this.repos.gateways.list().map((gateway) => ({
      id: gateway.id,
      name: gateway.name,
      kind: normalizeGatewayKind(gateway.type),
      enabled: gateway.enabled === 1,
      health: gatewayHealth[gateway.id] ?? 'healthy',
    }));
  }

  listCatalog(): ModelCatalogEntry[] {
    const { modelCatalog } = readSettingsSnapshot(this.repos);
    const merged = new Map<string, ModelCatalogEntry>();
    for (const entry of modelCatalog) {
      merged.set(`${entry.gatewayId}\u0000${entry.modelId}`, entry);
    }
    for (const quota of this.repos.quotas.list()) {
      if (quota.gateway_id === null || quota.model_id === null) continue;
      const key = `${quota.gateway_id}\u0000${quota.model_id}`;
      if (merged.has(key)) continue;
      const model = this.repos.models.getById(quota.model_id);
      merged.set(key, {
        gatewayId: quota.gateway_id,
        modelId: quota.model_id,
        capabilities: [],
        contextWindow: model?.context_window ?? null,
      });
    }
    return [...merged.values()];
  }

  listUsage(): ResourceUsage[] {
    return readSettingsSnapshot(this.repos).resourceUsage;
  }
}
