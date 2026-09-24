# Relay Web · 实例桌面（RFB/VNC）设计

> 状态：提案，待评审。
>
> 日期：2026-09-24。
>
> 读者：后续实现 agent、reviewer、发布负责人。
>
> 相关文档：
> - docs/relay-module.md
> - docs/relay-web-module.md
> - docs/config-reference.md
> - docs/superpowers/specs/2026-08-10-relay-web-rmux-terminal-design.md
> - docs/superpowers/specs/2026-08-12-relay-web-rmux-process-owned-design.md

## 1. 结论摘要

目标是在 relay-web 中选择任意在线 xacpx 实例，打开 Desktop 后观看并控制该实例机器的图形桌面。

本设计固定以下决策：

1. **浏览器统一使用 RFB/VNC，不为 Windows 单独引入 RDP。** relay-web 使用 noVNC；平台差异收敛在实例本机的 RFB server。
2. **Desktop 是实例级资源，不绑定 logical session。** Chat/Terminal 仍按会话工作；Desktop 从实例入口打开。
3. **控制面与数据面分离。** 登录、capability、开流、错误、审计继续走现有 JSON relay 协议；framebuffer、键鼠和 RFB handshake 走独立 binary WebSocket。
4. **Desktop 数据不得 base64 后塞进 RelayEnvelope。** 现有 instance gateway 和 /ws 只保留低带宽控制流量。
5. **仍保持单域名单端口部署。** 默认 8787 上按 upgrade path 分流；Desktop 只是新增独立 WebSocket 连接，不新增公网端口。
6. **connector 仍只主动出站。** VNC/RFB server 必须是实例本机 loopback 服务；不要求公网 IP、端口映射或开放 5900。
7. **v1 不允许 hub 指定任意 target host/port。** channel-relay 只连接配置中的 loopback port，防止 Desktop tunnel 退化为通用内网 TCP 代理。
8. **v1 一台实例同一时刻只允许一个 Desktop viewer。** 先把观看/控制主链路做正确；多 viewer / take-control 只有在服务端 RFB view-only filter 完成后再开放。
9. **Windows v1 采用 TightVNC attach 模式。** 推荐运行在已登录的 interactive user session；不把 Windows service session 当作可靠桌面来源。
10. **Linux 优先 TigerVNC/x11vnc attach（标准 VncAuth）。** GNOME Remote Desktop 的 VeNCrypt 不纳入 v1；WayVNC 仅在其显式配置 legacy VncAuth 兼容模式（`relax_encryption` + `allow_broken_crypto`）时可用，上游将其标记为弱安全的过渡兼容——默认安全配置的 WayVNC 会被 probe 以 `desktop-auth-unsupported` 拒绝。

## 2. 当前架构可复用部分

xacpx 已经具备本功能所需的大部分控制基础设施：

- packages/channel-relay 主动拨号 Relay Hub；
- Hub 按 account 隔离 instance；
- instance handshake 已支持 capabilities；
- relay-web 已有认证 /ws；
- Hub 已能把 browser request 定向到指定 instance；
- RMUX Terminal 已经实现 viewer identity、attachment、reconnect、backpressure 和 capability gating；
- Relay 默认 8787 单端口已经通过 HTTP upgrade path 区分 /ws 与 instance gateway。

Desktop 不应复制 Terminal 的 ANSI recovery 协议，但应复用它验证过的权限边界和“Hub 只路由、实例拥有本地资源”的架构原则。

## 3. 目标

### 3.1 用户体验

- 实例在线且支持 Desktop 时，在实例 UI 中显示 Desktop 入口。
- 点击后在中心区域打开 Desktop tab。
- Desktop tab 能显示远端图形桌面并发送键盘、鼠标和触控输入。
- 支持 Fit / Actual；服务端支持时可增加 Match window（remote resize）。
- 断网或 hub 重启后明确显示断开；用户重连时建立新的 RFB 会话，不依赖 framebuffer replay。
- VNC 不可用时显示具体原因，而不是无限 loading。

### 3.2 安全

- 远端 5900 不对公网开放。
- Hub 登录用户只能打开自己 account 下的 instance。
- stream ticket 单次使用、短 TTL、绑定 account + instance + side。
- Desktop tunnel 只能到 loopback + configured port。
- ticket、VNC password、ARD password 不写日志。
- 未认证的 VNC server 默认拒绝。
- Desktop disabled 时不声明 capability，也不创建任何 stream endpoint 状态。

### 3.3 性能

- RFB bytes 不经过 JSON parse/stringify/base64。
- Desktop burst 不阻塞 agent RPC、terminal input、cancel、heartbeat 等控制消息。
- 每一跳都有 hard payload / bufferedAmount / connection 数上限。
- slow browser 或 slow connector 被断开，不允许 hub 内存无界增长。

## 4. 非目标

v1 不做：

- Windows RDP backend；
- 登录屏幕 / Windows Secure Desktop / UAC 控制保证；
- 自动提权安装 TightVNC；
- 通用 TCP 端口转发；
- Desktop framebuffer 持久化或录像；
- 多 viewer 协作；
- 文件传输；
- 自动 clipboard 同步；
- 在 core 中增加 OS 图形 API；
- 通过现有 instance control WebSocket 承载 framebuffer。

## 5. 平台策略

所有平台最终向上提供同一个抽象：

~~~text
local desktop
    |
platform RFB server
    |
127.0.0.1:<configured-port>
    |
channel-relay DesktopTunnelRuntime
    |
binary WebSocket
    |
Relay Hub stream gateway
    |
binary WebSocket
    |
relay-web noVNC
~~~

### 5.1 Windows

推荐服务端：TightVNC。

要求：

- VNC authentication 开启；
- 监听 loopback，或由防火墙保证只有 loopback 可达；
- 默认端口 5900；
- 优先运行在真实 interactive user session；
- 不依赖 Windows service session 作为“可见桌面”的权威来源。

已知边界：

- 锁屏可能黑屏；
- UAC secure desktop 不保证可见/可控；
- 登录屏幕不属于 v1 保证范围。

对于普通 xacpx 用户机器，v1 只 attach 已存在服务，不自动安装或改注册表。后续如果做 managed Windows setup，必须是显式管理员动作，并采用“interactive user process / scheduled task”模型，而不是假定 service session 等同于用户桌面。

### 5.2 Linux

优先（标准 VncAuth，开箱即用）：

- TigerVNC / Xtigervnc（优先，X11/XFCE）；
- x11vnc（已有 X11 display）。

WayVNC（Wayland）仅在其显式启用 legacy VncAuth 兼容（`relax_encryption` + `allow_broken_crypto`）时可用；这是上游标记为弱安全的过渡兼容模式，默认安全配置（VeNCrypt/TLS）的 WayVNC 会被 probe 以 `desktop-auth-unsupported` 拒绝。GNOME Remote Desktop 的 VeNCrypt 路线同样不在 v1 支持集合。v1 只要求 endpoint 提供标准 RFB + VncAuth。

后续可增加 desktop.managed=true（Linux only），由 channel-relay 启动受控 TigerVNC/XFCE；该能力不应阻塞 attach-mode 首发。

### 5.3 macOS

macOS Screen Sharing 底层仍可提供 RFB，但认证与普通 VncAuth 不同。

阶段划分：

- Phase A：支持配置为标准 VncAuth 的 RFB endpoint；
- Phase B：增加 connector-side ARD account pre-auth。账号密码只在 browser -> authenticated control request -> connector 的短生命周期内使用，不落盘、不进入 URL、不返回 RPC result。connector 完成 ARD handshake 后，向 browser 暴露已认证的 RFB stream。

## 6. 包边界

### xacpx core

不改。

core 不得：

- import noVNC/VNC/RFB 库；
- 启动 VNC server；
- 保存 Desktop stream registry；
- 解析 framebuffer 或输入事件。

### packages/relay-protocol

只增加控制面 contract：

- capability；
- Desktop prepare req/res；
- relay-web open req/res；
- error codes；
- hard limits。

不定义 framebuffer DTO。

### packages/channel-relay

拥有实例侧 Desktop：

- config / platform guidance；
- RFB probe；
- DesktopTunnelRuntime；
- loopback TCP socket；
- connector-side binary WebSocket；
- 后续 ARD pre-auth；
- cleanup / backpressure / diagnostics。

### packages/relay

拥有 stream broker：

- ticket store；
- browser/connector WebSocket upgrade；
- account / instance authorization；
- stream pairing；
- lifetime / timeout / backpressure；
- audit log。

Hub 不解析 framebuffer，不保存 Desktop 内容。

### packages/relay-web

拥有：

- noVNC lazy chunk；
- Desktop tab / toolbar；
- open/reconnect/error state；
- keyboard/mouse/focus；
- sizing mode；
- password prompt（VncAuth v1）。

## 7. 配置

在 relay channel options 增加：

~~~json
{
  "desktop": {
    "enabled": false,
    "backend": "rfb",
    "port": 5900,
    "connectTimeoutMs": 1500,
    "maxStreams": 1
  }
}
~~~

建议类型：

~~~ts
export interface RelayDesktopConfig {
  enabled: boolean;
  backend: "rfb";
  port: number;
  connectTimeoutMs: number;
  maxStreams: number;
}
~~~

约束：

- enabled 默认 false；
- backend v1 仅 rfb；
- port 1..65535，默认 5900；
- target host 不可配置，固定 127.0.0.1（IPv6 loopback 可后续补）；
- connectTimeoutMs 250..10000；
- maxStreams v1 固定/限制为 1；
- config parse 后 immutable/frozen，沿用 terminal 风格。

## 8. Capability

packages/relay-protocol 增加：

~~~text
desktop.rfb.v1
~~~

语义：

- connector 实现 Desktop tunnel protocol；
- desktop.enabled=true；
- capability 不保证此刻 5900 正在监听，真正 open 时重新 probe。

后续能力：

~~~text
desktop.ard-auth.v1
desktop.multi-view.v1
desktop.remote-resize.v1
~~~

不要提前声明未实现能力。

## 9. 控制面协议

### 9.1 Browser -> Hub

WebClientMessage 新增：

~~~ts
{ kind: "desktop-open"; requestId: string; instanceId: string }
{ kind: "desktop-close"; instanceId: string; streamId: string }
~~~

WebServerEvent 新增：

~~~ts
{
  kind: "desktop-opened";
  requestId: string;
  instanceId: string;
  streamId: string;
  wsPath: "/desktop/observe?ticket=...";
  expiresAt: number;
  security: "vnc-auth" | "ard";
}
{
  kind: "desktop-request-failed";
  requestId: string;
  instanceId: string;
  code: string;
  message: string;
}
~~~

ticket 只用于一次 WebSocket upgrade，TTL 建议 60 秒。

### 9.2 Hub -> Connector

MSG 增加：

~~~text
instance.desktop.prepare
instance.desktop.cancel
~~~

prepare payload 只包含 stream identity / connector ticket / deadline；**不得包含 target host 或 target port**。connector 使用自己的 frozen desktop config 决定连接 127.0.0.1:<port>。

prepare result：

~~~ts
{
  streamId: string;
  security: "vnc-auth" | "ard";
}
~~~

错误必须稳定编码，例如：

~~~text
desktop-disabled
desktop-busy
desktop-rfb-unavailable
desktop-not-rfb
desktop-auth-unsupported
desktop-stream-timeout
desktop-instance-offline
desktop-protocol-error
~~~

## 10. 二进制数据面

新增两个 upgrade path：

~~~text
/desktop/observe?ticket=<browser-ticket>
/desktop/instance?ticket=<connector-ticket>
~~~

默认单端口部署时两者都在 8787。

- /desktop/observe：浏览器连接，必须同时通过 relay web session cookie + ticket account binding。
- /desktop/instance：channel-relay 的第二条主动出站 WebSocket，使用 connector ticket 绑定 instance。
- 两个 ticket 都 single-use。
- Hub StreamRegistry 将两端配对后，仅转发 binary frame。
- 任一侧发送 text frame、超 payload、鉴权不匹配或重复使用 ticket，立即关闭。

为了不破坏 --ws-port 的旧双端口布局：

- browser side 永远走 HTTP/dashboard 端口的 /desktop/observe；
- connector side 在 merged 模式走 8787，在 dedicated gateway 模式走 --ws-port 上的 /desktop/instance；
- dedicated gateway listener 需要从“所有连接直接进 InstanceGateway”改成按 path 分流 instance control 与 desktop instance stream。

关键点：**即使默认仍是一个公网端口，Desktop 使用独立 WebSocket/TCP connection，因此不会和 control plane 产生同连接 HOL blocking。**

## 11. StreamRegistry

Hub 内新增内存态 registry，例如：

~~~text
packages/relay/src/gateway/desktop-stream-gateway.ts
packages/relay/src/gateway/desktop-stream-registry.ts
packages/relay/src/gateway/desktop-ticket-store.ts
~~~

每条记录至少保存：

~~~ts
{
  streamId;
  accountId;
  instanceId;
  createdAt;
  expiresAt;
  browserSocket?;
  connectorSocket?;
  state: "preparing" | "waiting-browser" | "active" | "closed";
}
~~~

不写 SQLite。Hub 重启时 active desktop 全部断开，browser 再 open 即可。

不变量：

- accountId/instanceId 由 hub 权威绑定；
- 一个 ticket 只能 consume 一次；
- v1 每 instance 最多一个 active/preparing stream；
- 每 account 最多 8 个并发 active/preparing stream（`DESKTOP_MAX_STREAMS_PER_ACCOUNT`），reservation 为原子 check+insert；
- pending prepare 绑定发起 `/ws` 的 control socket/viewerId：prepare 返回后重验 owner 仍存活才 mint browser ticket；control socket close 立即 cancel 该 viewer 名下全部 stream（含已配对 binary）；desktop-close 校验同 viewer；
- browser binary 先断或 connector 先断都关闭另一侧；
- preparing 超时自动回收；
- instance control socket supersede/offline 立即关闭该 instance 的 stream。

内部职责：

1. prepare 前 probe 127.0.0.1:<port>；
2. 验证 RFB banner；
3. 识别 security types；
4. v1 仅接受支持的 auth；
5. 建 connector-side binary WSS；
6. 打开 loopback TCP；
7. 双向 pipe；
8. 对 WebSocket bufferedAmount / TCP writable backpressure 做有界控制；
9. stream close 时只关 TCP/tunnel，不停系统 VNC server；
10. stop/logout/disable 时关闭所有 tunnel。

v1 不需要 durable registry：Desktop 生命周期由系统图形 session/VNC server 持有，tunnel 本身是短生命周期资源。

## 13. RFB probe 与认证

v1 probe 至少确认：

- server banner 是 RFB 003.x；
- security type 列表可解析；
- None 默认拒绝；
- VncAuth 可用；
- VeNCrypt 返回 desktop-auth-unsupported；
- ARD 返回可识别但在 Phase B 前明确 unsupported。

VncAuth v1 由 noVNC 直接完成：

- 密码只保存在 relay-web 当前 tab 内存；
- 不进入 RelayEnvelope；
- 不进入 ticket；
- 不写 hub/connector 日志。

Phase B 的 ARD pre-auth 应借鉴“connector 先完成平台认证、browser 再接无凭据 RFB”的模式，但实现必须单独 review，因为它涉及 RFB handshake 重写和 secret handling。

## 14. relay-web

packages/relay-web 增加依赖 @novnc/novnc，并只在 Desktop 首次打开时 dynamic import。

建议模块：

~~~text
src/components/DesktopTab.vue
src/components/DesktopToolbar.vue
src/lib/desktop-client.ts
src/stores/desktop.ts
~~~

DesktopClient 只负责一个 noVNC RFB lifecycle：

- connect/disconnect；
- credentials；
- view-only local toggle；
- scaleViewport；
- resizeSession（仅 future capability 开启）；
- focus/keyboard/pointer；
- securityfailure 映射。

v1 UI：

- Connected / Connecting / Disconnected；
- Fullscreen；
- Fit / Actual；
- Disconnect；
- VNC password prompt；
- Windows/macOS/Linux 的明确 setup error 文案。

Desktop tab 不存 ticket。页面刷新或重连必须重新请求 desktop-open。

## 15. Backpressure 与硬上限

建议初始限制：

- Desktop WS maxPayload：1 MiB；
- connector 单次从 TCP 读取/发送块：<=64 KiB；
- destination bufferedAmount soft pause：2 MiB；
- hard close：4 MiB；
- prepare/ticket TTL：60s；
- connector prepare deadline：10s；
- v1 每 instance max stream：1；
- account active desktop cap：例如 8（Hub 可配置/常量）。

channel-relay：

- connector WS 堵塞时 pause local TCP；
- bufferedAmount 回落后 resume；
- hard cap 后 close stream。

Hub：

- 不做无限 queue；
- destination bufferedAmount 超 hard cap 时以 1013/明确 reason 关闭两侧；
- browser 重试建立新 stream。

## 16. Reconnect

Desktop 不需要 RMUX 风格 rebase/epoch。

RFB server 本身是当前桌面的权威状态。连接丢失后：

1. 旧 stream 关闭；
2. store 清理当前 streamId；
3. browser 重新发送 desktop-open；
4. connector 新建本地 RFB TCP；
5. noVNC 完整走一次 RFB handshake；
6. server 发送当前 framebuffer。

不尝试在 Hub 保存 framebuffer 或中间字节。

## 17. Windows 专项

### 17.1 v1 attach 要求

文档推荐 TightVNC：

- 开启 VNC authentication；
- 限制为 loopback；
- 禁止其自带 HTTP viewer；
- 端口默认 5900。

xacpx 不自动修改系统安全设置。

### 17.2 interactive session

对于需要可靠观看“当前用户桌面”的 Windows 机器：

- VNC process 应运行在已登录用户的 interactive session；
- 不把 Session 0 service 当作可靠桌面源；
- 如果 operator 自己用 service 模式并遇到黑屏，doctor 文案应指出 session mismatch。

后续 managed setup 若实现：

- 明确要求管理员确认；
- 安装后创建 user logon scheduled task；
- VNC server 在用户登录后启动；
- service 只可用于安装/配置，不作为最终 desktop source；
- 卸载/disable 要可逆。

### 17.3 明确不保证

- Winlogon；
- UAC secure desktop；
- 锁屏后的可靠图像；
- 跨 Windows user session 切换。

如果未来产品必须覆盖这些场景，再评估独立 RDP/Windows-native backend；不要污染 v1 RFB contract。

## 18. 测试

### relay-protocol

- Desktop DTO round-trip；
- requestId/instanceId/streamId 长度上限；
- unknown kind fail closed；
- capability normalization。

### relay hub

- browser ticket 只能自己 account 使用；
- connector ticket 只能目标 instance 使用；
- ticket single-use / TTL；
- v1 同 instance 第二个 stream -> desktop-busy；
- binary frame 双向透传；
- text frame / oversize fail；
- slow peer backpressure close；
- browser close 清 connector；
- instance offline/supersede 清 stream；
- merged 8787 和 dedicated --ws-port 两种 path routing。

### channel-relay

- config parser 默认关闭；
- 只允许 loopback target（无 host config）；
- RFB banner/security probe；
- VncAuth accepted；
- None/VeNCrypt/ARD(v1) error；
- TCP <-> WS piping；
- ws backpressure pauses TCP；
- stop/logout closes tunnel；
- capability 只在 enabled 时出现。

### relay-web

- noVNC lazy import；
- open -> binary ws -> RFB connect；
- password prompt；
- security failure；
- disconnect/reopen；
- fit/actual；
- Desktop entry capability gating；
- keyboard and pointer smoke；
- ticket never persisted in local/session storage。

### hard gate

增加一个全链路测试：

~~~text
real relay server
 + real channel-relay
 + fake loopback RFB server
 + browser-like binary websocket client
~~~

证明 instance RFB bytes 能到 browser，browser input bytes 能回到 fake RFB server，且普通 /ws control 同时保持可用。

## 19. 发布阶段

### Phase A：Linux + Windows VncAuth MVP

- control contract；
- binary stream broker；
- channel-relay attach runtime；
- noVNC Desktop tab；
- Linux/Windows setup docs；
- 单 viewer。

### Phase B：macOS ARD

- ARD credential UI；
- connector-side pre-auth；
- secret redaction；
- macOS Screen Sharing 真机验证。

### Phase C：multi-view

只有完成 server-side RFB view-only parser/filter 后才增加：

- desktop.multi-view.v1；
- controller/spectator；
- take-control；
- viewer count；
- spectator resize suppression。

不要仅依赖 noVNC viewOnly 作为授权边界。

### Phase D：managed setup

按价值再做：

- Linux managed TigerVNC/XFCE；
- Windows explicit admin setup helper；
- doctor / repair workflow。

## 20. 与 RMUX Terminal 的关系

可复用：

- capability gating；
- hub-stamped identity；
- fail-closed routing；
- explicit resource limits；
- reconnect UX；
- structured logging。

不复用：

- terminal attachment protocol；
- base64 terminal bytes；
- rebase/epoch/sequence；
- session resource catalog；
- durable terminal registry / RMUX lease。

Desktop 是 instance-scoped streaming transport，Terminal 是 session-scoped persistent process resource；两者不要为了“统一”强行共享 runtime。

## 21. OpenClaw 调研结论（设计输入）

2026-09-24 核对的 OpenClaw 当前实现提供了以下可验证参考：

- Control UI 通过 @novnc/novnc 直接消费 RFB；
- Desktop observer 使用独立 binary WebSocket，framebuffer 不经过普通 node RPC；
- host/node 统一要求 loopback RFB endpoint；
- Windows 推荐 TightVNC，而不是 RDP；
- managed Windows 场景通过 interactive user session 运行 VNC，避免 service-session 抓错桌面；
- Linux 用 TigerVNC / WayVNC；
- macOS Screen Sharing 走 RFB，但 ARD authentication 由 server-side bridge 预认证；
- read-only viewer 不能只依赖 noVNC viewOnly，服务端需要 RFB message filter；
- stream 有 hard payload/backpressure 限制。

对应上游入口（仅供 reviewer 复核，不作为 xacpx runtime 依赖）：

- openclaw/openclaw: ui/src/components/desktop/desktop-client.ts
- openclaw/openclaw: src/gateway/desktop/observe-bridge.ts
- openclaw/openclaw: src/gateway/desktop/host-source.ts
- openclaw/openclaw: src/node-host/desktop-stream-command.ts
- openclaw/crabbox: docs/features/vnc-windows.md
- openclaw/crabbox: docs/features/vnc-linux.md
- openclaw/crabbox: docs/features/vnc-macos.md

## 22. 验收标准

Phase A 合并前至少满足：

1. Linux TigerVNC 实例从 relay-web 可观看、鼠标键盘可控；
2. Windows interactive-session TightVNC 实例从 relay-web 可观看、鼠标键盘可控；
3. 5900 无需公网暴露；
4. Desktop 大流量时 agent cancel / terminal input 不与其共享 WebSocket connection；
5. browser/connector 任意一侧断线后 Hub 无残留 stream；
6. ticket 过期/复用/跨 account 均失败；
7. 未开启 desktop 的 instance 不显示入口；
8. None/unsupported RFB auth fail closed；
9. full protocol/hub/channel-relay/web tests 与 typecheck 通过；
10. 文档明确 Windows lock/UAC、macOS ARD 和 multi-view 的当前边界。
