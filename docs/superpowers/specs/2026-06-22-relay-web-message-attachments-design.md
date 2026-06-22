# relay-web 消息附件(图片为主,文件其次)— 设计

- **日期**: 2026-06-22
- **分支**: `feat/relay-web-message-attachments`
- **状态**: 设计已批,待写实现 plan
- **范围**: 让 relay-web 看板的消息输入框支持给一条消息附带图片或任意文件,经 relay hub → connector → core 喂给 acpx 会话;并在历史中持久化重显。

## 1. 背景与约束

- 现状:`PromptInput.vue` 只发纯文本;`chat.send(text)` → `control.prompt { sessionAlias, text }` → hub 注入 `chatKey/senderId/isOwner` → gateway → connector → `ControlService.prompt`(text-only)→ `agent.chat` → `transport.prompt` → acpx。
- **关键复用**:core 的媒体链路**已全通**,无需改动:
  - `transport/types.ts`: `PromptOptions.media?: PromptMediaInput`、`PromptMedia { type:"image"|"audio"|"video"|"file"; filePath; mimeType; fileName? }`。
  - `transport/prompt-media.ts`: `createStructuredPromptFile(text, media)` 已把 media 转成 ACP content blocks —— 图片→`image`(base64)、文件→`resource`(`file://` URI)外加一段 `Attachments available as local files:` 文本摘要列出绝对路径;并写 `prompt.json` 给 acpx。
  - `weixin/agent/interface.ts`: `ChatRequest.media` 已存在;`acpx-bridge-transport.ts` 已把 `options.media` 透传 acpx。
- **架构约束**:文件最终要落在 **daemon 侧磁盘**给 acpx 读。relay hub 与 daemon 可能不同机,字节必须沿 hub→connector RPC 通道走到 daemon。
- **同模式先例**:workspace-fs(`src/control/workspace-fs.ts` + `control.fs.*` RPC,经 `control.` 前缀白名单透传,hub 无需改),本特性沿用同一套穿透模式。

## 2. 方案抉择(已定)

- **附件类型**:图片为主、文件其次(两者都支持)。
- **传输架构**:**HAPI 两段式上传**。独立 `control.upload` RPC 先把字节落到 daemon 临时盘并返回路径,发送时消息只带"路径 + 元数据",不再重传字节。
  - 否决"内联 base64 进 prompt":虽改动面更小,但重发/历史会反复带字节、不利大文件、上传无独立进度。
- **历史重显**:**持久化元数据 + 预览**。`MessageRecordDto` 加 `attachments`,刷新/重进会话后图片缩略图与文件卡照常显示。
- **前端 UX**:对齐 HAPI —— picker 按钮 + 剪贴板粘贴 + 拖拽;pending 附件芯片(上传进度/删除);图片缩略图、文件用 mime 图标卡片。

## 3. 端到端数据流

```
[上传阶段]
relay-web 选/粘/拖文件
  → 读 base64;若为图片,客户端降采样到 ≤512px 生成 previewUrl(data URL)
  → api.rpc(instanceId, "control.upload", { filename, content(base64), mimeType })
  → POST /api/instances/:id/rpc
  → hub:control.* 白名单、非 chat-scoped,直接经 gateway 透传(hub 不改业务)
  → connector control-bridge:新增 "control.upload" case
  → ControlService.uploadFile():sanitize 文件名 → 写 ~/.xacpx/runtime/uploads/<rand>/<safe-name>
  → 返回 UploadResult { id, path, filename, mimeType, size }

[发送阶段]
relay-web 发送(附 pending 附件)
  → control.prompt { sessionAlias, text, media:[{ id, filePath:path, mimeType, fileName, kind }] }
  → hub 注入 chatKey/senderId/isOwner(原样),持久化入站消息时一并存 attachments
  → connector → ControlService.prompt():media 透传
  → agent.chat({ ..., media }) → transport.prompt(session, text, { media })
  → prompt-media.createStructuredPromptFile:图片→image block / 文件→resource block + 文本路径摘要
  → acpx
```

## 4. 各层改动清单

| 层 | 改动 |
|---|---|
| **relay-web** | 附件 UI(`PromptInput.vue`:picker 按钮 + paste + drag;`composer` store 持 pending 附件态与上传进度);`api/client.ts` 加 upload 调用;新 `MessageAttachments.vue` + `MessageList.vue` 渲染缩略图/文件卡;客户端图片降采样工具 |
| **relay-protocol** | 新增 `control.upload` 的 payload(`{ filename, content(base64), mimeType }`)与 result(`{ id, path, filename, mimeType, size }`)类型;`PromptPayload` 加 `media?: PromptAttachmentRef[]`;`MessageRecordDto` 加 `attachments?: AttachmentMetadata[]` |
| **relay (hub)** | upload RPC 走现有 `control.` 前缀白名单透传(**基本不改**,确认非 chat-scoped 分支已覆盖 `control.upload`);消息持久化时落 attachments;base64 大小二次校验 |
| **connector** | `control-bridge` 加 `control.upload` case → `ControlService.uploadFile` |
| **core `src/control`** | `ControlService.uploadFile()`(写临时文件 + sanitize + 大小校验 + 返回路径);`ControlPromptInput` 加 `media`;`prompt()` 把 media 透传 `agent.chat`;临时目录 TTL 清扫(启动 + 周期) |
| **core(已就绪,零改)** | `agent.chat` / `transport.prompt` / `prompt-media.ts` / acpx |

## 5. 参数与边界(默认值,实现时可调)

- **单文件上限**:10 MB(base64 over RPC)。
- **单条消息附件数**:≤ 5。
- **持久化预览**:仅图片;客户端**降采样到 ≤512px** 再存 `previewUrl`,避免把大 data URL 灌进 SQLite(比 HAPI 直接存 ≤5MB data URL 更省)。原图仍按上限上传给 agent。
- **临时文件生命周期**:`~/.xacpx/runtime/uploads/<rand>/`;**daemon 启动清扫 + TTL 24h 周期清扫**;不绑定 session-end(会话长寿)。历史重显依赖持久化的 `previewUrl`,不依赖临时文件存活。
- **图片 vs 文件 渲染**:图片→缩略图(用 previewUrl);文件→mime 图标 + 文件名 + 大小卡片。

## 6. 数据类型(草案)

```ts
// relay-protocol
interface UploadPayload { filename: string; content: string /*base64*/; mimeType: string }
interface UploadResult  { id: string; path: string; filename: string; mimeType: string; size: number }

// 发送时消息携带的轻量引用(不含字节)
interface PromptAttachmentRef {
  id: string;
  filePath: string;      // daemon 侧绝对路径(upload 返回)
  fileName: string;
  mimeType: string;
  kind: "image" | "file";
}

// 历史持久化与重显
interface AttachmentMetadata {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  previewUrl?: string;   // 仅图片,降采样 data URL
}
```

`PromptAttachmentRef → PromptMedia` 映射:`kind:"image"→type:"image"`,其余 `→type:"file"`(交给 `prompt-media` 走 resource block)。

## 7. 安全

- 文件名 sanitize:去 `..` 与路径分隔符,落盘到随机化临时目录(容器化),拒绝路径逃逸。
- base64 大小在 **hub 与 core 两侧都校验**(防客户端绕过)。
- upload RPC 沿 `control.` 白名单、非 chat-scoped(不注入 chatKey/senderId),与 workspace-fs 一致。
- **caveat(非图片文件)**:文件作为 `resource` block + 文本路径摘要传给 agent,agent 需对 daemon 上该绝对路径有 fs 读权限。临时目录在 workspace 外,Claude Code/codex 等可读绝对路径的 agent 能直接打开;若某 agent 受限于 workspace,实现时考虑把上传目录纳入其可读范围或落到 workspace 下的 `.xacpx-uploads/`。

## 8. 测试策略

- **core 单测**:`uploadFile`(写盘 / sanitize / 大小校验 / 路径逃逸拒绝)、TTL 清扫、`prompt()` media 透传到 `agent.chat`。
- **relay-protocol**:新增类型编译 + 序列化 round-trip。
- **relay 持久化**:`MessageRecordDto.attachments` 存取。
- **relay-web vitest**:`composer` store 加/删/进度/上限;`MessageAttachments.vue` 图片 vs 文件渲染分支;图片降采样工具。
- **端到端**:沿用 HAPI-borrow / workspace-fs 的真实 relay 联调(console 从分支跑 `node dist/cli.js run` 连 hub gateway,刷新连接器安装副本、清嵌套协议副本),验证上传→发送→agent 收到图片 block + 文件路径;含一类大小拒绝、一类路径逃逸拒绝。

## 9. 实现顺序(供写 plan 参考)

1. relay-protocol 类型(upload payload/result、PromptPayload.media、MessageRecordDto.attachments)。
2. core:`ControlService.uploadFile` + 临时目录/清扫 + `prompt()` media 透传 + 单测。
3. connector control-bridge `control.upload` case。
4. relay hub:确认 `control.upload` 透传白名单 + 持久化 attachments + 大小校验。
5. relay-web:upload 客户端 + composer 附件态 + 上传 UI + 渲染 + 降采样 + vitest。
6. 真实 relay 端到端联调与收尾。

## 10. 明确不做(YAGNI)

- 大文件分片/断点续传(>10MB 直接拒)。
- 服务端图片转码/缩略图生成(预览由客户端降采样)。
- 音频/视频专门 UI(core 类型支持,但 UI 不做特殊处理)。
- 附件的服务端长期存档(临时文件 TTL 清,历史只留元数据 + 小预览)。
- 微信等其它 channel 的附件接收/发送(本特性仅 relay-web → agent 方向)。
