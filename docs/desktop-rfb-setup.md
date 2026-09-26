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
          "connectTimeoutMs": 3000,
          "upgradeTimeoutMs": 5000
        }
      }
    }
  ]
}
```

- `enabled=false`（默认）时不声明 `desktop.rfb.v1`，relay-web 不会显示 Desktop 入口。
- `port` 只能是**本机 loopback**。RFB server 不需要公网可达；connector 主动连
  `127.0.0.1:<port>`。
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
4. **监听 loopback**：`Access Control → Loopback connections` 选
   `Allow loopback connections`。不需要允许 LAN/远程。
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

标准 VncAuth，无额外选项：

```bash
# x11vnc：镜像当前 X11 桌面
x11vnc -display :0 -rfbport 5900 -passwdfile ~/.vnc/passwd
```

```bash
# TigerVNC：新建一个虚拟桌面（需要连 DISPLAY 时）
tigervncserver :1 -geometry 1920x1080 -localhost
```

### WayVNC 仅 legacy 模式

Wayland 下的 WayVNC 默认开启安全加密，connector 不接 VeNCrypt，所以默认配置会被
判 `desktop-auth-unsupported`。必须显式以降级模式运行：

```
wayvnc 0.6+:
# ~/.config/wayvnc/config
security_type=vnc-auth
relax_encryption=true
allow_broken_crypto=true
```

或旧版按各自配置文件用相同语义的键。**这是弱安全过渡**：只用 loopback 时风险有限，
但不要把这些开关复制到非 loopback 部署。

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

- **Hub 日志**：stream 生命周期 `relay.desktop.stream.*`（开/关/close reason）。
- **connector 日志**：probe verdict（含 server 拒绝原因原文）、tunnel 出错原因。
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
