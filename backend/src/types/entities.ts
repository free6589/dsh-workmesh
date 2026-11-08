/**
 * 实体类型定义：Row 接口与数据库列一一对应（snake_case）；
 * `Create*` 为创建入参，`Update*` 为部分更新入参。
 * 注意：api_key_env 只存环境变量名，任何密钥本身都不入库。
 */

/** SQLite 布尔列的取值：行里是 0|1，入参额外接受 true/false（写入前归一化）。 */
export type SqlBool = boolean | 0 | 1;

// ---------- projects ----------
export type ProjectStatus = 'active' | 'archived';

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateProject {
  id?: string;
  name: string;
  description?: string;
  status?: ProjectStatus;
}

export type UpdateProject = Partial<Pick<Project, 'name' | 'description' | 'status'>>;

// ---------- project_repos（项目关联的 GitHub 仓库，一对多） ----------
export interface ProjectRepoRow {
  id: string;
  project_id: string;
  repo_full_name: string; // 形如 'owner/repo'
  default_branch: string;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectRepo {
  id?: string;
  project_id: string;
  repo_full_name: string;
  default_branch?: string;
  enabled?: SqlBool;
}

export type UpdateProjectRepo = Partial<Pick<ProjectRepoRow, 'repo_full_name' | 'default_branch'>> & {
  enabled?: SqlBool;
};

// ---------- modules ----------
export type ModuleStatus = 'active' | 'completed' | 'archived';

export interface Module {
  id: string;
  project_id: string;
  name: string;
  description: string;
  status: ModuleStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CreateModule {
  id?: string;
  project_id: string;
  name: string;
  description?: string;
  status?: ModuleStatus;
  sort_order?: number;
}

export type UpdateModule = Partial<Pick<Module, 'name' | 'description' | 'status' | 'sort_order'>>;

// ---------- phases ----------
export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface Phase {
  id: string;
  module_id: string;
  name: string;
  objective: string;
  status: PhaseStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CreatePhase {
  id?: string;
  module_id: string;
  name: string;
  objective?: string;
  status?: PhaseStatus;
  sort_order?: number;
}

export type UpdatePhase = Partial<Pick<Phase, 'name' | 'objective' | 'status' | 'sort_order'>>;

// ---------- tasks ----------
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';

export interface Task {
  id: string;
  project_id: string;
  module_id: string;
  phase_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface CreateTask {
  id?: string;
  project_id: string;
  module_id: string;
  phase_id: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
}

export type UpdateTask = Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority'>>;

// ---------- subtasks ----------
export interface Subtask {
  id: string;
  task_id: string;
  title: string;
  done: 0 | 1;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CreateSubtask {
  id?: string;
  task_id: string;
  title: string;
  done?: SqlBool;
  sort_order?: number;
}

export type UpdateSubtask = Partial<Pick<Subtask, 'title' | 'sort_order'>> & {
  done?: SqlBool;
};

// ---------- task_dependencies（DAG 边：task_id 依赖 depends_on_task_id） ----------
export interface TaskDependency {
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
}

// ---------- models ----------
export interface Model {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  api_key_env: string; // 环境变量名，不是密钥本身
  context_window: number | null;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface CreateModel {
  id?: string;
  name: string;
  provider?: string;
  base_url?: string;
  api_key_env?: string;
  context_window?: number | null;
  enabled?: SqlBool;
}

export type UpdateModel = Partial<
  Pick<Model, 'name' | 'provider' | 'base_url' | 'api_key_env' | 'context_window'>
> & {
  enabled?: SqlBool;
};

// ---------- gateways ----------
export interface Gateway {
  id: string;
  name: string;
  type: string;
  base_url: string;
  api_key_env: string;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface CreateGateway {
  id?: string;
  name: string;
  type?: string;
  base_url?: string;
  api_key_env?: string;
  enabled?: SqlBool;
}

export type UpdateGateway = Partial<Pick<Gateway, 'name' | 'type' | 'base_url' | 'api_key_env'>> & {
  enabled?: SqlBool;
};

// ---------- quotas ----------
export type QuotaMetric = 'requests' | 'tokens';
export type QuotaWindow = 'hour' | 'day' | 'month';

export interface Quota {
  id: string;
  gateway_id: string | null;
  model_id: string | null;
  metric: QuotaMetric;
  limit_value: number;
  window_type: QuotaWindow;
  created_at: string;
  updated_at: string;
}

export interface CreateQuota {
  id?: string;
  gateway_id?: string | null;
  model_id?: string | null;
  metric: QuotaMetric;
  limit_value: number;
  window_type: QuotaWindow;
}

export type UpdateQuota = Partial<
  Pick<Quota, 'gateway_id' | 'model_id' | 'metric' | 'limit_value' | 'window_type'>
>;

// ---------- agents ----------
export interface Agent {
  id: string;
  name: string;
  role: string;
  system_prompt: string;
  model_id: string | null;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface CreateAgent {
  id?: string;
  name: string;
  role?: string;
  system_prompt?: string;
  model_id?: string | null;
  enabled?: SqlBool;
}

export type UpdateAgent = Partial<Pick<Agent, 'name' | 'role' | 'system_prompt' | 'model_id'>> & {
  enabled?: SqlBool;
};

// ---------- runs ----------
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  project_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateRun {
  id?: string;
  project_id?: string | null;
  task_id?: string | null;
  agent_id?: string | null;
  status?: RunStatus;
}

export type UpdateRun = Partial<Pick<Run, 'status' | 'error'>>;

// ---------- run_events ----------
export type RunEventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RunEvent {
  seq: number;
  run_id: string;
  level: RunEventLevel;
  type: string;
  payload: string; // JSON 文本
  created_at: string;
}

// ---------- audit_log ----------
export interface AuditLogEntry {
  seq: number;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  detail: string; // JSON 文本
  created_at: string;
}

export interface CreateAuditLogEntry {
  actor?: string;
  action: string;
  entity_type?: string;
  entity_id?: string;
  detail?: unknown;
}

// ---------- settings ----------
export interface Setting {
  key: string;
  value: string;
  updated_at: string;
}
