# Relay Web · RMUX 持久终端设计

> 状态：设计定稿，待实施。
>
> 日期：2026-08-10。
>
> 读者：后续实现 agent、reviewer、发布负责人。本文是该项目的权威设计输入；除明确标注的“非目标”外，不需要回看本次讨论才能继续工作。
>
> 相关文档：
> - `docs/superpowers/specs/2026-06-30-relay-web-terminal-design.md`
> - `docs/superpowers/specs/2026-07-05-terminal-content-replay-design.md`
> - `docs/superpowers/specs/2026-07-12-track4-terminal-stream-hardening-design.md`
> - `docs/relay-module.md`
> - `docs/relay-web-module.md`
> - `docs/control-module.md`
> - `docs/config-reference.md`

## 1. 结论摘要

本设计把 relay-web 的终端从 xacpx 核心内存中的 `node-pty + ANSI ring buffer`，迁移为由实例侧 `channel-relay` 插件拥有的 RMUX 持久终端。

以下决策已经定稿，不是实施时的开放选项：

1. **RMUX 依赖、sidecar、终端 registry、租约、恢复和 GC 全部属于 `packages/channel-relay`。** xacpx 核心不得直接依赖 RMUX，也不得要求未安装 relay 插件的用户安装或启动 RMUX。
2. **核心只增加通用的逻辑会话资源 seam。** 它向插件提供不可变 `logicalSessionId`、权威 cwd、archive/delete/restore 生命周期通知；接口中不得出现 RMUX 或 relay-web 术语。
3. **一个未归档逻辑会话最多拥有一个 live terminal resource。** 同一账号在不同机器上打开同一个实例和逻辑会话时，attach 到同一个 RMUX session/pane。
4. **Tab 布局是浏览器本地状态，终端资源是实例侧共享状态。** 另一台机器不会被强制自动打开一个本地 Tab；但只要它打开该会话的终端，就看到同一画面和同一 shell。
5. **显式关闭终端 Tab 是全局 terminate。** 它立即使终端在所有设备上进入终态并关闭 RMUX session。页面刷新、浏览器关闭、切换会话、网络抖动只 detach，不 terminate。
6. **归档或删除逻辑会话立即 terminate 其终端。** 归档后恢复不会复活旧 shell；再次打开终端时创建新 shell。
7. **多设备采用单 controller、多 spectator。** 只有 controller 可以输入和 resize；其他 viewer 实时看同一画面，可以显式“接管控制”。不支持默认多写者输入交错。
8. **渲染使用 RMUX raw recovery stream。** 第一个事件必须是可重建终端状态的 ANSI rebase，后续使用 epoch/sequence 严格排序；不再把截断的原始 ANSI 历史当作快照。
9. **终端所有权采用 durable registry + RMUX daemon-side owner lease + 周期对账三重保障。** 即使浏览器、hub、connector、sidecar 或 xacpx 在任意写入点崩溃，也不能产生无限存活的孤儿终端。
10. **当前 `../rmux-typescript` 0.6.5 不能直接用于生产交互热路径。** 生产 adapter 必须是基于 RMUX 0.10 Rust SDK 的长驻 sidecar；禁止逐键 `spawn rmux`。
11. **旧核心终端先作为兼容实现保留，RMUX 通过 capability + 显式配置灰度。** 达到本文验收条件后，再删除 relay 对核心 `TerminalService` 的依赖和旧配置。

## 2. 背景与已核对事实

### 2.1 当前实现

当前终端的权威进程和回放缓冲位于核心：

- `src/control/terminal-service.ts` 使用 `node-pty`，把 session 放在进程内 `Map<terminalId, Session>`。
- 每个 session 保存最多 256 KiB 的原始 ANSI 字符串；溢出时按换行或字符裁掉最旧部分。
- `attach()` 返回 `{ buffer, lastSeq }`；`disposeAll()` 在 xacpx 关闭时杀掉全部 PTY。
- `ControlService` 暴露 `createTerminal/attachTerminal/writeTerminal/resizeTerminal/closeTerminal`。
- `packages/channel-relay/src/control-bridge.ts` 只是把 relay 消息转发到核心 `ControlService`。
- relay-web 把 terminal ID 存在 tab-scoped `sessionStorage` 的 `xacpx.terminal-ids.v1` 中。
- 显式关终端 Tab 时，`DashboardView.vue` 当前已经调用 `killSessionTerminal`；该产品语义继续保留。

### 2.2 当前故障根因

1. **网络重连没有终端重订阅。** 浏览器 `/ws` 重连后只重订阅 instance，没有重新 attach 打开的终端；断线期间输出永久丢失。
2. **raw history 不是 screen snapshot。** ANSI 是有状态协议，从任意行或字符裁剪后重放，不能保证 alternate screen、光标、滚动区域、模式和 rendition 正确，因此会叠屏或产生错误画面。
3. **浏览器 adapter 初始化有竞态。** `ghostty-web` 异步加载 WASM/font；adapter ready 前的 `write()` 当前会静默 no-op，attach replay 可能被丢弃。
4. **跨设备没有服务端身份。** terminal ID 只存在本机浏览器 `sessionStorage`，另一台机器不会发现或 attach 同一个终端。
5. **核心进程是终端 owner。** xacpx 关闭会执行 `disposeAll()`，因此 shell 生命周期无法独立于核心进程。

### 2.3 RMUX 0.10 能力

本设计基于本地 `../rmux` 的 0.10 代码，不基于旧版宣传材料：

- `Pane::recover_output()` 的第一个事件是完整 ANSI rebase。
- `PaneRecoveryRebase` 包含 epoch、generation、invalidation revision、next sequence、cols/rows、alternate、coverage、reason 和 keyframe bytes。
- resize、clear-history、parser expiry、consumer lag 和 process generation change 会产生新的 rebase。
- 后续 bytes 带精确 epoch/sequence，可检测漏包和错误代际。
- daemon 持有 shell、pane、screen 和 scrollback，普通客户端断开不会自动销毁 session。
- `EnsureSession` 支持 detached、cwd、initial size、structured process、environment 和 creation tags。
- RMUX 提供 daemon-side session lease；owner 停止续租后 daemon reaper 可以回收 session。
- `history-limit` 可以限制每个 pane 的 scrollback 行数。

### 2.4 当前 RMUX SDK 缺口

`../rmux-typescript` 当前版本为 0.6.5，主要通过 CLI/control-mode 包装 RMUX：

- `sendText()`、`resize()` 等会为调用启动进程，不适合逐键输入。
- 没有暴露 RMUX 0.10 recovery rebase/epoch/sequence。
- `snapshot()` 只是可见文本，不是可恢复的终端状态。

RMUX Rust SDK 0.10 已有 `CleanupPolicy::KillOnOwnerExit`，但当前 public interface 仍缺少本项目需要的两个动作：

1. 对一个通过 `EnsureSession` 创建或发现的现存 session **获取/接管 owner lease**；
2. owner 退出时**停止续租但不立即 kill、不 release lease**，让新进程在 TTL 内接管，否则由 daemon 到期回收。

本文第 15 节把这些缺口定义为阻塞前置工作。

## 3. 目标

### 3.1 用户体验目标

- 页面刷新、浏览器崩溃重载、短暂断网后，回到同一个 live shell，cwd、前台进程和画面保持一致。
- 不再出现 attach/reload 后的画面叠加、重复输出或漏输出。
- 同一 relay 账号在不同机器上打开相同实例和逻辑会话时，共享同一个终端资源。
- 明确区分本地视图 detach 和全局 terminate。
- 显式关闭终端 Tab 后，所有设备都立即看到终端退出。
- 用户归档或删除会话后，实例侧不会继续保留对应 shell。

### 3.2 可靠性目标

- 任意单点崩溃不能产生无限存活的 RMUX session。
- RMUX 可用时，archive/delete/explicit close 在一个有界 RPC 周期内完成 kill。
- RMUX 或 sidecar 暂时不可达时，资源先逻辑终止、停止续租，并在 owner lease TTL 内被 daemon 兜底回收。
- alias 删除后复用，不会 attach 或 kill 旧 alias 对应的终端。
- slow viewer、丢包、乱序或重连不能破坏其他 viewer，也不能继续在错误 screen state 上渲染。
- session 数、viewer 数、scrollback 和协议缓冲都有硬上限。

### 3.3 架构目标

- 未安装/未启用 channel-relay 时，核心构建、启动和依赖图完全不需要 RMUX。
- `channel-relay` 内形成一个深 `RelayTerminalRuntime` 模块；调用者无需理解 registry、lease、recovery、generation、GC 或 sidecar framing。
- RMUX 作为 true external dependency，位于内部 `RmuxTerminalDriver` seam 后；生产 adapter 和 in-memory test adapter 均通过同一 interface 验证。

## 4. 非目标

- v1 不支持一个逻辑会话同时创建多个独立 shell。
- 不同步浏览器本地 Tab 排列、滚动位置、selection、复制状态或主题；只同步终端资源和屏幕内容。
- 不跨 relay 账号共享终端。
- 不允许默认多 controller 或协同交错输入。
- 不保存归档会话的 shell；归档只保存 agent 会话历史。
- 不承诺跨主机重启、RMUX daemon 重启或机器重启恢复 shell；daemon 重启后 terminal resource 视为 exited。
- 不采用 RMUX Web Share 作为数据面；它会重复 hub 的登录、路由和审计模型。
- 不采用 `surface_stream()` 自建浏览器 grid renderer；主渲染路径继续使用 ghostty-web + raw recovery ANSI bytes。
- 不在本项目内提供 shell 命令白名单、chroot、容器或 cgroup。交互 shell 本身具有执行任意命令的能力；OS 资源隔离属于另一个安全项目。
- 不把当前 `@rmux/sdk` CLI wrapper 用于 key-by-key input。

## 5. 术语与身份

| 术语 | 定义 |
|---|---|
| Logical session | xacpx `SessionService` 管理的会话，不等同于 acpx transport session。 |
| `logicalSessionId` | 每个 logical session 的不可变 UUID。alias 可改显示名、可删除复用；该 ID 不复用。 |
| Terminal resource | channel-relay registry 中的一条持久终端记录，对应一个 RMUX session 和默认 pane。 |
| `terminalId` | channel-relay 生成的随机 UUID；浏览器和协议使用，不等于 RMUX name。 |
| Generation | 每次创建 terminal resource 生成的随机 UUID；防止旧事件、旧 attachment 或重用名字误作用于新资源。 |
| Viewer attachment | 一个浏览器 WebSocket 对 terminal resource 的临时观看关系。只存在内存中，有独立 TTL。 |
| Controller | 当前唯一允许 input/resize 的 attachment。 |
| Spectator | 只读 attachment；实时接收同一终端画面。 |
| Owner lease | channel-relay sidecar 向 RMUX daemon 续租的资源所有权。与浏览器 attachment 无关。 |
| Retention deadline | terminal resource 因用户无输入而应被回收的产品策略时间。 |
| Rebase | 能 reset 并重建兼容 emulator 的 RMUX ANSI keyframe。 |
| Reaping tombstone | registry 中 `state="reaping"` 的 durable 记录；只有确认 RMUX session 不存在后才能删除。 |

## 6. 最终模块与依赖方向

```text
relay-web / ghostty-web
        │ browser WebSocket terminal protocol
        ▼
relay hub
        │ auth + viewerId stamping + targeted routing
        ▼
channel-relay plugin
        │
        ├── RelayTerminalRuntime          ← deep module
        ├── TerminalRegistryStore         ← durable write-ahead state
        ├── TerminalAttachmentRegistry    ← ephemeral viewers/controllers
        ├── TerminalReconciler            ← startup + periodic mark-and-sweep
        └── RmuxTerminalDriver seam
                 │
                 ├── RustSidecarRmuxDriver   production adapter
                 └── InMemoryRmuxDriver      tests
                          │
                          ▼
                    RMUX 0.10 daemon
```

### 6.1 包归属

#### xacpx core

核心只负责：

- 为 logical session 持久化不可变 ID；
- 解析 chat scope + alias 到权威 session descriptor；
- 把 workspace 名解析为 cwd；
- 发布 archive/remove/restore 生命周期事件；
- 在 `ChannelStartInput` 注入通用 `SessionResourceCatalog`。

核心不得：

- import RMUX package；
- 解析 RMUX session name/tag；
- 保存 terminal registry；
- 处理 terminal input/output；
- 为 relay-web 启动 PTY 或 sidecar。

#### `packages/channel-relay`

插件负责全部实例侧终端能力：

- config parsing 和 capability advertisement；
- terminal open/resume/attach/detach/terminate；
- viewer/controller 权限；
- RMUX sidecar 生命周期；
- registry、lease、idle TTL、quota、GC 和 reconciliation；
- recovery stream 到 relay wire DTO 的映射；
- 监听 logical session 生命周期并回收终端。

#### `packages/relay-protocol`

只定义 wire contract、validators、capability 字符串和限制常量；不得依赖 xacpx core 或 RMUX。

#### `packages/relay`

只负责账号/instance 授权、hub-stamped viewer identity、browser socket subscription、request correlation、targeted fanout 和 backpressure；不得解释 ANSI 或 RMUX recovery state。

#### `packages/relay-web`

只负责本地 Tab、ghostty adapter、controller/spectator UI、recovery reducer、断线重 attach 和显式 terminate 交互。

## 7. 核心 `SessionResourceCatalog` seam

### 7.1 新的 logical session identity

在 `src/state/types.ts` 的 `LogicalSession` 增加：

```ts
logical_session_id: string;
```

不变量：

- 新建或 attach native session 时生成 UUIDv4。
- alias、display name、workspace、agent 或 transport binding 改变时 ID 不变。
- 删除后该 ID 永远不复用。
- 两个 alias 即使共享同一 `transport_session`，也有不同 `logical_session_id` 和不同 terminal resource。
- state schema 读取旧记录时，为缺失 ID 的记录一次性生成 UUID，并在任何 channel/plugin 启动前同步持久化；持久化失败则启动失败，禁止使用只存在内存中的临时 ID。

### 7.2 通用 interface

新增一个不含 terminal/RMUX 词汇的核心模块，例如 `src/sessions/session-resource-catalog.ts`：

```ts
export interface SessionResourceDescriptor {
  logicalSessionId: string;
  channelId: string;
  internalAlias: string;
  displayAlias: string;
  workspace: string;
  cwd: string;
  archived: boolean;
}

export type SessionResourceLifecycleEvent =
  | { type: "archived"; session: SessionResourceDescriptor }
  | { type: "restored"; session: SessionResourceDescriptor }
  | { type: "removed"; session: SessionResourceDescriptor };

export interface SessionResourceCatalog {
  resolve(chatKey: string, alias: string): Promise<SessionResourceDescriptor | null>;
  list(channelId: string): Promise<SessionResourceDescriptor[]>;
  subscribe(listener: (event: SessionResourceLifecycleEvent) => void): () => void;
}
```

接口契约：

- `resolve` 执行与 `ControlService` 相同的 chat-scope alias 解析，不能允许 relay 打开其他 channel 的 session。
- `cwd` 由核心 workspace config 权威解析，浏览器不能提供任意 cwd。
- `removed` 必须携带删除前的 descriptor snapshot。
- lifecycle event 只在核心 state 已成功持久化后发布。
- listener 抛错不得回滚已经完成的 logical session 操作；错误记录 app log。channel-relay 的启动 reconciliation 是漏通知的兜底。
- `list("relay")` 返回 active 和 archived relay sessions，供 startup/periodic reconciliation 使用。

`SessionResourceCatalog` 通过 `ChannelStartInput` 注入，并从 `xacpx/plugin-api` 只导出 interface/type。生产 adapter 由核心装配；channel-relay 单测使用 in-memory adapter。

## 8. channel-relay 配置与 capability

### 8.1 配置位置

终端配置移入 relay channel options：

```json
{
  "id": "relay",
  "type": "relay",
  "enabled": true,
  "options": {
    "url": "wss://relay.example.com",
    "terminal": {
      "enabled": true,
      "backend": "rmux",
      "bridgeCommand": "/optional/override/xacpx-rmux-bridge",
      "rmuxCommand": "/optional/override/rmux",
      "idleTimeoutSeconds": 900,
      "ownerLeaseTtlSeconds": 90,
      "reconcileIntervalSeconds": 30,
      "orphanGraceSeconds": 120,
      "attachmentTtlSeconds": 45,
      "maxSessions": 16,
      "maxViewersPerTerminal": 4,
      "historyLimit": 10000
    }
  }
}
```

默认和校验：

| 字段 | 默认 | 合法范围/约束 |
|---|---:|---|
| `enabled` | `false` | 必须显式开启。 |
| `backend` | `"rmux"` | 本 spec 只允许 `rmux`。 |
| `idleTimeoutSeconds` | `900` | `60..86400`，不能为 0。 |
| `ownerLeaseTtlSeconds` | `90` | `15..600`。 |
| `reconcileIntervalSeconds` | `30` | `5..300`。 |
| `orphanGraceSeconds` | `120` | `>= ownerLeaseTtlSeconds`，最大 3600。 |
| `attachmentTtlSeconds` | `45` | `15..300`。 |
| `maxSessions` | `16` | `1..128`。 |
| `maxViewersPerTerminal` | `4` | `1..16`。 |
| `historyLimit` | `10000` | `0..100000`。 |

decoded recovery chunk 固定为 48 KiB，不暴露配置；base64 后仍远低于现有 256 KiB WebSocket inbound cap。

### 8.2 capability

instance register/auth payload 增加 additive `capabilities?: string[]`。本功能使用：

```text
terminal.rmux.recovery.v1
terminal.multi-view.v1
```

channel-relay 只有在以下条件全部成立时才声明 capability：

- `terminal.enabled=true`；
- sidecar 完成版本 handshake；
- RMUX daemon 支持要求的 recovery、stable identity 和 owner lease capability；
- startup reconciliation 完成。

hub 将 capability 暴露给 relay-web。缺失 capability 时隐藏/禁用 Terminal 入口，不回退到未声明的核心 PTY。

## 9. `RelayTerminalRuntime` 深模块

建议文件落点：`packages/channel-relay/src/terminal/terminal-runtime.ts`。

对 `RelayChannel` 暴露的 interface：

```ts
export interface RelayTerminalRuntime {
  start(): Promise<void>;

  openOrResume(input: {
    chatKey: string;
    sessionAlias: string;
    viewerId: string;
    cols: number;
    rows: number;
  }): Promise<TerminalOpenResult>;

  startRecovery(attachmentId: string): Promise<void>;
  detach(attachmentId: string): void;
  heartbeat(attachmentId: string): void;

  input(attachmentId: string, generation: string, data: Uint8Array): Promise<void>;
  resize(attachmentId: string, generation: string, cols: number, rows: number): Promise<void>;
  takeControl(attachmentId: string, generation: string): Promise<TerminalRoleResult>;
  resync(attachmentId: string, generation: string): Promise<void>;

  terminate(input: {
    terminalId: string;
    generation: string;
    reason: "explicit-close" | "archive" | "delete" | "idle" | "disabled";
  }): Promise<TerminalTerminateResult>;

  retireLogicalSession(logicalSessionId: string, reason: "archive" | "delete"): Promise<void>;
  terminateAll(reason: "disabled" | "logout"): Promise<void>;
  stop(): Promise<void>;
}
```

结果类型固定为：

```ts
export interface TerminalOpenResult {
  terminalId: string;
  generation: string;
  attachmentId: string;
  role: "controller" | "spectator";
  viewerCount: number;
}

export interface TerminalRoleResult {
  terminalId: string;
  generation: string;
  attachmentId: string;
  role: "controller";
  viewerCount: number;
}

export type TerminalTerminateResult =
  | { status: "terminated" }
  | { status: "cleanup-pending" };
```

interface 的隐含契约也是 interface 的一部分：

- 所有改变一个 terminal resource 的操作在 per-terminal mutex 内串行。
- `openOrResume` 是按 `logicalSessionId` 幂等的，不按 alias 幂等。
- `terminate` 是幂等的；`already-gone` 视为成功。
- `input/resize/takeControl/resync` 必须同时验证 attachment、terminal、generation 和 controller role。
- `startRecovery` 是两阶段 attach 的第二步；调用前不产生 browser recovery frames。
- `stop()` 停止 viewer streams 和 owner heartbeat，但不得 release lease 或立即 kill live sessions；让新进程在 TTL 内 adopt，超时由 RMUX daemon 回收。
- runtime 内部复杂度不得泄漏到 `RelayChannel`、hub 或 web。

## 10. Durable registry 与崩溃一致性

### 10.1 文件位置与 schema

默认位置：

```text
<xacpx-home>/relay/terminal-owner.json
<xacpx-home>/relay/terminals.json
```

`terminal-owner.json` 保存稳定随机 `installationId`；与 hub `instanceId` 分离，避免重新配对改变 RMUX ownership namespace。

`terminals.json`：

```ts
interface TerminalRegistryFileV1 {
  schemaVersion: 1;
  revision: number;
  terminals: Record<string, TerminalRecordV1>;
}

interface TerminalRecordV1 {
  terminalId: string;
  logicalSessionId: string;
  internalAliasSnapshot: string;
  rmuxSessionName: string;
  rmuxSessionId?: string;
  generation: string;
  state: "creating" | "live" | "reaping";
  createdAt: string;
  lastInputAt: string;
  reapReason?: "explicit-close" | "archive" | "delete" | "idle" | "disabled" | "orphan" | "exited";
}
```

viewer、attachment、controller 和 recovery cursor 不持久化；它们都属于某个 browser/hub 连接的短暂状态。

### 10.2 RegistryStore 写入契约

`TerminalRegistryStore` 必须：

- 所有 mutation 串行；
- copy-on-write 构造 next snapshot；
- 写入同目录唯一 temp 文件，mode `0600`；
- flush/fsync 文件后 atomic rename；
- rename 成功后再发布内存 snapshot；
- 写失败时内存保持旧值并让操作失败；
- `revision` 每次成功 mutation 单调递增；
- whole-file corruption 时把原文件 best-effort rename 为 `.corrupt-<timestamp>`，随后进入保守 discovery/reconciliation，不能把未知 RMUX session 当作正常 live record。

禁止用 debounce 写入状态转换。`lastInputAt` 可以最多每 30 秒 checkpoint 一次，但 `creating/live/reaping` 转换必须同步落盘。

### 10.3 RMUX name 与 tags

RMUX session name 使用不可复用格式：

```text
xacpx-relay-<installation-short>-<terminal-uuid-without-dashes>
```

创建时写入 tags：

```text
xacpx:relay
owner:<installationId>
logical:<logicalSessionId>
terminal:<terminalId>
generation:<generation>
schema:1
```

GC 只有在 name prefix、owner tag、terminal tag 和 generation 全部匹配时才允许 kill。任一字段缺失、无法解析或与 registry 冲突时，记录诊断并走 owner lease 到期，不得猜测性删除用户自己的 RMUX session。

### 10.4 创建事务

在 per-logical-session lock 内：

1. 解析 `SessionResourceDescriptor`；不存在、非 relay、已归档则拒绝。
2. 若 registry 已有该 `logicalSessionId` 的 `live` resource，返回它并创建 attachment。
3. 若已有 `reaping` resource，返回 `terminal-terminating`，不得同名或同 ID 重建。
4. 执行 quota check；先同步 reap 已过期记录，仍超限则返回 `terminal-capacity-exceeded`。
5. 生成 `terminalId`、generation、不可复用 RMUX name。
6. **先同步持久化 `creating`。** 此时不能向浏览器返回成功。
7. 通过 driver 创建 detached RMUX session，cwd 取 descriptor，初始 size 取浏览器值，设置 history limit、scrubbed env、tags 和 owner lease。
8. 取得 RMUX stable session ID 和 default pane ID。
9. **同步持久化 `live` + stable ID。** 成功后才创建 attachment 并响应浏览器。
10. 第 7～9 步失败时立即尝试 compensating kill；无论 kill 是否成功，都把 record 转为 `reaping`，由 reconcile + owner lease 收尾。

崩溃窗口：

- 第 6 步前崩溃：没有 RMUX side effect。
- 第 6～7 步之间：startup 看到 `creating` 且 RMUX 不存在，删除记录。
- 第 7～9 步之间：startup 按确定性 name/tags 找到 RMUX，adopt 后完成 `live`；无法 adopt 则转 `reaping`。
- 第 9 步后：正常 adopt/resume。

### 10.5 终止事务

在 per-terminal lock 内：

1. 校验 terminalId + generation。
2. **先同步持久化 `reaping` + reason。** 从此逻辑上终端已经关闭，拒绝新的 attach/input/resize。
3. 停止 recovery streams 和 owner lease heartbeat；向现有 viewer 发 targeted `terminal-exit`。
4. 以 RMUX stable identity 执行幂等 kill，单次等待最多 5 秒。
5. kill 成功或 RMUX 回答 not-found：从 registry 删除记录。
6. kill 超时/sidecar 不可达：返回 `{ status: "cleanup-pending" }`，保留 tombstone；reconciler 重试，daemon owner lease 最迟在 TTL 后回收。

显式关 Tab 收到 `terminated` 或 `cleanup-pending` 都可以关闭本地 Tab，因为 terminal resource 已经逻辑终止；`cleanup-pending` 需要 toast，不能伪装成物理 kill 已确认。

## 11. 生命周期状态机与回收政策

### 11.1 Durable state machine

```text
                create intent durable
       ┌────────────────────────────────┐
       ▼                                │
   creating ── rmux created+recorded ─▶ live
       │                                │
       │ failure/crash reconcile        │ explicit close
       │                                │ archive/delete
       └──────────────────────────────▶ reaping
                                        │
                                        │ rmux absent confirmed
                                        ▼
                                      gone
```

没有 durable `attached/detached` 状态。attachment 是短暂 viewer 状态，不应污染资源所有权状态机。

### 11.2 用户动作语义

| 动作 | 资源行为 |
|---|---|
| 在不同逻辑会话之间切换 | 当前 viewer detach；terminal resource 保留。 |
| 路由切换或组件 unmount | detach。 |
| 页面刷新 | browser socket 断开触发 detach；刷新后 `openOrResume`。 |
| 浏览器窗口关闭 | detach；资源等待 idle timeout。 |
| 网络抖动 | detach/re-attach；不改变 durable state。 |
| 显式点击终端 Tab 的关闭按钮 | 全局 terminate。 |
| “终止终端”菜单 | 全局 terminate。 |
| 归档 logical session | terminate；恢复归档不会复活。 |
| 删除 logical session | terminate；logical delete 已持久化但 kill 失败时 tombstone + lease 继续兜底。 |
| shell 自然退出 | targeted exit；record 转 `reaping(exited)`，确认不存在后删除。 |
| `terminal.enabled` 运行时关闭 | 全部 resource 转 `reaping(disabled)`。 |

### 11.3 Idle 和 quota

- idle 只被以下动作刷新：成功 `openOrResume`、成功 `takeControl`、controller input。
- terminal output、heartbeat、普通 attach、spectator 活动和 resize 不刷新 idle。resize 可能由布局变化自动产生，不能无限保活。
- 到期后立即转 `reaping(idle)`。
- 一个 logical session 最多一个 live/creating resource。
- 实例总数达到 `maxSessions` 时，先 reap expired/reaping；仍满则拒绝创建。禁止静默 LRU-kill 未过期终端。
- 每个 terminal viewer 数达到 `maxViewersPerTerminal` 时，拒绝新 attachment，但不影响已连接 viewer。
- RMUX `history-limit` 必须按 channel config 设置，防止 scrollback 无界增长。
- 终端内程序仍可自行占用大量内存；本文只保证 RMUX/terminal ownership 不泄漏，不提供 OS process memory quota。

### 11.4 Archive/delete 集成

channel-relay 在 `SessionResourceCatalog` lifecycle event 上调用：

```ts
retireLogicalSession(logicalSessionId, "archive" | "delete")
```

该调用幂等。relay-web 发起的 archive/delete 仍走现有核心 session operation；不得在 browser 先单独 kill 再 archive，以免半成功。核心状态持久化后发布 lifecycle event，plugin 负责资源回收。

若 lifecycle 通知因进程崩溃丢失，startup/periodic reconciliation 通过 `catalog.list("relay")` 发现 logical session 已 archived/removed 并补做 reaping。

## 12. Owner lease、重启与孤儿防护

### 12.1 三种“租约”必须分开

| 机制 | owner | 作用 | 是否决定 shell 存活 |
|---|---|---|---|
| Viewer attachment TTL | browser socket | 清理 stale viewer/controller | 否 |
| Retention deadline | channel-relay runtime | 用户无输入回收 | 是 |
| RMUX owner lease | instance-side sidecar | xacpx/plugin/sidecar 死亡兜底 | 是 |

浏览器断线永远不能停止 RMUX owner lease。

### 12.2 Owner lease 规则

- 每个 `live` resource 都必须拥有 RMUX daemon-side owner lease；创建 lease 失败则创建操作失败并补偿清理。
- heartbeat 间隔为 effective TTL 的约三分之一，且使用 monotonic clock。
- lease token 与 RMUX stable session ID 绑定；name 重用不得让旧 token 续到新 session。
- 新 channel-relay sidecar 启动时，在连接 hub 之前先 reconcile 并 adopt 所有合法 live resource。
- 新 owner 成功 adopt 会 fence 旧 owner；旧 sidecar 观察到 lease lost 后必须停止 input/output/kill 等所有 mutation，并退出该 terminal 的 stream。
- `RelayChannel.stop()`/进程优雅退出调用 sidecar 的 abandon-to-expiry：停止 heartbeat，不 release、不立即 kill。新进程在 TTL 内 adopt；没有新进程则 daemon 回收。
- 显式 terminate/disabled/logout 不走 abandon，必须尝试立即 kill。
- xacpx 重启超过 owner lease TTL 后，终端丢失是预期行为；web 下一次 open 创建新 resource。
- relay connector 与 hub 的 WebSocket 断开时，channel-relay 立即清除该连接承载的全部 viewer attachment、controller role 和 recovery stream，但继续续 RMUX owner lease、继续执行 idle/GC；连接恢复后 browser 重新 open/attach。

### 12.3 Channel stop reason

现有 `MessageChannelRuntime.stop()` 没有表达“进程重启”和“永久禁用”的差别；RMUX 生命周期需要把它补成通用 channel 语义：

```ts
export type ChannelStopReason = "shutdown" | "disabled" | "removed" | "logout";

stop?(reason?: ChannelStopReason): void | Promise<void>;
logout(): void | Promise<void>;
```

- 缺省 reason 按 `shutdown`，执行 abandon-to-expiry，支持短重启接管。
- `disabled`、`removed`、`logout` 先 `terminateAll`，再停止 runtime。
- 显式 logout 必须 await 终端清理已进入 durable `reaping` 后才能删除 relay credential；RMUX 暂时不可达时允许 cleanup-pending + owner TTL，但不能先丢 registry/owner identity。
- 旧 channel adapter 继续兼容无参数 `stop()` 和同步 `logout()`；registry 调用点使用 `await` 接受两种返回值。

### 12.4 Startup 和周期 reconciliation

启动顺序：

1. load/validate owner ID 和 terminal registry；
2. 启动 sidecar，完成版本/capability handshake；
3. 从 core catalog 取得全部 relay logical sessions；
4. 从 RMUX inventory 读取当前 owner namespace sessions/tags；
5. reconcile 完成后才连接 relay hub 并声明 terminal capability。

每 `reconcileIntervalSeconds` 重复：

- `creating` + RMUX 存在 + logical session active：adopt 并完成 `live`。
- `creating` + RMUX 不存在：删除 stale intent。
- `live` + logical session active + 未过 idle：确保 lease active。
- `live` + logical session missing/archived/idle：转 `reaping`。
- `reaping`：重试 kill；确认不存在后删 registry。
- registry 有 record、RMUX 不存在：发 exit，删 record。
- RMUX 有合法 owner tags、registry 无 record：写入 quarantine first-seen；若能从 tags 对应到 active logical session 且 generation 唯一，可重建并 adopt；否则连续两轮且超过 `orphanGraceSeconds` 后 kill。
- 无法完整读取 registry、catalog 或 RMUX inventory：本轮 destructive GC fail closed；owner lease 仍提供最终回收。

执行任何 GC kill 前必须在 per-terminal lock 内重新读取最新 registry revision，并再次比较 terminalId、generation、RMUX stable ID 和状态仍为 `reaping`。扫描结果不能直接作为删除授权。

## 13. 多设备共享与 controller 模型

### 13.1 共享范围

terminal resource 的唯一键是实例内 `logicalSessionId`。hub 已用登录 account 检查 instance ownership；不同 account 即使猜到 terminalId 也不能 attach。

同一账号、同一 instance、同一 logical session：

- 机器 A 打开终端，创建 terminal resource。
- 机器 B 打开终端，`openOrResume` 返回同一个 terminalId/generation。
- 两边各自建立独立 recovery attachment，看到同一 shell。
- 任一边显式 terminate，所有 attachment 收到 exit。

本地 Tab 是否打开不跨设备同步。机器 B 必须自己打开 Terminal Tab；服务端 `openOrResume` 保证它不会创建第二个 shell。

### 13.2 Viewer identity

- browser 不得自报可信 viewerId。
- hub 为每个已认证 browser WebSocket 生成随机 viewerId，并在转发给 connector 时盖章。
- attachmentId 由 channel-relay 生成并绑定 `(viewerId, terminalId, generation)`。
- hub 维护 socket→attachments 和 attachment→socket 映射。
- socket close 时 hub best-effort 发 detach；attachment TTL 是丢失 detach 的兜底。
- browser 每 10 秒发 heartbeat；channel-relay 仅刷新 attachment TTL，不刷新 terminal idle deadline。

### 13.3 Controller

- 没有 controller 时，第一个成功 attachment 自动成为 controller。
- 后续 attachment 是 spectator。
- spectator input/resize 在 channel-relay 被拒绝，不得只依赖 web UI 禁用。
- `takeControl` 在 per-terminal lock 内原子执行：新 attachment 成 controller，旧 controller 立即降级 spectator；两边收到 role-changed。
- controller socket detach/TTL expiry后 controller 为空；terminal 继续 live，任一 spectator 可 take control。
- 只有 controller resize RMUX pane；spectator 以 RMUX 权威 cols/rows 渲染，不向后端争抢尺寸。
- 显式关 Tab 是全局 terminate，不是“只退出 viewer”。当 `viewerCount > 1` 时，web 必须确认“这会为所有设备终止终端”；确认后仍执行全局 terminate。
- `viewerCount` 是当前 terminal 上的 **attachment 总数**（含自己）。看板顶栏展示的「X 位观看者」是 `max(0, viewerCount - 1)`，即其他连接者；不得把协议字段改成“其他人数量”。

## 14. Wire protocol 与严格顺序

### 14.1 为什么不继续用 `ControlEvent terminal-output`

当前 output 按 account/instance 广播，浏览器再按 terminalId 过滤。多设备和 recovery 后必须改为 attachment-targeted routing，否则：

- 未 attach 的账号 socket 也承受终端洪流；
- 无法表达 controller role；
- 无法保证 rebase 先于该 attachment 的 bytes；
- slow viewer 会拖累无关 viewer。

新终端流不得继续塞进通用 `ControlEventDto` 广播。它使用独立的 targeted `WebServerEvent` 变体。

### 14.2 Browser → hub 消息

在 `WebClientMessage` 增加：

```ts
type TerminalWebClientMessage =
  | { kind: "terminal-open"; requestId: string; instanceId: string; sessionAlias: string; cols: number; rows: number }
  | { kind: "terminal-stream-start"; requestId: string; instanceId: string; attachmentId: string }
  | { kind: "terminal-input"; instanceId: string; attachmentId: string; generation: string; dataBase64: string }
  | { kind: "terminal-resize"; instanceId: string; attachmentId: string; generation: string; cols: number; rows: number }
  | { kind: "terminal-heartbeat"; instanceId: string; attachmentId: string }
  | { kind: "terminal-take-control"; requestId: string; instanceId: string; attachmentId: string; generation: string }
  | { kind: "terminal-resync"; requestId: string; instanceId: string; attachmentId: string; generation: string }
  | { kind: "terminal-terminate"; requestId: string; instanceId: string; terminalId: string; generation: string }
  | { kind: "terminal-detach"; instanceId: string; attachmentId: string };
```

限制：

- requestId、terminalId、attachmentId、generation 长度有限并严格校验。
- cols `1..500`、rows `1..300`。
- decoded input 单帧最多 64 KiB。
- base64 必须 canonical；非法 payload 在 hub 丢弃并记限速诊断。

### 14.3 Hub → browser targeted 消息

```ts
type TerminalWebServerEvent =
  | { kind: "terminal-opened"; requestId: string; instanceId: string; terminalId: string; generation: string; attachmentId: string; role: "controller" | "spectator"; viewerCount: number }
  | { kind: "terminal-request-failed"; requestId: string; instanceId: string; code: string; message: string }
  | { kind: "terminal-rebase-start"; instanceId: string; attachmentId: string; generation: string; epoch: number; nextSequence: number; cols: number; rows: number; alternate: boolean; totalBytes: number; chunkCount: number }
  | { kind: "terminal-rebase-chunk"; instanceId: string; attachmentId: string; generation: string; epoch: number; index: number; dataBase64: string }
  | { kind: "terminal-rebase-end"; instanceId: string; attachmentId: string; generation: string; epoch: number }
  | { kind: "terminal-bytes"; instanceId: string; attachmentId: string; generation: string; epoch: number; sequence: number; dataBase64: string }
  | { kind: "terminal-role-changed"; instanceId: string; attachmentId: string; terminalId: string; role: "controller" | "spectator"; viewerCount: number }
  | { kind: "terminal-exit"; instanceId: string; terminalId: string; generation: string; code?: number; reason: string };
```

recovery chunks 使用 exact bytes，不先转成 UTF-8 string。ghostty-web 支持 `Uint8Array`。

### 14.4 Hub ↔ connector 消息方向

现有 instance gateway 同时支持 request/response 和 event。新增 `MSG` 名称及方向固定如下，禁止把 low-frequency request 降级成 fire-and-forget：

| 名称 | 方向 | 形态 | 用途 |
|---|---|---|---|
| `instance.terminal.open` | hub → connector | request/response | resolve session、open/resume resource、创建 paused attachment，返回 `TerminalOpenResult`。 |
| `instance.terminal.take-control` | hub → connector | request/response | 原子转移 controller，返回 `TerminalRoleResult`。 |
| `instance.terminal.resync` | hub → connector | request/response | 丢弃旧 recovery stream，确认可启动新 stream。 |
| `instance.terminal.terminate` | hub → connector | request/response | durable tombstone + kill，返回 `TerminalTerminateResult`。 |
| `instance.terminal.stream-start` | hub → connector | event | 对已成功登记的 attachment 启动 `recover_output()`。 |
| `instance.terminal.input` | hub → connector | event | hub 盖 viewerId 后转发 exact input bytes。 |
| `instance.terminal.resize` | hub → connector | event | hub 盖 viewerId 后转发 controller resize。 |
| `instance.terminal.heartbeat` | hub → connector | event | 刷新 attachment TTL。 |
| `instance.terminal.detach` | hub → connector | event | 释放 viewer/role/stream，不影响 resource。 |
| `instance.terminal.viewer-event` | connector → hub | event | 携带 `{ viewerId, attachmentId, event }` 的 rebase/bytes/role/request-failed；hub 只发给仍绑定该 viewerId+attachmentId 的 socket。 |
| `instance.terminal.resource-exit` | connector → hub | event | 携带 terminalId+generation；hub fanout 给该 terminal 的全部当前 attachments。 |

hub 转发给 connector 的 attachment-scoped payload 必须包含自己盖章的 viewerId；connector 返回的 viewer event 必须回显 viewerId + attachmentId。hub 在发送前重新校验该二元组仍属于当前 socket，防止旧 connector 帧落到复用后的 browser connection。

low-frequency request 延续 instance gateway 的 deadline/response correlation；terminal open/take-control/resync/terminate 单次上限 10 秒，其中 RMUX kill 确认最多等待 5 秒。timeout 只允许返回明确失败或 `cleanup-pending`，不得让 underlying mutation 在 caller 已收到普通失败后无标识地继续创建第二个 resource。open request 因 deadline 取消时，channel-relay 必须在 runtime 内完成补偿或留下 `reaping` tombstone。

### 14.5 两阶段 open/stream start

必须采用两阶段握手，消除 snapshot/live race：

1. browser 发 `terminal-open`。
2. hub 校验 account 拥有 instance，盖 viewerId，向 connector 发有响应请求。
3. channel-relay resolve logical session，open/resume resource，创建 attachment，但**不启动 recovery stream**。
4. connector 返回 metadata；hub 先登记 socket↔attachment，并向 browser 发送 `terminal-opened`。
5. browser 收到 opened 后发送 `terminal-stream-start`。
6. hub 验证 attachment 属于该 socket，通知 connector。
7. channel-relay 此刻调用 `Pane::recover_output()`；它的第一个 rebase 包含步骤 7 时的完整权威画面，随后同一 per-attachment stream 产生 bytes。

如果步骤 4～6 任意一处丢失，attachment TTL 清理；browser 超时后重新 open。因为 recovery 在 stream-start 才建立，中间输出会包含在第一个 rebase，不会漏。

### 14.6 Browser recovery reducer

每个 attachment 维护：

```ts
{
  generation: string;
  phase: "waiting" | "rebase" | "live" | "resyncing" | "exited";
  epoch?: number;
  expectedSequence?: number;
  expectedChunkIndex?: number;
}
```

规则：

1. `rebase-start`：停止渲染 bytes，清空旧 chunks，校验 totalBytes/chunkCount/尺寸上限。
2. `rebase-chunk`：generation、epoch、index 必须完全匹配；不匹配立即进入 resyncing。
3. `rebase-end`：确认 chunk 数和 decoded byte 数；await adapter ready；reset emulator；按 rebase cols/rows resize；写入完整 keyframe；设置 `expectedSequence=nextSequence`；进入 live。
4. `terminal-bytes`：只有 generation/epoch/sequence 全部等于期望值才写；成功后 expectedSequence++。
5. sequence gap、重复 epoch、generation mismatch、chunk decode 错误或 adapter write 失败：停止继续渲染，发送 `terminal-resync`；禁止在损坏状态上“尽量继续”。
6. 新 rebase 可以在任何时刻替换当前 live epoch；旧 epoch 后续帧一律丢弃。

### 14.7 Rebase chunking 和 backpressure

- decoded chunk 固定 48 KiB。
- 单次 rebase `totalBytes` 上限 2 MiB；超过则 connector 终止 attachment，记录 protocol/capability error。该上限需与所 pin RMUX 版本的 recovery keyframe 上限同步测试。
- hub 只向 attachment 对应 socket发送 frame。
- socket `bufferedAmount` 超阈值时，只 evict 该 viewer，向 connector detach；terminal resource 和其他 viewer 不受影响。
- channel-relay 每个 attachment 的待发送队列必须有 byte 上限；超限关闭该 recovery stream，让 browser 重连/rebase，不能无界缓存。

### 14.8 稳定错误码

wire 上至少定义以下稳定 code；web 根据 code 映射 i18n，不解析 message 文本：

```text
terminal-disabled
terminal-rmux-unavailable
terminal-session-not-found
terminal-session-archived
terminal-capacity-exceeded
terminal-viewer-capacity-exceeded
terminal-terminating
terminal-attachment-not-found
terminal-generation-mismatch
terminal-not-controller
terminal-recovery-too-large
terminal-protocol-error
terminal-timeout
instance-offline
```

`message` 只用于诊断和 fallback 展示；不得把 sidecar stderr、路径、terminal bytes 或凭证透传给 browser。

## 15. RMUX Rust sidecar 与上游前置

### 15.1 禁止方案

以下实现不符合本文：

- 对每次 input/resize 调用 `rmux` CLI；
- 使用当前 `../rmux-typescript` 的 `Pane.sendText()` 作为交互热路径；
- 用 `capture-pane -p` 文本模拟 recovery；
- 只依赖 channel-relay 定时 GC、不创建 daemon owner lease；
- 在 Node 中重新实现 RMUX bincode wire protocol。

### 15.2 Rust SDK 前置接口

先在 RMUX 0.10 Rust SDK 落地并测试一个 public interface，语义等价于：

```rust
let session = rmux.ensure_session(
    EnsureSession::named(name)
        .create_only()
        .detached(true)
        .working_directory(cwd)
        .size(size)
        .tags(tags)
).await?;

let owned = rmux
    .adopt_owned_session(session)
    .cleanup_policy(CleanupPolicy::KillOnOwnerExit)
    .lease_ttl(ttl)
    .await?;

owned.abandon_to_lease_expiry().await?;
```

必须满足：

- adopt 可用于刚创建或已存在的 exact stable session identity；
- 新 lease 能 fence 旧 owner，旧 owner 可观察 `LeaseState::Lost`；
- abandon 停止 heartbeat，不发送 kill，不 release lease；
- explicit cleanup 仍按 stable identity 幂等 kill；
- rename/name reuse 不能重定向旧 lease；
- lease create 失败时 caller 可以安全补偿 kill；
- API 有 fake-daemon tests 覆盖 create/adopt/fence/abandon/expiry/rename/reuse。

不得依赖 server 内部 `HashMap::insert` 当前会覆盖旧 lease 这一未文档化实现细节；接管/fencing 必须成为 public contract。

### 15.3 Sidecar interface

channel-relay 通过一个长驻 Rust sidecar 使用 RMUX SDK。sidecar：

- stdin/stdout 使用 versioned length-bounded NDJSON request/response；bytes 用 base64；
- stdout 只允许协议帧，日志写 stderr；
- 每个请求带 request ID；响应 exactly once；
- input/resize 在 per-terminal actor 内串行；
- recovery event 保持 RMUX 原始 epoch/sequence；
- 对 driver 暴露 create/adopt/list/kill/input/resize/recover/stop-renewing；
- sidecar 崩溃时 channel-relay 使用有界指数退避重启；owner lease 在重启窗口内保护资源，超过 TTL 自动回收；
- handshake 返回 bridge version、RMUX wire version 和 capability 列表，不匹配时 terminal capability 不上线。

生产 adapter interface 建议位于 `packages/channel-relay/src/terminal/rmux-driver.ts`；sidecar framing adapter 位于 `rmux-sidecar-driver.ts`；测试使用 `in-memory-rmux-driver.ts`。

### 15.4 分发

开发/首个 spike 允许显式 `bridgeCommand` + `rmuxCommand`。正式发布前必须完成：

- macOS arm64/x64、Linux x64/arm64、Windows x64 的 sidecar artifact；
- artifact checksum/version verification；
- channel-relay npm package 通过 optional platform packages 或等价方式解析对应 binary；
- resolution 顺序：显式 config → plugin bundled platform binary → 明确 `terminal-rmux-unavailable`；
- RMUX daemon binary resolution：显式 config → bundled/sibling compatible binary → PATH；
- `xacpx doctor` 或 relay plugin doctor 输出 bridge/RMUX 版本、capability、registry 和 lease 状态。

所有 RMUX/bridge npm 或 binary 依赖必须由 channel-relay 引入，不能加入核心运行依赖。

## 16. ghostty-web adapter 修正

当前 `terminal-adapter.ts` 在异步 factory ready 前对 `write/resize/dispose` 做 no-op。必须改为明确 readiness interface：

```ts
export interface TerminalAdapter {
  ready(): Promise<void>;
  resetAndReplay(data: Uint8Array, cols: number, rows: number): Promise<void>;
  write(data: Uint8Array): Promise<void> | void;
  resize(cols: number, rows: number): void;
  // existing focus/selection/scroll/theme/dispose...
}
```

约束：

- ready 前的必要操作排队或 await，不能静默丢弃。
- rebase 必须 reset，而不是在旧 screen 上追加 keyframe。
- `resetAndReplay` 自身串行；执行时后续 bytes 暂存，完成后按 sequence 写入。
- adapter dispose 使尚未完成的 ready/replay 安全取消，不产生 unhandled rejection。
- `Uint8Array` 直接交给 ghostty，避免错误 Unicode round-trip。

## 17. 显式关闭 Tab 的可靠语义

### 17.1 UI 规则

- `X` 按钮表示“终止这个共享终端”，不是只隐藏本地 view。
- `viewerCount > 1` 时必须显示确认，明确其他设备也会退出。
- socket 在线时，发送有 requestId 的 `terminal-terminate`，等待 ack。
- ack 为 `terminated`：关闭 Tab，清本地 attachment/controller token。
- ack 为 `cleanup-pending`：关闭 Tab并显示“终端已关闭，实例正在完成资源清理”。
- 请求超时/instance offline：不得静默清除 Tab 或忘记 terminal；显示失败并允许重试。
- 页面 unload 不尝试把 terminate 偷塞进 unreliable `sendBeacon`；它只依赖 socket detach + idle policy。

### 17.2 全局事件

终止开始后 channel-relay 立即拒绝新 input/attach，并向所有 attachment 发送同 generation 的 `terminal-exit`。其他设备收到后把本地 terminal view 标为 exited 并清除 attachment；可以保留 Tab 展示退出状态，也可以按既有 UI 规范关闭，但不得自动创建替代 shell。

## 18. 安全与权限

- terminal 默认关闭；启用等价于允许 relay 登录者在实例 workspace 打开交互 shell。
- hub 对每个 browser terminal message 复用 account→instance ownership gate。
- channel-relay 再检查 logical session 属于 `channelId="relay"`，且未 archived。
- cwd 只来自 `SessionResourceCatalog`，browser payload 不接受 cwd。
- terminalId/generation/attachmentId 都不可代替授权；即使猜中也必须通过 account、instance、viewer attachment 和 controller checks。
- sidecar 创建 shell 时延续现有敏感 env denylist，并剔除 `XACPX_*`、relay credential 和 sidecar 内部变量；文档仍需声明 shell 可以主动读取磁盘凭证。
- terminal bytes、input 和 recovery keyframe 不写 app log；日志只记录 ID、reason、sizes、counts 和 error class。
- registry/owner 文件 mode `0600`。
- sidecar protocol 对 line length、base64 decoded size、request rate 和 outstanding requests 设置上限。
- RMUX inventory GC 只删除当前 installation 明确拥有且 identity 完全匹配的 session。

## 19. 可观测性

至少记录以下结构化事件：

```text
relay.terminal.runtime_ready
relay.terminal.runtime_unavailable
relay.terminal.created
relay.terminal.resumed
relay.terminal.viewer_attached
relay.terminal.viewer_detached
relay.terminal.control_transferred
relay.terminal.rebase
relay.terminal.resync_requested
relay.terminal.terminated
relay.terminal.cleanup_pending
relay.terminal.idle_reaped
relay.terminal.session_reaped
relay.terminal.orphan_quarantined
relay.terminal.orphan_reaped
relay.terminal.lease_lost
relay.terminal.sidecar_restarted
relay.terminal.protocol_violation
```

diagnostic snapshot 至少包含：live/creating/reaping 数、viewer/controller 数、oldest lastInput age、sidecar/RMUX version、lease state 和上次 reconcile 结果。不得包含终端内容。

## 20. 兼容与迁移

### 20.1 旧设计的地位

- `2026-06-30-relay-web-terminal-design.md` 是历史 v1 设计。
- `2026-07-05-terminal-content-replay-design.md` 的 raw ring-buffer replay 对 RMUX backend 被本文取代；其“显式 close 才 kill、unmount 不 kill”的用户动作区分仍保留，但显式 close 改为 acknowledged global terminate。
- `2026-07-12-track4-terminal-stream-hardening-design.md` 的 output coalescing 和 slow-socket backpressure 对 legacy backend 仍有效；RMUX backend 使用 per-attachment targeted stream 和 recovery resync。

### 20.2 灰度步骤

1. 先增加 logical session ID 和 `SessionResourceCatalog`，不改变现有 terminal 行为。
2. 完成 RMUX SDK 前置和 sidecar driver，全部以 fake/real integration test 验证。
3. 在 channel-relay 中实现 registry/runtime/reconcile，但默认 `terminal.enabled=false`，不声明 capability。
4. 增加 protocol/hub targeted routing 和 relay-web recovery reducer。
5. 显式开启 RMUX backend，在开发环境和少量实例灰度。
6. 达到本文验收条件后，relay-web 不再使用 `control.terminal.create/attach` 和 browser terminal ID sessionStorage。
7. 删除 channel-relay 对核心 terminal methods 的调用。
8. 单独后续变更删除核心 `src/control/terminal-service.ts`、`terminal.*` core config 和 node-pty terminal-only wiring；如果 node-pty 仍被 transport 使用，不删除 dependency。

### 20.3 旧 live PTY

升级时无法把当前核心内存 PTY 转移进 RMUX。旧 terminal ID attach 失败后，web 清除旧 `xacpx.terminal-ids.v1` 条目；用户重新打开时创建 RMUX terminal。不得尝试按 alias 猜测迁移。

### 20.4 版本兼容

- 所有 wire DTO additive，validators 必须接受缺失 capability 的旧 connector。
- 新 web 在 capability 缺失时隐藏新终端，不向旧 connector 发送新消息。
- 新 connector 与旧 hub 不声明可用 terminal capability，避免半可用 UI。
- channel-relay `minXacpxVersion` 在使用 `SessionResourceCatalog` 后必须提升到包含该 plugin interface 的核心版本。
- protocol、channel-relay、relay hub、relay-web 按 release runbook 的顺序发布和锁版本。

## 21. 文件级实施清单

以下是预期落点。实现者可以在保持 module/interface 归属不变的前提下微调文件名，但不得把 RMUX implementation 移回核心。

### Core

- `src/state/types.ts`：`logical_session_id`。
- `src/state/state-store.ts`：旧 state 校验/迁移。
- `src/sessions/session-service.ts`：创建 ID；archive/remove/restore 后发布 lifecycle。
- `src/sessions/session-resource-catalog.ts`：新 module。
- `src/channels/types.ts`：`ChannelStartInput.sessionResources`。
- `src/channels/types.ts`、`src/channels/channel-registry.ts`：通用 `ChannelStopReason` 与 async logout 兼容。
- `src/plugin-api.ts`：只导出 resource catalog types。
- `src/main.ts`：迁移持久化完成后装配并注入 catalog。
- `docs/control-module.md`、`docs/config-reference.md`、`AGENTS.md`：先更新对应模块文档，再补导航；AGENTS 只记录长期 seam，不放协议细节。

### Channel Relay

- `packages/channel-relay/src/config.ts`：terminal config 和校验。
- `packages/channel-relay/src/channel.ts`：runtime start-before-connect、lifecycle subscribe、stop abandon。
- `packages/channel-relay/src/control-bridge.ts`：移除新 backend 对核心 terminal methods 的依赖，路由 instance terminal requests/events 到 runtime。
- `packages/channel-relay/src/terminal/terminal-runtime.ts`。
- `packages/channel-relay/src/terminal/terminal-registry-store.ts`。
- `packages/channel-relay/src/terminal/terminal-reconciler.ts`。
- `packages/channel-relay/src/terminal/terminal-attachments.ts`。
- `packages/channel-relay/src/terminal/rmux-driver.ts`。
- `packages/channel-relay/src/terminal/rmux-sidecar-driver.ts`。
- `packages/channel-relay/src/terminal/in-memory-rmux-driver.ts`（测试可放 test support）。
- `packages/channel-relay/package.json`：RMUX/sidecar 依赖只在这里。
- `packages/channel-relay/README.md`、`docs/relay-module.md`：配置、依赖、生命周期和诊断。

### Relay Protocol

- `packages/relay-protocol/src/messages.ts`：instance terminal request/event names、capabilities。
- `packages/relay-protocol/src/messages.ts` 或拆分 DTO 文件：open/role/terminate/recovery shapes。
- `packages/relay-protocol/src/web-dtos.ts`：browser messages、targeted server events、strict validators。
- `packages/relay-protocol/src/limits.ts`：input/rebase/chunk/ID limits。
- 保持 `tsc` 构建并验证 dist barrel 运行时非空。

### Relay Hub

- `packages/relay/src/gateway/web-gateway.ts`：viewerId、socket attachment maps、targeted send、close detach、backpressure。
- `packages/relay/src/gateway/web-inbound.ts`：terminal request correlation、ownership gate、hub-stamped viewerId。
- `packages/relay/src/gateway/instance-gateway.ts`：终端低频请求/响应 + targeted event routing。
- `packages/relay/src/server.ts`：capability exposure 和接线。
- 终端流不得进入 turn accumulator 或历史数据库。

### Relay Web

- `packages/relay-web/src/api/events.ts`：request correlation、reconnect 后重 open active local terminal tabs。
- `packages/relay-web/src/stores/terminal.ts`：attachment state、controller role、recovery reducer、resync、terminate ack。
- `packages/relay-web/src/lib/terminal-adapter.ts`：ready/resetAndReplay/exact bytes。
- `packages/relay-web/src/components/TerminalTab.vue`：open/start-stream、heartbeat、role UI、global close。
- `packages/relay-web/src/views/DashboardView.vue`：close confirmation/ack；unmount 只 detach。
- 删除 RMUX backend 对 `lib/terminal-sessions.ts` 的身份依赖；server-side `openOrResume` 成为权威。
- i18n 增加 controller、spectator、take control、global close、cleanup pending、capacity、unavailable 文案。

## 22. 测试策略

### 22.1 Core tests

- 旧 state 缺 ID：一次性生成并持久化；第二次 load 不变化。
- save 失败：plugin/channel 不启动，内存不发布临时 ID。
- create/attach native/alias reuse/shared transport 的 ID 不变量。
- `SessionResourceCatalog.resolve` chat scope、cwd、archived、not-found。
- archive/remove/restore 所有入口都发一次正确 descriptor event；removed 带删除前 snapshot。
- listener throw 不回滚 session state。

### 22.2 Channel-relay runtime tests

使用 `InMemoryRmuxDriver` 从 `RelayTerminalRuntime` interface 测试 observable behavior，不穿透内部实现：

- open 创建、同 logicalSessionId resume、不同 logicalSessionId 隔离。
- alias 删除复用不接旧 terminal。
- creating/live/reaping 每个 crash point 的 restart reconciliation。
- explicit close、archive、delete、idle、disabled 的 terminate。
- kill timeout → cleanup-pending → later reconcile success。
- owner lease lost 后旧 runtime fencing。
- startup adopt within TTL；超过 TTL 后 gone。
- corrupt registry + tagged inventory 的 reconstruct/quarantine/reap。
- ambiguous/malformed tags fail closed。
- maxSessions/maxViewers/historyLimit。
- idle 只被 open/takeControl/input 刷新；output/resize/heartbeat 不刷新。
- first viewer controller、later viewer spectator、takeControl atomic demotion。
- spectator input/resize rejected。
- attachment TTL cleanup 不杀 terminal。
- sidecar crash/restart、recovery stream close、natural process exit。
- stop abandons lease而不立即 kill；explicit disable/logout 立即 kill。

### 22.3 RMUX/sidecar tests

在 RMUX 仓库或 sidecar package 使用真实 daemon：

- public adopt/fence/abandon/expiry contract。
- name rename/reuse/stable identity。
- `recover_output()` first rebase + bytes ordering。
- resize、alternate screen、clear-history、lag、process generation change 产生 rebase。
- non-UTF8/exact bytes round trip。
- keyframe chunking接近上限。
- input/resize per-terminal serialization。
- sidecar stdout framing、oversize、invalid base64、unexpected exit。

### 22.4 Protocol/hub tests

- 每个 DTO valid/invalid field、size limit、canonical base64。
- ownership gate：其他 account/instance/attachment 被拒绝。
- browser 自报 viewerId 被忽略；hub 盖章。
- two-phase open：映射建立后才 stream-start。
- socket close detach 全 attachments。
- targeted event 不广播给无 attachment socket。
- slow socket eviction 不影响其他 viewer或 terminal resource。
- requestId exactly-once response、timeout cleanup。
- connector/hub capability 新旧组合。

### 22.5 Relay-web tests

- real async adapter ready 前 replay 不丢。
- rebase reset 后重建，不能叠加旧 screen。
- chunk order/size/epoch/generation/sequence reducer。
- gap 后停止渲染并 resync；新 rebase 后恢复。
- refresh/reconnect 重新 `openOrResume` 同 terminal。
- spectator UI 禁止输入/resize；takeControl 后启用。
- controller 被接管后立即禁用输入。
- close with one viewer 直接 terminate；多 viewer 确认；取消不 terminate。
- terminate ack/cleanup-pending/offline/timeout UI。
- unmount、session switch、network disconnect 只 detach，绝不 terminate。
- 其他设备 terminal-exit 不自动创建新 shell。
- Tab layout 本地、terminal resource 共享。

### 22.6 End-to-end/fault matrix

至少手工或自动覆盖：

| 场景 | 预期 |
|---|---|
| shell 中运行 `vim`/`top` 后刷新 | 同一进程；完整正确画面；无叠屏。 |
| 输出期间断网再恢复 | rebase 后继续；无重复/缺口。 |
| A/B 两台机器打开同一会话 | 同 terminalId/generation；A controller、B spectator。 |
| B take control | A 立即变只读；PTY 尺寸由 B 控制。 |
| A 显式关 Tab且 B 在线 | 确认后 RMUX session kill；B 收 exit。 |
| A 只关浏览器窗口 | B 不退出；terminal 保留至 idle。 |
| archive/delete | daemon 可用时 5 秒内消失。 |
| kill 时 sidecar/RMUX 不可达 | logical close + tombstone；owner TTL 内消失。 |
| xacpx 重启小于 owner TTL | startup adopt，shell 保留。 |
| xacpx 停止超过 owner TTL | RMUX daemon 自动回收。 |
| crash 于 create 各写点 | 无无限 orphan；startup adopt 或 reap。 |
| crash 于 terminate 各写点 | tombstone/reconcile/lease 完成回收。 |
| alias 删除后同名新建 | 新 terminal；旧事件/attachment 无效。 |
| slow viewer/output flood | 只 evict slow viewer；hub/connector memory 有界。 |
| history 超限 | RMUX 按 historyLimit 淘汰；recovery 仍正确。 |
| RMUX daemon 重启 | registry 清 stale，web 显示 exited，下一次显式 open 新建。 |

## 23. 验证命令

实现过程中按改动范围运行，最终至少：

```bash
npx tsc --noEmit
npm test
bun run build:packages
cd packages/relay-web && npx vitest run
```

真实 RMUX integration/smoke 需要兼容的 RMUX 0.10 daemon 和 sidecar artifact；不得把需要真实基础设施的 smoke 混入普通 CI。发布前按 `docs/relay-release.md` 完成 package build、plugin 重装和真实 connector/hub/browser 验收。

## 24. 完成定义

只有以下条件全部满足，才能把 RMUX terminal 标为 production-ready：

- RMUX 依赖只存在于 channel-relay/plugin sidecar 分发链。
- logical session 不可变 ID 已迁移并覆盖所有生命周期入口。
- explicit Tab close 是 acknowledged global terminate；unmount/reload/network 只 detach。
- 同一 logical session 跨设备共享一个 terminal resource。
- controller/spectator 权限在实例侧强制执行。
- raw recovery rebase + exact bytes + epoch/sequence gap recovery 已端到端工作。
- browser adapter readiness/reset 竞态已修复。
- create/terminate write-ahead registry、owner lease 和 startup/periodic reconciliation 全部落地。
- archive/delete/idle/disabled/logout 都有回收路径和测试。
- orphan 生存时间在 sidecar/core 死亡后有 owner lease TTL 硬上限。
- session/viewer/history/frame/queue 都有硬上限。
- capability gating 支持新旧 hub/connector/web 混合升级。
- fault matrix 中的高风险场景已通过。
- 相关 `docs/*.md` 先于 AGENTS 导航更新，配置和运维诊断对用户可见。

## 25. 实施顺序与提交边界

为了让每个提交可验证、可回滚，按以下顺序实施；不要把跨仓库 SDK、核心 state migration、hub protocol 和 web renderer 塞进一个提交：

1. RMUX Rust SDK：adopt/fence/abandon public contract + tests。
2. Sidecar：versioned protocol、driver integration tests、dev artifact。
3. Core：`logical_session_id` migration。
4. Core：`SessionResourceCatalog` + lifecycle events + plugin-api 注入。
5. Relay protocol：capabilities、terminal request/targeted stream DTO/validators/limits。
6. Channel-relay：config、registry store、in-memory driver 和 runtime state machine。
7. Channel-relay：real sidecar adapter、lease、reconciler、lifecycle subscription。
8. Relay hub：viewer identity、two-phase request、targeted subscriptions/backpressure。
9. Relay-web：async-safe adapter + recovery reducer。
10. Relay-web：controller/spectator、reconnect、global close UX。
11. Cross-package integration/fault tests、docs、doctor、packaging。
12. 灰度开启 RMUX capability。
13. 达标后删除 relay 对 legacy core terminal 的调用；核心终端删除另开清理提交。

每一步必须保持构建通过。若前一步 interface 还未发布，可用 workspace dependency 联调，但不得用 `as any` 或复制 DTO 绕过版本契约。
