# 自托管 Relay Hub — 部署运维速查

> 这是面向运维者的精简 runbook。完整图文指南（架构、TLS/反向代理、systemd、备份、故障排查）见文档站点
> **[自托管 Relay Hub](https://gadzan.github.io/xacpx/zh/guide/relay-self-hosting)**（英文版 `/guide/relay-self-hosting`）。
> 模块内部实现见 [relay-module.md](relay-module.md) / [relay-web-module.md](relay-web-module.md)。

## 现状：从源码部署

`@ganglion/xacpx-relay` / `channel-relay` / `relay-protocol` / `relay-web` 四个包**尚未发布到 npm**（均 0.1.0）。
当前从仓库 checkout 构建运行；发布后 `xacpx-relay` 命令与 `xacpx plugin add @ganglion/xacpx-channel-relay` 即一行安装。

## 快速上手（零参数）

所有参数都有合理默认值，最简流程不需要任何 flag：

```bash
# 1. 构建（服务端 + 看板，看板必须单独构建，未含在 build:packages 内）
git clone https://github.com/gadzan/xacpx && cd xacpx && bun install
bun run build:relay         # → packages/relay/dist
bun run build:relay-web     # → packages/relay-web/dist（不构建则看板不可用）

# 2. 生成访问令牌 — DB 自动建在 ~/.xacpx-relay/relay.db
node packages/relay/dist/cli.js add token
# 输出示例：
#   access token: bBS9nN2W2MwdrdksoLTLrQeMLMah9M5flTOyEcBbIHc
#   (store it now — not shown again)
#   hint: use this token for web login AND: xacpx channel add relay --url ws://<host>:<ws-port> --token <token>
# 把该令牌交给用户：Web 登录页「Access token」字段粘贴登录；同时用来配对连接器。

# 3. 起服务 — 自动使用同一个默认 DB，自动检测已构建的看板
node packages/relay/dist/cli.js start
# 输出示例：
#   xacpx-relay listening: http :8787, instance ws :8788, db ~/.xacpx-relay/relay.db, dashboard: /…/relay-web/dist

# 4. 实例侧接入（同一个 access token 直接用于配对，--url 指向 8788 实例网关或其 wss:// 代理）
xacpx channel add relay --url wss://relay.example.com --token <上面的访问令牌> --name home-pc
xacpx restart
```

**默认值说明：**
- `--db` → `~/.xacpx-relay/relay.db`（绝对路径，父目录自动创建）
- `--web-root` → 自动检测与 `cli.js` 同发行包的 `relay-web/dist`；如未构建则静默不启用看板
- 其他：`--host 0.0.0.0`、`--http-port 8787`、`--ws-port 8788`

只有在需要自定义 DB 路径、绑定地址、端口或反向代理时才需要传 flag。

## 端到端（自定义路径示例）

```bash
# 自定义 DB 路径（生产环境推荐用绝对路径）
node packages/relay/dist/cli.js add token --db /var/lib/xacpx-relay/relay.db

# 带全量参数启动（反向代理场景）
node packages/relay/dist/cli.js start \
  --db /var/lib/xacpx-relay/relay.db \
  --web-root /opt/xacpx/packages/relay-web/dist \
  --host 0.0.0.0 --http-port 8787 --ws-port 8788 \
  --history-retention-days 30 --request-timeout-ms 120000 --trust-proxy
```

## 关键事实

- **双端口**：8787 = HTTP API + 看板 + 看板 `/ws`；8788 = 实例网关（实例在此注册）。两者分开便于分别防火墙。生产经反代终结 TLS，实例用 `wss://`。
- **`xacpx-relay` CLI 子命令**：`start` / `add token` / `ls` / `rm token <value-or-id>`。**没有 `stop`/`status`**——用 `Ctrl-C`/`SIGTERM`（建议 systemd/pm2/Docker 托管）。
- **持久化**：全部在单个 SQLite 文件（`--db`）。默认 `~/.xacpx-relay/relay.db`（固定绝对路径，父目录自动创建）。备份即停机/静默期 `cp` 该文件。
- **凭证**：访问令牌（access token）一令两用——既用于 Web 登录，也用于连接器首连（无需单独铸造配对令牌）。首连后实例换取长期凭证，写入 `<xacpx-home>/relay/credential.json`（0600），不进 `config.json`。
- **自动 GC**：每小时清理超 `--history-retention-days`（默认 30，另每会话硬上限 2000 条）的缓存消息，以及过期的 web 会话和配对令牌。
- **RPC 超时**：`--request-timeout-ms`（默认 120000）限定网关 RPC 请求超时；agent 冷启动慢 / 长 prompt 时可调大。
- **多租户**：账号只见自己的实例/会话；服务端盖戳身份；登录令牌和凭证一律哈希存储。

## 访问令牌管理

访问令牌（access token）是唯一的凭证形式——既用于 Web 登录，也直接用于连接器注册（无需单独的配对令牌）。

```bash
# 生成一个新访问令牌（令牌只打印一次）
xacpx-relay add token --db /var/lib/xacpx-relay/relay.db

# 生成时加上备注标签（--label 可选）
xacpx-relay add token --label laptop --db /var/lib/xacpx-relay/relay.db

# 列出所有令牌（显示短 id、标签、创建时间、实例数）
xacpx-relay ls --db /var/lib/xacpx-relay/relay.db

# 删除令牌及其关联账号（级联删除所有实例和历史）
# 可传令牌原值、完整 id 或 id 前缀（前缀唯一时才接受）
xacpx-relay rm token <value-or-id> --db /var/lib/xacpx-relay/relay.db
```

删除令牌后，该令牌派生的所有 web 会话同步失效（下次请求返回 401）。**注意**：已建立的 `/ws` 长连接不会被立即强制断开——需等到客户端重连时才感知；若需硬切，重启 hub 即可。

## 反向代理与限流（--trust-proxy）

限流按**客户端 IP** 统计。当 hub 位于 nginx/Caddy 等反向代理后方时，直接连到 hub 的 socket 地址是代理 IP，所有用户的失败计数会共用同一个桶。此时须传 `--trust-proxy`，hub 将读取 `X-Forwarded-For` 首部的真实客户端 IP：

```bash
xacpx-relay start --db /var/lib/xacpx-relay/relay.db --trust-proxy ...
```

不经反代直接暴露时**不要**传该标志，否则客户端可伪造 `X-Forwarded-For` 绕过限流。

## 强制全员重登录

停止 hub，在 DB 中清空 web 会话，然后重启：

```bash
sqlite3 /var/lib/xacpx-relay/relay.db "DELETE FROM web_sessions;"
# 再重启 hub
```

所有用户的会话 cookie 失效，需重新粘贴登录令牌登录。
