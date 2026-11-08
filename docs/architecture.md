# Workmesh 架构文档

版本 v0.1（2026-11-08）· 产出任务：`workspace_survey` · 勘察与决策基于对本机文件系统的实际检查，全部证据见 §1.6。配套实施计划见 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)。

## 0. 规格完整性声明

任务输入的目标描述在「页面 B：项目详情与横」处截断。实际勘察（§1.1–§1.3）未在工作区及相邻仓库发现任何 Workmesh 规格文档、原型或实现。对缺失部分的处理方式：

- 已完整传达的部分（核心理念、三平面架构要求、勘察要求）作为本文档范围依据；
- 「页面 B」按最小可解释语义「**项目详情与横览（概览）**」落地：项目详情页 + 项目级统计横览条（任务总数 / 执行中 / 完成率 / 最近执行），UI 模块（M13）为其余可能的子页预留扩展位；
- 后续若取得完整规格，以规格为准：更新本文档并在 §7 版本记录中注明差异，已交付模块按增量调整，不做整体重写。

## 1. 工作区勘察结论

### 1.1 工作区状态：空仓库

`/home/fish/projects_mine/dsh-workmesh` 除 `.git/` 外无任何文件；`git status` 显示 `main` 分支 **0 提交**、无 stash、无未跟踪文件。结论：**工作区为空，无已有技术栈，无 Workmesh HTML 原型或实现**。

全 `/home/fish/projects_mine` 范围检索（maxdepth 4 文件名 `*workmesh*`、根级 `*.md` 内容关键词 `workmesh`、`页面 B` 关键词在 PROJECT_MEMORY.md / root-plan/ / dsh-grok-workflow/docs / deepseek-harness/docs 中检索）均无命中——不存在可依据的完整规格文档。

**勘察后并发变化（如实登记）**：本文档撰写期间（2026-11-08 04:02–04:03 本地时间），同一工作区内由并行任务创建了 `backend/` 目录——`backend/package.json`（`dsh-workmesh-backend` 0.1.0，依赖 `hono ^4.7` + `@hono/node-server`，devDeps tsx / typescript 5.8 / vitest 3.2，engines node≥22.5；scripts 引用的 `src/server.ts` 与 `src/db/migrate-cli.ts` 尚未创建）与 `backend/src/db/` 五文件（`sqlite.ts` 基于 `node:sqlite` `DatabaseSync`，默认 PRAGMA 为 WAL + 外键 + busy_timeout；另有 migrate.ts、migrations.ts、sql.ts、errors.ts），TS strict + NodeNext。其选型与本文档 §2 决策一致，视为 M1/M2 骨架的落地起点；本机勘测开始时（03:55）该目录不存在。

### 1.2 多 Git 仓库职责划分

工作区所在 `~/projects_mine` 下有大量并行仓库，与本任务直接相关的五仓职责如下（各仓独立 Git 仓库，互不嵌套）：

| 仓库（本地路径） | 职责 | 与 Workmesh 的边界 |
|---|---|---|
| `dsh-workmesh`（本仓库） | 控制平面：全局调度中心，项目/任务/Agent/模型的管理面板与调度器 | 本文档的唯一开发目标；不修改其他仓库 |
| `Agent2API` | 资源平面：AI 路由网关（Rust）。统一模型 API、账号路由、网关密钥、请求报表 | 只经 HTTP API 集成；不复制其代码，避免 AGPL-3.0 传染 |
| `bifrost-mirror` | Bifrost 旧机（45.76.178.222）的镜像备份留档（shim 代码、Caddy 配置、token-usage 归档） | 只读参考，不参与部署；非 Bifrost 服务本体 |
| `dsh-grok-workflow` | 执行平面：DSH 外部插件源码（TypeScript），提供 `grok_workflow` 工具与 pre-step 闸门 | 集成其任务包/报告契约；不改其源码 |
| `deepseek-harness` | DSH 源码 monorepo（pnpm workspace：apps/{cli,web,desktop}，packages/{workflow,jobs,schedule,…}） | 只读参考；Workmesh 通过已安装的 `@deepseek-ai/dsh` 发行包对接 |

相邻但无直接耦合的仓库（勘察中确认存在，列为背景，不纳入集成面）：`any2api`、`free-llm-api`、`Agent2WebProviders`、`zcode2api`、`ChatGPT-Web2API`、`mcp-gateway`、`th-gateway`、`dsh-memory`、`qqbot`、`dsh` 等。

### 1.3 Agent2API 实际发现

- 本地路径 `/home/fish/projects_mine/Agent2API`，`package.json` v3.3.0-beta.6，Node ≥18.17（桌面壳与脚本），核心网关为 **Rust crate `agent2api-server`**（位于 `desktop-tauri/src-tauri/server/`，edition 2021，MSRV 1.88，rusqlite 0.40 bundled SQLite、rustls、Tokio；证据：`Cargo.toml` 与 `Dockerfile` 头部注释）。
- 能力面（README）：OpenAI Chat / Responses / Images 与 Anthropic Messages 统一接口、统一模型目录、账号优先级/负载均衡/会话亲和/故障转移、网关密钥（scoped）、请求报表（365 天热图）、插件式提供商扩展、三种部署形态（Tauri 桌面 / headless 服务器 / Docker）。
- **本机正在运行**：`ss -tlnp` 显示 `0.0.0.0:3065` 监听，与 README 默认面板/网关端口 3065 一致。
- 结论：可复用其统一模型 API 与网关密钥体系，集成方式为 HTTP（`http://127.0.0.1:3065/v1` 一类端点），不做代码级依赖。

### 1.4 Bifrost 实际发现

- **Bifrost 是外部网关服务，不在本机仓库内**。DSH profile（`/home/fish/.dsh/profiles/web/cordis.patch.yml`）中配置了两个 provider：`bifrost-responses` 与 `bifrost-completions`，`baseURL: https://models.fyrali.com/openai/v1`（L15–18、L44–47）；另有 MCP 聚合连接 `mcp-bifrost` 指向 `https://models.fyrali.com/mcp`（L692–697）；生图渠道配置同样引用 bifrost（L1914–1915）。
- `bifrost-mirror/` 是 2026-10-04 对旧 Bifrost 机的完整留档：server-shim（协议修补层，8101）、mcp-shim（MCP 聚合，8102）、study-shim（8103）、pricing-api（8790）、Caddy 配置与服务定义。**这是备份，不是可部署的 Bifrost 本体**（其 README 自述）。
- `~/.dsh/bifrost.env` 存在（含凭据，本轮勘察未读取内容）。
- 结论：资源平面把 Bifrost 当作远程 OpenAI 兼容端点 + MCP 聚合根集成；适配器必须缓存模型目录快照，容忍远端不可用。

### 1.5 DSH 与 Grok Workflow 实际发现

- DSH 发行包：`/home/fish/.local/share/mise/installs/node/26.8.1/lib/node_modules/@deepseek-ai/dsh/`，`@deepseek-ai/dsh` **0.2.1-rc.2**（TypeScript ESM，cordis 插件体系）；`dsh` CLI 位于 `~/.local/bin/dsh`（`dsh --version` → 0.2.1-rc.2）；Web GUI 运行于 `http://100.111.111.88:3090`（runtime context）。
- DSH 原生工作流基础设施已随发行包就位：`node_modules/@deepseek-ai/dsh-workflow`、`dsh-workflow-ptc`（PTC 沙箱脚本 + 子代理扇出）、`dsh-jobs`、`dsh-schedule`、`dsh-goal`、`dsh-headless`、`dsh-tool-workflow` 等。
- Grok Workflow 插件源码：`/home/fish/projects_mine/dsh-grok-workflow`，v0.6.0，TypeScript ESM + vitest + oxlint；其 `docs/ARCHITECTURE.md` 明确设计：`grok_workflow` 工具把 objective 转为**规划 → 并行执行 → 独立验证 → 有界重试 → 综合汇报**的多子代理工作流，产出带 `status: completed/partial/failed` 与 evidence 的结构化报告。
- 挂载状态说明（如实）：`~/.dsh/profiles/web/cordis.patch.yml` 与 `~/.dsh/plugins/`（仅 `dsh-infinite-gen-5`、`dsh-our-free-model`）中未发现 grok-workflow 的 bundle 痕迹，但其 `grok_workflow` 工具在本会话可用（本任务即经该工具派发）；挂载机制不影响架构结论——执行平面既可走插件工具，也可走 DSH 原生 workflow/headless。

### 1.6 勘察命令与证据索引

| 结论 | 证据（命令 / 路径） |
|---|---|
| 工作区为空 | `ls -la /home/fish/projects_mine/dsh-workmesh`；`git -C … status`（no commits yet）；`find … -maxdepth 3` 仅 `.git` |
| 无 workmesh 相关遗留 | `find /home/fish/projects_mine -maxdepth 4 -iname '*workmesh*'`（仅本目录）；`grep -l -i workmesh /home/fish/projects_mine/*.md`（无命中）；`grep -rn '页面 B' …`（无命中） |
| Agent2API 技术栈 | `Agent2API/package.json`；`Agent2API/Dockerfile`（L6–10 server crate / rusqlite bundled）；`Agent2API/desktop-tauri/src-tauri/server/Cargo.toml`；`ss -tlnp`（:3065） |
| Bifrost 配置 | `/home/fish/.dsh/profiles/web/cordis.patch.yml` L15–18、L44–47、L692–697、L1914–1915；`bifrost-mirror/README.md` |
| DSH 版本与组件 | `@deepseek-ai/dsh/package.json`；`ls …/node_modules/@deepseek-ai`；`dsh --version` |
| Grok Workflow 设计 | `dsh-grok-workflow/package.json`；`dsh-grok-workflow/docs/ARCHITECTURE.md`；`src/` 文件清单 |
| 环境与资源 | `node --version`→v26.8.1；`pnpm --version`→12.4.2；`sqlite3 --version`→3.54.0；`nproc`→6；`free -h`（31GiB 总量）；`df -h /home`（**100%，余 146M**）；`node -e "import('node:sqlite')…"`（DatabaseSync 实测可用） |

### 1.7 环境与资源约束

- 开发机：6 vCPU / 31GiB 内存 / Arch（omarchy）。**`/home` 分盘已 100% 占满（余 146M）**——P0 前必须先清理磁盘，且依赖选型必须克制（见 §2 不选清单）。
- 部署目标 VPS 资源有限（任务硬约束）：**禁止微服务、Redis、消息队列、大型数据库集群**。架构由此收敛为：单 Node 进程（API + 静态托管 + 调度器同进程）+ SQLite（WAL）+ 文件日志。

## 2. 技术栈决策

**决策原则：已有栈优先沿用；工作区为空时启用默认：TypeScript + 轻量 Web 框架 + SQLite + 现代前端。**

勘察结论是工作区为空（§1.1），故启用默认，并按本机既有生态与资源约束做具体选型：

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js 26.8.1（ESM） | 本机已有（mise），DSH 生态同栈，团队/Agent 熟悉 |
| 语言 | TypeScript（strict）+ tsx（dev）/ tsc（build） | 同 `dsh-grok-workflow` 的开发链；类型即契约 |
| Web 框架 | **Hono**（Node http adapter） | 轻量（无装饰性依赖）、TS-first、内建 SSE/静态托管；单进程足够 |
| 数据库 | **SQLite，经 `node:sqlite`（`DatabaseSync`）** | 本机 Node 26 实测可用（§1.6）；零原生编译依赖、零守护进程；Agent2API 同样以 SQLite 为存储，模式经过验证；DAO 层隔离，必要时可平替 better-sqlite3 |
| 前端 | React 19 + Vite + Tailwind CSS 4 + shadcn/ui 风格组件 + TanStack Query | 「现代前端组件」默认项；生态成熟、代码生成质量高、产物为纯静态文件由 Hono 直接托管 |
| 契约 | zod（packages/shared 内定义请求/响应/任务包/报告 schema） | 前后端共用一套校验；任务包契约与 Grok Workflow 的 JSON schema 风格对齐 |
| 测试/质量 | vitest + oxlint + `tsc --noEmit` | 与 `dsh-grok-workflow` 工具链一致，不引入第二套 |
| 包管理 | pnpm workspace（monorepo：apps/server、apps/web、packages/shared） | 本机 pnpm 12.4.2；deepseek-harness 同为 pnpm workspace，模式有先例 |
| 部署 | systemd 单服务 + SQLite 定时备份（`VACUUM INTO`/`.backup`）+ 日志轮转 | 满足 VPS 低资源约束；不引入容器编排 |

**明确不选**（并说明被排除的替代项）：微服务拆分、Redis/消息队列（任务约束禁用；用 SQLite 队列表 + 进程内轮询替代）、Next/Nuxt 类 SSR 框架（面板无需 SEO，静态 SPA 更省资源）、Drizzle/Prisma 等重型 ORM（表数量 ≤10，薄 DAO 足够）、独立网关进程（Hono 同进程承载）。

## 3. 核心理念与三平面架构

核心理念：**项目是管理中心，任务是执行单元，Agent 是执行者，模型是共享资源，Workmesh 是全局调度中心。**

### 3.1 三平面到具体组件的映射

| 平面 | 定义 | 已确认的外部系统（§1.3–1.5） | Workmesh 本仓库内的承载组件 |
|---|---|---|---|
| 控制平面 | 全局调度与管理：项目、任务、Agent 注册表、模型目录、派发与报表 | ——（Workmesh 自身即控制平面） | `apps/server`（Hono API + 调度器）、`apps/web`（管理面板）、`apps/server/src/db`（SQLite）、`apps/server/src/domain/*`（五个域模块）、`apps/server/src/scheduler` |
| 资源平面 | 模型与工具类共享资源的供给 | Agent2API（`127.0.0.1:3065`，统一模型 API + 网关密钥）；Bifrost（`https://models.fyrali.com/openai/v1` OpenAI 兼容 + `/mcp` 聚合）；独立 API（图像渠道 agnes/sensenova 等、any2api/free-llm-api 类服务，逐个注册） | `apps/server/src/adapters/`（`agent2api.ts`、`bifrost.ts`、`independent.ts`，统一 `ResourceAdapter` 接口：`health()` / `listModels()` / `capabilities()`） |
| 执行平面 | 单个任务的实际执行与自验 | DSH 0.2.1-rc.2（CLI `dsh`、Web GUI :3090、原生 workflow/jobs/schedule/headless）；Grok Workflow 插件（plan–execute–verify–retry–synthesize） | `apps/server/src/executors/`（`pack.ts` 任务包生成、`dsh-headless.ts` 进程派发、`report.ts` 报告解析入库） |

运行时拓扑：

```text
                    ┌────────────────────── 控制平面（本仓库） ──────────────────────┐
   浏览器 ──────────▶  apps/web (React SPA) ──▶ apps/server (Hono + scheduler + SQLite) │
                    └───────────────┬──────────────────────────────┬────────────────┘
                        资源平面调用（HTTP）              │        执行平面派发（子进程 / 任务包）
                    ┌───────────────────▼──────────┐    ┌───────────▼──────────────────┐
                    │ Agent2API  127.0.0.1:3065    │    │ DSH CLI/GUI（dsh 0.2.1-rc.2） │
                    │ Bifrost    models.fyrali.com │    │  ├ 原生 workflow/jobs/schedule│
                    │ 独立API    （注册表逐个接入）  │    │  └ grok_workflow（插件）       │
                    └──────────────────────────────┘    └──────────────────────────────┘
```

### 3.2 各网关与执行引擎的职责边界

| 组件 | 负责 | 明确不负责 |
|---|---|---|
| Workmesh（控制平面） | 项目/任务生命周期、Agent 注册、模型目录快照、派发决策、执行记录与报表、凭据**引用**管理 | 不转发模型推理流量；不保管上游密钥明文；不实现执行引擎 |
| Agent2API（资源网关） | 统一模型 API、账号路由/负载均衡/故障转移、网关密钥签发、请求报表 | 不理解任务语义；不管理项目/任务 |
| Bifrost（资源网关） | OpenAI 兼容模型端点、MCP 聚合、模型目录 | 同上 |
| 独立 API（逐个注册） | 各自的专域能力（如图像生成渠道） | 同上；未经注册与健康检查的端点不进入派发候选 |
| DSH（执行引擎宿主） | Agent 会话、工具沙箱、子代理、会话投影 | 不做多项目/多任务的调度与优先级 |
| Grok Workflow（执行策略插件） | 单目标任务的 plan–execute–verify–retry–synthesize、结构化报告 | 不维护跨任务状态；报告只回传一次 |

边界裁决规则：凡「把哪个任务、派给哪个 Agent、用哪个模型资源」的判断都在控制平面完成；执行平面只接收不可再分的任务包并回报结果。

### 3.3 模块边界与接口约定

- HTTP API 统一前缀 `/api/v1`，JSON；错误信封 `{"error":{"code","message","detail?"}}`；分页 `?cursor=&limit=`；变更类接口要求本地管理员 token（单用户面板，不做多租户）。
- 资源平面统一接口（`packages/shared` 定义）：`ResourceAdapter { id, kind, baseUrl, health(): HealthReport, listModels(): ModelEntry[], capabilities(): Capabilities }`；`listModels` 结果缓存入 `models` 表（快照 + `last_synced_at`），远端不可用时读快照并降级标记。
- 执行平面契约：任务包 `{ objective, acceptanceCriteria[], constraints[], writesPaths[], context }`（与 `grok_workflow` 输入字段对齐，见 `dsh-grok-workflow/docs/ARCHITECTURE.md`）；回报为结构化报告 `{ status: completed|partial|failed, summary, evidence[], testsRun[] }`，`report.ts` 负责把报告落库并驱动状态机。
- 凭据：Workmesh 只存**引用**（资源 id + 别名 + 存放位置说明），上游密钥留在 Agent2API/Bifrost/本地 env；日志与报告入库前做凭据脱敏（对齐 grok-workflow 的 redact 纪律）。
- 事件与队列：无 MQ；`queue` 表 + 调度器进程内轮询（默认 2s），任务时间线走 `task_events` 表；前端用 TanStack Query 轮询拉取，后续可选 SSE（Hono 原生支持）。
- 模块间调用只允许「域 → DAO」「路由 → 域」「调度器 → 域 + 执行器」，禁止路由直查 SQL、禁止适配器之间互相调用。

## 4. 数据模型概要

| 表 | 关键字段 | 说明 |
|---|---|---|
| `projects` | id, name, status, repo_path, spec_ref, created_at, updated_at | 管理中心主体；repo_path 指向本地仓库 |
| `tasks` | id, project_id→, title, objective, acceptance_criteria(JSON), constraints(JSON), writes_paths(JSON), status, priority, assignee_agent_id→ | 执行单元；写入面由 writes_paths 声明，用于并行开发防冲突 |
| `task_events` | id, task_id→, ts, kind, payload(JSON) | 时间线（queued/dispatched/log/report/…） |
| `agents` | id, name, kind('human'\|'dsh-session'\|'dsh-headless'\|'grok-workflow'), endpoint_ref, capabilities(JSON), status | 执行者注册表 |
| `resources` | id, kind('agent2api'\|'bifrost'\|'independent'), base_url, enabled, health_state, health_checked_at, meta(JSON) | 资源平面注册表 |
| `models` | id, resource_id→, model_id, display_name, capabilities(JSON), last_synced_at | 模型目录快照（共享资源） |
| `credential_refs` | id, resource_id→, alias, location, note | 只存引用，不存密钥材料 |
| `executions` | id, task_id→, agent_id→, engine_ref, status, started_at, finished_at, report(JSON), artifacts(JSON) | 执行记录，报告原文留存 |
| `queue` | task_id, priority, enqueued_at, attempts, max_attempts, state | 调度队列（SQLite 替代 MQ） |
| `settings` | key, value(JSON) | 面板级配置 |
| `audit_log` | id, ts, actor, action, target, detail | 变更审计 |

任务状态机：`draft → queued → dispatched → running → verifying → done | partial | failed`，任意态可 `canceled`；`partial/failed` 可回 `queued` 重派（attempts 上限保护）。索引要点：`tasks(project_id,status)`、`queue(state,priority)`、`task_events(task_id,ts)`；启用 WAL 与 `foreign_keys=ON`。

## 5. 文件责任人划分表（唯一责任模块）

归属规则：目录级归属递归生效（未单列的文件随所在目录）；每个文件/目录有且只有一个责任模块，跨模块改动必须在提交说明中注明接口变更并同步 `packages/shared`；`packages/shared` 是唯一允许被所有模块依赖的包。

路径映射：因 `backend/` 已作为服务端根目录落地（§1.1 并发登记），表中全部 `apps/server/*` 路径实际落位为 `backend/*`（例：`apps/server/src/db/` → `backend/src/db/`，`apps/server/src/domain/projects/` → `backend/src/domain/projects/`，`apps/server/test/**` → `backend/tests/**`，与 backend 脚手架的 tsconfig include 一致）；`apps/web`、`packages/shared` 的目录名由 M0/M12 任务在统一 workspace 约定时确定（沿用单包式可平行落 `web/`、`shared/`）。模块编号、职责边界与唯一责任规则不变。

| 路径 | 责任模块 | 模块名 |
|---|---|---|
| `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`.gitignore`、`.editorconfig`、`.npmrc` | M0 | 工程脚手架 |
| `docs/`（含本文件） | M15 | 文档 |
| `deploy/`（workmesh.service、backup.sh、.env.example） | M16 | 部署与运维 |
| `packages/shared/src/types.ts`、`schemas.ts`、`api.ts` | M11 | 共享契约包 |
| `apps/server/package.json`、`tsconfig.json` | M1 | 服务端壳 |
| `apps/server/src/index.ts`、`app.ts`、`config.ts`、`auth.ts`、`static.ts` | M1 | 服务端壳 |
| `apps/server/src/db/`（schema.sql、db.ts、migrate.ts、dao/*.ts） | M2 | 数据层 |
| `apps/server/src/domain/projects/` | M3 | 项目域 |
| `apps/server/src/domain/tasks/`（含状态机 state.ts） | M4 | 任务域 |
| `apps/server/src/domain/agents/` | M5 | Agent 注册域 |
| `apps/server/src/domain/resources/` | M6 | 资源与模型域 |
| `apps/server/src/domain/executions/` | M7 | 执行记录域 |
| `apps/server/src/api/routes/projects.ts` | M3 | 项目域 |
| `apps/server/src/api/routes/tasks.ts` | M4 | 任务域 |
| `apps/server/src/api/routes/agents.ts` | M5 | Agent 注册域 |
| `apps/server/src/api/routes/resources.ts`、`models.ts` | M6 | 资源与模型域 |
| `apps/server/src/api/routes/executions.ts` | M7 | 执行记录域 |
| `apps/server/src/api/routes/settings.ts` | M1 | 服务端壳 |
| `apps/server/src/adapters/`（types.ts、agent2api.ts、bifrost.ts、independent.ts） | M8 | 资源平面适配器 |
| `apps/server/src/executors/`（types.ts、pack.ts、dsh-headless.ts、report.ts） | M9 | 执行平面适配器 |
| `apps/server/src/scheduler/`（queue.ts、dispatch.ts、ticker.ts） | M10 | 调度器 |
| `apps/server/test/**`（与被测模块同名的 spec） | 各被测模块 | 测试随模块归属 |
| `apps/web/package.json`、`vite.config.ts`、`index.html`、`src/main.tsx`、`src/router.tsx`、`src/layout/`、`src/api/client.ts` | M12 | 前端壳 |
| `apps/web/src/features/projects/`、`features/tasks/` | M13 | 项目与任务页面 |
| `apps/web/src/features/resources/`、`features/executions/`、`features/settings/` | M14 | 资源/执行/设置页面 |
| `apps/web/src/components/ui/` | M12 | 前端壳（基础组件） |

## 6. 与相邻系统的集成事实速查

- Agent2API：`http://127.0.0.1:3065`（本机已监听）；密钥在其面板内管理，Workmesh 侧只登记引用。
- Bifrost：`https://models.fyrali.com/openai/v1`（provider `bifrost-responses` / `bifrost-completions`）+ `https://models.fyrali.com/mcp`；远端服务，健康检查必须带超时与快照降级。
- DSH：`~/.local/bin/dsh`（0.2.1-rc.2）；headless 任务用独立 profile（`dsh --profile <name> --from-default-profile headless` 模式创建），Workmesh 以子进程方式派发并回收结构化输出。
- Grok Workflow：任务包字段与其输入契约对齐；插件挂载机制未在 profile 配置中确认（§1.5），P4 先落 `dsh-headless` 直派路径，插件集成作为增强项。

## 7. 版本记录

- v0.1（2026-11-08）：初版。基于空工作区勘察；「页面 B」截断部分按 §0 处理。
