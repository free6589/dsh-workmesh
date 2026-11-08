/**
 * 适配器共用 HTTP 层：超时、错误分类、JSON 解析。
 * 所有网关探测都经此发出，网络层失败统一归为 GatewayRequestError，
 * 非 2xx 应答统一归为 GatewayHttpError，供各适配器翻译成诚实的结果状态。
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** 网络层失败：连接拒绝 / DNS / 超时 / 中途断开。 */
export class GatewayRequestError extends Error {
  readonly endpoint: string;
  constructor(message: string, endpoint: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GatewayRequestError';
    this.endpoint = endpoint;
  }
}

/** 网关返回非 2xx。bodyText 原样保留（截断后）供 detail 透出。 */
export class GatewayHttpError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly bodyText: string;
  constructor(status: number, endpoint: string, bodyText: string) {
    super(`gateway returned HTTP ${status} for ${endpoint}`);
    this.name = 'GatewayHttpError';
    this.status = status;
    this.endpoint = endpoint;
    this.bodyText = bodyText;
  }
}

export interface JsonRequest {
  status: number;
  json: unknown;
  endpoint: string;
}

export interface RequestJsonParams {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  fetchImpl: FetchImpl;
}

/** 截断错误正文，避免把大响应整段塞进 detail。 */
export function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function requestJson(params: RequestJsonParams): Promise<JsonRequest> {
  const method = params.method ?? 'GET';
  const endpoint = `${method} ${params.url}`;
  const headers: Record<string, string> = { accept: 'application/json', ...params.headers };
  let bodyText: string | undefined;
  if (params.body !== undefined) {
    headers['content-type'] = 'application/json';
    bodyText = JSON.stringify(params.body);
  }
  let response: Response;
  try {
    response = await params.fetchImpl(params.url, {
      method,
      headers,
      body: bodyText,
      signal: AbortSignal.timeout(params.timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GatewayRequestError(`gateway request failed (${endpoint}): ${detail}`, endpoint, {
      cause: error,
    });
  }
  const raw = await response.text();
  if (!response.ok) {
    throw new GatewayHttpError(response.status, endpoint, raw);
  }
  let json: unknown = null;
  if (raw.length > 0) {
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      json = raw; // 非 JSON 应答按原文透出，不猜测
    }
  }
  return { status: response.status, json, endpoint };
}

/** 去掉 baseUrl 结尾的斜杠，拼路径用。 */
export function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}
