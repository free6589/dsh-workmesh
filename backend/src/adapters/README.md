# 网关适配器 —— 端点来源与验证记录

本目录实现模型资源平面的统一网关适配器接口与三类独立实现。
**对接探测代码只调用本文登记且经实际验证存在的端点**；未验证的端点一律不调用，
相应数据以「网关未提供」显式上报，绝不伪造。

## 统一接口（types.ts）

| 方法 | 语义 | 失败语义 |
|---|---|---|
| `listModels()` | 模型目录 | `{ok:false, endpoint, httpStatus?, error}` |
| `getQuota()` | 账户/额度/用量 | `status: 'not_provided'`（网关未提供该 API）或 `'error'`（API 存在但读取失败），均不携带编造数字 |
| `getHealth()` | 健康探测 | `status: 'ok' \| 'degraded' \| 'unreachable' \| 'not_provided'` |
| `chat?()` | 可选请求能力 | `{ok:false, ...}`；`supportsChat` 声明能力 |

## 三类适配器与职责边界

| 实现 | 文件 | 定位 |
|---|---|---|
| `Agent2APIAdapter` | `agent2api.ts` | 主聚合网关。账户轮换 / Provider 调度完全在 Agent2API 内部，Workmesh 只做网关级探测，单次请求、无重试、无轮换 |
| `BifrostAdapter` | `bifrost.ts` | 独立网关路径，与 Agent2API 不共享任何逻辑 |
| `IndependentApiAdapter` | `independent.ts` | 独立第三方 API 直连（kind=independent），备用通道，仅 OpenAI 兼容标准端点 |

## Agent2API 端点清单

来源：本机 checkout `/home/fish/projects_mine/Agent2API` @ commit `bd36938d`（main），
服务端为 Rust crate `agent2api-server`，路由表 `desktop-tauri/src-tauri/server/src/server/http.rs`。

| 端点 | 鉴权 | 来源（文件:行） |
|---|---|---|
| `GET /health` | 无需鉴权（公开就绪探针；headless 闸门形态只回 `{status:"ok"}`） | `http.rs:886` 挂载；`api/health.rs` 头注释（裸 JSON，`status: "ok"\|"degraded"`） |
| `GET /v1/models` | 未携带 Key 可读公开清单；携带则必须有效 | `http.rs:891` 挂载；`api/chat.rs` `list_models`（「未携带 Key 时可读取公开清单。携带 Key 时必须有效」） |
| `POST /v1/chat/completions` | 必须携带有效网关 Key | `http.rs:902` 挂载；`http.rs:1084` `require_api_key`（「模型调用必须携带有效网关 Key，管理员会话不能代替模型鉴权」） |
| `GET /api/accounts/usage/snapshot` | 面板会话 **或不受限网关 Key** | 管理入口 `http.rs:406`（`/api/accounts` → `accounts_entry`）；实现 `api/accounts_usage.rs:43-57`（响应 `{at, results:[{id,name,usage,error,code?,at}], skipped}`）；Key 准入管理面：`http.rs:1103-1108`（「Key 也能操作管理接口（桌面壳 / 脚本自动化的通道）」；受限 Key 403 `management_access_denied`，`http.rs:1101-1103`） |

凭证头（`access.rs:757-761`、`access.rs:880-898`）：`Authorization: Bearer <key>` 或 `x-api-key`。
本适配器统一发送 `Authorization: Bearer`。

**适配器不调用**（无论是否有权限）：`/api/accounts` 的增删改、`/api/routing/*`、
`/api/checkin-*`、`/api/proxies/*`、`/api/keys` 等一切管理写接口 —— 那些是 Agent2API
内部账号与调度体系的操作面，Workmesh 只读快照、不做轮换、不做调度。

## Bifrost 端点清单

来源 1（部署事实）：本机留档 `/home/fish/projects_mine/bifrost-mirror`：

- `system-config/init.d/bifrost:2` ——「Bifrost AI gateway (docker maximhq/bifrost:latest, DB-backed)」，即部署本体为 **maximhq/bifrost**（Go 网关，docker，8080）；
- `system-config/caddy/Caddyfile` —— `handle /openai/* → 127.0.0.1:8080`（公网 API，应用层 virtual-key 鉴权）；`/openai/v1/chat/completions*` 单独转发至协议修补层（server-shim 8101）；
- `docs/ARCHITECTURE.md §1.4` —— DSH profile 中 bifrost provider 的 `baseURL: https://models.fyrali.com/openai/v1`。

来源 2（实测，2026-11-08 只读探测 `https://models.fyrali.com`）：

```
GET  https://models.fyrali.com/openai/v1/models
  → 401 {"type":"virtual_key_required","is_bifrost_error":false,"status_code":401,
         "error":{"message":"virtual key is required. Provide a virtual key via the x-bf-vk header."},
         "extra_fields":{"routing_info":{}}}
GET  https://models.fyrali.com/openai/v1/chat/completions
  → 404 {"error":"not found"}   ← 路径由 Caddy 转发、仅接受 POST；GET 404 佐证路径存在
GET  https://models.fyrali.com/api/health
  → 200 但为静态站点 HTML（非 Bifrost 探针；该路径未反代到网关）
```

结论与实现选择：

| 端点 | 鉴权 | 状态 |
|---|---|---|
| `GET {base}/models` | `x-bf-vk: <virtual key>`（401 报文原文指定）；同时发送 `Authorization: Bearer` 以兼容 OpenAI 客户端惯例 | **已验证存在**，用于 listModels 与健康探测 |
| `POST {base}/chat/completions` | 同上 | **已验证路径**（POST），用于可选请求能力 |
| governance / budget / virtual-key 管理类 API | —— | **未经验证**（直连 8080 从本机不可达），`getQuota()` 恒返回 `not_provided`，不调用 |

## independent（独立第三方 API）端点清单

只有 OpenAI 兼容标准端点：`GET {base}/models`、`POST {base}/chat/completions`（`Authorization: Bearer`）。
第三方供应商没有统一的账户/额度接口 → `getQuota()` 恒返回 `not_provided`。

## baseUrl 约定

| kind | baseUrl 形态 | 示例 |
|---|---|---|
| `agent2api` | 网关根（不含 `/v1`） | `http://127.0.0.1:3065` |
| `bifrost` | OpenAI 兼容根（含 `/openai/v1`） | `https://models.fyrali.com/openai/v1` |
| `independent` | OpenAI 兼容根（含 `/v1`） | `https://api.example.com/v1` |

## 密钥纪律

- 数据库只存 `api_key_env`（环境变量**名**，见 `src/types/entities.ts` 头注释）；
- 适配器在内存中经 `secretResolver` 取值，任何密钥材料不入库、不写日志、不出现在 API 响应；
- 测试全部使用虚构的 env 名与占位值。

## 调度边界（验收项）

Workmesh 层（本目录 + `services/resources.ts` + `routes/resources.ts`）**不包含**：
账户轮换、跨账号重试、Provider 故障转移、模型选择策略。适配器每次探测只发一次请求，
失败如实上报；多网关间的取舍属于 scheduler（M10）的职责，本层只提供资源状态数据。
