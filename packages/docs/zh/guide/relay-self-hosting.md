# 自托管 Relay Hub

**Relay Hub** 是一个可选的、自托管的服务端，它能把 xacpx 变成一个多租户的远程遥控看板。你的各个 xacpx 实例会通过 WebSocket **主动向外**拨号连接到 Hub 并注册；随后你即可从任意浏览器登录 Web 看板，在同一个地方驱动每个实例的会话——聊天、定时任务和编排。

本指南将带运维人员从零开始，搭建一个已配对实例并正常运行的 Hub。

## 架构速览

```
   xacpx instance A ─┐                         ┌─ browser (token login)
   xacpx instance B ─┤  WSS (dial-out)         │  HTTPS + WSS
   xacpx instance C ─┴──────────────►  RELAY HUB  ◄───────────┘
                          :8787 HTTP API + web /ws + instance gateway
                                  │
                              relay.db (SQLite)
```

- **单端口（默认）。** HTTP API、看板的 `/ws` 广播与**实例** WebSocket 网关（xacpx 实例在此注册）全部共用 **8787**——连接器通过根路径上的 WebSocket 升级完成注册。仅当你想要一个可独立配置防火墙的专用网关端口时，才传入 `--ws-port`。
- **多租户。** 每个 token 用户永远只能看到属于自己的实例和会话；服务端会在每次代理调用上打上身份标记。令牌、实例凭据和 Web 会话 Cookie 均以哈希形式存储。
- **数据真相源仍在实例侧。** Hub 会为看板缓存近期消息，但它并不拥有你的会话——会话归实例所有。

## 环境要求

- **Node.js ≥ 22.13**（使用内置的 `node:sqlite`）**或 Bun ≥ 1.2**（使用 `bun:sqlite`）。无需编译原生数据库插件。
- 一台可被你的实例和浏览器访问到的主机。对于 localhost 之外的任何部署，你都需要一个负责 TLS 终止的反向代理（参见 [TLS 与反向代理](#tls-reverse-proxy)）。
- 要配对实例，每个实例都需要 `xacpx` CLI（即[快速开始](/zh/guide/getting-started)中的常规安装）。

## 1. 获取服务端

全局安装 relay Hub。安装时会一并拉取看板包 `@ganglion/xacpx-web`，所以这一条命令就够了——无需单独构建看板、无需 `--web-root`：

```bash
npm i -g @ganglion/xacpx-relay
```

这会把 `xacpx-relay` 二进制放进你的 `PATH`。看板包会在启动时自动解析；`start` 命令会打印它解析出的路径（见下文）。

::: details 改为从源码运行（开发 / 贡献）
克隆仓库并构建服务端——`build:relay` 同时会构建 `@ganglion/xacpx-web`，hub 把它当作依赖来提供看板：

```bash
git clone https://github.com/gadzan/xacpx
cd xacpx
bun install && bun run build:relay
```

此时入口是 `packages/relay/dist/cli.js`——下文中所有 `xacpx-relay <command>` 都用 `node packages/relay/dist/cli.js <command>` 代替。
:::

## 2. 快速上手（无需任何参数）

认证完全基于令牌——**没有密码、没有管理员账户**。一个令牌就是一个用户。签发令牌后启动服务端：

```bash
# 步骤 A — 创建用户 + 令牌（DB 自动创建于 ~/.xacpx-relay/relay.db）
xacpx-relay add token

# 步骤 B — 启动服务端（使用相同的默认 DB；看板自动检测）
xacpx-relay start
```

`add token` 会**只打印一次**令牌：

```
access token: bBS9nN2W2MwdrdksoLTLrQeMLMah9M5flTOyEcBbIHc
(store it now — not shown again)
hint: use this token for web login AND: xacpx channel add relay --url <host> --token <token>
```

`start` 会确认运行状态：

```
xacpx-relay listening: http :8787, instance gateway: merged on http :8787 (path / or /gateway), db ~/.xacpx-relay/relay.db, dashboard: /usr/lib/node_modules/@ganglion/xacpx-web/dist
```

打开 `http://<host>:8787`，将令牌粘贴到 **Access token** 输入框，即可登录。

## 3. 令牌管理

Hub 的全部管理操作都通过少量 CLI 子命令完成（`add token` / `add invite` / `ls` / `rm token` / `rm invite` / `start` / `update`），所有标志均为可选：

### `add token` — 创建用户 + 登录令牌

```bash
xacpx-relay add token [--label <备注>] [--db <路径>]
```

每次调用都会创建一个独立的用户，并只打印一次访问令牌。同一个令牌可用于：
1. 登录 Web 看板（粘贴到 **Access token** 输入框）。
2. 配对 xacpx 实例（在 `channel add relay` 中传入 `--token <T>`）。

在多个实例上复用**同一个**令牌，可将它们归属于同一个用户。

### `ls` — 列出令牌

```bash
xacpx-relay ls [--db <路径>]
```

显示：短 ID、备注标签、创建日期、已配对实例数量。

### `rm token` — 吊销令牌（及其用户）

```bash
xacpx-relay rm token <值或ID> [--db <路径>]
```

删除该令牌对应的用户，并级联删除其实例、Web 会话和缓存消息。吊销后，该令牌的 Web 会话将在下次请求时失效；已打开的看板 `/ws` 长连接会在下次重连时才断开。若要立即强制断开所有会话：停止 Hub，执行 `sqlite3 <db> "DELETE FROM web_sessions;"`，然后重启。

### `add invite` — 通过链接邀请他人

不方便（或不想）在服务器上替对方铸令牌时，可以给对方一个**一次性邀请链接**：

```bash
xacpx-relay add invite [--label <备注>] [--ttl <n>{m|h|d}] [--url <站点地址>] [--db <路径>]
```

邀请码只打印**一次**；传 `--url` 时会额外打印可直接分享的兑换链接（不传则打印 `/invite/<code>` 路径，自行拼到 hub 域名后即可）：

```
invite code: mJ3…
redeem link: https://relay.example.com/invite/mJ3…
(share it now — single-use, not shown again; expires 2026-08-02 12:00 UTC)
```

对方打开链接后看到兑换页面，**点击按钮才会兑换**（链接预览和爬虫抓取不会烧掉邀请码）；兑换即创建一个全新账号，并且其访问令牌只显示这一次——语义与 `add token` 完全一致，只是变成了自助领取。

- `--ttl` 默认 `7d`（支持 `30m`、`12h`、`3d` 等，上限 10 年）。
- 邀请码单次有效、哈希落盘；已用/过期的码由每小时 GC 自动清理。
- 兑换端点与登录共用同一限流桶（按 IP 统计——反代后方记得 `--trust-proxy`）。
- `ls` 会追加 **invites** 段（短 id、标签、过期时间、状态 `unused|used|expired`）；用 `rm invite <码或ID>` 删除（不影响已兑换出的账号）。

::: warning 邀请链接会出现在反代日志中
邀请码明文位于 URL 路径中，反向代理的 access log 会记录**未兑换**的邀请链接（兑换后即作废，无风险）。在意的话可缩短 `--ttl`，或在反代对 `/invite/` 路径关闭访问日志。
:::

### `start` — 启动服务端

```bash
xacpx-relay start \
  [--db <路径>] \
  [--web-root <目录>] \
  [--host 0.0.0.0] \
  [--http-port 8787] \
  [--ws-port <n>] \
  [--request-timeout-ms 120000] \
  [--trust-proxy]
```

| 标志 | 默认值 | 用途 |
|---|---|---|
| `--db <路径>` | `~/.xacpx-relay/relay.db` | SQLite 数据库文件。目录会自动创建。 |
| `--http-port <n>` | `8787` | HTTP API **以及**看板的 `/ws` 广播。 |
| `--ws-port <n>` | _（已合并）_ | 省略则把实例网关合并到 HTTP 端口（单端口默认）。传入一个端口则会启动一个可单独配置防火墙的专用网关监听器。 |
| `--host <地址>` | `0.0.0.0` | 绑定地址。 |
| `--web-root <目录>` | _（自动检测）_ | 看板资源目录。自动解析已安装的 `@ganglion/xacpx-web`；仅在需要覆盖时才传入。 |
| `--history-retention-days <n>` | _（已退休）_ | 为兼容旧脚本而保留接受，但会被忽略——聊天记录现在保存在各设备上（看板 IndexedDB），不在 Hub 上。 |
| `--request-timeout-ms <n>` | `120000` | 代理到实例的每次请求超时时间。 |
| `--trust-proxy` | _（关闭）_ | 信任 `X-Forwarded-For` 用于限速。在反向代理后面运行时传入此参数；**绝不**在直接暴露于公网时使用（否则会导致 IP 伪造）。 |

没有 `stop`/`status` 子命令——请用 `Ctrl-C` / `SIGTERM` 停止 Hub（生产环境请在 systemd、pm2 或 Docker 下运行以管理生命周期）。

::: tip 限速说明
Hub 会对每个客户端 IP 进行限速，并设有全局失败上限。在反向代理后面运行时，传入 `--trust-proxy`，使 Hub 使用 `X-Forwarded-For` 中的真实客户端 IP 进行限速，而非代理的回环地址。
:::

## 4. 配对 xacpx 实例

### 挂载实例

在运行 xacpx 实例的机器上，使用步骤 2 中创建的**同一个令牌**添加 relay 连接器频道：

```bash
xacpx plugin add @ganglion/xacpx-channel-relay
xacpx channel add relay --url relay.example.com --token <T> [--name home-pc]
xacpx restart
```

把 `--url` 指向**与看板相同的主机**——裸域名会解析为 `wss://relay.example.com`，合并后的网关与该主机共用。`xacpx plugin add` 会从 npm 安装连接器，并自动拉取其依赖 `@ganglion/xacpx-relay-protocol`。实例侧的 `xacpx` 核心需 **≥ 0.24.10-beta.18**（连接器的 peer 要求）。

::: details 从源码检出目录配对（开发）
如果你从仓库检出目录运行实例，workspace 已经链接好了 `channel-relay` 与 `relay-protocol`——跳过 `plugin add`，直接运行 `xacpx channel add relay …` 即可。
:::

### `--url` 简写规则

`--url` 接受以下多种形式；连接器会自动将其规范化为完整的 WebSocket URL：

| 传入的值 | 解析结果 |
|---|---|
| `relay.example.com`（裸域名） | `wss://relay.example.com` |
| `1.2.3.4`（IP） | `ws://1.2.3.4:8787` |
| `1.2.3.4:9000` | `ws://1.2.3.4:9000` |
| `localhost` | `ws://localhost:8787` |
| `host:9000` | `ws://host:9000` |
| `ws://…` 或 `wss://…` | 原样使用 |
| `http://…` 或 `https://…` | 映射为 `ws://…` / `wss://…` |

::: warning IPv6
不支持未加方括号的裸 IPv6 地址。请使用 `[::1]:8787` 格式。
:::

### 配对工作原理

首次连接时，实例会用访问令牌换取一个长期有效的专属凭据，以 `0600` 权限写入 `<xacpx-home>/relay/credential.json`。配对令牌本身**会**持久化保存在 `~/.xacpx/config.json` 中（与 url/name 并列）——请把该文件当作机密对待，因为拿到令牌即可冒充该实例。令牌**仅在首次配对时使用**——后续所有重连均使用存储的凭据。

::: tip 一个令牌，多个实例
可以在多台机器（如 `home-pc`、`work-laptop`）上复用同一个令牌，它们都会在看板中归属于同一个用户。
:::

::: warning 从双端口（0.1.0）布局升级
默认已改为单端口。早先针对旧 `8788` 网关配对过的连接器，其 `config.json` 里冻结了 `ws://<host>:8788`（URL 只在 `channel add` 时规范化一次），所以它会继续连 `:8788`。请重新运行 `xacpx channel add relay --url <host> …`（或直接改存储的 `url`），让它指向合并后的 HTTP 端口。裸**域名**连接器（`wss://host`，不带端口）不受影响——它们本就落在合并网关上。
:::

回到看板，实例上线后会出现在左栏，并带有一个绿色圆点。选中某个会话即可聊天；打开任务面板（右栏，或移动端的 **Tasks** 按钮）可查看定时任务与编排任务。

## TLS 与反向代理 {#tls-reverse-proxy}

Hub 只说**明文** HTTP 和 WS。对于任何非 localhost 的部署，请在反向代理处终止 TLS，并转发那一个 HTTP 端口。实例随后应使用 `wss://` 连接。

看板的实时更新会在 **HTTP 端口**上发起 WebSocket 升级，因此代理也必须在该路由上允许升级。合并后的实例网关通过根路径上的 WebSocket 升级搭乘同一端口，因此这一条被代理的路由即可同时覆盖两者。

### Caddy

```text
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy 会自动为看板的 `/ws` 和网关根路径代理 WebSocket 升级——无需额外配置。

### nginx

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### 别让桌面票据进访问日志

如果你启用了实例桌面（RFB/VNC），浏览器和连接器会各自建立一条 WebSocket，其票据**必须**放在查询字符串里：

```text
/desktop/observe?ticket=<browser-ticket>
/desktop/instance?ticket=<connector-ticket>
```

浏览器的 WebSocket API 无法设置自定义认证头，所以查询字符串是那里唯一的载体；连接器侧沿用同样的形状，让两个平面行为一致。xacpx 自己的日志从不写这些票据（连接器只上报 origin+path），但**任何记录了请求 URI 的代理都会以明文把它们记下来**。

票据是一次性的，TTL 60 秒，并在 upgrade 过程中被消费，所以泄露的票据通常已经失效——但请按 `/invite/<code>` 的情形同等对待：为这些路径关闭访问日志。

Caddy —— 把 matcher 和 skip 声明为站点级指令：

```caddyfile
relay.example.com {
    @desktop_ticket {
        path /desktop/observe* /desktop/instance*
    }

    log
    log_skip @desktop_ticket

    reverse_proxy 127.0.0.1:8787
}
```

`log_skip` 本身是一条 HTTP 指令——它**不是** `reverse_proxy` 的子指令，所以必须放在站点（或 route）块里。`log` 才是真正发出访问日志的指令；如果你从未配置 `log`，Caddy 不会写访问日志，也就没什么可跳过的。使用**命名** logger（`log <name> { ... }`）时，请把 `log_skip` 作为同级指令保留，并以同样的方式把 matcher 传给它——它作用于该 logger 的条目。

> `log_skip` 需要 **Caddy 2.8+**。更老的 Caddy 中该指令名为 `skip_log`；如果 `caddy validate` 不接受 `log_skip`，就改用那个名字。

nginx —— 保留代理，但停止记录这两个 location：

```nginx
    # Ticket-bearing WebSocket upgrades: must NOT appear in access logs.
    location ~ ^/desktop/(observe|instance) {
        access_log off;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
```

这个正则 location 必须声明成能在这两个路径上胜出 `location /` 的形式（nginx 优先最长字面前缀，但正则按顺序匹配——请按上面所示放置，或者如果你更喜欢前缀匹配，就用 `location ^~ /desktop/`）。

受支持的 RFB 服务端的服务端配置见 [`docs/desktop-rfb-setup.md`](https://github.com/gadzan/xacpx/blob/main/docs/desktop-rfb-setup.md)；更精简的运维速查手册是 `docs/relay-deployment.md`。

::: details 进阶：专用网关端口（`--ws-port`）
如果你用 `xacpx-relay start --ws-port 8788` 启动 Hub，实例网关会获得自己的端口，而不再搭乘 HTTP 端口。届时你可以再加一个被代理的域名（`gateway.example.com` → `8788`），并让连接器指向 `wss://gateway.example.com`。仅当你想把网关与看板分开配置防火墙时才需要这样做。
:::

### 应该暴露哪些端口

| 端口 | 面向对象 | 是否公开暴露？ |
|---|---|---|
| 8787 | 浏览器（看板 + API + 看板 `/ws`）**以及** xacpx 实例（合并后的网关） | 是，需置于 TLS 之后 |
| 8788 | 仅当你启用 `--ws-port` 时——专用实例网关 | 是，需置于 TLS 之后 |
| — | `relay.db` | 绝不——它是一个本地文件 |

## 实例桌面（RFB/VNC） {#instance-desktop}

每个在线实例都可以选择把它的**本地图形桌面**开放给看板，这样你不只能操控它的会话，还能观看和控制这台机器本身。本节是各平台配置与排障指南的站点内对应内容；完整参考见 [`docs/desktop-rfb-setup.md`](https://github.com/gadzan/xacpx/blob/main/docs/desktop-rfb-setup.md)（中文），运维速查手册是 `docs/relay-deployment.md`。

### 你能得到什么，不能得到什么

| | 当前 |
|---|---|
| **支持的服务端** | 提供 **outer VNC Auth（security type 2）** 的 RFB 服务端，以及 macOS 屏幕共享（**Apple Remote Desktop，type 30**，由连接器侧终止握手） |
| **平台** | Linux、Windows 和 macOS 的交互式用户会话 |
| **Viewer 数** | 每个实例同时一个桌面流 |
| **传输** | 一条**独立的二进制 WebSocket**——framebuffer 不会进入控制平面，因此桌面流量不会阻塞聊天或终端输入 |
| **端口** | 不新增任何公网端口。连接器在实例上主动连 `127.0.0.1:<port>`；**5900 绝不会暴露到互联网** |
| **设计上拒绝的认证方式** | `None`（无认证）、Tight-only、VeNCrypt/TLS-only 与专有认证 |
| **本版本不支持** | 多 viewer、文件传输、剪贴板同步、会话录制 |

启用桌面会声明 `desktop.rfb.v1` 与 `desktop.ard-auth.v1` 能力。没有 `desktop.rfb.v1` 的实例在看板中不会显示 Desktop 入口。macOS 登录会在标签页里要求账户名和密码；什么都不保存，重连会再问一次。

### 在实例上启用

桌面按实例选择性开启，写在连接器已经在用的 channel-relay 配置里：

```json
{
  "channels": {
    "relay": {
      "enabled": true,
      "options": {
        "url": "wss://relay.example.com",
        "desktop": {
          "enabled": true,
          "port": 5900,
          "connectTimeoutMs": 1500,
          "maxStreams": 1
        }
      }
    }
  }
}
```

| 选项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关。省略或 `false` → 完全不会创建流状态。 |
| `port` | `5900` | 1–65535 的整数。这是连接器在 loopback 上**主动连接**的端口——配置指引和错误信息里报的就是这个值。 |
| `connectTimeoutMs` | `1500` | 250–10000。loopback TCP 连接、banner 预检和 Hub upgrade 三者共用。 |
| `maxStreams` | `1` | v1 固定为 `1`（单 viewer）——填其他值会在配置解析时被拒绝。 |

`host` / `hostname` / `target` 会**被拒绝**——目标固定为 loopback，因此连接器不可能变成通用 TCP 代理。

VNC 密码在看板中按标签页输入，只保存在标签页内存中：绝不写入磁盘、绝不出现在日志里、也绝不放在 URL 中。

### Windows（TightVNC）

1. 安装 TightVNC，并以**已登录用户的会话**运行 **server**——不要作为服务运行。服务会话显示的是另一个（空白的）桌面。
2. 认证：选择 **VNC password** 模式。必须设置主密码；除非你也打算在看板里输入 Windows 用户名，否则保持 "Require user authentication" 关闭。
3. 确认外层安全类型列表提供了 **type 2（VNC Auth）**。只提供 Tight（外层 type 16）的服务端会被拒绝——Tight-only 端点可以把子协商降到无认证。
4. 访问控制：使用 **LoopbackOnly** 访问控制加 Windows 防火墙。`LoopbackOnly` 是*访问控制*，不是绑定地址控制——绑定 `0.0.0.0` 加上仅回环的访问控制是可以接受的部署，因为外部连接仍然被拒绝。
5. 先在本地验证，再从外部验证：

```powershell
netstat -ano | findstr :5900
```

优先 `127.0.0.1:5900`。如果看到 `0.0.0.0:5900`，这**本身不算失败**——可接受的部署是 `0.0.0.0` 绑定 + 仅回环访问控制 + 防火墙。请改为确认 5900 从**第二台机器**不可达。

**锁屏、UAC 和登录界面不予保证。** 这是 Windows 交互式桌面的硬性限制，不是 bug：

- 锁定工作站后，TightVNC 仍然继续渲染，但键盘和鼠标事件到不了锁屏。看板会显示一张看起来是实时的画面，但输入没有任何效果。
- UAC 提权渲染在**安全桌面**上，VNC 既看不到也无法驱动。
- 要远程一台主机，它必须**已经登录**。如果你需要登录界面，请使用平台自带的 RDP/远程管理。

### Linux（TigerVNC / x11vnc）

标准 VncAuth，并且 RFB 服务端必须拒绝外部连接：

```bash
ss -ltnp | grep 5900
```

优先 `127.0.0.1:5900`。`0.0.0.0` 绑定不必然错误，但必须配合访问控制/防火墙，并验证从另一台机器不可达。

- **TigerVNC / x11vnc** —— 标准 VncAuth，首选。
- **WayVNC** —— 默认的安全配置会**被拒绝**。必须以 legacy VncAuth 兼容模式运行（`relax_encryption` + `allow_broken_crypto`）。这是一个刻意为之的弱安全过渡配置：只在保持 loopback-only 时可接受，不要复制到任何非 loopback 部署中。它还要求 **WayVNC 0.10.0 或更新版本**（legacy DES 认证在该版本才落地）。
- **GNOME 屏幕共享**（VeNCrypt v1）—— Phase A 不支持。

### macOS

macOS 屏幕共享是一条受支持的路径：连接器在实例本机完成 Apple Remote Desktop（type 30）握手（`desktop.ard-auth.v1`），浏览器看到的是普通的 RFB 3.8 流。

1. 系统设置 › 通用 › 共享 › **屏幕共享**，并允许你要登录的账户。
2. 在 macOS 提示时授予屏幕录制和辅助功能权限。
3. 除非你就是想走 VNC 密码路径，否则关掉「VNC 观看者可以使用密码控制屏幕」——同时提供两者的 Mac 会走 VNC 密码路径。

在看板中点击 **Desktop**：标签页会要求 macOS 账户名（短名或全名）和密码。它们经你已登录的控制连接送到这台 Mac 的连接器，只用于 ARD 握手，然后丢弃——什么都不保存，每次重连都会再问一次（账户名会在标签页中预填）。过旧、还不支持 ARD pre-auth 的连接器构建会报 `desktop-auth-unsupported`；请更新 `@ganglion/xacpx-channel-relay`。

### 排障：打开失败

错误会在看板横幅中显示，带一个稳定错误码加上 RFB 服务端自己的拒绝原文，指引是平台相关的——请逐字照做。

| 错误码 | 含义 | 处理 |
|---|---|---|
| `desktop-disabled` | 实例未启用桌面 | 改 `enabled=true`，重连连接器 |
| `desktop-busy` | 已有 viewer 接入 | 关掉另一个 Desktop 标签页 |
| `desktop-rfb-unavailable` | loopback 端口被拒绝 | RFB 服务端没启动，或配置的 `port` 不对——信息里报的是**你**配置的端口 |
| `desktop-not-rfb` | 端口有响应，但不是 RFB | `desktop.port` 指向了别的服务 |
| `desktop-auth-unsupported` | 认证方式不被接受 | Tight-only 外层 16 / VeNCrypt / `None` / 专有认证——见上方各平台小节 |
| `desktop-credentials-required` | macOS 要求账户名和密码 | 标签页显示的是表单，不是错误横幅 |
| `desktop-credentials-rejected` | macOS 拒绝了账户名或密码 | 表单保持打开；改正它们，或在屏幕共享中允许该账户 |
| `desktop-permission-denied` | 登录成功，但 macOS 没有开始会话 | 检查屏幕共享、屏幕录制和辅助功能权限 |
| `desktop-protocol-error` | RFB 握手破坏了协议约定 | 检查 RFB 服务端类型和版本；见上方各平台小节 |
| `desktop-stream-timeout` | tunnel 或 upgrade 超时 | 瞬时问题；重试 |
| `desktop-instance-offline` | 实例掉线了 | 等实例回来；重试 |

该看哪里：

- **Hub 日志** —— `relay.desktop.stream.*`：`stream_active`、`stream_closed`（含原因），以及 `text_frame`、`oversize_frame`、`backpressure_close`、`preattach_overflow`。
- **连接器日志** —— `relay.desktop.probe_rejected`（含 RFB 服务端自己的 `detail`）、`probe_ok`、`tunnel_failed`。
- **看板** —— 横幅显示错误码加详情；VNC 密码输错会在密码框里提示认证失败，而不是笼统的超时。

本功能刻意**没有单独的 desktop doctor 命令**（Phase A）。打开失败被做成可诊断的——错误码、服务端自己的拒绝原文、平台相关指引和连接器日志——因此没有为这个功能引入新的 doctor 框架。

## 令牌与用户管理

- **添加更多用户/实例：** 再次运行 `add token`——每次调用都会创建一个独立的用户。在多个实例上复用同一个令牌，可将它们归属于同一个用户。
- **审计：** `ls` 显示所有令牌的备注标签、创建日期和实例数量。
- **吊销：** `rm token <值或ID>` 删除该用户，并级联删除其实例、Web 会话和缓存消息。该令牌的 Web 会话将在下次请求时失效；已打开的 `/ws` 长连接会在重连时才断开。
- **强制全局重新登录：** 停止 Hub，执行 `sqlite3 <db> "DELETE FROM web_sessions;"`，然后重启。
- **自动 GC：** 一个每小时运行的维护循环会删除过期的 Web 会话、配对令牌和邀请码。无需配置 cron。（聊天记录按设备保存在看板的 IndexedDB 中——每会话最近 1000 条消息 / 8MB，不再由服务端清理。）

## 持久化与备份

账号、实例注册信息、令牌和恢复密钥存放在 `--db` 指定的那个 SQLite 文件中（默认为 `~/.xacpx-relay/relay.db`）。备份时，停止 Hub（或在空闲时刻做快照）并复制该文件：

```bash
cp ~/.xacpx-relay/relay.db /backups/relay-$(date +%F).db
```

丢失它就意味着丢失所有令牌用户和实例注册信息——届时实例需要重新配对。聊天记录**不在**这个文件里：会话记录按设备保存在各浏览器的 IndexedDB 中（每会话最近 1000 条消息 / 8MB），外加 daemon 自带的一份会话存储，因此数据库备份并不包含聊天记录。

## 在 systemd 下运行（示例）

```ini
# /etc/systemd/system/xacpx-relay.service
[Unit]
Description=xacpx relay hub
After=network.target

[Service]
# 使用已安装二进制的绝对路径——用 `command -v xacpx-relay` 查出来。
ExecStart=/usr/bin/xacpx-relay start --host 127.0.0.1
Restart=on-failure
User=xacpx

[Install]
WantedBy=multi-user.target
```

绑定到 `127.0.0.1`，让你的反向代理面向公网。DB 和看板会从默认位置自动检测；仅在需要非默认路径时才添加 `--db`。

## 在 pm2 下运行（示例）

如果你已经在用 [pm2](https://pm2.keymetrics.io/) 托管 Node 服务，它同样能管好 Hub——`xacpx-relay` 自身没有 `stop`/`status`，交给进程管理器负责重启和开机自启最合适。

```bash
pm2 start xacpx-relay --name xacpx-relay -- start

pm2 save        # 固化当前进程列表
pm2 startup     # 打印一条一次性命令，执行后即开机自启
```

pm2 会从 `PATH` 解析 `xacpx-relay` 并把绝对路径存进 dump，重启后也能恢复；万一 pm2 找不到（非标准安装），改传 `command -v xacpx-relay` 的绝对路径即可。

或用 ecosystem 文件固定参数（`pm2 start ecosystem.config.js`）：

```js
module.exports = {
  apps: [{
    name: "xacpx-relay",
    script: "xacpx-relay",
    args: "start",
    autorestart: true,
  }],
};
```

默认即可用。需要更安全的部署时，再往 `start` 后追加：`--host 127.0.0.1` 让 Hub 不直接对外（置于反向代理之后）、`--db <path>` 自定义数据库路径，或 `--trust-proxy` 让限速使用 `X-Forwarded-For` 里的真实客户端 IP（见 [TLS 与反向代理](#tls-reverse-proxy)）。`xacpx-relay update` 之后执行 `pm2 restart xacpx-relay` 加载新版本。

## 常见问题排查

| 现象 | 原因 | 解决办法 |
|---|---|---|
| 看板 404 / 空白页 | `start` 打印了 `dashboard: (none)`——没找到看板包 | 重装 `@ganglion/xacpx-relay`（它依赖 `@ganglion/xacpx-web`）。源码检出时用 `bun run build:relay` 重建，并确认 `packages/web/dist/index.html` 存在。 |
| 实例始终不变绿 | 网关 URL 错误、令牌被吊销或输入有误 | 把 `--url` 指向**与看板相同的主机**（合并后的网关与 HTTP 端口共用）；仅当你以 `--ws-port` 启动 Hub 时，才使用单独的 `:8788` 主机。如果令牌已被吊销，重新运行 `add token` 并重新配对。 |
| 自定义 `--db` 未生效 | `--db` 在不同命令间传入不一致 | 在 `add token` 和 `start` 中传入**相同的** `--db` 路径；默认的 `~/.xacpx-relay/relay.db` 是固定的绝对路径，省略 `--db` 是安全的。 |
| 经过代理后实时更新卡住 | 代理未在 8787 上转发 WebSocket 升级 | 在看板路由上允许 `Upgrade`/`Connection` 请求头。 |

## 另请参阅

- [`docs/relay-module.md`](https://github.com/gadzan/xacpx/blob/main/docs/relay-module.md) —— 服务端 + 连接器内部实现。
- [`docs/relay-web-module.md`](https://github.com/gadzan/xacpx/blob/main/docs/relay-web-module.md) —— 看板架构。
- 设计规范：`docs/superpowers/specs/2026-06-13-relay-hub-design.md`。
