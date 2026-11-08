/**
 * Agent2API 适配器（主聚合网关 · 独立实现）
 * ===========================================
 *
 * 边界纪律：
 *  - Agent2API 内部已有账户轮换、账号优先级、会话亲和与 Provider 故障转移；
 *    Workmesh 侧绝不重实现这些逻辑，也不做跨账号重试 —— 每次探测只发一次
 *    请求，失败如实上报。
 *  - 只调用下表登记的、经实际验证存在的端点（证据见 adapters/README.md，
 *    源码核对基于本机 checkout /home/fish/projects_mine/Agent2API @ commit bd36938d）：
 *
 *      GET  /health                          无需鉴权（http.rs:886 → api/health.rs，
 *                                            裸 JSON 对象，status: "ok" | "degraded"）
 *      GET  /v1/models                       未携带 Key 可读公开清单；携带则必须有效
 *                                            （http.rs:891 → api/chat.rs list_models）
 *      POST /v1/chat/completions             必须携带有效网关 Key
 *                                            （http.rs:902；require_api_key http.rs:1084）
 *      GET  /api/accounts/usage/snapshot     面板会话或不受限网关 Key 可读
 *                                            （http.rs:406 管理入口 + api/accounts_usage.rs:43-57；
 *                                            Key 准入管理面：http.rs:1103-1108「Key 也能操作管理接口
 *                                            （桌面壳 / 脚本自动化的通道）」）
 *
 *  - 凭证头：Authorization: Bearer <key>（access.rs:757-761 Bearer 候选；
 *    x-api-key 亦被接受，access.rs:898）。本适配器统一用 Bearer。
 *
 * baseUrl 约定：网关根地址（如 http://127.0.0.1:3065），不含 /v1。
 */

import {
  GatewayHttpError,
  GatewayRequestError,
  clip,
  requestJson,
  trimBase,
  type FetchImpl,
} from './http.js';
import type {
  ChatRequest,
  ChatResult,
  GatewayAdapter,
  GatewayConfig,
  HealthReport,
  ModelCatalogResult,
  ModelEntry,
  QuotaAccountUsage,
  QuotaReport,
} from './types.js';

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class Agent2APIAdapter implements GatewayAdapter {
  readonly kind = 'agent2api' as const;
  readonly supportsChat = true;
  private readonly fetchImpl: FetchImpl;

  constructor(readonly config: GatewayConfig, fetchImpl: FetchImpl = fetch) {
    this.fetchImpl = fetchImpl;
  }

  private base(): string {
    return trimBase(this.config.baseUrl);
  }

  private authHeaders(): Record<string, string> {
    return this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {};
  }

  /**
   * GET /v1/models —— 未带 Key 时网关返回公开清单；带 Key 时清单按该 Key
   * 的白名单过滤（api/chat.rs list_models 头注释）。因此是否带 Key 都合法。
   */
  async listModels(): Promise<ModelCatalogResult> {
    const url = `${this.base()}/v1/models`;
    try {
      const { json } = await requestJson({
        url,
        headers: this.authHeaders(),
        timeoutMs: this.config.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      const data = (json as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) {
        return { ok: false, endpoint: `GET ${url}`, error: 'response has no OpenAI-style data[] list' };
      }
      const models: ModelEntry[] = [];
      for (const item of data) {
        if (item === null || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const id = record['id'];
        if (typeof id !== 'string' || id === '') continue;
        const contextWindow = asOptionalNumber(record['maxInputTokens']);
        models.push({
          id,
          displayName: asOptionalString(record['name']),
          ownedBy: asOptionalString(record['owned_by']),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          raw: item,
        });
      }
      return { ok: true, models };
    } catch (error) {
      return this.catalogFailure(`GET ${url}`, error);
    }
  }

  /** GET /health —— 网关自报状态；headless 闸门形态下只回 {status:"ok"}，同样按 ok 处理。 */
  async getHealth(): Promise<HealthReport> {
    const url = `${this.base()}/health`;
    const probeEndpoint = `GET ${url}`;
    const checkedAt = new Date().toISOString();
    const startedAt = Date.now();
    try {
      const { status, json } = await requestJson({
        url,
        timeoutMs: this.config.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      const latencyMs = Date.now() - startedAt;
      const reported = (json as { status?: unknown } | null)?.status;
      const healthy = reported === 'ok';
      return {
        status: healthy ? 'ok' : 'degraded',
        probeEndpoint,
        httpStatus: status,
        latencyMs,
        detail: healthy ? undefined : `gateway self-reported status=${clip(JSON.stringify(reported ?? json), 120)}`,
        checkedAt,
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      if (error instanceof GatewayHttpError) {
        return {
          status: 'degraded',
          probeEndpoint,
          httpStatus: error.status,
          latencyMs,
          detail: clip(error.bodyText) || `HTTP ${error.status}`,
          checkedAt,
        };
      }
      if (error instanceof GatewayRequestError) {
        return {
          status: 'unreachable',
          probeEndpoint,
          latencyMs,
          detail: clip(error.message),
          checkedAt,
        };
      }
      return {
        status: 'degraded',
        probeEndpoint,
        latencyMs,
        detail: clip(error instanceof Error ? error.message : String(error)),
        checkedAt,
      };
    }
  }

  /**
   * GET /api/accounts/usage/snapshot —— 账户余额/积分的最近一次快照
   * （api/accounts_usage.rs:43-57：{at, results:[{id,name,usage,error,code?,at}], skipped}）。
   * 该端点真实存在，因此「没配 Key」与「401/403」都如实归为 error 并说明原因，
   * 绝不返回编造读数；usage 字段原样透传，不做换算。
   */
  async getQuota(): Promise<QuotaReport> {
    const url = `${this.base()}/api/accounts/usage/snapshot`;
    const fetchedAt = new Date().toISOString();
    if (!this.config.apiKey) {
      return {
        status: 'error',
        reason:
          'Agent2API 提供 /api/accounts/usage/snapshot（管理面接口，需面板会话或不受限网关 Key，' +
          '见 Agent2API server/http.rs:406 与 api/accounts_usage.rs），但该网关未配置 api_key_env 对应的密钥，' +
          '无法读取；按约定不返回编造数据。',
        endpoint: `GET ${url}`,
        fetchedAt,
      };
    }
    try {
      const { json } = await requestJson({
        url,
        headers: this.authHeaders(),
        timeoutMs: this.config.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      const record = (json ?? {}) as Record<string, unknown>;
      const results = Array.isArray(record['results']) ? record['results'] : [];
      const accounts: QuotaAccountUsage[] = [];
      for (const item of results) {
        if (item === null || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const accountId = asOptionalString(row['id']);
        if (!accountId) continue;
        const at = asOptionalNumber(row['at']);
        accounts.push({
          accountId,
          name: asOptionalString(row['name']),
          usage: row['usage'],
          error: asOptionalString(row['error']),
          code: asOptionalString(row['code']),
          ...(at !== undefined ? { at } : {}),
        });
      }
      const skipped = asOptionalNumber(record['skipped']);
      return {
        status: 'ok',
        accounts,
        ...(skipped !== undefined ? { skipped } : {}),
        endpoint: `GET ${url}`,
        fetchedAt,
      };
    } catch (error) {
      if (error instanceof GatewayHttpError) {
        const accessDenied = error.status === 401 || error.status === 403;
        return {
          status: 'error',
          reason: accessDenied
            ? `Agent2API 拒绝读取 ${url}（HTTP ${error.status}）：管理面需要面板会话或「不受限」网关 Key ` +
              '（受限 Key 会被 management_access_denied 拒绝，见 server/http.rs:1101-1103）；不返回编造数据。'
            : `读取 ${url} 失败（HTTP ${error.status}）：${clip(error.bodyText) || '无响应体'}；不返回编造数据。`,
          endpoint: `GET ${url}`,
          httpStatus: error.status,
          fetchedAt,
        };
      }
      if (error instanceof GatewayRequestError) {
        return {
          status: 'error',
          reason: `读取 ${url} 失败（网络层）：${clip(error.message)}；不返回编造数据。`,
          endpoint: `GET ${url}`,
          fetchedAt,
        };
      }
      return {
        status: 'error',
        reason: `读取 ${url} 失败：${clip(error instanceof Error ? error.message : String(error))}；不返回编造数据。`,
        endpoint: `GET ${url}`,
        fetchedAt,
      };
    }
  }

  /** POST /v1/chat/completions —— 网关 Key 必带（require_api_key，http.rs:1084）。 */
  async chat(request: ChatRequest): Promise<ChatResult> {
    const url = `${this.base()}/v1/chat/completions`;
    const endpoint = `POST ${url}`;
    if (!this.config.apiKey) {
      return {
        ok: false,
        endpoint,
        error: 'Agent2API 模型调用必须携带有效网关 Key（server/http.rs:1084 require_api_key）；当前未配置密钥，未发起请求。',
      };
    }
    try {
      const { json } = await requestJson({
        url,
        method: 'POST',
        headers: this.authHeaders(),
        body: {
          model: request.model,
          messages: request.messages,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        },
        timeoutMs: this.config.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      return { ok: true, value: { raw: json, endpoint } };
    } catch (error) {
      if (error instanceof GatewayHttpError) {
        return { ok: false, endpoint, httpStatus: error.status, error: clip(error.bodyText) || `HTTP ${error.status}` };
      }
      if (error instanceof GatewayRequestError) {
        return { ok: false, endpoint, error: clip(error.message) };
      }
      return { ok: false, endpoint, error: clip(error instanceof Error ? error.message : String(error)) };
    }
  }

  private catalogFailure(endpoint: string, error: unknown): ModelCatalogResult {
    if (error instanceof GatewayHttpError) {
      return {
        ok: false,
        endpoint,
        httpStatus: error.status,
        error: clip(error.bodyText) || `HTTP ${error.status}`,
      };
    }
    if (error instanceof GatewayRequestError) {
      return { ok: false, endpoint, error: clip(error.message) };
    }
    return { ok: false, endpoint, error: clip(error instanceof Error ? error.message : String(error)) };
  }
}
