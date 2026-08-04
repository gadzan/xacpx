# Relay Hub 模块说明（packages/relay + packages/channel-relay）

自托管多实例遥控枢纽。设计 spec：docs/superpowers/specs/2026-06-13-relay-hub-design.md。

## 服务端（@ganglion/xacpx-relay）

- 运行时：Node >= 22.13（node:sqlite）或 Bun >= 1.2（bun:sqlite），SqlDriver 适配层自动选择。
- 端口（默认单端口）：HTTP API（默认 8787，登录/实例/RPC 代理）。实例 WS 网关**默认合并到 HTTP 端口**——作为 `httpServer.on("upgrade")` 上的 noServer WebSocket upgrade，按路径路由：根 `/`（或显式 `/gateway`）= 实例网关，`/ws` = 看板扇出（两者共用同一 upgrade handler）。`--ws-port <n>` 为**可选** flag：传入则改在独立端口上跑一个专用 `WebSocketServer`（旧的双端口布局，便于单独防火墙网关）。
- 快速开始：
  1. `xacpx-relay add token`（打印访问令牌，既用于 Web 登录也用于连接器注册；DB 默认 `~/.xacpx-relay/relay.db`，自动建目录）
  2. `xacpx-relay start`（看板自动检测内置 `packages/relay-web/dist`）
  3. `xacpx channel add relay --url <host> --token <access-token> --name home-pc`（连接器接入；`--url` 支持裸域名/IP[:端口]）
- RPC 请求超时：`xacpx-relay start --request-timeout-ms <ms>` 限定网关 RPC 请求超时，默认 `120000`
  （共享常量 `DEFAULT_REQUEST_TIMEOUT_MS = 120s`，位于 packages/relay/src/gateway/instance-gateway.ts，
  网关回退与服务端均复用之）；agent 冷启动慢 / 长 prompt 时可调大。Hub 会把均已扣除 15 秒
  响应余量的绝对 work deadline 与相对 work budget 附在下行 request envelope 上，使
  connector/core 在串行队列出闸时拒绝已来不及安全完成的状态变更；两字段任一缺失即 fail closed。
- 会话级模型与推理强度分别通过 `control.session.model.get/set` 和
  `control.session.effort.get/set` 暴露。Hub 会为这些 RPC 覆写可信的 `chatKey`；effort 的配置 id
  与可选值由实例侧 adapter 广告，实例 transport 会拒绝未广告值，Hub/Web 不硬编码上游实现细节。
- 安全：登录令牌（login token）以 sha256 哈希落盘（高熵随机令牌，无需 scrypt；scrypt 密码哈希已随密码登录一并移除）；所有 token/凭证哈希存储；登录限流按客户端 IP + 全局失败上限（有界，见阶段五）；
  凭证比较定时安全（`hashEquals`，见 src/auth.ts）；RPC 代理只放行
  control.* 且服务端覆写 chatKey(`relay:<accountId>`)/senderId/isOwner。
- 账号模型：无密码、无角色；凭证为 CLI 铸造的登录令牌（`login_tokens` 表）。CLI 以令牌为中心：`add token` 建一个用户+令牌、`ls` 列出、`rm token <值或短id>` 删除该令牌背后的用户并级联删除其实例/会话/消息（底层 store 仍支持每账号多令牌）。
- 邀请码：`add invite [--label] [--ttl <n>{m|h|d}，默认 7d] [--url <base>]` 铸造一次性邀请码（`invite_codes` 表，sha256 哈希落盘，明文只打印一次），生成 `/invite/<code>` 链接。受邀者打开页面**点击兑换**（绝不 on-mount 自动兑换，防链接预览烧码）调用 `POST /api/invites/redeem`（免登录，注册在鉴权网关之前；与 `/api/login` 共用限流桶；统一 401 `invalid-code` 不区分不存在/已用/过期），事务内创建新账号 + login token 并返回 `{token, username}`（不设 cookie，页面展示一次并提供"用此 token 登录"按钮）。`ls` 追加 invites 段（unused|used|expired），`rm invite <码或短id>` 删除，已用/过期由每小时 GC 清理（`pruneInviteCodes`）。
- CSRF backstop：`/api/login`、RPC 以及 `POST /api/instances/pairing-token`
  统一要求 `content-type: application/json`（`requireJson`），否则返回 415。
  `/api/register` 与 `/api/invites` 已移除（显式返回 404，注意与新的 `/api/invites/redeem` 是不同路径）；`/api/*` 鉴权网关仅豁免 `/api/login`。

## 连接器（@ganglion/xacpx-channel-relay）

- 安装与配对：
  ```
  xacpx plugin add @ganglion/xacpx-channel-relay
  xacpx channel add relay --url <host> --token <access-token>   # --url 与看板同主机；裸域名(wss 根路径=合并网关)/IP[:端口](ws,默认 8787)
  xacpx restart
  ```
- 首连用访问令牌（或传统一次性配对令牌）注册并换发长期凭证，存 `<xacpx-home>/relay/credential.json`
  （weixin 凭证先例；config.json 只存 url/pairingToken）。访问令牌可复用；
  传统配对令牌单次有效，过期/已用需在 relay 侧重新生成并 `xacpx channel add relay` 更新。
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
- 阶段边界：离线不排队（实例离线时 RPC 返回 503）；~~事件断线期间丢弃~~ 断线期间的回合事件由
  连接器侧镜像暂存并随 `instance.state.sync` 恢复（见阶段七）；无镜像的旧 connector 断线期间事件仍丢弃。
  Web 看板（阶段三）消费本阶段的 HTTP API 与事件。

## 阶段三服务端接缝（Web 看板扇出）

服务端为 Web 看板新增的接缝（见 docs/relay-web-module.md）：

- **`messages` 缓存表（§5）+ `MessageStore`**：聊天回显缓存
  （`instance_id, session_alias, direction, text, created_at`）。`append()` 写入，
  `listBySession(accountId, ...)` 按 account 隔离、oldest-first 取最近若干条。
- **`WebGateway` 按账号扇出，并按 socket 的实例订阅过滤 `control-event`**：跟踪每个账号
  已鉴权的浏览器 socket，把 `WebServerEvent` 编码为 `web.event` 信封
  `broadcast(accountId, event)`。**订阅路由**（`subscribe` 帧 → `setSubscription`）：
  - `control-event` 只发给订阅了该 `event.instanceId` 的 socket。**未在订阅表里的 socket
    （刚注册、或从不发 `subscribe` 的旧客户端）= 订阅“全部”**（向后兼容）；显式 `subscribe []`
    = 订阅“无”，一条 `control-event` 都收不到。
  - `instance-status` / `notice` **不受订阅过滤，始终按账号全量广播**（看板需要感知任意实例
    的上下线与通知，与当前查看的是哪个实例无关）。
- **实例网关 `onStatusChange`/`onEvent` 接线**（server.ts `createRelayRuntime`）：
  - `onStatusChange` → web 广播 `instance-status`（账号全量）；离线时清空该实例的 turn 缓冲。
  - `onEvent`（instance.event）→ web 广播 `control-event`（按上面的实例订阅过滤）；其中
    `turn-output` 分片按 (instance, session) 累积进内存缓冲，`turn-finished` 时 flush 为一条
    `out` 历史消息写入 `MessageStore`；instance.notice → 广播 `notice`（账号全量）。
- **cookie 鉴权的 `/ws` web 扇出端点**：挂在 HTTP server 的 upgrade 上，按路径与实例网关分流
  （默认单端口时实例网关合并在同一 upgrade handler 的根 `/`；传 `--ws-port` 时网关另起专用端口），
  校验 `xrelay_session` cookie → 账号后 `webGateway.register(accountId, ws)`。
- **`GET /api/instances/:id/sessions/:alias/messages`**：按登录账号返回该会话的缓存历史。
- **真实删除同步清历史**：`control.sessions.remove` 经 connector 成功确认后，Hub 删除对应
  `(instance_id, session_alias)` 的缓存消息；归档不删除，因此恢复归档会话仍能看到历史。
- **prompt 回显历史**：`control.prompt` 经 RPC 代理时，把 prompt 文本 append 为一条 `in` 历史消息；
  若返回 `queued + queueItemId`，Hub 在对应出队 `turn-started` 到达时把同一行移动到真实执行点，
  因而刷新后的历史仍按“上一轮回复 → 出队 prompt”排列。
- **command 回显历史（阶段四）**：`control.command.execute` 经 RPC 代理时，把输入文本 append 为 `in`、
  把返回 `output` append 为 `out`（与 `control.prompt` 的 `in` 回显并列），使 `/命令` 结果也能跨 reload 存活。
- **`--web-root` 静态托管**：`createRelayRuntime({ webRoot })` → Hono `serveStatic` 托管 SPA
  构建产物（含 index.html SPA fallback）；CLI `xacpx-relay start --web-root <dir>`。

## 阶段四服务端接缝（维护循环与配置）

- **`GET /api/config`（authed）**：返回 `{ historyRetention: { days, maxPerSession } }` 供设置页展示；
  历史保留是服务端配置（只读），v1 不在 Web 端可改。
- **`GET /api/version`（authed）**：返回 `{ current, latest, updateAvailable }` 供设置页展示 hub 版本与「有可用更新」提示。`current` 读自 hub 自身的 `package.json`（`readRelayVersion`）；`latest` 经 `npm view @ganglion/xacpx-relay version` 查询，结果缓存 ~1h 且失败/超时容错（失败时返回 `latest:null`、`updateAvailable:false`，绝不阻塞设置页）。版本读取、npm 查询、语义化比较与缓存检查器集中在 `packages/relay/src/version.ts`，由本端点与 `xacpx-relay update` CLI 共用。
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

叙事相关事件保持 transport 的 ACP 到达顺序。每个工具事件或推理事件前的文本会先作为
`turn-output` 发出；transport 还会把 agent 的 messageId 边界编码为空行。这样 Web
可在同一 messageId 内维持完整 Markdown 块，并把活动放在不同文本块之间。缺少
messageId 时的句末判断使用 Unicode 句子终止属性，不绑定中文或英文字符表。
同一 toolCallId 的状态更新只更新原活动项，不新建活动位置或段落边界。

### 连接器规整（packages/channel-relay/src/tool-presentation.ts）

`toolUseEventToStepDto(event: ToolUseEvent): ToolStepDto` 将核心层的原始 `ToolUseEvent` 规整为友好的、有上限的呈现 DTO：

- `TEXT_CAP = 8000` 字符（文本/命令输出/搜索结果/读取预览等通用字段上限）。
- `DIFF_CAP = 4000` 字符（diff oldText / newText 各自上限）。
- `REASONING_CAP = 16000` 字符（在服务端侧对 reasoning chunk 累积截断）。
- **工具步数上限 `MAX_TOOL_STEPS = 200`**（服务端 server.ts 中校验，超出步数的新步骤静默丢弃）。
- **hub 侧 `TOOL_DETAIL_CAP = 32K 字符`（UTF-16 code units）**（server.ts `capToolStep` / `capSeededStructured`，纵深防御）：
  递归截断 tool step 内所有超限字符串（title/error 以及 detail 的 diff、命令/搜索输出、read 预览、text、fields 等）。
  tool-event 在 **broadcast 之前** 截断，保证 live 视图与持久化历史一致；`session-history` 回填的 `structured` 同样过闸。
  规范的 connector 已经在上面 TEXT_CAP/DIFF_CAP 处截过，正常流量不受影响（字符串都在限内时原样返回，零拷贝）；
  这道闸拦的是绕过规整的非规范/旧版 connector，避免超大 detail 撑爆持久化 `structured` 列、历史分页 payload 和浏览器扇出。
- 按 `kind` 分派到具体 `ToolDetailDto` 变体（`diff / read / command / search / text / fields`），不向线路侧暴露任何原始 JSON。
- **子代理步骤（`event.isSubagent`）独立于 `kind` 规整**：`detail = { type: "text", text: <委派 prompt>, output?: <子代理流式/最终输出> }`。
  prompt 取自既有输入抽取链（`prompt / description / task / instructions / summary`），output 取自既有块/`rawOutput` 抽取链
  （`textFromBlocks ?? stdout ?? formatted_output ?? text ?? 标量 rawOutput`），二者均按 `TEXT_CAP` 截断。`output` 为可选字段，
  旧连接器省略、旧 Web 忽略即回退到仅展示 prompt（fail-open）。非子代理的 `think` 步骤保持原有 `text` 形态不变。

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

## 阶段七：Hub 重启状态恢复（instance.state.sync + turn-finished.text）

设计 spec：docs/superpowers/specs/2026-08-03-relay-hub-restart-state-recovery-spec.md。

协议（packages/relay-protocol）：

- `turn-finished` 事件变体增加可选 `text?: string`（daemon 侧把最终回复文本随车带过来）。
- 新消息类型 `MSG.instanceStateSync = "instance.state.sync"`，载荷为 `InstanceStateSyncPayload`
  `{ turns, usage, commands, finishedOffline }`（见 src/messages.ts）：连接器在每次（重）连
  完成鉴权后立即推送一份内存镜像快照给 hub。纯增量协议：旧 hub 忽略未知消息类型，
  旧 connector 不发送则回退到原行为。
- 三个回合内容上限（`STATE_SYNC_TEXT_CAP = 256KiB` / `MAX_TOOL_STEPS = 200` /
  `REASONING_CAP = 16000`）集中在 `relay-protocol/src/limits.ts`，hub 与 connector 镜像共同 import。

连接器（packages/channel-relay/src/state-mirror.ts）：

- `createStateMirror` 订阅与转发完全相同的 ControlEvent 流，镜像每个 (sessionAlias) 的在途回合
  累积器、最后已知的 usage/commands，以及断线期间完成的回合 FIFO（`finishedOffline`，上限 32，
  逐出最旧并 log warning）。
- `RelayChannel.start()` 接线了 `RelayClient` 的 `onReady`：取 `mirror.takeStateSync(liveAliases)`
  （"take" 有副作用——会**永久裁剪** liveAliases 之外的别名）发送 `instance.state.sync`；
  只在 ws flush 回调确认后才 `clearFinishedOffline()`，未确认则下次重连重发（hub 端去重兜底）。

服务端（packages/relay/src/server.ts）：

- `turn-finished` 兜底：无缓冲时，只要 `event.text` **存在**（空字符串也算有内容）就落一条
  `out` 行，否则不落行但 log `warn`（`relay.event.turn_finished_without_content`）。
- `instance.state.sync` 处理：防御性形状校验（`validInstanceStateSync`，malformed 整体丢弃）；
  对 `turnBuffers` / `sessionUsage` / `sessionCommands` 按实例 **replace**（回合保留原始
  `startedAt`，后续 `turn-output`/`turn-finished` 照常 append/flush）；`finishedOffline` 逐项落库
  （携带的 `prompt` 先行回填 `in` 行），两层幂等去重：进程内指纹集（同一 hub 进程的重发精确去重）
  + SQLite 最近 5 行 prompt+reply **成对匹配**（跨再一次重启的重发兜底；文本恰好相同的两个
  不同回合不会被误杀）。
- SQLite schema 不变（不加列）；web 端无需改动，经既有 `state-snapshot` 自愈。

## 测试

- 单测按文件跑（tests/unit/packages/relay、tests/unit/packages/channel-relay）；
  run-tests.mjs 会预构建 relay-protocol dist。
- 模拟 hub 重启：`tests/unit/packages/relay/runtime-restart.test.ts` 用两个 in-process runtime
  共享同一磁盘 SQLite 文件，验证跨重启的 history 行 + state 快照恢复与去重。
- 全链路：`tests/unit/packages/relay/web-dashboard-e2e.test.ts` 用真实 relay-server
  （`startRelayServer`）+ 真实连接器（RelayClient/createControlBridge/subscribeControlEvents）
  验证 实例事件 → relay → web 客户端 + 历史缓存的端到端路径。
- 端到端手工验证 runbook：
  1. `bun run build:packages`
  2. `node packages/relay/dist/cli.js add token --db /tmp/relay.db`（记下打印的访问令牌）
  3. `node packages/relay/dist/cli.js start --db /tmp/relay.db`
  4. 另一终端：dry-run 或真实 xacpx 安装 channel-relay、channel add（用上面的访问令牌）、restart，
     然后 curl `POST /api/login` 用同一访问令牌换 cookie + `POST /api/instances/<id>/rpc {"type":"control.sessions.list"}` 验证。
