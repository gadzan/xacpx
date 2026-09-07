# relay-web 回合 trace 折叠（zcode 式「结束即收起中间过程」）

日期：2026-09-07
状态：已定稿，随实现微调

## 背景与目标

参照 zcode 的会话气泡：回合进行中，思考/工具等中间过程以弱化单行 chip 内联展开；回合结束后整个 trace 折叠进一条回合头部（「已工作 5 分 5 秒 ›」），正文直接呈现。

relay-web 现状：`turn-finished` 后 live turn 经 `flushTurn` 定型为历史消息，`TurnParts` 原样渲染全部 parts——推理面板、工具卡、子代理卡永远内联常驻，长回合把最终回复淹没。回合耗时只存在于输入框上方的 HUD（`ChatPane` `turn-hud`），回合结束即消失。

目标：**回合结束后默认折叠 trace**，收进一条回合头部；用户可展开。正文（text）与已发出的 peer 消息卡（agent-message）永不折叠。

**触发信号（已用真实流验证）**：ACP 回合边界 = `session/prompt` 的 JSON-RPC response（`{"result":{"stopReason":"end_turn",…}}`，实际值为 snake_case `end_turn`）。xacpx 管线里它的等价物就是 `turn-finished` 控制事件（`src/control/session-turn-runner.ts` 在 `agent.chat()` resolve 后发出，带 `ok/cancelled/errorMessage`）——web 端在该事件定型消息的瞬间折叠，零协议改动。

## 非目标

- **不改协议**：relay-protocol / relay hub / connector 零改动。`stopReason` 端到端透传（区分 `max_tokens` 截断不折叠等）是后续增强，链路见文末。
- 不改 live（streaming）行渲染：进行中回合照旧内联展开 + HUD 计时（zcode 进行中也是展开的）。
- legacy 历史行（无 `parts`，走 `ToolCallPanel` + `ReasoningPanel` fallback）不涉及：两组件本来就默认折叠。
- 不做相邻 read/search 工具聚合（「查阅 · 1 搜索, 1 列表」，P2）。
- 不做 reasoning chip 时长 / 工具行 diffstat（P1）。
- 不做全局「新回合默认折叠」的设置项。

## 方案取舍

- **折叠是纯视图状态，放演示层（TurnParts），不动 store/wire 数据**。`structured.parts` 是不可变传输数据，hub 历史收敛（`keepRicherStructured`）会整行替换消息对象，任何写进 store 的折叠状态都会被冲掉或引出同步负担。
- **头部固定在回合顶部**（zcode 一致），不是第一个 trace 项的位置——回合常以正文开头，按 trace 位置插头部会把头部夹在两段正文中间。
- **error 行永不折叠**：红色失败 ring 与错误卡片必须显眼；cancelled 行折叠（与 done 一致，内容一键可展开）。
- **手动展开状态放模块级 `Set<string>`，key = `traceKey`**，不用组件局部 ref：`turn-finished` 后 hub 历史收敛替换消息行，组件会被重建，局部状态必丢。`traceKey` 用持久行 `id:<n>`、乐观行 `t:<startedAt>`——flush 行与持久行的 `startedAt` 同源（都是 connector 在 turn-start 盖的戳，hub 存 `started_at` 列并回传 `MessageRecordDto.startedAt`），跨收敛稳定。
- **纯 v-show/v-if 切换，无过渡动画**：省掉 `prefers-reduced-motion` 分支；行高变化由既有的 `content-visibility` 虚拟化和 tail-follow watcher 自然消化。

## 组件设计

### `TurnParts.vue`（唯一改动的渲染组件）

新增 props（全部可选，现有调用点零破坏）：

```ts
collapseTrace?: boolean      // true = 回合已结束且允许折叠（policy 由调用方算）
traceKey?: string            // 展开状态的持久 key；缺省时每次渲染都折叠
traceElapsedMs?: number | null  // 回合耗时（展示用；null/undefined = 只显示计数）
```

行为：

- `collapseTrace` 为假（含 live 行不传）→ **现状行为**，无头部、全部内联。
- 为真且 presentation 中存在 trace 项（`reasoning`/`tool`/`subagent`）→ 顶部渲染折叠头：

  ```
  ▸ 已工作 4分32秒 · 6 步工具 · 3 段思考     ← en: "Worked 4m 32s · 6 tool steps · 3 thoughts"
  ```

  - 计数：tool+subagent 卡数为「步工具」，reasoning 段数为「段思考」；为 0 的段省略。
  - 耗时：`traceElapsedMs` 格式化为 `m分s秒` / `m m s s`（<1s 显示 `<1s`）；缺失时头部只有计数。
  - 无 trace 项（纯文本回复）→ 不渲染头部，与现状一致。
- **折叠态**：trace 项全部不渲染，只保留 text / agent-message 项（保持其在 parts 中的相对顺序）。
- **展开态**：头部 chevron 翻转，trace 项按原顺序内联渲染（`ensure-full`、subagent 卡、`streaming` 锚定等行为不变——live 才传 `streaming`，finished 行本就不传）。
- 展开状态：模块级 `const expandedTraces = new Set<string>()`；`traceKey` 存在时 toggle 增删；无 `traceKey` 的行不可记忆（始终折叠）。头部 `<button>` 带 `aria-expanded` 与 `data-test="trace-toggle"`。
- 头部样式：无边框弱化行（`text-fg-muted text-[11.5px]`），与 zcode 的低调头部对齐；整行可点。

### `MessageList.vue`（policy 计算与 props 装配）

仅 assistant 历史行的 `TurnParts` 调用点（`msg-content` 内，现 `:parts="m.structured.parts"` 一处）传新 props；live 行的三个调用点不动：

```ts
// script:
const hasTrace = (m: ChatMessage): boolean => {
  const parts = m.structured?.parts ?? [];
  return parts.some((p) => p.type !== "text" && p.type !== "agent-message");
};
const traceKeyOf = (m: ChatMessage): string =>
  m.id !== undefined ? `id:${m.id}` : m.startedAt !== undefined ? `t:${m.startedAt}` : "";
const traceElapsedOf = (m: ChatMessage): number | null => {
  if (m.startedAt === undefined) return null;
  const ms = Date.parse(m.createdAt) - m.startedAt;
  return Number.isFinite(ms) && ms > 0 ? ms : null;   // 跨机时钟偏差 → clamp 成 null
};
```

- `:collapse-trace="!m.failed && hasTrace(m)"`（failed 行永不折叠）。
- `:trace-key="traceKeyOf(m)"`、`:trace-elapsed-ms="traceElapsedOf(m)"`。

耗时口径：`createdAt`（乐观行=浏览器时钟 / 持久行=hub 时钟）减 `startedAt`（connector 时钟）。同机部署近似精确；跨机有时钟偏差，只作展示、偏差过大（负值）时降级为只显计数。精确耗时若将来要保证，需 hub 落 `durationMs` 列，不在本期。

### 数据流不变

`turn-finished` → `flushTurn` 定型（行带 `startedAt`/`createdAt`/`structured.parts`）→ `streaming` prop 消失 → 折叠即时生效；随后 hub 历史收敛整行替换，`traceKey` 从乐观 `t:` 切到持久 `id:` —— 已记录的展开状态会丢一次（`Set` 里是 `t:` 键，替换后查 `id:` 键不中）。接受：收敛发生在回合结束的亚秒级窗口内，用户此时还没来得及点开；不做双键迁移的复杂度。

## i18n（`en.ts` + `zh-CN.ts` 镜像，parity 测试强制）

```ts
turnTrace: {
  worked: "Worked",            // 已工作
  tools: "{n} tool steps",     // {n} 步工具
  thoughts: "{n} thoughts",    // {n} 段思考
  toggleTrace: "Toggle intermediate steps",  // aria-label：展开/收起中间过程
},
```

时长格式不走 i18n（`4:32` → `4分32秒` / `4m 32s` 在组件内按 locale 分支，与 `ChatPane` HUD 的 mm:ss 同级别近似；如 parity 不允许硬分支则退化为 `fmtDuration` 现有秒格式）。

## 测试

`packages/relay-web/src/__tests__/turnparts-collapse.test.ts`（新，mount TurnParts）：

1. `collapseTrace` 缺省/live：trace 项内联、无头部（回归确认）。
2. finished + trace 存在：头部渲染且含计数，trace 项不在 DOM；text 项保留。
3. 点头部展开：trace 项出现、`aria-expanded=true`；再点收起。
4. 同 `traceKey` 重挂载（模拟行替换）：展开状态保持；不同 key 不串。
5. 纯 text 行：无头部。
6. `traceElapsedMs` 传/不传：头部带/不带耗时段。
7. zh/en 文案分支冒烟（设置 locale 后断言头部文本）。

`messagelist.test.ts` 补一条：failed 行 `collapseTrace=false`、done 行 `=true`（可通过 DOM 断言头部有无）。

`i18n-parity.test.ts` 自动覆盖新 key。

## 文档

- `docs/relay-web-module.md`：「阶段六」之后补「回合 trace 折叠」小节（行为、traceKey 策略、error 不折叠）。

## 后续增强（不在本期）

- **stopReason 透传**：`streaming-prompt.ts` 捕获 response `result.stopReason`（acpx-cli 与 acpx-bridge 共用此解析器，一处改两路径；runtime 引擎 `runtime-adapter.ts` 已映射、`executeRuntimeTurn` 丢弃）→ prompt 结果带出 → `turn-finished` 加 `stopReason?` → `relay-protocol` DTO + hub 校验透传 → web。语义：`max_tokens`/`max_turns` 截断不自动折叠，头部加「已截断」徽标。
- 相邻同类工具聚合 chip（「查阅 · 1 搜索, 1 列表」）。
- reasoning chip 时长（客户端近似）、工具行 diffstat（+4 −1）。
