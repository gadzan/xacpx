# Relay Web · 实例桌面（RFB/VNC）实施计划

> 日期：2026-09-24
>
> 设计依据：docs/superpowers/specs/2026-09-24-relay-web-desktop-rfb-design.md
>
> 本计划先交付 Phase A（Linux + Windows VncAuth、单 viewer）。macOS ARD、多 viewer 和 managed setup 单独跟进，避免扩大首个 PR 的安全审查面。

## 0. 交付原则

- framebuffer 不进入 RelayEnvelope；
- 不复用 instance control WebSocket 承载 Desktop bytes；
- 不改 xacpx core；
- Desktop target 固定 loopback；
- v1 不做 arbitrary TCP tunnel；
- v1 单 instance 单 Desktop stream；
- 所有新协议 additive，老 connector / 老 hub 正常降级为“无 Desktop”。

## 1. Task 1：协议与 capability

修改：

- packages/relay-protocol/src/messages.ts
- packages/relay-protocol/src/web-dtos.ts
- packages/relay-protocol/src/limits.ts
- packages/relay-protocol/src/index.ts（如需要）
- tests/unit/packages/relay-protocol/desktop-dtos.test.ts

增加：

- RELAY_CAPABILITIES.desktopRfbV1 = desktop.rfb.v1
- MSG.desktopPrepare / desktopCancel
- Desktop prepare payload/result
- WebClientMessage desktop-open / desktop-close
- WebServerEvent desktop-opened / desktop-request-failed
- stable error codes
- request / stream / ticket limits

约束：协议里只有 stream metadata，不允许加入 dataBase64/framebuffer 字段。

验证：

~~~bash
bun run build:relay-protocol
bun test tests/unit/packages/relay-protocol/desktop-dtos.test.ts
~~~

建议提交：

~~~text
feat(relay-protocol): add desktop RFB control contracts
~~~

## 2. Task 2：channel-relay Desktop 配置与 RFB probe

修改/新增：

- packages/channel-relay/src/config.ts
- packages/channel-relay/src/desktop/rfb-probe.ts
- packages/channel-relay/src/desktop/platform-guidance.ts
- tests/unit/packages/channel-relay/desktop-config.test.ts
- tests/unit/packages/channel-relay/desktop-rfb-probe.test.ts

实现：

- desktop defaults disabled；
- backend=rfb；
- port/default 5900；
- connectTimeoutMs；
- maxStreams=1；
- host 不可配置；
- probe RFB banner；
- parse security types；
- accept VncAuth；
- reject None / VeNCrypt；
- ARD 返回明确 unsupported（为 Phase B 留类型）。

验证：

~~~bash
bun test tests/unit/packages/channel-relay/desktop-config.test.ts
bun test tests/unit/packages/channel-relay/desktop-rfb-probe.test.ts
npx tsc -p packages/channel-relay/tsconfig.json --noEmit
~~~

建议提交：

~~~text
feat(channel-relay): add loopback RFB desktop probe
~~~

## 3. Task 3：Hub Desktop ticket / stream registry

新增：

- packages/relay/src/gateway/desktop-ticket-store.ts
- packages/relay/src/gateway/desktop-stream-registry.ts
- packages/relay/src/gateway/desktop-stream-gateway.ts
- tests/unit/packages/relay/gateway/desktop-ticket-store.test.ts
- tests/unit/packages/relay/gateway/desktop-stream-gateway.test.ts

实现：

- random single-use ticket；
- TTL 60s；
- account/instance/side binding；
- v1 instance single-stream reservation；
- preparing/waiting-browser/active/closed state；
- pair browser connector sockets；
- close propagation；
- instance offline / reconnect fencing cleanup；
- hard bufferedAmount cap。

不落 DB。

建议提交：

~~~text
feat(relay): add desktop binary stream registry
~~~

## 4. Task 4：Relay server upgrade 路由

修改：

- packages/relay/src/server.ts
- 必要时 packages/relay/src/gateway/instance-gateway.ts
- 相关 server integration tests

默认 merged 模式：

~~~text
/ws                 -> browser control
/gateway or /       -> instance control
/desktop/observe    -> browser binary desktop
/desktop/instance   -> connector binary desktop
~~~

dedicated --ws-port：

- HTTP/dashboard port 处理 /desktop/observe；
- dedicated instance port 同时处理 instance control 与 /desktop/instance；
- 不允许 Desktop 回归为第二个公网“VNC port”。

验证 merged + dedicated 两种启动形态。

建议提交：

~~~text
feat(relay): route desktop binary websocket upgrades
~~~

## 5. Task 5：browser desktop-open 控制流

修改：

- packages/relay/src/gateway/web-inbound.ts
- packages/relay/src/gateway/web-gateway.ts（只加必要 request correlation/cleanup）
- packages/relay/src/gateway/instance-gateway.ts（若需要 desktop prepare request helper）

流程：

1. browser /ws 发 desktop-open；
2. 验证 account 拥有 instance + online + desktop.rfb.v1；
3. reserve stream；
4. mint connector ticket；
5. request instance.desktop.prepare；
6. connector 准备成功后 mint browser ticket；
7. targeted desktop-opened 只发给原 socket；
8. 失败回滚 reservation/tickets。

prepare deadline 建议 10s，不能复用 120s 普通 agent RPC 超时。

建议提交：

~~~text
feat(relay): broker desktop open requests
~~~

## 6. Task 6：channel-relay DesktopTunnelRuntime

新增：

- packages/channel-relay/src/desktop/desktop-tunnel-runtime.ts
- packages/channel-relay/src/desktop/desktop-stream-client.ts
- tests/unit/packages/channel-relay/desktop-tunnel-runtime.test.ts

修改：

- packages/channel-relay/src/channel.ts
- packages/channel-relay/src/relay-client.ts（仅需要暴露/复用 hub URL/credential state 时）
- packages/channel-relay/src/index.ts

运行时：

- bootstrap desktop config；
- enabled 时声明 desktop.rfb.v1；
- 收 instance.desktop.prepare；
- probe local RFB；
- 打开第二条 outbound binary WS 到 /desktop/instance；
- 连接 127.0.0.1:<port>；
- TCP <-> WS pipe；
- connector WS bufferedAmount 高时 pause TCP；
- hard cap close；
- stop/logout/disable 清所有 tunnel；
- control socket disconnect 清 stream。

注意：prepare 请求不得覆盖本机 port。

建议提交：

~~~text
feat(channel-relay): bridge loopback RFB over desktop stream
~~~

## 7. Task 7：真实 binary hard gate

新增类似：

- tests/integration/relay-desktop-rfb-hardgate.test.ts

测试组件：

- real Relay server；
- real RelayChannel；
- fake RFB TCP server on loopback random port；
- browser-like authenticated /ws + /desktop/observe client。

断言：

- open 成功；
- server -> connector -> hub -> browser bytes 不变；
- browser -> hub -> connector -> server bytes 不变；
- 大量 desktop bytes 时普通 control request 仍独立工作；
- browser close 后 fake RFB TCP 被关闭；
- instance disconnect 后 browser stream 关闭；
- ticket retry/复用失败。

建议提交：

~~~text
test(relay): hard-gate desktop RFB binary tunnel
~~~

## 8. Task 8：relay-web noVNC Client

修改：

- packages/relay-web/package.json
- bun.lock

新增：

- packages/relay-web/src/lib/desktop-client.ts
- packages/relay-web/src/stores/desktop.ts
- packages/relay-web/src/__tests__/desktop-client.test.ts
- packages/relay-web/src/__tests__/desktop-store.test.ts

实现：

- dynamic import @novnc/novnc；
- browser control RPC open；
- 根据 wsPath 新建独立 WebSocket；
- RFB(target, socket)；
- password prompt callback/state；
- connect/disconnect/securityfailure；
- scaleViewport；
- v1 resizeSession=false；
- tab dispose -> desktop-close + WS close；
- reconnect -> 重新 desktop-open，不复用 ticket。

建议提交：

~~~text
feat(relay-web): add noVNC desktop client
~~~

## 9. Task 9：Desktop Tab / 入口

新增/修改：

- packages/relay-web/src/components/DesktopTab.vue
- packages/relay-web/src/components/DesktopToolbar.vue
- Dashboard / center tabs / instance actions 对应文件
- en / zh-CN i18n
- unit tests

产品语义：

- Desktop 属于 instance，不属于 session；
- capability 缺失不显示；
- busy/unavailable/auth unsupported 有独立文案；
- password 只保存在当前组件/store 内存，不进入 localStorage/sessionStorage；
- v1 不显示 viewer count / take-control。

建议提交：

~~~text
feat(relay-web): expose per-instance Desktop tab
~~~

## 10. Task 10：Playwright RFB E2E

新增：

- packages/relay-web/e2e/desktop-rfb.spec.ts
- 测试 helper fake RFB server / mock hub binary endpoint

至少覆盖：

- 真 noVNC lazy load；
- 连接完成；
- framebuffer update 可见；
- keyboard/pointer 形成 RFB client message；
- password/security failure；
- disconnect/reopen；
- fullscreen / fit。

验证：

~~~bash
bun run --cwd packages/relay-web test
bun run --cwd packages/relay-web build
bun run --cwd packages/relay-web test:e2e -- desktop-rfb
~~~

## 11. Task 11：Windows / Linux 文档与 doctor

修改：

- docs/config-reference.md
- docs/relay-module.md
- docs/relay-web-module.md
- packages/docs 对应英文/中文页面
- channel-relay README

Windows 指导：

- TightVNC；
- VncAuth；
- loopback；
- interactive user session；
- lock/UAC/login screen 边界。

Linux 指导：

- TigerVNC/x11vnc/WayVNC；
- GNOME VeNCrypt v1 unsupported。

如果已有 channel doctor seam，增加 desktop probe summary；否则先把 open error 做到足够可诊断，不为本功能新建大 doctor 框架。

建议提交：

~~~text
docs(relay): document desktop RFB setup and limits
~~~

## 12. Phase B：macOS ARD（后续 PR）

独立设计/安全 review：

- connector-side ARD handshake；
- ephemeral credentials；
- secret redaction；
- pre-auth 后向 noVNC 暴露可继续的 RFB stream；
- Screen Sharing 权限错误区分；
- 真机测试。

完成后声明：

~~~text
desktop.ard-auth.v1
~~~

## 13. Phase C：multi-view（后续 PR）

前置条件：服务端 RFB client-message parser/filter。

实现后才允许：

- controller/spectator；
- take-control；
- viewerCount；
- server-enforced view-only；
- resize ownership。

仅设置 noVNC viewOnly 不算安全实现。

## 14. 最终验证矩阵

Phase A PR 合并前：

~~~bash
bun run build:relay-protocol
npx tsc --noEmit
bun test tests/unit/packages/relay-protocol/desktop-dtos.test.ts
bun test tests/unit/packages/channel-relay/desktop-config.test.ts
bun test tests/unit/packages/channel-relay/desktop-rfb-probe.test.ts
bun test tests/unit/packages/channel-relay/desktop-tunnel-runtime.test.ts
bun test tests/unit/packages/relay/gateway/desktop-ticket-store.test.ts
bun test tests/unit/packages/relay/gateway/desktop-stream-gateway.test.ts
bun test tests/integration/relay-desktop-rfb-hardgate.test.ts
bun run --cwd packages/relay-web test
bun run --cwd packages/relay-web build
~~~

另外做两台真机验收：

- Linux：TigerVNC/XFCE；
- Windows：interactive-session TightVNC。

真机验收必须记录：

- idle desktop 带宽；
- 快速拖窗口时带宽/CPU；
- browser bufferedAmount；
- Hub RSS；
- agent cancel latency；
- reconnect 行为；
- Windows lock/UAC 行为（预期不保证，确认错误表现不会误导用户）。

## 15. 完成定义

Phase A 完成 = 用户可以从 relay-web 打开在线 Linux/Windows xacpx instance 的 Desktop，在不暴露 5900 的情况下观看并控制；Desktop 流量与现有控制 WebSocket 隔离；关闭/断线无 Hub/connector 泄漏；所有凭据、ticket 和 loopback 边界满足设计中的安全约束。
