# Relay Web · 实例桌面 Phase B(macOS ARD)设计

> 状态:**提案,待评审。Phase B 实现刻意推迟。**
>
> 日期:2026-10-02。
>
> 读者:后续实现 agent、reviewer、安全评审负责人。
>
> 上游文档:
> - docs/superpowers/specs/2026-09-24-relay-web-desktop-rfb-design.md(Phase A 设计与 Phase B 边界)
> - docs/superpowers/plans/2026-09-24-relay-web-desktop-rfb.md(Phase A 实施计划,§12 的 Phase B 占位)
> - docs/desktop-rfb-setup.md(平台 setup 与现有认证边界)

## 1. 范围与定位

本文件是 **Phase B 的准备文档**,不是实现。它定义目标、边界、设计方向和验收标准,
供后续独立 review 与排期使用。

**Phase B implementation is intentionally deferred.** 在收到明确的实现指令之前,
不写 runtime code、不改协议、不改 connector 行为。

Phase B 的目标只有一个:

> 让 relay-web 能打开 macOS 实例的桌面,即支持 macOS Screen Sharing / ARD 的认证路径。

Phase A 已交付并仍在维护:

- Linux(TigerVNC / x11vnc / WayVNC legacy VncAuth)与 Windows(interactive TightVNC, VncAuth);
- 单 viewer;
- 独立 binary WebSocket 数据面;
- loopback-only target + 短生命周期单次使用 ticket 的安全模型。

## 2. 与 Phase A 的边界

Phase B 必须满足以下约束,任何一条被破坏都应在 review 中被拒绝。

| 边界 | 要求 |
|---|---|
| VncAuth 流程 | Phase A 的 VncAuth 路径**逐字节保持**。Phase B 是 additive:existing Linux/Windows 行为、错误码、probe 分类不得改变。 |
| 现有 capability | `desktop.rfb.v1` 语义不变。是否需要新的 capability(如 `desktop.ard.v1`)由 §5 讨论,不得复用/改写现有能力位。 |
| 控制面 | 登录、capability、开流、错误、审计仍走现有 JSON relay 协议。credentials **不**进入 RelayEnvelope。 |
| 数据面 | framebuffer 继续走独立 binary WebSocket,不进入 base64、不共享 control connection。 |
| loopback 边界 | Desktop target 仍是实例本机 loopback。Phase B 不开放任意 TCP 端口,不把 Desktop tunnel 变成通用代理。 |
| xacpx core | 仍不引入 OS 图形 API;平台差异仍只存在于实例本机的 RFB server 与 connector。 |

## 3. 为什么 macOS 需要单独一个 Phase

Phase A 用 RFB 3.3/3.7/3.8 的 VncAuth(security type 2)作为跨平台统一契约。macOS
Screen Sharing 底层确实提供 RFB,但其认证不是普通 VncAuth:

1. **认证形态不同。** ARD(Apple Remote Desktop)的 `Diffie-Hellman` + `Plain`/`MSLogonII`
   形式与标准 VncAuth 的 DES challenge/response 不同;Phase A 的 probe 现在把 ARD 明确
   归类为"可识别但 Phase B 前 unsupported"(`docs/.../design.md` §"ARD 返回可识别但在
   Phase B 前明确 unsupported")。
2. **账号模型不同。** ARD 认证通常针对 macOS 账号(可能带域名/前缀),而不是单个 VNC password。
3. **权限模型不同。** macOS 上 Screen Sharing 需要 Screen Recording / Accessibility 授权,
   错误形态与 Linux/Windows 的 setup error 不同,需要可区分的诊断。

因此 Phase B 不是"加一个 security type",而是**引入一次 connector-side 平台认证**,
并把"已认证的 RFB stream"而不是"凭据"暴露给 browser。

## 4. 设计目标

### 4.1 ARD credential handling

- browser **不直接**参与 ARD handshake;
- 账号/密码只在一次 authenticated control request 的短生命周期内存在:
  browser -> relay(已登录的控制连接)-> connector;
- **不落盘、不进入 URL/query、不进入 RPC result、不写日志**;
  与 Phase A 的"ticket、VNC password、ARD password 不写日志"一致;
- connector 完成 ARD handshake 后,向 browser 暴露**已认证的** RFB stream。

### 4.2 connector-side authentication

- connector 持有平台特定实现(ARD 握手在实例本机完成);
- connector 与 macOS Screen Sharing 之间仍是 loopback 连接;
- 认证失败必须在 connector 侧归类,并向 browser 返回**稳定错误码**,
  而不是一段自然语言;
- 认证成功后,后续 RFB 帧由现有 tunnel runtime 透传——不新增数据面。

### 4.3 browser 侧

- browser 只看到"一个可用的 Desktop stream"和"需要账号密码"的 UI 状态;
- browser **不**实现任何 ARD 协议细节;
- noVNC 侧需要能在这个已认证 stream 上继续 RFB(这可能涉及 handshake 重写,见 §5 风险)。

### 4.4 credential 生命周期与安全边界

- 单次使用:一次 prepare 对应的凭据只在这一次握手有效;
- 短生命周期:与 Phase A 的 prepare deadline 对齐,超时即作废;
- 不持久:进程内存外不留存;重连需要重新提交;
- 不可转发:凭据不出现在任何 URL、ticket、log、audit 事件中;
- 失败即抛:握手失败不保留半认证状态,connector 关闭该 stream 并归还 slot。

## 5. 待评审的设计决策

以下三点**尚未定稿**,是实现前必须由 review 决定的。本文件只列出选项与取舍,
不代替决策。

1. **capability 表达。** 新增 `desktop.ard.v1` 能力位,还是沿用 `desktop.rfb.v1`
   并在 prepare 结果里带 `security: "ard"`?Phase A 已经在 DTO 中预留了 `ard` 这一
   security 取值(见 `RELAY_CAPABILITIES`/`DesktopPrepareResult`),但当前会以
   `desktop-auth-unsupported` 失败。需要确认"预留但未实现"是否就是最终形态。

2. **handshake 重写的范围。** 如果已认证 stream 需要 noVNC 从"security types 协商"
   之后继续,那么 connector 侧必须改写/重放握手,这正是 Phase A 设计 §461 标记的
   "涉及 RFB handshake 重写和 secret handling,实现必须单独 review"的部分。
   需要明确:重放哪些阶段、哪些字节、如何在 banner revalidation 上与 Phase A 的
   现有 guard 共存。

3. **凭据输入通道。** 复用现有 `credentialsrequired` UI,还是新增 macOS 账号形态
   (可能含域名)的输入?前者实现面最小,但语义上"VNC password"与"ARD account"不同。

## 6. 明确的不做(Non-goals)

Phase B **不做**:

- 不修改 Phase A 的 VncAuth 流程或 probe 分类;
- 不实现多 viewer(Phase C,取决于 server-side RFB view-only filter);
- 不引入 managed setup / 自动安装 VNC server;
- 不做自动 clipboard 同步、文件传输、framebuffer 录像;
- 不开放任意 TCP tunnel、不暴露 5900;
- 不改 xacpx core。

## 7. 验收标准(草案)

实现 PR 提出时应满足,且每一项都应有对应测试:

1. macOS Screen Sharing 实例从 relay-web 可打开 Desktop,凭据在 browser 提交后由 connector 完成 ARD 认证;
2. 认证失败返回稳定错误码,且能区分"凭据被拒"与"平台权限不足(如缺少 Screen Recording 授权)";
3. 凭据不出现在 URL、ticket、log、RPC result、audit 事件中(有对应的 secret-redaction 测试);
4. Linux/Windows VncAuth 路径行为不变(Phase A 的 desktop 测试套件全绿);
5. Desktop 大流量下 control 请求仍独立(Phase A 的 hardgate 断言保持);
6. 断线/取消/重连无残留 stream,凭据不跨重连复用;
7. macOS 真机验证(一台真实 macOS 实例)通过。

## 8. 当前仓库状态与此 PR 的关系

本 PR **只**包含:

- 本设计文档;
- 实施计划草稿;
- issue checklist。

**不包含任何 runtime code、protocol、connector 或安全模型的改动。**
