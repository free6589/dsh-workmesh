/**
 * 三类网关适配器的 mock 单测。
 * 验收口径：
 *  - 统一接口三类独立实现类各自可实例化、行为互不影响；
 *  - 网关未提供的数据 → not_provided + 明确理由，绝不返回编造读数；
 *  - 探测请求只打经登记验证的端点、携带登记过的鉴权头。
 */

import { describe, expect, it } from 'vitest';
import type { FetchImpl } from '../src/adapters/http.js';
import { Agent2APIAdapter } from '../src/adapters/agent2api.js';
import { BifrostAdapter } from '../src/adapters/bifrost.js';
import { IndependentApiAdapter } from '../src/adapters/independent.js';
import { createGatewayAdapter, GATEWAY_KINDS, resolveGatewayKind } from '../src/adapters/index.js';
import type { GatewayConfig } from '../src/adapters/types.js';
import { createMockFetch, createRejectingFetch, type MockRoute } from './helpers.js';

function config(kind: GatewayConfig['kind'], overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    id: `gw-${kind}`,
    kind,
    name: `gateway-${kind}`,
    baseUrl:
      kind === 'agent2api' ? 'http://127.0.0.1:3065' : 'https://gateway.example.com/v1',
    timeoutMs: 5000,
    ...overrides,
  };
}

describe('统一适配器契约', () => {
  it('三类网关各有独立实现类', () => {
    for (const kind of GATEWAY_KINDS) {
      const adapter = createGatewayAdapter(config(kind));
      if (kind === 'agent2api') expect(adapter).toBeInstanceOf(Agent2APIAdapter);
      if (kind === 'bifrost') expect(adapter).toBeInstanceOf(BifrostAdapter);
      if (kind === 'independent') expect(adapter).toBeInstanceOf(IndependentApiAdapter);
      expect(adapter.kind).toBe(kind);
      expect(adapter.supportsChat).toBe(true);
    }
  });

  it('resolveGatewayKind 把历史默认值 openai-compatible 归为 independent', () => {
    expect(resolveGatewayKind('agent2api')).toBe('agent2api');
    expect(resolveGatewayKind('bifrost')).toBe('bifrost');
    expect(resolveGatewayKind('openai-compatible')).toBe('independent');
    expect(resolveGatewayKind('')).toBe('independent');
  });
});

describe('Agent2APIAdapter（主聚合网关）', () => {
  const modelsRoute: MockRoute = {
    method: 'GET',
    match: (url) => url === 'http://127.0.0.1:3065/v1/models',
    reply: () => ({
      body: {
        object: 'list',
        data: [
          { id: 'gpt-x', name: 'GPT X', maxInputTokens: 128000, owned_by: 'prov-a' },
          { id: 'glm-4', name: 'GLM-4' },
        ],
        meta: { lastRefreshedAt: 1690000000000 },
      },
    }),
  };

  it('listModels 归一化目录（displayName/contextWindow 取自网关字段，raw 原样保留）', async () => {
    const mock = createMockFetch([modelsRoute]);
    const adapter = new Agent2APIAdapter(config('agent2api'), mock.fetchImpl);
    const result = await adapter.listModels();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({ id: 'gpt-x', displayName: 'GPT X', contextWindow: 128000, ownedBy: 'prov-a' });
    expect(result.models[1]).toMatchObject({ id: 'glm-4', displayName: 'GLM-4' });
    expect(result.models[0]!.raw).toMatchObject({ maxInputTokens: 128000 });
  });

  it('listModels 未配置密钥时不携带鉴权头（公开清单）', async () => {
    const mock = createMockFetch([modelsRoute]);
    const adapter = new Agent2APIAdapter(config('agent2api'), mock.fetchImpl);
    await adapter.listModels();
    expect(mock.calls[0]!.headers.get('authorization')).toBeNull();
  });

  it('listModels 配置密钥时以 Bearer 携带', async () => {
    const mock = createMockFetch([modelsRoute]);
    const adapter = new Agent2APIAdapter(config('agent2api', { apiKey: 'a2a-key' }), mock.fetchImpl);
    await adapter.listModels();
    expect(mock.calls[0]!.headers.get('authorization')).toBe('Bearer a2a-key');
  });

  it('listModels 非 2xx 返回 ok:false（不抛异常）', async () => {
    const mock = createMockFetch([
      { method: 'GET', match: () => true, reply: () => ({ status: 401, body: { error: 'bad key' } }) },
    ]);
    const adapter = new Agent2APIAdapter(config('agent2api', { apiKey: 'a2a-key' }), mock.fetchImpl);
    const result = await adapter.listModels();
    expect(result).toMatchObject({ ok: false, httpStatus: 401 });
  });

  it('getHealth ok/degraded/unreachable 三态', async () => {
    const ok = createMockFetch([
      { method: 'GET', match: () => true, reply: () => ({ body: { status: 'ok', transport: 'upstream-api', models: 42 } }) },
    ]);
    const degraded = createMockFetch([
      { method: 'GET', match: () => true, reply: () => ({ body: { status: 'degraded' } }) },
    ]);
    const down = createRejectingFetch();
    const adapter = (fetch: FetchImpl) => new Agent2APIAdapter(config('agent2api'), fetch);

    const okReport = await adapter(ok.fetchImpl).getHealth();
    expect(okReport.status).toBe('ok');
    expect(okReport.probeEndpoint).toBe('GET http://127.0.0.1:3065/health');
    expect(okReport.latencyMs).toBeTypeOf('number');

    const degradedReport = await adapter(degraded.fetchImpl).getHealth();
    expect(degradedReport.status).toBe('degraded');

    const downReport = await adapter(down).getHealth();
    expect(downReport.status).toBe('unreachable');
    expect(downReport.detail).toBeTruthy();
  });

  it('getQuota 读取真实快照：accounts 原样透传（usage 不换算、error/code 保留）', async () => {
    const snapshot = {
      at: 1730000000000,
      results: [
        { id: 'acc-1', name: '账号一', usage: { credits: 120.5, total: 1000 } },
        { id: 'acc-2', name: '账号二', error: '余额查询失败', code: 'UPSTREAM_ERROR' },
      ],
      skipped: 1,
    };
    const mock = createMockFetch([
      {
        method: 'GET',
        match: (url) => url === 'http://127.0.0.1:3065/api/accounts/usage/snapshot',
        reply: () => ({ body: snapshot }),
      },
    ]);
    const adapter = new Agent2APIAdapter(config('agent2api', { apiKey: 'a2a-key' }), mock.fetchImpl);
    const report = await adapter.getQuota();
    expect(report.status).toBe('ok');
    expect(report.endpoint).toBe('GET http://127.0.0.1:3065/api/accounts/usage/snapshot');
    expect(report.accounts).toHaveLength(2);
    expect(report.accounts![0]).toMatchObject({ accountId: 'acc-1', name: '账号一' });
    expect(report.accounts![0]!.usage).toEqual({ credits: 120.5, total: 1000 });
    expect(report.accounts![1]).toMatchObject({ accountId: 'acc-2', error: '余额查询失败', code: 'UPSTREAM_ERROR' });
    expect(report.skipped).toBe(1);
  });

  it('getQuota 未配置密钥：status=error、不发请求、无任何编造读数', async () => {
    const mock = createMockFetch([]);
    const adapter = new Agent2APIAdapter(config('agent2api'), mock.fetchImpl);
    const report = await adapter.getQuota();
    expect(report.status).toBe('error');
    expect(report.reason).toContain('未配置');
    expect(report).not.toHaveProperty('accounts');
    expect(mock.calls).toHaveLength(0);
  });

  it('getQuota 401/403：status=error、无 accounts 字段', async () => {
    const mock = createMockFetch([
      { method: 'GET', match: () => true, reply: () => ({ status: 403, body: { error: 'management_access_denied' } }) },
    ]);
    const adapter = new Agent2APIAdapter(config('agent2api', { apiKey: 'restricted' }), mock.fetchImpl);
    const report = await adapter.getQuota();
    expect(report.status).toBe('error');
    expect(report.httpStatus).toBe(403);
    expect(report.reason).toContain('不返回编造数据');
    expect(report).not.toHaveProperty('accounts');
  });

  it('chat 未配置密钥时本地拒绝，不发起请求', async () => {
    const mock = createMockFetch([]);
    const adapter = new Agent2APIAdapter(config('agent2api'), mock.fetchImpl);
    const result = await adapter.chat!({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Key');
    expect(mock.calls).toHaveLength(0);
  });

  it('chat POST /v1/chat/completions，body 为允许字段，Bearer 头携带', async () => {
    const mock = createMockFetch([
      {
        method: 'POST',
        match: (url) => url === 'http://127.0.0.1:3065/v1/chat/completions',
        reply: () => ({ body: { id: 'cmpl-1', choices: [{ message: { role: 'assistant', content: 'hi' } }] } }),
      },
    ]);
    const adapter = new Agent2APIAdapter(config('agent2api', { apiKey: 'a2a-key' }), mock.fetchImpl);
    const result = await adapter.chat!({
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      maxTokens: 64,
    });
    expect(result.ok).toBe(true);
    expect(mock.calls[0]!.headers.get('authorization')).toBe('Bearer a2a-key');
    expect(JSON.parse(mock.calls[0]!.bodyText)).toEqual({
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      max_tokens: 64,
    });
  });
});

describe('BifrostAdapter（独立网关路径）', () => {
  const bifrostBase = 'https://gateway.example.com/v1';

  it('listModels 命中 {base}/models 且同时携带 x-bf-vk 与 Bearer（x-bf-vk 为实测 401 报文指定）', async () => {
    const mock = createMockFetch([
      {
        method: 'GET',
        match: (url) => url === `${bifrostBase}/models`,
        reply: () => ({ body: { object: 'list', data: [{ id: 'agnes/agnes-image-2.5-flash', object: 'model', owned_by: 'org' }] } }),
      },
    ]);
    const adapter = new BifrostAdapter(config('bifrost', { baseUrl: bifrostBase, apiKey: 'vk-123' }), mock.fetchImpl);
    const result = await adapter.listModels();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models[0]).toMatchObject({ id: 'agnes/agnes-image-2.5-flash', ownedBy: 'org' });
    expect(mock.calls[0]!.headers.get('x-bf-vk')).toBe('vk-123');
    expect(mock.calls[0]!.headers.get('authorization')).toBe('Bearer vk-123');
  });

  it('listModels 401（virtual_key_required）→ ok:false 且 httpStatus 401', async () => {
    const mock = createMockFetch([
      {
        method: 'GET',
        match: () => true,
        reply: () => ({
          status: 401,
          body: { type: 'virtual_key_required', error: { message: 'virtual key is required. Provide a virtual key via the x-bf-vk header.' } },
        }),
      },
    ]);
    const adapter = new BifrostAdapter(config('bifrost', { baseUrl: bifrostBase }), mock.fetchImpl);
    const result = await adapter.listModels();
    expect(result).toMatchObject({ ok: false, httpStatus: 401 });
  });

  it('getQuota 恒为 not_provided：理由含「网关未提供」，且绝无编造读数字段、零网络请求', async () => {
    const mock = createMockFetch([]);
    const adapter = new BifrostAdapter(config('bifrost', { baseUrl: bifrostBase, apiKey: 'vk-123' }), mock.fetchImpl);
    const report = await adapter.getQuota();
    expect(report.status).toBe('not_provided');
    expect(report.reason).toContain('网关未提供');
    expect(report).not.toHaveProperty('accounts');
    expect(report).not.toHaveProperty('endpoint');
    expect(mock.calls).toHaveLength(0);
  });

  it('getHealth 200 → ok；401 → degraded（鉴权未过）；断网 → unreachable', async () => {
    const ok = createMockFetch([{ method: 'GET', match: () => true, reply: () => ({ body: { object: 'list', data: [] } }) }]);
    const auth = createMockFetch([
      { method: 'GET', match: () => true, reply: () => ({ status: 401, body: { type: 'virtual_key_required' } }) },
    ]);
    const down = createRejectingFetch();
    const make = (fetch: FetchImpl) => new BifrostAdapter(config('bifrost', { baseUrl: bifrostBase, apiKey: 'vk-123' }), fetch);

    const okReport = await make(ok.fetchImpl).getHealth();
    expect(okReport.status).toBe('ok');
    expect(okReport.probeEndpoint).toBe(`GET ${bifrostBase}/models`);

    const authReport = await make(auth.fetchImpl).getHealth();
    expect(authReport.status).toBe('degraded');
    expect(authReport.httpStatus).toBe(401);

    const downReport = await make(down).getHealth();
    expect(downReport.status).toBe('unreachable');
  });

  it('chat 未配置 virtual key 时本地拒绝', async () => {
    const mock = createMockFetch([]);
    const adapter = new BifrostAdapter(config('bifrost', { baseUrl: bifrostBase }), mock.fetchImpl);
    const result = await adapter.chat!({ model: 'm', messages: [] });
    expect(result.ok).toBe(false);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('IndependentApiAdapter（独立第三方 API 直连）', () => {
  const base = 'https://third.example.com/v1';

  it('listModels 以 Bearer 调 {base}/models 并归一化', async () => {
    const mock = createMockFetch([
      {
        method: 'GET',
        match: (url) => url === `${base}/models`,
        reply: () => ({ body: { object: 'list', data: [{ id: 'deepseek-chat', owned_by: 'vendor' }] } }),
      },
    ]);
    const adapter = new IndependentApiAdapter(config('independent', { baseUrl: base, apiKey: 'sk-third' }), mock.fetchImpl);
    const result = await adapter.listModels();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models[0]).toMatchObject({ id: 'deepseek-chat', ownedBy: 'vendor' });
    expect(mock.calls[0]!.headers.get('authorization')).toBe('Bearer sk-third');
  });

  it('getQuota 恒为 not_provided（网关未提供），无编造字段、零请求', async () => {
    const mock = createMockFetch([]);
    const adapter = new IndependentApiAdapter(config('independent', { baseUrl: base }), mock.fetchImpl);
    const report = await adapter.getQuota();
    expect(report.status).toBe('not_provided');
    expect(report.reason).toContain('网关未提供');
    expect(report).not.toHaveProperty('accounts');
    expect(mock.calls).toHaveLength(0);
  });

  it('getHealth 401 → degraded；chat 无密钥也可发起（第三方可能免鉴权）', async () => {    const auth = createMockFetch([{ method: 'GET', match: () => true, reply: () => ({ status: 401, body: {} }) }]);
    const adapter = new IndependentApiAdapter(config('independent', { baseUrl: base }), auth.fetchImpl);
    expect((await adapter.getHealth()).status).toBe('degraded');

    const chatMock = createMockFetch([
      { method: 'POST', match: () => true, reply: () => ({ body: { id: 'cmpl-2' } }) },
    ]);
    const chatAdapter = new IndependentApiAdapter(config('independent', { baseUrl: base }), chatMock.fetchImpl);
    const result = await chatAdapter.chat!({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(true);
    expect(chatMock.calls[0]!.url).toBe(`${base}/chat/completions`);
  });
});
