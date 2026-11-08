/**
 * gateway_adapters → SchedulerPorts 桥接（只消费适配器接口，不修改任何适配器代码）。
 *
 * M8 的 GatewayAdapter 是异步接口（listModels/getHealth 各自发探测）；
 * 调度引擎是同步决策，本桥在每轮调度前把适配器读数一次性解析为端口快照：
 * - 网关清单与健康：来自 adapter.config + getHealth()；
 *   HealthReport.status 映射：ok→healthy、degraded→degraded、unreachable→unavailable、
 *   not_provided→healthy（网关未提供探测端点 ≠ 不健康，不武断降级）；
 * - 模型目录：listModels() 成功的条目归一化（capabilities 适配器暂不提供，置空，
 *   能力要求经 settings 目录快照补充）；读取失败的网关本轮没有候选（诚实降级，不编造目录）；
 * - 用量：QuotaReport 是账户级原始读数，无归一化比率，因此用量继续走
 *   settings 'scheduler.resource_usage' 通道，由运维/适配器侧换算后写入。
 */
import type { GatewayAdapter, HealthReport } from '../adapters/types.js';
import type {
  GatewayHealthState,
  GatewayResource,
  ModelCatalogEntry,
  ResourceUsage,
} from './types.js';
import type { SchedulerPorts } from './ports.js';

export function mapAdapterHealth(report: HealthReport): GatewayHealthState {
  switch (report.status) {
    case 'degraded':
      return 'degraded';
    case 'unreachable':
      return 'unavailable';
    case 'ok':
    case 'not_provided':
      return 'healthy';
  }
}

export async function createPortsFromAdapters(
  adapters: GatewayAdapter[],
  options: { usage?: ResourceUsage[] } = {},
): Promise<SchedulerPorts> {
  const [healthSnapshots, catalogSnapshots] = await Promise.all([
    Promise.all(
      adapters.map(async (adapter) => ({
        adapter,
        health: mapAdapterHealth(await adapter.getHealth()),
      })),
    ),
    Promise.all(
      adapters.map(async (adapter) => ({
        adapter,
        catalog: await adapter.listModels(),
      })),
    ),
  ]);

  const gateways: GatewayResource[] = healthSnapshots.map(({ adapter, health }) => ({
    id: adapter.config.id,
    name: adapter.config.name,
    kind: adapter.config.kind,
    enabled: true,
    health,
  }));

  const catalog: ModelCatalogEntry[] = [];
  for (const { adapter, catalog: result } of catalogSnapshots) {
    if (!result.ok) continue;
    for (const model of result.models) {
      catalog.push({
        gatewayId: adapter.config.id,
        modelId: model.id,
        capabilities: [],
        contextWindow: model.contextWindow ?? null,
      });
    }
  }

  const usage = options.usage ?? [];
  return {
    listGateways: () => gateways,
    listCatalog: () => catalog,
    listUsage: () => usage,
  };
}
