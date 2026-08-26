# acpx v0.13.1 升级调查报告

> 调查日期：2026-08-26
> 调查对象：[openclaw/acpx v0.13.1](https://github.com/openclaw/acpx/releases/tag/v0.13.1)（发布于 2026-08-19，commit `2d735cf`，npm 同日发布，带 provenance）
> 当前依赖：xacpx `dependencies.acpx = "0.13.0"`（npm 发布于 2026-08-05）

***

## 一、结论摘要（TL;DR）

| 问题                            | 结论                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 能否直接升级到 0.13.1？               | **可以，风险极低。**                                                                                                                                      |
| 是否有 Breaking change 影响 xacpx？ | **没有。** 唯一的 breaking change 位于 acpx 的**嵌入式 Runtime API**（`AcpRuntimeTurn.promptStarted` 变为必填），而 xacpx 从不以库方式 import acpx，只把 acpx 作为 CLI 子进程 spawn |
| CLI 参数 / JSON 输出格式是否变化？       | **没有变化。** 0.13.1 全部改动标注为 Runtime/embedding、CLI/session 行为修复、Replay viewer、ACP/terminal，未新增/删除/变更任何 CLI flag 或 `--format json` 事件结构                |
| 会话记录 schema 是否变化？             | **没有。** 仍为 `acpx.session.v1`，xacpx 的 compat fixtures 继续有效                                                                                         |
| 对 xacpx 的净影响？                 | **净收益。** 多项修复直接命中 xacpx 的使用路径（setMode 重连、ensureSession 会话复用、retained session 的事件投影、持久化错误上报、Windows 终端清理、长会话名原子写）                                  |
| 建议的升级动作                       | `package.json` 中 `"acpx": "0.13.0"` → `"0.13.1"`，`bun install`，跑 `npm run test:compat:acpx` + `npm test` 验证                                       |

***

## 二、acpx v0.13.1 更新了什么

### 2.1 Highlights

1. **Turn 级 ACP form / URL elicitation 处理**（嵌入式运行时）：带 capability、session、request、cancellation 与 late-response 的精确围栏（fencing）。
2. **`AcpRuntimeOptions`** **暴露 per-tool permission policy**：嵌入式客户端可复用 acpx 既有的工具级权限规则匹配与决策。
3. **一轮集中的可靠性修复**：session 所有权、replay viewer 沙箱围栏、终端清理、模型控制、持久化失败上报。

### 2.2 Breaking（唯一）

* **Runtime API**：`AcpRuntimeTurn.promptStarted` 变为必填——它在 `connection.prompt()` 返回 request promise（或提前失败）之后 settle。

  * 影响范围：**仅嵌入式调用方**（`import` acpx 作为库使用的程序）。

### 2.3 Fixes（按对 xacpx 的相关度分组）

**A. 直接命中 xacpx 使用路径的修复**

| 修复                                                                                                                                                             | 对应 xacpx 路径                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| CLI/session：**重连后、在 set\_mode / set\_model / set\_config\_option 之前重新应用 session-pinned model**（修复 [#489](https://github.com/openclaw/acpx/issues/489)）         | bridge transport 的 `setMode` / `setModel` 转发 |
| Runtime/embedding：**一次性 session 所有权从初始化贯穿整个 turn**——重复的 pre-turn `ensureSession` 复用同一个后端 session，完成后清理（修复 [#504](https://github.com/openclaw/acpx/issues/504)） | xacpx 每次 turn 前都调用 `ensureSession`           |
| Runtime/embedding：**retained session 全生命周期投影并持久化** **`session/update`** **通知**，含 turn 之间与之前的空闲期（修复 [#477](https://github.com/openclaw/acpx/issues/477)）        | bridge 持久持有的 session、流式事件解析                  |
| Runtime/sessions：**turn 结束时上报 checkpoint flush 与 session-store 保存失败**，不再静默丢弃                                                                                   | 回复/错误上报到聊天频道                                 |
| Runtime：`text_delta` 事件保留非空 `messageId` 与安全的 `_meta` 子集，使消费方能区分模型正文与仍走 `agent_message_chunk` 的适配器诊断信息                                                          | 流式文本解析（见 §5.3 优化机会）                          |
| Runtime/sessions：**会话 ID basename 很长时，原子写临时文件名保持在文件系统组件长度限制内**                                                                                                 | xacpx 组合式会话命名                                |

**B. 间接受益的修复**

* ACP/terminal：shell 终端退出后，挂起的 `ps` / PowerShell 进程列表辅助进程会被超时，`wait_for_exit` / `kill` / `release` 能正常完成。

* ACP/terminal：进程列表辅助进程的 stdout 上限提高到 execFile 默认 1 MiB 之上，大型 `ps` 输出不再被当作空丢弃。

* Runtime/embedding：在 client 配置边界快照 permission policy，调用方侧的修改不会影响 in-flight turn。

* Runtime/embedding：turn 结果只在生命周期持久化与 client 清理完成后才 settle（含意外 finalization 失败）。

**C. 与 xacpx 无关的修复**

* Replay viewer：manifest 选择的投影读取被围栏在 run bundle 内（含 symlink 目标）；missing 与 containment-denied 返回同一 not-found 响应（防止目录外探测）。xacpx 不内嵌 replay viewer。

***

## 三、xacpx 如何依赖 acpx（现状事实）

1. **依赖声明**：[package.json](package.json#L90) `dependencies` 中精确锁定 `"acpx": "0.13.0"`（无 `^`/`~`），随 xacpx 一起发布安装。
2. **只用 CLI，不用库**：全仓库（`src/`、`packages/`、`scripts/`、`tests/`）**没有任何** `from 'acpx'` / `require('acpx')` 的模块导入。acpx 对 xacpx 而言是一个**外部二进制**。
3. **解析优先级**（[resolve-acpx-command.ts](src/config/resolve-acpx-command.ts)）：

   1. `transport.command`（用户显式覆盖）
   2. **bundled**：`require.resolve("acpx/package.json")` 定位 `bin.acpx` —— 依赖升级即自动生效于此层
   3. `PATH` 兜底
4. **两种 transport 均 spawn 子进程**：

   * `acpx-cli`：`node:child_process` / `node-pty` 直接启动 acpx（[acpx-cli-transport.ts](src/transport/acpx-cli/acpx-cli-transport.ts)）

   * `acpx-bridge`：bridge 子进程（`BRIDGE_ACPX_COMMAND` 或默认 `"acpx"`）经 stdin/stdout JSON 协议通信（[bridge-main.ts](src/bridge/bridge-main.ts#L77)）
5. **使用的 CLI 接口面**（[acpx-command-builder.ts](src/transport/acpx-command-builder.ts)）：

   * 全局参数：`--format quiet|json`、`--json-strict`、`--cwd`、`--verbose`

   * 权限：`--permission-mode` 类 flag（`permissionModeToFlag`）、`--non-interactive-permissions`、`--permission-policy`

   * 其他：`--model`、`--ttl`（queue owner）、`--agent`（legacy）/ positional agent（0.13 结构化 argv 路径）

   * 子命令：`prompt -s <name> [--no-wait]`、`sessions new/ensure/show`、`setMode` / `setModel`（经 bridge JSON-RPC 风格请求，[bridge-server.ts](src/bridge/bridge-server.ts#L407)）
6. **消费的 JSON 事件流**（[streaming-prompt.ts](src/transport/streaming-prompt.ts#L188)、[prompt-output.ts](src/transport/prompt-output.ts#L87)）：只处理 `session/update` 通知，识别 `agent_message_chunk`、`agent_thought_chunk`、`tool_call`/`tool_call_update`、`plan`、`usage_update`、`available_commands_update`；已读取 `update.messageId` 做段落边界判断，读取 `update._meta.usage` 做 token 分解。
7. **版本假设散布点**（升级时需知悉、但均不受 0.13.1 影响）：

   * [agent-catalog.ts](src/config/agent-catalog.ts#L40)：acpx 0.13 registry 返回 argv 数组（≤0.12 返回字符串）的双形态兼容

   * [acpx-session-argv-migration.ts](src/transport/acpx-session-argv-migration.ts)：0.13 从记录的 argv 恢复会话

   * [session-service.ts](src/sessions/session-service.ts#L1008)：0.13 argv 查找行为注释

   * [tests/fixtures/acpx-compat/](tests/fixtures/acpx-compat/README.md)：基于真实 acpx@0.13.0 产物（schema `acpx.session.v1`）+ ≤0.12 legacy 记录的双向兼容 fixture

   * `xacpx doctor` 的 acpx 检查（[acpx-check.ts](src/doctor/checks/acpx-check.ts)）只报告解析到的命令与版本，**不强制最低版本**——升级不触发任何版本门槛

***

## 四、兼容性逐项分析

### 4.1 Breaking change：`AcpRuntimeTurn.promptStarted` 必填

* 该 API 属于 acpx 的**嵌入式 Runtime（库）接口**。

* xacpx **零库导入**（§3.2 已验证），因此该 breaking change 对 xacpx **无影响**。

* 唯一需要记住的时机：若未来 xacpx 改为嵌入式集成 acpx Runtime（替代 spawn CLI），升级到 0.13.1+ 时必须提供 `promptStarted`。

### 4.2 CLI 表面（flags / 子命令 / JSON 输出）

* 0.13.1 release notes 中**没有**任何 CLI flag、子命令或 `--format json` 事件结构的增删改。

* 所有改动标注为 Runtime/embedding（库）、CLI/session **行为修复**（重连后重放 pinned model，不改变接口）、Replay viewer、ACP/terminal。

* xacpx 的 compat 测试套件 `npm run test:compat:acpx`（[tests/compat/](tests/compat/acpx-latest.test.ts)）针对 npm 安装的真实 acpx + mock ACP agent 做端到端冒烟（含边界 argv、双 transport、queue owner、进程树终止），升级后跑一遍即可确认该层兼容。

### 4.3 会话记录 schema

* schema 仍为 `acpx.session.v1`；0.13.1 仅有的相关改动是**临时文件名长度约束**（更严格防护，非格式变更）。

* fixtures README 记录的 0.13 行为契约（`agent_command` = `renderArgvIdentity(argv)`、`agent_argv` 精确透传、index 临时文件 UUID 命名）在 0.13.1 均不变。

* `sessions new/ensure`、positional alias、`~/.acpx/config.json` overlay 合并逻辑不受影响。

### 4.4 用户侧重写（`transport.command` / PATH）

* 通过 `transport.command` 显式指定 acpx 或依赖 PATH 的用户，不受 xacpx 依赖升级影响——他们用自己的 acpx 版本。

* xacpx 依赖升级只改变 **bundled 兜底层**（解析优先级 2）的版本，行为收敛、无破坏。

**结论：升级到 0.13.1 无兼容性阻碍。**

***

## 五、对 xacpx 的影响与潜在优化

### 5.1 直接收益（升级即得，无需改代码）

1. **`/mode`、`/model`** **与模型相关选项在重连后更可靠**（acpx #489 修复）
   xacpx bridge transport 在重连场景下调用的 `set_mode` / `set_model` 之前，acpx 现在会先重新应用 session-pinned model——此前重连后模型依赖的选项可能失效。微信/飞书侧长驻会话重连频繁，此修复直接提升 xacpx 的 `/mode` 语义正确性。

2. **重复** **`ensureSession`** **复用同一后端会话**（acpx #504 修复）
   xacpx 每个 turn 前都会 `ensureSession`。0.13.1 保证 one-shot session 所有权从初始化贯穿到 turn 结束，避免重复创建后端会话再清理的抖动——降低会话泄漏与状态错配概率（AGENTS.md 中"logical vs transport session mismatch"正是 xacpx 的高发 bug 区）。

3. **空闲期也投影** **`session/update`**（acpx #477 修复）
   bridge 持久持有的 retained session 在 turn 之间、之前的空闲期也会收到并持久化 `session/update`。xacpx 及 relay web 仪表盘的会话状态展示更准确（例如 turn 结束后 agent 状态变更不再丢失）。

4. **持久化失败不再静默**
   checkpoint flush / session-store 保存失败会在 turn 结束时上抛。xacpx 可以把这类错误如实回报到聊天频道，而不是吞掉后出现"看似成功、状态丢失"的隐性故障。

5. **Windows 进程清理更干净**
   acpx 的 `ps` / PowerShell 辅助进程超时与 stdout 上限修复，减少了 acpx 侧进程挂起——直接减轻 xacpx 自身 `orphan-registry` / `windows-orphan-reaper` 的压力，进程树终止（`terminateProcessTree`）更可预期。

6. **长会话名不再触发文件系统组件长度错误**
   xacpx 的会话名由 alias + 上下文组合，可能较长；0.13.1 原子写临时文件名约束保证合法长 basename 的会话记录写入不再失败。

7. **turn settle 语义更严谨**
   turn 结果只在持久化与清理尝试完成后 settle（含意外 finalization 失败），xacpx 侧等待 prompt 完成的超时/取消逻辑面对的终态更一致。

### 5.2 无影响项（确认不踩坑）

* Replay viewer 围栏修复：xacpx 不内嵌 replay viewer。

* `AcpRuntimeOptions` permission policy 暴露：嵌入 API；xacpx 已通过 CLI `--permission-policy` flag 使用同等能力。

* elicitation 处理：嵌入 API；xacpx 的 CLI 路径不涉及。

### 5.3 潜在优化机会（可选，非升级必需）

1. **利用** **`text_delta`** **的** **`messageId`** **/** **`_meta`** **区分"模型正文"与"适配器诊断"**
   0.13.1 起 `text_delta` 事件保留非空 `messageId` 与安全 `_meta` 子集，而适配器诊断**仍走** **`agent_message_chunk`**。xacpx 目前把 `agent_message_chunk` 全部当作正文拼进回复（[streaming-prompt.ts](src/transport/streaming-prompt.ts#L311)）。后续可以评估消费 `text_delta`（或按 `_meta` 过滤 `agent_message_chunk`），把适配器诊断从聊天回复流中剥离——减少微信消息里的杂音。**注意**：这是 acpx Runtime 层事件语义，落地前需在真实 CLI JSON 流上验证 `text_delta` 的输出形态。

2. **升级后刷新 compat fixtures**
   fixtures 目前标注"由发布版 acpx\@0.13.0 产物"。schema 未变、无需改动即可继续使用；建议在下一次例行维护时用 0.13.1 重新采集一次，保持"最近发布版产物"的fixture 契约（README 的措辞是 byte-for-byte as written by acpx 0.13.0）。

3. **`xacpx doctor`** **增加最低版本提示（可选）**
   当前 doctor 只报告版本不校验门槛。xacpx 代码中已散布多个"acpx 0.13 行为"假设（argv registry、session 恢复），可以考虑在 doctor 中对 `< 0.13.0` 给出 warning，防止 PATH 解析到老版本 acpx 的用户踩到已修复的 0.12 → 0.13 差异。这与本次升级独立，属于防御性增强。

4. **远期：评估嵌入式集成**
   0.13.1 把 permission policy、elicitation 等 Runtime 能力开放给嵌入方。若未来 xacpx 想去掉子进程链路（bridge 的 stdin/stdout JSON 协议）以降低延迟与复杂度，嵌入式 Runtime 是可行方向——届时需适配 breaking 的 `AcpRuntimeTurn.promptStarted`。

***

## 六、建议升级步骤与验证清单

```bash
# 1. 升级依赖（精确锁版风格保持不变）
#    package.json: "acpx": "0.13.0" -> "0.13.1"
bun install

# 2. 类型检查 + 全量单元测试
npx tsc --noEmit
npm test

# 3. 真实 acpx 兼容冒烟（自动使用 bundled 0.13.1，隔离 HOME + mock ACP agent）
npm run test:compat:acpx

# 4.（有条件时）真实微信 + acpx 冒烟
npm run test:smoke
```

重点回归项（对应 §5.1 的收益路径）：

* [ ] bridge transport：断线重连后 `/mode`、`/model` 是否仍生效（#489）

* [ ] 连续多 turn：`ensureSession` 是否复用同一后端会话、无孤儿会话累积（#504）

* [ ] turn 间隙的 `session/update` 是否被 bridge 持久化（#477）

* [ ] 长会话名（>100 字符 basename）创建/恢复正常

* [ ] Windows：`xacpx stop` / 会话清理后无残留 acpx / node 进程

* [ ] `xacpx doctor` 报告 `bundled acpx (0.13.1)`

发布注意事项：

* xacpx 自身发版时按 `xacpx-release` 流程走；`acpx` 是运行时 `dependency`，升级会随 xacpx 的下一个版本分发给所有未设置 `transport.command` 的用户。

* 升级 PR 只需改 `package.json` 一行 + `bun.lock` 再生成；无需任何 `src/` 代码改动。

***

## 七、附录

* acpx v0.13.1 release notes：<https://github.com/openclaw/acpx/releases/tag/v0.13.1>

* npm 包：<https://www.npmjs.com/package/acpx/v/0.13.1>（integrity `sha512-9zhvUrAR4XxSIgaLCiiWmrwmEWh+...`，provenance 已签）

* 版本序列：0.12.1 → 0.13.0（2026-08-05）→ **0.13.1（2026-08-19）**

* xacpx 关键代码索引：

  * 依赖声明：[package.json](package.json#L90)

  * acpx 解析：[src/config/resolve-acpx-command.ts](src/config/resolve-acpx-command.ts)

  * CLI 参数构建：[src/transport/acpx-command-builder.ts](src/transport/acpx-command-builder.ts)

  * CLI transport：[src/transport/acpx-cli/acpx-cli-transport.ts](src/transport/acpx-cli/acpx-cli-transport.ts)

  * bridge transport / client：[src/transport/acpx-bridge/](src/transport/acpx-bridge/)

  * 流式事件解析：[src/transport/streaming-prompt.ts](src/transport/streaming-prompt.ts)、[src/transport/prompt-output.ts](src/transport/prompt-output.ts)

  * 兼容测试：[tests/compat/](tests/compat/)、fixtures：[tests/fixtures/acpx-compat/](tests/fixtures/acpx-compat/README.md)

