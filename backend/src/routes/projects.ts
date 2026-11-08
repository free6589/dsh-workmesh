/**
 * 项目 REST API（自动挂载为 /projects）
 * =====================================
 * - GET    /projects                 列表（?status= 六态过滤）
 * - POST   /projects                 创建（初始 Planning）
 * - GET    /projects/:id             详情
 * - PATCH  /projects/:id             改名/描述（status 由状态机专用接口控制）
 * - DELETE /projects/:id             删除（级联仓库关联/模块/阶段/任务/子任务/依赖）
 * - POST   /projects/:id/actions/:action   activate|pause|resume|maintain|complete|archive
 * - GET    /projects/:id/repos       仓库关联列表（项目≠仓库，多对多）
 * - POST   /projects/:id/repos       关联仓库 { repo: 'owner/name', default_branch?, enabled? }
 * - DELETE /projects/:id/repos/:repoId   移除关联
 * - GET    /projects/:id/stats       统计：模块数/任务数/进行中/阻塞数/当前阶段/进度
 *
 * 错误映射由入口 onError 统一处理：NotFoundError→404，ValidationError→400。
 */
import { Hono } from 'hono';
import { getServices } from '../services/context.js';

/** 兼容任意 Hono 上下文泛型的最小结构化入参类型。 */
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

const router = new Hono();

router.get('/', (c) => {
  const status = c.req.query('status');
  const projects = getServices().projects.listProjects(status === undefined ? undefined : { status });
  return c.json({ projects });
});

router.post('/', async (c) => {
  const project = getServices().projects.createProject(await readJsonObject(c));
  return c.json({ project }, 201);
});

router.get('/:id', (c) => {
  return c.json({ project: getServices().projects.getProject(c.req.param('id')) });
});

router.patch('/:id', async (c) => {
  const project = getServices().projects.updateProject(c.req.param('id'), await readJsonObject(c));
  return c.json({ project });
});

router.delete('/:id', (c) => {
  getServices().projects.deleteProject(c.req.param('id'));
  return c.body(null, 204);
});

router.post('/:id/actions/:action', (c) => {
  const project = getServices().projects.transitionProject(c.req.param('id'), c.req.param('action'));
  return c.json({ project });
});

router.get('/:id/repos', (c) => {
  return c.json({ repos: getServices().projects.listProjectRepos(c.req.param('id')) });
});

router.post('/:id/repos', async (c) => {
  const repoLink = getServices().projects.addProjectRepo(c.req.param('id'), await readJsonObject(c));
  return c.json({ repo_link: repoLink }, 201);
});

router.delete('/:id/repos/:repoId', (c) => {
  getServices().projects.removeProjectRepo(c.req.param('id'), c.req.param('repoId'));
  return c.body(null, 204);
});

router.get('/:id/stats', (c) => {
  return c.json(getServices().projects.getProjectStats(c.req.param('id')));
});

export default router;
