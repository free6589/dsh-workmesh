/**
 * 项目服务
 * ========
 * 职责：项目 CRUD、六态生命周期状态机（Planning/Active/Paused/Maintenance/
 * Completed/Archived，含暂停/归档等具名操作与合法转换校验）、项目与 GitHub
 * 仓库的多对多关联（项目≠仓库：同一仓库可挂到多个项目，仓库本身是外部
 * GitHub 实体、不在库内建模），以及项目统计（模块数、任务数、进行中、阻塞数、
 * 当前阶段、整体进度）。
 *
 * 存储：projects/project_repos/modules/phases/tasks/subtasks/task_dependencies
 * 等表归 data_layer，经 createRepositories 与 db/sql 读写；projects.status 的
 * CHECK 只允许 ('active','archived')，六态明细存于本任务自有的 project_lifecycle
 * 表（见 services/context.ts），projects.status 同步为粗粒度投影。
 *
 * 错误约定：沿用 data_layer 的两类业务错误（由入口 onError 统一映射为
 * HTTP 404/400）：实体不存在 → NotFoundError；输入非法、唯一冲突、非法状态
 * 转换、环依赖 → ValidationError。
 */
import { NotFoundError, ValidationError } from '../db/errors.js';
import { all, get, run } from '../db/sql.js';
import type { Repositories } from '../db/repositories/index.js';
import { withTransaction, type SqlDb } from '../db/sqlite.js';
import type { Project, ProjectRepoRow } from '../types/entities.js';

export const PROJECT_STATUSES = ['Planning', 'Active', 'Paused', 'Maintenance', 'Completed', 'Archived'] as const;
export type ProjectLifecycleStatus = (typeof PROJECT_STATUSES)[number];

/** 六态生命周期的合法转换表；未列出的转换一律拒绝。 */
const TRANSITIONS: Record<ProjectLifecycleStatus, readonly ProjectLifecycleStatus[]> = {
  Planning: ['Active', 'Archived'],
  Active: ['Paused', 'Maintenance', 'Completed', 'Archived'],
  Paused: ['Active', 'Archived'],
  Maintenance: ['Active', 'Completed', 'Archived'],
  Completed: ['Archived'],
  Archived: [],
};

export function canProjectTransition(from: ProjectLifecycleStatus, to: ProjectLifecycleStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 具名操作（激活/暂停/恢复/维护/完成/归档）→ 目标状态。 */
export const PROJECT_ACTIONS = {
  activate: 'Active',
  pause: 'Paused',
  resume: 'Active',
  maintain: 'Maintenance',
  complete: 'Completed',
  archive: 'Archived',
} as const satisfies Record<string, ProjectLifecycleStatus>;
export type ProjectAction = keyof typeof PROJECT_ACTIONS;

const REPO_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface ProjectsServiceDeps {
  db: SqlDb;
  repos: Repositories;
}

export interface ProjectView {
  id: string;
  name: string;
  description: string;
  /** 六态生命周期状态（状态机的当前状态） */
  status: ProjectLifecycleStatus;
  /** projects.status 的粗粒度投影（'active' | 'archived'） */
  storage_status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface ProjectStats {
  project_id: string;
  modules: number;
  total_tasks: number;
  completed_tasks: number;
  in_progress_tasks: number;
  blocked_tasks: number;
  current_phase: { id: string; name: string; module_id: string } | null;
  /** 已完成任务占比，两位小数；无任务时为 0 */
  progress: number;
}

type ProjectJoinRow = Project & { lifecycle_status: ProjectLifecycleStatus | null };

const now = () => new Date().toISOString();

function assertLifecycleStatus(value: unknown): ProjectLifecycleStatus {
  if (typeof value !== 'string' || !(PROJECT_STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(`status must be one of: ${PROJECT_STATUSES.join(', ')}`);
  }
  return value as ProjectLifecycleStatus;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  return value;
}

function normalizeEnabled(value: unknown, field: string): 0 | 1 | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new ValidationError(`${field} must be a boolean or 0/1`);
}

/** 与 data_layer 的 flat repo 同一纪律：未知字段直接报错，避免拼写错误静默生效。 */
function assertKnownFields(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new ValidationError(`unknown field '${key}'`);
  }
}

/** 兜底：lifecycle 行缺失（例如由数据层直接创建的项目）时按粗粒度投影推断。 */
function effectiveLifecycle(row: ProjectJoinRow): ProjectLifecycleStatus {
  return row.lifecycle_status ?? (row.status === 'archived' ? 'Archived' : 'Planning');
}

function toView(row: ProjectJoinRow): ProjectView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: effectiveLifecycle(row),
    storage_status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class ProjectsService {
  private readonly db: SqlDb;
  private readonly repos: Repositories;

  constructor(deps: ProjectsServiceDeps) {
    this.db = deps.db;
    this.repos = deps.repos;
  }

  // ---------- 查询 ----------

  private joinById(id: string): ProjectJoinRow | undefined {
    return get<ProjectJoinRow>(
      this.db,
      `SELECT p.*, l.status AS lifecycle_status
       FROM projects p LEFT JOIN project_lifecycle l ON l.project_id = p.id
       WHERE p.id = ?`,
      [id],
    );
  }

  private requireJoin(id: string): ProjectJoinRow {
    const row = this.joinById(id);
    if (!row) throw new NotFoundError('projects', id);
    return row;
  }

  private requireProjectRow(id: string): Project {
    return this.repos.projects.getByIdOrThrow(id);
  }

  getProject(id: string): ProjectView {
    return toView(this.requireJoin(id));
  }

  listProjects(filter?: { status?: unknown }): ProjectView[] {
    const params: string[] = [];
    let where = '';
    if (filter?.status !== undefined) {
      where = ' WHERE l.status = ?';
      params.push(assertLifecycleStatus(filter.status));
    }
    const rows = all<ProjectJoinRow>(
      this.db,
      `SELECT p.*, l.status AS lifecycle_status
       FROM projects p LEFT JOIN project_lifecycle l ON l.project_id = p.id${where}
       ORDER BY p.created_at, p.id`,
      params,
    );
    return rows.map(toView);
  }

  // ---------- CRUD ----------

  createProject(input: Record<string, unknown>): ProjectView {
    assertKnownFields(input, ['name', 'description']);
    const name = nonEmptyString(input.name, 'name');
    const description = optionalString(input.description, 'description') ?? '';
    if (this.repos.projects.getByName(name) !== undefined) {
      throw new ValidationError(`project name '${name}' already exists`);
    }
    return withTransaction(this.db, () => {
      const project = this.repos.projects.create({ name, description });
      run(this.db, 'INSERT INTO project_lifecycle (project_id, status) VALUES (?, ?)', [project.id, 'Planning']);
      return this.getProject(project.id);
    });
  }

  updateProject(id: string, patch: Record<string, unknown>): ProjectView {
    this.requireJoin(id);
    assertKnownFields(patch, ['name', 'description', 'status']);
    if (patch.status !== undefined) {
      throw new ValidationError(
        'project status is owned by the lifecycle state machine; use POST /projects/:id/actions/:action',
      );
    }
    const update: { name?: string; description?: string } = {};
    if (patch.name !== undefined) {
      const name = nonEmptyString(patch.name, 'name');
      const clash = this.repos.projects.getByName(name);
      if (clash !== undefined && clash.id !== id) {
        throw new ValidationError(`project name '${name}' already exists`);
      }
      update.name = name;
    }
    const description = optionalString(patch.description, 'description');
    if (description !== undefined) update.description = description;
    const updated = this.repos.projects.update(id, update);
    if (!updated) throw new NotFoundError('projects', id);
    return this.getProject(id);
  }

  deleteProject(id: string): void {
    this.requireJoin(id);
    // 级联清理：repos、modules→phases→tasks→subtasks→依赖边、lifecycle 行
    this.repos.projects.delete(id);
  }

  // ---------- 生命周期状态机 ----------

  transitionProject(id: string, action: unknown): ProjectView {
    const row = this.requireJoin(id);
    if (typeof action !== 'string' || !Object.hasOwn(PROJECT_ACTIONS, action)) {
      throw new ValidationError(
        `unknown project action '${String(action)}'; expected one of: ${Object.keys(PROJECT_ACTIONS).join(', ')}`,
      );
    }
    const target = PROJECT_ACTIONS[action as ProjectAction];
    const from = effectiveLifecycle(row);
    if (!canProjectTransition(from, target)) {
      throw new ValidationError(`illegal project status transition ${from} -> ${target} (action '${action}')`);
    }
    const storage = target === 'Archived' ? 'archived' : 'active';
    withTransaction(this.db, () => {
      run(this.db, 'UPDATE project_lifecycle SET status = ?, updated_at = ? WHERE project_id = ?', [
        target,
        now(),
        id,
      ]);
      run(this.db, 'UPDATE projects SET status = ?, updated_at = ? WHERE id = ?', [storage, now(), id]);
    });
    return this.getProject(id);
  }

  // ---------- GitHub 仓库关联（项目≠仓库，多对多） ----------

  listProjectRepos(projectId: string): ProjectRepoRow[] {
    this.requireProjectRow(projectId);
    return this.repos.projectRepos.list({ project_id: projectId });
  }

  addProjectRepo(projectId: string, input: Record<string, unknown>): ProjectRepoRow {
    this.requireProjectRow(projectId);
    assertKnownFields(input, ['repo', 'default_branch', 'enabled']);
    const repoFullName = nonEmptyString(input.repo, 'repo');
    if (!REPO_NAME_PATTERN.test(repoFullName)) {
      throw new ValidationError(`repo '${repoFullName}' is not a valid GitHub repository (expected 'owner/name')`);
    }
    if (this.repos.projectRepos.findByProjectAndRepo(projectId, repoFullName) !== undefined) {
      throw new ValidationError(`repo '${repoFullName}' is already linked to project '${projectId}'`);
    }
    const defaultBranch = optionalString(input.default_branch, 'default_branch');
    const enabled = normalizeEnabled(input.enabled, 'enabled');
    return this.repos.projectRepos.create({
      project_id: projectId,
      repo_full_name: repoFullName,
      ...(defaultBranch !== undefined ? { default_branch: defaultBranch } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
  }

  removeProjectRepo(projectId: string, repoLinkId: string): void {
    this.requireProjectRow(projectId);
    const link = this.repos.projectRepos.getById(repoLinkId);
    if (!link || link.project_id !== projectId) throw new NotFoundError('project_repos', repoLinkId);
    this.repos.projectRepos.delete(repoLinkId);
  }

  // ---------- 统计 ----------

  getProjectStats(projectId: string): ProjectStats {
    this.requireProjectRow(projectId);
    const modules = this.repos.modules.count({ project_id: projectId });
    const totalTasks = this.repos.tasks.count({ project_id: projectId });
    const completedTasks = this.repos.tasks.count({ project_id: projectId, status: 'done' });
    const inProgressTasks = this.repos.tasks.count({ project_id: projectId, status: 'in_progress' });
    // 阻塞 = 未进入终态（done/cancelled）且存在至少一条未满足的依赖（被依赖任务未 done）
    const blockedTasks =
      get<{ n: number }>(
        this.db,
        `SELECT COUNT(*) AS n
         FROM tasks t
         WHERE t.project_id = ?
           AND t.status NOT IN ('done', 'cancelled')
           AND EXISTS (
             SELECT 1 FROM task_dependencies d
             JOIN tasks dep ON dep.id = d.depends_on_task_id
             WHERE d.task_id = t.id AND dep.status <> 'done'
           )`,
        [projectId],
      )?.n ?? 0;
    const currentPhase =
      get<{ id: string; name: string; module_id: string }>(
        this.db,
        `SELECT p.id, p.name, p.module_id
         FROM phases p JOIN modules m ON m.id = p.module_id
         WHERE m.project_id = ? AND p.status = 'in_progress'
         ORDER BY p.sort_order, p.created_at, p.id
         LIMIT 1`,
        [projectId],
      ) ?? null;
    const progress = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100) / 100;
    return {
      project_id: projectId,
      modules,
      total_tasks: totalTasks,
      completed_tasks: completedTasks,
      in_progress_tasks: inProgressTasks,
      blocked_tasks: Number(blockedTasks),
      current_phase: currentPhase,
      progress,
    };
  }
}
