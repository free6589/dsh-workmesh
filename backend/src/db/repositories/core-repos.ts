import type { SqlDb } from '../sqlite.js';
import { withTransaction } from '../sqlite.js';
import { all, get, isUniqueConstraintError, run, type SqlValue } from '../sql.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { createFlatRepo, type FlatRepo, type ListOptions } from './flat-repo.js';
import type {
  CreateModule,
  CreatePhase,
  CreateProject,
  CreateProjectRepo,
  CreateSubtask,
  CreateTask,
  Module,
  Phase,
  Project,
  ProjectRepoRow,
  Subtask,
  Task,
  TaskDependency,
  UpdateModule,
  UpdatePhase,
  UpdateProject,
  UpdateProjectRepo,
  UpdateSubtask,
  UpdateTask,
} from '../../types/entities.js';

// ---------- projects ----------
export interface ProjectFilter extends Partial<Pick<Project, 'status'>>, ListOptions {}

export type ProjectsRepo = FlatRepo<Project, CreateProject, UpdateProject, ProjectFilter> & {
  getByName(name: string): Project | undefined;
};

export function newProjectsRepo(db: SqlDb): ProjectsRepo {
  const flat = createFlatRepo<Project, CreateProject, UpdateProject, ProjectFilter>(db, {
    table: 'projects',
    required: ['name'],
    createColumns: ['id', 'name', 'description', 'status'],
    updateColumns: ['name', 'description', 'status'],
    filterColumns: ['status'],
    conflictMessage: 'project name already exists',
  });
  return {
    ...flat,
    getByName(name: string): Project | undefined {
      return get<Project>(db, 'SELECT * FROM projects WHERE name = ?', [name]);
    },
  };
}

// ---------- project_repos ----------
export interface ProjectRepoFilter extends Partial<Pick<ProjectRepoRow, 'project_id' | 'enabled'>>, ListOptions {}

export type ProjectReposRepo = FlatRepo<ProjectRepoRow, CreateProjectRepo, UpdateProjectRepo, ProjectRepoFilter> & {
  findByProjectAndRepo(projectId: string, repoFullName: string): ProjectRepoRow | undefined;
};

export function newProjectReposRepo(db: SqlDb): ProjectReposRepo {
  const flat = createFlatRepo<ProjectRepoRow, CreateProjectRepo, UpdateProjectRepo, ProjectRepoFilter>(db, {
    table: 'project_repos',
    required: ['project_id', 'repo_full_name'],
    createColumns: ['id', 'project_id', 'repo_full_name', 'default_branch', 'enabled'],
    updateColumns: ['repo_full_name', 'default_branch', 'enabled'],
    filterColumns: ['project_id', 'enabled'],
    conflictMessage: 'this repo is already linked to the project',
    missingReferenceMessage: 'project does not exist',
  });
  return {
    ...flat,
    findByProjectAndRepo(projectId: string, repoFullName: string): ProjectRepoRow | undefined {
      return get<ProjectRepoRow>(
        db,
        'SELECT * FROM project_repos WHERE project_id = ? AND repo_full_name = ?',
        [projectId, repoFullName],
      );
    },
  };
}

// ---------- modules ----------
export interface ModuleFilter extends Partial<Pick<Module, 'project_id' | 'status'>>, ListOptions {}

export type ModulesRepo = FlatRepo<Module, CreateModule, UpdateModule, ModuleFilter>;

export function newModulesRepo(db: SqlDb): ModulesRepo {
  return createFlatRepo<Module, CreateModule, UpdateModule, ModuleFilter>(db, {
    table: 'modules',
    required: ['project_id', 'name'],
    createColumns: ['id', 'project_id', 'name', 'description', 'status', 'sort_order'],
    updateColumns: ['name', 'description', 'status', 'sort_order'],
    filterColumns: ['project_id', 'status'],
    conflictMessage: 'module name already exists in this project',
    missingReferenceMessage: 'project does not exist',
  });
}

// ---------- phases ----------
export interface PhaseFilter extends Partial<Pick<Phase, 'module_id' | 'status'>>, ListOptions {}

export type PhasesRepo = FlatRepo<Phase, CreatePhase, UpdatePhase, PhaseFilter>;

export function newPhasesRepo(db: SqlDb): PhasesRepo {
  return createFlatRepo<Phase, CreatePhase, UpdatePhase, PhaseFilter>(db, {
    table: 'phases',
    required: ['module_id', 'name'],
    createColumns: ['id', 'module_id', 'name', 'objective', 'status', 'sort_order'],
    updateColumns: ['name', 'objective', 'status', 'sort_order'],
    filterColumns: ['module_id', 'status'],
    conflictMessage: 'phase name already exists in this module',
    missingReferenceMessage: 'module does not exist',
  });
}

// ---------- tasks ----------
export interface TaskFilter
  extends Partial<Pick<Task, 'project_id' | 'module_id' | 'phase_id' | 'status'>>,
  ListOptions {}

export type TasksRepo = FlatRepo<Task, CreateTask, UpdateTask, TaskFilter>;

export function newTasksRepo(db: SqlDb): TasksRepo {
  return createFlatRepo<Task, CreateTask, UpdateTask, TaskFilter>(db, {
    table: 'tasks',
    required: ['project_id', 'module_id', 'phase_id', 'title'],
    createColumns: ['id', 'project_id', 'module_id', 'phase_id', 'title', 'description', 'status', 'priority'],
    updateColumns: ['title', 'description', 'status', 'priority'],
    filterColumns: ['project_id', 'module_id', 'phase_id', 'status'],
    missingReferenceMessage: 'referenced project/module/phase does not exist',
  });
}

// ---------- subtasks ----------
export interface SubtaskFilter extends Partial<Pick<Subtask, 'task_id' | 'done'>>, ListOptions {}

export type SubtasksRepo = FlatRepo<Subtask, CreateSubtask, UpdateSubtask, SubtaskFilter>;

export function newSubtasksRepo(db: SqlDb): SubtasksRepo {
  return createFlatRepo<Subtask, CreateSubtask, UpdateSubtask, SubtaskFilter>(db, {
    table: 'subtasks',
    required: ['task_id', 'title'],
    createColumns: ['id', 'task_id', 'title', 'done', 'sort_order'],
    updateColumns: ['title', 'done', 'sort_order'],
    filterColumns: ['task_id', 'done'],
    missingReferenceMessage: 'task does not exist',
  });
}

// ---------- task_dependencies（DAG） ----------
export type TaskDependenciesRepo = {
  /** 增加一条依赖边：taskId 依赖 dependsOnTaskId。自带环检测与存在性校验。 */
  add(taskId: string, dependsOnTaskId: string): TaskDependency;
  remove(taskId: string, dependsOnTaskId: string): boolean;
  /** taskId 直接依赖的全部边。 */
  listByTask(taskId: string): TaskDependency[];
  /** 依赖 taskId 的全部边（即它的下游）。 */
  listDependents(taskId: string): TaskDependency[];
  listAll(): TaskDependency[];
  /** Kahn 拓扑排序：被依赖者排在前。taskIds 缺省时覆盖全部有边任务。 */
  topologicalOrder(taskIds?: string[]): string[];
};

export function newTaskDependenciesRepo(db: SqlDb): TaskDependenciesRepo {
  function assertTaskExists(id: string): void {
    if (!get<Task>(db, 'SELECT id FROM tasks WHERE id = ?', [id])) throw new NotFoundError('tasks', id);
  }

  /** 沿 task -> depends_on 方向从 start 可达的全部任务。 */
  function reachableFrom(start: string): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [start];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const row of all<{ depends_on_task_id: string }>(
        db,
        'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?',
        [current],
      )) {
        if (!seen.has(row.depends_on_task_id)) {
          seen.add(row.depends_on_task_id);
          queue.push(row.depends_on_task_id);
        }
      }
    }
    return seen;
  }

  return {
    add(taskId: string, dependsOnTaskId: string): TaskDependency {
      if (taskId === dependsOnTaskId) throw new ValidationError('a task cannot depend on itself');
      assertTaskExists(taskId);
      assertTaskExists(dependsOnTaskId);
      return withTransaction(db, () => {
        if (reachableFrom(dependsOnTaskId).has(taskId)) {
          throw new ValidationError(`circular dependency: '${taskId}' would depend on itself transitively`);
        }
        try {
          run(db, 'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)', [
            taskId,
            dependsOnTaskId,
          ]);
        } catch (error) {
          if (isUniqueConstraintError(error)) throw new ValidationError('dependency already exists');
          throw error as Error;
        }
        const edge = get<TaskDependency>(
          db,
          'SELECT task_id, depends_on_task_id, created_at FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?',
          [taskId, dependsOnTaskId],
        );
        if (!edge) throw new Error('task_dependencies insert did not persist');
        return edge;
      });
    },

    remove(taskId: string, dependsOnTaskId: string): boolean {
      const changes = run(
        db,
        'DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?',
        [taskId, dependsOnTaskId],
      ).changes;
      return Number(changes) > 0;
    },

    listByTask(taskId: string): TaskDependency[] {
      return all<TaskDependency>(
        db,
        'SELECT task_id, depends_on_task_id, created_at FROM task_dependencies WHERE task_id = ? ORDER BY created_at',
        [taskId],
      );
    },

    listDependents(taskId: string): TaskDependency[] {
      return all<TaskDependency>(
        db,
        'SELECT task_id, depends_on_task_id, created_at FROM task_dependencies WHERE depends_on_task_id = ? ORDER BY created_at',
        [taskId],
      );
    },

    listAll(): TaskDependency[] {
      return all<TaskDependency>(
        db,
        'SELECT task_id, depends_on_task_id, created_at FROM task_dependencies ORDER BY created_at, task_id',
      );
    },

    topologicalOrder(taskIds?: string[]): string[] {
      const edges = all<{ task_id: string; depends_on_task_id: string }>(
        db,
        'SELECT task_id, depends_on_task_id FROM task_dependencies',
      );
      const nodes = new Set<string>(taskIds ?? []);
      if (taskIds === undefined) {
        for (const edge of edges) {
          nodes.add(edge.task_id);
          nodes.add(edge.depends_on_task_id);
        }
      }
      const indegree = new Map<string, number>();
      const dependents = new Map<string, string[]>();
      for (const node of nodes) {
        indegree.set(node, 0);
        dependents.set(node, []);
      }
      for (const edge of edges) {
        if (!nodes.has(edge.task_id) || !nodes.has(edge.depends_on_task_id)) continue;
        indegree.set(edge.task_id, (indegree.get(edge.task_id) ?? 0) + 1);
        dependents.get(edge.depends_on_task_id)!.push(edge.task_id);
      }
      const queue = [...nodes].filter((node) => (indegree.get(node) ?? 0) === 0).sort();
      const order: string[] = [];
      while (queue.length > 0) {
        const node = queue.shift()!;
        order.push(node);
        for (const next of dependents.get(node) ?? []) {
          const left = (indegree.get(next) ?? 0) - 1;
          indegree.set(next, left);
          if (left === 0) queue.push(next);
        }
      }
      if (order.length !== nodes.size) {
        throw new ValidationError('dependency graph contains a cycle');
      }
      return order;
    },
  };
}

// re-export，保持单个入口即可取到所有仓库类型
export type { SqlValue };
