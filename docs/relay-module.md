# Relay Hub 模块说明（packages/relay + packages/channel-relay）

自托管多实例遥控枢纽。设计 spec：docs/superpowers/specs/2026-06-13-relay-hub-design.md。

## 服务端（@ganglion/xacpx-relay）

- 运行时：Node >= 22.13（node:sqlite）或 Bun >= 1.2（bun:sqlite），SqlDriver 适配层自动选择。
- 两个端口：HTTP API（默认 8787，登录/邀请/实例/RPC 代理）+ 实例 WS 网关（默认 8788）。
- 快速开始：
  1. `xacpx-relay user new --account admin --db ./relay.db`（打印一次性登录令牌）
  2. `xacpx-relay start --db ./relay.db`
  3. `xacpx-relay pair --account admin --name home-pc --db ./relay.db`（铸造连接器配对令牌）
- RPC 请求超时：`xacpx-relay start --request-timeout-ms <ms>` 限定网关 RPC 请求超时，默认 `120000`
  （共享常量 `DEFAULT_REQUEST_TIMEOUT_MS = 120s`，位于 packages/relay/src/gateway/instance-gateway.ts，
  网关回退与服务端均复用之）；agent 冷启动慢 / 长 prompt 时可调大。
- 安全：登录令牌（login token）哈希落盘（scrypt，node:crypto 内置，格式含参数可迁移）；所有 token/凭证哈希存储；登录限流按客户端 IP + 全局失败上限（有界，见阶段五）；
  凭证比较定时安全（`hashEquals`，见 src/auth.ts）；RPC 代理只放行
  control.* 且服务端覆写 chatKey(`relay:<accountId>`)/senderId/isOwner。
- 账号模型：无密码、无角色、无邀请码；凭证为 CLI 铸造的登录令牌（`login_tokens` 表）；每个账号可持有多枚令牌；
  `token revoke --id <id>` 吊销单枚令牌并级联删除其派生的所有 web 会话。
- CSRF backstop：`/api/login`、RPC 以及 `POST /api/instances/pairing-token`
  统一要求 `content-type: application/json`（`requireJson`），否则返回 415。
  `/api/register` 与 `/api/invites` 已移除（显式返回 404）；`/api/*` 鉴权网关仅豁免 `/api/login`。

## 连接器（@ganglion/xacpx-channel-relay）

- 安装与配对：
  ```
  xacpx plugin add @ganglion/xacpx-channel-relay
  xacpx channel add relay --url ws://<relay-host>:8788 --token <pairing-token>
  xacpx restart
  ```
- 首连用配对 token 注册并换发长期凭证，存 `<xacpx-home>/relay/credential.json`
  （weixin 凭证先例；config.json 只存 url/pairingToken）。token 单次有效，
  过期/已用需在 relay 侧重新生成并 `xacpx channel add relay` 更新。
- 桥接面：relay 的 control.* RPC → 核心 ControlService（见 docs/control-module.md）；
  ControlEventBus 事件与编排通知上行为 instance.event / instance.notice。
- 会话创建表单数据面：`control.agents.list`（列已配置 agent：name+driver）、
  `control.workspaces.list`（name+cwd+description）、`control.workspaces.create`
  （按名+路径新建并**持久化**到实例 config，经 ConfigStore.upsertWorkspace + replaceRuntimeConfig
  同步进运行时 config 供 SessionService 校验）——三者经 control-bridge 映射到 ControlService。
- agent catalog 与配置管理 RPC（**config-global，非 chat-scoped**，与 agents.list/workspaces.list 一致）：
  - `control.agents.catalog`：返回 xacpx 已知的**全部 acpx driver**（来自 `listAgentTemplates()`，见
    src/config/agent-catalog.ts），每项带 `configured`（是否已落到 config.agents）+ best-effort
    `installed`：`builtin`（codex/claude，npx 自动拉取无需预装）/`yes`（PATH 探到对应 CLI 二进制）/
    `unknown`（探不到——纯提示，永不硬拦，可能装在无法预测的名字下）。
  - `control.agents.create {name,driver}`：按名+driver 新建 agent 并持久化进实例 config。
  - `control.agents.remove {name}`：删除 agent；若有现存会话正在用该 agent，则以 in-use 错误拒绝。
  - `control.workspaces.remove {name}`：删除 workspace；若有现存会话正在用该 workspace，则以 in-use 错误拒绝。
  - 四者经 control-bridge 映射到 ControlService（catalog/create/remove），in-use 校验在 ControlService 内。
- `control.sessions.create` 走**完整 transport 生命周期**（resolve→reserve→ensure→check→attach→refresh，
  经 `CommandRouter.createSessionWithTransport`）：解析 agent/workspace → 预留别名 → 在后端建/确认 acpx 命名会话
  → 校验 → 绑定逻辑会话 → best-effort 刷新 agent command。看板新建的会话因此**立即可 prompt**（旧实现只建逻辑会话，
  prompt 会以 `No named session` 失败）。
- 阶段边界：离线不排队（实例离线时 RPC 返回 503）；事件断线期间丢弃；
  Web 看板（阶段三）消费本阶段的 HTTP API 与事件。

## 阶段三服务端接缝（Web 看板扇出）

服务端为 Web 看板新增的接缝（见 docs/relay-web-module.md）：

- **`messages` 缓存表（§5）+ `MessageStore`**：聊天回显缓存
  （`instance_id, session_alias, direction, text, created_at`）。`append()` 写入，
  `listBySession(accountId, ...)` 按 account 隔离、oldest-first 取最近若干条。
- **`WebGateway` 按账号扇出**：跟踪每个账号已鉴权的浏览器 socket，把 `WebServerEvent`
  编码为 `web.event` 信封 `broadcast(accountId, event)` 给该账号所有连接。
- **实例网关 `onStatusChange`/`onEvent` 接线**（server.ts `createRelayRuntime`）：
  - `onStatusChange` → web 广播 `instance-status`；离线时清空该实例的 turn 缓冲。
  - `onEvent`（instance.event）→ web 广播 `control-event`；其中 `turn-output` 分片按
    (instance, session) 累积进内存缓冲，`turn-finished` 时 flush 为一条 `out` 历史消息
    写入 `MessageStore`；instance.notice → 广播 `notice`。
- **cookie 鉴权的 `/ws` web 扇出端点**：挂在 HTTP server 的 upgrade 上（与实例网关 `wsPort`
  分离），校验 `xrelay_session` cookie → 账号后 `webGateway.register(accountId, ws)`。
- **`GET /api/instances/:id/sessions/:alias/messages`**：按登录账号返回该会话的缓存历史。
- **prompt 回显历史**：`control.prompt` 经 RPC 代理时，把 prompt 文本 append 为一条 `in` 历史消息。
- **command 回显历史（阶段四）**：`control.command.execute` 经 RPC 代理时，把输入文本 append 为 `in`、
  把返回 `output` append 为 `out`（与 `control.prompt` 的 `in` 回显并列），使 `/命令` 结果也能跨 reload 存活。
- **`--web-root` 静态托管**：`createRelayRuntime({ webRoot })` → Hono `serveStatic` 托管 SPA
  构建产物（含 index.html SPA fallback）；CLI `xacpx-relay start --web-root <dir>`。

## 阶段四服务端接缝（维护循环与配置）

- **`GET /api/config`（authed）**：返回 `{ historyRetention: { days, maxPerSession } }` 供设置页展示；
  历史保留是服务端配置（只读），v1 不在 Web 端可改。
- **维护子系统 `src/maintenance.ts`**：`runMaintenance(stores, opts)` 跑一遍清理，
  `startMaintenanceLoop(...)` 每小时一次（`setInterval` 并 `unref`，不挡进程退出）：
  - 按账龄裁剪 `messages`（`--history-retention-days`，默认 30 天）+ 每会话硬上限
    `MAX_MESSAGES_PER_SESSION = 2000`（保最新）——`MessageStore.prune({ maxAgeMs?, maxPerSession? })`；
  - GC 过期的 `web_sessions`（`AccountStore.pruneExpired(now)`）与
    `pairing_tokens`（`InstanceStore.prunePairingTokens(now)`）。
- **CLI**：`xacpx-relay start --history-retention-days <n>`（透传给维护循环）。

## 阶段五加固（审计修复）

服务端（packages/relay）：

- **CSRF 415 backstop**：`POST /api/instances/pairing-token` 补上
  `requireJson` 守卫（与登录/RPC 一致），非 JSON 请求返回 415。
- **登录限流有界**：限流表按时间淘汰过期条目 + 最旧窗口硬上限，避免无界 Map 内存 DoS。
- **网关在线掉线即时拒绝**：`InstanceGateway` 在 socket 关闭时立即用 `instance-offline`
  排空在途请求（原先要等到 15s 超时才返回 503）。
- **凭证定时安全比较**：`verifyCredential` 改用定时安全哈希比较（`hashEquals`，src/auth.ts）。

协议（packages/relay-protocol）：

- **web 事件深度校验**：`parseWebServerEvent` 现在深度校验内层 `ControlEventDto` 的判别式/各变体字段
  以及 notice 形状（原先只校验外层信封），收紧 web 线信任边界。

连接器（packages/channel-relay）：

- **凭证原子写**：`CredentialStore.save` 用临时文件（mode 0600）+ chmod + rename 原子落盘，
  覆写时重新收紧权限，避免崩溃导致损坏/锁死。
- **协议版本不匹配显式提示**：`RelayClient` 记录无法解码的消息，遇到 `version-mismatch` 停止重连；
  收到 relay 的 `relay.protocol-error` 事件同样记录并停连（原先静默丢弃）。
- **`scheduled.create` 入参校验**：`control-bridge` 校验 `executeAt`，非 ISO 值返回 `bad-request`
  （原先抛通用 internal error）。

## 阶段六：Turn 状态展示流水线（turn-status display）

### 协议事件（packages/relay-protocol/src/dtos.ts）

`ControlEventDto` 包含以下新事件变体（与现有 `turn-output` 并列）：

- `{ type: "turn-started"; chatKey; sessionAlias }` — 回合开始，触发前端/服务端清零缓冲。
- `{ type: "tool-event"; chatKey; sessionAlias; step: ToolStepDto }` — 单次工具调用的 **归一化** 呈现 DTO（非原始 `ToolUseEvent`；由连接器侧规整后再入线）。
- `{ type: "turn-thought"; chatKey; sessionAlias; chunk: string }` — reasoning 文本分片（流式追加）。
- `{ type: "turn-finished"; chatKey; sessionAlias; ok; errorMessage?; cancelled?: boolean }` — 终态信号；`cancelled` 为 true 表示用户手动取消。

### 连接器规整（packages/channel-relay/src/tool-presentation.ts）

`toolUseEventToStepDto(event: ToolUseEvent): ToolStepDto` 将核心层的原始 `ToolUseEvent` 规整为友好的、有上限的呈现 DTO：

- `TEXT_CAP = 8000` 字符（文本/命令输出/搜索结果/读取预览等通用字段上限）。
- `DIFF_CAP = 4000` 字符（diff oldText / newText 各自上限）。
- `REASONING_CAP = 16000` 字符（在服务端侧对 reasoning chunk 累积截断）。
- **工具步数上限 `MAX_TOOL_STEPS = 200`**（服务端 server.ts 中校验，超出步数的新步骤静默丢弃）。
- 按 `kind` 分派到具体 `ToolDetailDto` 变体（`diff / read / command / search / text / fields`），不向线路侧暴露任何原始 JSON。

### 服务端累积与持久化（packages/relay/src/server.ts）

`createRelayRuntime` 的 `onEvent` 回调里维护 `Map<string, TurnAccumulator>`，键为 `"${instanceId}\0${sessionAlias}"`：

```ts
interface TurnAccumulator { text: string; steps: Map<string, ToolStepDto>; reasoning: string }
```

事件处理逻辑：

- `turn-started` → 清零/新建该键的 accumulator。
- `turn-output` → `a.text += chunk`。
- `tool-event` → 按 `toolCallId` upsert `a.steps`（受 `MAX_TOOL_STEPS = 200` 封顶）。
- `turn-thought` → `a.reasoning = (a.reasoning + chunk).slice(0, 16000)`。
- `turn-finished` → flush：`messages.append(instanceId, sessionAlias, "out", a.text, structured)`，
  其中 `structured = { toolSteps, reasoning? }`（仅当有步骤或 reasoning 时携带）；之后删除 accumulator。
- 实例离线（`onStatusChange online=false`）→ 按前缀批量删除对应实例的所有 accumulator，防内存泄漏。

所有事件先经 `webGateway.broadcast` 实时广播给 Web 客户端，再处理累积逻辑（广播与持久化并行，互不阻塞）。

### 数据库 `messages.structured` 列（packages/relay/src/db.ts）

`messages` 表含 `structured TEXT` 列（存 JSON 序列化的 `{ toolSteps, reasoning? }`），直接由建表 DDL 定义。

- `MessageStore.append(instanceId, alias, dir, text, structured?)` 序列化写入；`listBySession` 反序列化后在 `MessageRecordDto.structured` 中返回。

## 测试

- 单测按文件跑（tests/unit/packages/relay、tests/unit/packages/channel-relay）；
  run-tests.mjs 会预构建 relay-protocol dist。
- 全链路：`tests/unit/packages/relay/web-dashboard-e2e.test.ts` 用真实 relay-server
  （`startRelayServer`）+ 真实连接器（RelayClient/createControlBridge/subscribeControlEvents）
  验证 实例事件 → relay → web 客户端 + 历史缓存的端到端路径。
- 端到端手工验证 runbook：
  1. `bun run build:packages`
  2. `node packages/relay/dist/cli.js user new --account admin --db /tmp/relay.db`（记下打印的登录令牌）
  3. `node packages/relay/dist/cli.js start --db /tmp/relay.db`
  4. `node packages/relay/dist/cli.js pair --account admin --db /tmp/relay.db`（记下配对令牌）
  5. 另一终端：dry-run 或真实 xacpx 安装 channel-relay、channel add、restart，
     然后 curl `POST /api/login` 用登录令牌换 cookie + `POST /api/instances/<id>/rpc {"type":"control.sessions.list"}` 验证。
