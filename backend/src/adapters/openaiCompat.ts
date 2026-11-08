/**
 * OpenAI 兼容清单/健康探测的共享归一化逻辑。
 * 供 bifrost 与 independent 两个适配器复用；agent2api 的清单归一化
 * 有自己的字段约定（name / maxInputTokens），在其文件内独立实现。
 */

import { GatewayHttpError, GatewayRequestError, clip, type FetchImpl, type JsonRequest, requestJson, trimBase } from './http.js';
import type { HealthReport, ModelEntry } from './types.js';

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 归一化 OpenAI 兼容 `{object:"list", data:[...]}` 清单。
 * 额外识别常见的上下文窗口字段（maxInputTokens / context_length / max_context_tokens），
 * 识别不到就不填 —— 不编造。
 */
export function normalizeOpenAIModels(json: unknown): ModelEntry[] {
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new Error('model list response is not an OpenAI-style {data: [...]} object');
  }
  const entries: ModelEntry[] = [];
  for (const item of data) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = record['id'];
    if (typeof id !== 'string' || id === '') continue;
    const contextWindow =
      asOptionalNumber(record['maxInputTokens']) ??
      asOptionalNumber(record['context_length']) ??
      asOptionalNumber(record['max_context_tokens']);
    entries.push({
      id,
      displayName: asOptionalString(record['name']) ?? asOptionalString(record['display_name']),
      ownedBy: asOptionalString(record['owned_by']) ?? asOptionalString(record['ownedBy']),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      raw: item,
    });
  }
  return entries;
}

/** 从 OpenAI 兼容根拉取模型清单（GET {base}/models）。 */
export async function fetchOpenAIModels(params: {
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs: number;
  fetchImpl: FetchImpl;
}): Promise<JsonRequest> {
  return requestJson({
    url: `${trimBase(params.baseUrl)}/models`,
    headers: params.headers,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
}

/**
 * 用「已验证存在的模型清单端点」做健康探测的统一翻译：
 *   200 → ok；401/403 → degraded（可达但鉴权未过）；其余非 2xx → degraded；
 *   网络层失败 → unreachable。
 */
export function healthFromModelsProbe(params: {
  baseUrl: string;
  outcome: JsonRequest | GatewayHttpError | GatewayRequestError;
  latencyMs: number;
  checkedAt: string;
}): HealthReport {
  const probeEndpoint = `GET ${trimBase(params.baseUrl)}/models`;
  if (params.outcome instanceof GatewayRequestError) {
    return {
      status: 'unreachable',
      probeEndpoint,
      latencyMs: params.latencyMs,
      detail: clip(params.outcome.message),
      checkedAt: params.checkedAt,
    };
  }
  if (params.outcome instanceof GatewayHttpError) {
    return {
      status: 'degraded',
      probeEndpoint,
      httpStatus: params.outcome.status,
      latencyMs: params.latencyMs,
      detail: clip(params.outcome.bodyText) || `HTTP ${params.outcome.status}`,
      checkedAt: params.checkedAt,
    };
  }
  return {
    status: 'ok',
    probeEndpoint,
    httpStatus: params.outcome.status,
    latencyMs: params.latencyMs,
    checkedAt: params.checkedAt,
  };
}

/** 发起一次探测并计时；成功与非 2xx 都算「探测完成」，网络层异常原样上抛。 */
export async function probeWithTiming(params: {
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs: number;
  fetchImpl: FetchImpl;
}): Promise<{ outcome: JsonRequest | GatewayHttpError; latencyMs: number }> {
  const startedAt = Date.now();
  let outcome: JsonRequest | GatewayHttpError;
  try {
    outcome = await fetchOpenAIModels(params);
  } catch (error) {
    if (error instanceof GatewayHttpError) {
      outcome = error;
    } else {
      throw error; // GatewayRequestError 交由调用方翻译为 unreachable
    }
  }
  return { outcome, latencyMs: Date.now() - startedAt };
}
