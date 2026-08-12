# Relay Web · RMUX 持久终端 Implementation Plan

> **给执行者：** 按任务顺序实施并逐项勾选。每个任务都是独立提交边界；除明确写为可并行的任务外，不跨任务偷跑接线。设计细节以 [`2026-08-10-relay-web-rmux-terminal-design.md`](../specs/2026-08-10-relay-web-rmux-terminal-design.md) 为准；若本计划与 spec 冲突，以 spec 为准并先修订本计划。

**Goal:** 用 RMUX 0.10 为 relay-web 提供可跨刷新、网络抖动和短时实例重启恢复的共享终端；消除恢复时画面叠加；把显式关闭终端 Tab 定义为有确认响应的全局终止；通过 durable registry、owner lease、reconciliation、idle/quota/attachment 上限保证实例侧不会积累无界孤儿终端。

**Architecture:** xacpx core 只提供不可变 logical session identity 和通用 `SessionResourceCatalog`；`packages/channel-relay` 独占 RMUX sidecar、terminal registry、viewer/controller、lease、GC 和 recovery stream；hub 只做鉴权、viewer identity、请求关联和定向路由；relay-web 只维护本地 Tab、recovery reducer 和 ghostty 渲染。生产热路径使用 Rust sidecar + `rmux-sdk`，不使用 `../rmux-typescript`，也不在 Node 中重写 RMUX wire protocol。

**Source repositories:**

- xacpx：本仓库。
- RMUX upstream：`../rmux`，只为 Rust SDK public adopt/fence/abandon contract 改动。
- `../rmux-typescript`：只作为已调研的历史参考；本计划不修改、不依赖。

**Tech stack:** TypeScript 6、Bun、Vue 3、Pinia、Vitest、WebSocket、Rust/Tokio、RMUX 0.10 Rust SDK、NDJSON sidecar、durable JSON registry。

## 已锁定的产品与架构决定

- 同一 instance 内，以 `logicalSessionId` 为唯一键，每个 logical session 最多一个 `live/creating` terminal resource；alias、display name 和 transport session 都不是资源身份。
- 同账号在不同机器主动打开同一会话的终端时，共享同一个 `terminalId + generation` 和 shell；本地 Tab 布局、当前选中 Tab 不跨设备同步。
- 第一个 attachment 是 controller，后续是 spectator；只有 controller 可以 input/resize，`takeControl` 在实例侧原子转移权限。
- 显式点击终端 Tab 的 `X` 或“终止终端”是全局 terminate；刷新、浏览器关闭、路由切换、会话切换、组件 unmount、网络抖动都只 detach。
- 会话进入“睡眠”或被删除时终止 terminal resource；唤醒不会复活旧 terminal。代码/RPC 继续使用 `archive/unarchive` 兼容拼写，用户可见文案使用仓库术语“睡眠/唤醒”。
- `RelayChannel.stop("shutdown")` 停止续租并 abandon-to-expiry，不立即 kill；`disabled/removed/logout` 必须先写 durable `reaping` 并尝试立即 kill。
- capability 在 sidecar handshake、RMUX capability 检查和 startup reconciliation 全部成功前不得声明；缺 capability 的 web 隐藏终端入口，不回退到 legacy core PTY。
- RMUX 依赖、sidecar 解析和平台 binary 依赖只存在于 channel-relay 的发布链；core package 不新增 RMUX 依赖。
- sidecar Rust 源码落在 `packages/channel-relay/native/rmux-bridge/`。正式依赖 pin 已发布的精确 `rmux-sdk 0.10.x`，不得提交指向 `../rmux` 的 path dependency。
- legacy `control.terminal.create/attach`、core `terminal-service` 和浏览器 terminal-id sessionStorage 在灰度达标前保留；切流后另开清理提交，不混入首个 production rollout。

## 全局实施规则

- 行为变更先写失败测试，再实现，再跑 focused tests；每个提交保持 build/typecheck 可通过。
- registry 的 `creating/live/reaping` 转换全部同步 durable write；禁止 debounce。`lastInputAt` 只允许最多 30 秒一次 checkpoint。
- 自动清理只能依据 name prefix、owner tag、terminal tag、generation 和 RMUX stable identity 的完整匹配；不确定时 fail closed，交给 owner lease 到期。
- browser payload 不接受 cwd、viewerId 或可信 owner identity；cwd 来自 core catalog，viewerId 由 hub 盖章。
- terminal output/input/rebase bytes 不进入 app log、turn accumulator 或历史数据库。
- 所有 queue/frame/history/session/viewer 都有硬上限；定时器可注入、生产实例 `unref()`，所有周期任务防重入。
- protocol 改动保持 additive；旧 connector/hub/web 混合版本必须安全降级为“终端不可用”。
- core 单测使用 `bun test <单文件>`；web 单测使用 `cd packages/relay-web && npx vitest run <文件>`，不要用 Bun 跑 Vitest。
- 不运行需要真实微信/acpx 的 `npm run test:smoke`。真实 RMUX 测试使用独立 opt-in gate，不混入普通单测。
- 文档中给出的 commit message 是提交边界，不要求一次执行整阶段。

## 依赖图与阻塞门槛

| 阶段 | 产物 | 阻塞关系 |
|---|---|---|
| A | RMUX public adopt/fence/abandon + 发布版本 | 真实 sidecar/driver 被阻塞；core/protocol/fake runtime 可并行 |
| B | logical ID、catalog、lifecycle/stop reason | channel-relay runtime 装配被阻塞 |
| C | wire DTO、capability、validator | hub/web/connector 接线被阻塞 |
| D | registry、fake driver、attachments、runtime/reconciler | 真实 driver 和 channel 接线被阻塞 |
| E | Rust sidecar、Node driver、platform resolution | capability 上线和真实 smoke 被阻塞 |
| F | channel、hub、web end-to-end | 灰度被阻塞 |
| G | fault tests、doctor、packaging、docs | production-ready 被阻塞 |

### Release gate A

在进入真实 sidecar Task 15 前，必须记录一个已发布的 `rmux-sdk 0.10.x` 精确版本，并满足：

- public API 可 adopt 既有 exact stable session identity；
- 新 lease 会 fence 旧 owner，旧 owner 可观察 `LeaseState::Lost`；
- abandon 只停止 heartbeat，不 release、不 kill；
- fake-daemon 和 real-daemon tests 均通过；
- release notes 明确该 contract，不能依赖 server 当前 `HashMap::insert` 的偶然行为。

### Release gate B

在 relay-web 显示入口前，connector 必须同时报告 `terminal.rmux.recovery.v1` 和 `terminal.multi-view.v1`，hub 必须把这组 capability 暴露给当前 instance，web 必须按 capability gating。任何一层未知/缺失都视为不可用。

---

## Phase A — RMUX upstream prerequisite

### Task 1: 为既有 Session 增加 public owned-session adoption

**Repository:** `../rmux`

**Files:**

- Modify: `crates/rmux-sdk/src/handles/owned_session.rs`
- Modify: `crates/rmux-sdk/src/handles/rmux.rs`
- Modify if exports change: `crates/rmux-sdk/src/handles/mod.rs`, `crates/rmux-sdk/src/lib.rs`
- Test: `crates/rmux-sdk/src/handles/owned_session/tests.rs`
- Test: `crates/rmux-sdk/tests/owned_session_lease_transport.rs`

- [ ] 先写 fake-daemon tests：adopt 不发送 `new-session`，只接受 exact live `Session`；解析并固定 stable `SessionId`；缺 capability、session gone、identity 不唯一时在 lease side effect 前失败。
- [ ] 将 `OwnedSessionBuilder` 的来源建模为 `create(name)` 或 `adopt(session)`，不要用可重定向的 name 重新 ensure。public surface 采用 `Rmux::adopt_owned_session(session)` 或等价清晰命名。
- [ ] adopt 的 cleanup、renew 和后续 kill 全部按 stable `SessionId`；rename 后仍作用于原 session，原 name 被新 session 复用时不得误杀新对象。
- [ ] creation-only rollback 只适用于 create 分支；adopt lease 创建失败不得杀掉调用者交入的既有 session。
- [ ] 更新 Rustdoc，明确 ownership transfer、failure ownership 和 stable identity 语义。
- [ ] Run: `cargo test -p rmux-sdk handles::owned_session`
- [ ] Run: `cargo test -p rmux-sdk --test owned_session_lease_transport`
- [ ] Run: `cargo fmt --check && cargo clippy -p rmux-sdk --all-targets -- -D warnings`
- [ ] Commit: `feat(sdk): adopt existing sessions by stable identity`

### Task 2: 把 fencing 与 abandon-to-expiry 变成公开契约

**Repository:** `../rmux`

**Files:**

- Modify: `crates/rmux-sdk/src/handles/owned_session.rs`
- Modify: `crates/rmux-sdk/src/handles/owned_session/lease.rs`
- Modify only if protocol semantics are insufficient: `crates/rmux-proto/src/request/session.rs`, `crates/rmux-server/src/handler_session/leases.rs`
- Test: `crates/rmux-sdk/src/handles/owned_session/tests.rs`
- Test: `crates/rmux-sdk/tests/owned_session_lease_transport.rs`
- Test if server changes: `crates/rmux-server/src/handler_tests/session_leases.rs`

- [ ] 写测试固定：第二个 owner adopt 同一 stable ID 后，第一个 owner进入 `Lost`；旧 token 的 renew/release 都不能影响新 lease。
- [ ] 增加 consuming API `abandon_to_lease_expiry()`：停止 renew task、disarm Drop kill、保留 daemon lease 到自然 TTL；不得发送 release 或 kill request。
- [ ] 验证 `cleanup()` 仍按 stable ID 幂等 kill；`preserve/detach_owned` 仍是显式 release，不能和 abandon 混淆。
- [ ] 覆盖 shutdown race、heartbeat 正在进行、double abandon 不可发生（consuming type）、rename/name reuse、daemon disconnect 和 lease lost observation。
- [ ] 若 server 当前 replacement 不能形成有文档的 fencing，增加显式 ownership generation/token 语义及相应 wire capability；不得只补 SDK 测试掩盖 server 偶然实现。
- [ ] Run focused SDK/server tests, then `cargo test -p rmux-sdk` and affected server tests.
- [ ] Run: `cargo fmt --check && cargo clippy -p rmux-sdk --all-targets -- -D warnings`
- [ ] Commit: `feat(sdk): fence and abandon owned session leases`

### Task 3: RMUX real-daemon contract gate 与兼容补丁发布

**Repository:** `../rmux`

**Files:**

- Modify/Test: `crates/rmux-sdk/tests/lifecycle.rs`
- Modify/Test as needed: `crates/rmux-sdk/tests/smoke_v1.rs`, `crates/rmux-sdk/tests/smoke_v1_windows.rs`
- Modify: RMUX SDK docs/changelog/release metadata used by that repository

- [ ] 增加真实 daemon 集成：create→adopt、第二 owner fence、abandon→TTL reap、rename、name reuse、explicit stable kill。
- [ ] 保留并运行 `recover_output()` real-daemon coverage，确认 first event 是 rebase，原始 bytes/epoch/sequence 可供 sidecar 直接透传。
- [ ] 在 Unix 和 Windows 的支持矩阵上验证 owner TTL；平台受限测试必须有明确 CI gate，不得用 mock 冒充。
- [ ] 按 RMUX release 流程发布一个精确 `0.10.x` patch，记录 crate 版本和需要的 daemon capability。
- [ ] 在本计划的实施 PR/issue 中记录发布版本；xacpx sidecar `Cargo.toml` 只能 pin 此已发布版本。
- [ ] Commit: `test(sdk): gate owned-session adoption against daemon`

---

## Phase B — Core identity and generic lifecycle seam

### Task 4: 持久化不可变 `logical_session_id`

**Files:**

- Modify: `src/state/types.ts`
- Modify: `src/state/state-store.ts`
- Modify: `src/sessions/session-service.ts`
- Test: `tests/unit/state/state-store.test.ts`
- Test: `tests/unit/state/state-store-quarantine.test.ts`
- Test: `tests/unit/sessions/session-service.test.ts`
- Test if startup ordering needs a seam: `tests/unit/main.test.ts`

- [ ] `LogicalSession.logical_session_id` 为 required UUIDv4 string；present-but-invalid 的记录按现有 quarantine policy 处理，只有旧记录的 missing field 进入 migration。
- [ ] `StateStore.load()` 给 missing ID 的旧 session 一次性生成 UUID，并在返回 state 前用 private atomic writer 同步保存；保存失败使 `buildApp` 失败，channel/plugin 不启动。
- [ ] `inspect()` 保持无写副作用；load report/doctor 能区分“迁移”与“丢弃损坏记录”。
- [ ] 所有 create/attach native 路径生成新 UUID；对同一现存 logical session 的普通更新、rename、display name、agent/workspace/transport binding 更新保持 ID。
- [ ] alias 删除后同名新建必须得到不同 ID；两个 alias 即使共享 transport session 也得到不同 ID。
- [ ] 测试第二次 load 不再变更 ID，迁移保存失败不发布临时 ID。
- [ ] Run focused state/session/main tests and `npx tsc --noEmit`.
- [ ] Commit: `feat(sessions): persist immutable logical session ids`

### Task 5: 新增 `SessionResourceCatalog`

**Files:**

- Create: `src/sessions/session-resource-catalog.ts`
- Modify: `src/sessions/session-service.ts`
- Modify: `src/main.ts`
- Modify: `src/channels/types.ts`
- Modify: `src/plugin-api.ts`
- Test: `tests/unit/sessions/session-resource-catalog.test.ts`
- Test: `tests/unit/plugins/plugin-api-types.test.ts`
- Test: `tests/unit/run-console.test.ts`

- [x] 精确实现 spec §7.2 的 `SessionResourceDescriptor`、lifecycle union 和 catalog interface；命名不得出现 terminal/RMUX。
- [x] `resolve(chatKey, alias)` 复用 core 权威 chat-scope alias 解析，拒绝跨 channel alias；`cwd` 从 workspace config 解析，浏览器输入不参与。
- [x] `list("relay")` 同时返回 active 和 archived relay sessions；结果包含 internal/display alias 和 immutable ID。
- [x] 在 `AppRuntime` 暴露 catalog，并由 `runConsole` 注入 `ChannelStartInput.sessionResources`。
- [x] `plugin-api` 只导出 interface/type，不导出生产 adapter 或 SessionService 内部状态。
- [x] 单测覆盖 scope、display alias、cwd、archived、missing workspace/session 和 list 过滤。
- [ ] Run focused tests, `npx tsc --noEmit`, and `bun run build:plugin-api`.
- [ ] Commit: `feat(plugin-api): expose session resource catalog`

### Task 6: 让 session lifecycle 事件具备 durability ordering

**Files:**

- Modify: `src/sessions/session-service.ts`
- Modify: `src/sessions/session-resource-catalog.ts`
- Test: `tests/unit/sessions/session-service.test.ts`
- Test: `tests/unit/sessions/session-resource-catalog.test.ts`
- Test: `tests/unit/control/control-service-sessions.test.ts`
- Test: `tests/unit/commands/session-archive-delete.test.ts`
- Test: `tests/unit/sessions/session-archived.test.ts`

- [x] 把 archive、automatic restore/use、explicit unarchive、remove 的 state transition 改成 copy-on-write + `saveNow(nextState)`；成功后发布 runtime state，再发 lifecycle event。
- [x] `removed` 携带删除前 descriptor snapshot；每个逻辑操作恰好发一次事件，所有 control/command 入口收敛到同一路径。
- [x] durable save 失败时 state、chat context 和 event stream 都不变化。
- [x] listener throw 被隔离并写 app log，不回滚已持久化操作，也不阻断其他 listener。
- [x] 测试“睡眠→终止”“唤醒不复活”的事件语义；代码断言仍使用 archive/restored 标识。
- [x] Run focused tests and `npx tsc --noEmit`.
- [x] Commit: `feat(sessions): publish durable resource lifecycle events`

### Task 7: 通用 channel stop reason 与 async destructive cleanup

**Files:**

- Modify: `src/channels/types.ts`
- Modify: `src/channels/channel-registry.ts`
- Modify: `src/run-console.ts`
- Modify: `src/cli.ts`
- Modify: `src/channels/cli/channel-cli.ts`
- Modify as needed: `src/channels/weixin-channel.ts`
- Test: `tests/unit/channels/channel-registry.test.ts`
- Test: `tests/unit/run-console.test.ts`
- Test: channel CLI focused tests under `tests/unit/channels/`

- [ ] 增加 `ChannelStopReason = "shutdown" | "disabled" | "removed" | "logout"`；`stop(reason?)` 与 `logout()` 均允许 sync/async，旧 plugin 保持兼容。
- [ ] `stopAll()` 接受 reason，普通 signal/startup-error cleanup 传 `shutdown`；所有调用点 `await`。
- [ ] channel disable/remove CLI 在丢掉旧 options 前调用一个通用 async retirement hook：relay 可用原 config 启动 one-shot maintenance cleanup，其他 channel 默认 no-op。
- [ ] remove 的顺序固定为 terminal retirement→config save→可选 credential cleanup→restart；retirement 失败时不删除 config。disable 不删除 credential。
- [ ] `logout()` 调用点全部 await；credential 只能在 resource 已进入 durable `reaping` 后删除。
- [ ] 测试 sync legacy channel、async channel、reason 传递、one channel failure 隔离、remove/disable ordering。
- [ ] Run focused tests and `npx tsc --noEmit`.
- [ ] Commit: `feat(channels): add reasoned asynchronous shutdown`

---

## Phase C — Relay protocol and capability contract

### Task 8: 定义 RMUX terminal DTO、消息名、错误码和硬限制

**Files:**

- Modify: `packages/relay-protocol/src/messages.ts`
- Modify: `packages/relay-protocol/src/web-dtos.ts`
- Modify: `packages/relay-protocol/src/dtos.ts`
- Modify: `packages/relay-protocol/src/limits.ts`
- Modify: `packages/relay-protocol/src/payload-validators.ts`
- Modify if needed: `packages/relay-protocol/src/validate-primitives.ts`, `packages/relay-protocol/src/index.ts`
- Test: `tests/unit/packages/relay-protocol/messages.test.ts`
- Test: `tests/unit/packages/relay-protocol/web-dtos.test.ts`
- Test: `tests/unit/packages/relay-protocol/terminal-dtos.test.ts`
- Test: `tests/unit/packages/relay-protocol/payload-validators.test.ts`

- [x] 增加 spec §14.2–14.4 的 browser↔hub、hub↔connector request/event union 和 `TerminalOpenResult/RoleResult/TerminateResult`。
- [x] 定义 capability 常量、稳定 error-code union、ID/cols/rows/input/rebase/queue 上限；decoded rebase chunk 固定 48 KiB，total rebase 最大 2 MiB，input 最大 64 KiB。
- [x] 错误码至少固定为：`terminal-disabled`、`terminal-rmux-unavailable`、`terminal-session-not-found`、`terminal-session-archived`、`terminal-capacity-exceeded`、`terminal-viewer-capacity-exceeded`、`terminal-terminating`、`terminal-attachment-not-found`、`terminal-generation-mismatch`、`terminal-not-controller`、`terminal-recovery-too-large`、`terminal-protocol-error`、`terminal-timeout`、`instance-offline`。
- [x] canonical base64 validator 必须先做 encoded length bound，再 decode，再 round-trip 校验，避免大 payload/非 canonical 等价字符串。
- [x] `instance.terminal.open/take-control/resync/terminate` 是 req/res；`stream-start/input/resize/heartbeat/detach` 是 event；viewer/resource event 方向不可混用。
- [x] validators 拒绝 browser 自报 viewerId/cwd、unknown fields（按当前协议严格度）、invalid generation/size/index/count/sequence。
- [x] 协议保持 additive；legacy terminal DTO 暂留但新 capability 路径不使用。
- [x] Run focused tests, `bun run build:relay-protocol`, and `bun run assert:relay-protocol`.
- [x] Commit: `feat(relay-protocol): define recoverable terminal wire contract`

### Task 9: 在 instance handshake 和 dashboard DTO 中传播 capability

**Files:**

- Modify: `packages/relay-protocol/src/messages.ts`
- Modify: `packages/relay-protocol/src/web-dtos.ts` or the current instance DTO owner
- Modify: `packages/channel-relay/src/relay-client.ts`
- Modify: `packages/relay/src/db.ts`
- Modify: `packages/relay/src/stores/instances.ts`
- Modify: `packages/relay/src/gateway/instance-gateway.ts`
- Modify: relay HTTP instance-list mapping in `packages/relay/src/http/app.ts`
- Modify: `packages/relay-web/src/stores/instances.ts`
- Test: `tests/unit/packages/relay-protocol/web-dtos.test.ts`
- Test: `tests/unit/packages/relay/stores-instances.test.ts`
- Test: `tests/unit/packages/relay/gateway/instance-gateway-status.test.ts`
- Test: `packages/relay-web/src/__tests__/instances.test.ts`

- [x] `InstanceRegisterPayload`、`InstanceAuthPayload` 和 instance dashboard DTO 增加 `capabilities?: string[]`；旧 payload 缺失时归一化为空数组。
- [x] DB 增加 additive `capabilities_json` migration；每次 auth 用 connector 当前完整集合替换旧值，断线后保留最后已知集合供诊断，但 web 同时检查 `online`。
- [x] 只接受已知、去重、有数量/长度上限的 capability；未知值可保留用于前向兼容，但不能被本版本解释为 terminal 支持。
- [x] RelayClient handshake 在构造时接收已确认的 capability snapshot；runtime 未 ready 时不得先连 hub 再补报。
- [x] web helper `supportsRmuxTerminal(instance)` 要求 online + 两个 capability，所有入口共用该 helper。
- [x] Run focused protocol/hub/web tests and affected typechecks.
- [x] Commit: `feat(relay): propagate connector capabilities`

---

## Phase D — Channel-relay deep runtime with fake driver

### Task 10: 解析 plugin-owned terminal config

**Files:**

- Modify: `packages/channel-relay/src/config.ts`
- Modify: `packages/channel-relay/src/relay-provider.ts`
- Test: `tests/unit/packages/channel-relay/config.test.ts`
- Test: `tests/unit/packages/channel-relay/provider.test.ts`

- [x] 实现 spec §8.1 全部默认值、范围和交叉约束；`enabled` 默认 false，backend 只允许 `rmux`。
- [x] `orphanGraceSeconds >= ownerLeaseTtlSeconds`；bridge/rmux command 只接受非空绝对路径或明确的 command policy，不通过 shell 拼接。
- [x] CLI summary 隐去敏感值，显示 terminal backend/enabled/TTL/quota；add flow 不默认启用 terminal。
- [x] config 对象 immutable/normalized，后续 runtime 不再读取 raw options。
- [x] Run focused tests and `npx tsc -p packages/channel-relay/tsconfig.json --noEmit`.
- [x] Commit: `feat(channel-relay): parse rmux terminal configuration`

### Task 11: 实现 durable terminal owner 与 registry store

**Files:**

- Create: `packages/channel-relay/src/terminal/terminal-registry-store.ts`
- Create: `packages/channel-relay/src/terminal/terminal-types.ts`
- Test: `tests/unit/packages/channel-relay/terminal-registry-store.test.ts`

- [x] 精确实现 spec §10.1 schema：owner file、revision、`creating/live/reaping`、stable IDs、reason；viewer/controller/cursor 不持久化。
- [x] owner `installationId` 一次生成、mode 0600、与 hub instanceId 解耦；并发启动不能各自生成不同 owner。
- [x] owner file missing 只在 fresh install 创建；owner file 损坏/丢失但 registry 非空时 terminal runtime fail closed，不生成新 namespace 覆盖 cleanup evidence。registry 为空时可生成新 owner，旧 namespace只能等待原 lease TTL。
- [x] mutation 串行、copy-on-write、同目录唯一 temp、file flush/fsync、atomic rename、rename 后发布内存 snapshot；写失败内存不变。
- [x] whole-file corruption best-effort rename `.corrupt-*`，进入 `inventoryUncertain` 状态；不得把空文件当作“可安全删除全部”。
- [x] 提供 revision-fenced mutation/API，不让 reconciler 直接写内部 map。
- [x] fault tests 覆盖每个 write/flush/rename crash point、并发 mutation、revision monotonic、permissions、corrupt backup failure。
- [x] Run focused test and channel-relay typecheck.
- [x] Commit: `feat(channel-relay): add durable terminal registry`

### Task 12: 定义 driver seam、fake driver 与 attachment registry

**Files:**

- Create: `packages/channel-relay/src/terminal/rmux-driver.ts`
- Create: `packages/channel-relay/src/terminal/in-memory-rmux-driver.ts`
- Create: `packages/channel-relay/src/terminal/terminal-attachments.ts`
- Test: `tests/unit/packages/channel-relay/rmux-driver.test.ts`
- Test: `tests/unit/packages/channel-relay/terminal-attachments.test.ts`

- [x] `RmuxTerminalDriver` 只暴露 create/adopt/list/kill/input/resize/recover/stopRenewing/diagnostics；driver DTO 保留 stable session/pane ID、tags、raw bytes、epoch/sequence。
- [x] fake driver 可注入每个 operation 的 delay/failure/crash、lease lost、natural exit、lag/rebase 和 inventory；测试只通过 public runtime observable behavior 操作它。
- [x] attachment 绑定 `(viewerId, terminalId, generation)`；ID 随机不可预测；viewer/controller/recovery cursor 只在内存。
- [x] first viewer 自动 controller；后续 spectator；takeControl 原子降级旧 controller；spectator input/resize 在 registry 层拒绝。
- [x] attach/detach/takeControl/TTL expiry 都重新计算 viewerCount，并向受影响 attachments 发 role-changed；controller 离开后保持“无 controller”，不暗中随机提升 spectator。
- [x] TTL、heartbeat、detach、max viewers、socket disconnect bulk detach 都不 kill terminal，也不刷新 resource idle。
- [x] per-attachment outbound queue 以 bytes 硬限；溢出关闭该 stream并要求 resync，不阻塞其他 viewer。
- [x] Run focused tests and channel-relay typecheck.
- [x] Commit: `feat(channel-relay): model rmux drivers and terminal viewers`

### Task 13: 实现 `RelayTerminalRuntime` 创建、恢复与终止事务

**Files:**

- Create: `packages/channel-relay/src/terminal/terminal-runtime.ts`
- Test: `tests/unit/packages/channel-relay/terminal-runtime.test.ts`
- Test support: reuse `in-memory-rmux-driver.ts`

- [x] 对外 interface 与结果类型精确匹配 spec §9；per-logical-session lock 和 per-terminal lock 分离，lock order 写入模块注释并测试无反向获取。
- [x] open：catalog resolve/scope/archive 校验→按 logical ID 幂等 resume→quota→durable creating→driver create+lease→durable live→paused attachment→response。
- [x] RMUX name 固定为 `xacpx-relay-<installation-short>-<terminal-uuid-without-dashes>`；tags 精确包含 `xacpx:relay`、`owner:<installationId>`、`logical:<logicalSessionId>`、`terminal:<terminalId>`、`generation:<generation>`、`schema:1`。
- [x] quota 到达 `maxSessions` 时只先处理 expired/reaping；仍满则返回 `terminal-capacity-exceeded`，禁止 LRU-kill 未过期 resource。一个 logical ID 已有 creating/live 时绝不并发创建第二个。
- [x] open cancellation/deadline 后不得留下无记录 side effect：补偿 kill，失败则 durable reaping；caller 不能普通 timeout 后重试创建第二 resource。
- [x] recovery 只在 `startRecovery(attachmentId)` 建 stream；first frame 必须 rebase；48 KiB chunking 保留 raw bytes/epoch/sequence。
- [x] input/resize/takeControl/resync 同时校验 attachment、viewer binding、terminal、generation、controller role；所有 mutation 在 lease lost 后 fence。
- [x] terminate：先 durable reaping→拒绝新操作→停止 streams/续租→向 viewers 发 exit→stable kill（最多 5 秒）→absent 后删 record；timeout 返回 cleanup-pending。
- [x] natural shell exit 转 `reaping(exited)` 并发 exit；terminate/retry/already-gone 幂等。
- [x] idle 仅由成功 open/resume、takeControl 和 controller input 刷新；output/heartbeat/普通 attach/resize 不刷新。
- [x] 测试 alias reuse/shared transport、generation stale frame、create/terminate 每个 crash point、capacity/history limit 和所有稳定错误码。
- [x] Run focused runtime test and channel-relay typecheck.
- [x] Commit: `feat(channel-relay): add durable relay terminal runtime`

### Task 14: Startup/periodic reconciliation 与 orphan quarantine

**Files:**

- Create: `packages/channel-relay/src/terminal/terminal-reconciler.ts`
- Modify: `packages/channel-relay/src/terminal/terminal-runtime.ts`
- Test: `tests/unit/packages/channel-relay/terminal-reconciler.test.ts`

- [x] 按 spec §12.4 实现完整 mark-and-sweep；catalog、registry 或 inventory 任一不完整时，本轮 destructive GC fail closed。
- [x] startup 处理 creating/live/reaping 全矩阵；live 在 hub connect 前 adopt lease；超过 TTL 已 gone 时清 record并发资源退出状态。
- [x] inventory-only 合法 owner session 先持久化 quarantine first-seen；只有 tags 唯一映射 active logical session 时可重建/adopt，否则两轮且超过 grace 后再 kill。
- [x] quarantine 不引入未定义的第四种 resource state：把完整合法 tags 重建为 durable `creating` record，`createdAt` 作为 first-seen；下一轮只能转 live 或 reaping。tags 不完整时不能伪造 record，也不能 kill。
- [x] malformed/ambiguous tags、name prefix mismatch、stable ID mismatch 只记录诊断并等待 lease，不猜测 kill。
- [x] GC kill 前在 per-terminal lock 内重新读取 revision，并再次核对 terminalId/generation/stable ID/state。
- [x] periodic task 防重入、可注入 clock/timer、unref；`stop()` 等待 active pass 或安全取消。
- [x] owner lease lost 会立即 fence driver mutation和 streams；旧 runtime 不能 kill 被新 owner adopt 的 resource。
- [x] 测试 corrupt registry、missing catalog、inventory failure、sidecar outage、kill timeout→later success、restart within/after TTL。
- [x] Run focused reconciler/runtime tests and channel-relay typecheck.
- [x] Commit: `feat(channel-relay): reconcile rmux terminal ownership`

---

## Phase E — Rust sidecar and production driver

### Task 15: 建立 versioned、bounded sidecar protocol

**Depends on:** Release gate A；`Cargo.toml` pin 已发布 `rmux-sdk = "=<version>"`。

**Files:**

- Create: `packages/channel-relay/native/rmux-bridge/Cargo.toml`
- Create: `packages/channel-relay/native/rmux-bridge/src/main.rs`
- Create: `packages/channel-relay/native/rmux-bridge/src/protocol.rs`
- Create: `packages/channel-relay/native/rmux-bridge/src/actors.rs`
- Create: focused Rust unit/integration tests in the same crate
- Modify: repository build/test scripts only as required to expose explicit sidecar commands

- [ ] handshake 返回 bridge version、RMUX wire version、daemon capabilities；不兼容时退出 non-zero，stdout 不输出半合法帧。
- [ ] stdin/stdout 使用 versioned NDJSON，每行/request/outstanding/rate/base64 decoded bytes 有硬上限；每个 request ID exactly once response。
- [ ] stdout 只写协议，日志只写 stderr；错误响应经过 redaction，不含 cwd、env、terminal bytes、credential 或原始 sidecar stderr。
- [ ] 每个 terminal actor 串行 input/resize/recovery/kill；不同 terminal 可并行且有总并发上限。
- [ ] commands 覆盖 create/adopt/list/kill/input/resize/recover/stop-renewing/diagnostics；events 保留 raw epoch/sequence/bytes。
- [ ] create 使用 scrubbed env：沿用 core 现有敏感 denylist 语义，并额外移除 `XACPX_*`、relay credential 和 bridge 内部变量。
- [ ] malformed JSON、oversize、invalid base64、duplicate ID、stdout contamination、request cancellation、stdin EOF 都有测试。
- [ ] Run: `cargo test --manifest-path packages/channel-relay/native/rmux-bridge/Cargo.toml`
- [ ] Run: `cargo fmt --manifest-path packages/channel-relay/native/rmux-bridge/Cargo.toml --check`
- [ ] Run: `cargo clippy --manifest-path packages/channel-relay/native/rmux-bridge/Cargo.toml --all-targets -- -D warnings`
- [ ] Commit: `feat(channel-relay): add rmux rust bridge protocol`

### Task 16: 用真实 RMUX SDK 实现 sidecar actors

**Files:**

- Modify: `packages/channel-relay/native/rmux-bridge/src/actors.rs`
- Add: real-daemon integration tests/fixtures in the sidecar crate

- [ ] create detached session时设置 cwd、size、history limit、tags、scrubbed env 和 owner lease，并返回 stable session/default pane IDs。
- [ ] adopt exact stable identity；lease state watch 产生 lost event；stop-renewing 调用 public abandon-to-expiry。
- [ ] recover 使用 `Pane::recover_output()`；first rebase、resize、alternate screen、clear-history、lag、process generation change均原样映射。
- [ ] input/resize 使用 stable pane identity；kill 使用 stable session identity；name reuse 测试证明旧命令不能落到新 session。
- [ ] exact non-UTF8 bytes round-trip；keyframe 接近 2 MiB 边界和超过上限行为明确。
- [ ] sidecar crash/restart 小于 owner TTL 可 adopt；超过 TTL 资源已 gone。
- [ ] 将真实测试标为独立 `XACPX_RMUX_INTEGRATION=1` gate；普通 CI 不自动启动外部 daemon。
- [ ] Run unit tests always；在具备 RMUX 0.10 daemon 的发布环境运行 integration suite。
- [ ] Commit: `feat(channel-relay): drive rmux sessions from rust bridge`

### Task 17: Node sidecar driver、监督器与 binary resolution

**Files:**

- Create: `packages/channel-relay/src/terminal/rmux-sidecar-driver.ts`
- Create: `packages/channel-relay/src/terminal/rmux-sidecar-supervisor.ts`
- Create: `packages/channel-relay/src/terminal/resolve-rmux-binaries.ts`
- Test: `tests/unit/packages/channel-relay/rmux-sidecar-driver.test.ts`
- Test: `tests/unit/packages/channel-relay/rmux-sidecar-supervisor.test.ts`
- Test helpers: fake executable/stdio fixtures under `tests/helpers/`

- [ ] driver 解析 NDJSON 时先限长再 JSON/base64 decode；unknown/duplicate/late response、invalid event 和 stdout 噪声都视为 protocol violation。
- [ ] pending request 有 deadline/cancellation/exactly-once settlement；sidecar exit 原子拒绝全部 pending 并关闭 streams。
- [ ] per-attachment event queue 有 byte cap；Node 不把 bytes 转 UTF-8，统一 `Uint8Array`/base64 boundary。
- [ ] supervisor 使用有界指数退避且单实例重启；stop 不再重启；每次重启必须重新 handshake、reconcile/adopt 后才恢复 capability。
- [ ] resolution 顺序固定：显式 bridge config→plugin platform package→`terminal-rmux-unavailable`；RMUX binary 为显式 config→bundled/sibling compatible→PATH。
- [ ] binary 执行使用 argv/spawn，不经过 shell；校验 platform/arch/version/checksum。
- [ ] 测试 crash loop、partial frame、oversize、backpressure、restart within/after lease TTL 和 shutdown during restart。
- [ ] Run focused tests and channel-relay typecheck/build.
- [ ] Commit: `feat(channel-relay): supervise the rmux bridge`

---

## Phase F — Connector, hub and web wiring

### Task 18: 把 terminal runtime 接入 RelayChannel

**Files:**

- Modify: `packages/channel-relay/src/channel.ts`
- Modify: `packages/channel-relay/src/control-bridge.ts`
- Modify: `packages/channel-relay/src/relay-client.ts`
- Modify: `packages/channel-relay/src/index.ts`
- Modify: `packages/channel-relay/package.json`
- Test: `tests/unit/packages/channel-relay/channel.test.ts`
- Test: `tests/unit/packages/channel-relay/control-bridge.test.ts`
- Test: `tests/unit/packages/channel-relay/channel-relay-plugin.test.ts`

- [x] `start()` 要求 `sessionResources`，按 owner/registry→sidecar handshake→catalog/inventory reconcile→RelayClient connect 顺序启动。
- [x] 只有 runtime ready 后 handshake 声明两个 terminal capability；terminal disabled/unavailable 时 relay 的其余聊天/控制能力仍可启动。
- [x] 新 terminal request/event 路由到 runtime；不再在 RMUX capability path 调用 core `createTerminal/attachTerminal/writeTerminal/...`。
- [x] connector outbound viewer event 携带 hub-stamped viewerId + attachmentId；resource exit 携带 terminalId + generation。
- [x] hub WebSocket disconnect 回调 bulk detach 当前 connection 的 attachments，但保持 owner lease、idle 和 reconciler。
- [x] catalog archived/removed event 调 `retireLogicalSession`；restored 只更新 catalog view，不创建/复活 terminal。
- [x] `stop("shutdown")` abandon；disabled/removed/logout durable terminateAll；one-shot maintenance cleanup 可在未连接 hub 时工作。
- [x] bump plugin `minXacpxVersion` 到含 catalog/stop reason 的首个 core 版本；package 依赖不向 core 泄漏 RMUX。
- [x] Run focused tests, `bun run build:channel-relay`, and root typecheck.
- [x] Commit: `feat(channel-relay): own relay rmux terminal lifecycle`

### Task 19: Hub viewer identity、attachment maps 与定向 fanout

**Files:**

- Modify: `packages/relay/src/gateway/web-gateway.ts`
- Modify: `packages/relay/src/gateway/instance-gateway.ts`
- Modify: `packages/relay/src/server.ts`
- Test: `tests/unit/packages/relay/gateway/web-gateway.test.ts`
- Test: `tests/unit/packages/relay/terminal-gateway.test.ts`
- Test: `tests/unit/packages/relay/web-ws-integration.test.ts`

- [x] 每个 authenticated browser socket 生成随机 viewerId；browser 自报字段不存在/被 validator 拒绝。
- [x] WebGateway 维护 socket→attachments、attachment→socket、terminal→attachments；bind/unbind API 在一个同步 critical section 内更新双向 map。
- [x] `sendToAttachment(viewerId, attachmentId, event)` 发送前重新验证二元组仍属于当前 socket；stale connector frame 丢弃。
- [x] resource-exit 只 fanout 当前 terminal attachments；新 terminal stream 不走 account broadcast/subscription path。
- [x] socket close 清 maps并 best-effort 给 connector 发 detach；漏发由 attachment TTL 兜底。
- [x] slow socket 超过 bufferedAmount 阈值只 evict 该 viewer并 detach，其他 viewer/resource 不受影响。
- [x] connector reconnect/supersede fencing 对 pending terminal RPC 与旧 viewer events 同样生效。
- [x] Run focused hub tests and `npx tsc -p packages/relay/tsconfig.json --noEmit`.
- [x] Commit: `feat(relay): route terminal streams to attached viewers`

### Task 20: Hub 两阶段 open、低频 RPC 和 ownership gate

**Files:**

- Modify: `packages/relay/src/gateway/web-inbound.ts`
- Modify: `packages/relay/src/gateway/instance-gateway.ts`
- Modify: `packages/relay/src/gateway/web-gateway.ts`
- Modify: `packages/relay/src/server.ts`
- Test: `tests/unit/packages/relay/terminal-web-inbound.test.ts`
- Test: `tests/unit/packages/relay/terminal-gateway.test.ts`
- Test: `tests/unit/packages/relay/integration.test.ts`

- [x] browser open/take-control/resync/terminate 全部经过 account→instance ownership gate和 10 秒 req/res；instance offline 返回稳定 code。
- [x] open response 成功后，先 bind socket↔attachment，再发送 `terminal-opened`；只有 browser 后续 `stream-start` 才通知 connector recover。
- [x] 若发送 opened 失败，立即 unbind/detach；若 browser 不发 stream-start，attachment TTL 收尾。
- [x] input/resize/heartbeat/detach 必须验证 attachment 当前属于此 socket，再盖 viewerId转发；generation 保持原值。
- [x] requestId response exactly once；timeout/disconnect 清 pending。open timeout 的 connector 侧补偿/tombstone结果不得被 hub当普通成功重放。
- [x] terminate ack 的 `terminated/cleanup-pending` 都原样回 web；不能把 fire-and-forget close 当成功。
- [x] terminal frames 不进入 SQLite messages/state snapshot/turn accumulator。
- [x] Run focused tests, hub typecheck, and `bun run build:relay` after web tasks land.
- [x] Commit: `feat(relay): coordinate terminal attachment requests`

### Task 21: 修正 ghostty adapter readiness、reset 与 exact bytes

**Files:**

- Modify: `packages/relay-web/src/lib/terminal-adapter.ts`
- Test: `packages/relay-web/src/__tests__/terminal-adapter.test.ts`

- [x] interface 增加 `ready()` 和 `resetAndReplay(Uint8Array, cols, rows)`；`write` 接受 `Uint8Array`，不得 UTF-8 round-trip。
- [x] factory ready 前的必要 write/resize/theme/replay 排队或 await，不再 silent no-op。
- [x] rebase 先 reset emulator/grid/scrollback，再 resize，再写 keyframe；不能在旧 screen 上 append。
- [x] reset/replay 串行；其间 live bytes 按 sequence 暂存，完成后顺序 flush。
- [x] dispose 可安全取消 pending ready/replay/flush，无 unhandled rejection、double dispose 或 late canvas mutation。
- [x] 用真实异步 fake factory 测 ready-before/after-dispose、rebase during live write、alternate screen 和二进制 bytes。
- [x] Run: `cd packages/relay-web && npx vitest run src/__tests__/terminal-adapter.test.ts`
- [x] Run: `cd packages/relay-web && npx vue-tsc --noEmit`
- [x] Commit: `fix(relay-web): make terminal replay reset-safe`

### Task 22: 实现 web request client 与 recovery reducer/store

**Files:**

- Modify: `packages/relay-web/src/api/events.ts`
- Rewrite terminal state path in: `packages/relay-web/src/stores/terminal.ts`
- Create if it keeps the store deep: `packages/relay-web/src/lib/terminal-recovery.ts`
- Test: `packages/relay-web/src/__tests__/events.test.ts`
- Test: `packages/relay-web/src/__tests__/terminal-store.test.ts`
- Create/Test: `packages/relay-web/src/__tests__/terminal-recovery.test.ts`

- [x] events client 提供 requestId generator + pending map + deadline；socket close/reconnect reject pending并通知 store重开 active local terminal tabs。
- [x] store 以 local tab/session key 管理 attachment metadata，而不是用 persisted terminalId 作为服务端身份。
- [x] 精确实现 spec §14.6 reducer：waiting/rebase/live/resyncing/exited、epoch/sequence/chunk index/decoded bytes/generation 全校验。
- [x] gap、duplicate epoch、bad chunk/base64、generation mismatch、adapter failure 后停止渲染并发一次 resync；新 rebase 完成前不再接受 bytes。
- [x] open metadata 到达后发送 stream-start；reconnect 重新 openOrResume，同 logical session 得到同 terminal resource但新 attachment。
- [x] input/resize 仅 controller 状态允许发送；role-changed 立即更新双方；server 仍是最终权限边界。
- [x] heartbeat 每 10 秒，仅 attachment open 时运行；页面/route unmount发送 best-effort detach，不发 terminate。
- [x] terminate 等待 ack，offline/timeout保留本地 Tab和重试状态。
- [x] Run focused Vitest files and vue typecheck.
- [x] Commit: `feat(relay-web): recover rmux terminal attachments`

### Task 23: TerminalTab controller/spectator、全局 close 与 capability UX

**Files:**

- Modify: `packages/relay-web/src/components/TerminalTab.vue`
- Modify: `packages/relay-web/src/views/DashboardView.vue`
- Modify: `packages/relay-web/src/components/CenterTabStrip.vue` if close pending UI belongs there
- Modify: `packages/relay-web/src/stores/center-tabs.ts`
- Modify: `packages/relay-web/src/lib/session-terminal.ts`
- Modify/deprecate: `packages/relay-web/src/lib/terminal-sessions.ts`
- Modify: `packages/relay-web/src/i18n/messages/en.ts`
- Modify: `packages/relay-web/src/i18n/messages/zh-CN.ts`
- Test: `packages/relay-web/src/__tests__/terminal-tab.test.ts`
- Test: `packages/relay-web/src/__tests__/dashboard-center-tabs.test.ts`
- Test: `packages/relay-web/src/__tests__/center-tabs.test.ts`
- Test: `packages/relay-web/src/__tests__/session-terminal.test.ts`
- Test: `packages/relay-web/src/__tests__/i18n-parity.test.ts`

- [x] capability 缺失/instance offline 时隐藏或禁用 Terminal 入口，不调用 legacy create/attach。
- [x] 恢复的本地 terminal Tab 自动 openOrResume；删除 `autostart:false` 的 legacy PTY占位语义和 RMUX backend 对 `xacpx.terminal-ids.v1` 的身份依赖。
- [x] UI 显示 controller/spectator、viewerCount 和 take-control；spectator 禁用键盘、paste、shortcut input 和 backend resize。
- [x] close 单 viewer 可直接确认动作；`viewerCount > 1` 必须明确提示“会终止所有设备上的共享终端”。取消不发请求。
- [x] close pending 时 Tab 不消失且防 double submit；terminated 关闭 Tab；cleanup-pending 关闭 Tab并 toast；offline/timeout保留 Tab并允许重试。
- [x] session switch/unmount/refresh/pagehide/network close 只 detach；删除 Dashboard archive/delete 前的 browser-side kill，改由 core lifecycle→channel-relay retirement 单一路径。
- [x] 收到其他设备触发的 resource exit，当前 view 标 exited/清 attachment，不自动创建替代 shell。
- [x] local tab persistence仍只保存布局；同一终端是否在另一台机器打开不自动同步 UI。
- [x] 清理旧 `xacpx.terminal-ids.v1` 条目作为一次性 best-effort migration；legacy core PTY attach 失败不猜测 alias 迁移。
- [x] Run focused Vitest files, full relay-web test suite, and vue typecheck.
- [x] Commit: `feat(relay-web): add shared terminal control and global close`

---

## Phase G — Lifecycle completion, fault coverage and release

### Task 24: 实例 disable/remove/logout 与 daemon shutdown end-to-end

**Files:**

- Modify: `packages/channel-relay/src/channel.ts`
- Modify: `packages/channel-relay/src/relay-provider.ts` if maintenance cleanup is exposed there
- Modify: `src/channels/cli/channel-cli.ts`
- Modify: `src/cli.ts`
- Test: `tests/unit/packages/channel-relay/channel.test.ts`
- Test: channel CLI tests for disable/remove
- Test: `tests/unit/run-console.test.ts`

- [x] 在 running runtime 和 one-shot CLI runtime 两条路径验证 `shutdown` abandon，不 release、不 kill；新进程在 TTL 内 adopt。
- [x] disabled/removed/logout 先把所有 records durable 转 reaping，再 kill；RMUX unavailable 时返回 cleanup-pending并保留 registry/owner identity。
- [x] credential clear 必须在上述 durable transition 后；失败时打印可操作错误且不能删除唯一 cleanup evidence。
- [x] hub disconnect 只 bulk detach；不得复用 channel stop path。
- [x] 配置从 terminal enabled→disabled 时，即使新 config 已关闭，也要读取既有 registry完成 cleanup。
- [x] 测试重复命令、daemon concurrent owner 被 one-shot maintenance owner fence、kill timeout、process crash和后续 reconcile。
- [x] Run focused tests and root/channel-relay typechecks.
- [x] Commit: `feat(channel-relay): retire terminals on destructive channel actions`

### Task 25: 跨包 fake E2E 与 fault matrix

**Files:**

- Create: `tests/unit/packages/relay/rmux-terminal-e2e.test.ts`
- Extend: channel-relay runtime/reconciler tests
- Extend: relay gateway/web inbound tests
- Extend: relay-web terminal tests
- Add test helpers only under `tests/helpers/` or package-local `__tests__/support`

- [x] 建一个不需要真实 RMUX 的 connector↔hub↔browser harness，真实走 protocol envelopes、request correlation和 targeted events，driver 只替换为 in-memory fake。
- [x] 自动覆盖：刷新、断网重连、两设备共享、take control、全局 close、浏览器窗口 close、睡眠/delete、kill timeout、create/terminate crash window、alias reuse、stale generation。
- [x] 自动覆盖 slow viewer、output flood、queue cap、max sessions/viewers、history limit和 connector/hub mixed capabilities。
- [x] 每个 fault 后断言 registry/inventory/attachments 最终状态，不只断言 UI 文本；孤儿要么被 adopt，要么在 tombstone/reconcile/lease TTL 内消失。
- [x] 测试 terminal frames 未写入 messages DB、turn state或 account-wide broadcast。
- [x] 使用 fake monotonic clock推进 TTL，不在单测 sleep。
- [x] Run all new focused files and affected package builds.
- [x] Commit: `test(relay): cover rmux terminal fault recovery`

### Task 26: 真实 RMUX smoke 与高风险场景验收

**Files:**

- Create: `tests/smoke/relay-rmux-terminal.test.ts` or an explicit external harness documented alongside it
- Modify: `docs/relay-release.md` with opt-in commands

- [ ] 使用 release-pinned RMUX daemon、release-built sidecar和打包后的 channel-relay，不使用 workspace path shortcut。
- [ ] 执行 spec §22.6 全矩阵，至少包含 `vim/top` 刷新、输出中断网、A/B 设备接管、A close/B exit、短重启 adopt、超 TTL reap、daemon restart。
- [ ] 验证 raw non-UTF8/alternate screen/clear-history/resize rebase无叠屏、无重复和无 gap。
- [ ] kill sidecar、connector、hub 各一次并观察恢复；记录实际 resource disappearance 时间，必须不超过设计 TTL + bounded retry/grace。
- [ ] Windows x64 至少跑 create/recover/input/resize/kill/adopt smoke；macOS/Linux覆盖发布架构。
- [ ] 该 smoke 保持 opt-in，普通 `npm test` 不要求真实基础设施。
- [ ] Commit: `test(relay): add real rmux terminal smoke`

### Task 27: 平台 binary packages、checksum 与 publish verification

**Files:**

- Modify: `packages/channel-relay/package.json`
- Create: platform optional packages or release-generated package manifests for macOS arm64/x64、Linux arm64/x64、Windows x64
- Modify: `.github/workflows/publish-channel-relay.yml`
- Modify: `.github/workflows/test.yml` as needed for Rust/unit gates
- Modify: `scripts/verify-publish.mjs`
- Modify: root/package build scripts in `package.json`

- [ ] CI 从同一 source revision reproducibly build sidecar artifacts，写 version/checksum manifest；不得下载未校验 latest binary。
- [ ] channel-relay 通过 optional platform packages（或等价隔离机制）只安装当前平台 artifact；core package和其他 channel包不携带。
- [ ] package runtime resolution 校验 platform、arch、bridge version和 checksum；缺 artifact 返回 `terminal-rmux-unavailable`，relay channel其他能力仍可运行。
- [ ] `verify-publish` 解包 tarball，断言 Node bundle、类型、platform resolver、manifest存在，且没有 machine-specific path或 `../rmux` path dependency。
- [ ] release workflow 在 npm publish 前跑 Rust framing tests、JS driver tests和至少一个 real-daemon smoke；各 platform artifact 完成后才发布主 channel-relay 包。
- [ ] 检查许可证/NOTICE 和 RMUX binary/sdk 再分发要求。
- [ ] Run `bun run verify:publish` and inspect tarballs.
- [ ] Commit: `build(channel-relay): package rmux bridge binaries`

### Task 28: Plugin doctor、结构化诊断与安全日志

**Files:**

- Create: `packages/channel-relay/src/terminal/terminal-diagnostics.ts`
- Modify: generic plugin/channel doctor seam in `src/channels/cli/provider.ts`, `src/plugin-api.ts`, `src/plugins/plugin-doctor.ts` only as needed
- Modify: `packages/channel-relay/src/relay-provider.ts`
- Modify: `src/doctor/checks/plugin-check.ts`
- Test: `tests/unit/packages/channel-relay/provider.test.ts`
- Test: `tests/unit/plugins/plugin-doctor.test.ts`
- Test: `tests/unit/doctor/checks/plugin-check.test.ts`

- [ ] 用通用可选 plugin diagnostic hook 接入 `xacpx doctor`；core只呈现结构化结果，不理解 RMUX。
- [ ] 输出 bridge/RMUX version、capability、registry counts、viewer/controller counts、oldest input age、lease state、last reconcile和 cleanup-pending；不输出 terminal bytes、env、credential或完整路径中的敏感部分。
- [ ] 实现 spec §19 的结构化日志事件；ID可以记录，payload sizes/counts/error class可记录，内容不可记录。
- [ ] doctor 在 terminal disabled 时 skip；artifact missing/version mismatch fail；corrupt registry/lease lost/cleanup pending warn/fail并给出明确操作建议。
- [ ] doctor保持 read-only，不提供猜测性 orphan kill；修复依赖正常 reconciler/lease。
- [ ] 加日志 redaction test，注入 canary terminal bytes/credential/path token后断言从所有 logs/doctor输出消失。
- [ ] Run focused tests, root typecheck, and plugin-api build.
- [ ] Commit: `feat(doctor): report relay rmux terminal health`

### Task 29: 模块文档、配置参考和 release order

**Files:**

- Modify: `docs/control-module.md`
- Modify: `docs/config-reference.md`
- Modify: `docs/relay-module.md`
- Modify: `docs/relay-web-module.md`
- Modify: `docs/relay-deployment.md`
- Modify: `docs/relay-release.md`
- Modify: `packages/channel-relay/README.md`
- Modify last: `AGENTS.md`

- [ ] 先更新模块文档，再给 AGENTS 增加稳定导航；AGENTS 不复制协议/state machine细节。
- [ ] 用户文档明确：Tab `X` 是全局终止；关闭浏览器/断网不终止；多设备共享 shell但不共享 Tab 布局；controller/spectator和 take control。
- [ ] 配置文档列出全部默认值/范围、terminal 默认关闭、安全含义、idle/lease/attachment三种 TTL 区别。
- [ ] 运维文档说明 registry/owner路径、cleanup-pending、restart within TTL、超过 TTL 的预期丢失和 doctor输出。
- [ ] release 顺序固定：RMUX SDK/daemon→sidecar platform packages→xacpx core→relay-protocol→relay hub（含 web）→channel-relay；记录 min core/protocol版本。
- [ ] 把历史 legacy terminal/replay/hardening spec 标成兼容背景，不删除；本文成为 RMUX backend权威设计。
- [ ] 检查 user-facing 文案使用“睡眠/唤醒”，代码/API 文档可注明 archive legacy spelling。
- [ ] Commit: `docs: document relay rmux terminal operations`

### Task 30: 灰度开关、production readiness 与 legacy 切流

**Files:**

- Modify only after evidence: channel-relay capability enablement/config examples and release notes
- Test: mixed-version and rollout tests from Tasks 9、18、20、25

- [ ] 第一阶段发布 core identity/catalog，不改变 terminal UX。
- [ ] 第二阶段发布 protocol/hub/web/channel，但 terminal 默认 false；验证旧 hub/connector/web组合都安全隐藏。
- [ ] 开发实例显式开启 RMUX，收集 runtime ready/unavailable、rebase/resync、cleanup pending、orphan reaped和 backpressure指标。
- [ ] 少量实例灰度，连续验证无 orphan 超 TTL、无叠屏、无重复 shell、无 account-wide terminal广播。
- [ ] 只有 Final acceptance 全通过后，声明 `terminal.rmux.recovery.v1` production-ready；默认值是否改变另作产品决定，本计划不擅自开启。
- [ ] 切流后停止 web 使用 legacy create/attach和 terminal ID sessionStorage；channel-relay不再调用 core terminal methods。
- [ ] Commit: `feat(channel-relay): enable rmux terminal capability`

### Deferred Task 31: 删除 legacy core terminal（单独 PR）

这不是首个 RMUX rollout 的一部分。只有兼容窗口结束、旧 connector 已退出支持范围后才执行：

- [ ] 删除 core `src/control/terminal-service.ts`、对应 facade/events/config 和 legacy tests。
- [ ] 删除 legacy protocol DTO/message和 relay broadcast routing。
- [ ] 删除 web `terminal-sessions.ts` 及旧 attach/create兼容分支。
- [ ] 重新核对 `node-pty`：transport 仍使用则保留 dependency，不因 terminal cleanup误删。
- [ ] 独立 spec/plan、独立 release note和 rollback strategy。
- [ ] Suggested commit: `refactor(terminal): remove legacy relay pty backend`

---

## 每阶段验证命令

### RMUX upstream

```bash
cd ../rmux
cargo test -p rmux-sdk
cargo fmt --check
cargo clippy -p rmux-sdk --all-targets -- -D warnings
```

若修改 server lease 语义，再运行对应 `rmux-server` focused tests。真实 daemon/release tests 服从 RMUX 仓库自己的 release gate。

### Core / protocol / channel-relay / hub

```bash
cd /Users/maijiazhen/Projects/xacpx
npx tsc --noEmit
bun run build:plugin-api
bun run build:relay-protocol
npx tsc -p packages/channel-relay/tsconfig.json --noEmit
npx tsc -p packages/relay/tsconfig.json --noEmit
```

单测按任务列出的文件逐个跑，避免目录级共享状态污染。

### Relay web

```bash
cd /Users/maijiazhen/Projects/xacpx/packages/relay-web
npx vitest run src/__tests__/terminal-adapter.test.ts
npx vitest run src/__tests__/terminal-recovery.test.ts
npx vitest run src/__tests__/terminal-store.test.ts
npx vitest run src/__tests__/terminal-tab.test.ts
npx vue-tsc --noEmit
```

### Sidecar

```bash
cd /Users/maijiazhen/Projects/xacpx
cargo test --manifest-path packages/channel-relay/native/rmux-bridge/Cargo.toml
cargo fmt --manifest-path packages/channel-relay/native/rmux-bridge/Cargo.toml --check
cargo clippy --manifest-path packages/channel-relay/native/rmux-bridge/Cargo.toml --all-targets -- -D warnings
```

### 最终仓库门槛

```bash
cd /Users/maijiazhen/Projects/xacpx
npm test
bun run build:packages
bun run verify:publish
cd packages/relay-web && npx vitest run
```

真实 RMUX smoke 单独运行；不要把需要外部 daemon/platform artifact 的测试伪装成普通 unit pass。

## Final acceptance checklist

- [ ] RMUX 依赖只存在于 channel-relay sidecar/optional platform package链；core 无 RMUX import/dependency。
- [ ] missing logical ID migration 在 channel/plugin start 前 durable；alias reuse/shared transport不破坏身份。
- [ ] catalog scope/cwd/lifecycle完全由 core权威提供，removed event带删除前 snapshot。
- [ ] 显式 close 是 acknowledged global terminate；多 viewer有确认；offline/timeout不静默丢 Tab。
- [ ] refresh/window close/unmount/session switch/network wobble只 detach；owner lease不受 browser连接影响。
- [ ] 同一 logical session跨设备共享 terminalId/generation；本地 Tab布局不跨设备同步。
- [ ] controller/spectator权限在 channel-relay强制，takeControl原子且旧 controller立即只读。
- [ ] first recovery frame为 rebase；adapter reset后重建；raw bytes、epoch和sequence端到端无 Unicode round-trip。
- [ ] gap/invalid chunk/generation mismatch进入 resync，绝不在损坏画面上继续追加。
- [ ] creating/live/reaping所有 crash window有测试；cleanup-pending保留 tombstone并最终 reconcile。
- [ ] startup adopt发生在 hub connect/capability宣告前；lease lost fence旧 owner全部 mutation。
- [ ] shutdown abandon；disabled/removed/logout/sleep/delete/idle/natural exit都有明确回收路径。
- [ ] registry/inventory不确定时 destructive GC fail closed；合法孤儿在 grace/lease上限内消失。
- [ ] maxSessions、maxViewers、history、frame、request、outbound queue和socket backpressure均有硬限制和测试。
- [ ] terminal payload不进入日志、历史 DB、turn accumulator或无 attachment socket。
- [ ] capability mixed-version矩阵通过；缺 capability的 web不发送新终端消息，也不回退 legacy PTY。
- [ ] macOS arm64/x64、Linux arm64/x64、Windows x64 artifact有版本/checksum验证，publish tarball无本机路径。
- [ ] `npm test`、`bun run build:packages`、`bun run verify:publish`、完整 relay-web Vitest及所需 RMUX真实 gate全部通过。
- [ ] 模块/配置/部署/release/doctor文档完成，AGENTS只补稳定导航。

## 回滚边界

- capability 是上线开关。发生严重问题时先关闭 channel `options.terminal.enabled` 或停止声明 capability；旧聊天/会话控制继续工作。
- 已存在 resource 不能因关闭 capability 被遗忘：disable 流必须先 durable reaping并尝试 kill；失败依赖 tombstone + owner lease收尾。
- 不回滚 `logical_session_id` migration；它是 additive、通用且已持久化的 core identity。
- 不让新 web回退到 legacy PTY；回滚 web/hub/channel版本时按 release order整体回滚，避免一个 logical session同时存在两种 backend。
- 不手工删除 `terminals.json` 解决故障；保留 evidence，使用 doctor/reconciler/lease。任何人工强杀工具若未来需要，另行安全设计。
