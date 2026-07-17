# 贡献与开发

本指南面向修复 Bug 的开发者、新功能开发者、频道插件作者以及代码阅读者。如需面向用户的文档，请参阅[快速开始](/zh/guide/getting-started)指南和 [README](https://github.com/gadzan/xacpx/blob/main/README.md)。

## 开发环境搭建

### 前置条件

- **Node.js ≥ 22.12** 或 **Bun**（Bun 用于开发脚本和构建；Node 可运行构建产物）
- 微信、飞书或元宝账号（取决于你要测试的频道；仅阅读代码无需任何账号）
- `acpx` 及目标智能体 CLI（codex / claude / gemini 等）可在机器上正常运行

### 克隆与安装

```bash
git clone https://github.com/gadzan/xacpx
cd xacpx
bun install            # 安装根包及所有 packages/*（工作区）
```

### 首次构建

```bash
bun run build              # 主包：dist/cli.js + dist/bridge/bridge-main.js + dist/plugin-api.{js,d.ts}
bun run build:packages     # 主包 + 所有 packages/*（发布前必须执行）
```

### 首次运行

```bash
bun run dev                # 等价于：bun run ./src/cli.ts run（前台模式）
```

或使用 dry-run 模式（无需 IM 连接）：

```bash
bun run dry-run --chat-key wx:test -- "/ss new demo --agent codex --ws backend" "/status"
```

### 首次测试

```bash
npm test                   # tsc --noEmit + tests/unit/**/*.test.ts
```

## 构建命令

| 脚本 | 用途 |
| --- | --- |
| `bun run build` | 主包：打包 `dist/cli.js`、`dist/bridge/bridge-main.js`、`dist/plugin-api.js`；通过 `tsc -p tsconfig.plugin-api.json` 生成 `dist/plugin-api.d.ts` |
| `bun run build:plugin-api` | 仅刷新 `dist/plugin-api.d.ts`（修改公共类型时使用） |
| `bun run build:channel-feishu` | 主包 + 飞书插件 |
| `bun run build:channel-yuanbao` | 主包 + 元宝插件 |
| `bun run build:packages` | 主包 + 所有 `packages/*` |
| `bun run verify:publish` | `build:packages` + `scripts/verify-publish.mjs`（每次发布前运行） |
| `bun run dev` | 直接运行主包源码（无需构建） |
| `bun run dry-run -- ...` | Dry-run 入口（无 IM 连接） |
| `bun run login` | 微信二维码扫码登录 |

构建说明：
- `bun build --target node --external node-pty` — `node-pty` 不打包进产物，运行时从 `node_modules` 解析。`packages/*` 同样将 `xacpx` 标记为 external。
- 唯一稳定的公共 API 导出是 `xacpx/plugin-api`。其他路径（`xacpx/dist/*`、`xacpx/src/*`）属于内部路径，随时可能变更。
- 插件包使用 `tsc -p packages/<name>/tsconfig.json` 单独生成 `.d.ts` 文件，因为 `bun build` 目前不支持生成声明文件。

### 三种本地运行模式

**模式 1 — `bun run dev`（前台模式）：** 最常用的模式。直接运行 `src/cli.ts run`，无需重新构建即可热编辑。适用于调试路由器、频道、编排和传输层。

**模式 2 — `dist/cli.js`（模拟已安装状态）：**
```bash
bun run build
node ./dist/cli.js start
node ./dist/cli.js status
node ./dist/cli.js stop
```
适用于复现"用户已安装"场景的行为，测试 `bin/xacpx` 入口点，以及验证打包后的 `node-pty` 解析。

**模式 3 — `bun run dry-run`（无 IM 连接）：**
```bash
bun run dry-run --chat-key wx:test -- \
  "/agent add codex" \
  "/ws new backend -d /absolute/path/to/backend" \
  "/ss new demo -a codex --ws backend" \
  "/status"
```
复用相同的 `buildApp` + 路由器 + 传输栈，将 IM 入站替换为命令行参数，将 IM 出站替换为终端输出。适用于复现在单元测试中难以隔离的命令解析和会话生命周期 Bug。

## 测试命令

| 目录 | 命令 | 适用场景 |
| --- | --- | --- |
| `tests/unit/` | `npm test` 或 `npm run test:unit` | 默认；镜像 `src/` 结构；在 CI 中运行 |
| `tests/smoke/` | `npm run test:smoke` | 真实 `acpx` / 真实 IM 协议；手动运行，不在 CI 中运行 |
| `tests/helpers/`、`tests/fixtures/` | — | 共享工具和静态数据 |

测试运行器为 `scripts/run-tests.mjs` → `scripts/run-tests-lib.mjs::buildTestPlan`。它先运行 `tsc --noEmit`，然后为每个 `*.test.ts` 文件单独启动一个 `bun test` 进程。如需修改运行器行为，只修改这两个脚本。

测试约定：
- 任何写入磁盘的测试必须使用 `mkdtemp` 进行隔离，并通过 `rm -rf` 清理。
- 时间敏感的断言必须对预期的 promise 使用 `await`，或轮询直至条件满足——不得使用 `Bun.sleep()` 作为同步屏障。
- 涉及 `state.json` 写入的测试必须向 `buildApp()` 传入 `stateSaveDebounceMs: 0`（参见 `tests/unit/main.test.ts` 顶部的封装）。

## 仓库目录结构

### 顶层

```
xacpx/
├── src/                # 主包源码
├── packages/           # 第一方频道插件
│   ├── channel-feishu/
│   └── channel-yuanbao/
├── tests/
│   ├── unit/           # 默认单元测试
│   ├── smoke/          # 真实 acpx / 真实账号测试
│   ├── helpers/        # 共享 fixture 和 mock
│   └── fixtures/       # 静态测试数据
├── docs/               # 用户文档、设计文档、计划文档
│   └── superpowers/    # plans/ 和 specs/
├── packages/docs/      # VitePress 文档站
├── scripts/            # 测试运行器、发布预检
├── package.json        # npm workspaces 根
├── bun.lock
├── tsconfig.json
├── tsconfig.plugin-api.json
├── AGENTS.md           # 项目约定（CLAUDE.md 是符号链接）
└── README.md
```

### `src/` 子目录

| 目录 | 职责 |
| --- | --- |
| `src/cli.ts` | CLI 入口点；分发所有 `xacpx <command>` 子命令 |
| `src/main.ts` | `buildApp()` 运行时组装；`resolveRuntimePaths()` 路径解析 |
| `src/run-console.ts` | 启动序列：守护进程运行时 → 消费者锁 → 频道启动 |
| `src/console-agent.ts` | 将入站消息桥接到路由器 |
| `src/channels/` | 频道注册表；内置 `weixin`；向插件暴露 `MessageChannelRuntime` |
| `src/commands/` | 命令解析 + 处理器 + 路由器 |
| `src/sessions/` | 逻辑会话（`state.json` 持久化）+ `AsyncMutex` 串行化 |
| `src/transport/` | `acpx` 桥接抽象 + `acpx-cli` 和 `acpx-bridge` 实现 |
| `src/bridge/` | `acpx-bridge` 子进程入口和 JSONL 协议 |
| `src/orchestration/` | 多智能体编排服务 + IPC 服务器/客户端 + 状态机 |
| `src/mcp/` | `xacpx mcp-stdio` — 将编排能力暴露为 MCP 服务器 |
| `src/daemon/` | 守护进程控制器、状态/PID 文件、运行时元数据 |
| `src/plugins/` | 插件加载、CLI、doctor、包管理器抽象、校验 |
| `src/plugin-api.ts` | **公共**插件 API 类型重导出（编译为 `dist/plugin-api.d.ts`） |
| `src/state/` | `state.json` 持久化 + `DebouncedStateStore`（50 ms 写入合并） |
| `src/config/` | `config.json` 加载 / 写入 / 默认模板 |
| `src/recovery/` | 缺失可选依赖的自动安装 |
| `src/logging/` | 有界 `app.log`、级别过滤 |
| `src/weixin/` | 内置微信频道 + 媒体管线 + 消费者锁 |

### `packages/` 子包

每个插件包具有相同的结构：

```
packages/channel-<name>/
├── src/
│   ├── index.ts           # 默认导出 XacpxPlugin
│   ├── channel.ts         # 实现 MessageChannelRuntime
│   ├── <name>-provider.ts # 实现 ChannelCliProvider
│   └── ...
├── dist/                  # bun build 产物 + tsc 生成的 .d.ts 文件
├── package.json           # peerDependencies.xacpx（可选）
├── tsconfig.json
└── README.md
```

编写新频道插件，请参阅[频道插件开发](/zh/plugins/development)参考文档。

## 包管理

xacpx 使用 **Bun** 作为主要开发包管理器。锁文件为 `bun.lock`。

插件包管理（在 `~/.xacpx/plugins/` 内部）使用自动检测：若 `bun --version` 成功，则使用 `bun add/remove`；否则回退到 `npm install/uninstall`（`src/plugins/package-manager.ts`）。

### 插件主目录解析

1. `WEACPX_PLUGIN_HOME` 环境变量。
2. 默认值：`~/.xacpx/plugins/`（独立的 `package.json` + `node_modules`；与全局或项目 `node_modules` 隔离）。

### 微信 SDK 解析

1. `WEACPX_WEIXIN_SDK` 环境变量。
2. 已安装的包 `weixin-agent-sdk`。

## 发布说明

```bash
bun run verify:publish      # build:packages + scripts/verify-publish.mjs
```

发布时：
- 在 `package.json` 中更新 `version`；若第一方插件有变更，同步更新 `packages/*/package.json`。
- 在 `docs/releases/` 中添加发布说明。
- 创建 git tag。

发布命令：
```bash
bun run publish:xacpx
bun run publish:plugins     # 升级第一方插件包时使用
```

Tag 命名约定：
- 核心包：`vX.Y.Z`
- 插件：`channel-<pkg>-vX.Y.Z`

推送 tag 将通过 CI 自动触发 npm publish。

提交和 PR 约定：
- 遵循约定式提交：`fix:`、`feat:`、`docs:`、`chore:`、`test:`。
- 每次提交专注于一个变更；diff 越小越易于 review。
- 测试与代码变更放在同一次提交中。
- PR 标题不超过 70 个字符；描述说明原因、实现方式和验证方法。
- 影响守护进程行为（频道、传输、编排、状态）的变更应附上 dry-run 脚本作为验证证据。

## 文档约定

- `AGENTS.md`（符号链接为 `CLAUDE.md`）包含面向贡献者的长期稳定约束和导航信息。只编辑 `AGENTS.md`——不要直接修改 `CLAUDE.md`。
- 新增或重构子系统时：先更新或新增对应的 `docs/*.md` 页面，再在 `AGENTS.md` 中补充导航入口。
- 新增 CLI / 配置 / 命令能力时：先更新 `README.md` / `docs/commands.md` / `docs/config-reference.md`，再在 `AGENTS.md` 的"Docs to rely on"章节中添加链接。
- 保持 `AGENTS.md` 简短——超过一屏的细节应迁移到 `docs/` 或 `docs/code-wiki.md`。

设计文档位于 `docs/superpowers/`：
- **specs**（`YYYY-MM-DD-<topic>-design.md`）— 说明要解决的问题、原因以及考虑过的备选方案。
- **plans**（`YYYY-MM-DD-<topic>.md`）— 将 spec 拆解为智能体或人员可逐步执行的步骤。

两者通常与实现代码一起合入同一次合并。

### 快速定位指南

| 目标 | 查找位置 / 修改内容 |
| --- | --- |
| 添加新的斜杠命令 | `src/commands/parse-command.ts` → `src/commands/handlers/` → `src/commands/command-router.ts` → `tests/unit/commands/` |
| 修改命令的回复格式 | `src/formatting/` 渲染函数 |
| 添加新频道（飞书、Slack、Discord 等） | **不要**修改 `src/channels/` — 请参阅[频道插件开发](/zh/plugins/development)并创建 `packages/channel-<type>/` |
| 修改 acpx 调用方式（参数、PTY、超时） | `src/transport/acpx-cli/` 或 `src/transport/acpx-bridge/`；保持 `SessionTransport` 接口稳定 |
| 添加或修改编排能力 | `src/orchestration/orchestration-service.ts` + IPC 相关文件；测试在 `tests/unit/orchestration/` |
| 修改守护进程的 start/stop 行为 | `src/daemon/`；若状态字段有变更，同步更新 `daemon-status.ts` 和本文档站 |
| 修改 `xacpx doctor` | `src/doctor/index.ts` 及其探针 |
| 修改 `xacpx mcp-stdio` 暴露的工具 | `src/mcp/xacpx-mcp-tools.ts` |
| 修改 `state.json` 的 schema | `src/state/types.ts` + `state-store.ts` 解析逻辑；考虑迁移兼容性 |
| 添加或修改公共插件 API 类型 | `src/plugin-api.ts` 重导出 + `bun run build:plugin-api` |
| 修复测试运行器 | `scripts/run-tests-lib.mjs`（`buildTestPlan`） |
| 添加发布预检逻辑 | `scripts/verify-publish.mjs` |
