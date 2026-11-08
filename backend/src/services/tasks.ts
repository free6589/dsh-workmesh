/**
 * 任务树服务
 * =========
 * 职责：模块/阶段/任务/子任务的 CRUD 与层级关系（项目→模块→阶段→任务→子任务，
 * 全部级联删除），以及任务依赖 DAG（建立依赖、环检测并拒绝、拓扑排序、就绪
 * 任务查询）。
 *
 * 枚举沿用 data_layer 的定义：任务 todo/in_progress/blocked/done/cancelled、
 * 阶段 pending/in_progress/completed/blocked、模块 active/completed/archived。
 * 依赖边存在 data_layer 的 task_dependencies 表，环检测与事务回滚由其仓库完成。
 * 项目六态生命周期状态机见 services/projects.ts。
 *
 * 错误约定同 data_layer：NotFoundError → 404，ValidationError → 400。
 */
import { NotFoundError, ValidationError } from '../db/errors.js';
import { all, run } from '../db/sql.js';
import type { Repositories } from '../db/repositories/index.js';
import { withTransaction, type SqlDb } from '../db/sqlite.js';
import type {
  Module,
  ModuleStatus,
  Phase,
  PhaseStatus,
  Subtask,
  Task,
  TaskDependency,
  TaskStatus,
} from '../types/entities.js';

export const MODULE_STATUSES = ['active', 'completed', 'archived'] as const;
export const PHASE_STATUSES = ['pending', 'in_progress', 'completed', 'blocked'] as const;
export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;

export interface TasksServiceDeps {
  db: SqlDb;
  repos: Repositories;
}

export interface DependencyView extends TaskDependency {
  depends_on_title?: string;
  depends_on_status?: TaskStatus;
}

export interface DependentView extends TaskDependency {
  dependent_title?: string;
  dependent_status?: TaskStatus;
}

export type TaskDetail = Task & {
  subtasks: Subtask[];
  dependencies: DependencyView[];
  dependents: DependentView[];
};

export interface TaskListFilter {
  project_id?: string;
  module_id?: string;
  phase_id?: string;
  status?: unknown;
  limit?: number;
  offset?: number;
}

const now = () => new Date().toISOString();

function assertEnum<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T[number];
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

function assertInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be an integer`);
  }
  return value;
}

function assertNonNegativeInt(value: unknown, field: string): number {
  const parsed = assertInt(value, field);
  if (parsed < 0) throw new ValidationError(`${field} must be >= 0`);
  return parsed;
}

function normalizeSqlBool(value: unknown, field: string): 0 | 1 | undefined {
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

export class TasksService {
  private readonly db: SqlDb;
  private readonly repos: Repositories;

  constructor(deps: TasksServiceDeps) {
    this.db = deps.db;
    this.repos = deps.repos;
  }

  // ---------- 模块 ----------

  createModule(projectId: string, input: Record<string, unknown>): Module {
    this.repos.projects.getByIdOrThrow(projectId);
    assertKnownFields(input, ['name', 'description', 'status', 'sort_order']);
    const name = nonEmptyString(input.name, 'name');
    if (this.repos.modules.list({ project_id: projectId }).some((m) => m.name === name)) {
      throw new ValidationError(`module name '${name}' already exists in this project`);
    }
    const description = optionalString(input.description, 'description');
    const status = input.status === undefined ? undefined : assertEnum(input.status, MODULE_STATUSES, 'status');
    const sortOrder = input.sort_order === undefined ? undefined : assertNonNegativeInt(input.sort_order, 'sort_order');
    return this.repos.modules.create({
      project_id: projectId,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(sortOrder !== undefined ? { sort_order: sortOrder } : {}),
    });
  }

  listModules(projectId: string): Module[] {
    this.repos.projects.getByIdOrThrow(projectId);
    return this.repos.modules.list({ project_id: projectId });
  }

  getModule(id: string): Module {
    return this.repos.modules.getByIdOrThrow(id);
  }

  updateModule(id: string, patch: Record<string, unknown>): Module {
    const existing = this.repos.modules.getByIdOrThrow(id);
    assertKnownFields(patch, ['name', 'description', 'status', 'sort_order']);
    const update: { name?: string; description?: string; status?: ModuleStatus; sort_order?: number } = {};
    if (patch.name !== undefined) {
      const name = nonEmptyString(patch.name, 'name');
      const clash = this.repos.modules
        .list({ project_id: existing.project_id })
        .some((m) => m.name === name && m.id !== id);
      if (clash) throw new ValidationError(`module name '${name}' already exists in this project`);
      update.name = name;
    }
    const description = optionalString(patch.description, 'description');
    if (description !== undefined) update.description = description;
    if (patch.status !== undefined) update.status = assertEnum(patch.status, MODULE_STATUSES, 'status');
    if (patch.sort_order !== undefined) update.sort_order = assertNonNegativeInt(patch.sort_order, 'sort_order');
    const updated = this.repos.modules.update(id, update);
    if (!updated) throw new NotFoundError('modules', id);
    return updated;
  }

  deleteModule(id: string): void {
    this.repos.modules.getByIdOrThrow(id);
    // 级联：phases→tasks→subtasks，任务依赖边随任务删除
    this.repos.modules.delete(id);
  }

  // ---------- 阶段 ----------

  createPhase(moduleId: string, input: Record<string, unknown>): Phase {
    this.repos.modules.getByIdOrThrow(moduleId);
    assertKnownFields(input, ['name', 'objective', 'status', 'sort_order']);
    const name = nonEmptyString(input.name, 'name');
    if (this.repos.phases.list({ module_id: moduleId }).some((p) => p.name === name)) {
      throw new ValidationError(`phase name '${name}' already exists in this module`);
    }
    const objective = optionalString(input.objective, 'objective');
    const status = input.status === undefined ? undefined : assertEnum(input.status, PHASE_STATUSES, 'status');
    const sortOrder = input.sort_order === undefined ? undefined : assertNonNegativeInt(input.sort_order, 'sort_order');
    return this.repos.phases.create({
      module_id: moduleId,
      name,
      ...(objective !== undefined ? { objective } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(sortOrder !== undefined ? { sort_order: sortOrder } : {}),
    });
  }

  listPhases(moduleId: string): Phase[] {
    this.repos.modules.getByIdOrThrow(moduleId);
    return this.repos.phases.list({ module_id: moduleId });
  }

  getPhase(id: string): Phase {
    return this.repos.phases.getByIdOrThrow(id);
  }

  updatePhase(id: string, patch: Record<string, unknown>): Phase {
    const existing = this.repos.phases.getByIdOrThrow(id);
    assertKnownFields(patch, ['name', 'objective', 'status', 'sort_order']);
    const update: { name?: string; objective?: string; status?: PhaseStatus; sort_order?: number } = {};
    if (patch.name !== undefined) {
      const name = nonEmptyString(patch.name, 'name');
      const clash = this.repos.phases
        .list({ module_id: existing.module_id })
        .some((p) => p.name === name && p.id !== id);
      if (clash) throw new ValidationError(`phase name '${name}' already exists in this module`);
      update.name = name;
    }
    const objective = optionalString(patch.objective, 'objective');
    if (objective !== undefined) update.objective = objective;
    if (patch.status !== undefined) update.status = assertEnum(patch.status, PHASE_STATUSES, 'status');
    if (patch.sort_order !== undefined) update.sort_order = assertNonNegativeInt(patch.sort_order, 'sort_order');

    if (update.status === 'in_progress') {
      // 同一项目同时只保留一个进行中的阶段：先把其余 in_progress 降级为 pending
      withTransaction(this.db, () => {
        run(
          this.db,
          `UPDATE phases SET status = 'pending', updated_at = ?
           WHERE status = 'in_progress' AND id <> ?
             AND module_id IN (
               SELECT id FROM modules
               WHERE project_id = (
                 SELECT m.project_id FROM modules m JOIN phases p ON p.module_id = m.id WHERE p.id = ?
               )
             )`,
          [now(), id, id],
        );
        const updated = this.repos.phases.update(id, update);
        if (!updated) throw new NotFoundError('phases', id);
      });
    } else {
      const updated = this.repos.phases.update(id, update);
      if (!updated) throw new NotFoundError('phases', id);
    }
    return this.getPhase(id);
  }

  deletePhase(id: string): void {
    this.repos.phases.getByIdOrThrow(id);
    this.repos.phases.delete(id);
  }

  // ---------- 任务 ----------

  createTask(phaseId: string, input: Record<string, unknown>): TaskDetail {
    const phase = this.repos.phases.getByIdOrThrow(phaseId);
    const module = this.repos.modules.getByIdOrThrow(phase.module_id);
    assertKnownFields(input, ['title', 'description', 'status', 'priority']);
    const title = nonEmptyString(input.title, 'title');
    const description = optionalString(input.description, 'description');
    const status = input.status === undefined ? undefined : assertEnum(input.status, TASK_STATUSES, 'status');
    const priority = input.priority === undefined ? undefined : assertInt(input.priority, 'priority');
    const task = this.repos.tasks.create({
      project_id: module.project_id,
      module_id: module.id,
      phase_id: phase.id,
      title,
      ...(description !== undefined ? { description } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(priority !== undefined ? { priority } : {}),
    });
    return this.getTaskDetail(task.id);
  }

  listTasksByPhase(phaseId: string): Task[] {
    this.repos.phases.getByIdOrThrow(phaseId);
    return this.repos.tasks.list({ phase_id: phaseId });
  }

  listTasks(filter: TaskListFilter): Task[] {
    const status = filter.status === undefined ? undefined : assertEnum(filter.status, TASK_STATUSES, 'status');
    return this.repos.tasks.list({
      ...(filter.project_id !== undefined ? { project_id: filter.project_id } : {}),
      ...(filter.module_id !== undefined ? { module_id: filter.module_id } : {}),
      ...(filter.phase_id !== undefined ? { phase_id: filter.phase_id } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
      ...(filter.offset !== undefined ? { offset: filter.offset } : {}),
    });
  }

  getTaskDetail(id: string): TaskDetail {
    const task = this.repos.tasks.getByIdOrThrow(id);
    return {
      ...task,
      subtasks: this.repos.subtasks.list({ task_id: id }),
      dependencies: this.repos.taskDependencies.listByTask(id).map((edge) => this.toDependencyView(edge)),
      dependents: this.repos.taskDependencies.listDependents(id).map((edge) => this.toDependentView(edge)),
    };
  }

  updateTask(id: string, patch: Record<string, unknown>): TaskDetail {
    this.repos.tasks.getByIdOrThrow(id);
    assertKnownFields(patch, ['title', 'description', 'status', 'priority']);
    const update: { title?: string; description?: string; status?: TaskStatus; priority?: number } = {};
    if (patch.title !== undefined) update.title = nonEmptyString(patch.title, 'title');
    const description = optionalString(patch.description, 'description');
    if (description !== undefined) update.description = description;
    if (patch.status !== undefined) update.status = assertEnum(patch.status, TASK_STATUSES, 'status');
    if (patch.priority !== undefined) update.priority = assertInt(patch.priority, 'priority');
    const updated = this.repos.tasks.update(id, update);
    if (!updated) throw new NotFoundError('tasks', id);
    return this.getTaskDetail(id);
  }

  deleteTask(id: string): void {
    this.repos.tasks.getByIdOrThrow(id);
    this.repos.tasks.delete(id);
  }

  // ---------- 子任务 ----------

  createSubtask(taskId: string, input: Record<string, unknown>): Subtask {
    this.repos.tasks.getByIdOrThrow(taskId);
    assertKnownFields(input, ['title', 'done', 'sort_order']);
    const title = nonEmptyString(input.title, 'title');
    const done = normalizeSqlBool(input.done, 'done');
    const sortOrder = input.sort_order === undefined ? undefined : assertNonNegativeInt(input.sort_order, 'sort_order');
    return this.repos.subtasks.create({
      task_id: taskId,
      title,
      ...(done !== undefined ? { done } : {}),
      ...(sortOrder !== undefined ? { sort_order: sortOrder } : {}),
    });
  }

  listSubtasks(taskId: string): Subtask[] {
    this.repos.tasks.getByIdOrThrow(taskId);
    return this.repos.subtasks.list({ task_id: taskId });
  }

  updateSubtask(id: string, patch: Record<string, unknown>): Subtask {
    assertKnownFields(patch, ['title', 'done', 'sort_order']);
    const update: { title?: string; done?: 0 | 1; sort_order?: number } = {};
    if (patch.title !== undefined) update.title = nonEmptyString(patch.title, 'title');
    const done = normalizeSqlBool(patch.done, 'done');
    if (done !== undefined) update.done = done;
    if (patch.sort_order !== undefined) update.sort_order = assertNonNegativeInt(patch.sort_order, 'sort_order');
    const updated = this.repos.subtasks.update(id, update);
    if (!updated) throw new NotFoundError('subtasks', id);
    return updated;
  }

  deleteSubtask(id: string): void {
    if (!this.repos.subtasks.delete(id)) throw new NotFoundError('subtasks', id);
  }

  // ---------- 任务依赖 DAG ----------

  addDependency(taskId: string, input: Record<string, unknown>): DependencyView {
    assertKnownFields(input, ['depends_on']);
    const raw = input.depends_on;
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new ValidationError('depends_on must be a task id');
    }
    const dependsOn = raw.trim();
    this.repos.tasks.getByIdOrThrow(taskId);
    this.repos.tasks.getByIdOrThrow(dependsOn);
    if (taskId === dependsOn) throw new ValidationError('a task cannot depend on itself');
    if (this.repos.taskDependencies.listByTask(taskId).some((edge) => edge.depends_on_task_id === dependsOn)) {
      throw new ValidationError(`task '${taskId}' already depends on task '${dependsOn}'`);
    }
    // 环检测与写入在 data_layer 仓库内同一事务完成：拒绝时回滚，无残留
    const edge = this.repos.taskDependencies.add(taskId, dependsOn);
    return this.toDependencyView(edge);
  }

  listDependencies(taskId: string): DependencyView[] {
    this.repos.tasks.getByIdOrThrow(taskId);
    return this.repos.taskDependencies.listByTask(taskId).map((edge) => this.toDependencyView(edge));
  }

  removeDependency(taskId: string, dependsOnTaskId: string): void {
    this.repos.tasks.getByIdOrThrow(taskId);
    if (!this.repos.taskDependencies.remove(taskId, dependsOnTaskId)) {
      throw new NotFoundError('task_dependencies', `${taskId} -> ${dependsOnTaskId}`);
    }
  }

  /** Kahn 拓扑排序（被依赖者在前），范围为项目内全部任务；跨项目依赖边不参与本项目排序。 */
  getProjectTopology(projectId: string): { project_id: string; order: string[]; tasks: Task[] } {
    this.repos.projects.getByIdOrThrow(projectId);
    const ids = all<{ id: string }>(
      this.db,
      'SELECT id FROM tasks WHERE project_id = ? ORDER BY rowid',
      [projectId],
    ).map((row) => row.id);
    const order = this.repos.taskDependencies.topologicalOrder(ids);
    const byId = new Map(this.repos.tasks.list({ project_id: projectId }).map((task) => [task.id, task]));
    return {
      project_id: projectId,
      order,
      tasks: order.map((id) => byId.get(id) as Task),
    };
  }

  /** 就绪任务：未进入终态且全部依赖均已 done。 */
  listReadyTasks(projectId: string): { project_id: string; tasks: Task[] } {
    this.repos.projects.getByIdOrThrow(projectId);
    const tasks = all<Task>(
      this.db,
      `SELECT t.*
       FROM tasks t
       WHERE t.project_id = ?
         AND t.status NOT IN ('done', 'cancelled')
         AND NOT EXISTS (
           SELECT 1 FROM task_dependencies d
           JOIN tasks dep ON dep.id = d.depends_on_task_id
           WHERE d.task_id = t.id AND dep.status <> 'done'
         )
       ORDER BY t.created_at, t.id`,
      [projectId],
    );
    return { project_id: projectId, tasks };
  }

  // ---------- 内部 ----------

  private toDependencyView(edge: TaskDependency): DependencyView {
    const target = this.repos.tasks.getById(edge.depends_on_task_id);
    return {
      ...edge,
      ...(target !== undefined ? { depends_on_title: target.title, depends_on_status: target.status } : {}),
    };
  }

  private toDependentView(edge: TaskDependency): DependentView {
    const dependent = this.repos.tasks.getById(edge.task_id);
    return {
      ...edge,
      ...(dependent !== undefined ? { dependent_title: dependent.title, dependent_status: dependent.status } : {}),
    };
  }
}
