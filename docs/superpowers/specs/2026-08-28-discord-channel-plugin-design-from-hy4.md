# xacpx Discord 频道插件设计方案

> 状态：**评审修订版（实施基准 spec）** ｜ 日期：2026-08-28 ｜ 目标包：`packages/channel-discord` → `@ganglion/xacpx-channel-discord`
> 参考实现：`packages/channel-feishu`（xacpx 侧范式基准）、`E:\projects\openclaw\extensions\discord`（Discord 平台侧经验来源）

---

## 评审修订记录（2026-08-28）

经第三方评审 + 对当前 HEAD 的代码核验，本方案做如下修正。正文已同步更新，下文标注的 **F1–F7** 为修正点索引：

| # | 修正 | 依据 |
|---|---|---|
| **F1** | **废除 `Map<parentChatKey, threadId>` 投递绑定**。同一父频道下多个 thread 并发活跃时，后写覆盖先写；任务完成/进度/定时等异步投递只按 chatKey 寻址，会串到"最近活跃的另一个 thread"。v1 改为 **thread 恒用独立 chatKey（`t:<threadId>`）**；v2 若做父频道会话继承，须经 `task.replyContextToken`（`OrchestrationTaskRecord` 已携带，`src/orchestration/orchestration-types.ts:58`）反解投递目标，不得回退可变绑定 | 评审指出竞态；代码核验 `OrchestrationTaskRecord` 携带 `replyContextToken`，v2 路径可行 |
| **F2** | **preview 只展示生成过程；最终答案恒以新消息（MESSAGE_CREATE）发送**，短回答亦然。Discord 编辑只产生 MESSAGE_UPDATE、不推未读，而 xacpx 的 turn 是分钟级，用户通常已切走。这是对 openclaw `draft-stream.ts` seal 语义的**有意偏离**（其默认流式关闭、面向近实时交互，照抄 seal 属语境错位） | 评审采纳 3.8max 调研中记录的 Discord UX 事实 |
| **F3** | **token 正则不做硬门禁**。Discord token 格式有代际变化，正则硬校验会误杀合法 token。`validateConfig` 只查存在性与字符串类型；形状正则至多降为 `diagnose()` warn；真实有效性留给 `doctor --deep` 打 `GET /users/@me` | 评审意见 |
| **F4** | **`nativeSessionListFormat` 由 `"table"` 改为 `"cards"`**。Discord 的 markdown 表格渲染成管道符，与 weixin 同病；跟随 weixin 先例（`weixin-channel.ts:35`）。消费点在核心 `native-session-handler.ts:145`。agent 输出中的表格另有 `tableMode` 兜底——原方案此处与 D5 自相矛盾，现已消除 | 评审指出矛盾；代码核验 weixin 先例与消费点 |
| **F5** | **OutboundQuota 约定定案：只调 `onInbound`**。当前 HEAD 核验：feishu（`channel.ts:411`）、yuanbao（`channel.ts:478`）均只用 `onInbound`；`reserveFinal/enqueuePendingFinal` 仅 weixin 内置渠道实际使用（24h 窗口是微信平台语义）+ 文档示例。Discord v1 对齐既有插件行为 | 评审要求以 HEAD 代码裁决；已核验 |
| **F6** | **`createConsumerLock()` 由"不需要"改为 P4 实现**。Discord 每 token 仅一个 Gateway 会话，同 token 双开进程互踢；weixin 有 `createWeixinConsumerLock` 先例，实现成本低。原"❌ 无互斥需求"论证不成立。**实现修订（review round 3，取代 round 2 的集合 hash）**：每个 enabled token **单独持有一个锁文件**（`discord-consumer-<sha256(token)前16位>.lock.json`，文件名不含 accountId、不落明文 token）；`createConsumerLock()` 返回复合锁，按序 acquire 全部、任一冲突回滚已持有并抛错。由此任何 token 集合交集都竞争（`{X}` 挡住 `{X,Y}`；同 token 换 accountId 亦竞争），仅完全不相交的 token 集并存。round 2 的整体集合 hash 被弃：交集/换 accountId 可绕过，且 core（`cli.ts`）恒注入 `lockFilePath` 会使 hash 文件名在生产中失效——现改为仅取注入路径的目录作锚。**实现修订（review round 4）**：per-token 锁只解决**跨进程**互斥——`createConsumerLock()` 对 token 去重后，同进程内 `{a: tok-X, b: tok-X}` 仅一把锁，但 `start()` 会逐个 eligible account 各建一个 `DiscordClient`，同进程仍起**两个 Gateway 会话**；且 base config 继承（`resolveAccount` 的 `{...base, ...override}`）使多账号漏配 token 时轻易共享同一 token。修法：在 `parseDiscordChannelConfig()` 拿到 `configuredAccounts` 后**拒绝 enabled account 间的重复 resolved token**（错误信息只列 accountId，不输出 token 或其 fingerprint），把"进程内唯一"封在配置层，锁层继续负责"跨进程互斥" | 3.8max 复核补正；round 2 评审指出全局单文件语义不符；round 3 评审指出集合 hash 在 `{X}` vs `{X,Y}` 与 accountId 重排下漏锁；round 4 评审指出 per-token 锁未覆盖同进程多账号同 token（`start()` 多建 Gateway client）|
| **F7** | **附件上限数值不写死**。以 Discord 官方现行限制为准，实施前核实；默认保守、经 `media.maxBytes` 可配置 | 两案数值（8MB/25MB）均无依据 |

---

## 0. 一句话结论

做一个**对齐 feishu 插件骨架、只吸收 openclaw 的 Discord 平台经验**的新频道插件。
openclaw 那份 4.6 万行实现里，voice / activities(embedded app sdk) / moderation / pluralkit / presence / exec-approvals / native slash command 全部**不移植**——xacpx 只需要「收消息 → 喂 agent → 把结果发回去」。

预估规模：**约 25 个源文件 / 3500–4500 行**（feishu 是 40 文件，yuanbao 是 30 文件），落在两者之间。

---

## 1. 关键决策（先给结论，理由在后）

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| D1 | Gateway SDK | **discord.js v14**，但收口在 `DiscordClientLike` 接口后面 | openclaw 自研（`ws`+`discord-api-types`+`undici`）是为 voice/sharding 服务的，xacpx 不需要；自研 resume/heartbeat/429 是 bug 温床 |
| D2 | 流式策略 | **preview 仅过程展示（edit-in-place，节流 1200ms）；最终答案恒以新消息 MESSAGE_CREATE 发送**；超 2000 字符转分片 | Discord 编辑只产生 MESSAGE_UPDATE、不推未读；xacpx turn 分钟级、用户通常已切走。有意偏离 openclaw seal 语义（见 F2） |
| D3 | chatKey | `discord:<accountId>:(dm:<dmChannelId>\|g:<channelId>\|t:<threadId>)` | 需要类型前缀消歧 Discord 的三级结构；全部是 snowflake，永久稳定。**实现修订（review round 2）**：DM 段用 DM 频道 snowflake（入站消息自带 `channelId`），不是对端 userId——出站可凭 `channels.fetch(channelId)` 直投，省去 user→DM 解析；1:1 DM 频道 snowflake 永久稳定 |
| D4 | Thread 归属 | **v1：thread 恒用独立 chatKey（`t:<threadId>`）、独立会话**，投递目标即 chatKey 本身，零绑定状态 | 旧 `Map<parentChatKey, threadId>` 设计多 thread 并发会串投递（见 F1）；v1 不做 autoThread；v2 升级路径见 §4 |
| D5 | 表格 | 新增 `tableMode`，默认 `code` | Discord 不支持 GFM 表格 |
| D6 | 安全默认 | 全局 `allowed_mentions: { parse: [] }` | 否则 agent 输出里的 `@everyone` 会真的广播 |
| D7 | `stop()` | **显式实现**，不依赖 registry 的 `logout()` 回退 | feishu 偷懒没实现，语义上是债；新插件别再欠 |
| D8 | 多账号 identify | 启动时串行 stagger ≥5s | Discord identify 限流 5s 窗口，多 Client 实例间不协调 |

---

## 2. D1：SDK 选型论证

### openclaw 为什么自研（我们不能照抄的理由）

`extensions/discord/package.json` 的依赖是 `ws` + `discord-api-types` + `undici`，**没有 discord.js**。配套自研了：

- `src/internal/gateway.ts`（1093 行测试）—— 手写 WebSocket 生命周期
- `src/internal/gateway-identify-limiter.ts` —— `IDENTIFY_WINDOW_MS = 5_000` 手写限流
- `src/internal/gateway-rate-limit.ts` —— `GATEWAY_SEND_LIMIT = 120 / 60s` 手写队列
- `src/internal/gateway-close-codes.ts` —— 手动区分 fatal / non-resumable close code
- `src/internal/rest-scheduler.ts` —— 手写 REST 429 调度

它自研是因为要 `@discordjs/voice`（语音）、`@discord/embedded-app-sdk`（Activity）、sharding、以及细粒度 presence 控制。**这些 xacpx 一个都不需要。**

### 三个候选

| 候选 | 体积 | 优点 | 缺点 |
|---|---|---|---|
| **discord.js v14.26** ✅ | ~5MB，15 个间接依赖 | resume/heartbeat/429/分页全包；Node 22.12+ 要求与 xacpx `engines.node >= 22.13` **兼容** | 包大；Collection 缓存占内存 |
| oceanic.js | ~1.7MB | 纯 ESM、TS 优先、API 贴近 Discord 原语 | 社区小，修复慢 |
| 自研 ws | 最小 | 完全可控 | 至少 2000 行基础设施，且是长期维护负担 |

### 落地约束：接口收口

无论选哪个，**连接层必须藏在 `src/discord-client.ts` 后面**，对外只暴露一个 `DiscordClientLike`：

```ts
// src/discord-client.ts
export interface DiscordClientLike {
  start(input: { handlers: { onMessage(m: DiscordInboundMessage): void }; abortSignal: AbortSignal }): Promise<void>;
  probeBot(): Promise<{ botUserId: string }>;
  sendMessage(target: DeliveryTarget, body: OutboundBody): Promise<{ messageId: string }>;
  editMessage(target: DeliveryTarget, messageId: string, body: OutboundBody): Promise<void>;
  deleteMessage(target: DeliveryTarget, messageId: string): Promise<void>;
  startTyping(channelId: string): Promise<() => void>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  destroy(): Promise<void>;
}
```

这正好复用 feishu 已有的注入点模式：`FeishuChannel` 构造函数接收 `deps.createClient?.()`（`channel.ts:166`），测试时可注入 fake client。**照抄这个模式。**

> 依赖写死在 `DiscordClientLike` 之后，将来换 oceanic.js 只改 `discord-client.ts` + `discord-client.discordjs.ts` 两个文件。

---

## 3. 包结构

严格对齐 `packages/channel-feishu/`：

```
packages/channel-discord/
├── package.json                 # name: @ganglion/xacpx-channel-discord
├── tsconfig.json                # 直接复制 feishu 的，改 rootDir/outDir
├── README.md                    # 行为文档，不是 API 文档（照 feishu README 的写法）
└── src/
    ├── index.ts                 # 默认导出 XacpxPlugin
    ├── channel.ts               # DiscordChannel implements MessageChannelRuntime
    ├── config.ts                # parseDiscordChannelConfig(raw): DiscordConfig（构造期抛错）
    ├── types.ts                 # 协议侧形状（DiscordMessageEvent / DiscordRoute / DeliveryTarget）
    ├── tuning.ts                # 扁平数字面板 + resolveDiscordTuning(partial)
    ├── discord-client.ts        # DiscordClientLike 接口 + createDiscordClient()
    ├── discord-provider.ts      # ChannelCliProvider
    ├── provider.ts              # parseBooleanFlag / takeFlagValue 的**包内副本**
    │                            # （这两个 helper 未从 xacpx/plugin-api 运行时导出，见 §13 红线）
    ├── inbound.ts               # chatKey 构造/解析、门控、mention 清洗
    ├── outbound.ts              # sendRouteText / sendReplyWithGuard
    ├── preview-stream.ts        # ⭐ 过程预览流控（核心，语义见 F2）
    ├── chunk.ts                 # ⭐ 2000 字符分片器（核心）
    ├── markdown.ts              # tableMode 转换 + 出站降级
    ├── media.ts                 # 附件下载/上传
    ├── media-store.ts           # core RuntimeMediaStore 的**包内副本**（见 §12）
    ├── media-types.ts           # core media-types 的**包内副本**
    ├── outbound-media-safety.ts # 出站路径白名单校验（安全红线）
    ├── message-dedup.ts         # messageId 去重
    ├── abort-detect.ts          # "stop"/"取消" 快路径（移植 feishu）
    ├── errors.ts                # Discord 错误分类（retryable / fatal / permission）
    └── i18n/
        ├── messages.ts          # DiscordMessages 类型契约
        ├── en.ts
        ├── zh.ts
        └── index.ts             # setChannelLocale / t()
```

> v1 **不含** `thread-bindings.ts`：thread 的投递目标已内嵌于 chatKey（`t:<threadId>`），无需额外绑定状态（见 F1）。

---

## 4. chatKey 设计（D3）

### 格式

```
discord:<accountId>:dm:<dmChannelId>  # 私聊（Discord DM 频道 snowflake）
discord:<accountId>:g:<channelId>     # 服务器文本频道（含 forum post 的父频道）
discord:<accountId>:t:<threadId>      # thread / forum post 内（v1 恒独立会话，见 D4）
```

- **实现修订（review round 2）**：DM 段为 DM 频道 snowflake（入站 DM 消息自带的 `channelId`），非对端 `userId`。出站凭 chatKey 直接 `channels.fetch` 投递，不需要 user→DM 解析；1:1 DM 频道 snowflake 永久稳定，满足持久化要求。

- 全部段都是 Discord snowflake，**永久稳定**，可安全写入 `~/.xacpx/state.json` 做 session 绑定。
- `channelId` 不含 `:`，满足 `registerChannelFactory` 的校验（`src/channels/create-channel.ts:29`）。
- 遵守 `docs/plugin-development.md` §13：`<type>:<...>` 前缀，出站必须能反解，回调里先查前缀再处理。

### 解析

```ts
// src/inbound.ts
export function buildDiscordChatKey(r: { accountId: string; route: DiscordRoute }): string;
export function parseDiscordChatKey(chatKey: string): DiscordParsedRoute | null;  // 非 discord: 前缀 → null
export function buildDiscordQueueKey(...): string;   // 同形去前缀，仅作内部 Map key（对齐 feishu chat-queue.ts:3）
```

### Thread 语义（D4，F1）

**v1：thread 恒用独立 chatKey**（`discord:<acct>:t:<threadId>`）、独立会话；投递目标就是该 thread，零状态、零竞态。

旧设计（`inheritParent: true` 时 chatKey 归父频道、另用 `Map<chatKey, threadId>` 记投递位置）**已废弃**：

- 同一父频道下两个 thread 并发活跃时，后一个 `bind()` 覆盖前一个；
- 即时回复尚可在 `runTurn` 上下文里携带投递目标，但 **task completion / progress / scheduled / coordinator 这类异步投递只按 `task.chatKey` 寻址**，会被送到"最近活跃的另一个 thread"。

**v2 升级路径**（若"thread 与父频道共享会话"成为真实需求）：`OrchestrationTaskRecord` 已携带 `replyContextToken`（`src/orchestration/orchestration-types.ts:58`，即触发任务的入站消息 id），届时维护 `messageId → threadId` 映射、按 `task.replyContextToken` 反解投递目标。**禁止**回退到 `chatKey → 最近 thread` 的可变绑定。

v1 **不做** autoThread（自动开贴）。openclaw 的 `autoThread` / `autoThreadName` / `autoArchiveDuration` 是一整套子系统，等有真实需求再说。

---

## 5. 流式输出（D2，F2）——本方案的技术核心

### 问题

Discord 没有飞书 CardKit 那种可原地更新的卡片，只有：
- 单条消息 **2000 字符硬上限**
- `PATCH /channels/{id}/messages/{mid}` 可编辑已发消息
- 编辑有频率软限（约 5 次 / 5 秒）

另一个决定本方案语义的 Discord 特有事实：**编辑只产生 MESSAGE_UPDATE 事件，不产生未读提醒/推送**。而 xacpx 的 turn 是分钟级编码任务，用户大概率已经切走——如果把过程预览 seal 成最终答案，用户可能根本注意不到回答已经完成。

### 语义：预览只是过程，交付永远是新消息

**preview 仅作为生成过程的视觉反馈；最终答案恒以 MESSAGE_CREATE 新发——短回答也一样。**

这是对 openclaw `draft-stream.ts` 的**有意偏离**：openclaw 在最终文本 ≤1 个分片时 seal 在预览消息上，但其默认流式模式为 off、面向近实时交互场景；xacpx 长 turn 场景照抄 seal 属于语境错位。

```
1. 累积文本达到 minInitialChars（默认 ~200）后，POST 一条预览消息，记下 messageId
   （首帧防抖：攒够再发，减少推送噪音）
2. 之后每 throttleMs（默认 1200，下限 250）毫秒，用累积全文 PATCH 该预览消息
3. 文本超过 2000 字符 → 停止编辑（预览停留在最后一次快照），标记溢出
4. turn 结束：
   a. cleanup：删除预览消息（内容与最终答案重复，删除避免刷屏；删除失败仅 warn 不阻塞）
   b. 最终文本经 renderDiscordMarkdown(tableMode) + chunkDiscordText 分片，
      逐片以 MESSAGE_CREATE 新发
5. 预览创建/编辑全程容错：任何失败都静默降级为纯静态发送，绝不阻塞交付
```

### 映射到 xacpx

`ChannelStartInput` 的 `agent.chat()` 通过 `reply(text)` 回调吐**增量片段**（feishu 用的是 `cardController.appendStream(text)`，是 append 语义）。
**Discord 的 edit 需要全量快照**，所以插件必须自己累积：

```ts
// channel.ts runTurn 内
let accumulated = "";
const safeReply = async (delta: string): Promise<void> => {
  if (active.suppressed) return;
  accumulated += delta;            // reply 是增量，edit 要全量，插件侧累积
  preview.update(accumulated);     // 内部按 throttleMs 节流 PATCH
};

const response = await this.agent.chat({ /* ... */ reply: safeReply, /* ... */ });
await preview.cleanup();           // 删除预览消息（未创建则 no-op）
const finalText = accumulated || response.text || "";
for (const c of chunkDiscordText(renderDiscordMarkdown(finalText, tableMode), {...})) {
  await client.sendMessage(target, { content: c });   // 最终答案恒新发
}
```

### `preview-stream.ts` 接口

```ts
export function createDiscordPreviewStream(params: {
  client: DiscordClientLike;
  target: DeliveryTarget;
  maxChars?: number;        // 默认 2000，超过即停止编辑
  throttleMs?: number;      // 默认 1200，下限 250
  minInitialChars?: number; // 默认 200，首帧防抖
  onWarn?: (msg: string) => void;
}): {
  update(text: string): void;      // 传入累积全文，内部节流 edit
  cleanup(): Promise<void>;        // turn 结束：删除预览消息（未创建则 no-op）
  created(): boolean;
};
```

### `chunk.ts` 分片算法

借鉴 `extensions/discord/src/chunk.ts`（410 行，自包含）+ `packages/channel-yuanbao/src/markdown-chunker.ts`（368 行）的围栏感知：

| 规则 | 值 |
|---|---|
| 硬上限 | `maxChars = 2000` |
| 行数软限 | `maxLines = 17`（Discord 客户端会折叠超高消息，openclaw 的实测值） |
| 围栏平衡 | 跨片时先补闭围栏，下一片重开（保留 language hint，放不下才降级为 bare marker） |
| 单行超长 | 按 `segmentLimit` 再切（复用 yuanbao chunker 的 `preserveWhitespace` 语义） |

**不实现** openclaw 的 `rebalanceReasoningItalics`（约 150 行）：xacpx 的 reasoning 走 `onThought` 独立侧信道，不会混进正文。砍掉。

### `replyMode` 三档

复用 feishu 的命名（`channel-feishu` 的 `replyMode: auto | streaming | static`）：

| 模式 | 行为 |
|---|---|
| `auto`（默认） | 解析为 `streaming` |
| `streaming` | preview 展示生成过程 + **最终答案新发**（见上） |
| `static` | 不预览，最终文本直接分片新发 |

---

## 6. Markdown 与表格（D5）

Discord 支持标准 `**bold**` / `*italic*` / `` `code` `` / ```围栏``` / `> 引用` / `- 列表`，**不支持 GFM 表格**。

openclaw 的类型是 `MarkdownTableMode = "off" | "bullets" | "code" | "block"`（`src/config/types.base.ts:128`）。

xacpx 侧实现 `src/markdown.ts`：

```ts
export type DiscordTableMode = "code" | "bullets" | "off";   // 默认 "code"
export function renderDiscordMarkdown(text: string, tableMode: DiscordTableMode): string;
```

- 表格检测：连续 `^\|.*\|$` 行
- `code` → 原样包进 ``` 围栏（保留列对齐，最忠实）
- `bullets` → 每行转 `- k1: v1 · k2: v2`（移动端友好）
- `off` → 不动（表格会渲染成纯文本管道符，可读性差，但零信息损失）

另需处理（照 feishu `card/markdown-style.ts` 的 fail-safe 原则）：
- 标题层级降级：H1→H2（Discord 的 `#` 字号很大，容易刷屏）
- **任何异常都返回原文**，绝不因为格式化失败丢消息

---

## 7. 入站管线

严格对齐 feishu `handleMessageEvent`（`channel-feishu/src/channel.ts:354-475`）的顺序：

```
 1. dedup.tryRecord(messageId, accountId)   → 丢弃重复
       TTL 建议 24h / 10000 条（Discord resume 后的事件重放比飞书激进，
       feishu 是 12h/5000）
 2. isMessageExpired(createdTimestamp)      → 丢弃过期（建议 5min，覆盖 Discord resume 窗口）
 3. author.bot && !allowBots                → 丢弃（防 bot 互刷死循环）
 4. evaluateDiscordAccessPolicy()           → dmPolicy / guildPolicy / guilds[].channels 白名单
 5. buildDiscordChatKey()                   → dm:/g:/t: 三类，thread 恒独立（见 D4）
 6. tryHandleAbortTrigger()                 → "stop" / "取消" 快路径（移植 feishu abort-detect.ts）
 7. 清洗 mention、剥离 @bot → 纯文本
 8. quota.onInbound(chatKey)                ← OutboundQuota 的唯一用法（F5，HEAD 核验：
       feishu channel.ts:411、yuanbao channel.ts:478 相同；
       reserveFinal/enqueuePendingFinal 仅 weixin 内置渠道使用，本插件不引入）
 9. downloadInboundAttachments()
10. dispatch-time session binding
11. resolveTurnLane(requestText) + executor.run(chatKey, lane, () => runTurn(...), boundAlias)
```

第 10、11 步直接复用 plugin-api 已导出的三个原语（feishu `channel.ts:429-431`）：

```ts
const isSlash = requestText.trim().startsWith("/");
const boundAlias = isSlash ? undefined : (this.sessions?.peekCurrentSessionAlias(chatKey) ?? undefined);
const lane = resolveTurnLane(requestText);
await this.executor.run(chatKey, lane, () => this.runTurn({...}), boundAlias);
```

### 门控策略

对齐 feishu 的三元组语义：

```jsonc
{
  "dmPolicy": "allowlist",      // "open" | "allowlist" | "disabled"
  "guildPolicy": "allowlist",   // "open" | "allowlist" | "disabled"
  "allowFrom": [],              // Discord user snowflake 数组，或 ["*"]
  "guilds": {                   // 服务器级覆盖
    "<guildId>": {
      "users": [], "roles": [],
      "channels": { "<channelId>": { "requireMention": false } }
    }
  },
  "requireMention": true        // guild 场景默认要求 @bot 或 reply 到 bot；DM 恒为 false
}
```

mention 判定（借鉴 openclaw `message-handler.preflight.ts:462`）：
`message.mentions.has(botUser)` **或** `message.reference?.messageId` 指向 bot 发的消息 **或** 文本以配置前缀开头。

---

## 8. Gateway 与多账号（D8）

### Intents

对齐 openclaw `resolveDiscordGatewayIntents`（`monitor/gateway-plugin.ts:168`），砍掉 voice：

```ts
intents =
  Guilds | GuildMessages | DirectMessages |
  GuildMessageReactions | DirectMessageReactions |
  (config.intents.messageContent !== false ? MessageContent : 0) |
  (config.intents.guildMembers ? GuildMembers : 0)
```

> ⚠️ **`MessageContent` 是 privileged intent**，必须在 Discord Developer Portal 手动开启。没开的话 guild 消息的 `content` 是空字符串，bot 看起来"收不到消息"。这是 Discord 特有的坑，`diagnose()` 必须能报出来（见 §10）。

### 多账号

xacpx 强制 `config.id === config.type`（单实例），多 bot 通过 `options.accounts.<id>` 组织——和 feishu 完全一致。

**启动 stagger**：Discord 的 identify 限流是 5s 窗口（openclaw 的 `IDENTIFY_WINDOW_MS = 5_000`），而 discord.js 只在**同一个 Client 的多 shard 之间**协调，**多个 Client 实例之间不会协调**。所以：

```ts
// channel.ts start()
for (const [i, account] of enabledAccounts.entries()) {
  if (i > 0) await sleep(ACCOUNT_IDENTIFY_STAGGER_MS);   // 默认 5500
  await startAccount(account, input);
}
await Promise.all(longRunningPromises);   // 对齐 feishu：start() 是长跑 Promise
```

### `start()` / `stop()` / `logout()` 语义

| 方法 | 实现 |
|---|---|
| `start(input)` | 第一行 `setChannelLocale(input.locale ?? "en")`；按账号 stagger 启动；`abortSignal` 挂进 WS 生命周期；`await Promise.all(...)` 长跑到 abort |
| `stop(reason)` | **显式实现**：断开所有 Client、清 dedup、清 preview 残留。**不碰 token** |
| `logout()` | 由 `xacpx logout` 触发：`stop()` + 清持久化状态缓存 |

> 不要像 feishu 那样省略 `stop()` 让 registry 回退到 `logout()`（`channel-registry.ts:71-75`）。新插件按 `docs/plugin-development.md` §4 的语义写清楚。

---

## 9. `MessageChannelRuntime` 实现清单

| 成员 | 是否实现 | 说明 |
|---|---|---|
| `id` | ✅ | `readonly id = "discord"`（必须等于 type） |
| `isLoggedIn()` | ✅ | `accounts.some(a => a.enabled && a.configured)`，同步纯函数 |
| `login()` | ✅ | 非交互。已配置返回状态串；否则抛错指引 `options.token` |
| `logout()` | ✅ | 破坏性清理，仅 `xacpx logout` 触发 |
| `start()` | ✅ | 见 §8 |
| `stop(reason)` | ✅ | 见 §8（feishu 没做，我们做） |
| `createConsumerLock()` | ✅（P4） | Discord 每 token 仅一个 Gateway 会话，同 token 双开进程互踢会话；参照 weixin `createWeixinConsumerLock` 先例实现（见 F6） |
| `configureOrchestration()` | ✅ | 存 `markDelivered` / `markFailed` |
| `notifyTaskCompletion()` | ✅ | 先查 `task.chatKey` 前缀；失败走 `markFailed` 后 **return 而非 throw**（对齐 feishu `channel.ts:195`） |
| `notifyTaskProgress()` | ✅ | 直接 `sendRouteText` |
| `sendCoordinatorMessage()` | ✅ | 直接 `sendRouteText` |
| `sendScheduledMessage()` | ✅ | 不绑 session lane，走 `agent.chat`；不支持媒体 |
| `nativeSessionListFormat` | ✅ | **`"cards"`**——Discord 的 markdown 表格渲染成管道符，与 weixin 同病，跟随 weixin 先例（`weixin-channel.ts:35`；消费点 `native-session-handler.ts:145`）。agent 输出表格另有 `tableMode` 兜底（见 F4） |
| relay 三件套 | ❌ | 非结构化频道 |

---

## 10. CLI Provider（`discord-provider.ts`）

对齐 `packages/channel-feishu/src/feishu-provider.ts`：

| 方法 | 实现 |
|---|---|
| `type` | `"discord"` |
| `displayName` | `"Discord"` |
| `supportsLogin` | `false`（bot token 无扫码登录流程，和 feishu 一致） |
| `parseAddArgs` | `--token` / `--application-id` / `--reply-mode` / `--table-mode` / `--require-mention` / `--dm-policy` / `--guild-policy`；未知 flag 立即 `{ ok: false }`，**不抛异常** |
| `buildDefaultConfig` | `{ id: "discord", type: "discord", enabled: true, options: {...} }` |
| `validateConfig` | 返回 issue 数组不抛；`missing-required-field`（带 `flag: "--token"`）/ `invalid-config`；accounts 形态逐个查。**token 只查存在性与字符串类型，不做正则形状校验**（见 F3） |
| `renderSummary` | **token 恒为 `***`** |
| `promptForMissingFields` | `io.promptSecret` 取 token（不回显） |
| `supportsMultipleAccounts` | `true` + `buildAccountOverride` + `channelLevelOptionKeys` + `renderAccountSummary` |
| **`diagnose`** | ✅ **建议实现**（feishu 没做，relay 做了） |

### `diagnose()` 的检查项（Discord 特有价值很高）

1. `level: error` — token 缺失。**不用正则做硬门禁**（F3）：Discord token 格式有代际变化，正则硬校验会误杀合法 token；形状检查至多 `level: warn`，真实有效性留给深探活
2. `level: error` — `disabled` 但 `channels[]` 里 enabled
3. `level: warn` — `intents.messageContent` 未开启却配置了 guild 频道（会收不到内容）
4. `level: ok` — 浅检查通过

> 深度探活（`GET /users/@me`、intent 生效验证）建议放 `xacpx doctor --deep`，避免默认 doctor 打网络。

---

## 11. 配置 Schema

沿用 feishu 的三层结构（`channel-feishu/src/config.ts:124` 的 `resolveAccount(accountId, base, override, path)`）：

```
顶层 options（非保留键）  →  base 默认值
options.accounts.<id>     →  per-account 覆盖
逐字段校验 → DiscordResolvedAccountConfig（全字段必填 + configured 派生）
```

```jsonc
{
  "id": "discord",
  "type": "discord",
  "enabled": true,
  "options": {
    // ---- 账号凭据 ----
    "token": "MTxxx.xxx.xxx",
    "applicationId": "123456789012345678",

    // ---- 输出形态 ----
    "replyMode": "auto",              // auto | streaming | static
    "tableMode": "code",              // code | bullets | off
    "maxLinesPerMessage": 17,
    "previewThrottleMs": 1200,
    "minInitialChars": 200,           // 预览首帧防抖（F2）
    "typingIndicator": true,
    "ackReaction": null,              // 例如 "👀"

    // ---- 入站门控 ----
    "requireMention": true,
    "dmPolicy": "allowlist",
    "guildPolicy": "allowlist",
    "allowFrom": [],
    "guilds": {},
    "allowBots": false,

    // ---- 会话 ----（v1 无 thread.inheritParent：thread 恒独立会话，见 D4）
    "dedupTtlMs": 86400000,
    "dedupMaxEntries": 10000,
    "inboundExpiryMs": 300000,

    // ---- 网关 ----
    "intents": { "messageContent": true, "guildMembers": false },

    // ---- 媒体 ----
    "media": { "maxBytes": 8388608, "maxAttachments": 10 },   // maxBytes 默认值实施前按 Discord 官方现行限制核实（F7）

    // ---- 保留键（不视为 base account 字段）----
    "accounts": {},
    "defaultAccount": "default",
    "tuning": {}
  }
}
```

`BASE_RESERVED_KEYS = { accounts, defaultAccount, tuning }`（feishu 那一套）。

校验器全部手写、抛带路径的可读 Error（复用 feishu 的 `stringOptional` / `booleanOptional` / `enumValue` / `stringArray` / `parsePositiveOptionalNumber` 风格）。交叉校验示例：

```
dmPolicy="open" 要求 allowFrom 包含 "*"
guildPolicy="allowlist" 且 guilds 为空 → warn（bot 不会响应任何服务器消息）
configured = Boolean(token)
enabledAccounts.filter(configured).length === 0 → 整体抛错
```

**`parseDiscordChannelConfig` 必须在构造函数里调用**（feishu `channel.ts:115`），保证配置错误在工厂阶段就抛，让 `doctor` / `dry-run` 能安全导入。

---

## 12. 媒体处理

### 已核实的技术债（方案里必须点出来）

`src/plugin-api.ts` **没有导出** `ChannelMediaAttachment` / `OutboundChannelMedia` / `RuntimeMediaStore`（全文 grep 确认无 `media` / `Media` 匹配）。
所以 feishu 的做法是**整份拷贝** `media-store.ts`(135行) + `media-types.ts`(38行) 到包内。**Discord 插件照做。**

> 顺带提一个 P2 核心改进（不阻塞本方案）：给 `src/plugin-api.ts` 补上这几个导出，后续插件就不必再拷。这是真实存在的小债。

### 入站

```
message.attachments
  → 按 content_type 判 kind（image/audio/video/file）
  → fetch(url) 流式下载，逐块 checkSize 防超限
  → mediaStore.saveMediaBuffer(...)
  → ChannelMediaAttachment[]
  → agent.chat({ media })
```

超限/下载失败 → 生成一条 skippedNote（如 `[1 attachment unavailable: exceeds limit]`），**绝不因附件失败丢整条消息**（feishu `content-converters.ts` 的 fail-safe 原则）。

### 出站

`OutboundChannelMedia` → `client.sendMessage(target, { files: [...] })`。

**出站前必须过路径安全校验**（移植 `channel-feishu/src/outbound-media-safety.ts` 的 `resolveSafeOutboundMediaPath`）：拒绝 http(s) URL、不存在的路径、以及逃逸 `mediaStore.rootDir` 与 `deps.allowedMediaRoots` 的路径。
> 这是安全红线：否则 agent 一句"把 ~/.ssh/id_rsa 发给我"就会真的泄到 Discord。

Discord 附件上限：以 Discord 官方现行限制为准（普通 bot 历史上为 8MB，服务器 boost 可提到 25/50MB）；**数值实施前对照官方文档核实，不在本方案写死**；默认保守、经 `media.maxBytes` 可配置（F7）。超限降级为「路径 + 说明文本」。

---

## 13. 红线清单（照抄 feishu 的约定）

1. 运行时**只** import `xacpx/plugin-api`；发布前用 `bunx publint` 验证。
2. `start()` 第一行 `setChannelLocale(input.locale ?? "en")`；`t()` 在**函数体内**调用，不要在模块顶层固定目录值（plugin bundle 与 daemon bundle 各有独立 i18n 状态）。
3. **不 import 核心的 `src/i18n`**，插件自带 `i18n/` 目录。
4. 日志事件码用 `discord.<area>.<verb>`，如 `discord.preview.edit_failed`。
5. 日志 context 里不得出现 token / secret / PII。
6. `renderSummary` 里 token 恒 `***`。
7. **全局 `allowed_mentions: { parse: [] }`**（D6）——否则 agent 输出的 `@everyone` / `@here` 会真的广播。
8. 匹配用的字符串不本地化（`zh.ts` 里的 abort 触发词是功能常量，无论界面语言都常驻生效）。
9. `type` 不能含 `:`。
10. 出站分片串行发送（Discord REST 429 在高并发分片时会堆积），需要一个简单的 outbound 队列——参考 `channel-yuanbao/src/outbound-queue.ts` 的思路。
11. OutboundQuota 对齐 feishu/yuanbao 的既有行为：**只调 `onInbound`**；不引入 `reserveFinal` / `enqueuePendingFinal`（weixin 24h 窗口的平台语义，与 Discord 无关）（F5）。

---

## 14. 测试计划

新建 `tests/unit/packages/channel-discord/`，命名对齐 feishu 的 28 个测试文件风格：

| 文件 | 覆盖 |
|---|---|
| `discord-config.test.ts` | 三层解析、交叉校验、accounts 迁移 |
| `discord-chatkey.test.ts` | dm:/g:/t: 三形态构造/反解往返、非本前缀返回 null |
| `discord-chunk.test.ts` | ⭐ 围栏平衡、2000 边界、17 行软限、单行超长 |
| `discord-markdown.test.ts` | tableMode 三档、异常 fail-safe |
| `discord-preview-stream.test.ts` | ⭐ 节流窗口、超 2000 停止编辑、cleanup 删除、创建/编辑失败静默降级（F2 语义） |
| `discord-inbound.test.ts` | 门控矩阵（dm/guild × open/allowlist/disabled）、mention 清洗 |
| `discord-dedup.test.ts` | TTL 淘汰、容量上限 |
| `discord-channel.test.ts` | 契约测试：注入 fake `ChannelStartInput`，断言一条入站消息到达 fake agent |
| `discord-provider.test.ts` | `parseAddArgs` 参数组合、`validateConfig` 缺字段、**无正则硬门禁**（token 形状异常但存在 → 不报 error） |
| `discord-media.test.ts` | 入站下载、出站路径逃逸拒绝 |
| `discord-thread-route.test.ts` | thread 独立 chatKey（t:）构造/投递往返；归档 thread 发送失败降级父频道（F1 语义） |
| `no-hardcoded-cjk.test.ts` | ⭐ 断言包内源码无硬编码中文（feishu 有同名测试，是既有约定） |

跑法：`npm run test:unit tests/unit/packages/channel-discord`。

---

## 15. 分阶段落地

| Phase | 交付物 | 验收 |
|---|---|---|
| **P0 核心改动** | ① `src/plugins/known-plugins.ts` 的 `KNOWN_PLUGIN_TEMPLATES` 加 `{ packageName: "@ganglion/xacpx-channel-discord", channels: ["discord"], descriptionKey: "pluginChannelDiscord", official: true }`；② `src/i18n/types.ts` 的 `misc` 加 `pluginChannelDiscord: string`（`pluginChannelFeishu` 在 `types.ts:1283`）+ `en.ts` / `zh.ts` 两份目录；③ 根 `package.json` 加 `clean:channel-discord` / `build:channel-discord` / `publish:channel-discord`，并串进 `build:packages` 与 `publish:plugins` | `xacpx plugin known` 列出 discord |
| **P1 MVP** | `package.json` / `tsconfig.json` / `index.ts` / `config.ts` / `i18n/` / `channel.ts`（仅 static 模式）/ `discord-provider.ts` | `xacpx plugin add` → `channel add discord --token` → `restart` → DM 收发纯文本通 |
| **P2 流式** | `preview-stream.ts` + `chunk.ts` + `replyMode` 三档 | 长回答出现过程预览（打字机效果），**完成后预览被删除、最终答案以新消息送达**；超 2000 字符自动转分片且代码围栏不破（F2 语义） |
| **P3 富文本** | `markdown.ts` + `media.ts` + `media-store.ts` + `outbound-media-safety.ts` | 表格可读；图片/文件双向通；路径逃逸被拒 |
| **P4 加固** | `diagnose()`、**consumer lock**、ack reaction、typing、多账号 stagger、`README.md` | `xacpx plugin doctor` 能报出 MessageContent intent 缺失；同 token 双开被锁拒绝 |

---

## 16. 风险与坑

| # | 风险 | 缓解 |
|---|---|---|
| R1 | **`MessageContent` privileged intent 未开** → guild 消息 content 为空，bot 看似"收不到消息" | `diagnose()` 报 warn；README 顶部加粗提示 |
| R2 | **多账号 identify 限流**（5s 窗口）→ 并发登录被 4004/限流 | 启动 stagger 5500ms（D8） |
| R3 | **编辑频率软限**（~5 次/5 秒）→ preview 太激进会被限流 | `throttleMs` 默认 1200，下限 250 |
| R4 | **REST 429**：大量分片时堆积 | 出站串行队列；429 时按 `retry_after` 退避（discord.js 已内置，但需保证我们不并发轰炸） |
| R5 | **Thread 自动归档**（默认 60 分钟）→ 归档后首次发言会 unarchive，有延迟且需 `SEND_MESSAGES` | v1 不做 autoThread；向归档 thread 发送失败时降级到父频道发送并提示 |
| R6 | **token 泄露**：Discord 主动扫描公开仓库并吊销 token | README 明确警告：只用 `xacpx channel add` 写入 `~/.xacpx/config.json`，绝不进 git |
| R7 | **`@everyone` 广播**：agent 输出里出现即真广播 | 全局 `allowed_mentions: { parse: [] }`（D6） |
| R8 | **包体积**：discord.js ~5MB，装进 `~/.xacpx/plugins` | README 说明；若后续成为问题，改 oceanic.js 只需动 `discord-client.ts` |
| R9 | **模块缓存**：`xacpx plugin update` 后必须 `restart` 才生效（`docs/plugin-development.md` §16.3） | README 写明；`plugin add` CLI 默认会提示重启 |
| R10 | **附件大小上限**：数值随 Discord 政策变化 | 以官方现行限制为准，实施前核实；默认保守、`media.maxBytes` 可配置；超限降级为路径文本 + skippedNote（F7） |
| R11 | **同 token 双开进程互踢 Gateway 会话**（Discord 每 token 单会话） | P4 实现 `createConsumerLock`（weixin 先例）（F6） |

---

## 17. 参考索引

**xacpx 侧（必须遵循）**

- `docs/plugin-development.md` —— 插件开发权威文档（§12 配置形状、§13 chatKey 约定、§14 校验规则、§17 发布契约、§18 测试建议）
- `src/channels/types.ts:154` —— `MessageChannelRuntime` 接口
- `src/channels/create-channel.ts:26` —— type 约束（不得含 `:`、不得重复）
- `src/channels/channel-registry.ts:71` —— `stop()` 缺失时回退 `logout()`
- `src/channels/cli/provider.ts:35` —— `ChannelCliProvider` 接口
- `src/plugin-api.ts` —— 插件可导入的全部运行时导出（**注意不含媒体类型**）
- `src/plugins/known-plugins.ts` —— 官方插件清单
- `src/orchestration/orchestration-types.ts:41` —— `OrchestrationTaskRecord`（携带 `chatKey` / `replyContextToken`，v2 thread 投递路由的依据，见 F1）
- `src/commands/handlers/native-session-handler.ts:145` —— `/ssn` 会话列表格式消费点（F4）
- `src/channels/weixin-channel.ts:30-35` —— consumer lock 与 `nativeSessionListFormat: "cards"` 先例（F4、F6）
- `packages/channel-feishu/` —— 范式基准（尤其 `channel.ts:152` start 接线、`:354` 入站管线、`:667` runTurn、`config.ts:124` 三层解析）

**openclaw 侧（经验来源，不复制代码）**

- `extensions/discord/src/chunk.ts` —— 2000 字符 + 围栏平衡分片器（410 行，自包含）
- `extensions/discord/src/draft-stream.ts` —— edit-in-place 流控（268 行；**其 seal 语义不移植**，见 F2）
- `extensions/discord/src/markdown.ts:352` —— `normalizeDiscordBold(convertMarkdownTables(...))`
- `extensions/discord/src/monitor/gateway-plugin.ts:168` —— intents 组合
- `extensions/discord/src/internal/gateway-identify-limiter.ts` —— 5s identify 窗口
- `extensions/discord/src/internal/gateway-rate-limit.ts` —— 120/60s 网关发送限流
- `extensions/discord/src/internal/gateway-close-codes.ts` —— fatal / non-resumable 分类
- `extensions/discord/src/monitor/message-handler.preflight.ts` —— 入站门控与 mention 判定
- `extensions/discord/src/config-schema.ts` —— 完整配置 schema（取其子集）
- `src/config/types.base.ts:128` —— `MarkdownTableMode = "off" | "bullets" | "code" | "block"`
