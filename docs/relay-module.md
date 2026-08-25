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
  - `control.fs.browse {path?}`：config-global、目录-only 的实例文件系统浏览（供 Web
    目录选择器选新 workspace cwd）；空/`~` 为 home，相对路径按 home 解析；只返回目录
    名+绝对路径，响应上限 1000 条（`truncated` 标记；约束响应大小，服务端为读取整目录后排序截断），
    不返回文件/内容/元数据。不经 WorkspaceFs 的 workspace 白名单（选择尚未注册的目录是其目的），
    仍受 hub 账号-持有实例门约束。
  - 四者经 control-bridge 映射到 ControlService（catalog/create/remove），in-use 校验在 ControlService 内。
- `control.sessions.create` 走**完整 transport 生命周期**（resolve→reserve→ensure→check→attach→refresh，
  经 `CommandRouter.createSessionWithTransport`）：解析 agent/workspace → 预留别名 → 在后端建/确认 acpx 命名会话
  → 校验 → 绑定逻辑会话 → best-effort 刷新 agent command。看板新建的会话因此**立即可 prompt**（旧实现只建逻辑会话，
  prompt 会以 `No named session` 失败）。
- 阶段边界：离线不排队（实例离线时 RPC 返回 503）；~~事件断线期间丢弃~~ 断线期间的回合事件由
  连接器侧镜像暂存并随 `instance.state.sync` 恢复（见阶段七）；无镜像的旧 connector 断线期间事件仍丢弃。
  Web 看板（阶段三）消费本阶段的 HTTP API 与事件。

## RMUX 终端后端（channel-relay，默认关闭）

权威设计见 `docs/superpowers/specs/2026-08-10-relay-web-rmux-terminal-design.md`。实现落点：

- **配置**：`channels[].options.terminal`（见 `docs/config-reference.md`）；默认 `enabled=false`，不声明
  `terminal.rmux.recovery.v1` / `terminal.multi-view.v1`。
- **运行时**：`packages/channel-relay/src/terminal/`（registry、runtime、reconciler、process-owned sidecar）。
  每个原生 sidecar 通过 `rmux-ipc::endpoint_for_label` 使用独立的进程级 RMUX endpoint
  （`xacpx-relay-<pid>-<启动nonce>`），绝不连接用户级默认 RMUX socket。这样插件/npm 升级即使留下仍映射
  旧 `.old-*` 安装目录的 daemon，新 sidecar 也不会复用它；hard crash 后的新 sidecar 同样换 endpoint，
  旧 endpoint 上的 session 由 `KillOnOwnerExit` lease 回收，符合 no-adopt 边界。bridge handshake/diagnostics
  不启动 daemon，首次 create 才 lazy `connect_or_start`；clean shutdown 显式 `Rmux::shutdown()`。sidecar
  强制私有 daemon 使用空 RMUX 配置：Unix 由 bridge daemon-launcher 把 SDK 的 `--config-default` 改写为
  `--config-file /dev/null` 后 exec 真正 daemon（不改 bridge 的 `HOME` / `XDG_CONFIG_HOME`，shell 环境保持原样）；
  Windows 使用 RMUX 0.10 实际支持的 child-only `RMUX_CONFIG_FILE=NUL`。因此私有 daemon 的
  `exit-empty=on` 不会被用户配置关闭，hard crash 在 lease 清空 session 后也能回收 daemon。显式 kill
  最后一个登记 session 时 bridge 会先对仍存活的 daemon 显式 shutdown，再进入 `Empty`，避免 Windows
  下一次 create 加入一个正在异步退出的 managed endpoint generation；list 仍不启动 daemon，下一次
  create 会先从原始 label 重新解析 endpoint 再 `connect_or_start`（Windows managed label 在 daemon
  shutdown 后会轮换到新的具体 pipe generation，不能复用旧 pipe）。
  同一 pane 的 `recover` / `stop-recover` 在 `RmuxSidecarDriver` 里按 FIFO 串行，避免旧 attachment 的 teardown 杀掉新 attachment 的 recovery。最后一个 subscriber 离开后排入的 `stop-recover` **必须执行**，即使 replacement 已经 join；replacement 在旧 stream 停掉、新 recover ack 之前保持 unarmed，因此 first event 只能是 fresh rebase。pane start barrier 让同时 attach 的 viewer 共享同一次 `recover` RPC（成功则一起 catch-up，失败则一起收到错误，不会有人永久 waiting）。显式 `recover` 在 Rust 侧**总是 restart** recovery task，并且 **RPC 成功 = 已经拿到 initial Rebase**（不是仅仅 spawn 了 task；首包 `None`/`Err`/非 rebase 会让 RPC 失败）。sidecar 在把 initial Rebase 写入 stdout 队列之后才 spawn 后续 Bytes reader；`pane_by_id` / `recover_output` / 首个 Rebase 共用 10s 截止。stdin 循环里**只有 Recover** 异步 dispatch（Create/List/Kill/Input 仍串行，避免 reconciler 看到半创建 session）。一个坏 pane 的 `recover_output` 仍可能占住全局 sessions mutex 最多约 10s（后续可拆 per-session lock）。Node 只在 start barrier 发送 `recover`；已 live 的 late viewer 只 fan-out。catch-up cache 超预算时的 snapshot refresh 同样进入 stopping barrier，并复用同一 start barrier；Node 的 stop-recover 超时不会取消 native RPC，也不解除 stopping，要等下一次 recover ACK（或 crash）才清；replacement recover 失败会 close 该 pane 全部 subscriber。initial Rebase 之后底层 stream 的 `Err`/`None` 发 `recovery-stream-failed` / `recovery-stream-ended`；`PaneRecoveryEvent::End` 发 `exit` 后 reader 立即结束，不会把随后的 EOF 再包装成 transport failure。普通 subscriber/iterator 错误发 `terminal-recovery-failed` 并**保留** RMUX shell。`RmuxDriverCrashedError` / sidecar process 退出走 owner-loss，按进程退出 reap。
- **持久化**：`<xacpx-home>/relay/` 下 `terminal-owner.json` + `terminals.json`（与 `credential.json` 同目录惯例）；
  文件 mode `0600`。owner identity 在 cleanup-pending / kill 超时后仍保留，供后续 reconcile / lease TTL 回收。
- **停止语义**：`shutdown` → 进程内 durable reaping 后再 kill（无跨进程 adopt）；`disabled` / `removed` / `logout` → 同样 durable reaping 后再 kill；
  hub disconnect → 只 `detachAllAttachments`。CLI `channel disable|rm` 在 daemon **已停止**时走 one-shot retirement；daemon 仍在跑时推迟到重启，由旧进程 `stop()` 杀会话，避免再起一个看不到 HashMap 的 sidecar。`terminals.lock` 保证 registry 同一时刻只有一个 writer。
- **二进制解析**：`resolveRmuxBinaries`（`src/terminal/resolve-rmux-binaries.ts`）。bridge：explicit
  `terminal.bridgeCommand` → platform optional package → PATH。RMUX：explicit `terminal.rmuxCommand` → **bridge 同目录的
  bundled RMUX**（platform package 自包含 `bin/rmux[.exe]` + `libexec/rmux/rmux[.exe]`，版本 `RMUX_VERSION=0.10.0` 与
  bridge `rmux-sdk` pin 一致，source=`platform-package`）→ legacy managed helper `~/.local/libexec/rmux`
  （source=`managed-helper`）→ PATH `rmux-daemon`/`rmux`（source=`path`）。机器本地 stale RMUX（PATH WinGet 0.9.0、
  `~/.local/libexec/rmux` 旧版）永远不会盖过 bundled 0.10.0。pack 脚本（`scripts/pack-rmux-bridge-platform.mjs` +
  `scripts/rmux-release.mjs` 固定 URL/SHA-256）按原生 host 执行 `rmux -V` 校验，`verify-publish.mjs` 交叉核对
  TS 常量 / Cargo.toml / manifest 三处 pin 与 checksums 字节。发布链路 **test what you publish**：native build
  job 在 chmod 正确时直接 `npm pack` 出最终 tgz（artifact zip 会丢 POSIX exec bit，tgz 不丢），smoke 安装并测试
  **同一份 tgz**（断言 `test -x bin/rmux` / `libexec/rmux/rmux` + 真实 hostile lifecycle），`npm publish` 也发布
  同一份 tgz。平台包随附 redistributed-RMUX notice（`THIRD_PARTY_NOTICES.md` + `THIRD_PARTY_LICENSES/RMUX-LICENSE-MIT.txt`，
  MIT 分发要求保留上游 copyright/permission notice），build-platform 与 `verify-publish.mjs` 都强制检查。
  macOS release 全部在原生 runner（`macos-15` arm64 / `macos-15-intel` x64）上构建，pack 脚本的 `rmux -V`
  实跑门禁不依赖 Rosetta。
- **Doctor**：`ChannelCliProvider.diagnose` → `diagnoseRelayTerminal`（只读）；core 的 Plugins 检查只呈现结构化 finding，
  不理解 RMUX。terminal disabled → skip；cleanup-pending / 未打包 sidecar → warn；缺失 `bridgeCommand` 路径 → fail；
  bridge 找到但 RMUX daemon 未解析 → `terminal-rmux-daemon-unresolved` warn；解析出的 RMUX 版本 ≠ 0.10.0 →
  `terminal-binaries-resolved-mismatch` warn（含 source、expected/actualVersion，例如 WinGet PATH 0.9.0 场景）。
- **日志**：`relay.terminal.*` 事件（spec §19）；只记 ID / sizes / counts / error class，不记 bytes / credential / cwd。
  Sidecar 启动失败会把 stderr 尾部附在 `relay.terminal_bootstrap_failed`（例如 `rmux driver has crashed: xacpx-rmux-bridge fatal: …`），
  并附 redacted bridge/rmux path + source + expected RMUX 版本。
- **Windows**：`@ganglion/xacpx-rmux-bridge-win32-x64` 自带 `xacpx-rmux-bridge.exe` + `rmux.exe`（+ `libexec/rmux/rmux.exe`
  helper），完全离线可装、无需 PATH 上有任何 RMUX。发布包：https://github.com/Helvesec/rmux/releases
  （`rmux-0.10.0-windows-x86_64.zip`，固定 SHA-256 在 `scripts/rmux-release.mjs`）。

## Web Push（task-completion 桌面通知）

- 用途：实例产生 `notice.kind === "task-completion"` 时，向该账号已订阅的浏览器推系统通知（标签页在后台或已关闭也能收到）；`task-progress` / `coordinator-message` 仅走 WS 广播。设计 spec：docs/superpowers/specs/2026-08-24-web-push-task-completion-design.md。
- 配置：`xacpx-relay push-keys generate` 打印 VAPID 密钥对；经环境变量 `XACPX_RELAY_VAPID_SUBJECT` / `XACPX_RELAY_VAPID_PUBLIC_KEY` / `XACPX_RELAY_VAPID_PRIVATE_KEY` 或 start 子命令 `--vapid-subject/--vapid-public-key/--vapid-private-key` 注入。未配置则推送禁用（log warn），WS 通道不受影响。
- 存储：`push_subscriptions` 表（account_id + endpoint 主键，endpoint 全局唯一索引）。API：`GET /api/web-push/vapid-public-key`、`PUT/DELETE /api/web-push/subscriptions`（authed + requireJson）。
- 发送：server.ts 的 instanceNotice 分支 fire-and-forget fan-out；payload `{title=实例名, body=text 截断200, instanceId, url:"/"}`，TTL 3600；410/404 自动删订阅行。
- Web 端：SettingsView「桌面通知」开关（五态状态机）；订阅所有权 reconcile 属于认证生命周期——login/fetchMe await fail-closed 转移，logout 先解绑再清 session。SW 推送处理器为 public/push-sw.js，经 pwa-options 的 workbox.importScripts 注入。

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
- **`GET /api/instances/:id/sessions/:alias/messages`**：按登录账号返回该会话的缓存历史。默认返回完整 `structured`（旧看板兼容）。新看板带 `view=compact`：去掉 `parts` 已覆盖的重复 `toolSteps`，并剥掉折叠卡片用不到的工具正文（diff / 命令输出 / 文件预览），只留标题、状态和短 snippet；展开时再 `GET .../messages/:messageId` 拉该行全文。
- **`GET /api/instances/:id/sessions/:alias/messages/:messageId`**：同一所有权校验下返回单条完整历史（含未压缩的 `structured`），供 compact 列表在用户展开工具卡时补全。
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

- **web 事件深度校验**：`parseWebServerEvent` 现在深度校验内层 `ControlEventDto` 的判别式/各变体字段。`parseCanonicalBase64` 是 runtime-neutral 的（浏览器 `atob`/`btoa`，Node/Bun 可回退 `Buffer`），避免浏览器 bundle 因缺少 `Buffer` 静默丢掉 `terminal-rebase-chunk` / `terminal-bytes`。
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

- `MessageStore.append(instanceId, alias, dir, text, structured?)` 序列化写入；`listBySession` 反序列化后在 `MessageRecordDto.structured` 中返回完整行。HTTP 列表在 `view=compact` 时由 `compactHistoryMessage` 投影后再发给看板；`getById` 仍返回未经投影的原文。

## 阶段七：Hub 重启状态恢复（instance.state.sync + turn-finished.text）

设计 spec：docs/superpowers/specs/2026-08-03-relay-hub-restart-state-recovery-spec.md。

协议（packages/relay-protocol）：

- `turn-finished` 事件变体增加可选 `text?: string`（daemon 侧把最终回复文本随车带过来）与 `recoveryId?: string`
  （connector 给每个回合生成的稳定恢复 id，live 转发与离线 FIFO 共用同一 id）。
- 新消息类型 `MSG.instanceStateSync = "instance.state.sync"`，载荷为 `InstanceStateSyncPayload`
  `{ turns, usage, commands, finishedOffline }`（见 src/messages.ts）：连接器在每次（重）连
  完成鉴权后立即推送一份内存镜像快照给 hub。纯增量协议：旧 hub 忽略未知消息类型，
  旧 connector 不发送则回退到原行为。`finishedOffline` 每项携带 `recoveryId` 与 `truncated`。
- 新消息类型 `MSG.instanceRecoveryAck = "instance.recovery.ack"`（hub → connector，载荷 `{ recoveryIds }`）：
  hub 只在**数据库提交之后**（消息行 + receipt 同一事务）ack 对应的 recoveryId。
- 三个回合内容上限（`STATE_SYNC_TEXT_CAP = 256KiB` / `MAX_TOOL_STEPS = 200` /
  `REASONING_CAP = 16000`）集中在 `relay-protocol/src/limits.ts`，hub 与 connector 镜像共同 import。

连接器（packages/channel-relay/src/state-mirror.ts）：

- `createStateMirror` 订阅与转发完全相同的 ControlEvent 流，镜像每个 (sessionAlias) 的在途回合
  累积器、最后已知的 usage/commands，以及**已完成但尚未被 hub ack** 的回合 FIFO（内部名
  `pendingFinished`，上限 32，逐出最旧并 log warning）。每个回合在 `turn-started` 时生成一个
  稳定 `recoveryId`。注意 FIFO 里同时有断线期间完成的回合和**刚结束、正在等持久化 ack 的 live
  回合**——live 转发照常发生，条目只是等 ack 才删除。
- `RelayChannel.start()` 接线了 `RelayClient` 的 `onReady`：`mirror.buildStateSync(liveAliases)` 返回
  `{ snapshot, aliases }`（snapshot 是**纯拷贝**，只过滤不在 liveAliases 里的别名，不改动 mirror；
  aliases 是构建时各 alias 的**代际 generation**）。破坏性 GC 是单独的
  `pruneStateMirror(liveAliases, aliasesAtBuild)`，只在**确认 flush 成功之后**调用，且只对
  generation **未变化** 且不在 liveAliases 里的 alias 做 compare-and-delete——snapshot 之后新到达的
  session/turn（正被 live 转发）或**同 alias 换代**（新 turn / 新 pending 条目）都会被代际保护，
  绝不会被这个旧回调误删；send 失败/not-ready 时也绝不 prune。
- FIFO 条目**不做 flush 回调确认**：ws flush 只证明帧离开本地进程，不代表 hub 已持久化；条目
  只在收到 hub 的 `instance.recovery.ack`（对应 recoveryId）后由 `mirror.confirmFinished()` 清除。
  live `turn-finished` 转发同样打上 recoveryId，清 FIFO 同样等 ACK —— hub 在 send 之后、SQLite
  提交之前崩溃，则下次重连重发同一快照，hub 端 receipt 去重保证幂等，不会留下历史空洞。
- **过期语义与 hub 一致**：`mirror.expirePendingFinished()` 在每次 onReady 构建快照前（以及每次
  推入新条目时）丢弃超过 `RECOVERY_RETENTION_MS`（7 天，relay-protocol/limits.ts 共享常量）的
  条目。hub 的 receipt 按同一保留期 + 时钟偏移宽限清理，所以过期条目永远不会被重发成重复历史；
  反过来，connector 不再保留超过该窗口的条目，receipt 也不存在"重发时已过期"的窗口。

服务端（packages/relay/src/server.ts）：

- `turn-finished` 兜底：无缓冲时，只要 `event.text` **存在**（空字符串也算有内容）就落一条
  `out` 行；失败回合（`ok: false`）且无 `event.text` 时改落 `errorMessage` 行；两者都缺才
  log `warn`（`relay.event.turn_finished_without_content`）。有缓冲时同样：失败回合若无流式
  输出，落 `errorMessage` 而非留一个"有问无答"的空洞；**成功但回复为空**（`ok: true` 且
  `text: ""`）也落一条空 `out` 行（presence 语义，与无缓冲/离线路径一致——此时 receipt 已提交、
  connector 已删除条目，跳过的行永远无法补录）。
- 带 `recoveryId` 的 live `turn-finished`：回复行与 receipt 在**同一个 SQLite 事务**里提交，
  提交成功后才下发 `instance.recovery.ack`；事务失败则 `gateway.disconnect(instanceId)` 强制
  connector 重连（重连后 onReady 重新推送 state sync，pending 条目获得重试机会），再抛错记日志
  ——持久化失败绝不静默，否则条目会一直躺在 connector FIFO 里直到被逐出。`disconnect()` 会
  **原子撤销**连接（先移出 connections、拒绝在途请求、触发 offline 切换，再请求关闭 socket），
  关闭握手完成前该 socket 上迟到的 event/sync 一律被 ownership fencing 丢弃——不会出现
  "failed 后旧 socket 仍提交 out row 并 ACK、绕过重试" 的窗口；superseded 旧 socket 的迟到
  sync 同样被拒，不会覆盖新连接的恢复状态。
- **gateway 认证边界**：RPC response 必须来自**发出该请求的同一实例 + 同一 socket** 且回显
  请求 type（`PendingRequest` 绑定 socket/type）——请求 id 是顺序可猜的，跨实例伪造 response
  会污染别的实例的 queue correlation / 删除历史 / 写入伪造行，多账号 Hub 上是跨租户边界。
  socket 被 supersede 时，旧 socket 的 pending RPC **立即拒绝**（`instance-reconnected`），
  HTTP 调用不必等满 120s 超时。Web 终端 RPC（open / take-control / resync / terminate）
  在收到 `instance-reconnected` 后**向新 socket 重试一次**，不再把该错误映射成
  `instance-offline`（实例此时已经在线）。看板自己的 `/ws` 断开使用 `events-offline`，
  也不再显示「实例已离线」。
- `instance.state.sync` 处理：防御性形状校验（`validInstanceStateSync`，malformed 整体丢弃）；
  **整个 reconciliation 包在专用 try/catch 里**——任何数据库失败（不只是 finished 事务，也包括
  active turn 的 prompt backfill、recency 读取等）都会 `gateway.disconnect(instanceId)` 强制重连重发，
  且**先完成数据库对账、再替换内存状态**，失败不会留下半更新状态。**先处理 `finishedOffline`
  再恢复运行中回合**，保证历史顺序。`finishedOffline` 逐项在单个事务里落库（`in` 行对账 + `out`
  行 + receipt，同一事务，崩溃不会留下半组行）。幂等去重：携带 `recoveryId` 的项查
  `recovery_receipts` 表（跨重启存活；已 receipt 的重复项**直接 re-ack 不重复落行**）；无
  `recoveryId` 的旧式项退回进程内指纹集 + SQLite 最近 5 行 prompt+reply **成对匹配**。
- **同 alias 的已完成回合与运行中回合是不同 turn**（turn A 完成后队列又启动同 session 的 turn B）：
  用 `recoveryId` 区分，不再按 `sessionAlias` 跳过；只有 recoveryId 完全相同（真矛盾）才跳过。
- **`in` 行统一对账 `reconcileInboundPrompt`**（**live `turn-started` 与 state-sync 共用同一函数**，
  避免两套逻辑漂移）：**优先按已建立的 queue association 判定**（`queuedState()` 四态——
  `pending` → `promoteQueued()` 移到执行位置且**消费 `prompt_request_id`** / `fallback` →
  `finalizeQueuedFallback()` / `executed` → 直接返回 / `absent` 才尝试 pre-write correlation），
  只有 `absent` 时才按 `promptRequestId` 找预写行（`findByPromptRequest`，**限定
  instance+session**，跨会话错配的 buggy 包不会污染别的会话）并 `promoteQueuedRow()`；`absent`
  且无 correlation 时 `appendExecutedQueuedFallback()`（sync）或 `appendQueuedFallback()`（live，
  等待 RPC 合并）。Hub 在 web prompt **预写** inbound row 时生成 `promptRequestId` 并存入
  `messages.prompt_request_id`、随 `PromptPayload` 下发，connector 的 queue item 与
  `turn-started` 携带它；**正常 promote 后该字段即被清除**，后续 sync 不会按它重复提升同一行。
  live `turn-started` 的 DB 对账失败会 `gateway.disconnect()` 强制重连重试，且失败时**不安装**
  流式 buffer。无 `queueItemId` 时，**scheduled turn 按 `structured.scheduled.taskId` 去重**，
  普通 prompt 才用最后一行检查。`appendQueuedFallback`/`appendExecutedQueuedFallback` 均为
  **单条 INSERT**（原子），`markQueued` 整体在一个事务里。
- **daemon 侧 `turn-finished.text` 为完整累计回复**：`SessionTurnRunner` 累计实际发送的规范化
  chunk（streaming adapter 常让 `response.text` 缺失或只有末段），hub 无缓冲 fallback 不再依赖
  不可靠的 `response.text`。
- 失败回合（`ok: false`）落库时优先 `errorMessage`：`text` 为空/缺失时不会用空字符串覆盖错误
  信息（connector 的累积器以 `""` 起步，旧版镜像可能把 `text: ""` 和 errorMessage 一起带过来）。
- `truncated` 闭环：`finishedOffline.truncated` 为真时，`out` 行的 `structured` 里写入
  `{ truncated: true }`；**运行中回合**恢复时也会把 `turn.truncated` 带到 TurnAccumulator，
  该回合结束时 live flush 同样写入 `structured.truncated`——被 256KiB 上限截断的前缀不会
  被当作完整回复落库。Web 端 `MessageList.vue` 对有 `structured.truncated` 的回复显示
  "回复已截断" 徽标。
- 新增 `recovery_receipts` 表（`instance_id + recovery_id` 主键，`created_at`）与
  `RecoveryReceiptStore`；维护循环按 `RECOVERY_RECEIPT_TTL_MS`（= 共享保留期
  `RECOVERY_RETENTION_MS` 7 天 + 24h 时钟偏移宽限）定期清理。安全性依赖两侧一致：
  connector 在同一保留期后丢弃 `pendingFinished` 条目（不再重发），所以 receipt 到期时
  必然不会再被查询——清理不会重新引入重复历史，表也不会随每个回合无限增长。

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
