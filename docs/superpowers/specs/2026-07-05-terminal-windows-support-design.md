# 终端 Windows 支持设计

> 状态:待实现。范围:放开内置终端的 Windows 门禁,让 Windows 实例也能开终端。验证靠 hub beta 真机 + 一条最小 windows-latest CI leg。

## 目标

删掉终端的 Windows 主动门禁,使 `process.platform === "win32"` 的实例也能创建/使用内置终端;shell 选择走 pwsh→PowerShell→cmd 回落,并新增跨平台 `terminal.shell` 显式覆盖配置。

## 非目标 / 边界

- 不做终端**内容 replay**(第 3 层,单独立项)。本次只让 Windows 能起终端,行为与现有 macOS/Linux 终端一致(create/write/resize/idle 回收/close/exit)。
- 不动 connector(`channel-relay`)/ hub(`relay`):它们对终端纯透传,无平台逻辑。
- 不改前端终端渲染(ghostty-web 是原始字节流、平台无关)。
- 不跑全量单测于 Windows CI——只跑终端相关 + 装依赖冒烟(理由见"CI"节)。

## 已知底子(锚定,无需再查)

- 门禁是**单点主动 gating**:`src/control/terminal-service.ts:105` 一行 `if (platform === "win32") throw new Error("terminal-unsupported-platform")`,在选 shell / spawn 之前。
- node-pty `^1.1.0` 自带 Windows 预构建(`prebuilds/win32-{x64,arm64}/pty.node`+`conpty.node`+打包的 `conpty.dll`)。打包对 node-pty 是 `--external`(`package.json:45`),运行时从 `node_modules` require;`npm i` 时 node-pty 的 install 脚本取预构建,正常路径不需本地 MSVC。
- `node-pty-helper.ts:11` 对 win32 返回 null,`ensureNodePtyHelperExecutable(null)` no-op——已就绪,不改。
- cwd 链路 Windows 安全:`normalizePath`(`src/util/path.ts:8`)保盘符、`\`→`/`(`C:\x`→`C:/x`),ConPTY 接受正斜杠;终端路径上无 `realpath`/`path.posix` 破坏盘符。
- xacpx 本身早已跑 Windows(daemon/命名管道 IPC/`taskkill /F`/`.exe` 解析等成熟 win32 分支)——终端是唯一被主动 gate 的能力。

## 架构总览

四个改动单元,解耦:

1. **shell 解析纯函数** `resolveShell(...)`(在 `terminal-service.ts` 内或抽小工具)——可注入 `exists` 谓词,便于在 ubuntu CI 上以 `platform="win32"` 单测。取代现有 `defaultShell()`。
2. **门禁放开 + 配置串联**:删 win32 throw;`TerminalConfig` 加 `shell?: string`;经 deps 回调把配置串到 `resolveShell`。
3. **前端**:保留 `terminal-unsupported-platform` 映射作防御兜底(正常路径不再触发),更新 i18n 文案去掉"仅 mac/Linux"暗示。
4. **windows-latest CI leg**:最小、聚焦——装依赖 + 终端单测 + 真 ConPTY smoke。

## 单元设计

### 单元 1 — shell 解析(`src/control/terminal-service.ts`)

新增纯函数(导出以便单测),取代 `defaultShell()`(现 :67-70):

```ts
export interface ResolveShellArgs {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  shellOverride?: string;                 // config terminal.shell(跨平台,最高优先)
  exists?: (p: string) => boolean;        // 可注入;默认 fs 存在性检查
}

export function resolveShell(args: ResolveShellArgs): string {
  const { platform, env, shellOverride } = args;
  const exists = args.exists ?? defaultExists;
  // 1. 显式配置覆盖(任何平台)
  if (shellOverride && shellOverride.trim()) return shellOverride;
  // 2. 平台默认
  if (platform === "win32") {
    // 忽略 SHELL(常被 git-bash 污染成 MSYS 路径,node-pty 按 Windows 路径 spawn 会失败)
    const pathValue = env.PATH ?? env.Path ?? "";
    const dirs = pathValue.split(";").filter(Boolean);
    for (const name of ["pwsh.exe", "powershell.exe"]) {
      for (const dir of dirs) {
        const full = `${dir}\\${name}`;
        if (exists(full)) return full;   // 找到即返回绝对路径(确知存在)
      }
    }
    return env.ComSpec ?? "cmd.exe";     // 最终回落
  }
  // unix:行为不变
  if (env.SHELL) return env.SHELL;
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}
```

`defaultExists`:`(p) => { try { return statSync(p).isFile(); } catch { return false; } }`(win32 分支硬编码 `;` 与 `\\`,不依赖测试宿主的 `path.delimiter`/`path.sep`,故 ubuntu 上注入 `exists` 可完整测 win32 分支)。

**Interfaces**
- Produces:`resolveShell(args) => string`。
- Consumes:`fs.statSync`(默认 exists)、注入的 `platform`/`env`/`shellOverride`/`exists`。

### 单元 2 — 门禁放开 + 配置串联

**(a) config 类型 + 访问器**(`src/config/types.ts`):
- `TerminalConfig`(:50)加:`/** Explicit shell override (path or name). Cross-platform: wins over SHELL / platform default. */ shell?: string;`
- 新增访问器(镜像 `terminalIdleTimeoutSeconds`):
```ts
export function terminalShell(config: AppConfig): string | undefined {
  const v = config.terminal?.shell;
  return typeof v === "string" && v.trim() ? v : undefined;
}
```

**(b) TerminalService deps**(`terminal-service.ts`):`TerminalServiceDeps` 加可选回调 `shell?: () => string | undefined;`(镜像 `idleTimeoutSeconds: () => number`)。

**(c) create() 放开门禁 + 用解析 shell**(:104-107):
```ts
    create({ cwd, cols, rows }) {
      const shell = resolveShell({ platform, env: process.env, shellOverride: deps.shell?.() });
      const terminalId = randomUUID();
      const handle = spawn(shell, [], { name: "xterm-256color", cols, rows, cwd, env: scrubEnv() });
      ...
```
即删掉 `if (platform === "win32") throw ...` 那行,`defaultShell(platform)` 换成 `resolveShell(...)`。其余(session 管理/idle/事件)不变。

**(d) 布线**(`src/main.ts:768`):`createTerminalService({ ... })` 加 `shell: () => terminalShell(config),`,并在 :17 import 加 `terminalShell`。

**(e) control-service 不改**:`createTerminal` 仍传 `{cwd,cols,rows}`;shell 是 TerminalService 经 deps 读的配置,不走 control-service。connector/hub 不改。

**Interfaces**
- Consumes:`terminalShell(config)`、`resolveShell`。
- Produces:TerminalService 在所有平台(含 win32)可 create。

### 单元 3 — 前端(`packages/relay-web`)

- **保留** `TerminalTab.vue:270` 的 `"terminal-unsupported-platform" → terminal.unsupported` 映射作防御兜底(后端正常路径不再抛,但保留零风险,防未来再 gate)。**不删**。
- 更新 i18n 文案去掉"仅 mac/Linux"暗示(`en.ts:347` + `zh-CN.ts:345`,过 `i18n-parity.test.ts`):
  - en:`terminal.unsupported` → `"Terminal is not supported on this instance platform."`
  - zh:`"该实例平台不支持终端。"`

### 单元 4 — windows-latest CI leg(`.github/workflows/test.yml`)

在现有单 `test`(ubuntu-latest)job 旁**新增** `terminal-windows` job(`runs-on: windows-latest`),**只做聚焦验证,不跑全量**:
- checkout → setup Bun → setup Node 24 → `npm ci`(**验 node-pty 预构建在 Windows 解析安装**)。
- 跑终端单测:`bun test tests/unit/control/terminal-service.test.ts`(纯逻辑,注入 platform/spawn,平台无关,确认改动无回归)。
- 跑真 ConPTY smoke(单元 5 的 smoke 文件):`bun test tests/smoke/terminal-pty-smoke.test.ts`——在真 Windows 上起真实 shell 验证。

**关键取舍:不在 Windows 上跑 `npm test`(全量单测)**——整套单测从未在 Windows 跑过,会因大量无关既有 Windows 差异红掉、淹没本功能信号。只把"Windows 能装 node-pty + 能起终端 + 终端逻辑无回归"这件事验清。全量回归仍由既有 ubuntu leg 保证。

### 单元 5 — 测试

跑法:核心单测 `bun test tests/unit/control/terminal-service.test.ts`(单文件,勿整目录——整目录 bun test 有状态泄漏假失败)。前端 i18n `cd packages/relay-web && npx vitest run src/__tests__/i18n-parity.test.ts`。

**(a) `resolveShell` 单元**(`tests/unit/control/terminal-service.test.ts` 内新增,注入 platform/env/exists):
- config `shellOverride` 设了 → 任何平台都返回它(win32 + darwin 各一例)。
- unix 无覆盖:`env.SHELL` 优先;无 SHELL → darwin `/bin/zsh`、linux `/bin/bash`(**回归既有行为**)。
- win32 无覆盖:**忽略 `env.SHELL`**(即使 `SHELL=/usr/bin/bash` 也不用它);`exists` 让 `pwsh.exe` 命中 → 返回其绝对路径;pwsh 不在但 `powershell.exe` 在 → 返 powershell;都不在 → `env.ComSpec`;`ComSpec` 也无 → `cmd.exe`。
- win32 pwsh 优先于 powershell(两者都"存在"时选 pwsh)。

**(b) terminal-service 门禁**(改既有 :85-88 用例):
- 原"win32 抛 terminal-unsupported-platform"→ 改为"win32 不再抛;create 用解析出的 shell spawn"(注入 spawn 断言收到的 file = 解析结果;注入 platform=win32 + exists)。

**(c) 真 ConPTY smoke**(新建 `tests/smoke/terminal-pty-smoke.test.ts`):
- 用**真 spawn**(不注入)+ 真 platform 构造 TerminalService,`create({cwd: process.cwd(), cols:80, rows:24})`,write 一条打印命令(如 pwsh `echo __PTY_OK__\r`),收集 `terminal-output` 事件,断言输出含标记,然后 close,断言收到 `terminal-exit`。
- **平台守卫**:仅在能起真实 PTY 时跑(smoke 目录默认不入 `npm test`);Windows CI leg 显式调它验 ConPTY。非 Windows 上跑也应通过(macOS/Linux 真 PTY),故可作跨平台 PTY 冒烟,但主用途是 Windows leg。用合理超时,避免 CI 卡死。

**(d) i18n parity**:改文案后 en/zh-CN 同步,过 `i18n-parity.test.ts`。

## 错误处理

- shell 解析永不抛:PATH 空/无候选 → 回落 `ComSpec` → `cmd.exe`(始终有值)。
- node-pty 预构建缺失(极端:Windows 上 install 未取到二进制)→ `spawn` 抛,现有 `create` 无 try/catch 会向上冒泡成 rpc 错误,前端映射为 `terminal.error`(既有兜底文案)——可接受,beta 真机会暴露此类环境问题。
- `terminal.shell` 配置指向不存在的可执行 → spawn 失败同上冒泡;不做预校验(YAGNI,配置是用户显式行为)。

## 交付与验收

- 后端改动(core):`terminal-service.ts` + `config/types.ts` + `main.ts` + 单测;CI:`test.yml`;前端:`TerminalTab` i18n 文案。
- **发布**:core 改了 → 需发 core beta(带 terminal Windows 能力)+ relay/channel-relay 视版本耦合(前端只改了 i18n 文案,relay-web 打进 hub)。具体发布顺序/版本耦合按既有 runbook,在计划/发布阶段定,不在本 spec。
- **验收(hub beta 真机,Windows)**:Windows 实例上 `terminal.enabled=true` → 看板开终端 → 起 pwsh/PowerShell(或配 `terminal.shell` 指定)→ 能输入命令、看输出、resize、退出;设 `terminal.shell` 覆盖生效;git-bash 机器上 `SHELL=/usr/bin/bash` 不影响(仍起 PowerShell)。CI:windows-latest leg 绿(装依赖 + 终端单测 + ConPTY smoke)。
