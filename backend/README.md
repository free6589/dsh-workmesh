# dsh-workmesh backend

后端骨架：SQLite 数据层 + Hono HTTP 服务 + 路由自动加载约定。零重量级依赖——运行时依赖只有 `hono` 和 `@hono/node-server`，SQLite 使用 Node.js 内置模块 `node:sqlite`（无原生编译），不需要 Redis / 消息队列 / Postgres。

## 快速开始

```bash
npm install
npm run migrate   # 幂等迁移，可重复执行
npm run dev       # 开发模式（tsx watch），默认 http://127.0.0.1:8787
npm test          # Vitest 全量单元测试
npm run typecheck # tsc --noEmit
npm run build     # 编译到 dist/
```

首次 `npm run dev` / `npm start` 会自动执行迁移，无需先手动 migrate。

### 环境变量

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| `BACKEND_DB_PATH` | `<backend>/data/app.db` | SQLite 文件路径；`:memory:` 为内存库 |
| `BACKEND_PORT` | `8787` | 监听端口（回退 `PORT`） |
| `BACKEND_HOST` | `127.0.0.1` | 监听地址 |

## 健康检查

```
GET /health -> 200 {"status":"ok","checks":{"database":"ok"},...}   # 数据库可 ping
           -> 503 {"status":"degraded",...}                          # 数据库异常
```

## 路由自动加载约定（新增路由只需新增文件）

入口启动时扫描 `backend/src/routes/` 顶层文件并自动挂载，**任何新路由都不需要修改入口或注册代码**：

1. 新建 `backend/src/routes/<name>.ts`；
2. 文件 default export（或命名导出 `router`）一个 Hono router；
3. 重启服务后即挂载在 `/<name>`（文件名即前缀）。

```ts
// backend/src/routes/projects.ts
import { Hono } from 'hono';

const router = new Hono();
router.get('/', (c) => c.json({ items: [] }));
router.post('/', async (c) => c.json({ created: true }, 201));

export default router;
```

- `router.get('/list')` 对外为 `GET /projects/list`；
- 文件可命名导出 `basePath = '/custom'` 覆盖挂载前缀；
- 会被跳过的文件：`index.*`、`_` 或 `.` 开头（`src/routes/_loader.ts` 即加载器自身）、`*.test.ts` / `*.spec.ts`、`*.d.ts`、非 `.ts/.mts/.js/.mjs`、子目录；
- 缺少 router 导出的文件会启动报错（显式失败优于静默忽略）；挂载前缀冲突也会报错；
- `routes/ping.ts` 是可删除的示例；
- 后续任务（项目 API、网关适配器、调度器、执行集成）各自新增 `backend/src/routes/*.ts` 与 `backend/src/<module>/**` 即可，互不修改对方文件。

## 数据库 Schema 与迁移

迁移在 `src/db/migrations.ts` 中按序定义（`0001_core` → `0002_platform` → `0003_runtime`），由 `src/db/migrate.ts` 的账本机制（`schema_migrations` 表）驱动，每条迁移在事务内执行；所有语句都是 `CREATE ... IF NOT EXISTS`，因此重复执行天然幂等，账本丢失也不会破坏已有结构。

实体（15 张表 + 账本）：

| 表 | 说明 |
| --- | --- |
| `projects` | 项目 |
| `project_repos` | 项目关联的多个 GitHub 仓库（UNIQUE(project_id, repo_full_name)） |
| `modules` / `phases` / `tasks` / `subtasks` | 项目 → 模块 → 阶段 → 任务 → 子任务层级，级联删除 |
| `task_dependencies` | 任务依赖 DAG 边（复合主键 + 自环 CHECK + 数据访问层环检测） |
| `models` | 模型目录（`api_key_env` 只存环境变量名，密钥不入库） |
| `gateways` | API 网关定义 |
| `quotas` | 按 gateway/model 的配额（requests/tokens，hour/day/month） |
| `agents` | Agent 定义（可绑定 model） |
| `runs` / `run_events` | 执行记录（状态机 queued→running→终态）与事件流（自增 seq） |
| `audit_log` | 审计日志 |
| `settings` | 键值设置 |

## 类型化数据访问层

`src/db/repositories/` 按 `createRepositories(db)` 聚合全部仓库；行类型在 `src/types/entities.ts`（与列名一致的 snake_case）。统一提供 `create / getById / getByIdOrThrow / list(filter) / count / update / delete`，并附带各实体专用查询：

```ts
import { createApp } from './server.js';

const { repos } = await createApp({ db });

const project = repos.projects.create({ name: 'demo' });
repos.projectRepos.create({ project_id: project.id, repo_full_name: 'owner/repo' });
repos.tasks.update(taskId, { status: 'in_progress' });
repos.taskDependencies.add(taskB, taskA);            // 写入前做环检测
repos.taskDependencies.topologicalOrder();            // Kahn 拓扑排序
repos.runs.start(runId); repos.runs.finish(runId, { status: 'succeeded' });
repos.runEvents.listByRun(runId, { afterSeq: 10 });   // 事件流断点续读
repos.settings.set('key', 'value');                    // upsert
```

约束约定：

- 业务错误分两类：`NotFoundError`（→ HTTP 404）与 `ValidationError`（→ HTTP 400），由 `src/server.ts` 的 `onError` 统一映射；
- `list/filter` 的过滤列来自白名单，未知字段直接报错，杜绝拼写错误静默生效；
- 布尔列（`enabled`/`done`）入参接受 `true/false/0/1`，行内为 `0|1`。

## 测试

`tests/` 下四组单元测试：迁移幂等性（含跨进程重开、账本丢失场景）、全部仓库 CRUD 与查询（含 DAG 环检测、级联删除、运行状态机）、`/health` 与 404、路由自动加载（含“在 `backend/src/routes/` 新增文件后零入口改动即被挂载”的直接验证）。
