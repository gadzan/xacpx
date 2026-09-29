# 实例桌面（RFB/VNC）配置指南

> 状态：Phase A（Linux + Windows VncAuth，单 viewer）。设计依据
> `docs/superpowers/specs/2026-09-24-relay-web-desktop-rfb-design.md`，
> 后端语义见 `docs/relay-module.md`。

本文只讲一件事：让在线实例的本地图形桌面能通过 relay-web 观看与控制，同时
**不对外暴露 5900**。xacpx core 不参与本功能；RFB/VNC server 完全由你负责。

## 1. 边界（Phase A 不支持）

| 能力 | Phase A |
| --- | --- |
| 平台 | Linux、Windows |
| 认证 | 仅 outer VNC Auth（RFB security type 2） |
| Viewer 数 | 1（第二个 viewer 收到 `desktop-busy`） |
| 桌面旋转 | 不支持（`desktop.remote-resize.v1` 未实现） |
| viewer/controller | 不支持（`desktop.multi-view.v1` 未实现） |
| macOS ARD 预认证 | 不支持（Phase B） |
| 任意 TCP 转发 | 永远不支持；目标固定 `127.0.0.1:<port>` |

None（无认证）、VeNCrypt/TLS-only、专有认证与 macOS ARD 认证一律
fail closed，报 `desktop-auth-unsupported`。这不是部署失误，是刻意的安全边界：
connector 拒绝让弱认证平面成为 xacpx 连接面的旁路。

## 2. 配置

在目标实例对应的 channel-relay 配置段启用：

```json
{
  "channels": [
    {
      "type": "relay",
      "options": {
        "desktop": {
          "enabled": true,
          "port": 5900,
          "connectTimeoutMs": 3000
        }
      }
    }
  ]
}
```

- `enabled=false`（默认）时不声明 `desktop.rfb.v1`，relay-web 不会显示 Desktop 入口。
- `port` 只能是**本机 loopback**。RFB server 不需要公网可达；connector 主动连
  `127.0.0.1:<port>`。
  这是**单向约束**：它固定了 connector 去连哪里，但没有限制 RFB server 监听在
  哪个地址。所以「不暴露 5900」还需要 RFB server 自己只监听 loopback
  （见 §3/§4 的具体开关与验证命令）。两侧都得是 loopback，边界才成立。
- `connectTimeoutMs`（250–10000）同时用于 loopback TCP 连接、banner preflight 与
  Hub `/desktop/instance` upgrade 三者，不提供单独的 upgrade 超时。
  唯一例外：真正建立 tunnel 时读取 12 字节 RFB banner 有**独立的 2 秒硬上限**
  （`Math.min(timeoutMs, 2000)`）。两者都是“越慢越早失败”的保守设定——一个已经接受
  了 TCP 连接的 loopback server 没有理由把 12 个字节压着不发。
- 完整 schema 与默认值见 `docs/config-reference.md`。

启用后实例出现 Desktop 入口；不代表 5900 已在监听——真正 open 时才重新 probe。

## 3. Windows（TightVNC）

要求全部满足：

1. **下载 TightVNC**（`tightvnc.com/download.php`），安装 `Server`。
2. 以**交互用户会话**运行：登录到该用户桌面后启动。**服务会话不是可靠的桌面源**，
   session 0 与服务隔离后看到的桌面不是用户当前桌面。
3. **开启 VNC authentication**：
   ` TightVNC Server: Configuration → Server → Authentication` 选
   `VNC password, Windows logon...` 之外**纯 VNC password** 那一项，设置密码。
4. **拒绝非 loopback 连接**：`Access Control → Loopback connections` 选
   `Allow loopback connections`。不需要允许 LAN/远程。

   这里要说清一个常常被混淆的语义：TightVNC 可验证的配置项
   （`LoopbackOnly` / 注册表 `SET_LOOPBACKONLY`、`VALUE_OF_LOOPBACKONLY=1`）描述都是
   "allow only loopback connections"，属于**访问控制**——它让外部连接被拒绝，但
   **不保证 socket 的 bind address 是 127.0.0.1**。也就是说 TightVNC 很可能仍然绑定
   `0.0.0.0:5900`，只是不接受来自外部的连接。

   因此本文档对 Windows 的安全承诺是「**外部连接被拒绝**」，而不是「只 bind
   loopback」。达到它需要两项同时成立：

   - TightVNC 侧设为仅允许 loopback；
   - Windows Firewall 侧阻止外部访问该端口。

   验证（在实例机器上执行）：

   ```bash
   netstat -ano | findstr :5900
   ```

   只期望看到 `127.0.0.1:5900` 条目。**如果看到 `0.0.0.0:5900`，那说明监听面没有被
   限制**，此时该桌面是安全的唯一依赖是 loopback-only 设置 + 防火墙，而不是端口本身
   不可达。TightVNC 是否有可验证的 bind-address-only 配置项尚未确认，需要 §14 的
   Windows 真机项给出结论；在确认之前，不要把这条指令理解为「5900 必然只在 loopback
   上监听」。
5. 确认 outer security 列表里有 **type 2（VNC Auth）**。仅提供 Tight（outer type 16）
   的端点会被拒绝（见 §6）。

### 锁屏 / UAC / 登录屏

**不做保证。** 这是 Windows 交互式桌面的固有限制：

- 工作站锁定后，TightVNC 继续渲染但输入不落到锁屏；relay-web 看到的是"画面在动、
  键鼠无响应"。
- UAC 提权台面在 secure desktop，VNC 不可见也不可输入。
- 控制远程主机时，远程那台必须是**已登录**状态。

这是设计文档里明确的 Phase A 边界，不是 bug。如果需要看登录屏，请使用平台自带的
RDP/远程管理能力。

## 4. Linux（TigerVNC / x11vnc）

标准 VncAuth，**且必须只监听 loopback**：

```bash
# x11vnc：镜像当前 X11 桌面
# -localhost 隐含 -listen localhost：把监听地址限制到本机。没有它 x11vnc 默认
# 监听所有接口，5900 会暴露到 LAN/公网—— connector 固定拨 127.0.0.1 只约束
# 「它连哪」，不约束「谁在听」，所以这一项不能省。
x11vnc -display :0 -rfbport 5900 -localhost -passwdfile ~/.vnc/passwd
```

```bash
# TigerVNC：新建一个虚拟桌面（需要连 DISPLAY 时）
# Xvnc 默认 RFB 端口是 5900 + display number，所以 :1 会监听 5901。
# 用 -rfbport 显式固定成下面配置示例里的 5900。
tigervncserver :1 -geometry 1920x1080 -localhost -rfbport 5900
```

启动后必须验证监听面，否则文档承诺的「不对外暴露 5900」不成立：

```bash
# 期望：只出现 127.0.0.1:5900，不出现 0.0.0.0:5900 / [::]:5900
ss -ltnp | grep 5900
```

### WayVNC 仅 legacy 模式

Wayland 下的 WayVNC 默认开启安全加密，connector 不接 VeNCrypt，所以默认配置会被
判 `desktop-auth-unsupported`。必须显式以降级模式运行。

**需要 WayVNC 0.10.0 或更新**：legacy DES（VNC auth）是 0.10.0 才实现的，更早的
版本即使关掉加密也没有 vnc-auth 可协商。

```
# ~/.config/wayvnc/config
enable_auth=true
password=YOUR_VNC_PASSWORD
relax_encryption=true
allow_broken_crypto=true
```

**`enable_pam` 必须保持关闭**：PAM 一旦启用会覆盖上面的 password 认证，connector
看到的就是非 outer VncAuth 的认证面并被 fail closed。

注意官方配置关键字是 `enable_auth` / `password`，没有 `security_type` 这一项——旧文
档写的版本不可用。**这是弱安全过渡**：只用 loopback 时风险有限，但不要把这些开关
复制到非 loopback 部署。

### GNOME 远程桌面（内置共享）

GNOME Settings → Sharing → Remote Login 走 VeNCrypt，**Phase A 不支持**。请改用
x11vnc 或 TigerVNC。

## 5. macOS

Phase A 只接标准 VncAuth RFB server。Apple Screen Sharing 默认 ARD auth，
报 `desktop-auth-unsupported`（需 Phase B 的 connector 侧预认证）。

临时方案：安装 TightVNC Viewer/Server 或 TigerVNC，配置为纯 VNC password + loopback。

## 6. 排障

Open 失败时错误码与含义：

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `desktop-disabled` | 实例未启用 desktop | 改 `enabled=true`，重连 connector |
| `desktop-busy` | 已有 viewer | 关掉另一个 Desktop 标签页 |
| `desktop-rfb-unavailable` | 连不上 loopback 端口 | RFB server 没启动/端口不对 |
| `desktop-not-rfb` | 端口在监听但不是 RFB | `desktop.port` 指向别的服务了 |
| `desktop-auth-unsupported` | 认证方式不被接受 | 见下 |
| `desktop-stream-timeout` | tunnel/upgrade 超时 | 网络抖动；可重试 |
| `desktop-instance-offline` | 实例掉线 | 等实例回来；可重试 |
| `desktop-auth-failed` | 密码被 VNC server 拒绝 | 换个密码重试 |

错误文案已包含平台相关的设置提示（`platform-guidance.ts` 生成），直接照文案改配置即可。

### `desktop-auth-unsupported` 的常见原因

1. TightVNC 只给了 outer **Tight (16)**，没给 **type 2**——请在 Authentication 里
   选 VNC password 模式。outer 16 + type 2 同时存在时正常接受，且永不进入 Tight
   子协商。
2. GNOME Screen Sharing（VeNCrypt）、macOS Screen Sharing（ARD）——见 §4/§5。
3. RFB server 允许 None 但 connector 策略拒绝（默认策略就是拒绝 None）。

### 诊断信息在哪

- **Hub 日志**：stream 生命周期 `relay.desktop.stream.*`——`stream_active`（两侧 attach
  成功，framebuffer 开始流动）与 `stream_closed`（含 close reason），以及
  `text_frame` / `oversize_frame` / `backpressure_close` / `preattach_overflow`
  这些拒绝与驱逐事件。
- **connector 日志**：`relay.desktop.probe_rejected`（含 RFB server 拒绝原因原文
  `detail`）、`probe_ok`、`tunnel_failed`。
- **relay-web 面板**：错误横幅展示 code + 详情；VNC 密码输错会在密码框提示
  认证失败，而不是笼统超时。

connector 侧没有独立 desktop doctor 命令。Phase A 的选择是：把 open 错误做到
可诊断（上述文案 + connector 侧日志）而不是新建一个大 doctor 框架。

## 7. 安全约束

- **loopback 唯一目标**：`port` 只能连 `127.0.0.1`，杜绝把 connector 变成任意 TCP 代理。
- **不进控制面**：framebuffer / 键鼠走独立二进制 WebSocket（`/desktop/observe`、
  `/desktop/instance`），永不 base64 进 RelayEnvelope。
- **ticket 单次 + 60s TTL**，绑定 account + instance + side；过期/复用/跨账号都拒绝。
- **密码只在 tab 内存**，不写 localStorage/sessionStorage，不进日志、不进 ticket。
- **关闭只关 tunnel**，不停系统 VNC server；connector 退出/断线清空所有 tunnel。
