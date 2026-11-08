/**
 * ResourcesService 单测（内存 SQLite + mock fetch）：
 * 网关 CRUD 校验、模型逻辑目录与绑定 CRUD、密钥仅存引用、监控数据透传。
 */

import { describe, expect, it } from 'vitest';
import { findBinding } from '../src/services/resources.js';
import type { MockRoute } from './helpers.js';
import { createTestService, type TestServiceHandle } from './helpers.js';

const A2A_HEALTH: MockRoute = {
  method: 'GET',
  match: (url) => url === 'http://127.0.0.1:3065/health',
  reply: () => ({ body: { status: 'ok', transport: 'upstream-api', models: 42 } }),
};

const A2A_SNAPSHOT: MockRoute = {
  method: 'GET',
  match: (url) => url === 'http://127.0.0.1:3065/api/accounts/usage/snapshot',
  reply: () => ({
    body: {
      at: 1730000000000,
      results: [{ id: 'acc-1', name: '账号一', usage: { credits: 120.5, total: 1000 } }],
      skipped: 0,
    },
  }),
};

function bootstrap(routes: MockRoute[] = []): TestServiceHandle {
  return createTestService([...routes, A2A_HEALTH, A2A_SNAPSHOT], { WORKMESH_TEST_A2A_KEY: 'a2a-secret-0001' });
}

function seedGateways(handle: TestServiceHandle): { a2aId: string; bifrostId: string; directId: string } {
  const a2a = handle.service.createGateway({
    name: 'agent2api-main',
    type: 'agent2api',
    base_url: 'http://127.0.0.1:3065',
    api_key_env: 'WORKMESH_TEST_A2A_KEY',
  });
  const bifrost = handle.service.createGateway({
    name: 'bifrost-remote',
    type: 'bifrost',
    base_url: 'https://models.fyrali.com/openai/v1',
    api_key_env: 'WORKMESH_TEST_BF_KEY',
  });
  const direct = handle.service.createGateway({
    name: 'standby-api',
    base_url: 'https://third.example.com/v1',
    enabled: false,
  });
  return { a2aId: a2a.id, bifrostId: bifrost.id, directId: direct.id };
}

describe('网关 CRUD', () => {
  it('创建：type 归一化、base_url 校验、密钥只存 env 名', () => {
    const handle = bootstrap();
    const { a2aId, directId } = seedGateways(handle);
    const a2a = handle.service.getGateway(a2aId);
    expect(a2a.type).toBe('agent2api');
    expect(a2a.api_key_env).toBe('WORKMESH_TEST_A2A_KEY');
    const direct = handle.service.getGateway(directId);
    expect(direct.type).toBe('independent');
    expect(direct.enabled).toBe(0);
  });

  it('历史默认值 openai-compatible 被归一化为 independent', () => {
    const handle = bootstrap();
    const row = handle.service.createGateway({ name: 'legacy', base_url: 'https://x.example.com/v1', type: 'openai-compatible' });
    expect(row.type).toBe('independent');
  });

  it('非法 type / 非法 base_url / 空 name 均拒绝', () => {
    const handle = bootstrap();
    expect(() => handle.service.createGateway({ name: 'x', base_url: 'https://a.example.com', type: 'quantum' })).toThrowError(/unknown gateway type/);
    expect(() => handle.service.createGateway({ name: 'x', base_url: 'ftp://a.example.com' })).toThrowError(/must be http\(s\)/);
    expect(() => handle.service.createGateway({ name: 'x', base_url: 'not a url' })).toThrowError(/not a valid URL/);
    expect(() => handle.service.createGateway({ name: '   ', base_url: 'https://a.example.com' })).toThrowError(/name/);
    expect(() => handle.service.createGateway({ name: 'x', base_url: 'https://a.example.com', api_key_env: 'has space' })).toThrowError(/environment variable/);
  });

  it('同名冲突与未知 id 报错语义正确', () => {
    const handle = bootstrap();
    handle.service.createGateway({ name: 'dup', base_url: 'https://a.example.com/v1' });
    expect(() => handle.service.createGateway({ name: 'dup', base_url: 'https://b.example.com/v1' })).toThrowError(/already exists/);
    expect(() => handle.service.updateGateway('missing', { name: 'n' })).toThrowError(/not found/);
    expect(() => handle.service.deleteGateway('missing')).toThrowError(/not found/);
  });

  it('更新：字段生效且可回读', () => {
    const handle = bootstrap();
    const { a2aId } = seedGateways(handle);
    const updated = handle.service.updateGateway(a2aId, { base_url: 'http://127.0.0.1:3066', enabled: false });
    expect(updated.base_url).toBe('http://127.0.0.1:3066');
    expect(updated.enabled).toBe(0);
  });

  it('删除被绑定引用的网关被拒绝；解除后可删', () => {
    const handle = bootstrap();
    const { a2aId } = seedGateways(handle);
    const model = handle.service.createModel({ name: 'chat-default' });
    handle.service.setBindings(model.id, [{ gatewayId: a2aId, upstreamModel: 'gpt-x' }]);
    expect(() => handle.service.deleteGateway(a2aId)).toThrowError(/model binding/);
    handle.service.setBindings(model.id, []);
    handle.service.deleteGateway(a2aId);
    expect(handle.service.findGateway(a2aId)).toBeUndefined();
  });
});

describe('模型逻辑目录与绑定', () => {
  it('模型 CRUD + 绑定整体替换 + 目录视图拼接网关配置', () => {
    const handle = bootstrap();
    const { a2aId, bifrostId } = seedGateways(handle);
    const model = handle.service.createModel({ name: 'chat-default', context_window: 128000 });
    expect(handle.service.listModels()).toHaveLength(1);

    handle.service.setBindings(model.id, [
      { gatewayId: a2aId, upstreamModel: 'gpt-x', priority: 10 },
      { gatewayId: bifrostId, upstreamModel: 'glm-4', priority: 5 },
    ]);
    const bindings = handle.service.listBindings(model.id);
    expect(bindings.map((b) => b.upstream_model)).toEqual(['gpt-x', 'glm-4']); // priority 降序

    const catalog = handle.service.getModelCatalog(model.id);
    expect(catalog.model.name).toBe('chat-default');
    expect(catalog.bindings[0]!.gateway).toMatchObject({ id: a2aId, type: 'agent2api', base_url: 'http://127.0.0.1:3065' });

    // 整体替换：旧绑定消失
    handle.service.setBindings(model.id, [{ gatewayId: bifrostId, upstreamModel: 'glm-4' }]);
    expect(handle.service.listBindings(model.id)).toHaveLength(1);

    // 删除模型 → 绑定级联消失（findBinding 直查应为空；已删 id 再查报 not found）
    handle.service.deleteModel(model.id);
    expect(findBinding(handle.db, model.id, a2aId, 'gpt-x')).toBeUndefined();
    expect(() => handle.service.listBindings(model.id)).toThrowError(/not found/);
  });

  it('绑定校验：未知网关、空 upstream、重复绑定、非法 priority 均拒绝', () => {
    const handle = bootstrap();
    const { a2aId } = seedGateways(handle);
    const model = handle.service.createModel({ name: 'm' });
    expect(() => handle.service.setBindings(model.id, [{ gatewayId: 'ghost', upstreamModel: 'x' }])).toThrowError(/does not exist/);
    expect(() => handle.service.setBindings(model.id, [{ gatewayId: a2aId, upstreamModel: '  ' }])).toThrowError(/upstreamModel/);
    handle.service.setBindings(model.id, [{ gatewayId: a2aId, upstreamModel: 'gpt-x' }]);
    expect(() =>
      handle.service.setBindings(model.id, [
        { gatewayId: a2aId, upstreamModel: 'gpt-x' },
        { gatewayId: a2aId, upstreamModel: 'gpt-x' },
      ]),
    ).toThrowError(/duplicate binding/);
    expect(() => handle.service.setBindings(model.id, [{ gatewayId: a2aId, upstreamModel: 'y', priority: -1 }])).toThrowError(/priority/);
    // 失败的调用不留半截状态
    expect(handle.service.listBindings(model.id)).toHaveLength(1);
  });

  it('updateModel：字段生效可回读；未提及字段保持原值；空 name 与未知 id 拒绝', () => {
    const handle = bootstrap();
    const model = handle.service.createModel({ name: 'chat-default', provider: 'openai', context_window: 128000 });
    const updated = handle.service.updateModel(model.id, {
      name: 'chat-main',
      context_window: 200000,
      enabled: false,
    });
    expect(updated).toMatchObject({ id: model.id, name: 'chat-main', context_window: 200000, enabled: 0 });
    // patch 未提及的字段不被改动
    expect(handle.service.getModel(model.id)).toMatchObject({ provider: 'openai', name: 'chat-main' });

    expect(() => handle.service.updateModel(model.id, { name: '   ' })).toThrowError(/name/);
    expect(() => handle.service.updateModel('ghost', { name: 'x' })).toThrowError(/not found/);
    // 失败调用后数据不变
    expect(handle.service.getModel(model.id).name).toBe('chat-main');
  });

  it('模型重名校拒；未知模型 id 报 not found', () => {
    const handle = bootstrap();
    handle.service.createModel({ name: 'dup' });
    expect(() => handle.service.createModel({ name: 'dup' })).toThrowError(/already exists/);
    expect(() => handle.service.getModel('ghost')).toThrowError(/not found/);
  });
});

describe('监控数据（额度/健康透传）', () => {
  it('gatewayQuota：agent2api 读真实快照；bifrost 返回 not_provided 且无编造读数', async () => {
    const handle = bootstrap();
    const { a2aId, bifrostId } = seedGateways(handle);

    const a2aQuota = await handle.service.gatewayQuota(a2aId);
    expect(a2aQuota.status).toBe('ok');
    expect(a2aQuota.accounts![0]).toMatchObject({ accountId: 'acc-1', usage: { credits: 120.5, total: 1000 } });

    const bfQuota = await handle.service.gatewayQuota(bifrostId);
    expect(bfQuota.status).toBe('not_provided');
    expect(bfQuota.reason).toContain('网关未提供');
    expect(bfQuota).not.toHaveProperty('accounts');
  });

  it('gatewayHealth：agent2api 经 /health 探测为 ok', async () => {
    const handle = bootstrap();
    const { a2aId } = seedGateways(handle);
    const report = await handle.service.gatewayHealth(a2aId);
    expect(report.status).toBe('ok');
    expect(report.probeEndpoint).toBe('GET http://127.0.0.1:3065/health');
  });

  it('overview 巡检只探测启用网关，停用进 skipped', async () => {
    const handle = bootstrap();
    const { a2aId, bifrostId, directId } = seedGateways(handle);
    const health = await handle.service.overviewHealth();
    expect(health.gateways.map((g) => g.gatewayId).sort()).toEqual([a2aId, bifrostId].sort());
    expect(health.skipped.map((s) => s.gatewayId)).toEqual([directId]);

    const quota = await handle.service.overviewQuota();
    const byId = new Map(quota.gateways.map((g) => [g.gatewayId, g.report]));
    expect(byId.get(a2aId)!.status).toBe('ok');
    expect(byId.get(bifrostId)!.status).toBe('not_provided');
  });

  it('密钥经 secretResolver 注入且不出现在任何响应/报告中', async () => {
    const handle = bootstrap();
    const { a2aId } = seedGateways(handle);
    const quota = await handle.service.gatewayQuota(a2aId);
    expect(JSON.stringify(quota)).not.toContain('a2a-secret-0001');
    expect(handle.service.getGateway(a2aId)).not.toHaveProperty('apiKey');
  });
});
