# Session Model Selection 实现计划

> 用 superpowers:subagent-driven-development 或本会话 TDD 逐任务实现。

**目标：** 让用户能为会话指定 LLM model，三种入口：(1) `/session new ... --model <id>` 按会话；(2) 智能体配置 `model` 字段作默认；(3) `/model [<id>]` 运行时查看/切换。

**架构：** `model` 落在 `LogicalSession`（持久化）→ `ResolvedSession.model`（运行时）→ 两个 transport 把它发给 acpx。acpx 本体已完整支持：创建用全局 `--model <id>`，运行时切换用 `<agent> set -s <name> model '<id>'`（对 live queue-owner 即时生效，无需重启），查询用 `<agent> status --format json` 的 `.model`/`.availableModels`。缺口全在 xacpx 侧。

**model id 不做格式校验**——交给 acpx 的 `RequestedModelUnsupportedError`（按 agent 广告的 availableModels 校验）。

---

## Phase 1：状态/解析层

**Files:**
- Modify: `src/transport/types.ts` — `ResolvedSession` 加 `model?: string`
- Modify: `src/state/types.ts:22` — `LogicalSession` 加 `model?: string`
- Modify: `src/config/types.ts:59` — `AgentConfig` 加 `model?: string`
- Modify: `src/sessions/session-service.ts` — `toResolvedSession` 填 `model: session.model ?? agentConfig.model`；新增 `setSessionModel(alias, modelId?)`（mutate by alias，镜像 `setSessionTransportAgentCommand`）和 `setCurrentSessionModel(chatKey, modelId?)`（镜像 `setCurrentSessionMode`）
- Test: `tests/unit/sessions/session-model.test.ts`

要点：`toResolvedSession` 的 fallback 顺序 = 会话级 `session.model` 优先，否则智能体配置 `agentConfig.model`，都没有则 undefined。`createSession`/`createLogicalSession` 加可选 `model` 参数并写入 `session.model`。

## Phase 2：acpx-cli transport

**Files:**
- Modify: `src/transport/acpx-cli/acpx-cli-transport.ts`
  - 私有 `buildModelArgs(session)` → `session.model ? ["--model", session.model] : []`
  - `buildArgs` prefix 注入 `buildModelArgs`（创建/历史等共用路径）
  - `buildPromptArgs` prefix 注入（覆盖 acpx prompt 自起的 warm queue-owner）
  - `setModel(session, modelId)`：`run(buildArgsNoModel(session, ["set","-s",session.transportSession,"model",modelId]))`——**注意切换时不要注入旧 model**，用一个不含 model 的 args 构造或传 `{...session, model: modelId}` 保持一致
  - `getSessionModel(session)`：跑 `status --format json`，解析 `{ current: json.model, available: json.availableModels ?? [] }`
- Modify: `src/transport/acpx-queue-owner-launcher.ts` 调用方（`launchMcpQueueOwnerIfNeeded`）传 `sessionOptions: session.model ? { model: session.model } : undefined`
- Test: `tests/unit/transport/acpx-cli-model.test.ts`（断言 args 含 `--model`；setModel/getSessionModel 命令字符串）

实现细节：`set` 命令签名是 `set <key> <value>` + `-s/--session`（**非** `set-mode`）。query 用 `--format json`（不是默认 quiet）。

## Phase 3：SessionTransport 接口 + 命令面

**Files:**
- Modify: `src/transport/types.ts` — 接口加 `setModel?(session, modelId): Promise<void>` 和 `getSessionModel?(session): Promise<{ current?: string; available: string[] }>`（可选，bridge 在 Phase 5 实现）
- Modify: `src/commands/parse-command.ts`
  - `session.new` 解析循环加 `--model`/`-m`（可选，不设 invalid）；类型 `{ kind:"session.new"; ...; model?: string }`
  - `agent.add` 解析 `--model <id>`（可选）；类型 `{ kind:"agent.add"; template; model?: string }`
  - 新增 `/model` → `{ kind:"model.show" }`，`/model <id>` → `{ kind:"model.set"; modelId }`
- Modify: `src/commands/router-types.ts` — `SessionInteractionOps` 加 `setModelTransportSession`、`getModelTransportSession`
- Modify: `src/commands/command-router.ts` — 新增 case `model.show`/`model.set`；wire 两个 op；`session.new`/`agent.add` 透传 model
- Modify: `src/commands/handlers/session-handler.ts`
  - `handleSessionNew` 加 `model?` 参数：resolveSession 后设 `session.model = model`；attach 后 `setSessionModel(alias, model)`
  - 新增 `handleModelShow`/`handleModelSet`（镜像 `handleModeShow`/`handleModeSet`）+ `modelHelp()`
- Modify: `src/commands/handlers/agent-handler.ts` — `handleAgentAdd` 接 `model?`，merge 进存储的 `AgentConfig`
- Modify: `src/commands/command-policy.ts` — 加 `model.show`（读类）、`model.set` 显示名 `/model`
- Modify: i18n `src/i18n/messages/{zh,en}/session.ts`（modelHeader/modelNotSet/modelSet/modelAvailable/modelHelp* 等）+ `agent.ts`（如需）
- Test: `tests/unit/commands/parse-command-model.test.ts`、`tests/unit/commands/handlers/model-handler.test.ts`

## Phase 4：acpx-bridge transport

**Files:**
- Modify: `src/transport/acpx-bridge/acpx-bridge-protocol.ts` — 加 `"setModel"`/`"getSessionModel"` 方法名；请求 payload 加 `model?`
- Modify: `src/transport/acpx-bridge/acpx-bridge-transport.ts` — `ensureSession`/`prompt` 序列化 `session.model`；实现 `setModel`/`getSessionModel`（镜像 setMode）
- Modify: `src/bridge/bridge-runtime.ts` — `sessions new`/`prompt` arg 注入 `--model`；新增 `set model`/`status` 处理
- Modify: `src/bridge/bridge-server.ts` — 路由新方法
- Test: `tests/unit/transport/acpx-bridge-model.test.ts` / bridge-runtime 测试

## Phase 5：文档

- `docs/config-reference.md` agent 表加 `model`
- `docs/commands.md` `/session new --model`、`/agent add --model`、`/model` 说明
- `README.md`（如有命令清单）

---

## 自检清单
- [ ] 会话级 model 覆盖智能体默认，两者都没有则不发 `--model`
- [ ] 运行时 `set model` 不携带旧的全局 `--model`（避免歧义）
- [ ] 两个 transport 都接 model（默认 acpx-cli + 可选 bridge）
- [ ] model id 含 `[high]` 等字符——execFile 数组传参，无 shell 注入
- [ ] i18n zh/en 同步（接口类型保证）
- [ ] 全量 typecheck + 受影响单测逐文件跑（勿整目录）
