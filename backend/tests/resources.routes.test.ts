/**
 * 资源平面路由的 HTTP 级测试（Hono app.request + 内存库 + mock fetch）：
 * CRUD、错误信封、404/400 语义、「网关未提供」端到端可见、密钥材料零泄漏。
 */

import { describe, expect, it } from 'vitest';
import { appWithResources, createTestService, type MockRoute, type TestServiceHandle } from './helpers.js';

const A2A_HEALTH: MockRoute = {
  method: 'GET',
  match: (url) => url === 'http://127.0.0.1:3065/health',
  reply: () => ({ body: { status: 'ok', models: 42 } }),
};

const A2A_SNAPSHOT: MockRoute = {
  method: 'GET',
  match: (url) => url === 'http://127.0.0.1:3065/api/accounts/usage/snapshot',
  reply: () => ({
    body: { at: 1730000000000, results: [{ id: 'acc-1', name: '账号一', usage: { credits: 120.5, total: 1000 } }], skipped: 0 },
  }),
};

function bootstrap(routes: MockRoute[] = []): { handle: TestServiceHandle; app: ReturnType<typeof appWithResources> } {
  const handle = createTestService([...routes, A2A_HEALTH, A2A_SNAPSHOT], { WORKMESH_TEST_A2A_KEY: 'a2a-secret-0001' });
  return { handle, app: appWithResources(handle.service) };
}

async function createGateway(app: ReturnType<typeof appWithResources>, body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await app.request('/resources/gateways', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { gateway: { id: string } };
  return { id: json.gateway.id };
}

describe('网关 CRUD 路由', () => {
  it('POST → 201；响应与错误信封不含密钥材料', async () => {
    const { app } = bootstrap();
    const res = await app.request('/resources/gateways', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'agent2api-main',
        type: 'agent2api',
        base_url: 'http://127.0.0.1:3065',
        api_key_env: 'WORKMESH_TEST_A2A_KEY',
        enabled: true,
      }),
    });
    expect(res.status).toBe(201);
    const raw = await res.text();
    expect(raw).not.toContain('a2a-secret-0001');
    const json = JSON.parse(raw) as { gateway: Record<string, unknown> };
    expect(json.gateway).toMatchObject({ name: 'agent2api-main', type: 'agent2api', api_key_env: 'WORKMESH_TEST_A2A_KEY', enabled: 1 });
  });

  it('GET 列表与详情；未知 id → 404 信封', async () => {
    const { handle, app } = bootstrap();
    const { id } = await createGateway(app, { name: 'g1', base_url: 'https://a.example.com/v1', type: 'independent' });

    const list = await app.request('/resources/gateways');
    expect(list.status).toBe(200);
    const listJson = (await list.json()) as { gateways: unknown[] };
    expect(listJson.gateways).toHaveLength(1);

    const detail = await app.request(`/resources/gateways/${id}`);
    expect(detail.status).toBe(200);

    const missing = await app.request('/resources/gateways/ghost');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'not_found' });
    expect(handle.service.listGateways()).toHaveLength(1);
  });

  it('PATCH 更新；非法输入与重复名 → 400 validation_error', async () => {
    const { app } = bootstrap();
    const { id } = await createGateway(app, { name: 'g1', base_url: 'https://a.example.com/v1' });

    const patched = await app.request(`/resources/gateways/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base_url: 'https://b.example.com/v1', enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { gateway: Record<string, unknown> }).gateway).toMatchObject({
      base_url: 'https://b.example.com/v1',
      enabled: 0,
    });

    const badType = await app.request(`/resources/gateways/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'quantum' }),
    });
    expect(badType.status).toBe(400);
    expect(await badType.json()).toMatchObject({ error: 'validation_error' });

    const badUrl = await app.request(`/resources/gateways/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base_url: 'javascript:alert(1)' }),
    });
    expect(badUrl.status).toBe(400);
  });

  it('DELETE → 204；再查 404；再删 404', async () => {
    const { app } = bootstrap();
    const { id } = await createGateway(app, { name: 'g1', base_url: 'https://a.example.com/v1' });
    const removed = await app.request(`/resources/gateways/${id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect((await app.request(`/resources/gateways/${id}`)).status).toBe(404);
    const again = await app.request(`/resources/gateways/${id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  it('非法 JSON body → 400 validation_error', async () => {
    const { app } = bootstrap();
    const res = await app.request('/resources/gateways', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'validation_error' });
  });
});

describe('模型逻辑目录路由', () => {
  it('模型 CRUD + PUT 绑定 + catalog 视图', async () => {
    const { app } = bootstrap();
    const a2a = await createGateway(app, { name: 'a2a', type: 'agent2api', base_url: 'http://127.0.0.1:3065' });

    const created = await app.request('/resources/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'chat-default', context_window: 128000 }),
    });
    expect(created.status).toBe(201);
    const { model } = (await created.json()) as { model: { id: string } };

    const bound = await app.request(`/resources/models/${model.id}/bindings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bindings: [{ gatewayId: a2a.id, upstreamModel: 'gpt-x', priority: 3 }] }),
    });
    expect(bound.status).toBe(200);
    const bindingsJson = (await bound.json()) as { bindings: Array<{ upstream_model: string }> };
    expect(bindingsJson.bindings[0]!.upstream_model).toBe('gpt-x');

    const catalog = await app.request(`/resources/models/${model.id}/catalog`);
    expect(catalog.status).toBe(200);
    const catalogJson = (await catalog.json()) as { bindings: Array<{ gateway: { type: string } }> };
    expect(catalogJson.bindings[0]!.gateway.type).toBe('agent2api');

    const removed = await app.request(`/resources/models/${model.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
  });

  it('PATCH /models/:id 更新生效；空 name → 400；未知 id → 404', async () => {
    const { app } = bootstrap();
    const created = await app.request('/resources/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'chat-default', provider: 'openai', context_window: 128000 }),
    });
    expect(created.status).toBe(201);
    const { model } = (await created.json()) as { model: { id: string } };

    const patched = await app.request(`/resources/models/${model.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'chat-main', context_window: 200000, enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { model: Record<string, unknown> }).model).toMatchObject({
      id: model.id,
      name: 'chat-main',
      context_window: 200000,
      enabled: 0,
    });

    const badName = await app.request(`/resources/models/${model.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(badName.status).toBe(400);
    expect(await badName.json()).toMatchObject({ error: 'validation_error' });

    const ghost = await app.request('/resources/models/ghost', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toMatchObject({ error: 'not_found' });
  });

  it('绑定未知网关 → 400；未知模型 → 404', async () => {
    const { app } = bootstrap();
    const model = await app.request('/resources/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'm1' }),
    });
    const { model: m } = (await model.json()) as { model: { id: string } };

    const badBinding = await app.request(`/resources/models/${m.id}/bindings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bindings: [{ gatewayId: 'ghost', upstreamModel: 'x' }] }),
    });
    expect(badBinding.status).toBe(400);

    const ghost = await app.request('/resources/models/ghost');
    expect(ghost.status).toBe(404);
  });
});

describe('额度与健康监控端点（「网关未提供」端到端）', () => {
  it('bifrost 网关的 quota 端点返回 not_provided，绝不带编造读数', async () => {
    const { app } = bootstrap();
    const bf = await createGateway(app, { name: 'bf', type: 'bifrost', base_url: 'https://models.fyrali.com/openai/v1' });
    const res = await app.request(`/resources/gateways/${bf.id}/quota`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const report = JSON.parse(raw) as Record<string, unknown>;
    expect(report['status']).toBe('not_provided');
    expect(String(report['reason'])).toContain('网关未提供');
    expect(report).not.toHaveProperty('accounts');
    expect(report).not.toHaveProperty('endpoint');
  });

  it('agent2api 网关的 quota 端点透传真实快照；密钥不出现在响应中', async () => {
    const { app } = bootstrap();
    const a2a = await createGateway(app, {
      name: 'a2a',
      type: 'agent2api',
      base_url: 'http://127.0.0.1:3065',
      api_key_env: 'WORKMESH_TEST_A2A_KEY',
    });
    const res = await app.request(`/resources/gateways/${a2a.id}/quota`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('a2a-secret-0001');
    const report = JSON.parse(raw) as { status: string; accounts: Array<{ accountId: string; usage: unknown }> };
    expect(report.status).toBe('ok');
    expect(report.accounts[0]).toMatchObject({ accountId: 'acc-1', usage: { credits: 120.5, total: 1000 } });
  });

  it('health 端点返回探测结果；monitoring 汇总覆盖启用网关并标注停用跳过', async () => {
    const { app } = bootstrap();
    const a2a = await createGateway(app, {
      name: 'a2a',
      type: 'agent2api',
      base_url: 'http://127.0.0.1:3065',
      api_key_env: 'WORKMESH_TEST_A2A_KEY',
    });
    const bf = await createGateway(app, { name: 'bf', type: 'bifrost', base_url: 'https://models.fyrali.com/openai/v1', enabled: false });

    const health = await app.request(`/resources/gateways/${a2a.id}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ gatewayId: a2a.id, status: 'ok', probeEndpoint: 'GET http://127.0.0.1:3065/health' });

    const overview = await app.request('/resources/monitoring/health');
    expect(overview.status).toBe(200);
    const healthJson = (await overview.json()) as {
      gateways: Array<{ gatewayId: string; status: string }>;
      skipped: Array<{ gatewayId: string; reason: string }>;
    };
    expect(healthJson.gateways.map((g) => g.gatewayId)).toEqual([a2a.id]);
    expect(healthJson.skipped).toEqual([{ gatewayId: bf.id, gatewayName: 'bf', reason: 'gateway is disabled' }]);

    const quotaOverview = await app.request('/resources/monitoring/quota');
    expect(quotaOverview.status).toBe(200);
    const quotaJson = (await quotaOverview.json()) as { gateways: Array<{ gatewayId: string; report: { status: string } }> };
    expect(quotaJson.gateways[0]!.gatewayId).toBe(a2a.id);
    expect(quotaJson.gateways[0]!.report.status).toBe('ok');
  });

  it('models 探测端点：未知网关 404', async () => {
    const { app } = bootstrap();
    const res = await app.request('/resources/gateways/ghost/models');
    expect(res.status).toBe(404);
  });
});
