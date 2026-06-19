# 自托管 Relay Hub

**Relay Hub** 是一个可选的、自托管的服务端，它能把 xacpx 变成一个多租户的远程遥控看板。你的各个 xacpx 实例会通过 WebSocket **主动向外**拨号连接到 Hub 并注册；随后你即可从任意浏览器登录 Web 看板，在同一个地方驱动每个实例的会话——聊天、定时任务和编排。

本指南将带运维人员从零开始，搭建一个已配对实例并正常运行的 Hub。

## 架构速览

```
   xacpx instance A ─┐                         ┌─ browser (token login)
   xacpx instance B ─┤  WSS (dial-out)         │  HTTPS + WSS
   xacpx instance C ─┴──────────────►  RELAY HUB  ◄───────────┘
                       :8788 instance gateway   :8787 HTTP API + web /ws
                                  │
                              relay.db (SQLite)
```

- **两个端口。** HTTP API 与看板的 `/ws` 广播共用 **8787**；**实例** WebSocket 网关（xacpx 实例在此注册）是 **8788**。两者相互独立，便于你分别配置防火墙策略。
- **多租户。** 每个 token 用户永远只能看到属于自己的实例和会话；服务端会在每次代理调用上打上身份标记。令牌、实例凭据和 Web 会话 Cookie 均以哈希形式存储。
- **数据真相源仍在实例侧。** Hub 会为看板缓存近期消息，但它并不拥有你的会话——会话归实例所有。

## 环境要求

- **Node.js ≥ 22.13**（使用内置的 `node:sqlite`）**或 Bun ≥ 1.2**（使用 `bun:sqlite`）。无需编译原生数据库插件。
- 一台可被你的实例和浏览器访问到的主机。对于 localhost 之外的任何部署，你都需要一个负责 TLS 终止的反向代理（参见 [TLS 与反向代理](#tls-reverse-proxy)）。
- 要配对实例，每个实例都需要 `xacpx` CLI（即[快速开始](/zh/guide/getting-started)中的常规安装）。

## 1. 获取服务端

全局安装 relay Hub。Web 看板已**内嵌在包内**,所以这一条安装就够了——无需单独构建看板、无需 `--web-root`：

```bash
npm i -g @ganglion/xacpx-relay
```

这会把 `xacpx-relay` 二进制放进你的 `PATH`。内嵌看板会在启动时自动检测；`start` 命令会打印它解析出的路径（见下文）。

::: details 改为从源码运行（开发 / 贡献）
克隆仓库并构建服务端——`build:relay` 同时会构建看板并把它嵌入到 `packages/relay/dist/relay-web`：

```bash
git clone https://github.com/gadzan/xacpx
cd xacpx
bun install && bun run build:relay
```

此时入口是 `packages/relay/dist/cli.js`——下文中所有 `xacpx-relay <command>` 都用 `node packages/relay/dist/cli.js <command>` 代替。
:::

## 2. 快速上手（无需任何参数）

认证完全基于令牌——**没有密码、没有管理员账户、没有邀请流程**。一个令牌就是一个用户。签发令牌后启动服务端：

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
hint: use this token for web login AND: xacpx channel add relay --url ws://<host>:<ws-port> --token <token>
```

`start` 会确认运行状态：

```
xacpx-relay listening: http :8787, instance ws :8788, db ~/.xacpx-relay/relay.db, dashboard: /usr/lib/node_modules/@ganglion/xacpx-relay/dist/relay-web
```

打开 `http://<host>:8787`，将令牌粘贴到 **Access token** 输入框，即可登录。

## 3. 令牌管理

Hub 一共有 **4 条 CLI 命令**，所有标志均为可选：

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

### `start` — 启动服务端

```bash
xacpx-relay start \
  [--db <路径>] \
  [--web-root <目录>] \
  [--host 0.0.0.0] \
  [--http-port 8787] \
  [--ws-port 8788] \
  [--history-retention-days 30] \
  [--request-timeout-ms 120000] \
  [--trust-proxy]
```

| 标志 | 默认值 | 用途 |
|---|---|---|
| `--db <路径>` | `~/.xacpx-relay/relay.db` | SQLite 数据库文件。目录会自动创建。 |
| `--http-port <n>` | `8787` | HTTP API **以及**看板的 `/ws` 广播。 |
| `--ws-port <n>` | `8788` | 实例网关——xacpx 实例在此注册。 |
| `--host <地址>` | `0.0.0.0` | 绑定地址。 |
| `--web-root <目录>` | _（自动检测）_ | 看板资源目录。自动解析包内嵌入的看板（`cli.js` 旁边的 `dist/relay-web`）；仅在需要覆盖时才传入。 |
| `--history-retention-days <n>` | `30` | 超过此天数的缓存消息会被每小时清理一次（同时硬性上限为每会话 2000 条）。 |
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
xacpx channel add relay --url <主机地址> --token <T> [--name home-pc]
xacpx restart
```

`xacpx plugin add` 会从 npm 安装连接器，并自动拉取其依赖 `@ganglion/xacpx-relay-protocol`。实例侧的 `xacpx` 核心需 **≥ 0.11.0**（连接器的 peer 要求）。

::: details 从源码检出目录配对（开发）
如果你从仓库检出目录运行实例，workspace 已经链接好了 `channel-relay` 与 `relay-protocol`——跳过 `plugin add`，直接运行 `xacpx channel add relay …` 即可。
:::

### `--url` 简写规则

`--url` 接受以下多种形式；连接器会自动将其规范化为完整的 WebSocket URL：

| 传入的值 | 解析结果 |
|---|---|
| `relay.example.com`（裸域名） | `wss://relay.example.com` |
| `1.2.3.4`（IP） | `ws://1.2.3.4:8788` |
| `1.2.3.4:9000` | `ws://1.2.3.4:9000` |
| `localhost` | `ws://localhost:8788` |
| `host:9000` | `ws://host:9000` |
| `ws://…` 或 `wss://…` | 原样使用 |
| `http://…` 或 `https://…` | 映射为 `ws://…` / `wss://…` |

::: warning IPv6
不支持未加方括号的裸 IPv6 地址。请使用 `[::1]:8788` 格式。
:::

### 配对工作原理

首次连接时，实例会用访问令牌换取一个长期有效的专属凭据，以 `0600` 权限写入 `<xacpx-home>/relay/credential.json`——**绝不会**写入 `config.json`（后者只保存 url/name）。令牌**仅在首次配对时使用**——后续所有重连均使用存储的凭据。

::: tip 一个令牌，多个实例
可以在多台机器（如 `home-pc`、`work-laptop`）上复用同一个令牌，它们都会在看板中归属于同一个用户。
:::

回到看板，实例上线后会出现在左栏，并带有一个绿色圆点。选中某个会话即可聊天；打开任务面板（右栏，或移动端的 **Tasks** 按钮）可查看定时任务与编排任务。

## TLS 与反向代理 {#tls-reverse-proxy}

Hub 只说**明文** HTTP 和 WS。对于任何非 localhost 的部署，请在反向代理处终止 TLS，并同时转发 HTTP/web 端口和实例网关端口。实例随后应使用 `wss://` 连接。

看板的实时更新会在 **HTTP 端口**上发起 WebSocket 升级，因此代理也必须在该路由上允许升级。

### Caddy

```text
relay.example.com {
    reverse_proxy 127.0.0.1:8787   # HTTP API + dashboard + dashboard /ws (Caddy proxies upgrades automatically)
}

gateway.example.com {
    reverse_proxy 127.0.0.1:8788   # instance gateway; instances use wss://gateway.example.com
}
```

### nginx

```nginx
# Dashboard + HTTP API (port 8787, includes the dashboard /ws upgrade)
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

# Instance gateway (port 8788) — instances connect with wss://gateway.example.com
server {
    listen 443 ssl;
    server_name gateway.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;
    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### 应该暴露哪些端口

| 端口 | 面向对象 | 是否公开暴露？ |
|---|---|---|
| 8787 | 浏览器（看板 + API + 看板 `/ws`） | 是，需置于 TLS 之后 |
| 8788 | xacpx 实例（网关） | 是，需置于 TLS 之后 |
| — | `relay.db` | 绝不——它是一个本地文件 |

## 令牌与用户管理

- **添加更多用户/实例：** 再次运行 `add token`——每次调用都会创建一个独立的用户。在多个实例上复用同一个令牌，可将它们归属于同一个用户。
- **审计：** `ls` 显示所有令牌的备注标签、创建日期和实例数量。
- **吊销：** `rm token <值或ID>` 删除该用户，并级联删除其实例、Web 会话和缓存消息。该令牌的 Web 会话将在下次请求时失效；已打开的 `/ws` 长连接会在重连时才断开。
- **强制全局重新登录：** 停止 Hub，执行 `sqlite3 <db> "DELETE FROM web_sessions;"`，然后重启。
- **自动 GC：** 一个每小时运行的维护循环会清理超过 `--history-retention-days`（以及每会话 2000 条上限）的缓存消息，并删除过期的 Web 会话。无需配置 cron。

## 持久化与备份

所有数据都存放在 `--db` 指定的那个 SQLite 文件中（默认为 `~/.xacpx-relay/relay.db`）。备份时，停止 Hub（或在空闲时刻做快照）并复制该文件：

```bash
cp ~/.xacpx-relay/relay.db /backups/relay-$(date +%F).db
```

丢失它就意味着丢失所有令牌用户、实例注册信息和缓存历史——届时实例需要重新配对。

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

## 常见问题排查

| 现象 | 原因 | 解决办法 |
|---|---|---|
| 看板 404 / 空白页 | `start` 打印了 `dashboard: (none)`——没找到内嵌的看板 | 看板随 `@ganglion/xacpx-relay` 一起出厂；重装该包即可。源码检出时用 `bun run build:relay` 重建（它会把看板嵌入 `dist/relay-web`）。 |
| 实例始终不变绿 | 网关 URL 错误、令牌被吊销或输入有误 | 确认 `--url` 能解析到 **8788** 网关（或其 `wss://` 代理）；如果令牌已被吊销，重新运行 `add token` 并重新配对。 |
| 自定义 `--db` 未生效 | `--db` 在不同命令间传入不一致 | 在 `add token` 和 `start` 中传入**相同的** `--db` 路径；默认的 `~/.xacpx-relay/relay.db` 是固定的绝对路径，省略 `--db` 是安全的。 |
| 经过代理后实时更新卡住 | 代理未在 8787 上转发 WebSocket 升级 | 在看板路由上允许 `Upgrade`/`Connection` 请求头。 |

## 另请参阅

- [`docs/relay-module.md`](https://github.com/gadzan/xacpx/blob/main/docs/relay-module.md) —— 服务端 + 连接器内部实现。
- [`docs/relay-web-module.md`](https://github.com/gadzan/xacpx/blob/main/docs/relay-web-module.md) —— 看板架构。
- 设计规范：`docs/superpowers/specs/2026-06-13-relay-hub-design.md`。
