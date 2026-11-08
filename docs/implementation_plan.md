# Workmesh 实施计划

版本 v0.1（2026-11-08）· 依据 [ARCHITECTURE.md](./ARCHITECTURE.md) v0.1 的工作区勘察与技术栈决策。本文档回答「分几步做、每步产出哪些文件、怎么验收」。

## 0. 前置事实（来自勘察，不重复论证）

- 工作区 `/home/fish/projects_mine/dsh-workmesh` 为空 git 仓库（main，0 提交），无已有栈、无 Workmesh 原型/实现；技术栈启用默认：**TypeScript + 轻量 Web 框架（Hono）+ SQLite（node:sqlite）+ 现代前端（React/Vite/Tailwind/shadcn/ui 风格）**。
- 目标描述在「页面 B：项目详情与横」截断，工作区内无完整规格；「页面 B」按「项目详情与横览（概览）」最小语义实现（ARCHITECTURE.md §0）。
- 硬约束：VPS 资源有限——单进程、SQLite，禁微服务/Redis/消息队列/大型数据库集群。开发机 `/home` 已 100% 占满（余 146M），**P0 开始前必须先清理磁盘**，否则 `pnpm install` 无法完成。
- 集成对象已确认存在：Agent2API（Rust 网关，本机 :3065）、Bifrost（models.fyrali.com 远端）、DSH 0.2.1-rc.2（`~/.local/bin/dsh`）、Grok Workflow 插件源码（`~/projects_mine/dsh-grok-workflow`）。
- 并发登记（2026-11-08 04:02–04:03 本地时间）：并行任务在同一工作区创建了 `backend/` 骨架（`dsh-workmesh-backend`：Hono ^4.7 + `node:sqlite` DatabaseSync + tsx/vitest，`src/db/` 数据层五文件；scripts 引用的 `src/server.ts`、`src/db/migrate-cli.ts` 与 tests 目录尚未出现）。选型与本计划 §2/ARCHITECTURE.md §2 一致；本文中 `apps/server/*` 路径按 ARCHITECTURE.md §5 的映射规则实际落位为 `backend/*`，P1 数据层已由该任务部分交付。

## 1. 模块清单

| 模块 | 名称 | 目标 | 主要交付物 | 依赖 |
|---|---|---|---|---|
| M0 | 工程脚手架 | monorepo 可安装、可类型检查、可跑空测试 | 根配置文件 + 三个 workspace 包 | 磁盘清理 |
| M1 | 服务端壳 | Hono 应用启动、静态托管、鉴权、错误信封、健康检查 | `apps/server/src/{index,app,config,auth,static}.ts` | M0、M11 |
| M2 | 数据层 | 建表、迁移、DAO；WAL + 外键 | `apps/server/src/db/*` | M0 |
| M3 | 项目域 | 项目 CRUD 与统计（含「页面 B」横览数据） | `domain/projects/`、`routes/projects.ts` | M1、M2、M11 |
| M4 | 任务域 | 任务 CRUD、状态机、写入面声明 | `domain/tasks/`、`routes/tasks.ts` | M1–M3、M11 |
| M5 | Agent 注册域 | 执行者注册与心跳 | `domain/agents/`、`routes/agents.ts` | M1、M2 |
| M6 | 资源与模型域 | 资源注册、健康巡检、模型目录快照 | `domain/resources/`、`routes/resources.ts`、`routes/models.ts` | M1、M2、M8 |
| M7 | 执行记录域 | 执行记录与报告入库、时间线 | `domain/executions/`、`routes/executions.ts` | M1、M2、M9 |
| M8 | 资源平面适配器 | Agent2API / Bifrost / 独立API 统一接口 | `apps/server/src/adapters/*` | M11 |
| M9 | 执行平面适配器 | 任务包生成、DSH headless 派发、报告解析 | `apps/server/src/executors/*` | M11 |
| M10 | 调度器 | SQLite 队列、指派、并发/重试上限 | `apps/server/src/scheduler/*` | M4–M7、M9 |
| M11 | 共享契约包 | zod schema 与 API/任务包/报告契约 | `packages/shared/src/*` | M0 |
| M12 | 前端壳 | SPA 骨架、路由、布局、API client | `apps/web/*`（骨架部分） | M0、M11 |
| M13 | 项目与任务页面 | 项目列表/详情+横览（页面 B）、任务看板与时间线 | `apps/web/src/features/{projects,tasks}/` | M12 |
| M14 | 资源/执行/设置页面 | 资源健康与模型目录、执行记录、设置 | `apps/web/src/features/{resources,executions,settings}/` | M12 |
| M15 | 文档 | 架构与计划（本两份）及后续 ADR | `docs/` | —— |
| M16 | 部署与运维 | systemd 服务、备份、日志轮转、磁盘水位告警 | `deploy/*` | M1、M2 |

## 2. 文件责任人划分表（唯一责任模块）

每个文件/目录有且只有一个责任模块；目录级归属递归生效。跨模块改动必须在提交说明中注明接口变更并同步 `packages/shared`。此表与 ARCHITECTURE.md §5 同源，后续模块开发以本表为并行开发防冲突依据。

路径映射：`backend/` 已作为服务端根目录由并行任务落地（§0 并发登记），本表全部 `apps/server/*` 路径实际落位为 `backend/*`（例：`apps/server/src/db/` → `backend/src/db/`；`apps/server/test/**` → `backend/tests/**`）；前端与共享包目录名在 M0 统一 workspace 约定时确定。模块编号与唯一责任规则不变。

| 路径 | 责任模块 | 阶段 |
|---|---|---|
| `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`.gitignore`、`.editorconfig`、`.npmrc` | M0 | P0 |
| `packages/shared/src/types.ts`、`schemas.ts`、`api.ts` | M11 | P0/P1 |
| `apps/server/package.json`、`tsconfig.json` | M1 | P0 |
| `apps/server/src/index.ts`、`app.ts`、`config.ts`、`auth.ts`、`static.ts` | M1 | P0/P1 |
| `apps/server/src/db/`（schema.sql、db.ts、migrate.ts、dao/*.ts） | M2 | P1 |
| `apps/server/src/domain/projects/`、`apps/server/src/api/routes/projects.ts` | M3 | P2 |
| `apps/server/src/domain/tasks/`、`apps/server/src/api/routes/tasks.ts` | M4 | P2 |
| `apps/server/src/domain/agents/`、`apps/server/src/api/routes/agents.ts` | M5 | P2 |
| `apps/server/src/domain/resources/`、`routes/resources.ts`、`routes/models.ts` | M6 | P3 |
| `apps/server/src/domain/executions/`、`routes/executions.ts` | M7 | P4 |
| `apps/server/src/adapters/`（types.ts、agent2api.ts、bifrost.ts、independent.ts） | M8 | P3 |
| `apps/server/src/executors/`（types.ts、pack.ts、dsh-headless.ts、report.ts） | M9 | P4 |
| `apps/server/src/scheduler/`（queue.ts、dispatch.ts、ticker.ts） | M10 | P5 |
| `apps/server/test/**`（与被测模块同名 spec） | 各被测模块 | 随阶段 |
| `apps/web/package.json`、`vite.config.ts`、`index.html`、`src/main.tsx`、`src/router.tsx`、`src/layout/`、`src/api/client.ts`、`src/components/ui/` | M12 | P0/P2 |
| `apps/web/src/features/projects/`、`features/tasks/` | M13 | P2 |
| `apps/web/src/features/resources/`、`features/executions/`、`features/settings/` | M14 | P3/P4 |
| `docs/` | M15 | P0 起 |
| `deploy/workmesh.service`、`backup.sh`、`.env.example` | M16 | P6 |

## 3. 分阶段实施清单与验收要点

### P0 工程脚手架（M0、M1 骨架、M11 骨架、M12 骨架、M15）

前置：清理 `/home` 磁盘（至少留出 5GiB）；确认 Node 26.8.1 / pnpm 12.4.2。

产出：根配置、`apps/server`（Hono hello + `/api/v1/health` + 静态托管位）、`apps/web`（Vite + React 骨架，dev 代理到 server）、`packages/shared`（空契约 + version 导出）、两份 docs。

验收要点：

- [ ] `pnpm install && pnpm -r typecheck` 通过；
- [ ] `pnpm --filter server dev` 后 `curl -fsS http://127.0.0.1:8088/api/v1/health` 返回 `{"ok":true}`（端口 8088，避开本机已占用的 3065/3090）；
- [ ] `pnpm --filter web build` 产出 `apps/web/dist`，由 server 托管后浏览器可打开空白面板；
- [ ] `git init` 后首次提交包含全部脚手架与 docs。

### P1 数据层（M2、M11 完整契约）

产出：`db/schema.sql`（§4 的 11 张表）、`db/migrate.ts`（顺序迁移 + `user_version` 记录）、`db/db.ts`（node:sqlite 打开、WAL、外键）、`db/dao/*.ts`；`packages/shared` 补齐任务包/报告/资源适配 schema。

验收要点：

- [ ] `pnpm --filter server test -- db` 全绿：CRUD、迁移可从零重放两次结果一致；
- [ ] `sqlite3 data/workmesh.db 'PRAGMA integrity_check; PRAGMA journal_mode;'` → `ok` / `wal`；
- [ ] 任务包 schema 与 `grok_workflow` 输入字段对齐（objective / acceptanceCriteria / constraints / writesPaths / context），以 `packages/shared/src/schemas.ts` 中的 zod 定义与单测为准。

### P2 控制平面核心（M3、M4、M5、M13）

产出：项目/任务/Agent 三个域 + 路由 + 前端页面（项目列表、项目详情与横览、任务看板与时间线）。

验收要点：

- [ ] API 层面：`POST /api/v1/projects` → 创建；`POST /api/v1/tasks` 带 acceptanceCriteria/constraints/writesPaths；状态机非法流转返回 409；
- [ ] UI 层面：项目详情页展示横览条（任务总数/执行中/完成率/最近执行），任务看板按状态分组可手动流转；
- [ ] 鉴权：无 token 的写操作返回 401；错误信封格式统一；
- [ ] vitest 覆盖状态机全部合法/非法迁移路径。

### P3 资源平面（M6、M8、M14 部分）

产出：`ResourceAdapter` 接口 + 三个适配器 + 资源注册路由 + 健康巡检定时任务 + 模型目录快照落库；前端资源页。

验收要点：

- [ ] Agent2API 适配器对本机 `127.0.0.1:3065` 探活成功（以实测为准，不可用则记录 health_state=down，不抛未捕获异常）；
- [ ] Bifrost 适配器拉取 `https://models.fyrali.com/openai/v1/models`（带超时 5s），断网时读 `models` 表快照并标记 stale；
- [ ] 独立 API 以注册表方式接入（kind=independent），至少注册 1 个示例通道走通 health+listModels；
- [ ] 凭据仅存引用：`credential_refs` 表中无任何密钥材料（检查项：对库内容 grep 常见密钥前缀应为空）。

### P4 执行平面（M7、M9、M14 部分）

产出：任务包生成、`dsh-headless.ts`（为任务创建/复用 headless profile，子进程派发 `dsh`，超时与退出码处理）、`report.ts`（结构化报告解析 + 脱敏 + 入库）；执行记录页。

验收要点：

- [ ] 端到端冒烟：创建一条带 `writesPaths` 指向临时目录的任务 → 派发 → 回收报告 status ∈ {completed, partial, failed} 且 evidence 非空（或失败原因明确）；
- [ ] 报告入库前经脱敏（对齐 grok-workflow redact 纪律），`executions.report` 中无密钥样字符串；
- [ ] DSH 未安装/不可用时降级为「手动执行」模式：任务转 human agent，面板可粘贴报告回填——不阻塞主流程；
- [ ] `dsh --version` 0.2.1-rc.2 兼容性在派发前预检（executors/types.ts 中的 engine 探针）。

### P5 调度中心（M10）

产出：queue 表消费循环（2s 轮询）、指派策略（按 agent capabilities + writesPaths 冲突检查，同一时刻一个写入面只派给一个执行者）、attempts 上限与退避。

验收要点：

- [ ] 并发写冲突防护：两条 writesPaths 相交的任务不会被同时派发（单测构造）；
- [ ] 重试：max_attempts 内 partial/failed 任务可回队，超出后终态；
- [ ] 压测参考值：100 条排队任务在 6 vCPU 单进程下调度循环无明显积压（logs 可观测）。

### P6 部署与运维（M16）

产出：`deploy/workmesh.service`（systemd，`WorkingDirectory=/home/fish/projects_mine/dsh-workmesh`，Restart=on-failure）、`backup.sh`（`sqlite3 … ".backup"` 滚动保留 7 份 + cron）、`.env.example`（无真实密钥）、磁盘水位告警脚本。

验收要点：

- [ ] `systemctl --user status workmesh` active，重启后数据仍在（SQLite 持久化验证）；
- [ ] 备份恢复演练：从备份文件恢复库并 `integrity_check` 通过，演练记录写入 `docs/`；
- [ ] 日志轮转与磁盘告警生效（`/home` 100% 的现状必须能被告警捕获）；
- [ ] VPS 迁移清单：Node 26+ / pnpm / systemd 单元 / 数据目录——无 Redis、无 MQ、无集群组件。

## 4. 里程碑依赖与并行度

```text
P0 ──▶ P1 ──▶ P2 ──▶ P5 ──▶ P6
 │      └──▶ P3 ──┐
 └────▶ (M11 契约先行，P1 定稿后 P2–P4 可并行)
             P4 ──┘
```

可并行的分组（按 §2 责任表，无文件交集）：{M3, M4, M5}、{M8, M9}、{M12 完成 + M13 与 M14 分头}。M11 契约在 P1 定稿前冻结，其后修改视为破坏性变更，须同步全部依赖模块。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 开发机 `/home` 100% 占满 | P0 前强制清理；`pnpm store prune`；依赖选型已排除重型编译项（node:sqlite 零原生依赖） |
| Grok Workflow 插件挂载机制未在 profile 配置中确认 | P4 主路径走 DSH headless 直派（不依赖插件挂载）；插件集成列为增强项 |
| Bifrost 为外部远端，可能不可用 | 适配器 5s 超时 + 快照降级 + stale 标记；健康巡检独立于请求路径 |
| Agent2API 为 Rust/AGPL，端口或版本可能变化 | 仅 HTTP 集成不引入代码；适配器端点可配置，探活失败不阻塞其余功能 |
| 任务描述截断（页面 B） | 按 ARCHITECTURE.md §0 的最小语义实现并留扩展位；取得完整规格后增量调整 |
| node:sqlite 上游仍处演进期 | DAO 层隔离，切换 better-sqlite3 只动 `db/db.ts` 与依赖清单 |

## 6. 总验收清单（对照任务验收标准）

- [ ] `docs/ARCHITECTURE.md` 与 `docs/IMPLEMENTATION_PLAN.md` 存在且完整（本两份）；
- [ ] 技术栈决策及理由 + 「已有栈优先、空工作区默认 TypeScript+轻量框架+SQLite+现代前端」声明（ARCHITECTURE.md §2）；
- [ ] 三平面到具体组件的映射与网关/执行引擎职责边界（ARCHITECTURE.md §3）；
- [ ] 勘察结论：无既有原型/实现、可复用模块清单、多仓库职责、Agent2API/Bifrost/Grok Workflow 实际发现（ARCHITECTURE.md §1）；
- [ ] 模块清单与文件责任人划分表，每文件/目录唯一责任模块（本文档 §1/§2）。

## 7. 版本记录

- v0.1（2026-11-08）：初版，对应 ARCHITECTURE.md v0.1。
