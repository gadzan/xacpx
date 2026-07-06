# 协议加固批次:relay 消息运行时校验 + 类型级绑定 设计文档

**日期:** 2026-07-06
**来源:** 2026-07 全库架构审读「轨道 2 协议加固」(见 memory `project-arch-audit-2026-07-backlog`)。

## 目标

治两条同源缺陷:

1. **无运行时校验**:relay 46 个消息只有 TS 类型,跨信任边界的 payload 过线即 `as XxxPayload` 强转即信。最危险的是**连接器 `control-bridge.ts`** 的大 switch——~40 处裸 cast 后直接执行 `fs.write/delete/copy/rename`、`prompt` 注入、`commandExecute`;以及 **hub `server.ts:151`** 的 `(payload as InstanceEventPayload).event as ControlEventDto` 双 cast,驱动所有历史 DB 写。唯一已深校验的方向是 web-push(`web-dtos.ts`)。
2. **无类型级绑定**:`MSG` 是纯字符串常量表(`messages.ts:6`),40+ 个 `XxxPayload` 仅靠**命名约定**关联消息类型;`case MSG.fsWrite: payload as FsWritePayload` 里标签与 cast 各写各的,可静默漂移,tsc 不报。

**一个统一产物同时解决两者**:在 `relay-protocol` 建一个按 `MessageType` 键控的手写校验器注册表,它既是运行时校验的来源,也用 `satisfies Record<...>` 反推出类型级绑定。这是 PR #137 用 `satisfies Record<ControlEventDto["type"], true>` 根治 control-event 白名单漂移那招的推广。

## 全局约束

- **无新依赖**。全仓无任何 schema/校验库,`relay-protocol` 是**零依赖发布包**、被 hub/connector/web 三包 `^0.1.0` 钉死引用;必须保持零运行时依赖。手写校验器,沿用 `web-dtos.ts` 既有风格。
- **隐私红线**(继承 Track 1):任何 rejection 日志或 error message **绝不**记 payload 值——不记 fs 路径、prompt 文本、upload 内容、凭证;只记 `type` 与结构化 reason(哪个字段缺失/类型错)。
- **协议兼容不破**:纯新增校验(拒的本就是非法帧),不改任何 payload 结构、不改 envelope 浅校验 → protocol 保持 `0.1.x`、`^0.1.0` 兼容。
- **git 卫生**:只 add 改动文件,禁 `git add -A`;不改 lockfile;英文 conventional commits。
- **测试**:relay-protocol / relay / channel-relay 逐文件 `bun test`(CI 在 node 下跑);类型级绑定靠 `npx tsc --noEmit`。

---

## 现状(证据)

### 消息表

- `packages/relay-protocol/src/messages.ts:6-53`:`export const MSG = { … } as const`,46 个消息,camelCase 键 → 命名空间 wire 字符串(如 `prompt: "control.prompt"` @`:25`,`fsWrite: "control.fs.write"` @`:44`)。`MessageType = (typeof MSG)[keyof typeof MSG]` @`:55`。
- payload 各自独立 `interface XxxPayload`(`messages.ts:73-450`),**与 MSG 键无任何类型级联系**。
- 信封 `packages/relay-protocol/src/envelope.ts:5-13`:`{ protocolVersion, kind, id?, type, payload?: unknown }`。`decodeEnvelope`/`isEnvelopeShape`(`:23-58`)只校验信封壳,`payload` 保持 `unknown`。

### 两道未校验的信任边界

- **连接器收 hub 控制 RPC** — `packages/channel-relay/src/control-bridge.ts:151-359` 的 `dispatchControlRequest` 大 `switch(envelope.type)`:每 arm `payload as XxxPayload`(~40 处:`:155,159,163,167,171,176,181,191,200,207,214,221,223,227,231,235,239,251,257,262,266,271,276,281,295,301,306,311,316,321,330,335,341,346,351`)。副作用真正落地处:fs 变更(`fsCreate:294`/`fsRename:300`/`fsDelete:305`/`fsCopy:310`/`fsWrite:320`/`fsDownload:315`)、prompt 注入(`:220-221`)、commandExecute(`:230-233`)、upload(`:350-355`,唯一有内联字段检查的 arm)、scheduledCreate(`:238-249`)。默认 arm 返回 `errorPayload("unknown-type", …)`(`:357-358`)。
- **hub 收连接器事件** — `packages/relay/src/server.ts:151`:`const event = (envelope.payload as InstanceEventPayload).event as ControlEventDto` 双 cast。下游 `onEvent`(`:153-211`)据此做 `messages.append` DB 写:`turn-started`(`:153-158`)、`turn-finished`(`:175-190`)、`session-history` 循环 append 每行(`:201-210`,连接器可塞任意行)。

### hub HTTP 透传(先落库风险)

- `packages/relay/src/http/app.ts` 的 `/api/instances/:id/rpc`:`app.ts:312` 读 body `as { type?, payload? }`,唯一门是 `body.type.startsWith("control.")`(`:313`),payload 原样转发给连接器(`:353`)。但 `MSG.prompt`/`MSG.commandExecute` 在转发**前**先 `messages.append` 落库(`:333-357`),`MSG.upload` 做 size 检查(`:325`)。malformed 会先污染 DB 再被连接器拒。

### 已有深校验样板(web-push 方向,复用之)

- `packages/relay-protocol/src/web-dtos.ts`:`validControlEvent(e)`(`:162-212`)——对 `ControlEventDto` 16 变体逐一校验必填字段的**编译期穷尽** switch,`default` 里 `const _exhaustive: never = type`(`:206-209`)。`parseWebServerEvent`(`:224-235`)、`validNotice`(`:217-221`)、`validToolStep`(`:145-157`)、内联谓词 `isStr/optStr/optNum`(`:115-117`)。
- `satisfies` 样板:`CONTROL_EVENT_TYPE_MAP = { … } satisfies Record<ControlEventDto["type"], true>`(`web-dtos.ts:91-108`),`CONTROL_EVENT_TYPES` 从其键派生(`:110`)。

### 依赖 / 消费者

- 全仓零校验库(grep zod/valibot/ajv/yup/superstruct/io-ts/typebox/runtypes/arktype 无命中)。`relay-protocol/package.json` 无 dependencies 块。
- 协议消费者:hub `packages/relay`、连接器 `packages/channel-relay`、前端 `packages/relay-web`,均 `^0.1.0`;core `src/` 仅 `control-service.ts:28` 一处 `import type PromptAttachmentRef`(几乎绝缘)。

---

## 设计

### 构件 1 — `packages/relay-protocol/src/payload-validators.ts`(新建)

按 `MessageType` 键控的手写校验器注册表:

```ts
// 校验器:unknown → 正确 payload 类型 | null(null = 非法,拒)
type Validator<T> = (payload: unknown) => T | null;

// 被校验的控制 RPC 请求类型子集(约 40 个:MSG 里 kind=req 的控制 RPC)。
// 排除:instanceRegister/instanceAuth(握手,已在 instance-gateway 单独校验)、
// instanceEvent/instanceNotice(事件方向,走边界 B)、terminalInput/Resize/Close(instance.* 事件,
// 已由 parseWebClientMessage 校验)。terminalCreate/terminalAttach 是 req/res 控制 RPC,纳入。
// 精确清单由实现计划枚举。
export type ControlRpcType = /* MSG.sessionsList | MSG.prompt | MSG.fsWrite | … 约 40 个 */;

// 全量注册表,satisfies 强制穷尽:漏一个 ControlRpcType → tsc 红
export const CONTROL_PAYLOAD_VALIDATORS = {
  [MSG.sessionsList]: validateChatKeyOnly,
  [MSG.prompt]: validatePrompt,
  [MSG.fsWrite]: validateFsWrite,
  // …全部 40 个
} satisfies Record<ControlRpcType, Validator<unknown>>;
```

- **校验器风格**:沿用 `web-dtos.ts` 的 `isStr/optStr/optNum` 谓词逐字段检查;必填缺失或类型错 → 返回 `null`;通过 → 返回**结构收窄后的 payload**(不做深拷贝,原样返回被 narrow 的对象)。
- **不校验语义**:只校验形状(字段存在 + 类型),不校验业务合法性(如 workspace 是否存在、path 是否越界——那些各 handler 已有自己的检查,不搬到这里)。

### 构件 2 — 类型级绑定 `PayloadFor` + `parseControlPayload`

```ts
// 每个校验器的返回类型「就是」该消息 payload 类型,由注册表反推
export type PayloadFor<T extends ControlRpcType> =
  NonNullable<ReturnType<(typeof CONTROL_PAYLOAD_VALIDATORS)[T]>>;

// 类型安全的统一解析入口,取代裸 `payload as XxxPayload`
export function parseControlPayload<T extends ControlRpcType>(
  type: T,
  payload: unknown,
): PayloadFor<T> | null {
  return (CONTROL_PAYLOAD_VALIDATORS[type] as Validator<PayloadFor<T>>)(payload);
}
```

`PayloadFor<T>` 应与手写 `XxxPayload` 结构等价——每个校验器写完用一条 type-level 断言(`expectTypeOf` 或等价)锁定「校验器返回类型 = 对应 XxxPayload」,防止校验器漏字段导致 narrow 类型与协议类型漂移。

### 构件 3 — 共享谓词抽取

`web-dtos.ts:115-117` 的 `isStr/optStr/optNum`(及需要的 `isObj` 等)抽到 `packages/relay-protocol/src/validate-primitives.ts`(新建),`web-dtos.ts` 与 `payload-validators.ts` 都从此 import。避免两份实现漂移。

### 三道边界落地

| 边界 | 位置 | 做法 | rejection 行为 |
|---|---|---|---|
| **A 连接器控制 RPC** | `control-bridge.ts:151-359` 每 arm | `const input = parseControlPayload(MSG.xxx, payload); if (!input) return errorPayload("invalid-payload", \`${type}: malformed payload\`);` 取代 `payload as XxxPayload` | 回 `errorPayload("invalid-payload", …)`,走现成 res 信封回 hub→web。**不断连、不重试**(malformed 多半版本偏移) |
| **B hub 收 instanceEvent** | `server.ts:151` | 复用现成 `validControlEvent`(web-dtos.ts)**直接校验内层 event**:`const event = validControlEvent((envelope.payload as InstanceEventPayload)?.event); if (!event) { log invalid; return; }`。**注意**:不要用 `parseWebServerEvent`——那校验的是 hub→浏览器广播信封(`{instanceId,event,kind}` 外壳),与 instance→hub 的 `{event}` 形状不同;这里只需内层 `validControlEvent` | **丢弃**该事件:不 broadcast、不 append;记 `relay.event.invalid`(RelayLogger,只带 instanceId + reason,无 payload) |
| **C hub 先落库 RPC** | `app.ts` prompt/commandExecute/upload 分支 | `messages.append` **之前** 用对应校验器校验;失败 → HTTP 400 | 返回 400 + `{ error: { code: "invalid-payload", … } }`,**不 append**、不污染 DB。不含 payload 值 |

### 可观测性 + 隐私

- **hub 侧** 用 Track 1 的 `RelayLogger`。事件名:边界 B `relay.event.invalid`(context:`instanceId` + `reason`);边界 C 由 HTTP 400 响应体承载,可选记 `relay.rpc.invalid_payload`(context:`instanceId` + `type` + `reason`)。
- **连接器侧**:channel-relay 无独立日志层,**不新建**(超范围)。边界 A 的 rejection 靠 `errorPayload` 回传——hub 侧会看到 error res。实现时核实 channel-relay 是否已有可复用 logger;若无则仅回传,不记日志。
- **隐私**:所有日志/error message **只含** `type`、`instanceId`、结构化 `reason`(如 `"missing field: chatKey"` / `"field text must be string"`);**绝不含** payload 值(fs 路径、prompt 文本、upload 内容、任何凭证)。

---

## 测试策略

### relay-protocol(核心)

- 新单测 `tests/unit/packages/relay-protocol/payload-validators.test.ts`(路径随现有 relay-protocol 测试布局):每个校验器 ≥3 例——合法通过并返回收窄对象、缺必填字段返回 null、字段类型错返回 null。
- satisfies 穷尽:靠 tsc(注册表漏一个 `ControlRpcType` 即编译红);加注释说明这是穷尽守卫,勿用 `Partial`。
- 类型级绑定:一条 type-level 断言测 `parseControlPayload(MSG.fsWrite, x)` 的返回类型 = `FsWritePayload | null`,及至少一处 `// @ts-expect-error` 证明接错消息类型的 payload 会编译失败。

### 连接器 control-bridge

- 选代表 arm(`fsWrite`、`prompt`)测:malformed payload → 返回 `errorPayload("invalid-payload", …)` 且**不调用** `control.writeFile`/`control.prompt`(mock control,断言未被调用);合法 payload → 正常执行。

### hub

- 边界 B:畸形 `ControlEventDto`(如 `turn-finished` 缺 `sessionAlias`)→ `messages.append` 未被调用 + `relay.event.invalid` 记录(spy RelayLogger)。
- 边界 C:畸形 prompt(缺 `text`)→ HTTP 400 且 `messages.append` 未被调用。

---

## 文件清单

| 文件 | 动作 | 责任 |
|---|---|---|
| `packages/relay-protocol/src/validate-primitives.ts` | 新建 | `isStr/optStr/optNum/isObj` 等共享谓词 |
| `packages/relay-protocol/src/payload-validators.ts` | 新建 | 约 40 校验器 + `CONTROL_PAYLOAD_VALIDATORS` + `ControlRpcType` + `PayloadFor` + `parseControlPayload` |
| `packages/relay-protocol/src/web-dtos.ts` | 改 | 谓词改从 `validate-primitives` import(去重) |
| `packages/relay-protocol/src/index.ts` | 改 | 导出新符号 |
| `packages/channel-relay/src/control-bridge.ts` | 改 | 约 40 arm 换 `parseControlPayload` + rejection |
| `packages/relay/src/server.ts` | 改 | 边界 B 复用 `validControlEvent` + 记 invalid |
| `packages/relay/src/http/app.ts` | 改 | 边界 C 校验 prompt/commandExecute/upload |

## 发布

纯代码合并,不改 payload 结构 → protocol `0.1.x` 兼容不破。实机生效需 core+relay+channel-relay beta;按用户决定**攒着跟后续轨道一起发**,本批次合并时不发。

## 明确不做(YAGNI / 越界)

- 不校验 res 方向(只读 list 的返回结果由本端产生,可信)。
- 不给连接器新建日志层。
- 不做限流 / 断连惩罚 / 重试。
- 不碰 web-push 方向(`web-dtos.ts` 已深校验)。
- 不改 envelope 浅校验、不改任何 payload 结构。
- 不引入任何第三方库。
- 不校验握手 `instanceRegister/instanceAuth`(已在 instance-gateway 单独处理)与 terminal input/resize/close(已由 `parseWebClientMessage` 校验)。
