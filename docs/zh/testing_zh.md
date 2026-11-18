# Testing Guide

## Goal

让测试目录和执行入口保持清晰、稳定、可维护。

生产代码放在 `src/`，测试代码放在 `tests/`，不要再把测试文件散落在源码目录里。relay-web 包有一个下文明确记录的 Vitest 例外。

## 目录约定

### `tests/unit/`

默认单元测试目录。

规则：

- 目录结构尽量镜像 `src/`
- 默认所有稳定、可重复、无外部环境依赖的测试都放这里
- `npm test` 和 `npm run test:unit` 都跑这里

### `tests/integration/`

为真正跨模块、跨边界的测试预留。

只有当测试明显依赖多个模块协作，并且不适合继续放在 `tests/unit/` 时，再使用这个目录。

当前仓库还没有强制启用它。

### `tests/smoke/`

放真实环境烟测脚本或需要外部依赖的验证：

- 真实 `acpx`
- 真实 bridge
- 真实微信运行链路

这些测试不应进入默认 `npm test`，避免本地或 CI 因环境差异变得不稳定。

### `tests/helpers/`

放测试辅助函数、fixture builder、测试专用工具。

当前如果某个 helper 很小，也可以先内联在测试文件里；只有复用明显时再提取。

### `packages/relay-web/src/__tests__/`（包级例外）

relay-web 的组件/store 测试放在该包自己的 `src/__tests__/` 下，因为它们需要 Vite 的 Vue 转换以及该包的 jsdom/Vitest 配置。运行方式：

```bash
bun run --cwd packages/relay-web test
```

根目录的 `npm test` 通过 `test:web` 把这套测试包含进来。这是唯一受支持的「测试放在 `src` 下」的例外；Node/核心/各包的测试仍放在 `tests/unit/` 下。

## 默认命令

### 全量默认单元测试

```bash
npm test
```

等价于：

```bash
npx tsc --noEmit
node ./scripts/run-tests.mjs
```

默认先执行 TypeScript 类型检查，再递归执行 `tests/unit/**/*.test.ts`。

### 显式运行 unit tests

```bash
npm run test:unit
```

同样会先执行：

```bash
npx tsc --noEmit
```

### 构建验证

```bash
bun run build
```

### macOS 平台测试

```bash
npm run test:macos
```

macOS 的 CI job 使用这个聚焦套件；Ubuntu 继续跑 `npm test`，包含所有单元文件与 relay-web 的 Vitest。文件列表是 `scripts/run-tests-lib.mjs` 里的 `MACOS_TEST_FILES`。每个文件都在独立的 Bun 进程中运行，与完整 runner 一样带相同的 prebuild、类型检查、import lint 和超时。之后它会在 Node 下运行 `scripts/smoke-terminal-conpty.mjs`，与守护进程的 native 插件运行时保持一致。聚焦套件不调用 relay-web 的 Vitest。

入选的文件覆盖这些宿主行为：

| 边界 | 覆盖内容 |
| --- | --- |
| PTY | 在 Node 下真实执行 node-pty shell 并产生输出；POSIX 标记无法靠命令回显满足 |
| 文件监听 | 在 `main.test.ts` 中通过宿主 watcher 做真实配置热重载 |
| 文件锁 | native `fs-ext` flock、崩溃释放、跨进程的 registry 归属，以及并发的配置/终端 registry 写入 |
| 进程生命周期 | bootstrap 归属、worker 关闭、stdin EOF 和 POSIX 进程组 |
| 文件系统身份 | 真实符号链接、inode 别名、规范化路径、workspace 归属边界和 Git worktree |
| SQLite | native Bun SQLite 事务、独立连接和重开后的持久性 |

依赖这些宿主边界的新测试，请放进 macOS 列表。只注入 `platform` 参数或 mock 操作系统 API 的测试，仍由完整的 Linux 套件覆盖。macOS job 还保留生产构建、acpx 兼容性 smoke、Node SQLite 契约和 CLI/runtime 基准。

`tests/unit/packages/channel-relay/terminal-registry-lock-recovery.test.ts` 会在 `node_modules/.registry-lock-test-*` 下构建一个 Node registry writer，对一个竞争的 Bun loader 施加真实持有的锁：过期的 mtime 不得抢走归属，被 SIGKILL 的持有者必须释放它。CI 另外在专用的 Windows job 中运行该文件，那里归属用的是命名管道 guard 而不是 flock。

### 隔离的本地 CI 验证

构建请使用临时 worktree 或临时 checkout：runner 会重新构建受版本控制的 `packages/relay-protocol/dist` 产物。子进程请使用临时的 `HOME`、`USERPROFILE` 和 `TMPDIR` 运行。把 `XACPX_CONFIG`/`WEACPX_CONFIG`、`XACPX_STATE`/`WEACPX_STATE` 以及两个插件 home 变量都设到该临时目录内的路径；先清掉继承来的启动/IPC 覆盖项。把 `OPENCLAW_STATE_DIR` 和 `CLAWDBOT_STATE_DIR` 也重定向到那里。

仅靠显式的配置/state fixture 并不能隔离所有副作用：`buildApp()` 会在进程 home 下初始化一个上传存储。反过来说，`buildApp()` 不会获取守护进程的 runtime-consumer 锁，所以正在运行的 operator 守护进程并不能证明是它导致了测试超时。请使用有界的子进程，并在归因失败或比较耗时之前，先检查它们的退出状态和完整测试摘要。`verify-stack` 记录了同样的 home/state 隔离原则；它的 daemon/hub 栈对这些只跑测试的场景是没有必要的。

## 新增测试时的规则

1. 新测试默认放 `tests/unit/`；relay-web 的 Vue/jsdom 测试使用上文记录的包级例外
2. 目录结构尽量镜像 `src/`
3. 测试文件命名保持 `*.test.ts`
4. 避免把临时排障脚本留在仓库根目录
5. 需要真实环境的验证不要塞进默认测试套件

## 什么时候放进 smoke

下列情况优先考虑 `tests/smoke/` 而不是 `tests/unit/`：

- 需要真实 `acpx` 会话
- 需要真实 `~/.acpx` 状态写入
- 需要真实微信登录
- 需要外部网络、GUI、二维码扫描或本地 agent 运行环境

## 迁移后的规则

- `src/` 只放生产代码，上文记录的 `packages/relay-web/src/__tests__/` 除外
- `tests/` 只放测试代码
- `scripts/` 只放运行脚本，不放测试主体

如果以后需要新增测试类型，优先在 `tests/` 下新增子目录，而不是重新把测试塞回 `src/`。

## 会话创建体验（Smoke）

### 平台包缺失自愈

复现：
1. 删除 opencode 安装目录下的 `node_modules/opencode-windows-x64`。
2. 在微信中执行 `/ss opencode --ws demo`。
3. 预期消息序列：
   - 🚀 正在启动 `opencode`…
   - 📦 检测到缺失依赖 `opencode-windows-x64`，正在自动安装…
   - 🔄 安装完成，正在验证会话启动…
   - 🚀 正在启动 `opencode`…（验证阶段的全新进度，计时从 0 开始）
   - 🔧 `opencode` 初始化中…（已等待 Ns）（仅长耗时时）
   - ✅ 会话已创建：...

### 自愈失败

两类失败：

- **npm 安装失败**（断网、权限等）：自动尝试精确（每个候选父包路径各一次，覆盖 Bun/npm/pnpm/yarn 全局与本地 node_modules）与全局共 N 次安装都非零退出。最终消息标题为 `❌ 自动安装失败`，列出每次 stderr 摘要（精确步骤会标注具体路径）、手动命令 `npm install -g <pkg>`、日志路径。
- **安装成功但验证仍失败**（精确安装落在错误的依赖树上、资源已被 acpx 缓存）：安装 exit=0 但重新 ensureSession 仍抛缺失依赖。最终消息标题为 `⚠️ 自动安装已执行但未能修复会话启动问题`，每个步骤显示「安装已执行但验证失败（精确 / <path>｜全局）」，同样附手动命令与日志路径。
- **跨包管理器发现**：xacpx 在自动安装前会枚举候选父包目录——Bridge 报告的 seed、`require.resolve` 能看到的本地 node_modules、`$BUN_INSTALL`/`~/.bun/install/global/node_modules`，以及 `npm root -g` / `pnpm root -g` / `yarn global dir`。含有 `package.json` 的目录会依次作为「精确」安装步骤使用。

### 仅进度反馈

在无错场景下，`/ss <agent>`：
- < 3s：只看到 🚀 正在启动
- ≥ 3s：🚀 后再见 🔧 初始化中…（已等待 Ns）
