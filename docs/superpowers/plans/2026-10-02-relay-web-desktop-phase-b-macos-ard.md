# Relay Web · 实例桌面 Phase B（macOS ARD）实施记录

> 状态：已按设计 §5 的三项决定实现。
>
> 日期：2026-10-02。
>
> 设计：[`docs/superpowers/specs/2026-10-02-relay-web-desktop-phase-b-macos-ard-design.md`](../specs/2026-10-02-relay-web-desktop-phase-b-macos-ard-design.md)

## 1. 决定（设计 §5）

1. **能力位。** `desktop.rfb.v1` 仍是 Desktop 按钮的门。新增 `desktop.ard-auth.v1`：connector 在 prepare 上接受凭据并终止 RFB type 30。Hub 在转发凭据前检查它。浏览器不读它。启用 desktop 时，每个平台都在 `desktop.rfb.v1` 旁边声明它。
2. **字节。** 探测顺序仍是 type 2、Tight-only、type 30。没有 type 2 的 type 30 是 `{ ok: true, security: "ard" }`。`[2, 30]` 仍是 `vnc-auth`。ARD 在第二条 TCP 上由 `ard-auth.ts` 跑完，再向浏览器播放 18 字节 RFB 3.8 None 问候。VncAuth 的 banner 重放字节不变。
3. **凭据。** 同一对 `desktop-open` / `instance.desktop.prepare` 走两轮。第一轮无凭据，connector 返回 `desktop-credentials-required` 且不开 tunnel。第二轮携带 `credential: { kind: "ard", username, password }`。只有 `signIn` 发送它。公开的 `open()` 不接受凭据。

浏览器侧 ARD 不实现。认证在 connector。

## 2. 落地分层

~~~text
协议     DesktopCredential、闭集解析、desktop.ard-auth.v1、三个错误码
ard-auth  type 30 握手、AES-128-ECB、ServerInit 放回 socket、14 字节应答过滤
connector 探测把 type 30 判为 ard；openArdTunnel + spliceRaw；ArdSecret.wipe
hub       无能力位则在 reserve 前拒绝凭据；ard 走 reportConnectorReady
relay-web 账户表单、按 status 区分的会话行、signIn、重连再挑战
文档      本文件、设计 §5、desktop-rfb-setup 的 macOS 节
~~~

## 3. 安全点

- 凭据不进 URL、ticket、日志、RPC 结果。`ArdSecret` 的 `toJSON` / `util.inspect` 返回 `"[redacted]"`，`wipe()` 在 `handlePrepare` 的 `finally`。
- SecurityResult 失败是 `desktop-credentials-rejected`。成功之后、ServerInit 之前连接关闭是 `desktop-permission-denied`。停在 ServerInit 是 `desktop-stream-timeout`。
- `preauthArd` 使用 `ARD_PREAUTH_MAX_MS = 5000`，不用 `connectTimeoutMs` 截断。
- 客户端先写 128 字节密文，再写 DH 公钥。

## 4. 回归

- VncAuth 的 banner 重放期望字节不改。
- None、Tight-only、VeNCrypt 仍是 `desktop-auth-unsupported`。
- 多 viewer、托管安装、剪贴板、文件传输、录像、任意 TCP 转发仍不做。
