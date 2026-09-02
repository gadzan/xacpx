# xacpx 频道插件开发参考

> 面向开发者的插件 API 参考手册。所有可用类型、方法、字段、错误码都列在这里。
> 用户向导请看 [docs/channel-management.md](./channel-management_zh.md)。

`xacpx` 把消息频道做成了 npm 插件。一个频道插件就是一个 npm 包，默认导出一个 `XacpxPlugin`（旧名 `WeacpxPlugin` 仍可用），里面声明若干个 `ChannelPluginDefinition`。daemon 在启动时会读 `~/.xacpx/config.json` 里的 `plugins[]`，从 `~/.xacpx/plugins/node_modules/<plugin-name>` 动态 import 插件包，注册其频道工厂和 CLI provider。

> **改名说明（0.8.0）：** 项目已从 `weacpx` 改名为 `xacpx`。请从 `xacpx/plugin-api` 导入，peer 依赖用 `xacpx`，并优先使用新名 `XacpxPlugin` / `minXacpxVersion` / `compatibleXacpxVersions`。为向后兼容，旧名 `WeacpxPlugin` / `minWeacpxVersion` / `compatibleWeacpxVersions` 仍被核心读取（两者同时声明时新名优先），已发布的老插件无需改动即可继续工作。本文档下方示例仍沿用旧名以减少改动，等价替换为新名即可。

---

## 目录

- [谁应该看这份文档](#谁应该看这份文档)
- [快速开始：最小可运行插件](#快速开始最小可运行插件)
- [工程结构](#工程结构)
- [1. 插件入口：`WeacpxPlugin`](#1-插件入口weacpxplugin)
- [2. 频道注册：`ChannelPluginDefinition`](#2-频道注册channelplugindefinition)
- [3. 频道工厂：`ChannelFactory`](#3-频道工厂channelfactory)
- [4. 频道运行时：`MessageChannelRuntime`](#4-频道运行时messagechannelruntime)
- [5. 启动上下文：`ChannelStartInput`](#5-启动上下文channelstartinput)
- [6. 出站配额：`OutboundQuota`](#6-出站配额outboundquota)
- [7. 应用日志：`AppLogger`](#7-应用日志applogger)
- [8. 编排回调：`OrchestrationDeliveryCallbacks`](#8-编排回调orchestrationdeliverycallbacks)
- [9. 消费者锁：`ConsumerLock`](#9-消费者锁consumerlock)
- [10. CLI provider：`ChannelCliProvider`](#10-cli-providerchannelcliprovider)
- [11. CLI provider 辅助类型](#11-cli-provider-辅助类型)
- [12. 配置形态：`ChannelRuntimeConfig`](#12-配置形态channelruntimeconfig)
- [13. ChatKey 与 channelId 约定](#13-chatkey-与-channelid-约定)
- [14. 校验规则](#14-校验规则)
- [15. plugin doctor 诊断](#15-plugin-doctor-诊断)
- [16. 端到端生命周期](#16-端到端生命周期)
- [17. 发布契约](#17-发布契约)
- [18. 测试建议](#18-测试建议)
- [19. 参考实现](#19-参考实现)

---

## 谁应该看这份文档

- 想为 xacpx 增加一个新频道（飞书、Discord、Slack、微信公众号 …）的开发者
- 想把现有 IM 系统接入 xacpx 编排能力的工程
- 想在自己的私有部署里 fork / 扩展频道行为的人

如果你只是消费方（安装并使用别人写好的频道），看 [docs/channel-management.md](./channel-management_zh.md) 就够了。

---

## 快速开始：最小可运行插件

```ts
// src/index.ts
import type {
  ChannelStartInput,
  CoordinatorMessageInput,
  MessageChannelRuntime,
  WeacpxPlugin,
} from "xacpx/plugin-api";

class HelloChannel implements MessageChannelRuntime {
  readonly id = "hello";

  isLoggedIn(): boolean { return true; }
  async login(): Promise<string> { return "hello credentials configured"; }
  logout(): void {}

  async start(_: ChannelStartInput): Promise<void> {
    // 接收消息：调用 input.agent.handle(chatKey, text)
    // 发送消息：保留 input.agent 的引用，由你的网关回调驱动
  }

  async notifyTaskCompletion(): Promise<void> {}
  async notifyTaskProgress(): Promise<void> {}
  async sendCoordinatorMessage(_: CoordinatorMessageInput): Promise<void> {}
}

const plugin: WeacpxPlugin = {
  apiVersion: 1,
  name: "xacpx-channel-hello",
  minWeacpxVersion: "0.3.3",
  channels: [
    {
      type: "hello",
      factory: (options) => new HelloChannel(),
    },
  ],
};

export default plugin;
```

最小包结构：

```
xacpx-channel-hello/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

在装有 xacpx 的环境里：

```bash
xacpx plugin add ./path/to/xacpx-channel-hello   # 或者 npm 包名
xacpx plugin doctor
xacpx channel add hello
xacpx restart
```

跑通这条链路后，再开始往 `MessageChannelRuntime` 里填业务逻辑。

---

## 工程结构

推荐的目录与文件：

```
my-channel/
├── package.json           # name, peerDependencies: { xacpx: ">=0.3.x" }
├── tsconfig.json          # extends xacpx 顶层 tsconfig（一方包）或独立配置
├── README.md
├── src/
│   ├── index.ts           # default export WeacpxPlugin
│   ├── channel.ts         # implements MessageChannelRuntime
│   ├── cli-provider.ts    # implements ChannelCliProvider（可选但强推）
│   ├── config.ts          # 解析 / 校验 options
│   └── ...                # 网关、签名、消息编解码等
└── dist/                  # 发布产物（src 不发布）
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
  "peerDependencies": { "xacpx": ">=0.3.3" },
  "peerDependenciesMeta": { "xacpx": { "optional": true } }
}
```

`xacpx` 声明为 peer，且 `optional`：开发时本地装一份，用户运行时由 xacpx 主体提供。所有 import 必须从 `xacpx/plugin-api` 走，**禁止**从 `xacpx/dist/*` 或 `src/*` 取符号——那些是内部实现，不属于稳定 API 表面。

---

## 1. 插件入口：`WeacpxPlugin`

```ts
import type { WeacpxPlugin } from "xacpx/plugin-api";
import {
  WEACPX_PLUGIN_API_VERSION,
  WEACPX_PLUGIN_MIN_CORE_VERSION,
} from "xacpx/plugin-api";

export interface WeacpxPlugin {
  apiVersion: 1;
  name?: string;
  minWeacpxVersion?: string;
  compatibleWeacpxVersions?: string;
  channels?: ChannelPluginDefinition[];
}

const plugin: WeacpxPlugin = {
  apiVersion: WEACPX_PLUGIN_API_VERSION,        // 当前固定为 1
  minWeacpxVersion: WEACPX_PLUGIN_MIN_CORE_VERSION, // 例如 "0.3.3"
  channels: [/* ... */],
};

export default plugin;
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `apiVersion` | 是 | 当前必须是字面量 `1`。xacpx 后续 breaking change 会升 API 版本。从 `WEACPX_PLUGIN_API_SUPPORTED_VERSIONS` 可读到当前 xacpx 接受的版本集合。 |
| `name` | 否 | 显式声明插件名。如果填了，必须等于安装时的 npm 包名（含 scope），否则启动校验会拒绝。 |
| `minWeacpxVersion` | 推荐 | 该插件能正常工作的 **xacpx 核心最小版本**（如 `"0.3.3"`）。当前 xacpx 低于这个版本时，插件加载会失败并提示 `upgrade xacpx`。第一方插件必须声明；第三方插件强烈建议声明。 |
| `compatibleWeacpxVersions` | 否 | 显式 xacpx 兼容范围；支持 `x.y.z` / `>=x.y.z` / `^x.y.z`。和 `minWeacpxVersion` 同时声明则两者都需满足。 |
| `channels` | 否 | 频道定义列表。允许为空（保留给未来非频道扩展点）。 |

约束：

- 必须用**默认导出**（`export default plugin`）。命名导出无效。
- 模块在 daemon 进程里只 import 一次；不要在顶层有副作用（计时器、全局监听器等）。

### 兼容性错误与对应处理

加载/校验时可能产生的兼容性错误及修复方向：

| 错误关键词 | 含义 | 用户应做的事 |
| --- | --- | --- |
| `requires xacpx >=X.Y.Z; ... upgrade xacpx` | 插件比当前 xacpx 新 | 升级 `xacpx` 到 ≥ 该版本，或换装与当前 xacpx 兼容的旧插件版本 |
| `apiVersion N; supported: ...; install a compatible plugin` | 插件用的是 xacpx 不识别的 API 版本 | 升级或降级**插件**到与本地 `xacpx` 兼容的版本 |
| `invalid plugin metadata` | `minWeacpxVersion` / `compatibleWeacpxVersions` 字段非法 | 联系插件作者或检查发布元数据 |

`xacpx plugin doctor` 也会把这些错误以 `ERROR <plugin>: ...` 的形式打印出来，可以放在 CI 或发布流程里作为前置检查。

---

## 2. 频道注册：`ChannelPluginDefinition`

```ts
export interface ChannelPluginDefinition {
  type: string;
  factory: ChannelFactory;
  cliProvider?: ChannelCliProvider;
  retireChannel?: (ctx: ChannelRetireContext) => Promise<void>;
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `type` | 是 | 频道类型字符串，例如 `"feishu"`、`"yuanbao"`。同一进程内全局唯一。 |
| `factory` | 是 | 工厂函数，daemon 启动时调用，用于实例化 `MessageChannelRuntime`。 |
| `cliProvider` | 否 | `xacpx channel add <type>` 的解析与提示逻辑。不提供时用户必须手改 `~/.xacpx/config.json`。强烈建议提供。 |
| `retireChannel` | 否 | `xacpx channel disable` / `xacpx channel rm` 的 CLI 生命周期钩子。core 在已加载插件中按频道类型查找，不会自行 import 插件 npm 包。用于一次性资源清理（例如 process-owned 终端）。钩子会收到 `print` 和 `getDaemonStatus`；若 daemon 仍在运行，可能需要推迟到重启再清理。 |

`type` 约束：

- 非空，且不能含 `:`（chatKey 用 `:` 分隔）。
- 不能与已注册类型重复（`weixin` 始终被内置占用）。
- 不能与 `cliProvider.type` 不一致（如果声明了 cliProvider）。

---

## 3. 频道工厂：`ChannelFactory`

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

参数：

| 参数 | 含义 |
| --- | --- |
| `options` | `channels[].options`，由用户配置或 `cliProvider.buildDefaultConfig` 写入。**未经类型校验**，工厂内部要自己 parse。 |
| `deps.mediaStore` | xacpx 提供的临时媒体落盘工具。处理图片/文件附件时用。 |
| `deps.allowedMediaRoots` | 已注册 workspace 的 cwd 集合。决定哪些目录允许把 agent 输出的本地文件作为出站附件。 |

工厂应当在这一步**只做参数解析与状态初始化**：不要打开网络连接、读外部 token。所有副作用留到 `start()`。这样可以让 doctor / dry-run 安全 import。

例：

```ts
factory: (options) => new MyChannel(options)

class MyChannel implements MessageChannelRuntime {
  private readonly config: MyConfig;
  constructor(options: Record<string, unknown> | undefined) {
    this.config = parseMyConfig(options); // throw 不合法配置
  }
  // ...
}
```

---

## 4. 频道运行时：`MessageChannelRuntime`

```ts
export interface MessageChannelRuntime {
  id: string;

  isLoggedIn(): boolean;
  login(): Promise<string>;
  logout(): void;

  start(input: ChannelStartInput): Promise<void>;

  stop?(): void | Promise<void>;

  createConsumerLock?(options?: ConsumerLockOptions): ConsumerLock;
  configureOrchestration?(callbacks: OrchestrationDeliveryCallbacks): void;

  notifyTaskCompletion(task: OrchestrationTaskRecord): Promise<void>;
  notifyTaskProgress(task: OrchestrationTaskRecord, text: string): Promise<void>;
  sendCoordinatorMessage(input: CoordinatorMessageInput): Promise<void>;
}
```

### `id: string`

频道实例的唯一 id。xacpx 当前要求 `id === type`，因此一般写成 `readonly id = "<type>"`。日志里会用它来标记上下文。

### `isLoggedIn(): boolean`

同步、纯函数。返回当前是否拥有可用凭据。daemon 启动前会调用一次决定是否需要走 `login()`。

### `login(): Promise<string>`

非交互式频道（OAuth、appKey/appSecret）通常返回一段提示信息：

```ts
async login(): Promise<string> {
  if (this.isLoggedIn()) return "credentials configured";
  throw new Error("Provide options.appKey and options.appSecret in channels[].options");
}
```

交互式频道（微信扫码）才需要在这里执行二维码流程并阻塞到登录成功。如果你的频道**永远不需要交互式登录**，把 `cliProvider.supportsLogin` 设为 `false`。

### `logout(): void`

**破坏性操作**：删除已保存的凭据、断开持久连接、清空内存里的会话。只有用户显式执行 `xacpx logout` 才会走到这里——正常的 daemon shutdown 不会调用它。**必须可重入。**

唯一的遗留例外：频道**没有**实现 `stop()` 时，daemon 关停路径会回退调用 `logout()`。如果你依赖这个回退，`logout()` 里就不能删除任何需要用户重新交互获取的东西（重新登录、重新扫码）。新插件应实现 `stop()`，并把凭据删除逻辑只放在 `logout()` 里。

### `start(input: ChannelStartInput): Promise<void>`

频道开始接收消息的入口。详情见 [§5](#5-启动上下文channelstartinput)。

要求：

- 把消息推送给 `input.agent.handle(chatKey, text)`。
- 监听 `input.abortSignal`，收到 abort 后干净地停掉网关、关闭长连接、清队列。
- 调发送类操作前先用 `input.quota` 预留配额（详见 [§6](#6-出站配额outboundquota)）。
- 任何外发都通过 `input.logger` 记录关键事件，方便用户用 `xacpx doctor --verbose` / `app.log` 排查。

`start()` 通常是个长运行 promise——返回时意味着你已经 wire 好回调，但消息循环可以是后台异步。

### `stop?(): void | Promise<void>`

可选，**推荐实现**。非破坏性的关停钩子：每次 daemon 关停（SIGTERM / Ctrl-C 以及启动失败的 cleanup）时，registry 优先调用 `stop()`，只有它不存在时才回退到 `logout()`。在这里释放运行时资源——停掉客户端、丢弃 `agent` / `quota` / `logger` 引用、清队列——但**绝不能动磁盘上的凭据**：daemon 停止或重启不应迫使用户重新登录。注意 `stop()` 执行时 `abortSignal` 通常已经触发过，所以它往往只是一小段收尾（甚至可以是 no-op）。

### `createConsumerLock?(options?): ConsumerLock`

可选。如果你的频道需要**整机互斥**（同一个微信号不能被两个 xacpx 进程同时连），实现这个方法。详见 [§9](#9-消费者锁consumerlock)。

### `configureOrchestration?(callbacks)`

可选。daemon 在 wire 编排服务时调用，给你两个回调：`markTaskNoticeDelivered` 和 `markTaskNoticeFailed`。如果你的频道支持任务完成通知（`notifyTaskCompletion`），需要保存这两个回调，在送达成功 / 失败时调用以更新 orchestration 状态。详见 [§8](#8-编排回调orchestrationdeliverycallbacks)。

### `notifyTaskCompletion(task): Promise<void>`

被编排服务调用，通知用户某个 worker 任务已完成。`task.chatKey` 是路由目标。如果送达成功，调用 `markTaskNoticeDelivered(task.taskId, accountId)`；失败调用 `markTaskNoticeFailed(task.taskId, errorText)`。

实现要点：

- 如果 `task.chatKey` 不属于你的频道（看 prefix 判断），**直接返回**，不要报错。daemon 会广播给所有频道。
- 内容生成可借用 xacpx 的 `renderTaskCompletion`（如果暴露了）或自己拼。
- 注意配额：`notifyTaskCompletion` 算 final 出站，建议先 `quota.reserveFinal(chatKey)`。

### `notifyTaskProgress(task, text): Promise<void>`

任务心跳通知（默认 60s 一次）。语义同上，但受 `progressHeartbeatSeconds` 控制，且通常不预留 final 配额。如果你的频道不支持中间心跳，写空实现即可。

### `sendCoordinatorMessage(input: CoordinatorMessageInput): Promise<void>`

```ts
export interface CoordinatorMessageInput {
  coordinatorSession: string;
  chatKey: string;
  accountId?: string;
  replyContextToken?: string;
  text: string;
}
```

编排服务向 coordinator 会话所在频道发文本时调用。语义类似 `notifyTaskCompletion` 的简化版。`replyContextToken` 是回复上下文（飞书/yuanbao 用来 quote 父消息），可忽略。

---

## 5. 启动上下文：`ChannelStartInput`

```ts
export interface ChannelStartInput {
  agent: ChatAgent;
  abortSignal: AbortSignal;
  quota: OutboundQuota;
  logger: AppLogger;
  // 可选字段（核心按需注入）：
  commandHints?: CommandHint[];   // xacpx 内置命令目录，供输入框命令提示用
  coreVersion?: string;           // xacpx 核心版本字符串
  locale?: Locale;                // 当前运行时语言（"en" | "zh"），见 §5.1 国际化
}
```

| 字段 | 用途 |
| --- | --- |
| `agent` | xacpx 路由器入口。你收到一条文本消息后，调 `agent.handle(chatKey, text)` 把它喂给命令路由。 |
| `abortSignal` | daemon shutdown 信号。监听 `aborted` 事件，停掉所有长连接和定时器。 |
| `quota` | 出站速率/总量配额，详见下节。 |
| `logger` | 结构化日志器，详见 [§7](#7-应用日志applogger)。 |
| `commandHints?` | xacpx 内置命令目录，供支持输入框命令提示的频道使用。 |
| `coreVersion?` | xacpx 核心版本字符串，供需要它的频道（如命令同步元数据）使用。 |
| `locale?` | 当前运行时语言（`"en"` \| `"zh"`，类型 `Locale`），由 `config.language` 解析得来。用它本地化你的频道输出，见 [§5.1](#51-国际化i18n)。 |

`ChatAgent` 接口本身在内部，但通过 `MessageChannelRuntime` 的契约只要求你把入站文本 `await agent.handle(chatKey, text)` 即可。返回不带数据；agent 会在自己的回调链里调你的发送方法。

> **重要**：你的频道要持有一份 `agent` / `quota` / `logger` 引用直到 `stop()` / `logout()` 或 `abortSignal` 触发。`start()` 返回后这些不会再传一次。

### 5.1 国际化（i18n）

xacpx 的界面语言由 `config.language`（`en` | `zh`）控制，缺省按系统 locale 推断。频道插件可以让自己的用户可见文本跟随同一个语言。

**获取语言**：在 `start(input)` 里读 `input.locale`（类型 `Locale`，从 `xacpx/plugin-api` 导出）。这是**推荐**的来源——它是核心按值传进来的，与模块实例无关。

`xacpx/plugin-api` 也导出了 `getLocale()`，但**不要把它当作主来源**：插件包通常与 daemon 各自打包了一份独立的 i18n 状态，`getLocale()` 读到的是插件这一份，未必反映 daemon 的 `config.language`。它只适合作兜底。

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

---

### 5.2 文本频道的子代理提示（`formatSubagentNotice` / `SubagentNoticeTracker`）

当一轮对话触发子代理（`Agent` / `Task` 委派）时，传输层会给对应的工具事件打上 `isSubagent: true`（若 provider 提供，还会带 `parentToolCallId`）。飞书卡片、Web 面板这类富频道会把它们折叠成嵌套轨迹；纯文本频道（微信、元宝）渲染不了，因此 `xacpx/plugin-api` 导出两个 helper，把轨迹降级为“每次委派一行”的诚实呈现：

```ts
import { SubagentNoticeTracker, formatSubagentNotice, type ToolUseEvent } from "xacpx/plugin-api";

// 每一轮对话只建一个 tracker（不是每个事件建一个），把该轮的每个工具事件都喂给它。
const notices = new SubagentNoticeTracker();

const request = {
  // ...
  onToolEvent: (event: ToolUseEvent) => {
    const line = notices.notice(event); // → "↳ [subagent] <task> (running)" 或 null
    if (line) void sendLine(line);       // 你的频道自己的前台门控发送
  },
};
```

- `SubagentNoticeTracker.notice(event)` **只**对 `isSubagent` 事件返回一行，且**同一个 `toolCallId` 最多一行**——首次出现时输出，之后的所有帧（包括终止帧）都被吞掉，所以 `running → success` 不会重复出两行。普通工具调用一律返回 `null`，避免刷屏。
- `formatSubagentNotice(event)` 是它背后的无状态格式化函数（优先取 `event.summary`，退回 `toolName`，超长标题会截断）。只有当你需要自定义去重时才直接用它。
- 这两个 helper 绝不会编造无法证实的子步骤——它们只呈现委派本身。

---

## 6. 出站配额：`OutboundQuota`

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

来源：微信公众号 24 小时主动消息上限的抽象。其它频道（飞书、yuanbao）配额无限，但 xacpx 对所有频道用同一套门面，便于 orchestration 调度。

最常用的两个：

- **`onInbound(chatKey)`**：用户发了一条消息进来时调用。重置该 chatKey 的 24h 窗口。
- **`reserveFinal(chatKey)`**：发"最终回复"前调用，返回 `true` 才能发；返回 `false` 表示配额耗尽，应该 enqueue 等下一个 inbound 触发后再发。

非微信频道一般可以直接：

```ts
async sendFinalText(chatKey: string, text: string) {
  if (!this.quota?.reserveFinal(chatKey)) {
    this.quota?.enqueuePendingFinal(chatKey, [{ text }]);
    return;
  }
  await this.gateway.sendText(chatKey, text);
}
```

详细语义见 `src/weixin/messaging/quota-manager.ts` 的注释。

---

## 7. 应用日志：`AppLogger`

`AppLogger.info / .warn / .error` 都是异步的，签名形如：

```ts
await logger.info(eventCode: string, message: string, fields?: Record<string, unknown>): Promise<void>
```

约定：

- `eventCode` 用 `<channel>.<area>.<verb>` 风格，如 `"feishu.inbound.message"`、`"yuanbao.gateway.connected"`。便于聚合查询。
- `fields` 不要塞密钥/PII。`appSecret`、用户 token 必须显式过滤。
- daemon 已经帮你打时间戳和 pid，不要重复。

日志最终落到 `~/.xacpx/runtime/app.log`，并由 `xacpx doctor --verbose` 抓取。

---

## 8. 编排回调：`OrchestrationDeliveryCallbacks`

```ts
export interface OrchestrationDeliveryCallbacks {
  markTaskNoticeDelivered: (taskId: string, accountId: string) => Promise<void>;
  markTaskNoticeFailed: (taskId: string, errorMessage: string) => Promise<void>;
}
```

daemon 在 buildApp 阶段调用 `configureOrchestration(callbacks)` 把这两个函数交给你。意义：

- 当你成功把"任务完成通知"投递到 IM 平台后，调 `markTaskNoticeDelivered(taskId, accountId)`。orchestration 服务会把 task 的 `noticeSentAt` 落盘，避免重启后重复投递。
- 投递失败（接口报错、配额超限），调 `markTaskNoticeFailed(taskId, errorMessage)`。orchestration 会在下一次 inbound / 重启后 replay。

未实现 `configureOrchestration` 的频道，所有 task 通知都会被认为"未送达"，可能导致重复投递。如果你的频道支持 `notifyTaskCompletion`，**强烈建议同时实现 `configureOrchestration`**。

---

## 9. 消费者锁：`ConsumerLock`

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

什么时候要实现：你的频道**用单点凭据连接到一个长会话网关**，多个 xacpx 进程同时连会被对端踢下线（典型：微信 web 协议）。

不需要实现的情况：纯 HTTP webhook、有独立 bot id 的应用（飞书自建应用、yuanbao 多 bot）。

实现要点：

- 用文件锁（`proper-lockfile` / 自家 fcntl）做物理互斥。
- `acquire` 失败时抛带元信息的错（参考 `ActiveWeixinConsumerLockError`），让 daemon 能在日志里告诉用户"另一个进程持有锁，pid=xxx"。
- `release` 必须幂等。
- 核心 runtime 锁先取得，随后为**每一个**提供 lock 的渠道各取得一把 fence（不再只取第一把），
  按渠道 id 确定顺序严格串行 acquire，部分冲突时按相反顺序回滚；诊断事件前缀使用该渠道自己的 id。
- `options.lockFilePath` 是**按 config 根作用域**的路径（当前 config 根 runtime 目录下的
  `<channelId>-consumer.lock.json`）。两份 config 根会拿到不同路径，所以**不能**用它承载
  凭据级/全局命名空间。若互斥必须机器全局成立（Discord：每个 bot token 只允许一个 Gateway 会话），
  自行在用户全局 core home 下派生路径，忽略注入的 lockFilePath。
- 锁文件元信息不可读时必须 fail-closed：有限次数重读后拒绝启动；**绝不** `rm()` 自己读不懂的锁文件，
  那等于删掉另一个活进程的 fence。
- 参考实现：`src/weixin/monitor/consumer-lock.ts`（config 作用域）与
  `packages/channel-discord/src/channel.ts` 的 `createConsumerLock()`（用户全局、按 bot token）。

---

## 10. CLI provider：`ChannelCliProvider`

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

`xacpx channel add <type>` 的全部行为由 cliProvider 决定。每个方法的契约：

### `type / displayName`

- `type` 必须等于 `ChannelPluginDefinition.type`。
- `displayName` 用于交互式提示，例如 `"Feishu"`。

### `supportsLogin: boolean`

- `true`：需要 `xacpx login` 走交互式凭据获取（目前仅微信）。
- `false`：所有凭据通过 `channels[].options` 配置。

### `parseAddArgs(args): ChannelCliParseResult`

把 `xacpx channel add feishu --app-id x --app-secret y` 中 `--app-id x --app-secret y` 这一串解析成 `ChannelCliInput`（key/value 字典）。返回：

```ts
| { ok: true; input: ChannelCliInput }
| { ok: false; message: string }   // 用于直接打到 stderr
```

要求：

- 未识别的 flag 立刻 `{ok: false}`。
- 布尔类 flag 用 `parseBooleanFlag(value, flagName)`（参考 yuanbao-provider 写法）。
- 不要在这里 throw —— 错误必须用 `ok:false` 报。

### `buildDefaultConfig(input): ChannelRuntimeConfig`

把 `ChannelCliInput`（已含交互补全的字段）转成 `~/.xacpx/config.json` 写入用的 `ChannelRuntimeConfig`：

```ts
{
  id: "feishu",
  type: "feishu",
  enabled: true,
  options: { appId: "...", appSecret: "...", domain: "feishu", requireMention: true }
}
```

注意：`id` 必须等于 `type`（多实例当前未支持）。

### `validateConfig(config): ChannelCliValidationIssue[]`

不抛错，返回 issues 数组。两类：

```ts
| { kind: "missing-required-field"; flag: string; message: string }
| { kind: "invalid-config"; message: string }
```

`missing-required-field.flag` 是缺哪个 CLI flag（如 `"--app-id"`），CLI 会用它提示用户该补什么。

### `renderSummary(config): string[]`

返回展示用的多行字符串，比如：

```
type: feishu
appId: cli_xxx
appSecret: ***            ← 必须脱敏
domain: feishu
requireMention: true
```

`xacpx channel show <type>` 会调用它。**密钥字段必须显示成 `***` 或省略后缀**，不要原样输出。

### `promptForMissingFields(input, io): Promise<ChannelCliInput>`

只在 `io.isInteractive()` 为真时被调到。利用 `io.promptText` / `io.promptSecret` 把缺失字段补全。`promptSecret` 不会回显，用于密钥。

---

## 11. CLI provider 辅助类型

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

`parseBooleanFlag(value, flagName)` 和 `takeFlagValue(args, index, flagName)` 这两个常用解析工具暂时**没有**在 `xacpx/plugin-api` 里以运行时形式导出。一方包 `@ganglion/xacpx-channel-yuanbao` / `@ganglion/xacpx-channel-feishu` 都各自复制了一份私有实现——参考 `packages/channel-yuanbao/src/yuanbao-provider.ts` 顶部 10 行直接抄。

---

## 12. 配置形态：`ChannelRuntimeConfig`

```ts
export interface ChannelRuntimeConfig {
  id: string;
  type: string;
  enabled: boolean;
  options?: Record<string, unknown>;
}
```

约束：

- `id === type`（多实例未来才支持）。
- `enabled: false` 的频道不会被 daemon 实例化，但仍出现在 `xacpx channel list`。
- `options` 任意 JSON 对象，由你的 `factory` 解析。建议在频道包里专门写一个 `parseMyConfig(options): MyConfig` 函数，先 throw 给出可读错误，再让构造函数信任结果。

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

---

## 13. ChatKey 与 channelId 约定

`chatKey` 是 xacpx 路由里的会话标识，跨频道全局唯一。约定：

```
<channelId>:<channel-internal-id>
```

例：

- 微信：`weixin:wxid_abc123`（注意微信兼容旧格式 `wxid_abc123`，等价于 `weixin:wxid_abc123`）
- 飞书：`feishu:oc_xxxx`
- 元宝：`yuanbao:<account>:<conv>`

你的频道**必须**：

1. 入站消息时构造 `<type>:<...>` 形式的 chatKey 并传给 `agent.handle(chatKey, text)`。
2. 出站消息时从 chatKey 反向解析回内部 id，注意 strip 掉 `<type>:` 前缀。
3. `notifyTaskCompletion` 等回调里检查 `task.chatKey` 是否以 `<type>:` 开头，不是就直接返回。

`channelId` 不能含 `:`。`registerChannelFactory` 会强制校验，未通过的会在 daemon 启动时报错。

---

## 14. 校验规则

daemon 在 import 插件后做以下检查（`src/plugins/validate-plugin.ts`）。任意一条失败会拒绝注册并打印 actionable 错误：

| 检查项 | 失败动作 |
| --- | --- |
| `apiVersion === 1` | 报 `unsupported plugin apiVersion` |
| `name`（如有）必须等于 npm 包名 | 报 `plugin name does not match package name` |
| 每个 channel 的 `type` 非空、不含 `:` | 报 `channel type must be non-empty / must not contain ":"` |
| 单个插件内 `type` 不重复 | 报 `plugin registers duplicate channel type` |
| 同一进程里 `type` 不被多个插件同时注册 | 报 `channel type ... is already provided by ...` |
| 不允许覆盖内置类型 (`weixin`) | 报 `channel type is already registered: weixin` |

CLI 不会自动 disable 出错的插件——需要用户手工 `xacpx plugin disable <name>` 或修复后 `xacpx plugin doctor`。

---

## 15. plugin doctor 诊断

`xacpx plugin doctor` 的输出由 `src/plugins/plugin-doctor.ts` 产出。常见 issue 及含义：

| `level` | `message` 模式 | 含义 / 用户该做什么 |
| --- | --- | --- |
| `error` | `package not installed in plugin home; run xacpx plugin add <name>` | 配置里写了 plugin，但 `~/.xacpx/plugins/node_modules` 里没装。重装。 |
| `error` | `failed to import plugin: ...` | npm 包能装上但 import 报错。看错误里堆栈，多半是依赖版本冲突或缺 `dist`。 |
| `error` | `unsupported plugin apiVersion` 等 | 校验失败。看 §14。 |
| `error` | `channel type X is already provided by ...` | 两个 plugin 同时声明同一 type。卸载其中一个。 |
| `error` | `channel X is configured but no enabled plugin provides it` | `channels[]` 有 X 但没有相应插件 enabled。`xacpx plugin add` 或 `xacpx plugin enable`。 |
| `warn` | `plugin is installed and valid but disabled; run xacpx plugin enable` | 装好了但 `enabled: false`。 |
| `error` | `channel X is configured but provider plugin is disabled` | 频道已配但提供方插件被禁用——daemon 启动会失败。`plugin enable` 或 `channel disable`。 |
| `ok` | `plugin is installed and valid; channels: ...` | 健康。 |

写插件时可以借这个表反推：保证你的插件能稳定走到 `ok`，再进入 `xacpx restart`。

---

## 16. 端到端生命周期

### 16.1 用户的 CLI 路径

| 阶段 | 命令 | 副作用 |
| --- | --- | --- |
| 安装 | `xacpx plugin add <pkg> [--version <v>]` | `bun add` / `npm install` 到 `~/.xacpx/plugins`，import + validate，写 `plugins[]` |
| 升级 | `xacpx plugin update <pkg> [--version <v>]` `xacpx plugin update --all` | 重新 install 同名包，再 import + validate；`--version` 时同步写回 `plugins[].version` |
| 校验 | `xacpx plugin doctor [<pkg>]` | 不修改任何状态，只汇报每个插件 / 每个频道的健康状态 |
| 停用 | `xacpx plugin disable <pkg>` | 仅把 `plugins[].enabled = false`，不卸包 |
| 重启 | `xacpx plugin enable <pkg>` | `enabled = true` |
| 卸载 | `xacpx plugin remove <pkg>` (`rm` 别名) | 卸 npm 包 + 从 `plugins[]` 移除（**不会**自动 `channel rm`） |
| 频道 | `xacpx channel add/rm/enable/disable/show/list <type>` | 改 `channels[]`；走插件提供的 `cliProvider`（如有） |
| 生效 | `xacpx restart` | daemon 重新 import 所有 enabled 插件 |

每条插件命令都接受 `--restart` / `--no-restart`，默认在交互式终端里询问。详见 [docs/channel-management.md#插件管理](./channel-management_zh.md#插件管理)。

### 16.2 daemon 启动顺序

```
1. main() 启动
2. 读 ~/.xacpx/config.json
3. plugin-loader 遍历 plugins[].enabled === true：
   3.1 import("<plugin-home>/node_modules/<name>")
   3.2 validateWeacpxPlugin
   3.3 registerChannelPlugin —— 注入 factory + cliProvider + 可选 retireChannel
4. createMessageChannels 遍历 channels[].enabled === true：
   4.1 channelFactories.get(type)
   4.2 factory(options, deps) → MessageChannelRuntime
5. runConsole(...)：
   5.1 channel.configureOrchestration?.(callbacks)
   5.2 取得必需且与渠道无关的核心 runtime ownership lock
   5.3 为**每一个**提供 consumer lock 的渠道各取得一把 fence，按渠道 id 确定顺序串行取得（兼容旧 daemon 的 fence）；部分冲突时按相反顺序回滚
   5.4 发布 daemon identity，再协调共享状态并清理陈旧 owner
   5.5 报告 daemon ready，再执行 channel.start({ agent, abortSignal, quota, logger }) 与 scheduler.start()
6. 收消息：channel → agent.handle(chatKey, text) → router
7. 出消息：orchestration → channel.notifyTaskCompletion / sendCoordinatorMessage
8. SIGTERM / SIGINT：abortSignal aborted → 持有 ownership 完成 dispose/reap → registry.stopAll：channel.stop?()（回退：logout()）→ 按相反顺序释放所有渠道 fence，再释放核心锁 → daemon exit
```

正常退出走 `abortSignal` 加非破坏性的 `stop()`；破坏性的 `logout()` 只在 `xacpx logout` 显式调用时被触发——唯一例外是没有实现 `stop()` 的遗留频道，关停时会回退到 `logout()`。

### 16.3 模块缓存语义（开发者必读）

- daemon 在 §16.2 第 3 步把每个插件 `import()` 一次，**模块对象在 daemon 进程生命周期内被缓存**。`xacpx plugin update` 只改磁盘，**不会**让运行中的 daemon 看到新代码。
- 因此 update 后必须 `xacpx restart`。CLI 默认会问；写脚本时建议显式 `--restart`。
- 反过来，`xacpx plugin add/update/remove` 这些 CLI 命令**自己**走的是一个独立短生命周期 Node 进程，校验时跑的 `import()` 用的是磁盘新版本。所以"装好但没重启"的窗口期里：CLI 校验通过 ≠ daemon 也加载了新版本。这是 `xacpx plugin doctor` 始终报"装好了"但 daemon 表现不变的根因。

### 16.4 失败回滚

| 失败点 | 表现 | 行动 |
| --- | --- | --- |
| `plugin add` 时 import 失败 | CLI 立即报错，**不写 config** | 修包，或换版本 `--version` 重试 |
| `plugin add` 时 validate 失败（apiVersion 不匹配、name 与包名不一致、单插件内 type 重复、factory 缺失等） | CLI 立即报错，**不写 config** | 看错误，修包元信息 |
| `plugin add` 时跨插件 type 冲突 | 不会在 add 阶段发现，只能在 `plugin doctor` 或 daemon 启动时发现 | 装完跑 `xacpx plugin doctor` 复核 |
| `plugin update` 时 import / validate 失败 | CLI 报错；如果原来 `plugins[].version` 有值，会自动 `npm install` 回滚到该版本；否则提示用户手动重装 | 看错误，必要时手动 `xacpx plugin add <pkg>` 回到 latest |
| daemon 启动时插件 import 失败 | daemon 进程退出，错误进 `~/.xacpx/runtime/app.log` | `xacpx plugin doctor` 看 ERROR 行；常见手段是 `plugin disable <name>` 暂时绕开 |
| `channel add` 时 cliProvider validate 失败 | CLI 报缺哪个字段 | 按提示补全 |

---

## 17. 发布契约

一方包路径：`packages/channel-<type>/`，发布名 `@ganglion/xacpx-channel-<type>`。第三方可任意命名，但若设了 `WeacpxPlugin.name`，**必须**等于 npm 包名。

### 17.1 官方 vs 第三方插件发现

`xacpx plugin known` 只列举随当前 xacpx 版本一起发布的**官方**频道插件（`src/plugins/known-plugins.ts`）：

```text
官方插件：
- feishu  @ganglion/xacpx-channel-feishu   飞书频道
- yuanbao @ganglion/xacpx-channel-yuanbao  腾讯元宝频道

安装：
  xacpx plugin add <package>
```

第三方插件的发现走 npm 自身（`npm search` / GitHub / README），**不会**出现在 `plugin known` 里。`xacpx` 不做 marketplace、不做 npm 索引、不做自动安装；用户只需要：

```bash
xacpx plugin add <你的-npm-包名>
```

如果你写了一个第三方频道插件，建议在自己仓库 README 里直接给出这个 `plugin add` 命令，而不是依赖 xacpx 去做发现。

发布前检查：

- `dist/` 含 `.js` 和 `.d.ts`。
- `package.json` 的 `peerDependencies.xacpx` 用 `>=x.y` 而非 `^x.y`，避免锁死小版本。
- `peerDependenciesMeta.xacpx.optional = true`，否则用户安装时 npm 可能在 `~/.xacpx/plugins` 里要求装一份 xacpx，浪费空间。
- 发布产物里**只**导入 `xacpx/plugin-api`。可以用 `bunx publint` 验证。
- 全 ESM，`"type": "module"`。

发布命令、preflight、dry-run、版本号选取（patch / minor / major）见 [docs/developments_zh.md 的发布章节](./developments_zh.md#发布)。

---

## 18. 测试建议

最少应有：

1. **单元层**（不依赖 xacpx）：parse / validate config 函数、消息编解码、签名算法、chatKey 构造与解析。
2. **CLI provider 单元测试**：用 `parseAddArgs` 喂各种参数组合，断言 `ChannelCliInput`；用 `validateConfig` 喂故意缺字段的 config，断言 issues。
3. **频道契约测试**：实例化 `MyChannel(options)`，注入 fake `ChannelStartInput`（自己写一个 `OutboundQuota` / `AppLogger` mock），断言一次入站消息会走到 fake `agent.handle`。
4. **集成层**（可选）：在测试里跑 `runCli(["channel", "add", "<type>", ...])`，断言 `~/.xacpx/config.json` 被正确写入。

参考 `packages/channel-yuanbao/src/access/__tests__`（如有）和 `tests/unit/channels/*`。

---

## 19. 参考实现

| 包 | 路径 | 看什么 |
| --- | --- | --- |
| `@ganglion/xacpx-channel-feishu` | `packages/channel-feishu/` | 标准 OAuth2 / 自建应用、HTTP webhook、@ 提及、群单聊路由 |
| `@ganglion/xacpx-channel-yuanbao` | `packages/channel-yuanbao/` | 长连 WebSocket、自定义签名、消息去重、心跳通知 |
| 内置 `weixin` | `src/channels/weixin-channel.ts` | 唯一一个走 `supportsLogin: true` + `ConsumerLock` 的频道 |

每个一方包都有 `src/index.ts`（plugin 入口）+ `src/channel.ts`（runtime）+ `src/<type>-provider.ts`（CLI provider），对照看最快。

---

## 拓展阅读

- 用户向频道管理：[docs/channel-management.md](./channel-management_zh.md)
- 配置文件全字段：[docs/config-reference.md](./config-reference_zh.md)
- 发布 / 版本流程：[docs/developments_zh.md → 发布](./developments_zh.md#发布)
- Code wiki / 模块地图：[docs/code-wiki.md](./code-wiki_zh.md)
