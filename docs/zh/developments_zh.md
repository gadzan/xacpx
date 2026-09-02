# 贡献者开发指南

> 给想修 bug、加功能、写频道插件，或者读代码理解架构的人。
> 用户向使用文档：[README.md](./README_zh.md)。

---

## 目录

- [项目快照](#项目快照)
- [5 分钟环境准备](#5-分钟环境准备)
- [仓库结构](#仓库结构)
- [构建管线](#构建管线)
- [本地运行的三种模式](#本地运行的三种模式)
- [测试](#测试)
- [架构地图](#架构地图)
- [子系统速查表](#子系统速查表)
- [acpx / SDK / 插件解析顺序](#acpx--sdk--插件解析顺序)
- [配置与运行时文件](#配置与运行时文件)
- [代码风格与约定](#代码风格与约定)
- [按场景找入口](#按场景找入口)
- [Plan / Spec 写作流程](#plan--spec-写作流程)
- [提交、PR 与发布](#提交pr-与发布)
- [拓展阅读](#拓展阅读)

---

## 项目快照

`xacpx` 是 **"消息频道 ↔ 命令路由 ↔ acpx 会话驱动"** 的桥接系统：

- **频道**：内置 `weixin`；`feishu` / `yuanbao` 通过一方插件包分发；任何符合 `WeacpxPlugin` 契约的 npm 包都可以加进来。
- **命令路由**：解析微信/飞书/元宝/CLI 收到的 `/ss`、`/agent`、`/group` 等 slash 命令，普通文本作为 prompt 喂给当前会话。
- **Transport**：把"会话 ensure/prompt/cancel/setMode"统一为 `SessionTransport` 接口，具体实现两套——`acpx-cli`（直接 spawn `acpx`，可选 `node-pty` 分配 PTY）和 `acpx-bridge`（独立 bridge 子进程 + JSONL 协议）。
- **Orchestration**（可选）：coordinator 会话下委派多个 worker，跟踪进度、问题、人类确认、分组汇总。可通过 `xacpx mcp-stdio` 暴露给外部 MCP host。
- **Daemon**：`xacpx start` / `status` / `stop`，PID + status + log 落在 `~/.xacpx/runtime/`。
- **Monorepo**：`packages/channel-feishu`、`packages/channel-yuanbao` 作为 npm workspaces 与主包同仓发布。

---

## 5 分钟环境准备

### 必要环境

- **Node.js ≥ 22.13** 或 **Bun**（Bun 用于开发脚本与 build；运行时也可用 Node）
- 一个可用的微信 / 飞书 / 元宝账号（看你测哪个频道；只读取代码可以省）
- 本机能跑 `acpx` 和你想接的 agent CLI（codex / claude / gemini …）

### 克隆与依赖

```bash
git clone https://github.com/gadzan/xacpx
cd xacpx
bun install            # 同时装根包和 packages/* 的依赖（workspaces）
```

### 第一次构建

```bash
bun run build              # 主包：dist/cli.js + dist/bridge/bridge-main.js + dist/plugin-api.{js,d.ts}
bun run build:packages     # 主包 + 全部 packages/*（发布前必须）
```

### 第一次跑

```bash
bun run dev                # 等价于 bun run ./src/cli.ts run，前台运行 daemon
```

或者只跑 dry-run（不连 IM）：

```bash
bun run dry-run --chat-key wx:test -- "/ss new demo --agent codex --ws backend" "/status"
```

### 第一次测

```bash
npm test                   # tsc --noEmit + tests/unit/**/*.test.ts
```

跑通这一步之后，欢迎开始动代码。

---

## 仓库结构

### 顶层

```
xacpx/
├── src/                # 主包源码
├── packages/           # 一方频道插件
│   ├── channel-feishu/
│   └── channel-yuanbao/
├── tests/
│   ├── unit/           # 默认单测
│   ├── smoke/          # 需要真实 acpx / 真实账号
│   ├── helpers/        # 共享 fixture / mock
│   └── fixtures/       # 静态数据
├── docs/               # 用户文档 + 本指南 + 设计文档
│   ├── superpowers/    # plans/ + specs/，工作流详见下文
│   └── releases/       # 历史发版说明
├── scripts/            # 测试 runner、发布前校验
├── package.json        # 同时是 npm workspaces 根
├── bun.lock
├── tsconfig.json
├── tsconfig.plugin-api.json
├── AGENTS.md           # 项目规约（CLAUDE.md 是它的符号链接）
└── README.md
```

### `src/` 子目录

每一个目录一句话说清职责，更深入的内容见对应模块文档。

| 目录 | 职责 | 入口 / 关键文件 |
| --- | --- | --- |
| `src/cli.ts` | CLI 总入口，`xacpx <command>` 派发 | `runCli()` |
| `src/main.ts` | `buildApp()` 装配运行时；`resolveRuntimePaths()` 路径解析 | `buildApp` |
| `src/run-console.ts` | 启动序列：构建 runtime → 必需的核心 ownership lock → reconcile/reap → daemon ready → channel/scheduler start | `runConsole()` |
| `src/console-agent.ts` | 把入站消息桥接到 router | `ConsoleAgent` |
| `src/channels/` | 频道注册中心；内置 weixin；暴露 `MessageChannelRuntime` 给插件 | `channels/types.ts`、`channels/plugin.ts` |
| `src/commands/` | 命令解析 + handler + router | `command-router.ts`、`parse-command.ts` |
| `src/sessions/` | 逻辑会话（state.json 持久化）+ AsyncMutex 串行化 | `session-service.ts` |
| `src/transport/` | acpx 桥接抽象 + cli/bridge 两实现 | `transport/types.ts`、`acpx-cli/`、`acpx-bridge/` |
| `src/bridge/` | acpx-bridge 子进程入口与 JSONL 协议 | `bridge-main.ts`、`bridge-server.ts`、`bridge-runtime.ts` |
| `src/orchestration/` | 多 agent 编排服务 + IPC server/client + 状态机 | `orchestration-service.ts`、`orchestration-server.ts` |
| `src/mcp/` | `xacpx mcp-stdio` 实现，把 orchestration 暴露成 MCP server | `xacpx-mcp-server.ts`、`xacpx-mcp-tools.ts` |
| `src/daemon/` | daemon 控制器、status/PID 文件、运行时元数据 | `daemon-controller.ts`、`daemon-runtime.ts` |
| `src/plugins/` | 插件加载、CLI、doctor、包管理器抽象、签名校验 | `plugin-loader.ts`、`plugin-cli.ts`、`plugin-doctor.ts` |
| `src/plugin-api.ts` | **公共**插件 API 类型再导出（编译产物 `dist/plugin-api.d.ts`） | — |
| `src/state/` | `state.json` 持久化 + `DebouncedStateStore`（50ms 写合并） | `state-store.ts`、`debounced-state-store.ts` |
| `src/config/` | `config.json` 加载/写入/默认模板 | `config-store.ts`、`load-config.ts` |
| `src/recovery/` | 缺失可选依赖时的自动恢复（`auto-install-optional-dep.ts`） | — |
| `src/process/` | 跨平台子进程封装 | — |
| `src/logging/` | bounded `app.log`、按级别过滤 | `app-logger.ts` |
| `src/formatting/` | 出站文本/任务渲染 | — |
| `src/util/` | `writePrivateFileAtomic` + `proper-lockfile` 等通用工具 | `private-file.ts` |
| `src/weixin/` | 内置 weixin 频道 + 媒体管线 + consumer lock | `monitor/`、`messaging/` |
| `src/weixin-sdk.ts` | weixin SDK 解析器，支持 `WEACPX_WEIXIN_SDK` 覆盖 | `loadWeixinSdk()` |
| `src/dry-run.ts` | 不连 IM 跑 router 的入口 | `bun run dry-run` |
| `src/login.ts` | 微信扫码登录流程 | `xacpx login` |
| `src/doctor/` | `xacpx doctor` 诊断套件 | — |

### `packages/` 子包

每个插件包结构一致：

```
packages/channel-<name>/
├── src/
│   ├── index.ts          # 默认导出 WeacpxPlugin
│   ├── channel.ts        # implements MessageChannelRuntime
│   ├── <name>-provider.ts# implements ChannelCliProvider
│   └── ...
├── dist/                  # bun build 产物 + tsc emit 的 .d.ts
├── package.json           # peerDependencies.xacpx (optional)
├── tsconfig.json          # 继承根 tsconfig，emitDeclarationOnly
└── README.md
```

写新频道插件请看 [docs/plugin-development.md](./plugin-development_zh.md)。

---

## 构建管线

`package.json` 中关键 script：

| Script | 作用 |
| --- | --- |
| `bun run build` | 主包：`bun build` 出 `dist/cli.js`、`dist/bridge/bridge-main.js`、`dist/plugin-api.js` + `tsc -p tsconfig.plugin-api.json` 出 `dist/plugin-api.d.ts` |
| `bun run build:plugin-api` | 单独刷新 `dist/plugin-api.d.ts`（写新公共类型时用） |
| `bun run build:channel-feishu` | 主包 + feishu 插件 |
| `bun run build:channel-yuanbao` | 主包 + yuanbao 插件 |
| `bun run build:packages` | 主包 + 全部 packages/* |
| `bun run verify:publish` | `build:packages` + `scripts/verify-publish.mjs`（发布前必跑） |
| `bun run dev` | 前台跑主包源码（不需要先 build） |
| `bun run dry-run -- ...` | dry-run 入口 |
| `bun run login` | 微信登录 |

要点：

- `bun build --target node --external node-pty`：`node-pty` 不打进 bundle，运行时由 `node_modules` 解析。`packages/*` 同理 `--external xacpx`。
- 主包对外只导出 `xacpx/plugin-api`；其它路径（`xacpx/dist/*`、`xacpx/src/*`）**不是稳定 API**，别在外部依赖。
- 插件包用 `tsc -p packages/<name>/tsconfig.json` 单独 emit `.d.ts`，因为 bun build 目前不出 `.d.ts`。

---

## 本地运行的三种模式

### 1. `bun run dev` — 前台主包

最常用。直接跑 `src/cli.ts run`，热修改，不打 dist。

```bash
bun run dev                # 前台跑，Ctrl-C 退出
bun run login              # 单独完成微信扫码（或在另一个 shell）
```

适合：调试 router、channel、orchestration、transport。

### 2. `dist/cli.js` — 模拟用户安装态

```bash
bun run build
node ./dist/cli.js start
node ./dist/cli.js status
node ./dist/cli.js stop
```

适合：复现"用户装好以后跑出来"的状态；测 `bin/xacpx` 入口；验证打包后 `node-pty` 解析等。

### 3. `bun run dry-run` — 不连 IM

```bash
bun run dry-run --chat-key wx:test -- \
  "/agent add codex" \
  "/ws new backend -d /absolute/path/to/backend" \
  "/ss new demo -a codex --ws backend" \
  "/status"
```

复用同一套 `buildApp` + router + transport，把 IM 入站换成命令行参数，把出站打印到终端。适合复现命令解析、session lifecycle 的 bug，单测无法复现的复杂时序也能在这里手动跑通。

`--chat-key` 任意值都可以，建议用 `wx:test` / `feishu:test` / `yuanbao:test` 模拟不同频道路由。

---

## 测试

完整说明：[docs/testing.md](./testing_zh.md)。简要：

| 目录 | 跑法 | 何时用 |
| --- | --- | --- |
| `tests/unit/` | `npm test` / `npm run test:unit` | 默认；镜像 `src/` 结构；CI 跑这套 |
| `tests/smoke/` | `npm run test:smoke` | 真实 acpx / 真实 IM 协议；本地手动跑，不进 CI |
| `tests/integration/` | (尚未启用) | 跨模块跨进程的协作测试，未来扩 |
| `tests/helpers/`、`tests/fixtures/` | — | 测试公用 |

测试 runner：`scripts/run-tests.mjs` → `scripts/run-tests-lib.mjs::buildTestPlan`。它先 `tsc --noEmit`，再为每个 `*.test.ts` 单独起 `bun test`。改 runner 行为请只动这两个文件。

约定：

- 任何写盘的 test 用 `mkdtemp` 隔离，`rm -rf` 自清理。
- 时间相关断言**不要**用 `Bun.sleep(20)` 当同步屏障。要么显式 `await someExpectedPromise`，要么 poll until 条件满足。原因见我们历史踩过的坑。
- 涉及 `state.json` 写盘的测试用例，记得 buildApp 时传 `stateSaveDebounceMs: 0`（`tests/unit/main.test.ts` 顶部已经有 wrapper）。

---

## 架构地图

完整地图：[docs/code-wiki.md](./code-wiki_zh.md)。这里只画一张总流图，方便先建心智模型。

```
            +------------------------------------------------------+
            | 用户在 IM 平台发消息 / CLI 输入                        |
            +------------------------------------------------------+
                              |
                              v
   +-----------------------------------------------------+
   | MessageChannelRuntime (weixin / feishu / yuanbao …) |
   |   - chatKey 构造                                    |
   |   - 入站去重、媒体落盘                              |
   |   - 出站配额（OutboundQuota）                       |
   +-----------------------------------------------------+
                              |  agent.handle(chatKey, text)
                              v
                    +---------------------+
                    | ConsoleAgent        |
                    +---------------------+
                              |
                              v
                    +---------------------+
                    | CommandRouter       |  ← src/commands/
                    +---------------------+
                       |              |
        slash command  |              | 普通文本
                       v              v
              +------------+    +-------------+
              | handlers/  |    | SessionService → transport.prompt
              +------------+    +-------------+
                                       |
                                       v
              +-------------------------------------------+
              | SessionTransport (acpx-cli | acpx-bridge) |
              +-------------------------------------------+
                                       |
                                       v
                                 acpx 子进程
```

旁路：

- **Orchestration** 通过 `OrchestrationServer`（Unix socket / Named Pipe）把多 agent 编排能力对外暴露。`xacpx mcp-stdio` 是它的 MCP-over-stdio 客户端封装。
- **Daemon** 把 `runConsole` + IPC server + heartbeat 包成后台进程；前台 `xacpx run` 跳过 daemon 包装。
- **State 持久化** 走 `DebouncedStateStore` → `StateStore` → `writePrivateFileAtomic`（`proper-lockfile` 跨进程互斥 + `write-file-atomic` 原子 rename + Windows EBUSY 兜底）。

---

## 子系统速查表

| 子系统 | 入口 | 文档 |
| --- | --- | --- |
| 命令解析与路由 | `src/commands/` | [commands-module.md](./commands-module_zh.md), [commands.md](./commands_zh.md) |
| Daemon CLI | `src/daemon/`、`src/cli.ts` | [daemon-module.md](./daemon-module_zh.md) |
| Acpx-Bridge 协议 | `src/bridge/` | [`docs/2026-03-25-weacpx-acpx-bridge-design.md`](../2026-03-25-weacpx-acpx-bridge-design.md) |
| Orchestration | `src/orchestration/` | [`docs/2026-04-13-weacpx-orchestration-design.md`](../2026-04-13-weacpx-orchestration-design.md) |
| 外部 MCP 集成 | `src/mcp/` | [external-mcp.md](./external-mcp_zh.md) |
| 频道管理 | `src/channels/` | [channel-management.md](./channel-management_zh.md) |
| 频道插件 SPI | `src/plugin-api.ts`、`src/plugins/` | [plugin-development.md](./plugin-development_zh.md) |
| 配置 | `src/config/` | [config-reference.md](./config-reference_zh.md), [config-command.md](./config-command_zh.md) |
| 测试 | `tests/`、`scripts/run-tests*` | [testing.md](./testing_zh.md) |
| 发布 | `scripts/verify-publish.mjs` | [发布章节](#发布) |

---

## acpx / SDK / 插件解析顺序

### acpx

`src/config/resolve-acpx-command.ts:resolveAcpxCommand`：

1. `transport.command`（config 显式覆盖）
2. **bundled** acpx：从主包 `node_modules/acpx/...` 解析（默认 `dependencies` 已经声明 `acpx@^0.6.1`）
3. Shell `PATH`

### weixin SDK

`src/weixin-sdk.ts:loadWeixinSdk`：

1. `WEACPX_WEIXIN_SDK` 环境变量
2. 已安装包 `weixin-agent-sdk`

### 插件 home

`src/plugins/plugin-home.ts:resolvePluginHome`：

1. `WEACPX_PLUGIN_HOME` 环境变量
2. 默认 `~/.xacpx/plugins/`（独立 `package.json`，与全局 / 项目 `node_modules` 隔离）

包管理器自动探测：能跑 `bun --version` 就用 `bun add/remove`，否则回退 `npm install/uninstall`（`src/plugins/package-manager.ts`）。插件 add/update 会带 `--registry=https://registry.npmjs.org` 和 `--@ganglion:registry=...`，避免 optional 的 `@ganglion/xacpx-rmux-bridge-*` 被公司镜像 404。可用 `XACPX_PLUGIN_REGISTRY` 覆盖。

---

## 配置与运行时文件

默认全在 `~/.xacpx/`：

| 路径 | 内容 | 写入方 |
| --- | --- | --- |
| `~/.xacpx/config.json` | agents、workspaces、channels、plugins、transport 等静态配置 | `ConfigStore`，CLI |
| `~/.xacpx/state.json` | sessions、chat_contexts、orchestration 状态 | `DebouncedStateStore`（50ms 合并）→ `StateStore` |
| `~/.xacpx/runtime/daemon.pid` | 当前 daemon PID | `DaemonRuntime` |
| `~/.xacpx/runtime/status.json` | daemon heartbeat / start_at / log paths | 同上 |
| `~/.xacpx/runtime/app.log` | bounded 应用日志（轮转） | `AppLogger` |
| `~/.xacpx/runtime/orchestration.sock` | Unix socket / `\\.\pipe\xacpx-orchestration-<hash>` | `OrchestrationServer` |
| `~/.xacpx/plugins/` | 插件 npm home（独立 `package.json` + `node_modules`） | `xacpx plugin add/update` |

字段细节：[docs/config-reference.md](./config-reference_zh.md)。

---

## 代码风格与约定

强约束写在 `AGENTS.md`（`CLAUDE.md` 是它的符号链接）。重点：

- **第一性原理**：从原始需求出发，不复制模板；目标不清楚先停下来对齐。
- **TypeScript 严格模式**：`strict: true`；不放过 `any`；类型即文档。
- **不写无用注释**：除非要解释 *WHY*（隐性约束、过去事故、特意规避的写法）。删掉解释 WHAT 的注释。
- **不要为不可能发生的场景加 `try/catch` / fallback**：内部边界相信类型；只在系统边界（用户输入、外部 API）做校验。
- **测试先行**：bug 修复要附 failing test → 修复 → test 转绿。修代码不写测试视为未完成。
- **频道**：内置只有 `weixin`；非 weixin 频道**必须**作为插件包，在 `src/channels/` 写 product-specific 通道运行时一律不接受。
- **避免破坏性变更**：`xacpx/plugin-api` 是公开类型；改它要慎重，必要时升 `XACPX_PLUGIN_API_VERSION`。

---

## 按场景找入口

新人最容易卡在"我要加 X，从哪里下手"。这张表覆盖最常见的场景：

| 想做的事 | 看这里 / 改这里 |
| --- | --- |
| 加一个新的 slash 命令 | `src/commands/parse-command.ts` 加 token；`src/commands/handlers/` 加 handler；`src/commands/command-router.ts` 注册；测试镜像到 `tests/unit/commands/` |
| 改某个命令的回复格式 | `src/formatting/` 的 render 函数；命令在 router 里调对应 render |
| 加一个新的频道（飞书/Slack/Discord …） | **不要**改 `src/channels/`，看 [docs/plugin-development.md](./plugin-development_zh.md)，在 `packages/channel-<type>/` 起新包 |
| 改 acpx 调用方式（命令行参数、PTY、超时） | `src/transport/acpx-cli/` 或 `src/transport/acpx-bridge/`，保持 `SessionTransport` 接口稳定 |
| 加 / 改一项 orchestration 能力 | `src/orchestration/orchestration-service.ts` + `orchestration-ipc.ts` + `orchestration-server.ts`；测试在 `tests/unit/orchestration/` |
| 改 daemon 启停行为 | `src/daemon/`；status 字段改了同步更 `daemon-status.ts` 与文档 |
| 改 `xacpx doctor` | `src/doctor/index.ts` 与各 probe |
| 改 `xacpx mcp-stdio` 暴露的工具 | `src/mcp/xacpx-mcp-tools.ts` |
| 改 `state.json` schema | `src/state/types.ts` + `state-store.ts` 的解析；考虑迁移 |
| 加可恢复的运行时错误 | `src/recovery/`；router 里 wire 进对应命令 |
| 加 / 改全局公共类型 | `src/plugin-api.ts` 再导出 + `bun run build:plugin-api` |
| 修测试 runner | `scripts/run-tests-lib.mjs`（`buildTestPlan`） |
| 加发布前 preflight | `scripts/verify-publish.mjs` |

---

## Plan / Spec 写作流程

`docs/superpowers/specs/` 与 `docs/superpowers/plans/` 是非强制但**强推荐**的工作流：

- **spec**（设计文档）：解释"我要解决什么 / 为什么这样做 / 备选方案"。
  在动复杂代码前先写一份，命名 `YYYY-MM-DD-<topic>-design.md`。
- **plan**（实施计划）：把 spec 拆成可被 agent / 自己一步步执行的步骤，命名 `YYYY-MM-DD-<topic>.md`。

这两份在历史 PR 里通常作为同一次合并的一部分，便于后续考古。

---

## 提交、PR 与发布

### 提交

- 提交信息走 conventional commits 风格（`fix:`、`feat:`、`docs:`、`chore:`、`test:`）。
- 一个提交聚焦一件事；diff 越小越容易审。
- 测试与代码改动尽量在同一个 commit 里。

### PR

- PR 标题简洁（< 70 字），描述里写：
  - 为什么改（链接 issue / spec）
  - 怎么改
  - 怎么验（手动 / 自动测试）
- 触发 daemon 行为变化的改动（频道、transport、orchestration、state）建议附 dry-run 脚本作证据。

### 发布

发布流程（一句话版）：

```bash
bun run verify:publish      # build:packages + scripts/verify-publish.mjs
bun run publish:xacpx
bun run publish:plugins     # 升一方插件包时
```

发版时记得：

- 升 `package.json` `version`；如果改了一方插件，也升对应 `packages/*/package.json`。
- 在 `docs/releases/` 加发版说明。
- 给 git tag。

### 一方频道插件发布（tag 驱动）

`packages/channel-*` 下的一方频道插件通过 **tag 驱动的 GitHub Actions workflow** 发布，而不是手工 `npm publish`。每个插件各有一个 workflow，遵循同一套契约：

| 插件 | 包名 | tag 规则 | workflow |
| --- | --- | --- | --- |
| 飞书 | `@ganglion/xacpx-channel-feishu` | `channel-feishu-v*` | `.github/workflows/publish-channel-feishu.yml` |
| 元宝 | `@ganglion/xacpx-channel-yuanbao` | `channel-yuanbao-v*` | `.github/workflows/publish-channel-yuanbao.yml` |
| Discord | `@ganglion/xacpx-channel-discord` | `channel-discord-v*` | `.github/workflows/publish-channel-discord.yml` |

推送匹配的 tag（或用 `workflow_dispatch` 指定已存在的 tag）后，workflow 会检出该精确 tag，依次跑 `npm ci` → `npm test` → 包构建 → `verify:publish`，从 `packages/<name>/package.json` 读取版本号，并且 **当 tag 与 `channel-<name>-v<version>` 不一致时 fail closed 直接失败**。随后把包发布到 npm：预发布版本用 `next` dist-tag、稳定版本用 `latest`，并创建对应的 GitHub Release。workflow 依赖仓库的 `NPM_TOKEN` secret。

因为版本号是唯一事实来源，发版就简化成：升 `packages/channel-discord/package.json` 的 `version` → 合并 → 推 tag。

`verify:publish` 只校验 `scripts/verify-publish.mjs` 里 `DEFAULT_PACKAGES` 登记过的包。没登记的包会**完全零校验**地发布出去，而 workflow 那一步照样是绿的——所以**新增一方插件时必须同时在那里登记**。`tests/unit/scripts/verify-publish.test.ts` 会断言 `packages/` 下每个非 private 包都已登记，这条不变量就是防止它悄悄失效的。

**Discord 首发 runbook**（以 `0.8.0` 为例——**写文档期间不要真的打 tag / 发 npm**，只有明确要求发版时才做）：

```bash
# 1. 确认 PR 合并后 main 上就是目标代码
# 2. 确认 packages/channel-discord/package.json 版本（如 0.8.0）
# 3. 确认 npm 包名 @ganglion/xacpx-channel-discord
# 4. 创建并推送精确 tag
git tag channel-discord-v0.8.0
git push origin channel-discord-v0.8.0

# 5. Actions 自动跑 测试 → 构建 → verify:publish → npm → GitHub Release
# 6. 核对 npm dist-tag 与 GitHub Release
```

**中断发版的恢复契约**（npm 上版本已存在，但 GitHub Release 缺失——workflow 在 `npm publish` 与 `gh release create` 之间挂掉或失败）：

- **不要重跑 publish workflow，也不要移动或重推 tag。** npm 侧已经完成：对已存在的版本再 `npm publish` 只会失败；而给已发布的 tag 换指向，会让 tag 不再指向产出该制品的那个 commit。
- 先确认 tag 存在，并且指向携带该版本的那个 commit：

  ```bash
  git show-ref --verify refs/tags/channel-discord-v0.8.0
  git rev-parse refs/tags/channel-discord-v0.8.0^{commit}   # 必须是 package.json 里 version 为 0.8.0 的那个 commit
  ```

- 只补缺失的 Release 对象，并让 `--verify-tag` 充当「tag 其实不存在就拒绝创建」的闸门。标题要与 workflow 会用的那份一致，并且稳定版要带 `--latest=false`，免得插件 Release 抢走仓库核心版本的 latest 标记：

  ```bash
  gh release create channel-discord-v0.8.0 --verify-tag \
    --title "@ganglion/xacpx-channel-discord v0.8.0" --latest=false --generate-notes
  ```

- 版本号带预发布后缀（`-rc.1`、`-beta.2` 等）时，把 `--latest=false` 换成 `--prerelease`；workflow 用同一套 `package.json` 规则推导该标记，且这种版本当时的 npm dist-tag 是 `next` 而不是 `latest`。
- Release 这一步双向幂等：该 tag 已有 Release 就跳过，所以部分成功后重发同一条命令是安全的。

---

## 拓展阅读

- 用户视角：[README.md](./README_zh.md)
- 完整命令参考：[commands.md](./commands_zh.md)
- 频道管理：[channel-management.md](./channel-management_zh.md)
- 插件开发：[plugin-development.md](./plugin-development_zh.md)
- 配置字段：[config-reference.md](./config-reference_zh.md)
- 代码地图：[code-wiki.md](./code-wiki_zh.md)
- 测试约定：[testing.md](./testing_zh.md)
- 发版流程：[发布章节](#发布)
- 多 Agent 编排原理：[`2026-04-13-weacpx-orchestration-design.md`](../2026-04-13-weacpx-orchestration-design.md)
- Acpx-Bridge 协议：[`2026-03-25-weacpx-acpx-bridge-design.md`](../2026-03-25-weacpx-acpx-bridge-design.md)
- 项目规约（`AGENTS.md` / `CLAUDE.md`）：[../AGENTS.md](../../AGENTS.md)
