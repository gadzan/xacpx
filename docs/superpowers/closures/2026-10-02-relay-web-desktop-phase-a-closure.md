# Relay Web 实例桌面 Phase A · Closure

> 日期:2026-10-02。
>
> 关联:PR #364(merged,`d439d470`),设计 docs/superpowers/specs/2026-09-24-relay-web-desktop-rfb-design.md,计划 docs/superpowers/plans/2026-09-24-relay-web-desktop-rfb.md。

## 1. 交付结论

Phase A 已合并至 `main` 并在合入前满足设计 §22 的验收标准:

- Linux / Windows interactive-session VncAuth 实例可从 relay-web 观看并控制(Windows 用 TightVNC,Linux 用 TigerVNC/x11vnc/WayVNC attach mode)。
- 5900 无需公网暴露:target 固定 loopback,connector 仍只主动出站。
- Desktop 流量走独立 binary WebSocket,不与 control 请求共享 connection;framebuffer 不进入 RelayEnvelope/base64。
- 关闭/断线无 Hub/connector 残留 stream(closeAll 传播 + instance offline fencing)。
- ticket 60s TTL、单次使用、account/instance/side 绑定;未开启 desktop 的 instance 不显示入口。
- None / unsupported / ARD(v1)均 fail closed,返回稳定错误码(`ARD` 在 DTO 中预留但按 design 明确 unsupported)。
- xacpx core 未改动:`git diff origin/main -- src/` 为空。

CI:(`test`、`Test (macOS)`、`terminal-windows`、`terminal-rmux-windows`、`Relay Web terminal E2E`)全绿。

## 2. 与 main 的合并

base 分支在此 PR 开发期间前进了 36 个 commit(ACP elicitation、Discord interactive channels)。冲突文件与取舍:

- `packages/relay-protocol/src/messages.ts`:additive —— `desktop.rfb.v1` 与 `interaction.elicitation.form.v1` 并存。
- `packages/relay/src/gateway/web-inbound.ts`:合并 import 与 `WebClientDeps` 的 `desktop` / `interactions` 两块。
- `packages/relay/src/server.ts`:同时接线 `desktop`(over `runtime.desktop.*` + `runtime.desktopStreamOwners`)与 main 的 `interactions`。
- `packages/channel-relay/src/channel.ts`:以 main 版本为底,移植 desktop 模块;import/字段/prepare+cancel dispatch/三处 `closeAll` teardown/`bootstrapDesktop`/capability advertisement/`getDesktopRuntimeForTests` seam。
- `packages/relay-protocol/dist/*`:`bun run build:relay-protocol` 重新生成,不手工合并 generated 产物。
- `src/`:未改动。

合并过程中发现并修复一个 ordering bug:`startLogger` 的捕获从 `bootstrapTerminal()` 内移至 `start()`,否则 `terminal.enabled=false` 的 desktop-only 配置下 tunnel runtime 拿不到 logger,probe/tunnel 事件会被静默丢弃。回归测试:"a desktop-only channel still hands the tunnel runtime a logger"。

(`channel.ts` 用 LF,main 副本为 CRLF;此文件 diff 应忽略 CR 阅读。)

## 3. 环境限制(非回归)

本机(Windows)实测下列失败在 unmodified `origin/main` 上同样发生,与 Phase A 无关:

- `tests/unit/adapters/hermes-shim.test.ts` 的 bundled-build 断言(POSIX `file:///` 绝对路径在 Windows 不可解析)。
- `terminal-registry-store.test.ts` 的 `exclusiveWriter` 两例;`credential-store.test.ts` 的 0600 perms 两例(Windows 不尊重 POSIX mode bits,`chmod(0o600)` 落为 `0o666`)。
- 6 个 desktop tunnel 5s 超时用例:在 pre-merge branch tip `cbe74335` 上一同复现,CI(Linux/macOS/Windows runner)上通过。

对比方法:(worktree + `bun test` 同文件对比),不是"本地绿"推断。

## 4. 遗留与后续

- **Phase B(macOS ARD)**:设计/计划草稿 + issue checklist 已就绪(分支 `phase-b-macos-ard-design`,issue #367),三个决策未定稿:capability 表达、handshake 重写范围、凭据输入通道。未写 runtime code。
- **Phase C(multi-view)**:依赖 server-side RFB view-only parser/filter,未排期。
- Windows 本地覆盖:lock/UAC 边界见 platform guidance 与文档。

## 5. 文档落地

- docs/desktop-rfb-setup.md(Linux/Windows setup 与诊断)。
- 本 closure 记录合并取舍、环境限制与 Phase A 边界,便于后续 agent 不重复排查上述"Windows 特有失败"。
