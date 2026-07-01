# relay-web 远程实例终端 设计 (Design Spec)

> 状态:已脑暴定稿,待写实现计划。
> 日期:2026-06-30。
> 相关:[[project_hapi_borrow_relay_web_ux]](终端是其中明确 deferred 项)、docs/relay-module.md、docs/relay-web-module.md、docs/control-module.md。

## 目标 (Goal)

在 relay-web 看板里,给选中的会话开一个**真·交互式终端**,直连实例机器上的 shell,字节流经现有 relay 链路实时双向传输。前端用 `ghostty-web` 渲染。

## 背景与动机

relay-web 当前能管理会话、看流式对话、浏览工作空间文件,但没有「直接在实例机器上敲命令」的能力。终端补上这块,让远程运维/排查不必绕 agent。

终端此前在 HAPI 借鉴批次里被显式 deferred,理由是「需 connector PTY/fs RPC + 安全模型,HAPI 自身 fail-open 不可照抄」。本 spec 正是来解这两点。

## 关键决策(脑暴结论)

| 维度 | 决策 |
|---|---|
| **传输** | 方案 C:混合双向。低频控制走 RPC,高频按键/输出走「`/ws` 上行 + 网关 event」的有序快速路。**否决**了 POST/键(乱序+粘贴风暴)和新开 `/terminal` WS(不必要)。 |
| **v1 范围** | 最小可用(刷新即丢、无回放、无重连),**但预留 v2 缝**(terminalId 服务端生成、输出带 seq)。 |
| **安全姿态** | 默认关 + 显式开启(`terminal.enabled` 默认 false)。 |
| **归属** | 挂在选中会话,cwd=会话 workspace;terminalId 按 (instance, sessionAlias) 索引。 |
| **前端组件** | `ghostty-web`(v0.4.0,MIT,~400KB WASM,xterm API 兼容),包一层薄 adapter,addon 缺口可退回 xterm。 |
| **平台** | v1 仅 macOS/Linux(node-pty helper 在 win32 返回 null)。 |

## 架构与数据流

沿用 relay 现有的两条 WS 腿(浏览器↔hub 的 `/ws`、hub↔连接器的实例网关),不新开 socket。把高频按键和低频控制分两条路:

**低频控制(走现有 RPC 代理,要响应):**
- `control.terminal.create {sessionAlias, cols, rows}` → 返回 `{terminalId}`(服务端生成)。在实例上 spawn PTY。

**高频/有序(走快速双向路,fire-and-forget,不撞 120s 超时):**
- 上行:`terminal-input`、`terminal-resize`、`terminal-close`
- 下行:`terminal-output`、`terminal-exit`

```
按键 / resize:
  浏览器 ghostty ──(/ws 上行帧, 新)──▶ hub ──(网关 event 帧, 新)──▶ 连接器 ──▶ TerminalService.pty.write()
                     ↑ cookie 身份 + 账号-instance 归属校验   ↑ kind=event 无 timer        ↑ 路由 inbound event

输出 / 退出:
  PTY.onData ──▶ TerminalService ──(ControlEvent terminal-output)──▶ 连接器 ──instance.event──▶ hub ──web 广播──▶ 浏览器 ghostty.write()
```

### 本设计引入的两个「第一次」(主要结构成本)

1. **`/ws` 第一次支持上行。** 今天 `WebGateway` 纯下行(只听 `close`)。新增:放宽 `WebSocketLike` 接口 + 在 `register`(cookie 已鉴权后)挂 `message` handler;入站 `terminal-*` 帧做一次「该账号是否拥有目标 instance」校验(镜像 `/api/instances/:id/rpc` 代理的归属检查)。
2. **实例网关第一次支持 hub→连接器推 event。** 今天只有连接器→hub 的 event。新增 `InstanceGateway.sendEvent(instanceId, type, payload)`(`kind=event`、**不挂 timer**,因此不受 `DEFAULT_REQUEST_TIMEOUT_MS=120s` 约束);连接器侧加 inbound-event 处理,把 `instance.terminal.input/resize/close` 路由到核心 TerminalService。

### 为什么不全走 RPC

按键若走 `POST /rpc`:多个在途 POST 到连接器可能**乱序**(终端输入乱序=灾难),保证顺序需串行化→退化成每字符一个 RTT 的卡顿;粘贴/键重复→POST 风暴(每个带完整 header+cookie 鉴权+account 查表)。走 `/ws`→网关 event 的有序单流,延迟与 HAPI(Socket.IO 双向)持平。create/close 低频留在 RPC(create 还要把 terminalId 取回)。

## 组件与文件清单

### 核心 (`src/`)
- **`src/control/terminal-service.ts`(新)** — PTY 会话管理器。`create/write/resize/close`,`Map<terminalId, PtySession>`;每会话 `onData`→发 `terminal-output`、`onExit`→发 `terminal-exit`;空闲计时器 kill;`terminal.enabled` 关时 create 抛错。
- **`src/control/control-service.ts`** — 暴露 `createTerminal/writeTerminal/resizeTerminal/closeTerminal`,事件经 ControlEventBus 上抛。
- **`src/control/control-event-bus.ts`** — 新 ControlEvent 变体 `terminal-output` / `terminal-exit`。注意:control 路径需穿 command-router + handlers + router-types 三处,只接 console-agent 会 tsc 绿但静默断链。
- **`src/transport/acpx-cli/node-pty-helper.ts`** — 复用其 spawn + win32-guard;按需抽出通用 `spawnPty`(补交互式 write + resize,现状只捕获整段输出、写死 80×24)。
- **`src/config/types.ts` + `config-store.ts`** — 新增 `terminal?: { enabled: boolean; idleTimeoutSeconds?: number }`(`enabled` 默认 false),照 workspaces/agents 的 JSON-patch 持久化范式。

### 协议 (`packages/relay-protocol/src/`)
- **`messages.ts`** — `MSG.terminalCreate = "control.terminal.create"`(走 RPC 代理白名单)。
- **`dtos.ts`** — `ControlEventDto` 加 `terminal-output { terminalId; seq; data }` / `terminal-exit { terminalId; code }`(`seq` 单调,为 v2 scrollback 预留)。
- **`web-dtos.ts`** — 把两个新事件加进 `CONTROL_EVENT_TYPES` + `validControlEvent`(web 端闸门);**新增上行 web→hub 帧类型** `terminal-input { instanceId; terminalId; data }` / `terminal-resize { instanceId; terminalId; cols; rows }` / `terminal-close { instanceId; terminalId }`(`/ws` 第一次有入站)。
- **网关下行 event 类型** `instance.terminal.input/resize/close`(hub→连接器,第一次)。

> 改 SessionDto/协议 DTO 后须重建 protocol dist(`tsc` 构建,不能用 bun build 的桶文件——会被 tree-shake 成空导出运行时崩)。

### 连接器 (`packages/channel-relay/src/`)
- **`control-bridge.ts`** — dispatch `control.terminal.create`;订阅 `terminal-output/exit` 上抛;**新增 inbound-event 处理**把 `instance.terminal.*` 路由到核心 TerminalService(经 plugin-api 接缝)。
- **plugin-api** — 补对应方法签名。

### Hub (`packages/relay/src/`)
- **`gateway/instance-gateway.ts`** — 加 `sendEvent(instanceId, type, payload)`(`kind=event`,不挂 timer)。
- **`gateway/web-gateway.ts`** — 放宽 `WebSocketLike` + 入站 `message` handler。
- **`server.ts`** — 接线:`/ws` 入站 `terminal-*` 帧 → 校验账号拥有该 instance → `gateway.sendEvent`;`terminal-output/exit` 直接 web 广播,**绕开 turn 累积器**(不受 `MAX_TOOL_STEPS` 截断 / `turn-finished` flush)。
- **`http/app.ts`** — `control.terminal.create` 已被 `control.*` 白名单放行;因带 `sessionAlias`,加进 `CHAT_SCOPED_TYPES` 让服务端盖 `chatKey/senderId/isOwner`。

### relay-web (`packages/relay-web/src/`)
- **`lib/terminal-adapter.ts`(新)** — 薄封装,暴露 `open/write/onData/resize/dispose`,内部用 `ghostty-web`;ghostty addon 缺口卡住时可换回 `@xterm/xterm`,不锁死。
- **`components/TerminalTab.vue`(新)** — 挂载 adapter;ResizeObserver→算 cols/rows→`resize`;`onData`→`input`。
- **`stores/terminal.ts`(新)** — `create/input/resize/close` + 消费 `terminal-output/exit` 写进 ghostty。
- **右栏 `Tasks|Files` 切换处** — 加 `Terminal` tab。
- **`api/events.ts`** — `/ws` 客户端加上行 `send` 能力(今天只收)。
- **`package.json` + 根 `package-lock.json`** — 加 `ghostty-web` 依赖,**必须 `npm install --package-lock-only` 同步根 lock**(否则 CI `npm ci` 在 Install 步挂 "Missing ghostty-web from lock file")。
- **i18n `en.ts` + `zh-CN.ts`** — 新文案两份同步(`i18n-parity.test.ts` 会断言 key 集合一致且无空值)。

## 安全模型

指导思想:**信任边界就是 hub 登录态**——而 hub 登录态本来就能 prompt agent、agent 跑工具即任意代码执行,故终端不引入新信任边界,只是更直接。因此**不做命令/路径白名单**(交互 shell 总能绕),力气花在「默认关、身份隔离、不泄密、不泄漏资源」。

1. **默认关 + 显式开启(命门)**:`terminal.enabled` 默认 `false`;`createTerminal` 首查此位,关则抛 `terminal-disabled`,连 PTY 都不 spawn。文档明确开启=授予「凭 hub 登录态在本机开 shell」的能力。要在运行时**关闭**终端,须将 `terminal.enabled` 置为 `false`(覆写现有 key);**不能**靠删除整个 `terminal` 块来关闭——`replaceRuntimeConfig` 内部用 `Object.assign` 合并,不会删 key,旧的 `enabled: true` 会保留到重启。
2. **身份隔离(复用现成盖章)**:上行 `terminal-*` 帧在 hub 校验「该 cookie 账号是否拥有目标 instance」(镜像 `/rpc` 代理),不通过即丢;`terminalId` 按 instance 命名空间。**不照抄 HAPI 的 fail-open**(HAPI 的 resize/write 不复检会话权限、多 socket 可覆盖劫持)。
3. **不泄密(env 脱敏)**:spawn env 剔除已知密钥(`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`XACPX_*` 凭证等,集中 `SENSITIVE_ENV_KEYS`),注入 `TERM=xterm-256color`、`LANG`。**残余风险如实标注**:shell 仍能读磁盘上的 `~/.ssh`、`~/.aws` 等文件——env 脱敏挡不住主动读文件,这是交互 shell 固有属性,不假装能防。
4. **不泄漏资源(生命周期硬约束)**:v1 的回收路径有三条:(a) web 端 teardown 显式发 `terminal-close`(切换会话/tab 关闭/组件 unmount);(b) 空闲计时器——`idleTimeoutSeconds`(默认 900s)无**用户输入**(write/resize)自动 kill + 发 `terminal-exit`(PTY 输出不重置计时器，因此 `top`/`tail -f` 等持续输出的进程在无交互时仍会被回收);(c) daemon 全量关闭时 `disposeAll`。**v1 未实现**:浏览器仅刷新/关标签页而不触发 teardown 时,PTY 会留活直到空闲超时命中。hub `/ws` 断开后触发核心清理、连接器链路丢失后 dispose 所有 PTY 留作 **v2**(随重连保活一并实现)。
5. **审计(轻量)**:best-effort 记 create/close/idle-kill(instanceId、sessionAlias、accountId)到 `app.log`,v1 不做独立审计表。

**明确不做(YAGNI)**:命令白名单、路径沙箱/chroot、只读模式、资源配额。理由统一为「交互 shell 本质可绕,做了是虚假安全感」;若将来要给非 owner 开放,另起 spec。

## 生命周期 (v1)

1. 选中会话 → 点右栏 `Terminal` tab → `TerminalTab` 测量尺寸 → `control.terminal.create {sessionAlias, cols, rows}`(RPC)。
2. 核心 spawn PTY,返回服务端生成的 `terminalId`;store 存,ghostty `open()`。
3. 打字 → ghostty `onData` → `terminal-input` 帧;PTY 回显 → `terminal-output` 事件 → ghostty `write`。
4. 容器 resize → ResizeObserver → 重算 cols/rows → `terminal-resize` 帧。
5. 关闭(v1 已实现路径):切走会话 / 关 tab / 组件 unmount → teardown 发 `terminal-close`;空闲 15min 无用户输入 → idle timer kill PTY + `terminal-exit`;daemon 关闭 → `disposeAll`。**v1 未实现**:浏览器直接关标签或刷新不触发 teardown,PTY 留活至空闲超时;`/ws` 断开触发核心清理 + 连接器离线 dispose 为 v2。

## v2 预留缝(v1 只埋不实现)

- `terminalId` 服务端生成、`terminal-output` 带单调 `seq` → v2 hub 加环形缓冲按 seq 去重/回放。
- v2 把「`/ws` 断开即 kill」改成「保活待重连」:PTY 在浏览器断开后不立即死,等独立 detached-timeout;前端凭 `terminalId` re-attach,hub 回放缓冲。v1 create 不绑死「每 attach 新建」,为此留口。
- 多 viewer 共享同一终端:v1 不做;terminalId 按 (instance,sessionAlias) 索引天然允许 v2 同会话多 viewer attach 同一 PTY。

## 错误处理

- `terminal.enabled=false` → `terminal-disabled`,前端提示「在实例 config 开启 `terminal.enabled`」。
- Windows 实例 → `terminal-unsupported-platform`,前端明示 v1 仅 mac/Linux。
- 实例离线 → create RPC 走现有 503;前端显示「实例离线」。
- cwd 不存在 → **v1 未做校验/回退**:node-pty spawn 失败会抛错,经 Fix 1/Fix 3 后前端显示通用错误提示(`terminal.error`);cwd 校验存在 + 回退默认目录 + notice 延迟至 v2。
- ghostty-web WASM 加载失败 / addon 缺口 → adapter 捕获,tab 显示降级提示;开发期评估是否切 xterm。
- **输出洪流**(`cat 大文件`):v1 直通;`terminal-output` 在连接器侧 ~16ms 合帧 + 单帧上限(如 64KB,超出截断标记)防 web 帧风暴。**明确记一笔**:v1 不做完整背压,洪流下可能丢尾部输出——不假装无损。
- **pre-terminalId 早期事件被丢弃(比 output 更广)**:前端按 `id === terminalId` 过滤下行帧,而 `terminalId` 在 create RPC 返回前始终为空,因此 create 解析前到达的 `terminal-output` **和** `terminal-exit`（shell 极速退出时）都会被静默丢弃——tab 可能维持"打开"外观但永无输出。这是 v1 已知限制;v2 修法为基于 `seq` 的缓冲/重放,暂存「等待中那个终端」的早期帧。

## 测试

- **核心**:`terminal-service.test.ts`——create 用脱敏 env+正确 cwd spawn(mock node-pty)、input 写入、resize、close kill、`enabled=false` 拒绝、空闲超时 kill、win32 拒绝。
- **协议**:新 DTO 变体 parse/validate + `validControlEvent` 闸门 + 上行 `terminal-*` 帧校验。
- **连接器**:control-bridge dispatch create + inbound `instance.terminal.input` 路由(参照现有 bridge-dispatch Set-membership 回归测试范式,tsc 抓不住掉一个 Set 条目)。
- **Hub**:`gateway.sendEvent` 下行无 timer、`/ws` 入站帧 parse + instance 归属校验(含越权拒绝用例)、`terminal-output` web 广播绕开累积器。
- **relay-web**:terminal store + adapter(mock ghostty)+ TerminalTab 挂载;`npx vitest run`(不能 bun test:缺 jsdom 会假失败)。
- **e2e**:扩 `web-dashboard-e2e.test.ts`,用 echo PTY 假桩跑通「按键→/ws→网关 event→连接器→PTY→输出事件→web」全链路。
- **手工 smoke**:真 relay + 真 PTY 开 shell、`ls`/`vim`/`top`、resize、空闲超时(沙箱全栈联调:连接器是 plugin home 安装副本,需重打包+重装+重启 console;嵌套 `node_modules/@ganglion/...relay-protocol` 会遮蔽刷新副本,需 `rm -rf` 让其回退)。

## 范围边界

- v1 不含:scrollback/回放、重连保活、多 viewer 共享、Windows、命令/路径沙箱、资源配额、独立审计表。这些或入 v2,或入后续 spec。
- v1 含:单 shell、实时双向、ghostty-web 渲染、默认关开关、env 脱敏、空闲超时、右栏 Terminal tab。
