/**
 * Bifrost 适配器（独立网关路径 · 独立实现，不与 Agent2API 共享任何逻辑）
 * =====================================================================
 *
 * 部署事实（adapters/README.md 有完整探测记录）：
 *  - 目标部署为 docker maximhq/bifrost（DB-backed），位于
 *    bifrost-mirror/system-config/init.d/bifrost:2「Bifrost AI gateway (docker maximhq/bifrost:latest, DB-backed)」；
 *  - 公网入口 Caddy 将 /openai/* 反代到该网关（bifrost-mirror/system-config/caddy/Caddyfile，
 *    handle /openai/* → 127.0.0.1:8080）；
 *  - 经实测（2026-11-08，对 https://models.fyrali.com 只读探测）：
 *      GET  {base}/models            → 401 {"type":"virtual_key_required","is_bifrost_error":false,...,
 *                                      "error":{"message":"virtual key is required. Provide a virtual
 *                                      key via the x-bf-vk header."}}
 *                                      —— 端点存在；鉴权头为 x-bf-vk（网关 401 文本即权威说明）。
 *      POST {base}/chat/completions  → 该路径由 Caddy 单独转发（经协议修补层），
 *                                      GET 探测 404（仅 POST），POST 即 OpenAI 兼容补全。
 *  - 额度/账户/用量类端点（governance/budget 等）未在所配置公开端点暴露，
 *    直连 8080 从本机不可达、未经验证 —— 因此 getQuota() 恒返回 not_provided，
 *    适配器绝不调用未经验证的端点，也绝不编造读数。
 *
 * baseUrl 约定：OpenAI 兼容根（如 https://models.fyrali.com/openai/v1）。
 */

import { GatewayHttpError, GatewayRequestError, clip, requestJson, trimBase, type FetchImpl } from './http.js';
import {
  fetchOpenAIModels,
  healthFromModelsProbe,
  normalizeOpenAIModels,
  probeWithTiming,
} from './openaiCompat.js';
import type {
  ChatRequest,
  ChatResult,
  GatewayAdapter,
  GatewayConfig,
  HealthReport,
  ModelCatalogResult,
  QuotaReport,
} from './types.js';

export class BifrostAdapter implements GatewayAdapter {
  readonly kind = 'bifrost' as const;
  readonly supportsChat = true;
  private readonly fetchImpl: FetchImpl;

  constructor(readonly config: GatewayConfig, fetchImpl: FetchImpl = fetch) {
    this.fetchImpl = fetchImpl;
  }

  /**
   * 鉴权头：x-bf-vk 为实测确认的 virtual key 头（401 报文原文指定）；
   * Authorization: Bearer 一并发送以兼容标准 OpenAI 客户端行为
   * （DSH 的 bifrost 渠道即按 OpenAI 兼容方式配置）。
   */
  private authHeaders(): Record<string, string> {
    if (!this.config.apiKey) return {};
    return { 'x-bf-vk': this.config.apiKey, authorization: `Bearer ${this.config.apiKey}` };
  }

  async listModels(): Promise<ModelCatalogResult> {
    const url = `${trimBase(this.config.baseUrl)}/models`;
    try {
      const { json } = await fetchOpenAIModels({
        baseUrl: this.config.baseUrl,
        headers: this.authHeaders(),
        timeoutMs: this.config.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      return { ok: true, models: normalizeOpenAIModels(json) };
    } catch (error) {
      if (error instanceof GatewayHttpError) {
        return { ok: false, endpoint: `GET ${url}`, httpStatus: error.status, error: clip(error.bodyText) || `HTTP ${error.status}` };
      }
      if (error instanceof GatewayRequestError) {
        return { ok: false, endpoint: `GET ${url}`, error: clip(error.message) };
      }
      return {
        ok: false,
        endpoint: `GET ${url}`,
        error: clip(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  /**
   * 网关未提供可验证的账户/额度 API —— 恒返回 not_provided（含「网关未提供」字样），
   * 不发起任何未经验证的请求，不返回编造数字。
   */
  async getQuota(): Promise<QuotaReport> {
    return {
      status: 'not_provided',
      reason:
        'Bifrost 网关未提供可经所配置公开端点验证的账户/额度/用量 API：实测仅 OpenAI 兼容的 ' +
        'GET {base}/models 与 POST {base}/chat/completions 存在（见 adapters/README.md 探测记录）；' +
        'governance/budget 类端点未在公开路径暴露且未经验证，适配器不调用未验证端点，也不返回编造数据。',
      fetchedAt: new Date().toISOString(),
    };
  }

  /** 健康探测 = GET {base}/models（已验证存在的只读端点）。 */
  async getHealth(): Promise<HealthReport> {
    const checkedAt = new Date().toISOString();
    try {
      const { outcome, latencyMs } = await probeWithTiming({
        baseUrl: this.config.baseUrl,
        headers: this.authHeaders(),
        timeoutMs: this.config.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      const report = healthFromModelsProbe({
        baseUrl: this.config.baseUrl,
        outcome,
        latencyMs,
        checkedAt,
      });
      if (report.httpStatus === 401 || report.httpStatus === 403) {
        return {
          ...report,
          status: 'degraded',
          detail: report.detail?.includes('virtual key')
            ? report.detail
            : `可达但鉴权未通过（HTTP ${report.httpStatus}）：virtual key 缺失或无效`,
        };
      }
      return report;
    } catch (error) {
      if (error instanceof GatewayRequestError) {
        return {
          status: 'unreachable',
          probeEndpoint: `GET ${trimBase(this.config.baseUrl)}/models`,
          latencyMs: undefined,
          detail: clip(error.message),
          checkedAt,
        };
      }
      return {
        status: 'degraded',
        probeEndpoint: `GET ${trimBase(this.config.baseUrl)}/models`,
        detail: clip(error instanceof Error ? error.message : String(error)),
        checkedAt,
      };
    }
  }

  /** POST {base}/chat/completions —— OpenAI 兼容补全；virtual key 必带（401 报文实证）。 */
  async chat(request: ChatRequest): Promise<ChatResult> {
    const url = `${trimBase(this.config.baseUrl)}/chat/completions`;
    const endpoint = `POST ${url}`;
    if (!this.config.apiKey) {
      return {
        ok: false,
        endpoint,
        error: 'Bifrost 需要 virtual key（实测 401 报文：virtual key is required via the x-bf-vk header）；当前未配置密钥，未发起请求。',
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
}
