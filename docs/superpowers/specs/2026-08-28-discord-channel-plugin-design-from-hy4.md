# xacpx Discord 频道插件设计方案

> 状态：**评审修订版（实施基准 spec）** ｜ 日期：2026-08-28 ｜ 目标包：`packages/channel-discord` → `@ganglion/xacpx-channel-discord`
> 参考实现：`packages/channel-feishu`（xacpx 侧范式基准）、`E:\projects\openclaw\extensions\discord`（Discord 平台侧经验来源）

---

## 评审修订记录（2026-08-28）

经第三方评审 + 对当前 HEAD 的代码核验，本方案做如下修正。正文已同步更新，下文标注的 **F1–F8** 为修正点索引；实施过程中（review round 5–7）逐条落到代码里、且必须与本文一致的**运行时不变量**另见 §18：

| # | 修正 | 依据 |
|---|---|---|
| **F1** | **废除 `Map<parentChatKey, threadId>` 投递绑定**。同一父频道下多个 thread 并发活跃时，后写覆盖先写；任务完成/进度/定时等异步投递只按 chatKey 寻址，会串到"最近活跃的另一个 thread"。v1 改为 **thread 恒用独立 chatKey（`t:<threadId>`）**；v2 若做父频道会话继承，须经 `task.replyContextToken`（`OrchestrationTaskRecord` 已携带，`src/orchestration/orchestration-types.ts:58`）反解投递目标，不得回退可变绑定 | 评审指出竞态；代码核验 `OrchestrationTaskRecord` 携带 `replyContextToken`，v2 路径可行 |
| **F2** | **preview 只展示生成过程；最终答案恒以新消息（MESSAGE_CREATE）发送**，短回答亦然。Discord 编辑只产生 MESSAGE_UPDATE、不推未读，而 xacpx 的 turn 是分钟级，用户通常已切走。这是对 openclaw `draft-stream.ts` seal 语义的**有意偏离**（其默认流式关闭、面向近实时交互，照抄 seal 属语境错位） | 评审采纳 3.8max 调研中记录的 Discord UX 事实 |
| **F3** | **token 正则不做硬门禁**。Discord token 格式有代际变化，正则硬校验会误杀合法 token。`validateConfig` 只查存在性与字符串类型；形状正则至多降为 `diagnose()` warn；**真实有效性不由 doctor 判定**——doctor 恒为静态本地检查，不设 `--deep` 打 `GET /users/@me`，token 与 intent 是否可用只能由 Gateway 启动结果给出（见 §10、§18） | 评审意见；round 6 复核改掉 `doctor --deep` |
| **F4** | **`nativeSessionListFormat` 由 `"table"` 改为 `"cards"`**。Discord 的 markdown 表格渲染成管道符，与 weixin 同病；跟随 weixin 先例（`weixin-channel.ts:35`）。消费点在核心 `native-session-handler.ts:145`。agent 输出中的表格另有 `tableMode` 兜底——原方案此处与 D5 自相矛盾，现已消除 | 评审指出矛盾；代码核验 weixin 先例与消费点 |
| **F5** | **OutboundQuota 约定定案：只调 `onInbound`**。当前 HEAD 核验：feishu（`channel.ts:411`）、yuanbao（`channel.ts:478`）均只用 `onInbound`；`reserveFinal/enqueuePendingFinal` 仅 weixin 内置渠道实际使用（24h 窗口是微信平台语义）+ 文档示例。Discord v1 对齐既有插件行为 | 评审要求以 HEAD 代码裁决；已核验 |
| **F6** | **`createConsumerLock()` 由"不需要"改为实现，并在 review round 7 定案为三层互斥**。Discord 每 token 仅一个 Gateway 会话，同 token 双开进程互踢；原"❌ 无互斥需求"论证不成立。三层各封一段语义，**缺一层都会漏**：**① 配置层（进程内唯一）**——`parseDiscordChannelConfig()` 在拿到 `configuredAccounts` 后拒绝 enabled 账号间重复 resolved token（错误信息只列 accountId，不输出 token 或其 fingerprint），因为 `start()` 会逐个 eligible account 各建一个 `DiscordClient`，而 base config 继承（`resolveAccount` 的 `{...base, ...override}`）使多账号漏配 token 时轻易共享同一 token。**② 核心层（每频道一把，全部持有）**——`createRuntimeConsumerLock({ coreLock, channelLocks })` 组合 core 归属锁与**所有**声明 `createConsumerLock` 的频道锁：`cli.ts` 按 `channel.id.localeCompare` 排序后逐个建锁并保留各频道自己的诊断前缀 `${channel.id}.consumer_lock.${event}`；acquire 严格串行 `core → A → B → C`，任一失败按逆序回滚已持有的锁再抛出原错误（**不用 `Promise.all`**：并发后无从知道拿到了哪几把，也无从精确回滚）；release 同样逆序，且某个锁抛错不得阻止后续锁释放，最后重抛第一个错误。**③ Discord 锁层（跨进程 per-token）**——每个 distinct enabled token 一个锁文件 `<coreHome>/runtime/discord-consumer-<sha256(token)前16位>.lock.json`（文件名不含 accountId、不落明文 token），`createConsumerLock()` 返回按序 acquire、任一冲突回滚已持有的复合锁。**锁目录恒为 `coreHomeDir(process.env.HOME ?? homedir())/runtime`，不随 `XACPX_CONFIG` 迁移**——token 归属是"每用户 + 每 token"，不是"每配置"，否则同一 token 换两个配置根就能起两个 Gateway 会话；注入的 `lockFilePath` 只用于定位与诊断，**不再充当命名空间锚点**。**metadata 不可读时 fail closed**：`open(..., "wx")` 与随后写 JSON 之间存在发布窗口，读到空/半截 metadata 时只做少量重读（5 次 × 20ms），仍不可读则报 `lock_invalid_conflict` / `reason: existing_lock_metadata_unreadable` 并抛错，**绝不 `rm()` 后重试**——那等于抢走活跃持有者的锁。若锁文件在 `EEXIST` 与读取之间被持有者正常释放（读到 ENOENT），那是"可重试"而不是"不可读"，照常重试即可。PID 复用硬化（`processStartedAtMs` 比对）与 `lockId` 门控 release 保留，因此"metadata 可读且 pid 已死"的 stale 锁仍能被正常回收 | 3.8max 复核补正；round 2 评审指出全局单文件语义不符；round 3 评审指出集合 hash 在 `{X}` vs `{X,Y}` 与 accountId 重排下漏锁（round 3 曾改"取注入路径的目录作锚"，round 7 判定该锚点本身错位，已废）；round 4 评审指出 per-token 锁未覆盖同进程多账号同 token；round 6 评审指出 core 只 acquire `lockCreators[0]`；round 7 评审指出 metadata 发布窗口下"读不到就删"会抢锁 |
| **F7** | **附件上限数值不写死**。以 Discord 官方现行限制为准，实施前核实；默认保守、经 `media.maxBytes` 可配置 | 两案数值（8MB/25MB）均无依据 |
| **F8** | **归档 thread 降级收敛到一个惰性 helper**。原实现有两份同构的"发送失败→改投父频道"错误分类器：文本先向 thread 发一次、失败后再调 helper 又向 thread 发第二次（thread 被发两遍），而**出站媒体根本没有降级**——归档 thread 里的图片/文件只记一条 `discord.media.send_failed` 就丢掉。现由 `sendWithThreadFallback()` 独占该判定：它自己发首投，`resolveParentTarget()` **只在首投被判为 archived/not-found 之后才调用**（健康 thread 零成本，也不会被重复投递），最终文本、出站媒体、私有 `sendRouteText()`、后台完成通知四条路全部走它（round 8 补上最后一条：通知此前仍向 thread 裸发，答案到了父频道而通知被记一条 `discord.bg_notice.failed` 丢掉）；父频道优先取入站消息自带的 `parentChannelId`（挂在 `ActiveTask` 上），拿不到才回查 REST。父频道不可知时**重抛原始 Discord 错误**，绝不静默成功 | round 7 评审：媒体绕过 fallback；文本重复投递；父频道字段被 `as unknown as`  cast 掉而恒为 undefined；round 8 复核：后台完成通知仍向 thread 裸发 |

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
export interface DiscordBotIdentity {
  botUserId: string;
  botTag?: string;
}

export interface DiscordClientLike {
  start(input: { handlers: { onMessage(m: DiscordInboundMessage): void }; abortSignal: AbortSignal }): Promise<DiscordBotIdentity>;
  probeBot(): Promise<DiscordBotIdentity>;
  sendMessage(target: DeliveryTarget, body: OutboundBody): Promise<{ messageId: string }>;
  editMessage(target: DeliveryTarget, messageId: string, body: OutboundBody): Promise<void>;
  deleteMessage(target: DeliveryTarget, messageId: string): Promise<void>;
  startTyping(channelId: string): Promise<() => void>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  destroy(): Promise<void>;
}
```

> **身份契约（review round 6 补正）**：`start()` 返回 `DiscordBotIdentity`，它是 bot 身份的**唯一权威来源**——登录失败（坏 token、intent 未批、连接错误）或会话建立却没有 bot user id 时 `start()` 必须 reject，账号按启动失败处理。自检消息门控、mention 门控与 reply-to-bot 判定全部以这个 `botUserId` 为准，空 id 会静默关掉它们。`probeBot()` 只是诊断用 REST 探针（`GET /users/@me`），**永不参与启动身份推导**——它能返回空而登录照样成功，把它当权威就是 fail-open。

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
    ├── outbound.ts              # sendWithThreadFallback：唯一的归档 thread 降级入口（round 8 删掉零引用的 sendRouteText helper）
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

mention 判定（实现见 `src/inbound.ts` 的 `shouldHandleDiscordMessage`，round 5/6 补正）：

- **显式 @-mention bot**：`message.mentions.users` 命中 `botUserId`；`mentions` 未填充时回退到内容检查 `<@${botUserId}>` / `<@!${botUserId}>`。
- **精确 reply 到 bot**：`message.repliedUserId === botUserId` **或** `message.mentions.repliedUser?.id === botUserId`。只有 `referencedMessageId`（不知道被回复者是谁）**不算**——回复另一个人类不能触发 bot。
- 文本前缀触发**未实现**（早期方案借鉴 openclaw 的措辞，现已删除）。
- DM 恒不受 mention 门控约束；guild 下 `requireMention` / `accountRequireMention` / `channelRequireMention` 先合并成**同一个** `effectiveRequireMention`，普通门控与 abort 快路径共用 `isDiscordReplyToBot`，避免两处规则漂移。

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

> ⚠️ **`Message Content` 是 privileged intent**，默认 `intents.messageContent: true`（`config.ts:175`），仍须在 Discord Developer Portal 手动开启。三种情形要分开说（review round 5/6 补正）：
>
> 1. **Portal 未开 + 我们仍上报该 intent** → Gateway 以 close code **4014（Disallowed intents）** 拒绝，`start()` reject，**bot 直接离线**、账号按启动失败处理，不是"上线但收不到内容"。
> 2. **显式 `intents.messageContent: false`** → 不请求该 intent，bot 正常在线，Discord 仍会投递**DM**、bot 自己的消息与**显式 @-mention bot** 的消息内容；其余普通服务器消息 `content` 为空，在 `requireMention: false` 的 guild 频道里会被丢掉。
> 3. **仅 reply 指向 bot 而不带 @-mention** → **不等价于第 2 条**：没有 @-mention 就没有内容兜底，关闭 intent 时这条消息的 `content` 依然是空。reply-to-bot 只放宽 mention 门控，不放宽 Discord 侧的内容投递。
>
> `diagnose()` 只做静态检查（见 §10），第 1 种情形只能由 Gateway 启动结果暴露。


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
| `notifyTaskProgress()` | ✅ | 私有 `sendRouteText()`：渲染+分片后每片走 `sendWithThreadFallback`（thread 键的 chatKey 无入站元数据，父频道只能回查 REST） |
| `sendCoordinatorMessage()` | ✅ | 同上，私有 `sendRouteText()` |
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

**doctor 只做静态本地检查，绝不联网**（review round 6 定案）：它读配置、判形状，**不打 `GET /users/@me`、不验证 intent 是否获批**，也不设 `xacpx doctor --deep` 之类的深探活档——因为"token 是否有效 / privileged intent 是否批准"这类事实只有 **Gateway 启动结果**能给出权威答案（见 §2 身份契约与 §8 intents）。doctor 报 OK 不代表 bot 能上线。

| `code` | level | 触发条件 |
|---|---|---|
| `discord-token-missing` | error | 账号（含合并 base 后）无 token |
| `discord-message-content-disabled` | warn | 显式 `intents.messageContent: false`；措辞必须区分上面第 2/3 种情形：bot 仍在线，DM 与显式 @-mention 仍有内容，普通服务器消息 content 为空 |
| `discord-token-shape` | warn | token 异常短（软提示，**不作硬门禁**，见 F3） |
| `discord-config-ok` | ok | 以上全通过；文案必须明说这是静态本地检查、看不到 token 有效性与 intent 批准状态，请启动频道看 Gateway 日志（如 close code 4014） |


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

校验器全部手写、抛带路径的可读 Error（复用 feishu 的 `stringOptional` / `booleanOptional` / `enumValue` / `stringArray` / `parsePositiveOptionalNumber` 风格）。

**`parseDiscordChannelConfig()` 是语义校验的唯一权威**（review round 6 定案）：`DiscordChannel` 构造函数调用它，`discordCliProvider.validateConfig()` 也只做它的包装（把抛出的 Error 折算成 `invalid-config` issue；`config.options === undefined` 同样判 issue，与 parser 对 `undefined` 的拒绝保持一致——两处判定不一致就是 drift）。交叉校验按实现事实列：

```
options 非对象（含 undefined）        → 抛错
accounts 非对象                      → 抛错
accountId 为空或含 ":"               → 抛错（chatKey 以 ":" 分段，含 ":" 会让路由歧义）
无任何 enabled 且 configured 的账号   → 抛错（token 必填）
enabled 账号之间 resolved token 重复  → 抛错（信息只列 accountId，见 F6）
defaultAccount 指向不存在的账号       → 抛错
```

> **不存在**"`dmPolicy="open"` 要求 `allowFrom` 包含 `"*"`"这类交叉约束：`dmPolicy` 与 `allowFrom` 是两个独立开关，`allowlist` + 非空 `allowFrom` 与 `open` 都能放行 DM，parser 也不为此抛错或 warn。早期方案里的这条断言是错的，已删除。

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
| **P4 加固** | `diagnose()`、**consumer lock**、ack reaction、typing、多账号 stagger、`README.md` | `diagnose()` 静态报出 `intents.messageContent` 被关闭与 token 缺失（不联网）；同 token 双开被用户全局 per-token 锁拒绝；同进程多账号同 token 被配置层拒绝 |

---

## 16. 风险与坑

| # | 风险 | 缓解 |
|---|---|---|
| R1 | **`Message Content` privileged intent**：Portal 未开而我们仍上报该 intent → Gateway 以 **4014 拒绝、bot 直接离线**；显式 `intents.messageContent: false` → bot 在线但普通服务器消息 `content` 为空（DM 与显式 @-mention 仍有内容） | `diagnose()` 静态 warn（不联网，看不到 Portal 状态）；README 顶部加粗提示；真实结果由 `start()` 的 Gateway 失败暴露（见 §8、§18） |
| R2 | **多账号 identify 限流**（5s 窗口）→ 并发登录被 4004/限流 | 启动 stagger 5500ms（D8） |
| R3 | **编辑频率软限**（~5 次/5 秒）→ preview 太激进会被限流 | `throttleMs` 默认 1200，下限 250 |
| R4 | **REST 429**：大量分片时堆积 | 出站串行队列；429 时按 `retry_after` 退避（discord.js 已内置，但需保证我们不并发轰炸） |
| R5 | **Thread 自动归档**（默认 60 分钟）→ 归档后发言失败（50083） | v1 不做 autoThread；向归档 thread 发送失败时统一降级到父频道，**文本、出站媒体、私有 `sendRouteText()` 与后台完成通知走同一个惰性 helper**，父频道不可知则重抛原错（见 F8） |
| R6 | **token 泄露**：Discord 主动扫描公开仓库并吊销 token | README 明确警告：只用 `xacpx channel add` 写入 `~/.xacpx/config.json`，绝不进 git |
| R7 | **`@everyone` 广播**：agent 输出里出现即真广播 | 全局 `allowed_mentions: { parse: [] }`（D6） |
| R8 | **包体积**：discord.js ~5MB，装进 `~/.xacpx/plugins` | README 说明；若后续成为问题，改 oceanic.js 只需动 `discord-client.ts` |
| R9 | **模块缓存**：`xacpx plugin update` 后必须 `restart` 才生效（`docs/plugin-development.md` §16.3） | README 写明；`plugin add` CLI 默认会提示重启 |
| R10 | **附件大小上限**：数值随 Discord 政策变化 | 以官方现行限制为准，实施前核实；默认保守、`media.maxBytes` 可配置；超限降级为路径文本 + skippedNote（F7） |
| R11 | **同 token 双开进程互踢 Gateway 会话**（Discord 每 token 单会话） | 三层互斥：配置层拒重复 token + 核心层持有**全部**频道锁 + 用户全局 per-token 锁文件（见 F6） |

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

---

## 18. 运行时不变量（round 5–7 已落地）

本节是**契约**，不是实现说明：下面每条都已在 HEAD 生效并有回归测试守着，改代码时若与任一条冲突，即为 bug（即使测试没覆盖到）。测试位置：`tests/unit/packages/channel-discord/`、`tests/unit/daemon/runtime-consumer-lock.test.ts`、`tests/unit/cli-consumer-lock-wiring.test.ts`、`tests/unit/scripts/publish-channel-discord-workflow.test.ts`。

1. **身份 fail-closed**：`start(): Promise<DiscordBotIdentity>` 是唯一权威身份来源；Gateway 会话建立但拿不到 bot user id 时按**启动失败**处理，不得回退到 `probeBot()` 或空串——空 `botUserId` 会静默关掉自检/mention/reply 三道门控。
2. **自检消息判定先于 dedup 与 allowBots**：Discord 会把自己的 MESSAGE_CREATE 回投，`author.id === botUserId` 一律丢弃；`allowBots` 只管**其他** bot。顺序反过来就是自消息死循环。
3. **根 abort 必须绑进每个 in-flight turn**：`registerActiveTask()` 订阅 `start()` 收到的 `abortSignal`，触发时置 `suppressed` 并 abort 该 turn 自己的 controller；turn 的 `finally` 必须解绑监听（否则长跑 daemon 每条消息泄漏一个 listener）。被抑制的 turn 既不发答案也不发完成通知。
4. **accountId 不得含 `:`**：chatKey 以 `:` 分段（`discord:<accountId>:<kind>:<channelId>`），含 `:` 会让路由歧义。`parseDiscordChannelConfig()` 直接抛错。
5. **mention 清理只剥自己的 mention tag，并保留缩进与换行**：折叠所有空白会把多行提示词、粘贴的代码块压成一行。出站文本恒定 `allowedMentions: { parse: [] }`（D6 / R7）。
6. **reply-to-bot 要精确到"被回复者确实是 bot"**：只有 `repliedUserId` / `mentions.repliedUser.id` 命中 bot id 才算，光有 `referencedMessageId` 不够——那会把"回复另一个人类"当成回复 bot。正常 mention 门控与 abort 快路径共用同一个判定，且共用同一个 `effectiveRequireMention`（频道级 override 优先于账号级），二者不得各读一份。
7. **配额重置的时序**：`quota.onInbound(chatKey)` 在消息**被接纳之后、入站附件下载之前**调用。放在下载之后，一个慢附件会把预算重置拖到下一轮，导致合法消息被限。
8. **`parseDiscordChannelConfig()` 是语义校验的唯一权威**：构造函数调用它；`discordCliProvider.validateConfig()` 只做包装（含 `options === undefined` 也判 issue）。两处判定不一致就是 drift。
9. **归档 thread 降级只有一个入口且惰性**（F8）：最终文本、出站媒体、私有 `sendRouteText()`、后台完成通知（`sendBackgroundCompletionNotice`）都交给 `sendWithThreadFallback()`，由它发首投；`resolveParentTarget()` 只在首投被判 archived(50083)/not-found 后调用。父频道优先 `ActiveTask.parentChannelId`（来自入站消息，`registerActiveTask` 必须真的存下来），否则回查 REST；不可知则重抛原始错误。非 thread 目标不得解析、不得使用父频道。通知是尽力而为：它的降级外面还包一层 catch，两处都失败只记 `discord.bg_notice.failed`，不得打断 turn 收尾。断言见 `tests/unit/packages/channel-discord/discord-thread-route.test.ts`（含"通知到了父频道"一条）。
10. **consumer lock 三层各封一段**（F6）：配置层拒 enabled 账号重复 token；核心层 `createRuntimeConsumerLock` 持有 **core + 所有频道** 的锁，串行 acquire、逆序回滚、release 不被单个抛错中断（**禁止 `Promise.all`**）；Discord 锁文件名按 token hash 落在**用户全局** `~/.xacpx/runtime/`，不随 `XACPX_CONFIG` 或注入路径迁移；metadata 不可读时少量重读后 **fail closed，绝不删既有锁文件**。
11. **publish 只能来自精确 tag**（`.github/workflows/publish-channel-discord.yml`）：两个按事件门控的 checkout 步骤，dispatch 走 `ref: refs/tags/${{ inputs.tag }}`，让分支名在 checkout 阶段就失败而不是以"看着像 tag"的名字发出分支 HEAD；`git show-ref --verify` + `HEAD == tag^{commit}` + `tag == channel-discord-v<package.json version>` 三条证明**必须排在 `npm publish` 之前**；`gh release create` 带 `--verify-tag`；shell 里**不得出现 `${{ }}` 内插**，外部值只经 `env:` 进入。静态守门：`tests/unit/scripts/publish-channel-discord-workflow.test.ts`。
12. **中断发版的恢复不改状态机**（文档契约，无代码断言）：npm 已有该版本而 GitHub Release 缺失时，**不重跑 publish、不移动/重推 tag**（重推会让 tag 不再指向产出该制品的 commit）；只做 `git show-ref --verify` + `git rev-parse refs/tags/<tag>^{commit}` 校验，然后单独 `gh release create <tag> --verify-tag --title "@ganglion/xacpx-channel-discord v<version>" --generate-notes`，稳定版带 `--latest=false`、预发布版改用 `--prerelease`（与 workflow 那两步逐字一致）。完整 runbook 见 [`docs/developments.md`](../../developments.md) 与 [`docs/zh/developments_zh.md`](../../zh/developments_zh.md)。
