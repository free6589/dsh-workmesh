/**
 * 独立第三方 API 直连适配器（备用通道 · 独立实现）
 * ==================================================
 *
 * 定位：补充资源与网关故障时的备用通道 —— 任意外部 OpenAI 兼容端点
 * （第三方供应商、自建代理等），以注册表方式接入（kind=independent）。
 *
 * 只使用 OpenAI 兼容的两个标准端点：
 *   GET  {base}/models
 *   POST {base}/chat/completions
 * 第三方供应商没有统一的账户/额度接口，故 getQuota() 恒返回 not_provided；
 * 适配器不猜测、不调用未经验证的管理端点。
 *
 * baseUrl 约定：OpenAI 兼容根（如 https://api.example.com/v1）。
 */

import { GatewayHttpError, GatewayRequestError, clip, requestJson, trimBase, type FetchImpl } from './http.js';
import { fetchOpenAIModels, healthFromModelsProbe, normalizeOpenAIModels, probeWithTiming } from './openaiCompat.js';
import type {
  ChatRequest,
  ChatResult,
  GatewayAdapter,
  GatewayConfig,
  HealthReport,
  ModelCatalogResult,
  QuotaReport,
} from './types.js';

export class IndependentApiAdapter implements GatewayAdapter {
  readonly kind = 'independent' as const;
  readonly supportsChat = true;
  private readonly fetchImpl: FetchImpl;

  constructor(readonly config: GatewayConfig, fetchImpl: FetchImpl = fetch) {
    this.fetchImpl = fetchImpl;
  }

  private authHeaders(): Record<string, string> {
    return this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {};
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
      return { ok: false, endpoint: `GET ${url}`, error: clip(error instanceof Error ? error.message : String(error)) };
    }
  }

  /** 第三方 API 无统一额度接口 —— 如实返回「网关未提供」。 */
  async getQuota(): Promise<QuotaReport> {
    return {
      status: 'not_provided',
      reason:
        '独立第三方 API 网关未提供统一的账户/额度/用量接口：适配器只调用经实际验证存在的 OpenAI 兼容端点' +
        '（GET {base}/models、POST {base}/chat/completions），额度状态如实返回「网关未提供」，不返回编造数据。',
      fetchedAt: new Date().toISOString(),
    };
  }

  /** 健康探测 = GET {base}/models（标准只读端点）。 */
  async getHealth(): Promise<HealthReport> {
    const checkedAt = new Date().toISOString();
    try {
      const { outcome, latencyMs } = await probeWithTiming({
        baseUrl: this.config.baseUrl,
        headers: this.authHeaders(),
        timeoutMs: this.config.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      const report = healthFromModelsProbe({ baseUrl: this.config.baseUrl, outcome, latencyMs, checkedAt });
      if (report.httpStatus === 401 || report.httpStatus === 403) {
        return {
          ...report,
          status: 'degraded',
          detail: `可达但鉴权未通过（HTTP ${report.httpStatus}）：API Key 缺失或无效`,
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

  async chat(request: ChatRequest): Promise<ChatResult> {
    const url = `${trimBase(this.config.baseUrl)}/chat/completions`;
    const endpoint = `POST ${url}`;
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
