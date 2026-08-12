# PR #264 简化重做计划：优先复用 acpx 0.13 的 Windows structured argv / legacy built-in recovery

> 目标仓库：`gadzan/xacpx`  
> 当前 PR：<https://github.com/gadzan/xacpx/pull/264>  
> 当前已审 head（制定本计划时）：`e00eca062c982320971a7941f7d87f83aa6a358d`  
> xacpx 依赖：`acpx: 0.13.0`  
> upstream：<https://github.com/openclaw/acpx>  
> acpx Windows structured argv 修复：<https://github.com/openclaw/acpx/pull/473>  
> acpx 原始问题：<https://github.com/openclaw/acpx/issues/466>

---

## 1. 结论先行

当前 PR #264 很可能把问题解决在了错误的层级，导致实现明显过重。

PR 目前为了修复 Windows 上历史 raw agent command 无法安全重放的问题，引入了：

- xacpx 自己的历史 argv migration；
- `xacpx-managed-*` session-local alias；
- 对 `~/.acpx/config.json` 的 overlay 写入；
- startup replay；
- alias self-proof；
- state/config/acpx 多层锁；
- migration CLI；
- acpx session index / record proof reader；
- overlay 生命周期与未来 GC 问题；
- migration state partial-write recovery。

但 xacpx 当前已经精确依赖 `acpx@0.13.0`，而 acpx 0.13 本身就是为 Windows structured argv 引入的版本。

acpx 0.13 已经具备：

1. Windows agent spawn 必须使用 structured argv；
2. session record 持久化 `agent_argv`；
3. queue owner / reconnect / runtime 全程沿用 persisted `agent_argv`；
4. 对历史 built-in `agent_command` 自动 backfill `agentArgv`；
5. 对无法证明 argv 的历史 custom raw command 明确 fail closed。

因此新的首选方向不是继续完善 xacpx-managed overlay，而是：

> **让 xacpx 不再提前阻断 Windows historical raw selector，把历史 `transport_agent_command` 原样交给 acpx 用于定位旧 session record；真正的 argv 恢复和 Windows spawn 交给 acpx 0.13 自己完成。**

如果最小 E2E 验证通过，则建议大幅重做 PR #264。

---

## 2. acpx 0.13 的关键行为

### 2.1 Windows 不允许 raw command 直接 spawn

acpx 的 `resolveAgentCommandParts()` 逻辑是：

```text
agentArgv 存在
  -> 按 structured argv spawn

agentArgv 不存在 + win32
  -> fail closed

agentArgv 不存在 + Unix
  -> split raw command
```

也就是说，Windows 上：

```text
"kimi acp"
```

不能直接被猜成：

```json
["kimi", "acp"]
```

这是 acpx 的明确产品约束，而不是 xacpx 自己的限制。

### 2.2 但 legacy built-in session 会自动恢复 argv

acpx 0.13 的 session parser 会做：

```text
record.agent_argv
  ??
resolveAgentArgvForCommand(record.agent_command)
```

例如旧 record：

```json
{
  "agent_command": "kimi acp"
}
```

读取后可以得到：

```json
{
  "agentCommand": "kimi acp",
  "agentArgv": ["kimi", "acp"]
}
```

acpx upstream 为这个行为有明确 regression tests，包括历史 Codex / Claude / Gemini / Kiro / OpenCode 等 built-in command。

### 2.3 queue owner 真正启动 agent 时使用 record 的 argv

acpx prompt 流程不是把本次 CLI 的 raw `--agent` 一路传给 queue owner。

实际上：

```text
CLI invocation
  |
  | --agent "kimi acp"
  v
用 agentCommand + cwd + name 查 session record
  |
  v
得到 record id
  |
  v
sendSession(recordId)
  |
  v
queue owner 子进程
  |
  v
resolveSessionRecord(recordId)
  |
  v
parseSessionRecord()
  |
  +--> legacy built-in 自动补 agentArgv
  |
  v
new AcpClient({
  agentCommand: record.agentCommand,
  agentArgv: record.agentArgv
})
```

因此 raw `--agent` 在这里更像一个 **历史 session selector**，而不一定是最终 Windows spawn command。

这是本计划最核心的假设，需要用真实 Windows E2E 证明。

---

## 3. 当前 xacpx 的可疑提前 fail-close

当前 `SessionService.resolveLaunchSpec()` 对 Windows historical raw command 会直接 throw，大意如下：

```ts
if (recordedCommand) {
  if (platform === "win32") {
    throw new Error(
      "session was created with a raw command that cannot be launched on Windows..."
    );
  }

  return {
    acpxAgent: agentConfig.driver,
    rawCommand: recordedCommand,
    agentCommand: recordedCommand,
  };
}
```

当前注释假设：

> acpx rejects raw `--agent` strings on Windows，所以 xacpx 必须先迁移。

需要验证这个假设是否过强。

根据 acpx 0.13 当前实现，真正的 Windows raw rejection 发生在 **AcpClient 准备 spawn 且 record 最终没有 `agentArgv` 时**，不是发生在 `--agent` flag 刚解析出来时。

所以有可能只需：

```text
Windows historical recordedCommand
       |
       v
不要在 xacpx 提前 throw
       |
       v
继续作为 --agent raw selector 交给 acpx
       |
       v
让 acpx 自己找旧 record / backfill argv / spawn
```

---

## 4. 第一阶段：先做最小验证，不要立即大删代码

这是下一位 agent 应首先完成的工作。

### 4.1 建一个独立 spike / focused test

不要一开始就重写整个 PR。

先证明下面两个 Case。

### Case A：历史 built-in session 在 Windows 上可被 acpx 0.13 原生恢复

构造真实或尽可能真实的 acpx session record：

```json
{
  "agent_command": "kimi acp"
}
```

关键要求：

- `agent_argv` 缺失；
- xacpx state 里的 `transport_agent_command` 仍是 `"kimi acp"`；
- 不创建任何 `xacpx-managed-*` alias；
- 不修改 `~/.acpx/config.json`；
- Windows 平台；
- 走真实 `acpx@0.13.0` CLI / queue-owner 路径，而不是 mock 掉核心行为。

目标验证：

```text
xacpx
  -> raw selector "kimi acp"
  -> acpx 找到旧 record
  -> parseSessionRecord backfills ["kimi", "acp"]
  -> queue owner 使用 structured argv
  -> prompt / status / reconnect 至少一条完整路径成功
```

验收条件：

- Windows 不出现 raw-command spawn error；
- 命中旧 record，而不是创建新 session；
- 历史 `acpxRecordId` / backend session identity 保持一致；
- `~/.acpx/config.json` 没有新增 `xacpx-managed-*`；
- xacpx state 不需要先做 migration。

### Case B：历史 custom raw command 在 Windows 上仍然 fail closed

构造旧 record：

```json
{
  "agent_command": "some-custom-agent --foo"
}
```

并且：

```text
agent_argv 缺失
```

该 command 不属于 acpx built-in migration table。

期望：

```text
xacpx 允许 selector 进入 acpx
  -> acpx 找到旧 record
  -> record 无法 backfill argv
  -> AcpClient Windows spawn 前 fail closed
```

验收条件：

- 不允许 xacpx 自己猜 argv；
- 不允许静默创建新 session；
- 不允许污染 `~/.acpx/config.json`；
- 给出 acpx 自己明确的 structured argv / recreate guidance；
- 不发生错误 identity attach。

这个失败是可以接受的，也是 acpx 0.13 官方声明的兼容边界。

---

## 5. 额外必须验证的边界

### 5.1 当前 acpx config override 不能改变历史 session identity

例如：

```json
{
  "agents": {
    "kimi": {
      "argv": ["different-kimi", "--acp"]
    }
  }
}
```

但历史 record 仍然是：

```text
agent_command = "kimi acp"
```

推荐仍然使用：

```text
--agent "kimi acp"
```

作为 selector，而不是改成：

```text
acpx kimi ...
```

因为 positional `kimi` 会经过 **当前 config resolution**，可能得到新的 `agentCommand`，从而找不到旧 session。

必须验证：

```text
历史 raw selector "kimi acp"
  -> 仍命中旧 record
  -> current config override 不重定向历史 session
```

这也是不建议简单把所有历史 session 改成 bare driver name 的原因。

### 5.2 named session / cwd routing

验证至少：

- cwd default session；
- named session；
- directory walk / repo-root routing（如果 xacpx 依赖）；
- reset 后的新 transport session；
- attach / refresh。

### 5.3 warm queue owner 和 cold queue owner

至少验证：

1. cold start：没有 owner，acpx 新拉 queue owner；
2. warm owner：已经有 owner，再发 prompt。

确保两条路径最终都使用 record 的 structured argv。

---

## 6. 如果第一阶段验证通过：重做 PR #264

### 6.1 总体目标

把 #264 从“xacpx 实现自己的 argv migration subsystem”改成：

> **xacpx 正确持久化新 session 的 structured identity，同时对 legacy session 让 acpx 0.13 负责 backward compatibility。**

### 6.2 建议删除的内容

如果验证通过，优先删除整套 session-local migration overlay：

- `src/state/auto-migrate-agent-argv.ts`
- migration CLI：`xacpx migrate argv`
- startup `autoMigrateArgv`
- `xacpx-managed-*` migration alias 生成/写入逻辑
- session overlay restart replay
- historical alias self-proof（如果只服务于 migration overlay）
- migration 的 acpx index / record proof reader
- migration state/config 双锁或三锁事务
- migration state write fatal handling
- migration result / skipped / configUpdates 等模型
- migration 专用测试
- PR 文档中关于 managed aliases / overlay 的描述

注意：

不要机械删除所有 overlay 代码。

如果已有其他功能（例如当前 config-derived agent overlay）在 PR 之前就存在且有独立用途，应保留。

只删除 **为 legacy session migration 新增的 session-local managed overlay**。

### 6.3 建议保留的内容

保留这类改动：

- 新 session / create / attach / reset 路径持久化真实：
  - `transport_agent_command`
  - `transport_agent_argv`
  - 必要的 `transport_acpx_agent`（仅当本来就有稳定用途）
- config 中显式 `agents.<name>.argv` 的支持；
- 当前 launch resolver 对 structured argv 的优先级；
- Windows 对 genuinely unsafe custom raw state 的 fail-closed；
- acpx 0.13 compat tests；
- Windows process/queue-owner safety fixes（如果与本问题独立）。

目标是：

> 从今天开始不再制造新的 raw-only legacy state；已有 built-in legacy state 交给 acpx 自己恢复。

---

## 7. `SessionService.resolveLaunchSpec()` 的建议方向

不要直接照抄，先根据现有 `BridgeRuntime` 调用参数确认。

概念上：

```ts
if (recorded structured argv exists) {
  return structured sticky launch;
}

if (explicit current config argv exists) {
  return current structured launch;
}

if (recorded legacy raw command exists) {
  // Unix: existing behavior.
  // Windows: DO NOT split it in xacpx.
  // Let it remain an acpx selector so acpx can resolve the old record.
  return {
    rawCommand: recordedCommand,
    agentCommand: recordedCommand,
    ...
  };
}

return derived current launch;
```

关键是：

- Windows 上不要在 xacpx 层 `splitCommandLine(recordedCommand)`；
- 不要把它伪造成 guessed argv；
- 不要先映射成当前 bare driver；
- 不要写 acpx config alias。

如果 acpx 最终加载的旧 record没有 `agentArgv`，让 acpx 自己拒绝。

---

## 8. 需要检查 `BridgeRuntime` 的参数语义

必须确认 xacpx 最终 spawn acpx CLI 时：

```text
rawCommand / agentCommand
```

具体如何映射到：

```text
acpx --agent <command>
```

需要确认：

1. raw command 在 Windows 上是否只是一个独立 argv element 传给 acpx CLI；
2. xacpx 自己有没有 shell 拼接；
3. 是否会经过额外 quoting / split；
4. queue-owner bridge 是否会把 current driver name 强行替换 raw selector；
5. prompt/history/status/cancel 等不同 RPC 是否使用一致 selector。

目标是：

```text
xacpx process argv:
[
  ".../acpx",
  "--agent",
  "kimi acp",
  ...
]
```

而不是：

```text
shell string:
acpx --agent kimi acp ...
```

两者安全性完全不同。

---

## 9. Windows E2E 验收矩阵

建议至少覆盖以下矩阵：

| 场景 | old acpx record `agent_argv` | xacpx state | 期望 |
|---|---:|---|---|
| built-in kimi legacy | 无 | raw `"kimi acp"` | 成功恢复 |
| built-in codex historical command | 无 | historical raw | 成功恢复 |
| built-in claude historical command | 无 | historical raw | 成功恢复 |
| built-in + current acpx override | 无 | old raw | 仍命中 old record |
| custom raw | 无 | raw custom | fail closed |
| custom structured | 有 | structured | 正常 |
| new xacpx session | 有 | structured | 正常 |
| warm queue owner | 有/可 backfill | old raw selector | 正常 |
| cold queue owner | 有/可 backfill | old raw selector | 正常 |
| named session | 无但可 backfill | old raw | 正常 |
| reset session | 新 structured | 新 state | 正常 |

另外应断言：

```text
~/.acpx/config.json
```

在 legacy built-in recovery 测试前后完全不需要增加 `xacpx-managed-*`。

---

## 10. 一个重要 fallback

如果 Case A 不成立，不要直接回到当前 4000+ 行实现。

先定位失败在哪一层。

### A. acpx CLI 在查 record 前就拒绝 `--agent` raw

当前源码调研看起来不像这样，但如果真实 0.13 package 行为不同：

- 写 source-blind packaged smoke；
- 确认 npm package dist 与 GitHub tag 一致。

### B. 能找到 record，但 parser 没 backfill argv

检查：

- dependency 真的是 0.13.0；
- historical command 是否在 acpx migration table；
- xacpx 使用的 record 是否符合 `acpx.session.v1`；
- 是否读取了别的 session store。

### C. backfill 成功，但 queue owner 又丢 argv

这会是 acpx 0.13 的 upstream bug。

当前源码显示 queue owner 明确使用：

```ts
sessionRecord.agentArgv
```

所以如果真实复现失败，应优先作为 upstream acpx bug 处理，而不是立刻在 xacpx 再造一套 registry。

### D. 只有 custom raw session 无法恢复

这是预期结果，不需要 #264 为它构建 managed overlay migration。

产品层面可选择：

- 提示用户 recreate；
- 或提供一个很窄的 explicit manual repair command；
- 但不要自动猜 argv。

---

## 11. 如果确实需要 custom legacy repair，建议做窄工具，不做永久 overlay subsystem

只有在明确有大量重要 custom legacy session 必须保留时再考虑。

更小的方案：

```text
xacpx repair-session-argv <session> --argv-json '[...]'
```

特点：

- 用户显式提供 argv；
- xacpx 不猜；
- 只修改 xacpx state 或明确支持的 persisted identity；
- 不启动 startup migration；
- 不创建 hash alias；
- 不修改全局 acpx config；
- 没有 restart replay / GC。

但这个方案只有在 acpx CLI 无法直接利用 repaired argv 时才有意义。

如果仍然需要 alias 才能传给 CLI，那要重新评估是否值得维护这一机制。

---

## 12. 不建议当前马上迁移到 `acpx/runtime`

调研确认：

```ts
AcpAgentRegistry.resolve(agentName): string | string[]
```

因此 `acpx/runtime` 可以原生接收：

```ts
["kimi", "acp"]
```

而完全不需要 `~/.acpx/config.json` alias。

长期看，这可能比 shelling out CLI 更干净。

但目前不建议为了 #264 做这次架构切换，因为：

- xacpx 已经有 bridge / queue-owner / RPC 体系；
- acpx runtime 不是 CLI 所有能力的完整 drop-in；
- 例如 public runtime `permissionPolicy` 仍有 upstream open issue；
- 切 runtime 会扩大 blast radius。

因此本 PR 优先做：

> **最小修复，复用 acpx CLI 0.13 已有 session migration。**

未来再单独评估 runtime 化。

---

## 13. 推荐实施顺序

### Commit 1 — Proof only

只加测试 / spike：

- Windows historical built-in raw selector；
- acpx record 无 `agent_argv`；
- 不创建 managed alias；
- 证明 prompt/reconnect 成功。

如果这一步不绿，停止重构，先分析。

### Commit 2 — Remove premature Windows fail-close

修改 `SessionService.resolveLaunchSpec()`：

- legacy raw recorded command 在 Windows 不再由 xacpx 提前 throw；
- 继续原样作为 acpx selector；
- 绝不在 xacpx split。

加单元测试。

### Commit 3 — Remove session migration subsystem

删除：

- auto migration；
- migration CLI；
- session-local managed overlays；
- replay；
- proof reader；
- migration locks；
- 对应测试与文档。

保持每一步可编译。

### Commit 4 — Preserve future correctness

重新完整检查：

- create
- attach
- reset
- refresh
- Web create
- native attach

确保新 session 都会记录 structured identity，不再制造新的 raw-only state。

### Commit 5 — Full Windows regression

跑：

- typecheck；
- unit；
- Linux full suite；
- Windows IPC / process / queue owner；
- packaged CLI；
- ConPTY；
- acpx compat smoke；
- source-blind npm/package test。

最后确认：

```text
git grep xacpx-managed
```

如果只为本 PR migration 使用，应当没有残留。

---

## 14. PR 描述建议

如果重做成功，PR 不应再描述为：

> auto-migrate Windows raw-command sessions to structured argv

更准确的方向是：

> **fix(windows): reuse acpx 0.13 structured argv recovery for legacy sessions**

核心说明：

1. xacpx 新 session 持久化 structured identity；
2. Windows historical raw command 不再被 xacpx 提前拒绝；
3. raw string只作为 acpx historical session selector；
4. acpx 0.13 从 persisted record 自己恢复 built-in `agentArgv`；
5. unsupported custom raw history 保持 fail closed；
6. 不修改 `~/.acpx/config.json`；
7. 不引入永久 managed alias 或 startup migration。

---

## 15. 最终验收标准

只有全部满足，才认为简化方案成功：

- [ ] Windows historical built-in session 能继续 prompt；
- [ ] 命中原 acpx record / history；
- [ ] historical record 无 `agent_argv` 时由 acpx 0.13 backfill；
- [ ] xacpx 不解析 raw command；
- [ ] xacpx 不猜 argv；
- [ ] current acpx agent override 不改变历史 session identity；
- [ ] custom raw unsupported history fail closed；
- [ ] 新 session 始终记录 structured argv；
- [ ] `~/.acpx/config.json` 不新增 `xacpx-managed-*`；
- [ ] 无 startup migration；
- [ ] 无 migration CLI；
- [ ] 无 session overlay replay；
- [ ] 无新的 overlay GC 生命周期；
- [ ] Windows queue owner cold/warm 都通过；
- [ ] Linux/macOS 原行为不退化；
- [ ] exact-head full CI green。

---

## 16. 给执行 agent 的一句话任务

> **先用真实 `acpx@0.13.0` 在 Windows compat test 中证明：历史 built-in `transport_agent_command` 可以仅作为 raw `--agent` selector 命中旧 acpx record，并由 acpx record parser 自动补 `agentArgv` 后通过 queue owner structured spawn。证明后，删除 PR #264 的 session-local managed alias / overlay / auto-migration 整套机制，只保留新 session structured identity 与 legacy selector passthrough；unsupported custom raw history继续交给 acpx fail closed。不要在 xacpx 猜 argv。**
