/**
 * 模型资源平面服务（网关配置 + 模型逻辑目录 + 额度/健康监控）
 * ============================================================
 *
 * 职责边界：
 *  - 网关（gateways 表）与模型逻辑目录（models 表 + model_gateway_bindings 绑定）
 *    的 CRUD；
 *  - 通过统一适配器做网关级探测（模型目录 / 额度 / 健康），只提供资源状态数据；
 *  - 不做模型调度与故障转移 —— 绑定的 priority 只是存储的数据，
 *    多网关/多绑定之间的取舍属于 scheduler（M10）。
 *
 * 密钥纪律：数据库只存 api_key_env（环境变量名）；真实密钥在构造适配器时
 * 经 secretResolver（默认 process.env）解析，仅存于内存。
 *
 * 绑定表说明：model_gateway_bindings 由迁移 0004_resource_bindings 创建；
 * 其数据访问是本服务的配套实现（保持资源平面的表结构改动收敛在资源平面内）。
 */

import { createGatewayAdapter, GATEWAY_KINDS, resolveGatewayKind } from '../adapters/index.js';
import type { FetchImpl } from '../adapters/http.js';
import type {
  GatewayAdapter,
  GatewayConfig,
  GatewayKind,
  HealthReport,
  ModelEntry,
  QuotaReport,
} from '../adapters/types.js';
import { NotFoundError, ValidationError } from '../db/errors.js';
import type { Repositories } from '../db/repositories/index.js';
import { all, get, run } from '../db/sql.js';
import type { SqlDb } from '../db/sqlite.js';
import { withTransaction } from '../db/sqlite.js';
import type { CreateModel, Gateway, Model, UpdateModel } from '../types/entities.js';

/** 适配器单次请求超时（巡检定时任务可在此基础上收紧）。 */
export const ADAPTER_TIMEOUT_MS = 15000;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------- 输入类型 ----------

export interface CreateGatewayInput {
  id?: string;
  name: string;
  type?: string;
  base_url?: string;
  api_key_env?: string;
  enabled?: boolean | 0 | 1;
}

export interface UpdateGatewayInput {
  name?: string;
  type?: string;
  base_url?: string;
  api_key_env?: string;
  enabled?: boolean | 0 | 1;
}

export interface CreateModelInput extends CreateModel {}

export interface UpdateModelInput extends UpdateModel {}

export interface BindingInput {
  gatewayId: string;
  upstreamModel: string;
  priority?: number;
  enabled?: boolean | 0 | 1;
}

export interface ModelGatewayBinding {
  id: string;
  model_id: string;
  gateway_id: string;
  upstream_model: string;
  priority: number;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface CatalogBinding extends ModelGatewayBinding {
  gateway: {
    id: string;
    name: string;
    type: string;
    base_url: string;
    enabled: 0 | 1;
  };
}

export interface GatewayOverviewHealth {
  gatewayId: string;
  gatewayName: string;
  kind: GatewayKind;
  report: HealthReport;
}

export interface GatewayOverviewQuota {
  gatewayId: string;
  gatewayName: string;
  kind: GatewayKind;
  report: QuotaReport;
}

export interface SkippedGateway {
  gatewayId: string;
  gatewayName: string;
  reason: string;
}

/** 网关级模型目录拉取结果（带网关归属）。 */
export type GatewayModelCatalog =
  | { gatewayId: string; ok: true; models: ModelEntry[] }
  | { gatewayId: string; ok: false; endpoint: string; error: string; httpStatus?: number };

export interface ResourcesServiceDeps {
  db: SqlDb;
  repos: Repositories;
  /** 测试注入；缺省 global fetch。 */
  fetchImpl?: FetchImpl;
  /** 测试注入；缺省读 process.env。入参是环境变量名。 */
  secretResolver?: (envName: string) => string | undefined;
}

// ---------- 校验工具 ----------

function assertBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`base_url '${url}' is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`base_url must be http(s), got '${parsed.protocol}'`);
  }
}

function normalizeGatewayType(input: string | undefined): GatewayKind {
  const value = (input ?? '').trim();
  if (value === '' || value === 'openai-compatible') return 'independent';
  if ((GATEWAY_KINDS as readonly string[]).includes(value)) return value as GatewayKind;
  throw new ValidationError(
    `unknown gateway type '${value}'; expected one of: ${GATEWAY_KINDS.join(', ')} ` +
      "(legacy 'openai-compatible' is accepted and maps to 'independent')",
  );
}

function assertEnvName(value: string): void {
  if (!ENV_NAME_RE.test(value)) {
    throw new ValidationError(`api_key_env '${value}' is not a valid environment variable name`);
  }
}

function normalizeEnabled(value: boolean | 0 | 1 | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === true || value === 1;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

// ---------- 服务 ----------

export class ResourcesService {
  private readonly db: SqlDb;
  private readonly repos: Repositories;
  private readonly fetchImpl: FetchImpl;
  private readonly secretResolver: (envName: string) => string | undefined;

  constructor(deps: ResourcesServiceDeps) {
    this.db = deps.db;
    this.repos = deps.repos;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.secretResolver = deps.secretResolver ?? ((name) => process.env[name]);
  }

  // ==== 网关配置 CRUD ====

  listGateways(): Gateway[] {
    return this.repos.gateways.list();
  }

  getGateway(id: string): Gateway {
    return this.repos.gateways.getByIdOrThrow(id);
  }

  findGateway(id: string): Gateway | undefined {
    return this.repos.gateways.getById(id);
  }

  createGateway(input: CreateGatewayInput): Gateway {
    const name = nonEmptyString(input.name, 'name');
    const kind = normalizeGatewayType(input.type);
    const baseUrl = nonEmptyString(input.base_url, 'base_url');
    assertBaseUrl(baseUrl);
    let apiKeyEnv = '';
    if (input.api_key_env !== undefined) {
      apiKeyEnv = input.api_key_env.trim();
      if (apiKeyEnv !== '') assertEnvName(apiKeyEnv);
    }
    const enabled = normalizeEnabled(input.enabled);
    return this.repos.gateways.create({
      ...(input.id !== undefined ? { id: input.id } : {}),
      name,
      type: kind,
      base_url: baseUrl,
      api_key_env: apiKeyEnv,
      ...(enabled !== undefined ? { enabled } : {}),
    });
  }

  updateGateway(id: string, patch: UpdateGatewayInput): Gateway {
    this.repos.gateways.getByIdOrThrow(id);
    const normalized: UpdateGatewayInput = {};
    if (patch.name !== undefined) normalized.name = nonEmptyString(patch.name, 'name');
    if (patch.type !== undefined) normalized.type = normalizeGatewayType(patch.type);
    if (patch.base_url !== undefined) {
      normalized.base_url = nonEmptyString(patch.base_url, 'base_url');
      assertBaseUrl(normalized.base_url);
    }
    if (patch.api_key_env !== undefined) {
      const env = patch.api_key_env.trim();
      if (env !== '') assertEnvName(env);
      normalized.api_key_env = env;
    }
    const enabled = normalizeEnabled(patch.enabled);
    if (enabled !== undefined) normalized.enabled = enabled;
    const updated = this.repos.gateways.update(id, normalized);
    if (!updated) throw new NotFoundError('gateways', id);
    return updated;
  }

  deleteGateway(id: string): void {
    this.repos.gateways.getByIdOrThrow(id);
    const bindings = this.listBindingsByGateway(id);
    if (bindings.length > 0) {
      const modelIds = [...new Set(bindings.map((b) => b.model_id))].sort();
      throw new ValidationError(
        `gateway '${id}' is still referenced by ${bindings.length} model binding(s) ` +
          `(models: ${modelIds.join(', ')}); remove those bindings first`,
      );
    }
    if (!this.repos.gateways.delete(id)) throw new NotFoundError('gateways', id);
  }

  // ==== 模型逻辑目录 CRUD ====

  listModels(): Model[] {
    return this.repos.models.list();
  }

  getModel(id: string): Model {
    return this.repos.models.getByIdOrThrow(id);
  }

  createModel(input: CreateModelInput): Model {
    nonEmptyString(input.name, 'name');
    return this.repos.models.create(input);
  }

  updateModel(id: string, patch: UpdateModelInput): Model {
    this.repos.models.getByIdOrThrow(id);
    if (patch.name !== undefined) nonEmptyString(patch.name, 'name');
    const updated = this.repos.models.update(id, patch);
    if (!updated) throw new NotFoundError('models', id);
    return updated;
  }

  deleteModel(id: string): void {
    // 绑定行随 ON DELETE CASCADE 一并删除。
    if (!this.repos.models.delete(id)) throw new NotFoundError('models', id);
  }

  // ==== 逻辑模型 → 网关绑定 ====

  listBindings(modelId: string): ModelGatewayBinding[] {
    this.repos.models.getByIdOrThrow(modelId);
    return this.listBindingsByModel(modelId);
  }

  /** 整体替换某逻辑模型的绑定集合（顺序即存储顺序，不含任何调度语义）。 */
  setBindings(modelId: string, inputs: BindingInput[]): ModelGatewayBinding[] {
    this.repos.models.getByIdOrThrow(modelId);
    if (!Array.isArray(inputs)) throw new ValidationError('bindings must be an array');
    const seen = new Set<string>();
    const prepared: Array<{ gatewayId: string; upstreamModel: string; priority: number; enabled: 0 | 1 }> = [];
    for (const input of inputs) {
      const gatewayId = nonEmptyString(input?.gatewayId, 'bindings[].gatewayId');
      if (!this.repos.gateways.getById(gatewayId)) {
        throw new ValidationError(`gateway '${gatewayId}' does not exist`);
      }
      const upstreamModel = nonEmptyString(input?.upstreamModel, 'bindings[].upstreamModel');
      const priority = input?.priority ?? 0;
      if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0) {
        throw new ValidationError('bindings[].priority must be a non-negative integer');
      }
      const key = `${gatewayId}\u0000${upstreamModel}`;
      if (seen.has(key)) {
        throw new ValidationError(`duplicate binding for gateway '${gatewayId}' and upstream model '${upstreamModel}'`);
      }
      seen.add(key);
      const enabled = normalizeEnabled(input?.enabled);
      prepared.push({ gatewayId, upstreamModel, priority, enabled: enabled === false ? 0 : 1 });
    }
    return withTransaction(this.db, () => {
      run(this.db, 'DELETE FROM model_gateway_bindings WHERE model_id = ?', [modelId]);
      for (const item of prepared) {
        run(
          this.db,
          `INSERT INTO model_gateway_bindings
             (id, model_id, gateway_id, upstream_model, priority, enabled)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), modelId, item.gatewayId, item.upstreamModel, item.priority, item.enabled],
        );
      }
      return this.listBindingsByModel(modelId);
    });
  }

  /** 逻辑模型目录视图：模型行 + 绑定逐条挂上网关当前配置（纯数据拼接，无调度）。 */
  getModelCatalog(modelId: string): { model: Model; bindings: CatalogBinding[] } {
    const model = this.repos.models.getByIdOrThrow(modelId);
    const bindings: CatalogBinding[] = [];
    for (const binding of this.listBindingsByModel(modelId)) {
      const gateway = this.repos.gateways.getById(binding.gateway_id);
      if (!gateway) continue; // 外键 RESTRICT 下不应发生；防御性跳过而不是编造
      bindings.push({
        ...binding,
        gateway: {
          id: gateway.id,
          name: gateway.name,
          type: gateway.type,
          base_url: gateway.base_url,
          enabled: gateway.enabled,
        },
      });
    }
    return { model, bindings };
  }

  // ==== 网关级监控（经统一适配器） ====

  /** 拉取网关的实时模型目录。 */
  async gatewayModels(id: string): Promise<GatewayModelCatalog> {
    const gateway = this.gatewayById(id);
    const result = await this.adapterFor(gateway).listModels();
    if (result.ok) return { gatewayId: id, ok: true, models: result.models };
    return {
      gatewayId: id,
      ok: false,
      endpoint: result.endpoint,
      error: result.error,
      ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
    };
  }

  /** 读取网关额度/账户用量。网关未提供时报告 status='not_provided'，绝不编造。 */
  async gatewayQuota(id: string): Promise<QuotaReport & { gatewayId: string }> {
    const gateway = this.gatewayById(id);
    const report = await this.adapterFor(gateway).getQuota();
    return { gatewayId: id, ...report };
  }

  /** 网关健康探测。 */
  async gatewayHealth(id: string): Promise<HealthReport & { gatewayId: string }> {
    const gateway = this.gatewayById(id);
    const report = await this.adapterFor(gateway).getHealth();
    return { gatewayId: id, ...report };
  }

  /** 全局健康巡检视图：只探测启用中的网关，停用的列入 skipped。 */
  async overviewHealth(): Promise<{
    checkedAt: string;
    gateways: GatewayOverviewHealth[];
    skipped: SkippedGateway[];
  }> {
    const rows = this.repos.gateways.list();
    const enabled = rows.filter((row) => row.enabled === 1);
    const disabled = rows.filter((row) => row.enabled !== 1);
    const gateways = await Promise.all(
      enabled.map(async (row) => ({
        gatewayId: row.id,
        gatewayName: row.name,
        kind: resolveGatewayKind(row.type),
        report: await this.adapterFor(row).getHealth(),
      })),
    );
    return {
      checkedAt: new Date().toISOString(),
      gateways,
      skipped: disabled.map((row) => ({
        gatewayId: row.id,
        gatewayName: row.name,
        reason: 'gateway is disabled',
      })),
    };
  }

  /** 全局额度巡检视图：结构与 overviewHealth 对齐。 */
  async overviewQuota(): Promise<{
    fetchedAt: string;
    gateways: GatewayOverviewQuota[];
    skipped: SkippedGateway[];
  }> {
    const rows = this.repos.gateways.list();
    const enabled = rows.filter((row) => row.enabled === 1);
    const disabled = rows.filter((row) => row.enabled !== 1);
    const gateways = await Promise.all(
      enabled.map(async (row) => ({
        gatewayId: row.id,
        gatewayName: row.name,
        kind: resolveGatewayKind(row.type),
        report: await this.adapterFor(row).getQuota(),
      })),
    );
    return {
      fetchedAt: new Date().toISOString(),
      gateways,
      skipped: disabled.map((row) => ({
        gatewayId: row.id,
        gatewayName: row.name,
        reason: 'gateway is disabled',
      })),
    };
  }

  // ==== 内部 ====

  private gatewayById(id: string): Gateway {
    return this.repos.gateways.getByIdOrThrow(id);
  }

  private adapterFor(gateway: Gateway): GatewayAdapter {
    const apiKey = this.resolveSecret(gateway.api_key_env);
    const config: GatewayConfig = {
      id: gateway.id,
      kind: resolveGatewayKind(gateway.type),
      name: gateway.name,
      baseUrl: gateway.base_url,
      timeoutMs: ADAPTER_TIMEOUT_MS,
      ...(apiKey !== undefined ? { apiKey } : {}),
    };
    return createGatewayAdapter(config, { fetchImpl: this.fetchImpl });
  }

  private resolveSecret(envName: string): string | undefined {
    const name = envName.trim();
    if (name === '') return undefined;
    const value = this.secretResolver(name);
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed !== '' ? trimmed : undefined;
  }

  private listBindingsByModel(modelId: string): ModelGatewayBinding[] {
    return all<ModelGatewayBinding>(
      this.db,
      `SELECT * FROM model_gateway_bindings WHERE model_id = ? ORDER BY priority DESC, created_at, id`,
      [modelId],
    );
  }

  private listBindingsByGateway(gatewayId: string): ModelGatewayBinding[] {
    return all<ModelGatewayBinding>(
      this.db,
      `SELECT * FROM model_gateway_bindings WHERE gateway_id = ? ORDER BY created_at, id`,
      [gatewayId],
    );
  }
}

/** 供测试/工具使用的绑定直查（不触发存在性校验）。 */
export function findBinding(db: SqlDb, modelId: string, gatewayId: string, upstreamModel: string): ModelGatewayBinding | undefined {
  return get<ModelGatewayBinding>(
    db,
    'SELECT * FROM model_gateway_bindings WHERE model_id = ? AND gateway_id = ? AND upstream_model = ?',
    [modelId, gatewayId, upstreamModel],
  );
}
