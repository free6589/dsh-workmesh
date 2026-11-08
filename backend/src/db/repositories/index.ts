import type { SqlDb } from '../sqlite.js';
import {
  newModulesRepo,
  newPhasesRepo,
  newProjectsRepo,
  newProjectReposRepo,
  newSubtasksRepo,
  newTaskDependenciesRepo,
  newTasksRepo,
} from './core-repos.js';
import { newAgentsRepo, newGatewaysRepo, newModelsRepo, newQuotasRepo } from './platform-repos.js';
import { newAuditLogRepo, newRunEventsRepo, newRunsRepo, newSettingsRepo } from './runtime-repos.js';

export * from './flat-repo.js';
export * from './core-repos.js';
export * from './platform-repos.js';
export * from './runtime-repos.js';

/** 全部类型化数据访问仓库，按实体聚合在一个对象上。 */
export function createRepositories(db: SqlDb) {
  return {
    projects: newProjectsRepo(db),
    projectRepos: newProjectReposRepo(db),
    modules: newModulesRepo(db),
    phases: newPhasesRepo(db),
    tasks: newTasksRepo(db),
    subtasks: newSubtasksRepo(db),
    taskDependencies: newTaskDependenciesRepo(db),
    models: newModelsRepo(db),
    gateways: newGatewaysRepo(db),
    quotas: newQuotasRepo(db),
    agents: newAgentsRepo(db),
    runs: newRunsRepo(db),
    runEvents: newRunEventsRepo(db),
    auditLog: newAuditLogRepo(db),
    settings: newSettingsRepo(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
