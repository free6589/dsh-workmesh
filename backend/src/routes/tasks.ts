/**
 * 任务编排 REST API（自动挂载为 /tasks）
 * =====================================
 * 层级：项目 → 模块 → 阶段 → 任务 → 子任务；依赖 DAG 建立在任务之间。
 *
 * - POST/GET  /tasks/projects/:projectId/modules        项目下模块创建/列表
 * - GET/PATCH/DELETE /tasks/modules/:id                 模块详情/更新/删除
 * - POST/GET  /tasks/modules/:id/phases                 模块下阶段创建/列表
 * - GET/PATCH/DELETE /tasks/phases/:id                 阶段详情/更新/删除
 * - POST/GET  /tasks/phases/:id/tasks                   阶段下任务创建/列表
 * - GET/PATCH/DELETE /tasks/:id                        任务详情（含子任务与依赖）/更新/删除
 * - GET       /tasks?project_id=&module_id=&phase_id=&status=&limit=&offset=
 * - POST/GET  /tasks/:id/subtasks                       子任务创建/列表
 * - PATCH/DELETE /tasks/subtasks/:id                    子任务更新/删除
 * - POST/GET  /tasks/:id/dependencies                   建立依赖 { depends_on } / 依赖列表
 * - DELETE    /tasks/:id/dependencies/:dependsOnTaskId  移除依赖
 * - GET       /tasks/projects/:projectId/topology       Kahn 拓扑排序（被依赖者在前）
 * - GET       /tasks/projects/:projectId/ready          就绪任务（全部依赖已 done）
 *
 * 环依赖在数据层仓库内检测并在事务中回滚，拒绝时无残留；
 * 错误映射由入口 onError 统一处理（404/400）。
 */
import { Hono } from 'hono';
import { ValidationError } from '../db/errors.js';
import { getServices } from '../services/context.js';
import type { TaskListFilter } from '../services/tasks.js';

type JsonRequest = { req: { json(): Promise<unknown> } };

async function readJsonObject(c: JsonRequest): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function parseOptionalInt(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`);
  }
  return parsed;
}

const router = new Hono();

// ---------- 模块 ----------

router.post('/projects/:projectId/modules', async (c) => {
  const module = getServices().tasks.createModule(c.req.param('projectId'), await readJsonObject(c));
  return c.json({ module }, 201);
});

router.get('/projects/:projectId/modules', (c) => {
  return c.json({ modules: getServices().tasks.listModules(c.req.param('projectId')) });
});

router.get('/modules/:id', (c) => {
  return c.json({ module: getServices().tasks.getModule(c.req.param('id')) });
});

router.patch('/modules/:id', async (c) => {
  const module = getServices().tasks.updateModule(c.req.param('id'), await readJsonObject(c));
  return c.json({ module });
});

router.delete('/modules/:id', (c) => {
  getServices().tasks.deleteModule(c.req.param('id'));
  return c.body(null, 204);
});

// ---------- 阶段 ----------

router.post('/modules/:id/phases', async (c) => {
  const phase = getServices().tasks.createPhase(c.req.param('id'), await readJsonObject(c));
  return c.json({ phase }, 201);
});

router.get('/modules/:id/phases', (c) => {
  return c.json({ phases: getServices().tasks.listPhases(c.req.param('id')) });
});

router.get('/phases/:id', (c) => {
  return c.json({ phase: getServices().tasks.getPhase(c.req.param('id')) });
});

router.patch('/phases/:id', async (c) => {
  const phase = getServices().tasks.updatePhase(c.req.param('id'), await readJsonObject(c));
  return c.json({ phase });
});

router.delete('/phases/:id', (c) => {
  getServices().tasks.deletePhase(c.req.param('id'));
  return c.body(null, 204);
});

// ---------- 任务 ----------

router.post('/phases/:id/tasks', async (c) => {
  const task = getServices().tasks.createTask(c.req.param('id'), await readJsonObject(c));
  return c.json({ task }, 201);
});

router.get('/phases/:id/tasks', (c) => {
  return c.json({ tasks: getServices().tasks.listTasksByPhase(c.req.param('id')) });
});

router.get('/', (c) => {
  const filter: TaskListFilter = {};
  const projectId = c.req.query('project_id');
  if (projectId !== undefined) filter.project_id = projectId;
  const moduleId = c.req.query('module_id');
  if (moduleId !== undefined) filter.module_id = moduleId;
  const phaseId = c.req.query('phase_id');
  if (phaseId !== undefined) filter.phase_id = phaseId;
  const status = c.req.query('status');
  if (status !== undefined) filter.status = status;
  const limit = parseOptionalInt(c.req.query('limit'), 'limit');
  if (limit !== undefined) filter.limit = limit;
  const offset = parseOptionalInt(c.req.query('offset'), 'offset');
  if (offset !== undefined) filter.offset = offset;
  return c.json({ tasks: getServices().tasks.listTasks(filter) });
});

router.get('/:id', (c) => {
  return c.json({ task: getServices().tasks.getTaskDetail(c.req.param('id')) });
});

router.patch('/:id', async (c) => {
  const task = getServices().tasks.updateTask(c.req.param('id'), await readJsonObject(c));
  return c.json({ task });
});

router.delete('/:id', (c) => {
  getServices().tasks.deleteTask(c.req.param('id'));
  return c.body(null, 204);
});

// ---------- 子任务 ----------

router.post('/:id/subtasks', async (c) => {
  const subtask = getServices().tasks.createSubtask(c.req.param('id'), await readJsonObject(c));
  return c.json({ subtask }, 201);
});

router.get('/:id/subtasks', (c) => {
  return c.json({ subtasks: getServices().tasks.listSubtasks(c.req.param('id')) });
});

router.patch('/subtasks/:id', async (c) => {
  const subtask = getServices().tasks.updateSubtask(c.req.param('id'), await readJsonObject(c));
  return c.json({ subtask });
});

router.delete('/subtasks/:id', (c) => {
  getServices().tasks.deleteSubtask(c.req.param('id'));
  return c.body(null, 204);
});

// ---------- 任务依赖 DAG ----------

router.post('/:id/dependencies', async (c) => {
  const body = await readJsonObject(c);
  const dependency = getServices().tasks.addDependency(c.req.param('id'), body);
  return c.json({ dependency }, 201);
});

router.get('/:id/dependencies', (c) => {
  return c.json({ dependencies: getServices().tasks.listDependencies(c.req.param('id')) });
});

router.delete('/:id/dependencies/:dependsOnTaskId', (c) => {
  getServices().tasks.removeDependency(c.req.param('id'), c.req.param('dependsOnTaskId'));
  return c.body(null, 204);
});

// ---------- 项目级 DAG 查询 ----------

router.get('/projects/:projectId/topology', (c) => {
  return c.json(getServices().tasks.getProjectTopology(c.req.param('projectId')));
});

router.get('/projects/:projectId/ready', (c) => {
  return c.json(getServices().tasks.listReadyTasks(c.req.param('projectId')));
});

export default router;
