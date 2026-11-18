# xacpx Relay Hub 设计（多实例遥控看板）

> **认证 / CLI / 端口模型已被后续实现取代（2026-11 复核）**：本文的以下主张与当前代码不符，
> 阅读时请以代码与 `docs/relay-deployment.md` / `docs/relay-module.md` 为准：
> - 账号表：本文设计 `password_hash(scrypt)` + `role(admin|member)`；实际 `accounts` 只有
>   `id / username / created_at`，登录走 access token（`packages/relay/src/db.ts`、`src/http/app.ts` 的 token 登录）。
> - CLI：本文设计 `start|stop|status|init-admin`；实际是 `start / add token / add invite / ls / rm token / rm invite / push-keys generate / update`（`packages/relay/src/cli.ts`），没有 `stop`/`status`/`init-admin`。
> - 端口：本文设计 HTTP 与实例 WS 分两个端口（默认 8787/8788）；默认已是单端口合并（网关走 HTTP 端口的 upgrade），`--ws-port` 仅用于独立网关端口。
> - `invites` 表与“配对 token 作废后换发长期凭证”的细节以当前 schema 与 `docs/relay-deployment.md` 为准。
>
> 本文保留为最初的产品/架构设计记录（多实例遥控看板的整体形态仍然成立）。

- 日期：2026-06-13
- 状态：已确认（与用户逐节评审通过）
- 范围：新增 relay 服务端、Web 看板、xacpx 侧连接器插件与核心 Control API

## 1. 背景与目标

xacpx 目前通过 IM 频道（微信/飞书/元宝）远程控制 acpx 会话。本设计新增一条「自托管 Web」路径：

- 一个可部署在服务器上的 **relay hub**，接受多个 xacpx 实例外联注册，转发消息与指令；
- 一个 **Web 看板**（三栏 IM 形态），登录后可跨实例管理会话：对话、安排定时任务、跟踪/操作编排任务；
- 多租户：一个部署内可开多个账号（管理员邀请制），实例归属账号、账号间隔离。

定位是 **遥控面板**：任务与编排的事实源始终在各 xacpx 实例（scheduler / orchestration），relay 不自建任务模型，只做账号、路由、转发与展示缓存。

## 2. 决策摘要

| 决策点 | 结论 |
| --- | --- |
| 拓扑 | 多实例 Hub：实例 WSS 外联注册，relay 托管 Web 看板 |
| 用户模型 | 多租户（单部署多账号，管理员邀请制） |
| 分发形态 | 开源自托管包（npm / 后续可加 Docker），依赖轻（SQLite） |
| 任务模型 | relay 为遥控面板，不自建任务模型；实例离线即置灰，不排队 |
| 界面形态 | 三栏 IM：左实例-会话树 / 中聊天流 / 右当前会话任务面板 |
| 消息语义 | Web 是独立频道（独立 chatKey），不镜像、不互通其它频道 |
| xacpx 接入 | 核心新增正式 Control API（src/control/），连接器只做搬运 |
| 代码位置 | 本仓库 packages/ 下，新增 4 包 + 1 核心子系统 |
| 前端栈 | Vue 3 + Vite；服务端 TypeScript + Bun 构建、Node 兼容 |

## 3. 总体架构

```
┌─ 用户电脑 / 内网（每个 xacpx 实例）─────────────────┐
│  xacpx daemon                                        │
│  ├─ src/control/        ★新增 Control API（核心）    │
│  │    ControlService：sessions / prompt / scheduler  │
│  │    / orchestration 的类型化门面 + ControlEventBus │
│  │    （turn 输出、会话状态变更等事件流）             │
│  └─ packages/channel-relay  ★relay 连接器插件        │
│       消费 ControlService，外联 relay (WSS)，         │
│       配对 token 注册，断线指数退避重连               │
└──────────────────────────┬───────────────────────────┘
                           │ WSS（实例外联，JSON 信封协议）
┌─ 服务器（自托管部署）────▼───────────────────────────┐
│  packages/relay  ★relay hub 服务                     │
│  ├─ 实例网关：接受实例注册、按账号路由               │
│  ├─ SQLite：账号 / 实例 / 配对 token / 聊天历史缓存  │
│  ├─ HTTP API + WS：服务前端（登录态、实时事件推送）  │
│  └─ 静态托管 Web SPA                                 │
│  packages/relay-web  ★Vue 3 + Vite 三栏 IM 看板      │
│  packages/relay-protocol ★协议/类型共享包            │
└──────────────────────────┬───────────────────────────┘
                           │ HTTPS / WSS
                      浏览器（多账号登录）
```

## 4. 组件设计

### 4.1 `src/control/` —— 核心 Control API（新核心子系统）

把分散在 SessionService、ActiveTurnRegistry、scheduler、orchestration、transport 的能力收拢为一个类型化控制面，服务结构化消费者（首个消费者是 channel-relay）：

- **ControlService**（门面，按域分组）：
  - `sessions`：列出逻辑会话（alias/agent/workspace/绑定）、运行状态、新建/删除逻辑会话；
  - `prompt`：向指定会话发 prompt（流式输出经事件总线）、取消运行中 turn；
  - `scheduler`：列出/创建/取消定时任务（对接现有 /later 调度器）；
  - `orchestration`：列出编排任务与状态、取消；创建面按现有编排能力渐进暴露；
  - `executeCommand`：以合成 chat 上下文走现有命令路由执行任意 `/命令`，返回文本（Web 输入框兜底）。
- **ControlEventBus**：结构化事件流——turn 输出分片、turn 终态、会话增删/状态变更、定时任务变更、编排状态变更。消费者订阅后自行序列化转发。
- 命令路由继续服务文本频道；Control API 与其并行，二者共享底层服务，不互相依赖。
- 通过 `ChannelStartInput` 以可选字段注入（`control?: ControlService` 等），保持频道边界惯例。

### 4.2 `packages/relay-protocol` —— 协议共享包

- JSON 信封：`{ protocolVersion, kind: "req" | "res" | "event", id?, type, payload }`；
- 实例↔relay 与 前端↔relay 两组消息类型分开命名空间；
- 提供类型守卫与编解码校验（不引运行时重依赖）；
- `protocolVersion` 不匹配时双方返回明确错误（指明哪侧需升级），不静默降级。

### 4.3 `packages/channel-relay` —— xacpx 侧连接器插件

- 标准 channel 插件（`XacpxPlugin`），频道类型 `relay`；
- 实现 `MessageChannelRuntime`：聊天回合走 `agent.handle(chatKey, text)`，享受频道既有语义（配额、定时任务投递、编排通知）；交互回合带 `metadata.chatType: "direct"` + `senderId`（hub 账号 id），符合 fail-closed 路由契约；
- 经 `ChannelStartInput.control` 消费 ControlService：结构化查询与操作序列化为 relay 协议；订阅 ControlEventBus 转发事件；
- 外联 WSS：首连用一次性配对 token 注册，换发长期实例凭证存入 `<xacpx-home>/relay/credential.json`（不进 config.json）；断线指数退避重连；
- CLI provider：`xacpx channel add relay --url <ws(s)-url> --token <pairing-token>` 写入频道配置；配对交换发生在首次运行时连接（连接器以 token 注册 → relay 换发长期凭证 → 存 `<xacpx-home>/relay/credential.json`，不进 config.json）。核心 CLI 不支持插件自定义顶级命令，故不提供 `xacpx relay connect`。

### 4.4 `packages/relay` —— hub 服务端

- TypeScript，Bun 构建、Node 运行时兼容；HTTP + WS 服务（框架选型在实施计划中定，倾向轻量如 Hono + ws）；SQLite 经 SqlDriver 适配层（Bun→bun:sqlite，Node→node:sqlite，零原生依赖）；HTTP（Hono）与实例 WS 分两个端口（默认 8787/8788）。
- **实例网关**：校验实例凭证、维护在线状态（last_seen 心跳）、把前端指令路由到目标实例、把实例事件扇出给该账号的前端连接；
- **前端 API**：登录（HTTP-only cookie）、快照查询（实例/会话/任务列表）、WS 事件订阅；前端模型为「快照 + 事件增量」，重连先拉快照再订阅；
- **SQLite 持久化**：见 §5；聊天历史仅作回显缓存，可配置保留策略；
- 静态托管 relay-web 构建产物；CLI：`xacpx-relay start|stop|status|init-admin`。

### 4.5 `packages/relay-web` —— Web 看板（Vue 3 + Vite）

三栏 IM 布局：

- **左栏**：实例-会话树（在线状态、运行中 ● 标记）、新建/删除逻辑会话、实例配对入口；
- **中栏**：选中会话的聊天流；prompt 流式渲染；运行中可取消；输入框支持 `/命令`（executeCommand 文本结果渲染）；历史回显来自 relay 缓存；
- **右栏**：当前会话的定时任务（列表/创建/取消）与编排任务（列表/状态/取消）；
- **设置页**：账号管理（admin 邀请）、实例配对（生成 token + 引导命令）、历史保留策略。

## 5. 数据模型（relay SQLite）

- `accounts`：`id, username, password_hash(scrypt，node:crypto 内置、格式含参数可迁移), role(admin|member), created_at`；
- `invites`：`token_hash, created_by, expires_at, used_by`；
- `instances`：`id, account_id, name, credential_hash, status, last_seen_at, core_version`；实例唯一归属账号，账号间不可见；
- `messages`：`instance_id, session_alias, direction, text, created_at`（回显缓存，按条数/天数保留）【阶段三实现（聊天回显缓存），阶段二未实现】；
- `web_sessions`：登录态 token 哈希。

## 6. 实例配对流程

1. Web 看板「添加实例」→ relay 生成一次性配对 token（短有效期，hash 存库）；
2. 用户在 xacpx 侧执行 `xacpx channel add relay --url wss://hub.example.com --token <token>`；
3. 连接器首连注册，relay 校验后换发长期实例凭证（hash 存库），配对 token 作废；凭证存入 `<xacpx-home>/relay/credential.json`（不进 config.json）；后续重连用实例凭证。

## 7. 安全

- 实例连接生产环境强制 WSS；relay 自身不执行任何命令，仅路由——被攻破时攻击面限于向已配对实例发指令，实例侧仍受 xacpx 自身权限语义约束；
- Web 登录限流；密码 scrypt（node:crypto 内置、格式含参数可迁移）；所有 token/凭证哈希落盘；
- 账号隔离：所有实例/会话/消息查询强制按 account_id 过滤；
- Web 用户对自己账号下的实例视为 owner。

## 8. v1 范围与非目标

**v1 做**：上述三栏全部功能、多账号邀请、实例配对、断线恢复、`/命令` 兜底。

**v1 不做**：离线任务排队、跨实例编排、消息镜像/互通其它频道、移动端适配优化、审计日志。

## 9. 错误处理

- **实例离线**：树置灰、会话只读、写操作返回明确错误；连接器重连恢复后状态自动刷新；
- **relay 重启 / 前端断线**：两侧自动重连；前端「快照 + 事件增量」防幽灵状态；
- **turn 流中断**：turn 终态事件兜底，UI 标注「连接中断已恢复」，不静默丢尾部输出；
- **协议版本不匹配**：明确报错并指明升级侧。

## 10. 测试策略

- `relay-protocol`：编解码与类型守卫单测；
- `src/control`：`tests/unit/control/` 单测，复用现有 fake service 模式；
- `channel-relay`：参考 channel-feishu 测试模式（先 build dist），内存 fake relay 服务端做协议往返测试；
- `relay`：认证、网关路由、快照/事件一致性单测 + fake 连接器集成测试；
- 全链路：v1 用 `bun run dry-run` 实例 + 本地 relay 手动验证，后续补 smoke。

## 11. 实施分期建议

1. **阶段一**：`src/control/`（ControlService + ControlEventBus）+ `relay-protocol`；
2. **阶段二**：`packages/relay` 服务端（账号/配对/网关）+ `channel-relay` 连接器，CLI 配对走通；
3. **阶段三**：`relay-web` 三栏看板（会话树 + 对话流）；【已实现】登录 + 实例/会话树 + 对话流交付，
   同时落地服务端 Web 扇出（`/ws`）、`messages` 缓存表与 `MessageStore`/`WebGateway`；
4. **阶段四**【已实现】：右栏任务面板（定时 + 编排：列表/创建/取消）、设置页（admin 邀请 +
   实例配对 token + 只读历史保留摘要）、`instance.notice` toast、`/ws` 连接恢复徽标、
   服务端保留/GC 维护循环（`src/maintenance.ts` + `--history-retention-days`，每会话 2000 上限，
   GC 过期 web_sessions/invites/pairing_tokens）、`GET /api/config`，以及 `control.command.execute`
   输入+输出回显进 `messages` 缓存。历史保留为服务端配置，v1 在 Web 端只读不可编辑。
5. **阶段五**【已实现】：审计修复 —— 错误恢复（重连快照、连接中断回合标记、取消运行回合）、
   安全加固（pairing-token/invites CSRF 415、限流上限、网关在线掉线即时拒绝、凭证定时安全比较与原子写、
   协议版本不匹配显式提示、web 事件深度校验）、补齐 §4.5 会话创建/删除 UI。

每阶段单独出实施计划（writing-plans），独立可合并。
