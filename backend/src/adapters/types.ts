/**
 * 统一网关适配器契约（模型资源平面 · M8）
 * =========================================
 *
 * 三类网关各自独立实现本接口，代码层面不混为一体：
 *  - agent2api   —— Agent2API（主聚合网关）：只调用其真实存在的 HTTP API，
 *                   不重实现其内部账户轮换与 Provider 调度；
 *  - bifrost     —— Bifrost（独立网关路径）：与 Agent2API 无任何共享逻辑；
 *  - independent —— 独立第三方 API 直连（补充资源与备用通道，OpenAI 兼容）。
 *
 * 诚实性约定（验收口径）：
 *  - 网关未提供某项数据时，getQuota()/getHealth() 必须显式返回
 *    `not_provided` 并在 reason 中说明「网关未提供」，绝不携带编造的数字；
 *  - API 存在但本次读取失败（未配置密钥 / 401 / 网络不可达）时返回 `error`
 *    或 `unreachable`，同样不携带编造数据；
 *  - 适配器只调用 adapters/README.md 中登记的、经实际验证存在的端点。
 */

/** 三类网关的统一类型标识（对应 gateways.type 列的规范取值）。 */
export type GatewayKind = 'agent2api' | 'bifrost' | 'independent';

export const GATEWAY_KINDS: readonly GatewayKind[] = ['agent2api', 'bifrost', 'independent'];

/**
 * gateways.type 列的历史取值映射：建表默认值 'openai-compatible'
 * 语义上就是「独立第三方 API 直连」，映射为 independent。
 */
export function resolveGatewayKind(type: string): GatewayKind {
  if (type === 'agent2api' || type === 'bifrost') return type;
  return 'independent';
}

export interface GatewayConfig {
  id: string;
  kind: GatewayKind;
  name: string;
  /** agent2api：网关根（如 http://127.0.0.1:3065）；bifrost / independent：OpenAI 兼容根（含 /v1 或 /openai/v1）。 */
  baseUrl: string;
  /** 解析后的密钥材料，仅在内存中传递，绝不入库、绝不写入响应。 */
  apiKey?: string;
  timeoutMs: number;
}

/** 模型目录条目（由网关的模型清单端点归一化而来）。 */
export interface ModelEntry {
  id: string;
  displayName?: string;
  ownedBy?: string;
  contextWindow?: number;
  /** 网关原始条目，原样保留供上层按需取用。 */
  raw: unknown;
}

export interface ModelCatalogOk {
  ok: true;
  models: ModelEntry[];
}

export interface ModelCatalogFailure {
  ok: false;
  endpoint: string;
  httpStatus?: number;
  error: string;
}

export type ModelCatalogResult = ModelCatalogOk | ModelCatalogFailure;

/** 单个账户的用量/额度读数（字段由网关返回，原样透传，不做换算）。 */
export interface QuotaAccountUsage {
  accountId: string;
  name?: string;
  usage?: unknown;
  error?: string;
  code?: string;
  /** 网关记录的采样时刻（毫秒时间戳），缺省表示网关未给。 */
  at?: number;
}

export interface QuotaReport {
  /** ok=读到真实读数；not_provided=网关未提供该 API；error=API 存在但本次读取失败。 */
  status: 'ok' | 'not_provided' | 'error';
  /** status ≠ ok 时必填：为什么拿不到（含「网关未提供」字样或失败原因）。 */
  reason?: string;
  /** 仅 status === 'ok' 时存在。 */
  accounts?: QuotaAccountUsage[];
  /** 网关侧跳过查询的账号数（Agent2API 快照的 skipped 字段）。 */
  skipped?: number;
  /** 数据来源端点（status === 'ok' 时）。 */
  endpoint?: string;
  /** 失败时的 HTTP 状态码（如可得知）。 */
  httpStatus?: number;
  fetchedAt: string;
}

export interface HealthReport {
  /** ok=探测通过；degraded=可达但自报不健康/鉴权失败；unreachable=网络层不可达；not_provided=网关未提供可探测端点。 */
  status: 'ok' | 'degraded' | 'unreachable' | 'not_provided';
  probeEndpoint: string;
  httpStatus?: number;
  latencyMs?: number;
  detail?: string;
  checkedAt: string;
}

export interface ChatMessage {
  role: string;
  content: unknown;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletion {
  /** 网关原始响应，原样透传。 */
  raw: unknown;
  endpoint: string;
}

export type ChatResult =
  | { ok: true; value: ChatCompletion }
  | { ok: false; endpoint: string; httpStatus?: number; error: string };

/**
 * 统一网关适配器接口。三类网关各有独立实现类；
 * chat 是可选请求能力（supportsChat 声明），调度策略不在此层实现。
 */
export interface GatewayAdapter {
  readonly kind: GatewayKind;
  readonly config: GatewayConfig;
  readonly supportsChat: boolean;
  /** 模型目录。 */
  listModels(): Promise<ModelCatalogResult>;
  /** 额度/账户用量。网关未提供时返回 not_provided，绝不编造数字。 */
  getQuota(): Promise<QuotaReport>;
  /** 健康探测。 */
  getHealth(): Promise<HealthReport>;
  chat?(request: ChatRequest): Promise<ChatResult>;
}
