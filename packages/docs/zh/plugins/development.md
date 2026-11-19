# 频道插件开发

## 概述

xacpx 将消息频道封装为 npm 插件。频道插件是一个 npm 包，导出一个 `XacpxPlugin` 对象（兼容旧名称 `WeacpxPlugin`），其中声明一个或多个 `ChannelPluginDefinition` 条目。守护进程启动时，会读取 `~/.xacpx/config.json` 中的 `plugins[]`，从 `~/.xacpx/plugins/node_modules/<plugin-name>` 动态导入每个已启用的插件包，并注册其频道工厂和 CLI 提供者。

> **改名说明（0.8.0）：** 项目已从 `weacpx` 改名为 `xacpx`。新插件请从 `xacpx/plugin-api` 导入，将 `xacpx` 声明为 peer dependency，并优先使用新名称 `XacpxPlugin` / `minXacpxVersion` / `compatibleXacpxVersions`。为保持向后兼容，旧名称 `WeacpxPlugin` / `minWeacpxVersion` / `compatibleWeacpxVersions` 仍受核心支持（若同时声明两套名称，新名称优先）。使用旧名称发布的插件无需任何修改即可继续正常工作。

本文档涵盖编写、测试和发布频道插件所需的全部内容：所有类型、方法、字段及错误码。

## 包结构

推荐的目录布局：

```
my-channel/
├── package.json           # name, peerDependencies: { xacpx: ">=0.24.10-beta.18" }
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts           # default export XacpxPlugin
│   ├── channel.ts         # implements MessageChannelRuntime
│   ├── cli-provider.ts    # implements ChannelCliProvider (optional but strongly recommended)
│   ├── config.ts          # parse / validate options
│   └── ...                # gateway, signing, message codec, etc.
└── dist/                  # published build artifacts (src is not published)
    ├── index.js
    └── index.d.ts
```

`package.json` 关键字段：

```jsonc
{
  "name": "@scope/xacpx-channel-my",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist", "README.md"],
  "peerDependencies": { "xacpx": ">=0.24.10-beta.18" },
  "peerDependenciesMeta": { "xacpx": { "optional": true } }
}
```

将 `xacpx` 声明为 `optional` peer：本地开发时安装一份，运行时由 xacpx 提供。所有导入**必须**来自 `xacpx/plugin-api`，不可从 `xacpx/dist/*` 或 `xacpx/src/*` 导入（那是内部路径，不属于稳定 API 面）。

## 插件清单与导出

### `XacpxPlugin` / `WeacpxPlugin`

```ts
import type { XacpxPlugin } from "xacpx/plugin-api";
import {
  WEACPX_PLUGIN_API_VERSION,
  WEACPX_PLUGIN_MIN_CORE_VERSION,
} from "xacpx/plugin-api";

// New name (preferred):
const plugin: XacpxPlugin = {
  apiVersion: WEACPX_PLUGIN_API_VERSION,       // currently fixed at 1
  minXacpxVersion: WEACPX_PLUGIN_MIN_CORE_VERSION, // e.g. "0.5.0"
  channels: [/* ... */],
};

export default plugin;
```

| 字段 | 是否必填 | 说明 |
| --- | --- | --- |
| `apiVersion` | 是 | 必须为字面量 `1`。xacpx 会在未来的破坏性变更中递增此值。`WEACPX_PLUGIN_API_SUPPORTED_VERSIONS` 列出当前 xacpx 所接受的版本号。 |
| `name` | 否 | 若设置，必须与 npm 包名完全一致（含 scope）；否则启动校验会拒绝该插件。 |
| `minXacpxVersion` | 推荐 | 插件所需的最低 xacpx 核心版本（如 `"0.5.0"`）。若已安装的 xacpx 版本较旧，加载会失败并提示 `upgrade xacpx`。官方插件必须设置；强烈建议第三方插件也设置。 |
| `compatibleXacpxVersions` | 否 | 显式版本范围（`x.y.z` / `>=x.y.z` / `^x.y.z`）。与 `minXacpxVersion` 同时声明时，两个约束须同时满足。 |
| `channels` | 否 | 频道定义列表，可为空（保留给未来的非频道扩展点）。 |

约束：

- 必须使用**默认导出**（`export default plugin`）。具名导出会被忽略。
- 每个守护进程只导入一次模块；避免顶层副作用（定时器、全局监听器等）。

### 兼容性错误

| 错误关键词 | 含义 | 用户操作 |
| --- | --- | --- |
| `requires xacpx >=X.Y.Z; ... upgrade xacpx` | 插件版本高于已安装的 xacpx | 将 `xacpx` 升级至 ≥ 该版本，或安装与当前 xacpx 兼容的插件版本 |
| `apiVersion N; supported: ...; install a compatible plugin` | 插件使用了 xacpx 不识别的 API 版本 | 升级或降级**插件**至与已安装 xacpx 兼容的版本 |
| `invalid plugin metadata` | `minXacpxVersion` / `compatibleXacpxVersions` 字段格式错误 | 联系插件作者或检查发布元数据 |

`xacpx plugin doctor` 会将这些错误以 `ERROR <plugin>: ...` 格式输出，适用于 CI 或发布前的预检。

### `ChannelPluginDefinition`

```ts
export interface ChannelPluginDefinition {
  type: string;
  factory: ChannelFactory;
  cliProvider?: ChannelCliProvider;
  retireChannel?: (ctx: ChannelRetireContext) => Promise<void>;
}
```

| 字段 | 是否必填 | 说明 |
| --- | --- | --- |
| `type` | 是 | 频道类型字符串，如 `"feishu"`、`"yuanbao"`。在进程内必须全局唯一。 |
| `factory` | 是 | 工厂函数；在守护进程启动时被调用以实例化 `MessageChannelRuntime`。 |
| `cliProvider` | 否 | 为 `xacpx channel add <type>` 提供解析和交互逻辑。不提供时，用户须手动编辑 `~/.xacpx/config.json`。强烈建议提供。 |
| `retireChannel` | 否 | `xacpx channel disable` / `xacpx channel rm` 的 CLI 生命周期钩子。core 在已加载插件中按类型分发，不会 import 插件包。用于一次性资源清理。 |

`type` 约束：不可为空，不可含 `:` 字符（chatKey 使用 `:` 作为分隔符），不可与已注册类型冲突（`weixin` 始终由内置频道保留）。

## 频道生命周期

### `ChannelFactory`

```ts
export type ChannelFactory = (
  options: Record<string, unknown> | undefined,
  deps?: CreateChannelDeps,
) => MessageChannelRuntime;

export interface CreateChannelDeps {
  mediaStore?: RuntimeMediaStore;
  allowedMediaRoots?: string[];
}
```

| 参数 | 说明 |
| --- | --- |
| `options` | 来自配置的 `channels[].options` 对象，类型为 `Record<string, unknown>`，未经预验证。请在工厂内部解析和验证。 |
| `deps.mediaStore` | xacpx 提供的临时媒体存储工具。处理图片或文件附件时使用。 |
| `deps.allowedMediaRoots` | 已注册的工作区 `cwd` 路径集合。决定哪些目录可作为 agent 输出的出站文件附件来源。 |

**工厂中只解析参数、初始化状态**，不要打开网络连接或读取外部令牌。所有副作用留给 `start()`。这样 `doctor` 和 `dry-run` 才能安全地导入插件。

示例：

```ts
factory: (options) => new MyChannel(options)

class MyChannel implements MessageChannelRuntime {
  private readonly config: MyConfig;
  constructor(options: Record<string, unknown> | undefined) {
    this.config = parseMyConfig(options); // throw on invalid config
  }
  // ...
}
```

### `MessageChannelRuntime`

```ts
export type ChannelStopReason = "shutdown" | "disabled" | "removed" | "logout";

export interface MessageChannelRuntime {
  id: string;

  isLoggedIn(): boolean;
  login(): Promise<string>;
  logout(): void | Promise<void>;

  start(input: ChannelStartInput): Promise<void>;

  stop?(reason?: ChannelStopReason): void | Promise<void>;

  createConsumerLock?(options?: ConsumerLockOptions): ConsumerLock;
  configureOrchestration?(callbacks: OrchestrationDeliveryCallbacks): void;

  notifyTaskCompletion(task: OrchestrationTaskRecord): Promise<void>;
  notifyTaskProgress(task: OrchestrationTaskRecord, text: string): Promise<void>;
  sendCoordinatorMessage(input: CoordinatorMessageInput): Promise<void>;
  sendScheduledMessage?(input: ScheduledChannelMessageInput): Promise<void>;
  requestPermission?(request: ChannelPermissionRequest): Promise<ChannelPermissionDecision>;
  requestElicitation?(request: ChannelElicitationRequest): Promise<ChannelElicitationDecision>;
}
```

**`id`** — 唯一实例标识符。xacpx 当前要求 `id === type`，因此写成 `readonly id = "<type>"`。用于日志上下文。

**`isLoggedIn()`** — 同步纯函数。返回当前是否存在可用凭据。在启动前调用一次，用于判断是否需要 `login()`。

**`login()`** — 非交互式频道（OAuth、appKey/appSecret）通常返回一个状态字符串：

```ts
async login(): Promise<string> {
  if (this.isLoggedIn()) return "credentials configured";
  throw new Error("Provide options.appKey and options.appSecret in channels[].options");
}
```

交互式频道（微信二维码扫描）会阻塞直到登录完成。若频道不需要交互式登录，将 `cliProvider.supportsLogin` 设为 `false`。

**`logout()`** — **破坏性凭据移除。** 仅通过显式的 `xacpx logout` CLI 路径触发——绝不会作为正常关闭或重新登录的一部分被调用。签名为 `logout(): void | Promise<void>`。由于它会清除已存储的凭据，用户必须重新执行 `login()` / `xacpx channel add <type>` 才能重新连接，因此切勿在自己的清理路径中调用它。

**`start(input)`** — 频道开始接收消息的入口点。详见下方[入站消息](#入站消息)。

**`stop?(reason?)`** — 可选。**非破坏性**关闭钩子：释放运行时资源（关闭连接、取消定时器、清理内存会话），不触碰已存储的凭据。守护进程的 `stopAll` 优先调用 `stop()`，仅对 `stop()` 出现之前发布的频道回退到 `logout()`（那些插件的 `logout()` 只是无害的客户端停止）。`reason` 取值：`"shutdown"`（信号或启动失败清理）、`"disabled"` / `"removed"`（CLI 变更）、`"logout"`（显式登出命令）。新频道应实现它，不要依赖 `logout()` 回退。

**`createConsumerLock?(options?)`** — 可选。若频道需要**进程级互斥**（例如同一个微信账号同时只能由一个 xacpx 进程连接），则实现此方法。详见下方 `ConsumerLock`。

**`configureOrchestration?(callbacks)`** — 可选。守护进程在装配编排服务时调用，提供 `markTaskNoticeDelivered` 和 `markTaskNoticeFailed` 回调。若频道支持 `notifyTaskCompletion`，请保存这些回调并在投递成功/失败时调用。

**`notifyTaskCompletion(task)`** — 编排服务调用此方法，通知用户工作任务已完成。通过检查 `task.chatKey` 路由。成功时调用 `markTaskNoticeDelivered(taskId, accountId)`，失败时调用 `markTaskNoticeFailed(taskId, errorText)`。若 `task.chatKey` 不属于本频道（检查前缀），立即返回——守护进程会向所有频道广播。

**`notifyTaskProgress(task, text)`** — 心跳通知（默认每 60 秒，由 `progressHeartbeatSeconds` 控制）。若频道不支持流式心跳，写一个空实现即可。

**`sendCoordinatorMessage(input)`**

```ts
export interface CoordinatorMessageInput {
  coordinatorSession: string;
  chatKey: string;
  accountId?: string;
  replyContextToken?: string;
  text: string;
}
```

编排服务调用此方法，向协调者会话所在频道发送文本消息。`replyContextToken` 是回复上下文句柄（Feishu/Yuanbao 用于引用父消息），可忽略。

**`sendScheduledMessage?(input)`** — 可选。投递定时/后台回合的输出。仅当频道需要以不同于普通入站回复的方式路由定时回合结果时才实现，否则省略。

**`requestPermission?(request)`** — 可选。交互式权限 UI（计划审批）。未实现表示该频道不支持交互式权限，broker 会 fail-closed。实现方必须校验响应者等于 `request.requester.senderId`，且必须只结算一次（首个终态决定生效）。

**`requestElicitation?(request)`** — 可选。交互式 ACP 表单 Elicitation UI。未实现表示该频道不支持 Elicitation，broker 会 fail-closed。仅为 `request.requester.senderId` 渲染，并返回平台认证过的响应者 id（绝不使用自报 id）；展示 `request.agent.name`，绝不用 agent 可控的 `message`/`title`/`description` 文本替代身份标识；呈现 `request.message`；提供互相独立的 Decline 与 Cancel 控件；允许用户在 Accept 前审阅并修改响应；待处理表单状态只保存在服务端内存中（绝不把答案值编码进 control id/URL，绝不持久化答案）；只结算一次——`ChannelElicitationDecision` 的每个成员都是用户动作，都需要经过认证的 `responderId`，不存在无响应者变体。外部取消（超时、回合销毁、agent `$/cancel_request`、关闭）不是用户决定：立即撤回 UI、停止收集输入，并 reject/抛出（或永不结算）——该终态取消由核心持有并自行以 `cancel` 结算。

## 入站消息

### `ChannelStartInput`

```ts
export interface ChannelStartInput {
  agent: ChatAgent;
  routeConversation?: (request: ChatRequest) => ConversationChannelAgent | undefined;
  abortSignal: AbortSignal;
  quota: OutboundQuota;
  logger: AppLogger;
  perfTracer?: PerfTracer;
  sessions?: SessionService;
  activeTurns?: ActiveTurnRegistry;
  control?: PublicControlService;
  trustedConversationPrompt?: (
    input: ConversationPromptRequestDto,
    ingress: HumanIngressContext,
  ) => Promise<ConversationPromptResponseDto>;
  sessionResources?: SessionResourceCatalog;
  // 可选字段（核心按需注入）：
  commandHints?: CommandHint[];   // 内置命令目录，供输入框命令提示用
  coreVersion?: string;           // xacpx 核心版本字符串
  locale?: Locale;                // 当前运行时语言（"en" | "zh"），见“国际化”
}
```

| 字段 | 用途 |
| --- | --- |
| `agent` | xacpx 路由入口（`ChatAgent`）。收到文本消息时，以 `ChatRequest` 调用 `await agent.chat(request)`，返回 `ChatResponse`。不存在 `handle` 方法。 |
| `routeConversation?` | 在平台准入之后、当前 Session 查询、活跃度跟踪或 Session 通道选择之前调用。返回的 Agent 将在独立的 Conversation 通道上接管本次入站回合（无 Session 别名、无前台/后台结果钩子）；返回 `undefined` 则保持普通 Session 分发。须提供精确的 channel/account/chatKey/平台消息身份；完整的 chat 请求必须携带 authenticated-human 元数据。 |
| `abortSignal` | 守护进程关闭信号。监听 `aborted` 事件，停止所有长连接和定时器。 |
| `quota` | 出站速率/数量配额。详见[回复与媒体](#回复与媒体)。 |
| `logger` | 结构化日志记录器。详见 [AppLogger](#applogger)。 |
| `perfTracer?` | 性能追踪。把它颁发的 `PerfSpan` 挂到该回合的 `ChatRequest.perfSpan` 上，下游层即可直接标记事件，无需额外传递。 |
| `sessions?` | 逻辑会话服务。会话感知型频道从它读取分发时的会话绑定（当前别名），并持久化后台回合结果。 |
| `activeTurns?` | 共享的在途回合注册表，用于分发时的前台跟踪。`sessions` + `activeTurns` 正是下方“分发时绑定 / 每会话通道”语义的实现。 |
| `control?` | 公开的结构化控制门面（sessions / prompt / scheduler / orchestration / Bot / Conversation）。受信任的 Conversation 执行是核心私有能力，不在此对象上。可选：纯文本频道可忽略。 |
| `trustedConversationPrompt?` | 经 hub 认证的 Direct Conversation 接受入口。入站上下文必须已由认证方频道覆写；公开的 `control.promptConversation` 永不接受该上下文，插件也不得伪造它。 |
| `sessionResources?` | 逻辑会话资源的通用目录：不可变逻辑会话 ID、内部/显示别名、权威工作区 `cwd`、归档标记，以及生命周期事件订阅。可选：纯文本频道可忽略。 |
| `commandHints?` | 内置命令目录，供支持输入框命令提示的频道使用。 |
| `coreVersion?` | xacpx 核心版本字符串，供需要它的频道（如命令同步元数据）使用。 |
| `locale?` | 当前运行时语言（`"en"` \| `"zh"`，类型 `Locale`），由 `config.language` 解析得来。用它本地化你的频道输出。详见[国际化](#国际化i18n)。 |

调用 agent：

```ts
const response = await input.agent.chat({
  accountId,                       // 本频道的账号 id
  conversationId: chatKey,         // 你为本次入站消息构造的 `<type>:<...>` chatKey
  text,
  ...(replyContextToken ? { replyContextToken } : {}),
  ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  metadata: { channel: "<type>", chatType: "group", origin: "human" as const },
  reply: async (segment) => { await this.sendText(chatKey, segment); },  // 流式分段
});

if (response.text) await this.sendText(chatKey, response.text);          // 最终回复
```

`ChatRequest` / `ChatResponse` 从 `xacpx/plugin-api` 导出。`reply` 用于流式推送回合中的分段；一旦使用了它，`response.text` 就是最终消息。完整的 `ChatRequest` 还携带 `media`、`humanStopSignal`、`onToolEvent` / `onThought` / `onPlan` / `onUsage` / `onCommands` 旁路通道、`perfSpan`，以及路由元数据（`channelMessageId`、`authenticatedHuman`、`senderId`、`isOwner`、`boundSessionAlias` 等）。完整的入站请求示例见 `src/weixin/messaging/handle-weixin-message-turn.ts`。

`start()` 返回后，保持对 `agent`、`quota` 和 `logger` 的引用直到 `stop?()` / `logout()` 被调用或 `abortSignal` 触发——`start()` 返回后不会再次传入它们。

`start()` 通常是一个长期运行的 Promise，在回调注册完成后返回。消息循环可在后台异步持续运行。

## 国际化（i18n）

xacpx 的界面语言由 `config.language`（`en` | `zh`）控制，缺省按系统 locale 推断。频道插件可以让自己的用户可见文本跟随同一个语言。

**从 `ChannelStartInput.locale` 读取语言**（在 `start(input)` 内，类型 `Locale`，从 `xacpx/plugin-api` 导出）。这是**推荐**来源——核心按值传入，与模块实例无关。

`xacpx/plugin-api` 也导出了 `getLocale()`，但**不要把它当作主来源**：插件包与 daemon 通常各自打包了一份独立的 i18n 状态，`getLocale()` 读到的是插件这一份，未必反映 daemon 的 `config.language`。它只适合作兜底。

**推荐做法**——插件自带一份小型双语目录（不要 import 核心内部的 `src/i18n`）：

```ts
// my-channel/src/i18n.ts
import { getLocale, type Locale } from "xacpx/plugin-api";

const en = { greeting: "Hi", failed: (id: string) => `Task ${id} failed` };
const zh: typeof en = { greeting: "你好", failed: (id) => `任务 ${id} 执行失败` };

let active: Locale | null = null;
export function setChannelLocale(locale: Locale): void { active = locale; }
export function t() { return (active ?? getLocale()) === "zh" ? zh : en; }
```

```ts
// my-channel/src/channel.ts
async start(input: ChannelStartInput): Promise<void> {
  setChannelLocale(input.locale ?? "en");   // 先定语言，再产出任何文本
  // ... 之后用 t().greeting / t().failed(id) 产出用户可见文本
}
```

> 在函数体内调用 `t()`（不要在模块顶层把目录值固定下来），这样语言切换才生效。

**不要本地化“用来匹配”的字符串**：凡是拿来匹配用户输入或外部工具输出的词（例如中文中断词「停止」「取消」、或匹配 acpx 输出的标记），必须是与界面语言无关的固定常量，**不**随 `locale` 切换——中文用户不论界面是什么语言都会打「停止」。

## 回复与媒体

### `OutboundQuota`

```ts
export interface OutboundQuota {
  onInbound(chatKey: string): void;
  reserveMidSegment(chatKey: string): boolean;
  reserveFinal(chatKey: string): boolean;
  finalRemaining(chatKey: string): number;
  hasPendingFinal(chatKey: string): boolean;
  drainPendingFinalUpToBudget(chatKey: string, available: number): PendingFinalChunk[];
  prependPendingFinal(chatKey: string, chunks: PendingFinalChunk[]): void;
  enqueuePendingFinal(chatKey: string, chunks: PendingFinalChunk[]): void;
  clearPendingFinal(chatKey: string): void;
}
```

该抽象源自微信的 24 小时主动消息限制。其他频道（Feishu、Yuanbao）实际上没有配额限制，但 xacpx 对所有频道使用同一个接口门面以简化编排调度。

最常用的两个方法：

- **`onInbound(chatKey)`** — 每次收到用户消息时调用。为该 chatKey 重置 24 小时窗口。
- **`reserveFinal(chatKey)`** — 发送最终回复前调用。返回 `true` 表示可发送；返回 `false` 表示配额已耗尽。`false` 时，将内容加入队列，等下次入站后重试。

非微信频道通常可按如下方式实现出站：

```ts
async sendFinalText(chatKey: string, text: string) {
  if (!this.quota?.reserveFinal(chatKey)) {
    this.quota?.enqueuePendingFinal(chatKey, [{ text }]);
    return;
  }
  await this.gateway.sendText(chatKey, text);
}
```

### `AppLogger`

```ts
export interface AppLogger {
  debug: (event: string, message: string, context?: LogContext) => Promise<void>;
  info: (event: string, message: string, context?: LogContext) => Promise<void>;
  error: (event: string, message: string, context?: LogContext) => Promise<void>;
}
```

使用示例：

```ts
await logger.info("feishu.inbound.message", "received message", { chatKey });
```

规范：
- 事件代码使用 `<channel>.<area>.<verb>` 格式，如 `"feishu.inbound.message"`、`"yuanbao.gateway.connected"`。
- 从 `context` 对象中去除密钥和个人信息（PII）。不要包含 `appSecret` 或用户令牌。
- 守护进程已自动添加时间戳和 PID，无需重复记录。

日志写入 `~/.xacpx/runtime/app.log`，可通过 `xacpx doctor --verbose` 查看。

### `OrchestrationDeliveryCallbacks`

```ts
export interface OrchestrationDeliveryCallbacks {
  markTaskNoticeDelivered: (taskId: string, accountId: string) => Promise<void>;
  markTaskNoticeFailed: (taskId: string, errorMessage: string) => Promise<void>;
}
```

守护进程在应用装配阶段调用 `configureOrchestration(callbacks)`。任务完成通知成功投递到 IM 平台后，调用 `markTaskNoticeDelivered`；投递失败（API 报错、配额超限）时，调用 `markTaskNoticeFailed`。编排服务依靠这些信号避免重启后重复投递。

实现了 `notifyTaskCompletion` 但未实现 `configureOrchestration` 的频道，每个任务都会被视为"从未投递"，可能导致重复通知。

### `ConsumerLock`

```ts
export interface ConsumerLockMetadata {
  pid: number;
  mode: "foreground" | "daemon";
  startedAt: string;
  configPath: string;
  statePath: string;
  hostname?: string;
}

export interface ConsumerLock {
  acquire(meta: ConsumerLockMetadata): Promise<void>;
  release(): Promise<void>;
}

export interface ConsumerLockOptions {
  lockFilePath?: string;
  onDiagnostic?: (event: string, context: Record<string, string | number | boolean | undefined>) => void | Promise<void>;
}
```

当频道使用单点凭据连接到持久网关会话，且多个 xacpx 进程同时连接会导致相互断连时（微信 Web 协议是典型示例），请实现 `createConsumerLock`。纯 HTTP Webhook 或使用独立 Bot ID 的频道（Feishu 自建应用、Yuanbao 多 Bot）无需此功能。

实现注意事项：
- 使用文件锁（`proper-lockfile` 或自定义 `fcntl`）实现物理互斥。
- `acquire` 失败时，抛出带有元数据的错误（参见 `ActiveWeixinConsumerLockError`），以便守护进程在日志中报告"另一进程持有锁，pid=xxx"。
- `release` 必须幂等。
- 核心 runtime 锁先取得，随后为**每一个**提供 lock 的渠道各取得一把 fence（不再只取第一把），按渠道 id 确定顺序严格串行 acquire，部分冲突时按相反顺序回滚；诊断事件前缀使用该渠道自己的 id。
- `options.lockFilePath` 是**按 config 根作用域**的路径（当前 config 根 runtime 目录下的 `<channelId>-consumer.lock.json`）。两份 config 根会拿到不同路径，因此不能用它承载凭据级或全局命名空间。若互斥必须机器全局成立（Discord：每个 Bot Token 只允许一条 Gateway 会话），请自行在用户全局 core home 下派生路径，并忽略注入的 lockFilePath。
- 锁文件元数据不可读时必须 fail-closed：有限次数重读后拒绝启动；绝不要 `rm()` 自己读不懂的锁文件，那等于删除另一个活跃进程的 fence。

参考实现：[`src/weixin/monitor/consumer-lock.ts`](https://github.com/gadzan/xacpx/blob/main/src/weixin/monitor/consumer-lock.ts)（config 作用域）与 [`packages/channel-discord/src/channel.ts` 的 `createConsumerLock()`](https://github.com/gadzan/xacpx/blob/main/packages/channel-discord/src/channel.ts)（用户全局、按 Bot Token）。

## 配置

### `ChannelRuntimeConfig`

```ts
export interface ChannelRuntimeConfig {
  id: string;
  type: string;
  enabled: boolean;
  options?: Record<string, unknown>;
}
```

- `id === type`（多实例支持计划中，暂未提供）。
- `enabled: false` 的频道不会被守护进程实例化，但仍会出现在 `xacpx channel list` 中。
- `options` 是任意 JSON 对象；由工厂解析。建议编写专用的 `parseMyConfig(options): MyConfig` 函数，输入非法时抛出可读的错误，然后让构造函数信任其结果。

`~/.xacpx/config.json` 顶层结构：

```jsonc
{
  "plugins": [
    { "name": "@scope/xacpx-channel-my", "version": "0.1.0", "enabled": true }
  ],
  "channels": [
    { "id": "weixin", "type": "weixin", "enabled": true },
    {
      "id": "my",
      "type": "my",
      "enabled": true,
      "options": { "appKey": "...", "appSecret": "..." }
    }
  ]
}
```

### CLI 提供者

```ts
export interface ChannelCliProvider {
  type: string;
  displayName: string;
  supportsLogin: boolean;
  parseAddArgs(args: string[]): ChannelCliParseResult;
  buildDefaultConfig(input: ChannelCliInput): ChannelRuntimeConfig;
  validateConfig(config: ChannelRuntimeConfig): ChannelCliValidationIssue[];
  renderSummary(config: ChannelRuntimeConfig): string[];
  promptForMissingFields(input: ChannelCliInput, io: ChannelCliIo): Promise<ChannelCliInput>;
}
```

`xacpx channel add <type>` 的所有行为均由 CLI 提供者驱动。各方法契约：

- **`type` / `displayName`** — `type` 必须与 `ChannelPluginDefinition.type` 一致。`displayName` 用于交互式提示（如 `"Feishu"`）。
- **`supportsLogin`** — `true` 表示 `xacpx login` 会触发交互式凭据获取（目前仅微信支持）。`false` 表示所有凭据通过 `channels[].options` 传入。
- **`parseAddArgs(args)`** — 从 `xacpx channel add feishu --app-id x --app-secret y` 解析 CLI 标志。返回 `{ ok: true; input: ChannelCliInput }` 或 `{ ok: false; message: string }`。不要抛出异常——错误一律使用 `ok: false`。遇到未识别的标志必须立即返回 `ok: false`。
- **`buildDefaultConfig(input)`** — 将已填充完整的 `ChannelCliInput` 转换为适合写入 `~/.xacpx/config.json` 的 `ChannelRuntimeConfig`。`id` 必须等于 `type`。
- **`validateConfig(config)`** — 返回验证问题数组（不要抛出异常）。两种类型：`{ kind: "missing-required-field"; flag: string; message: string }` 和 `{ kind: "invalid-config"; message: string }`。`missing-required-field` 的 `flag` 字段是缺失的 CLI 标志（如 `"--app-id"`）。
- **`renderSummary(config)`** — 返回 `xacpx channel show <type>` 的显示行。**密钥字段必须显示为 `***`**，不得明文打印。
- **`promptForMissingFields(input, io)`** — 仅在 `io.isInteractive()` 为 `true` 时调用。使用 `io.promptText` / `io.promptSecret` 填充缺失字段。`promptSecret` 不会在终端回显。

辅助类型：

```ts
export type ChannelCliInput = Record<string, string | boolean | undefined>;

export interface ChannelCliIo {
  print: (line: string) => void;
  stderr: (text: string) => void;
  isInteractive: () => boolean;
  promptText: (message: string) => Promise<string>;
  promptSecret: (message: string) => Promise<string>;
}
```

`parseBooleanFlag` 和 `takeFlagValue` 辅助函数**当前未**从 `xacpx/plugin-api` 运行时导出。两个官方插件（`@ganglion/xacpx-channel-yuanbao`、`@ganglion/xacpx-channel-feishu`）各自携带私有副本——直接复制 [`packages/channel-yuanbao/src/yuanbao-provider.ts`](https://github.com/gadzan/xacpx/blob/main/packages/channel-yuanbao/src/yuanbao-provider.ts) 的前约 10 行即可。

### ChatKey 约定

`chatKey` 是跨所有频道的全局唯一会话标识符：

```
<channelId>:<channel-internal-id>
```

示例：
- 微信：`weixin:<accountId>:<userId>`（群聊：`weixin:<accountId>:group:<groupId>`）
- 飞书：`feishu:<accountId>:<chatId>`（话题：`feishu:<accountId>:<chatId>:thread:<threadId>`）
- 元宝：`yuanbao:<accountId>:<chatType>:<target>`（`chatType` 为 `direct` 或 `group`）

频道必须：
1. 为入站消息构造 `<type>:<...>` 格式的 chatKey，并作为 `conversationId` 传入 `agent.chat(request)` 对象。
2. 在将 chatKey 转换回内部 ID 用于出站消息时，去掉 `<type>:` 前缀。
3. 在 `notifyTaskCompletion` 等回调中，先检查 `task.chatKey` 是否以 `<type>:` 开头再处理——否则立即返回（守护进程会向所有频道广播）。

## 测试插件

最低推荐测试覆盖：

1. **单元层**（无 xacpx 依赖）：配置解析/验证函数、消息编解码、签名算法、chatKey 的构造与解析。
2. **CLI 提供者单元测试**：向 `parseAddArgs` 传入各种参数组合并断言结果 `ChannelCliInput`；向 `validateConfig` 传入故意残缺的配置并断言问题列表。
3. **频道契约测试**：实例化 `MyChannel(options)`，注入假的 `ChannelStartInput`（模拟 `OutboundQuota` 和 `AppLogger`），断言一条入站消息能到达假的 `agent.chat`。
4. **集成层**（可选）：在测试中运行 `runCli(["channel", "add", "<type>", ...])`，断言 `~/.xacpx/config.json` 被正确写入。

示例参见 `tests/unit/packages/channel-feishu/feishu-start-wiring.test.ts` 和 `tests/unit/channels/channel-plugin.test.ts`。

### 启动时的验证规则

守护进程会验证每个导入的插件（`src/plugins/validate-plugin.ts`）。任何验证失败都会拒绝注册并给出可操作的错误信息：

| 检查项 | 失败信息 |
| --- | --- |
| `apiVersion === 1` | `unsupported plugin apiVersion` |
| `name`（若设置）必须与 npm 包名一致 | `plugin name does not match package name` |
| 每个频道 `type` 不为空且不含 `:` | `channel type must be non-empty / must not contain ":"` |
| 单个插件内无重复 `type` | `plugin registers duplicate channel type` |
| 同一进程中没有两个插件注册相同的 `type` | `channel type ... is already provided by ...` |
| 不可覆盖内置 `weixin` 类型 | `channel type is already registered: weixin` |

CLI 不会自动禁用验证失败的插件。用户须手动运行 `xacpx plugin disable <name>` 或修复问题后重新运行 `xacpx plugin doctor`。

### plugin doctor 诊断

`xacpx plugin doctor` 输出（来自 `src/plugins/plugin-doctor.ts`）：

| 级别 | 消息模式 | 含义/操作 |
| --- | --- | --- |
| `error` | `package not installed in plugin home; run xacpx plugin add <name>` | 插件已在配置中声明但未安装。重新安装。 |
| `error` | `failed to import plugin: ...` | 包已安装但导入失败。查看调用栈——通常是依赖版本冲突或缺少 `dist`。 |
| `error` | `unsupported plugin apiVersion` | 验证失败。 |
| `error` | `channel type X is already provided by ...` | 两个插件声明了相同类型。移除其中一个。 |
| `error` | `channel X is configured but no enabled plugin provides it` | 配置中引用了某频道但无匹配的已启用插件。运行 `xacpx plugin add` 或 `xacpx plugin enable`。 |
| `warn` | `plugin is installed and valid but disabled; run xacpx plugin enable` | 已安装但 `enabled: false`。 |
| `error` | `channel X is configured but provider plugin is disabled` | 频道已配置但提供者插件被禁用——守护进程启动将失败。运行 `plugin enable` 或 `channel disable`。 |
| `ok` | `plugin is installed and valid; channels: ...` | 健康。 |

在运行 `xacpx restart` 之前，使用此表验证插件是否达到 `ok` 状态。

## 发布插件

### 官方插件命名

官方插件路径为 `packages/channel-<type>/`，发布为 `@ganglion/xacpx-channel-<type>`。第三方插件可使用任意 npm 包名，但若设置了 `XacpxPlugin.name`，**必须**与 npm 包名完全一致。

`xacpx plugin known` 列出的官方插件：

```text
- feishu   @ganglion/xacpx-channel-feishu   Feishu channel
- yuanbao  @ganglion/xacpx-channel-yuanbao  Tencent Yuanbao channel
- discord  @ganglion/xacpx-channel-discord  Discord channel
- relay    @ganglion/xacpx-channel-relay    Relay hub connector (drive this instance from a self-hosted relay hub)

安装：
  xacpx plugin add <package>
```

第三方插件通过 npm 本身发现（搜索/GitHub/README），不出现在 `plugin known` 中。若你发布第三方频道插件，请在 README 中直接提供 `xacpx plugin add <your-package-name>` 命令。

### 发布前检查清单

- `dist/` 中同时包含 `.js` 和 `.d.ts` 文件。
- `peerDependencies.xacpx` 使用 `>=x.y`（而非 `^x.y`），避免锁定次要版本。
- `peerDependenciesMeta.xacpx.optional = true`（否则 npm 可能尝试将 xacpx 安装到插件目录中）。
- 发布产物仅从 `xacpx/plugin-api` 导入。可用 `bunx publint` 验证。
- 纯 ESM：`"type": "module"`。

### 插件生命周期 CLI 命令

| 阶段 | 命令 | 效果 |
| --- | --- | --- |
| 安装 | `xacpx plugin add <pkg> [--version <v>]` | 将包 `bun add` / `npm install` 到 `~/.xacpx/plugins`，导入并验证，写入 `plugins[]` |
| 升级 | `xacpx plugin update <pkg> [--version <v>]` 或 `--all` | 重新安装，重新导入并验证；`--version` 更新 `plugins[].version` |
| 检查 | `xacpx plugin doctor [<pkg>]` | 对每个插件和频道进行只读健康报告 |
| 禁用 | `xacpx plugin disable <pkg>` | 将 `plugins[].enabled` 设为 `false`；包保留已安装状态 |
| 重新启用 | `xacpx plugin enable <pkg>` | 将 `enabled` 设为 `true` |
| 移除 | `xacpx plugin remove <pkg>`（别名：`rm`） | 卸载 npm 包并从 `plugins[]` 中移除；**不会**自动从 `channels[]` 中移除 |
| 频道 | `xacpx channel add/rm/enable/disable/show/list <type>` | 通过插件的 `cliProvider`（若提供）修改 `channels[]` |
| 激活 | `xacpx restart` | 守护进程重新导入所有已启用的插件 |

每个插件命令均接受 `--restart` / `--no-restart`；交互式终端默认弹出提示。

### 模块缓存语义

守护进程在启动序列的第 3 步导入每个插件，**模块对象在守护进程整个生命周期内缓存**。`xacpx plugin update` 只改变磁盘内容——运行中的守护进程在 `xacpx restart` 之前不会加载新代码。

`plugin add/update/remove` CLI 命令在一个独立的短生命周期 Node 进程中运行，因此其导入验证使用磁盘上的版本。"CLI 显示有效"到"守护进程实际加载新版本"之间，恰好差一次 `xacpx restart`。

### 回滚行为

| 失败点 | 行为 | 恢复方式 |
| --- | --- | --- |
| `plugin add` 导入失败 | CLI 立即报错；**配置不写入** | 修复包或尝试不同的 `--version` |
| `plugin add` 验证失败 | CLI 立即报错；**配置不写入** | 修复插件元数据 |
| 跨插件类型冲突 | `add` 时不检测；由 `plugin doctor` 或守护进程启动时捕获 | 每次安装后运行 `xacpx plugin doctor` |
| `plugin update` 导入/验证失败 | CLI 报错；若 `plugins[].version` 已设置，回滚到之前版本 | 查看错误；手动 `xacpx plugin add <pkg>` 回到最新版 |
| 守护进程启动导入失败 | 守护进程退出；错误写入 `~/.xacpx/runtime/app.log` | 运行 `xacpx plugin doctor`；用 `plugin disable <name>` 临时绕过 |
| `channel add` cliProvider 验证失败 | CLI 报告缺失的字段 | 补充缺失的字段 |

### 参考实现

| 包 | 路径 | 重点学习内容 |
| --- | --- | --- |
| `@ganglion/xacpx-channel-feishu` | `packages/channel-feishu/` | 标准 OAuth2/自建应用、HTTP Webhook、@提及处理、群聊/私聊路由 |
| `@ganglion/xacpx-channel-yuanbao` | `packages/channel-yuanbao/` | 长连接 WebSocket、自定义签名、消息去重、心跳通知 |
| 内置 `weixin` | [`src/channels/weixin-channel.ts`](https://github.com/gadzan/xacpx/blob/main/src/channels/weixin-channel.ts) | 唯一 `supportsLogin: true` 且实现 `ConsumerLock` 的频道 |

每个官方包均包含 `src/index.ts`（插件入口）+ `src/channel.ts`（运行时）+ `src/<type>-provider.ts`（CLI 提供者）。并行阅读是理解模式的最快方式。
