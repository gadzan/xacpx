# Relay Web · 实例桌面 Phase B（macOS ARD）

> 状态：已实现。本文记录落地时的三项决定，不再是待评审提案。
>
> 日期：2026-10-02。决定落在 `cursor/macos-ard-desktop-phase-b-8b8c`。
>
> 上游：
> - [`docs/superpowers/specs/2026-09-24-relay-web-desktop-rfb-design.md`](2026-09-24-relay-web-desktop-rfb-design.md) §5.3（认证在 connector）
> - [`docs/desktop-rfb-setup.md`](../../desktop-rfb-setup.md)
> - [`docs/relay-module.md`](../../relay-module.md)

## 1. 范围

relay-web 可以打开 macOS Screen Sharing。connector 在本机 loopback 上完成 Apple Remote Desktop（RFB security type 30），然后向浏览器播放一段固定的 RFB 3.8 None 问候。浏览器仍用公开的 noVNC 构造函数，不实现 ARD。

Phase A 的 VncAuth 路径保持原样：Linux 与 Windows、单 viewer、独立二进制 WebSocket、目标固定 `127.0.0.1:<port>`。xacpx core（`src/`）不参与。

## 2. 与 Phase A 的边界

| 边界 | 落地 |
|---|---|
| VncAuth 字节 | `readTunnelBanner`、`earlyChunks`、`forwardToWs` 不改。`openTunnel` 没有 ARD 分支。 |
| 探测顺序 | 先 type 2，再 Tight-only 拒绝，再 type 30。`[2, 30]` 仍是 `vnc-auth`。`[16, 30]` 仍是 Tight 拒绝。 |
| 能力位 | `desktop.rfb.v1` 仍是 Desktop 按钮的门。另加 `desktop.ard-auth.v1`。 |
| 凭据 | 只出现在一轮 `desktop-open` 和对应的 `instance.desktop.prepare` 上。不进 URL、ticket、RPC 结果、日志或磁盘。 |
| 弱认证 | None、Tight-only、VeNCrypt 仍是 `desktop-auth-unsupported`。 |

## 3. 为什么认证在 connector

macOS Screen Sharing 默认提供 type 30，不是 VNC 密码。noVNC 1.7.0 自己会做 ARD，但 Phase A 设计 §5.3 把平台认证放在 connector：浏览器只看到已经签入的 RFB 流。浏览器侧 `_negotiateARDAuth` 不采用。

## 4. 凭据与错误码

一轮 prepare 不带凭据。探测到 ARD 且没有凭据时，connector 返回 `desktop-credentials-required`，不开 tunnel。Hub 现有失败路径释放 stream。人在没有任何预约的时候输入。

下一轮 `desktop-open` 和 prepare 带 `credential: { kind: "ard", username, password }`。`signIn` 是唯一发送者。公开的 `open()` 不接受凭据。重连再问一次，不重发密码。账户名可以留在这个标签页的内存里做预填。

| 码 | 含义 |
|---|---|
| `desktop-credentials-required` | 挑战。relay-web 显示账户表单，不是错误横幅。 |
| `desktop-credentials-rejected` | SecurityResult 失败。表单保持打开并标出拒绝。 |
| `desktop-permission-denied` | SecurityResult 成功之后、ServerInit 之前 TCP 关闭。 |
| `desktop-stream-timeout` | 停在 ServerInit。慢启动不是权限拒绝。 |
| `desktop-auth-unsupported` | 实例没有 `desktop.ard-auth.v1`，或服务器是 None / Tight-only / VeNCrypt。 |

字段经 `parseDesktopCredential`：闭集，1 到 63 个 UTF-8 字节，不含 NUL。connector 把凭据放进 `ArdSecret`。`toJSON` 和 `util.inspect` 返回 `"[redacted]"`，`wipe()` 在 `handlePrepare` 的 `finally` 里清掉副本。

## 5. 三项决定

### 5.1 能力位

`desktop.rfb.v1` 继续作为 Desktop 按钮的门。`desktop.ard-auth.v1` 表示 connector 会在 prepare 上接受凭据并自己完成 RFB type 30。Hub 在转发任何凭据之前检查它。浏览器不读这个能力位。只要启用了 desktop，每个平台都在 `desktop.rfb.v1` 旁边声明它。

没有该能力位的实例收到凭据时，Hub 在 `reserve` 之前返回 `desktop-auth-unsupported`。

### 5.2 字节

探测顺序不变：type 2，然后 Tight-only，然后 type 30。没有 type 2 的 type 30 是 `{ ok: true, security: "ard" }`。`[2, 30]` 仍是 `vnc-auth`。探测 socket 仍然销毁。

ARD 在第二条 TCP 连接上跑，代码在 `packages/channel-relay/src/desktop/ard-auth.ts`。顺序是 SecurityResult、ClientInit 字节 `0x01`、读完整的 ServerInit 再放回 socket。浏览器先收到固定的 18 字节 RFB 3.8 None 问候（`RFB 003.008\n`、类型个数 1、类型 1、SecurityResult `00 00 00 00`），然后是那些 ServerInit 字节。noVNC 的 14 字节应答校验前 13 字节，14 字节全部丢弃。VncAuth 的 `readTunnelBanner`、`earlyChunks`、`forwardToWs` 字节不变。

客户端线序对齐 noVNC 1.7.0 `_negotiateARDAuthAsync`：128 字节 AES-128-ECB 密文在前，客户端 DH 公钥在后。密钥是共享秘密左填充到 `keyLength` 后的 MD5。每一半凭据 64 字节：UTF-8 字段、一个 NUL、随机填充。`preauthArd` 使用自己的 `ARD_PREAUTH_MAX_MS = 5000`，不用 `connectTimeoutMs` 去截断。

`handlePrepare` 把 `vnc-auth` 交给现有的 `openTunnel`，把 `ard` 交给 `openArdTunnel`。两者共用同一个 pending 记录。不含方案逻辑的监听尾部是 `spliceRaw(tunnel, fromBrowser)`。VncAuth 传入恒等函数。`classifySecurityTypes` 和 `ard-auth.ts` 不从 `packages/channel-relay/src/index.ts` 导出。

### 5.3 凭据通道

沿用现有的 `desktop-open` / `instance.desktop.prepare` 一对消息，走两轮。第一轮没有凭据。第二轮在这两条消息上携带 `credential`。不新增 connector RPC，不在人打字期间占用 desktop 槽位。

Hub 只通过新建的 prepare 对象转发凭据，不展开传入消息。`security: "ard"` 但这一次 open 没有凭据，是 `desktop-protocol-error`。有凭据的 `ard` 结果走和 VncAuth 相同的 `reportConnectorReady`。会话行按 `status` 区分：`prompt` 只存在于 `auth-required`。

## 6. 明确不做

多 viewer、托管安装、剪贴板同步、文件传输、录像、任意 TCP 转发、改 `src/`。
