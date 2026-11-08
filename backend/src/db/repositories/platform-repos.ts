import type { SqlDb } from '../sqlite.js';
import { get } from '../sql.js';
import { createFlatRepo, type FlatRepo, type ListOptions } from './flat-repo.js';
import type {
  Agent,
  CreateAgent,
  CreateGateway,
  CreateModel,
  CreateQuota,
  Gateway,
  Model,
  Quota,
  UpdateAgent,
  UpdateGateway,
  UpdateModel,
  UpdateQuota,
} from '../../types/entities.js';

// ---------- models ----------
export interface ModelFilter extends Partial<Pick<Model, 'enabled'>>, ListOptions {}

export type ModelsRepo = FlatRepo<Model, CreateModel, UpdateModel, ModelFilter> & {
  getByName(name: string): Model | undefined;
};

export function newModelsRepo(db: SqlDb): ModelsRepo {
  const flat = createFlatRepo<Model, CreateModel, UpdateModel, ModelFilter>(db, {
    table: 'models',
    required: ['name'],
    createColumns: ['id', 'name', 'provider', 'base_url', 'api_key_env', 'context_window', 'enabled'],
    updateColumns: ['name', 'provider', 'base_url', 'api_key_env', 'context_window', 'enabled'],
    filterColumns: ['enabled'],
    conflictMessage: 'model name already exists',
  });
  return {
    ...flat,
    getByName(name: string): Model | undefined {
      return get<Model>(db, 'SELECT * FROM models WHERE name = ?', [name]);
    },
  };
}

// ---------- gateways ----------
export interface GatewayFilter extends Partial<Pick<Gateway, 'enabled' | 'type'>>, ListOptions {}

export type GatewaysRepo = FlatRepo<Gateway, CreateGateway, UpdateGateway, GatewayFilter> & {
  getByName(name: string): Gateway | undefined;
};

export function newGatewaysRepo(db: SqlDb): GatewaysRepo {
  const flat = createFlatRepo<Gateway, CreateGateway, UpdateGateway, GatewayFilter>(db, {
    table: 'gateways',
    required: ['name'],
    createColumns: ['id', 'name', 'type', 'base_url', 'api_key_env', 'enabled'],
    updateColumns: ['name', 'type', 'base_url', 'api_key_env', 'enabled'],
    filterColumns: ['enabled', 'type'],
    conflictMessage: 'gateway name already exists',
  });
  return {
    ...flat,
    getByName(name: string): Gateway | undefined {
      return get<Gateway>(db, 'SELECT * FROM gateways WHERE name = ?', [name]);
    },
  };
}

// ---------- quotas ----------
export interface QuotaFilter
  extends Partial<Pick<Quota, 'gateway_id' | 'model_id' | 'metric' | 'window_type'>>,
  ListOptions {}

export type QuotasRepo = FlatRepo<Quota, CreateQuota, UpdateQuota, QuotaFilter>;

export function newQuotasRepo(db: SqlDb): QuotasRepo {
  return createFlatRepo<Quota, CreateQuota, UpdateQuota, QuotaFilter>(db, {
    table: 'quotas',
    required: ['metric', 'limit_value', 'window_type'],
    createColumns: ['id', 'gateway_id', 'model_id', 'metric', 'limit_value', 'window_type'],
    updateColumns: ['gateway_id', 'model_id', 'metric', 'limit_value', 'window_type'],
    filterColumns: ['gateway_id', 'model_id', 'metric', 'window_type'],
    missingReferenceMessage: 'referenced gateway/model does not exist',
  });
}

// ---------- agents ----------
export interface AgentFilter extends Partial<Pick<Agent, 'enabled'>>, ListOptions {}

export type AgentsRepo = FlatRepo<Agent, CreateAgent, UpdateAgent, AgentFilter> & {
  getByName(name: string): Agent | undefined;
};

export function newAgentsRepo(db: SqlDb): AgentsRepo {
  const flat = createFlatRepo<Agent, CreateAgent, UpdateAgent, AgentFilter>(db, {
    table: 'agents',
    required: ['name'],
    createColumns: ['id', 'name', 'role', 'system_prompt', 'model_id', 'enabled'],
    updateColumns: ['name', 'role', 'system_prompt', 'model_id', 'enabled'],
    filterColumns: ['enabled'],
    conflictMessage: 'agent name already exists',
    missingReferenceMessage: 'referenced model does not exist',
  });
  return {
    ...flat,
    getByName(name: string): Agent | undefined {
      return get<Agent>(db, 'SELECT * FROM agents WHERE name = ?', [name]);
    },
  };
}
