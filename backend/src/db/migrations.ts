/**
 * 迁移清单。每条迁移由按序执行的语句组成，所有语句都使用
 * `CREATE ... IF NOT EXISTS`，配合 schema_migrations 账本实现幂等：
 * 重复执行既不会重复建表，账本丢失时也能安全重建记录。
 */
export interface Migration {
  id: string;
  statements: string[];
}

const TS = "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export const migrations: Migration[] = [
  {
    id: '0001_core',
    statements: [
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at ${TS},
        updated_at ${TS}
      )`,
      `CREATE TABLE IF NOT EXISTS project_repos (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        repo_full_name TEXT NOT NULL,
        default_branch TEXT NOT NULL DEFAULT 'main',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_at ${TS},
        updated_at ${TS},
        UNIQUE (project_id, repo_full_name)
      )`,
      `CREATE TABLE IF NOT EXISTS modules (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at ${TS},
        updated_at ${TS},
        UNIQUE (project_id, name)
      )`,
      `CREATE TABLE IF NOT EXISTS phases (
        id TEXT PRIMARY KEY,
        module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        objective TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','blocked')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at ${TS},
        updated_at ${TS},
        UNIQUE (module_id, name)
      )`,
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
        phase_id TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','blocked','done','cancelled')),
        priority INTEGER NOT NULL DEFAULT 0,
        created_at ${TS},
        updated_at ${TS}
      )`,
      `CREATE TABLE IF NOT EXISTS subtasks (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at ${TS},
        updated_at ${TS}
      )`,
      `CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at ${TS},
        PRIMARY KEY (task_id, depends_on_task_id),
        CHECK (task_id <> depends_on_task_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_project_repos_project ON project_repos(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_modules_project ON modules(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_phases_module ON phases(module_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_module ON tasks(module_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
      `CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id)`,
      `CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_dependencies(depends_on_task_id)`,
    ],
  },
  {
    id: '0002_platform',
    statements: [
      `CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL DEFAULT '',
        base_url TEXT NOT NULL DEFAULT '',
        api_key_env TEXT NOT NULL DEFAULT '',
        context_window INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_at ${TS},
        updated_at ${TS}
      )`,
      `CREATE TABLE IF NOT EXISTS gateways (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL DEFAULT 'openai-compatible',
        base_url TEXT NOT NULL DEFAULT '',
        api_key_env TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_at ${TS},
        updated_at ${TS}
      )`,
      `CREATE TABLE IF NOT EXISTS quotas (
        id TEXT PRIMARY KEY,
        gateway_id TEXT REFERENCES gateways(id) ON DELETE CASCADE,
        model_id TEXT REFERENCES models(id) ON DELETE CASCADE,
        metric TEXT NOT NULL CHECK (metric IN ('requests','tokens')),
        limit_value INTEGER NOT NULL,
        window_type TEXT NOT NULL CHECK (window_type IN ('hour','day','month')),
        created_at ${TS},
        updated_at ${TS}
      )`,
      `CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_at ${TS},
        updated_at ${TS}
      )`,
      `CREATE INDEX IF NOT EXISTS idx_quotas_gateway ON quotas(gateway_id)`,
      `CREATE INDEX IF NOT EXISTS idx_quotas_model ON quotas(model_id)`,
      `CREATE INDEX IF NOT EXISTS idx_agents_model ON agents(model_id)`,
    ],
  },
  {
    id: '0003_runtime',
    statements: [
      `CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        created_at ${TS},
        updated_at ${TS}
      )`,
      `CREATE TABLE IF NOT EXISTS run_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
        type TEXT NOT NULL DEFAULT 'log',
        payload TEXT NOT NULL DEFAULT '{}',
        created_at ${TS}
      )`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL DEFAULT 'system',
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT '',
        entity_id TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '{}',
        created_at ${TS}
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at ${TS}
      )`,
      `CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id)`,
      `CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id)`,
      `CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`,
      `CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, seq)`,
    ],
  },
  {
    // 模型资源平面（M8）：逻辑模型到网关的绑定目录。
    // 逻辑模型（models 表）通过本表引用网关（gateways 表）与上游模型名；
    // 绑定顺序（priority）只是数据，选择/调度策略由 scheduler 负责。
    id: '0004_resource_bindings',
    statements: [
      `CREATE TABLE IF NOT EXISTS model_gateway_bindings (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        gateway_id TEXT NOT NULL REFERENCES gateways(id) ON DELETE RESTRICT,
        upstream_model TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        created_at ${TS},
        updated_at ${TS},
        UNIQUE (model_id, gateway_id, upstream_model)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mgb_model ON model_gateway_bindings(model_id)`,
      `CREATE INDEX IF NOT EXISTS idx_mgb_gateway ON model_gateway_bindings(gateway_id)`,
    ],
  },
];
