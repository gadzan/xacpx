# 自托管 Relay Hub — 部署运维速查

> 这是面向运维者的精简 runbook。完整图文指南（架构、TLS/反向代理、systemd、备份、故障排查）见文档站点
> **[自托管 Relay Hub](https://gadzan.github.io/xacpx/zh/guide/relay-self-hosting)**（英文版 `/guide/relay-self-hosting`）。
> 模块内部实现见 [relay-module.md](relay-module.md) / [relay-web-module.md](relay-web-module.md)。

## 现状：从源码部署

`@ganglion/xacpx-relay` / `channel-relay` / `relay-protocol` / `relay-web` 四个包**尚未发布到 npm**（均 0.1.0）。
当前从仓库 checkout 构建运行；发布后 `xacpx-relay` 命令与 `xacpx plugin add @ganglion/xacpx-channel-relay` 即一行安装。

## 端到端

```bash
# 1. 构建（服务端 + 看板，看板必须单独构建，未含在 build:packages 内）
git clone https://github.com/gadzan/xacpx && cd xacpx && bun install
bun run build:relay         # → packages/relay/dist
bun run build:relay-web     # → packages/relay-web/dist（不构建则没有 Web UI）

# 2. 建首个账号（打印一次性登录令牌；--db 用绝对路径）
node packages/relay/dist/cli.js user new --account admin --db /var/lib/xacpx-relay/relay.db
# 输出示例：
#   login token: xrt_xxxxxxxxxxxx
#   (store it now — not shown again)
# 把该令牌交给用户，他们在 Web 登录页的「Access token」字段粘贴即可。

# 3. 起服务（--web-root 指向已构建的看板，否则无 UI）
node packages/relay/dist/cli.js start \
  --db /var/lib/xacpx-relay/relay.db \
  --web-root /opt/xacpx/packages/relay-web/dist \
  --host 0.0.0.0 --http-port 8787 --ws-port 8788 --history-retention-days 30 --request-timeout-ms 120000

# 4. 发连接器配对令牌（单次使用、--ttl-minutes 默认 10 分钟）
node packages/relay/dist/cli.js pair --account admin --name home-pc --db /var/lib/xacpx-relay/relay.db

# 5. 实例侧接入（--url 指向 8788 实例网关或其 wss:// 代理）
xacpx channel add relay --url wss://relay.example.com --token <配对令牌> --name home-pc
xacpx restart
```

## 关键事实

- **双端口**：8787 = HTTP API + 看板 + 看板 `/ws`；8788 = 实例网关（实例在此注册）。两者分开便于分别防火墙。生产经反代终结 TLS，实例用 `wss://`。
- **`xacpx-relay` CLI 子命令**：`start` / `user new` / `user token` / `user ls` / `user rm` / `token revoke` / `pair`。**没有 `stop`/`status`**——用 `Ctrl-C`/`SIGTERM`（建议 systemd/pm2/Docker 托管）。
- **持久化**：全部在单个 SQLite 文件（`--db`）。默认 `./relay.db` 是 **cwd 相对路径**（坑），务必用绝对路径。备份即停机/静默期 `cp` 该文件。
- **凭证**：实例首连用一次性配对令牌换长期凭证，写入 `<xacpx-home>/relay/credential.json`（0600），不进 `config.json`。
- **自动 GC**：每小时清理超 `--history-retention-days`（默认 30，另每会话硬上限 2000 条）的缓存消息，以及过期的 web 会话和配对令牌。
- **RPC 超时**：`--request-timeout-ms`（默认 120000）限定网关 RPC 请求超时；agent 冷启动慢 / 长 prompt 时可调大。
- **多租户**：账号只见自己的实例/会话；服务端盖戳身份；登录令牌和凭证一律哈希存储。

## 账号与登录令牌管理

登录凭证为 CLI 铸造的登录令牌（login token），不使用密码或邀请码。

```bash
# 新建账号并获取首个登录令牌（令牌只打印一次）
xacpx-relay user new --account alice --db /var/lib/xacpx-relay/relay.db

# 为已有账号补发一个额外登录令牌（可选 --label 备注用途）
xacpx-relay user token --account alice [--label laptop] --db /var/lib/xacpx-relay/relay.db

# 列出所有账号（显示账号名、创建时间、令牌数、实例数）
xacpx-relay user ls --db /var/lib/xacpx-relay/relay.db

# 删除账号（若账号下还有实例则拒绝，加 --force 则级联删除所有关联实例和令牌）
xacpx-relay user rm --account alice --db /var/lib/xacpx-relay/relay.db
xacpx-relay user rm --account alice --force --db /var/lib/xacpx-relay/relay.db
```

将令牌交给用户后，用户在 Web 看板登录页的「Access token」输入框中粘贴即可完成登录；服务端将令牌兑换为会话 cookie。

## 登录令牌吊销

```bash
# 先用 user ls 确认账号，再通过日志或 DB 获取 login_token id，然后：
xacpx-relay token revoke --id <login-token-id> --db /var/lib/xacpx-relay/relay.db
```

吊销后，该令牌派生的所有 web 会话同步失效（下次请求返回 401）。**注意**：已建立的 `/ws` 长连接不会被立即强制断开——需等到客户端重连时才感知；若需硬切，重启 hub 即可。

## 连接器配对令牌

```bash
# 为账号铸造一枚配对令牌（单次使用，默认 10 分钟有效）
xacpx-relay pair --account alice [--name home-pc] [--ttl-minutes 10] --db /var/lib/xacpx-relay/relay.db
```

连接器侧用该令牌完成首连注册，换取长期凭证后令牌自动失效。过期或已使用需重新 `pair` 后 `xacpx channel add relay` 更新。

## 反向代理与限流（--trust-proxy）

限流按**客户端 IP** 统计。当 hub 位于 nginx/Caddy 等反向代理后方时，直接连到 hub 的 socket 地址是代理 IP，所有用户的失败计数会共用同一个桶。此时须传 `--trust-proxy`，hub 将读取 `X-Forwarded-For` 首部的真实客户端 IP：

```bash
xacpx-relay start --db /var/lib/xacpx-relay/relay.db --trust-proxy ...
```

不经反代直接暴露时**不要**传该标志，否则客户端可伪造 `X-Forwarded-For` 绕过限流。

## 升级迁移

`xacpx-relay start` 在启动时**自动运行**数据库 schema 迁移：添加 `login_tokens` 表、为 `web_sessions` 补列 `login_token_id`、删除 `invites` 表、重建 `accounts` 表（去掉旧的 `password_hash` / `role` 列）。已有 cookie 会话在到期前继续有效，**无需**用户重新登录。

**但已有账号不会自动获得登录令牌**——升级后须手动为每个需要 Web 访问的账号补发：

```bash
xacpx-relay user token --account <label> --db /var/lib/xacpx-relay/relay.db
```

## 强制全员重登录

停止 hub，在 DB 中清空 web 会话，然后重启：

```bash
sqlite3 /var/lib/xacpx-relay/relay.db "DELETE FROM web_sessions;"
# 再重启 hub
```

所有用户的会话 cookie 失效，需重新粘贴登录令牌登录。
