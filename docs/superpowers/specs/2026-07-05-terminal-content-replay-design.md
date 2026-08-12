# 终端内容 replay(第 3 层)设计

> **兼容背景（非权威）**：对 RMUX backend，raw ring-buffer replay 已被
> [`2026-08-10-relay-web-rmux-terminal-design.md`](./2026-08-10-relay-web-rmux-terminal-design.md)
> 的 recovery rebase 取代。本文「显式 close 才 kill、unmount 不 kill」的用户动作区分仍适用。

> 状态:待实现。四包改动(relay-protocol / core / channel-relay / relay-web)。目标:web 刷新后恢复终端 scrollback 并接回同一个 live shell。

## 目标

浏览器刷新/崩溃重载后,终端 tab 不再新开空 shell,而是:恢复刷新前的 scrollback,并**接回同一个仍在运行的 PTY**(shell 的 cwd、环境、跑到一半的进程都还在)。

## 非目标 / 边界

- 不做客户端保留态的增量续传(客户端 ghostty scrollback 在刷新时清空,无保留态)——attach 一次性回放整段 ring buffer。
- 不改 output 的广播路由(仍按账号广播 + 前端按 terminalId 过滤);只有 **replay buffer** 走点对点 RPC 响应。
- 不改 idle 回收策略(仍 900s、只被 write/resize 重置);不新增"web 断连驱动的回收"(跨层管线,YAGNI)。
- 不做多客户端并发 attach 的特殊处理(v1 单活动客户端假设)。

## 依赖的既有事实(锚定)

- 终端 RPC:`control.terminal.create` 是**点对点 RPC**(有响应);`terminal-input/resize/close` 是 fire-and-forget 的 `web.client` 上行事件。
- `terminal-output` 事件:`{ type, terminalId, seq, data }`,**按账号广播**(`web-gateway.ts` broadcast),前端 `if(id===terminalId)` 过滤;`seq` 携带但**当前无人消费**(前端 `terminal.ts` 回调丢弃 seq)。
- `TerminalService.Session = { handle, seq, idleTimer }`——**无输出缓冲**;`onData` emit 即弃;idle 只被 write/resize 重置。
- 前端 `terminalId` 是 `TerminalTab.vue` 组件局部 `let terminalId`,**不落盘**;`onBeforeUnmount → teardown → terminals.close()` **杀 PTY**(刷新即杀是这里造成的)。
- 第 1+2 层已落地:恢复的终端 tab `autostart=false` → 显"启动新终端"占位;center-tabs `closeTab`/`clearSession` 是"显式关闭"信号(已用于清文件草稿)。
- relay-protocol 用 **tsc**(非 bun)构建 dist(`export *` 桶文件会被 bun tree-shake 成空)。

## 架构总览

新增一条点对点 RPC `control.terminal.attach`,配后端 per-PTY ring buffer。刷新恢复路径:

```
web 刷新 → TerminalTab 挂载 → 有持久化 terminalId?
  是 → store.attach(instanceId, id) → RPC control.terminal.attach {terminalId}
        → connector control-bridge(新 case) → control.attachTerminal(id)
        → TerminalService.attach(id):
             PTY 活 → { ok:true, buffer, lastSeq }（并 resetIdle）
             PTY 无 → { ok:false }
      ← 点对点 RPC 响应回发起 tab
      ok  → 灌 buffer 进 ghostty + 订阅 live(丢弃 seq≤lastSeq)+ 进 open
      !ok → clearTerminalId + 回落第 1+2 层占位
  否 → 现状(autostart→create / 非 autostart→占位)
```

`seq` 的用途:解决 attach 快照与 live 订阅之间的边界(重叠/遗漏)——attach 返回快照时的 `lastSeq`,客户端丢弃 seq≤lastSeq 的 live 事件去重。

## 单元设计

### 单元 1 — 后端 ring buffer + attach(`src/control/terminal-service.ts`)

- `Session` 加缓冲:`{ handle, seq, idleTimer, buffer: string, bufBytes: number }`。
- `onData` 回调:在既有 `events.emit(...)` **之外**,`session.buffer += data; session.bufBytes += byteLen(data)`;若 `bufBytes > 256*1024`,从 buffer **最旧的 `\n` 行边界**起裁剪直到 ≤256KB(按行边界裁,避免从半截 ANSI 转义序列中间切开导致回放渲染错乱;若单行本身超限则退化为按字节硬裁)。`seq` 自增逻辑不变。
- `TerminalService` interface 加:`attach(terminalId: string): TerminalAttachResult`。
- `attach` 实现:`const s = sessions.get(terminalId); if (!s) return { ok: false }; resetIdle(terminalId); return { ok: true, buffer: s.buffer, lastSeq: s.seq - 1 }`（`seq` 是"下一个要发的"计数,已发出的最后一个是 `seq-1`;若从未 emit 过则 lastSeq 可为 -1,客户端不丢任何 live 事件——正确)。
- `close`/`disposeAll`/idle 回收:**不变**(显式关闭 + daemon 关停 + idle 超时仍杀;后端无"刷新即杀")。session 删除时 buffer 随之释放。

**类型**:`TerminalAttachResult = { ok: false } | { ok: true; buffer: string; lastSeq: number }`(在 protocol 定义,core 复用或结构对齐)。

### 单元 2 — control 门面(`src/control/control-service.ts`)

- 加 `attachTerminal(terminalId: string): TerminalAttachResult`:仿 `writeTerminal` 那批纯转发——`if (!this.deps.terminalEnabled()) throw new Error("terminal-disabled"); return this.deps.terminal.attach(terminalId);`。不做 session 解析(attach 只认 terminalId)。
- `ControlServiceDeps.terminal` 类型加 `attach`。

### 单元 3 — 协议(`packages/relay-protocol/src/`)

- `messages.ts`:`MSG` 加 `terminalAttach: "control.terminal.attach"`。
- 新类型:`TerminalAttachRequest = { terminalId: string }`;`TerminalAttachResult = { ok: false } | { ok: true; buffer: string; lastSeq: number }`。放在终端相关 DTO 处并从桶文件导出。
- **构建**:改完 `bun run` 相关 relay-protocol 的 tsc 构建、重生成 dist,`assert:relay-protocol` 验运行时导出非空(桶空导出坑)。

### 单元 4 — 连接器(`packages/channel-relay/src/control-bridge.ts`)

- `handleControlRpc` 的 switch(create case 附近)加 `case MSG.terminalAttach:`——校验 `terminalId` 为字符串 → `await control.attachTerminal(terminalId)` → 返回结果对象(走 create 同款点对点 RPC 响应)。
- input/resize/close 下行通道、terminal-output 上行广播:**不动**。
- **沙箱连接器坑**:连接器改动要重打包 + 重装插件目录 + 重启 console 才生效(否则改了 dist 不生效——native tab/定时派发都踩过)。

### 单元 5 — hub(`packages/relay`)

- attach 走既有 create 的 RPC 转发路径,**预期零改动**;若存在按 message 名的显式 RPC 白名单/路由表,补 `terminalAttach` 一条。web→hub 用现成 RPC 通道则 `web-inbound` 无需加 case。实现时对照 create 的端到端路径确认 attach 能发/能收/能回。

### 单元 6 — 前端 store(`packages/relay-web/src/stores/terminal.ts`)

- 加 `attach(instanceId, terminalId): Promise<TerminalAttachResult>` → `api.rpc(instanceId, "control.terminal.attach", { terminalId })`。
- `applyEvent` 的 `terminal-output` 分支**接住 seq**:`onOutput` 回调签名 `(terminalId, data)` → `(terminalId, data, seq)`;`applyEvent` 传入 `event.seq`。`onExit` 不变。

### 单元 7 — 前端持久化(`packages/relay-web/src/lib/terminal-sessions.ts`,新建)

仿 `lib/file-drafts.ts` 结构,sessionStorage `xacpx.terminal-ids.v1`,按 `sessionKey`(`instanceId::alias`)存 `terminalId`:
- `saveTerminalId(sessionKey: string, id: string): void`
- `loadTerminalId(sessionKey: string): string | null`
- `clearTerminalId(sessionKey: string): void`
- read/write try/catch 兜底,写失败静默(配额)。

### 单元 8 — 前端组件(`packages/relay-web/src/components/TerminalTab.vue` + `DashboardView.vue`)

**挂载决策**(取代当前简单的 autostart 二分):
1. `loadTerminalId(sessionKey)` 有值 → `await terminals.attach(instanceId, id)`:
   - `ok` → adapter.write(buffer) 灌 scrollback;订阅 onOutput(**丢弃 seq ≤ lastSeq**);status 直接 open;`started=true`。无缝接回。
   - `!ok` → `clearTerminalId(sessionKey)` → 走占位(showPlaceholder)。
2. 无持久化 id 且 `autostart` → 现有 `start()` 新建;create 成功后 `saveTerminalId(sessionKey, terminalId)`。
3. 无 id 且非 autostart → 占位(现状)。

**seq 去重 + attach handoff 排序(避免乱序/丢事件)**:必须**先订阅 live、再发 attach**——否则快照与订阅之间的 emit 会漏。但订阅早了 live 会在 buffer 灌入前乱序写。正确顺序:
1. 订阅 `onOutput`,进入**排队模式**:incoming `(id,data,seq)`(id 匹配)先推入本地 `pending[]`,不直接写 adapter。
2. 发 `terminals.attach(...)`。
3. attach `ok` 返回后:先 `adapter.write(buffer)` 灌 scrollback;再把 `pending` 里 `seq > lastSeq` 的按序 `adapter.write`(≤lastSeq 的丢弃,已含在 buffer);清空 pending;切**直写模式**(后续 onOutput 直接 write,仍 `if(id===terminalId)` 过滤)。
4. attach `!ok`:丢弃 pending、注销回调、回落占位。

新建/placeholder-start 路径无 attach、无排队,onOutput 直写(与现状一致)。组件持有一个 `attaching` 标志与 `pending` 数组表达排队模式。

**生命周期(关键改动):**
- `start()` create 成功 → `saveTerminalId(sessionKey, terminalId)`。
- **`onBeforeUnmount` / `teardown` 不再杀 PTY**:只做前端资源释放(dispose adapter、注销回调、清 resizeObserver)。**移除** teardown 里的 `terminals.close(terminalId)`。
- **显式关闭才杀 + 清 id**:
  - close 按钮 emit `close` → DashboardView 关闭该终端 tab 的路径里,显式 `terminals.close(instanceId, terminalId)` + `clearTerminalId(sessionKey)`。
  - center-tabs 关终端 tab / `clearSession`(session 被剪)时,像清文件草稿那样,对终端 tab 一并 `terminals.close` + `clearTerminalId`。因 store 无 instanceId/terminalId 上下文,close 的触发点放在 DashboardView 的关闭处理(它有 key→instanceId + 能读持久化 id),而非 center-tabs store 内部。
- **sessionKey**:给 TerminalTab 传 `:session-key`(DashboardView v-for 的 `key`,与第 1+2 层 FileViewer 一致),或组件用 `instanceId`+`sessionAlias` 自拼。

## 错误处理

- attach RPC 失败/超时 → 当作 `{ok:false}` 处理:清 id、回落占位,不崩、不卡。
- ring buffer 裁剪:单行超 256KB 的极端 → 退化按字节硬裁(可能顶部一行有渲染瑕疵,可接受)。
- sessionStorage 读写:try/catch 吞异常,写失败静默降级(功能退化为"不接回",回落占位)。
- PTY 在 attach 前刚 exit(竞态)→ `sessions.get` 落空 → `{ok:false}` → 占位。正确。

## 测试策略

- **core**(bun,单文件 `bun test tests/unit/control/terminal-service.test.ts`):onData 累积;超 256KB 从最旧 `\n` 裁剪(断言不切转义序列);`attach` 存在返 `{ok,buffer,lastSeq}`+resetIdle、不存在返 `{ok:false}`、close 后返 `{ok:false}`;lastSeq = seq-1 语义(含从未 emit 时 -1)。`control-service` attachTerminal gate + 转发。
- **protocol**:`terminalAttach` 名/类型;重建 dist + `assert:relay-protocol` 运行时导出非空。
- **connector**:control-bridge attach RPC case 转发(需 fresh dist;改后重打包重装插件重启)。
- **relay-web**(`cd packages/relay-web && npx vitest run`,**非 bun**):`terminal-sessions.ts` round-trip/容错/配额;store `attach` + `applyEvent` 接住 seq;TerminalTab 挂载三分支(attach ok 灌 buffer+去重、!ok 回落占位、无 id autostart 新建);生命周期——刷新卸载**不** close、显式关闭才 close+clear（mock `terminals.close` 断言时机);seq 去重(lastSeq=N → live seq≤N 丢、>N 渲染)。mock `ghostty-web`。
- 类型:core `npx tsc --noEmit`;relay-web `npx vue-tsc --noEmit`。i18n 若增键过 parity。

## 交付与发布

- 四包:relay-protocol(加 RPC)、core(ring buffer + attach + control 门面)、channel-relay(转发 case)、relay-web(持久化 + attach 流 + 生命周期)。
- 发布顺序(收尾阶段按 runbook):protocol(锁 0.1.x 保 ^0.1.0)→ core → channel-relay → relay(hub)。core 版本耦合:`tests/unit/packages/package-metadata.test.ts` 硬编码版本 + `weacpx-compat` shim 镜像 root.version。`npm install --package-lock-only` 同步 lock。
- **可与已在 main 的 Windows 支持批在一起发 core beta**(用户已同意批发)。
- 实机验收:开终端跑输出 → 硬刷新 → scrollback 恢复且**接回同一 shell**(不是空的)、跑到一半的进程还在;关 tab → PTY 真被杀不泄漏;>15min idle 回收后刷新 → attach 不到 → 回落"启动新终端"占位;seq 去重无重复/丢行。
