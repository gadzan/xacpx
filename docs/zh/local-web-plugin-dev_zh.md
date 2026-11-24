# 从源码运行本地频道插件

频道插件是 npm 包。开发时这很不方便：每次改动都要发 beta、再升级，才能被加载，一个笔误就要走完一整轮发布。

`scripts/dev-channel-web.mjs` 把插件目录指向本仓库，让运行中的 daemon 直接加载 `packages/*` 下的构建产物。

```bash
node ./scripts/dev-channel-web.mjs --build   # 构建、链接，然后重启
node ./dist/cli.js restart
```

之后日常迭代：

```bash
bun run build:channel-web
node ./dist/cli.js restart
```

回到已发布的 npm 包：

```bash
node ./scripts/dev-channel-web.mjs --unlink
node ./dist/cli.js restart
```

## 脚本改了什么

一共三处，`--unlink` 会全部还原：

| 位置 | 改动 |
| --- | --- |
| `~/.xacpx/plugins/node_modules/@ganglion/xacpx-channel-web` | 链接到 `packages/channel-web`；npm 原版备份在同级 `.npm-backup` |
| `~/.xacpx/plugins/node_modules/@ganglion/xacpx-channel-relay` | 同上，指向 `packages/channel-relay`（本机网页频道要用它的终端入口） |
| 本仓库的 `node_modules/xacpx/` | `plugin-api` 解析垫片，每次链接都会写入 |

`XACPX_PLUGIN_HOME` 可以覆盖插件目录，对隔离 daemon 做测试时有用。

## 为什么需要垫片

插件构建时带 `--external xacpx`，运行时导入 `xacpx/plugin-api`。正常情况下，daemon 靠插件目录里的解析垫片满足这个导入。一旦把插件指到本仓库，Node 就会从本仓库解析这个导入——仓库里没有垫片，所有插件都加载失败：

```
Cannot find package 'xacpx' imported from .../packages/channel-web/dist/index.js
```

daemon 随后跳过插件，又因为频道仍配置着，直接拒绝启动：

```
Error: 频道 relay 需要安装插件：xacpx plugin add @ganglion/xacpx-channel-relay
```

这条报错有误导性——插件其实是装着的，是缺垫片导致加载失败。`scripts/dev-channel-web.mjs` 会往两边都写垫片，避免这种情况。

## 确认真的生效

要查 daemon 实际加载了哪份构建，而不是只看链接建没建：

```bash
curl http://127.0.0.1:7138/api/instances
```

只有当运行中的代码包含时间线能力探测时，本机实例才会报 `conversations.timeline.v1`。缺少这个能力，看板会显示「此连接器版本过旧」并隐藏所有会话，所以它是最快的「加载了旧构建」信号。

## 相关文档

- [`docs/cli-reference.md`](./cli-reference.md)——面向用户的 `xacpx channel add web` 及其参数。
- [`docs/developments.md`](./developments.md)——本地运行 xacpx 的三种方式，本文是其中的插件特例。
- [`docs/release-automation.md`](./release-automation.md)——改动就绪后如何发布正式包。
