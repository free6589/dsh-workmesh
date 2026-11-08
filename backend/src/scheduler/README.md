# Workmesh 全局调度器（backend/src/scheduler）

网关级模型调度引擎：在 **Agent2API / Bifrost / 独立 API** 三类资源入口之间做确定性选择，
并负责任务状态机、阻塞识别、无人值守的自动下一步与调度决策审计。

## 职责边界（审查要点）

| 做 | 不做 |
|---|---|
| 网关级选择：选定 (gateway, model) + 降级链 + 可追溯理由 | Agent2API 内部账户轮换（由 Agent2API 自身负责） |
| 消费 gateway_adapters 的模型目录/额度/健康**数据**（经 `SchedulerPorts` 接口） | 实现/修改任何适配器代码 |
| 派发决策落库：创建 `queued` run + `scheduler_decision` 事件，供执行平面消费 | 直接调用模型 API 发起推理 |
| Grok Workflow 的**上游编排**：决定是否派发、派给哪个资源 | 重实现 Grok Workflow 的 plan–execute–verify–retry 执行引擎 |

## 模块结构

| 文件 | 职责 |
|---|---|
| `types.ts` | 领域类型（调度上下文、决策、候选评估） |
| `policy.ts` | 策略引擎（纯函数）：硬性过滤 + 固定权重评分 + 确定性排序 |
| `state.ts` | 任务状态机、阻塞识别、无人值守下一步安排（退避/升级） |
| `planning.ts` | 跨项目协同优先级与全局派发顺序 |
| `ports.ts` | `SchedulerPorts` 端口契约 + settings 读取 + `DbSchedulerPorts` 默认数据通道 |
| `ports-adapter.ts` | M8 `GatewayAdapter` → `SchedulerPorts` 桥（只消费适配器接口，不改适配器代码） |
| `engine.ts` | 引擎：`decide`（决策落库）/ `tick`（无人值守一轮）/ 查询 |
| `router.ts` | Hono 路由工厂（决策查询、手动决策、tick、阻塞清单、派发顺序） |

## 调度策略

```
score = 健康(healthy=1 / degraded=0.4) × 0.35
      + 配额余量(1 − 使用率) × 0.30
      + 上下文契合(达标 2 倍记满分) × 0.15
      + 模型偏好(命中 preferredModel) × 0.20
      − 争用惩罚(使用率 > 0.6 且归一化优先级 < 0.7 时生效)
```

硬性淘汰（记录原因码）：网关未注册/禁用/unavailable、能力缺失、上下文不足或未知、
配额耗尽、degraded 且任务声明 `allowDegraded=false`。
排序：得分降序 → 网关类型序（agent2api → bifrost → independent）→ gatewayId/modelId 字典序；
首个为 selected，其余自动构成降级链。全部常量固定，同输入必同输出。

## settings 约定（优先级设定由数据层读写）

| 键 | 内容 |
|---|---|
| `scheduler.unattended` | `'true'/'false'`，无人值守总开关（缺省 false） |
| `scheduler.project_priorities` | `{"<projectId>": 0..10}` 项目权重（缺省 5） |
| `scheduler.task_requirements` | `{"<taskId>": {requiredCapabilities, minContextWindow?, preferredModel?, allowDegraded?}}` |
| `scheduler.gateway_health` | `{"<gatewayId>": "healthy"/"degraded"/"unavailable"}` 健康覆盖（适配器上报） |
| `scheduler.model_catalog` | `ModelCatalogEntry[]` 目录快照（适配器同步；quotas 绑定作兜底目录） |
| `scheduler.resource_usage` | `ResourceUsage[]` 用量快照（适配器上报） |

## 决策审计

- 每次决策写 `audit_log`：`action='scheduler_decision'`，detail 为完整决策
  （选定/降级链/全部候选评估与原因码/rationale/状态快照/attempts）；
- 阻塞时另写 `action='scheduler_blocked'`：原因 + 下一步安排 + 预计重试时刻；
- 派发时创建 `runs`（queued）并在 `run_events` 记 `type='scheduler_decision'` 事件；
- 查询：`GET /scheduler/decisions`、`GET /scheduler/decisions/:decisionId`、
  `GET /scheduler/blocked`、`GET /scheduler/dispatch-order`、
  `POST /scheduler/decide {task_id}`、`POST /scheduler/tick {limit?}`。

## 装配

```ts
// server.ts / routes 装配处（一行）：
app.route('/scheduler', createSchedulerRouter({ repos }));
```

M8 网关适配器落地后有两种接入方式：

```ts
// 1) 适配器桥（推荐）：每轮调度前把 GatewayAdapter 读数解析为端口快照
import { createPortsFromAdapters } from './scheduler/ports-adapter.js';
const ports = await createPortsFromAdapters(adapters, { usage: reportUsage() });
const engine = new SchedulerEngine({ repos, ports });

// 2) settings 快照通道：DbSchedulerPorts（缺省），适配器把目录/健康/用量写入 settings
```

`ports-adapter.ts` 只 import 适配器契约类型（`GatewayAdapter` / `HealthReport`），
不修改 `src/adapters/**` 的任何实现；配额读数（账户级、无归一化比率）不直接进策略，
用量比率继续走 settings 通道。
