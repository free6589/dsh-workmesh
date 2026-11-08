/**
 * 适配器工厂：按网关类型构造对应实现类。三类实现互不共享逻辑
 * （仅复用无状态 HTTP/归一化工具），新增网关类型时在此登记。
 */

import { Agent2APIAdapter } from './agent2api.js';
import { BifrostAdapter } from './bifrost.js';
import { IndependentApiAdapter } from './independent.js';
import type { FetchImpl } from './http.js';
import type { GatewayAdapter, GatewayConfig } from './types.js';

export interface AdapterDeps {
  fetchImpl?: FetchImpl;
}

export function createGatewayAdapter(config: GatewayConfig, deps: AdapterDeps = {}): GatewayAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  switch (config.kind) {
    case 'agent2api':
      return new Agent2APIAdapter(config, fetchImpl);
    case 'bifrost':
      return new BifrostAdapter(config, fetchImpl);
    case 'independent':
      return new IndependentApiAdapter(config, fetchImpl);
  }
}

export { Agent2APIAdapter, BifrostAdapter, IndependentApiAdapter };
export * from './types.js';
export { GatewayHttpError, GatewayRequestError } from './http.js';
