# xacpx Model Discovery V2 专项技术方案

> 日期：2026-11-10  
> 状态：设计评审稿（只定义方案，不包含代码实施）  
> 建议仓库路径：`docs/superpowers/specs/2026-11-10-model-discovery-v2-design.md`  
> 审计基线：`gadzan/xacpx` 默认分支 `main`，审计日期 2026-11-10  
> 当前包版本：`xacpx 0.24.10-beta.14`；直接依赖
> `acpx 0.19.5`（精确版本）  
> 关联实现：已合并 PR [\#393 feat(control): report agent models as a
> capability state](https://github.com/gadzan/xacpx/pull/393)

本文是代码审读后的目标设计，不代表已实施或已通过真实 Agent
验证。凡涉及运行时行为，均需按本文测试矩阵补证。

------------------------------------------------------------------------

## 0. 决策摘要

**V2
的目标不是重写模型选择器，而是把模型发现变成有身份、有时效、有来源、有失败语义的能力服务。**

建议保留 PR \#393 的 Capability State、单一
ModelPicker、候选模型与已验证模型分离、显式刷新和失败保留旧列表等设计；重点重构底层发现
API、缓存身份与刷新生命周期。

### 0.1 本方案的核心决策

| 领域       | 决策                                                                                                                 |
|------------|----------------------------------------------------------------------------------------------------------------------|
| 冷探测     | 用 `acpx/runtime` 的公开 `inspectAgentModels()` 替换 `sessions new → status → show → close → delete record` 命令链   |
| 启动解析   | 探测必须复用 xacpx 正常会话的 Agent Launch 解析结果；不能自行拼装一套不同的命令                                      |
| 导入边界   | 只从公开 `acpx/runtime` 导入；新增唯一受控封装，并更新 `scripts/lint-acpx-imports.mjs` allowlist                     |
| 缓存身份   | fingerprint v2 至少纳入 agent、规范化 cwd、driver、完整有效 launch、settingsPolicy、adapter 版本/registry 和认证修订 |
| 缓存时效   | 正向模型目录采用 15 分钟 soft TTL；过期数据可展示为 stale，但不能冒充刚验证结果                                      |
| 刷新       | 同 fingerprint single-flight；generation fencing 防止失效前的旧探测回写                                              |
| 读取优先级 | Bot 自有活跃 Runtime → 同身份 fresh cache → 同身份新鲜活跃 Session → stale cache → `needs-setup`                     |
| 空列表语义 | 区分“没有公布模型信息”“明确公布了空列表”“探测失败”；不得把解析失败当成空列表                                         |
| effort     | 冷探测 API 不返回 effort；不能据此推断空 effort。effort 继续按当前 Session / 当前模型实时读取                        |
| UI         | 保留默认模型、自定义 ID、suggestions；清楚标识 stale、refreshing、empty、unsupported、unauthenticated 和 error       |
| 兼容性     | 不修改、fork 或 patch acpx；不依赖 acpx 私有 `src/*` / `dist/*`                                                      |

### 0.2 这次不做的事情

- 不建立一份声称覆盖所有 Agent 的静态模型大全。
- 不把 `modelCandidates` 升格成 Agent 已验证的模型。
- 不通过发送 Prompt 来发现模型。
- 不改变 Bot、Session、Runtime 的所有权和生命周期。
- 不把模型列表发现当作模型调用授权；最终能否使用仍由 Agent adapter
  决定。
- 不虚构每个模型的 effort / reasoning 能力矩阵。
- 不借此重构 CLI Engine、Bridge Engine 或 Runtime Engine 的整体架构。

------------------------------------------------------------------------

## 1. 代码基线与证据

### 1.1 当前实现基线

| 项目             | 当前事实                                                                                     |
|------------------|----------------------------------------------------------------------------------------------|
| xacpx 版本       | 根 `package.json` 为 `0.24.10-beta.14`                                                       |
| acpx 版本        | 根 `package.json` 精确固定 `0.19.5`                                                          |
| Capability State | PR \#393 已合并；wire union 为 `ready / unsupported / needs-setup / error`                   |
| 持久化缓存       | `state.json.capability_lists`，通过 `CapabilityCacheStore` 写入                              |
| Web 短缓存       | Relay Web store 另有 instance + agent + workspace + bot 维度的短缓存和 single-flight         |
| 冷探测           | 当前仍由 acpx CLI 的临时命名 Session 完成                                                    |
| Engine 路由      | agent-level cold probe 不绑定逻辑 Session；EngineRouter 将该操作路由到 CLI Engine            |
| Runtime Engine   | 自身 `probeAgentCapabilities()` 返回 unsupported；不应为了模型探测而创建/绑定 Runtime Worker |

### 1.2 当前主要代码位置

| 文件                                                | 当前职责                                                                |
|-----------------------------------------------------|-------------------------------------------------------------------------|
| `src/agents/capability-discovery.ts`                | Capability State 组装、读取顺序、cache key、single-flight、探测结果处理 |
| `src/agents/capability-cache.ts`                    | `capability_lists` StateStore 持久化                                    |
| `src/agents/capability-probe.ts`                    | 目前的临时 acpx Session 探测、解析和清理                                |
| `src/transport/types.ts`                            | `AgentCapabilityProbeRequest/Result` 与 SessionTransport 能力接口       |
| `src/transport/session-model-catalog.ts`            | Session 当前模型目录读取、OMP 特定空目录回退                            |
| `src/bridge/bridge-runtime.ts`                      | Bridge 侧 acpx CLI 管理命令和模型探测实现                               |
| `src/transport/acpx-cli/acpx-cli-transport.ts`      | CLI Transport 的模型探测实现                                            |
| `src/bridge/engine/engine-router.ts`                | agent-level probe 路由                                                  |
| `src/bridge/engine/runtime-engine.ts`               | Runtime Engine 对 cold probe 的 unsupported 实现                        |
| `packages/relay-protocol/src/agent-capability.ts`   | Capability wire DTO、状态构造与边界解析                                 |
| `packages/relay-web/src/stores/instances.ts`        | Web capability RPC 缓存、并发请求合并和失效                             |
| `packages/relay-web/src/components/ModelPicker.vue` | Bot / New Session 共用模型选择器                                        |
| `scripts/lint-acpx-imports.mjs`                     | acpx 公共 API 的受控导入边界                                            |

### 1.3 已确认的问题

#### A. 冷探测还保留旧 CLI 命令链

`src/agents/capability-probe.ts` 当前流程：

``` text
acpx sessions new --name xacpx-capability-probe
              ↓
acpx status -s xacpx-capability-probe
              ↓
acpx sessions show xacpx-capability-probe
              ↓
acpx sessions close xacpx-capability-probe
              ↓
按 record id 删除 acpx Session 文件
```

该实现的注释仍描述 acpx 0.16.0 没有模型检查 API。但当前依赖已是
0.19.5；上游从 0.17.1 起提供了公开 `inspectAgentModels()`。

现有流程必须自行维护 reserved name、CLI 输出解析、record id 提取、close
和文件删除。它比“只需要得到 ACP `session/new`
的模型广告”承担了更多状态与清理责任。

#### B. 持久化 cache 有 `fetchedAt`，但读取时没有 TTL 判断

`CachedCapability` 当前字段：

``` ts
interface CachedCapability {
  models: Array<{ modelId: string; name?: string }>;
  efforts: string[];
  effortKnown: boolean;
  fetchedAt: string;
}
```

`AgentCapabilityService.cached()` 只检查内存 Map / StateStore
中是否存在记录，没有判断 `fetchedAt`
是否过期。因此旧目录可能长期被当作可用缓存。

#### C. fingerprint 没覆盖完整的 CapabilityContext

当前 `CapabilityContext` 已包含：

- `cwd`
- `driver`
- `settingsPolicy`
- `launch`
- `suggestions`
- `configuredModel`

但 `capabilityCacheKey()` 实际只组合：

- `agent`
- `cwd`
- `launchFingerprint(launch)`
- `authFingerprint(env)`

而 `launchFingerprint()` 只包含
`agentCommand / acpxAgent / rawCommand / agentArgv`。`driver` 和
`settingsPolicy` 没有进入 key。

这会让不同 driver / Claude settings policy
的发现结果存在误复用风险。即使当前某些配置碰巧会改变
launch，也不能把这种间接关系当作身份保证。

#### D. Session status JSON 解析失败会被降级为空列表

`src/bridge/bridge-runtime.ts#getSessionModel()` 当前在 JSON parse catch
中返回：

``` ts
return { available: [] };
```

这把协议解析失败伪装成“Agent
正常返回了空模型目录”。`session-model-catalog.ts` 的
`coldFallbackWhenEmpty` 目前只在 OMP 路径启用，其他 Agent
可能因此错过冷探测。

#### E. 缓存优先级会遮挡后续 Session 广告

当前被动读取顺序为：

``` text
Bot owned runtime → persisted cache → ordinary sessions → needs-setup
```

由于 cache 不过期，只要曾经成功探测过，就可能长期跳过 ordinary Session
的新广告。V2 必须先修复时效，再定义来源优先级。

#### F. effort 被表达成一个 Agent 级列表，语义过宽

当前 `CapabilityAdvertisement` / `CachedCapability` 将 `efforts`
放在模型列表旁边作为一份全局能力。实际 ACP adapter
可能根据当前模型返回不同 config option。

另外，acpx 0.19.5 的 `inspectAgentModels()` 只返回模型
ID、名称和当前模型，不返回 effort/configOptions。因此冷探测不能把
`efforts: []` 解释成“已确认没有 effort”。

#### G. 真实 Agent 验证仍然不足

PR \#393 的验证记录明确说明，当时没有对
OMP、Claude、Codex、OpenCode、Cursor 做真实模型枚举；主要使用 fake
command output 覆盖 unauthenticated / unsupported 等情况。

V2 必须补真实 adapter 矩阵，不能只靠单元测试证明模型发现可靠。

------------------------------------------------------------------------

## 2. acpx 0.19.5 `inspectAgentModels()` 的真实契约

权威源码：

- [`src/runtime/public/probe.ts`，tag
  `v0.19.5`](https://github.com/openclaw/acpx/blob/v0.19.5/src/runtime/public/probe.ts)
- [`src/runtime/public/contract.ts`，tag
  `v0.19.5`](https://github.com/openclaw/acpx/blob/v0.19.5/src/runtime/public/contract.ts)
- [`src/runtime.ts`，tag
  `v0.19.5`](https://github.com/openclaw/acpx/blob/v0.19.5/src/runtime.ts)

### 2.1 API 形状

``` ts
type InspectAgentModelsOptions = {
  agentCommand: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  agentProcessEnv?: Record<string, string>;
};

async function inspectAgentModels(
  options: InspectAgentModelsOptions,
): Promise<AcpRuntimeSessionModels | undefined>;
```

返回类型：

``` ts
type AcpRuntimeSessionModels = {
  currentModelId?: string;
  availableModelIds: string[];
  availableModels?: Array<{
    modelId: string;
    name: string;
  }>;
};
```

它从 `acpx/runtime` 公共入口导出：

``` ts
import { inspectAgentModels } from "acpx/runtime";
```

### 2.2 实际生命周期

上游实现做了以下事情：

1.  检查外部 AbortSignal。
2.  建立自身 timeout AbortController，并与外部 signal 合并。
3.  创建 ACP Client。
4.  以 `permissionMode: "deny-all"` 和
    `nonInteractivePermissions: "deny"` 启动。
5.  禁用 `fs` 和 `terminal`。
6.  启动 Agent 并创建 ACP Session。
7.  读取 `session/new` 的 models 信息。
8.  在 `finally` 中取消 timer、移除 abort listener、关闭 Client。
9.  如果已 abort，先关闭 Client，再等待 inspection settle，最后再次
    close。

它不会发送用户 Prompt，也不创建 acpx Runtime Store / acpx 持久化 Session
Record。

### 2.3 必须保留的限制

- Agent 可能在自己的原生历史系统中创建 Session 历史；API
  只负责关闭自己拥有的 ACP Transport，不承诺删除 Agent 原生历史。
- `timeoutMs` 是启动 / Session 发现
  deadline；清理会被等待，整体耗时可能长于该值。
- `inspectAgentModels()` 不返回 effort 或完整 ACP `configOptions`。
- 它要求的是 **Agent 实际执行命令的 argv**，不是 `acpx` CLI
  自身的命令路径。
- 它不会自动理解 xacpx 的 managed adapter pin、local fallback、Hermes
  shim、用户 argv、raw command 或 Claude settings policy；这些必须由
  xacpx 在调用前正确解析。

因此它是一个更好的 ACP 探测原语，不是完整的 xacpx Model Discovery
Service。

------------------------------------------------------------------------

## 3. 目标架构

### 3.1 分层

``` text
ControlService
    │
    ▼
AgentCapabilityService
    ├── ContextResolver
    │     ├── canonical cwd
    │     ├── driver / settingsPolicy
    │     ├── resolved Agent Launch
    │     └── auth/config revision
    │
    ├── AdvertisementReader
    │     ├── target-owned Runtime
    │     └── compatible live Session
    │
    ├── CapabilityCache
    │     ├── memory
    │     ├── state.json capability_lists
    │     ├── TTL / stale
    │     └── generation fencing
    │
    ├── ProbeCoordinator
    │     ├── single-flight
    │     ├── timeout / cancellation
    │     └── background refresh
    │
    └── AcpxModelInspector
          └── acpx/runtime.inspectAgentModels()
```

### 3.2 职责边界

**AgentCapabilityService**

- 决定读取哪个来源。
- 决定 cache fresh / stale。
- 负责状态分类、single-flight、generation 和失效。
- 只返回 xacpx 自己定义的 DTO。
- 不直接拼 acpx CLI 命令。

**ContextResolver**

- 从现有配置和 Session Launch 解析链得到实际 Agent argv。
- 统一处理 driver、settingsPolicy、adapter pin、registry、preinstalled
  adapter、local fallback、用户 argv 和 raw command。
- 输出 cache fingerprint 所需的稳定身份信息。
- 不向 Web / Relay 暴露命令、环境变量或凭证。

**AcpxModelInspector**

- 唯一封装 `inspectAgentModels()` 的模块。
- 负责把 xacpx 已解析的 Agent argv、cwd、agentProcessEnv、AbortSignal 和
  timeout 交给 acpx。
- 将上游返回类型映射成 xacpx 内部 DTO。
- 不负责缓存，不负责 Bot / Session 身份，不负责 UI 状态。

**CapabilityCache**

- 只持久化可再生的模型目录和安全元数据。
- 不持久化明文凭证、环境变量、原始 command、隐藏 alias 或 Session
  alias。
- 读取旧缓存时必须验证 fingerprint version。

------------------------------------------------------------------------

## 4. Agent Launch 必须只有一个事实来源

这是 `inspectAgentModels()` 接入的前置条件。

### 4.1 不允许直接从 `agent` 字符串猜命令

正常会话的 launch 解析已经包含多种路径：

- 显式 `agents.<name>.command`
- 用户配置 `argv`
- xacpx 管理的 Codex / Claude 精确版本
- 已预安装的 managed adapter release
- Hermes ACP shim
- OpenCode / KiloCode / Reasonix / OMP 等 local fallback
- acpx 内建 driver
- `~/.acpx/config.json` 中的 overlay alias

相关实现：

- `src/config/resolve-agent-command.ts`
- `src/config/agent-launch.ts`
- `src/sessions/session-service.ts#resolveLaunchSpec`
- `src/transport/acpx-agent-overlay.ts`
- `src/transport/agent-registry.ts`
- `src/adapters/adapter-catalog.ts`

`inspectAgentModels()` 的 `agentCommand` 是 Agent child process 的
argv。因此不能把 `resolveAcpxCommand()` 返回的 acpx CLI binary 当作
`agentCommand`。

### 4.2 统一解析函数

建议新增一个可测试的公共内部 seam：

``` ts
interface ResolvedModelProbeLaunch {
  agentCommand: string[];
  cwd: string;
  agentProcessEnv?: Record<string, string>;
  identity: {
    agent: string;
    driver: string;
    settingsPolicy: string;
    launchDigest: string;
    adapterVersion?: string;
    adapterRegistryDigest?: string;
    authRevision: string;
    configRevision: string;
  };
}

function resolveModelProbeLaunch(
  context: CapabilityContext,
): Promise<ResolvedModelProbeLaunch>;
```

要求：

1.  结构化 `agentArgv`、managed adapter argv、Hermes shim、local
    fallback 直接复用现有解析结果。
2.  bare acpx driver 通过 acpx registry 解析；不能手写复制 driver →
    command 映射表。
3.  overlay alias 必须读取与正常 acpx Session 相同的 registry/config
    来源。
4.  Unix raw command 使用与正常 acpx 启动等价的解析规则；Windows
    不允许为探测放宽现有 raw command fail-closed 约束。
5.  Claude `settingsPolicy` 必须复用现有
    `resolveClaudeAgentProcessEnv()` / 等价逻辑，不能只传普通
    `process.env`。
6.  对无法证明和正常 Session 使用同一 launch 的情况，返回结构化
    `probe-unavailable`，不能退回猜测 driver 名称。
7.  对实际解析出的 argv 做 digest；日志只记录 digest 前缀，绝不记录完整
    argv。

### 4.3 acpx 导入边界

新增
`src/transport/acpx-model-inspector.ts`（名称可调整）作为唯一模型检查封装：

``` ts
// 只允许这个受控模块新增 inspectAgentModels import
import { inspectAgentModels } from "acpx/runtime";
```

同步更新：

- `scripts/lint-acpx-imports.mjs` allowlist
- 对 allowlist 的单元测试
- `src/transport/acpx-model-inspector.ts` 的 API contract tests

不得导入 `acpx/src/*`、`acpx/dist/*` 或内部未公开模块。`package.json`
继续精确固定 `acpx: 0.19.5`，不改成浮动 range。

------------------------------------------------------------------------

## 5. V2 模型发现生命周期

### 5.1 被动读取

被动读取不应无条件启动新 Agent。它先利用已有可信数据：

``` text
请求 Agent + workspace (+ optional Bot)
                 │
                 ▼
       resolve context / fingerprint v2
                 │
                 ▼
     Bot 自有、同身份的活跃 Runtime？
          ├── yes → 返回 runtime advertisement
          └── no
                 │
                 ▼
        fingerprint v2 的 fresh cache？
          ├── yes → 返回 fresh cache
          └── no
                 │
                 ▼
      同身份、未归档的活跃普通 Session？
          ├── 有可信 advertisement → 返回 session
          └── 没有
                 │
                 ▼
          是否有 stale cache？
          ├── yes → 返回 stale + 启动后台 refresh
          └── no  → 返回 needs-setup / Fetch models
```

说明：

- Bot 自有 Runtime 只用于该 Bot，必须匹配 Bot id 和完整 launch
  identity。
- ordinary Session 必须排除产品隐藏 Session、归档 Session 和不同 launch
  的 Session。
- fresh cache 不被一个无法证明新鲜度的旧 Session 覆盖。
- stale cache 不再阻挡新的 compatible Session。
- 没有任何历史数据时仍由用户显式点击 Fetch
  models，不在打开对话框时无条件启动 Agent。
- 用户显式 `probe: true` 不走上述短路，必须重新验证。

### 5.2 显式刷新

``` text
probe: true
   │
   ├── bypass runtime shortcut
   ├── bypass fresh/stale cache shortcut
   ├── bypass ordinary Session shortcut
   └── ProbeCoordinator.inspect(fingerprint, generation)
                    │
                    ▼
             inspectAgentModels()
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
      valid result          failure
          │                   │
          ▼                   ▼
   normalize catalog     preserve last-good
   persist cache         attach failure reason
   publish update        never overwrite cache
```

同 fingerprint 正在进行的有效 probe
可以被并发请求共享；显式刷新不能直接返回旧 cache 冒充新结果。

### 5.3 后台 stale refresh

- 只有存在 stale positive cache 时才允许被动读取触发后台刷新。
- 同一 fingerprint + generation 同时最多一个后台 probe。
- RPC 先返回 stale state，不等待 Agent 冷启动。
- 成功后更新 cache，并发出 instance-scoped `agent-capabilities-changed`
  信号，让 Web 丢弃短缓存并重新读取。
- 失败时保留旧 cache，并在当前 daemon
  内记录最近一次刷新失败；不能把失败时间写成 `fetchedAt`。
- 后台刷新不得改变 Bot 配置、Session 当前模型或 effort。

如果第一阶段暂时不实现事件推送，可先只实现 stale 标记 +
手动刷新；不能在没有通知机制时声称已经实现完整 stale-while-revalidate。

------------------------------------------------------------------------

## 6. 缓存身份：Fingerprint V2

### 6.1 建议组成

``` ts
interface CapabilityFingerprintV2 {
  schemaVersion: 2;
  agent: string;
  driver: string;
  canonicalCwd: string;
  settingsPolicy: string;
  launchDigest: string;
  resolvedAgentCommandDigest: string;
  adapterVersion?: string;
  adapterRegistryDigest?: string;
  configRevision: string;
  authRevision: string;
}
```

最终 cache key：

``` ts
const key = sha256(stableSerialize(fingerprintV2));
```

字段说明：

| 字段                         | 目的                                                                 |
|------------------------------|----------------------------------------------------------------------|
| `agent`                      | 区分配置中的 Agent 名称                                              |
| `driver`                     | 防止同一个 Agent 配置切换 driver 后误用旧目录                        |
| `canonicalCwd`               | 使用 realpath / 平台规范化后的 workspace 身份                        |
| `settingsPolicy`             | 区分 Claude provider-only / isolated / full-user                     |
| `launchDigest`               | 覆盖 agentCommand、acpxAgent、rawCommand、agentArgv 的完整身份       |
| `resolvedAgentCommandDigest` | 覆盖最终实际执行 argv，防止 overlay / registry / local fallback 漂移 |
| `adapterVersion`             | managed adapter pin / preinstalled release 变化时换 key              |
| `adapterRegistryDigest`      | registry 来源变化时换 key                                            |
| `configRevision`             | 认证外的 Agent 运行配置发生变化时换 key                              |
| `authRevision`               | 登录状态或认证材料变化时换 key                                       |

### 6.2 凭证处理

严禁把以下数据明文写入 cache、日志或 Relay DTO：

- API Key / Token / Secret
- `agentProcessEnv`
- 完整 argv 中可能包含的敏感参数
- 原始 auth 文件内容

建议：

1.  对明确允许参与身份判断的认证环境变量做
    allowlist，不再依赖一个过宽的正则扫描所有环境变量。
2.  使用本机安装级 secret 做 HMAC fingerprint；secret
    应独立、安全持久化，不随普通诊断日志输出。
3.  对 adapter auth/config 文件可记录规范化路径身份及
    `mtime / size / file identity` 等元数据，不读取内容写入 cache。
4.  xacpx 能感知的 login/logout 操作递增 `authRevision`。
5.  无法可靠检测外部 CLI 登录变化时，依赖短 TTL + 显式 refresh 兜底。
6.  日志只输出 `fingerprint.slice(0, 8)`，不输出原始 key 输入。

### 6.3 必须覆盖的失效边界

- agent 名称或 driver 变化
- workspace cwd / realpath 变化
- `settingsPolicy` 变化
- command / argv / acpxAgent / rawCommand 变化
- managed adapter 版本或 preinstalled release 变化
- adapter registry 变化
- Claude settings profile 变化
- 登录 / 登出 / auth revision 变化
- 用户显式刷新
- cache schema / fingerprint version 升级

### 6.4 V1 cache 迁移

旧 `capability_lists` key 不包含完整 driver / settingsPolicy
身份，无法证明与 V2 fingerprint 相同。

因此：

- V1 记录不迁移成 V2 fresh cache。
- V1 记录不能继续作为“已验证模型目录”返回。
- 可以保留旧数据供回滚诊断，但必须标记 legacy / stale，不能静默混入 V2。
- V2 首次成功探测后写入新 key。
- V1 数据可在后续 GC 中清理。

这会让升级后的部分 Agent 需要重新 Fetch
models，但比跨配置误用旧模型目录安全。

------------------------------------------------------------------------

## 7. TTL、Stale、Single-flight 与 Generation Fencing

### 7.1 初始缓存策略

建议先采用以下可调参数：

| 参数                               |     初始值 | 说明                                                |
|------------------------------------|-----------:|-----------------------------------------------------|
| `MODEL_CATALOG_SOFT_TTL_MS`        |    15 分钟 | 正向模型目录的 fresh 窗口                           |
| `MODEL_CATALOG_STALE_RETENTION_MS` |      30 天 | stale cache 保留上限，超过后 GC                     |
| `MODEL_CATALOG_NEGATIVE_TTL_MS`    |      30 秒 | 仅进程内抑制短时间重复失败；不持久化 negative cache |
| Web capability RPC cache           | 现有 60 秒 | 只用于减少重复 RPC，不是 daemon 事实源              |

15 分钟是 V2 的初始工程参数，不是对所有 Agent 的永久保证。真实 Agent
测试后可按 driver 观察结果调整。

### 7.2 Cache Entry

``` ts
interface CachedCapabilityV2 {
  schemaVersion: 2;
  fingerprintVersion: 2;
  models: Array<{ modelId: string; name?: string }>;
  fetchedAt: string;
  softExpiresAt: string;
  source: "probe" | "runtime" | "session";
  adapterVersion?: string;
}
```

不持久化：

- 原始 command / argv
- cwd 明文（如业务上不需要）
- 凭证或 env
- Session alias / ACPX record id
- 当前 Bot 的 selectedModel / selectedEffort

`fetchedAt` 只在成功取得新目录时更新。失败、stale read、cache hydration
均不得刷新该时间。

### 7.3 Fresh / Stale 语义

| 状态                   | 行为                                                |
|------------------------|-----------------------------------------------------|
| fresh                  | 正常返回，来源标记 cache/runtime/session            |
| stale + refreshing     | 返回旧目录并明确 stale，后台 single-flight 正在验证 |
| stale + refresh failed | 保留旧目录，展示最近一次验证失败原因                |
| expired retention      | 不再展示为历史目录；删除后返回 needs-setup          |
| explicit probe         | 绕过 cache，等待本次 probe 结果                     |

stale 模型可以继续作为用户可选项展示，但 UI
必须明确它不是最新验证结果。执行阶段仍由 Agent adapter
决定模型是否有效；不能把 stale 目录当作调用授权。

### 7.4 Single-flight 与 Generation Fencing

当前 `inflight` 只按 fingerprint 存 Promise。V2 应把 generation
纳入并发身份：

``` ts
type ProbeFlightKey = `${fingerprint}:${generation}`;

interface ProbeCoordinator {
  generationFor(fingerprint: string): number;
  invalidate(fingerprint: string): void;
  run(
    fingerprint: string,
    generation: number,
    task: () => Promise<AgentCapabilityProbeResult>,
  ): Promise<AgentCapabilityProbeResult>;
}
```

规则：

1.  同 fingerprint + generation 的并发 probe 合并。
2.  invalidate 时 generation 递增。
3.  新请求不能复用旧 generation 的 Promise。
4.  probe 结束后，只有 generation 仍匹配才能写 cache / publish。
5.  旧 probe 可以正常完成和清理资源，但结果不能覆盖新状态。
6.  `finally` 只删除自己那一代 flight，不能误删新 flight。
7.  cache 写入失败不影响当前 RPC 返回；但必须记录持久化失败。

------------------------------------------------------------------------

## 8. 模型目录状态语义

V2 不允许用一个 `[]` 表达所有失败。

### 8.1 状态定义

| 状态          | 语义                                              | UI 处理                                |
|---------------|---------------------------------------------------|----------------------------------------|
| `ready`       | 至少一个模型被 adapter 明确公布                   | 展示 adapter models                    |
| `empty`       | ACP 明确返回 models 对象，但 availableModels 为空 | 显示“Agent 已响应，但没有公布可选模型” |
| `unsupported` | Agent 没有公布模型元数据 / 不支持枚举             | 保留 default 和 custom id              |
| `needs-setup` | 需要认证或用户完成 setup                          | 显示登录 / setup 提示                  |
| `error`       | timeout、transport、protocol、cleanup 等失败      | 展示可操作错误和 retry                 |
| `loading`     | Web 本地状态                                      | 不作为 daemon wire state               |

`stale` 不是新的业务 status，而是 `ready` 的 freshness 元数据：

``` ts
type CapabilityFreshness = "fresh" | "stale";
```

### 8.2 acpx inspector 结果分类

`inspectAgentModels()` 的三种关键返回形态：

| 上游返回                              | V2 分类                                    |
|---------------------------------------|--------------------------------------------|
| `undefined`                           | `unsupported`：没有模型广告                |
| `{ availableModels: [] }`             | `empty`：明确广告了空列表                  |
| `{ availableModels: [...] }`          | `ready`                                    |
| throw / timeout / abort / spawn error | `needs-setup` 或 `error`，按可证明原因分类 |

认证失败优先使用结构化错误类型 /
code；只有上游没有结构化信息时才允许使用有测试覆盖的 adapter-specific
文本分类。不能把普通启动失败猜成 unauthenticated。

### 8.3 Protocol DTO 建议

在 `packages/relay-protocol/src/agent-capability.ts` 中：

- 新增 `empty` state。
- 新增 `freshness`、`refreshing`、`lastVerifiedAt` 等可选字段。
- `ready.models` 继续只允许 adapter-verified models。
- `suggestions` 继续单独保存。
- `reason` 继续只表达失败 / stale refresh 原因。
- parser 对未知或不完整 payload 继续 fail-closed，不降级成空模型数组。

示意：

``` ts
interface ReadyCapabilityV2 {
  status: "ready";
  models: [CapabilityModel, ...CapabilityModel[]];
  suggestions: CapabilityModel[];
  source: "runtime" | "cache" | "session" | "probe";
  fetchedAt: string;
  freshness: "fresh" | "stale";
  refreshing?: boolean;
  lastVerifiedAt?: string;
  reason?: CapabilityReason;
  efforts: EffortView;
}

interface EmptyCapabilityV2 {
  status: "empty";
  reason: CapabilityReason;
  fetchedAt: string;
  suggestions: CapabilityModel[];
  recovery: string;
}
```

新增 `empty` 是 wire schema 变化。Relay Protocol、Core、Connector、Web
必须一起更新；旧版本遇到未知状态时应显示 stale-response /
unavailable，而不是把它渲染成 ready 空列表。

------------------------------------------------------------------------

## 9. Effort / Model-specific Config Options

### 9.1 V2 不从 `inspectAgentModels()` 推断 effort

acpx 0.19.5 `AcpRuntimeSessionModels` 只包含：

- `currentModelId`
- `availableModelIds`
- 可选 `availableModels[{ modelId, name }]`

它不包含：

- `configOptions`
- 每个模型支持的 effort
- 当前模型的 reasoning 参数范围

所以新冷探测必须把 effort 标记为 unavailable，而不是把 `[]` 标记成
known-empty。

### 9.2 保留 Session 级真实读取

当前 Session 已有：

- `getSessionEffort()`
- `setSessionEffort()`
- 切换 model 后重新读取 effort 的流程

V2 保留此行为，并明确 effort 数据的 scope：

``` ts
interface EffortView {
  status: "known" | "unavailable";
  options?: CapabilityEffort[];
  current?: string;
  forModelId?: string;
}
```

规则：

1.  从当前 Session 读取的 effort，只对当时的 `currentModelId` 有效。
2.  切换模型后必须重新读取；旧模型的 effort 选项不能自动套给新模型。
3.  如果 `forModelId` 与当前选择不匹配，不显示为该模型的已验证选项。
4.  刷新失败可以保留最后一次合法选项，但必须保留其
    `forModelId`，不能伪装成当前模型的能力。
5.  cold probe 未返回 effort 时，UI 隐藏 effort 控件或显示
    unavailable；不显示空的 known list。

### 9.3 未来扩展条件

只有当 ACP 协议或 adapter 明确提供模型级 config option 证据，并且 xacpx
能稳定关联到具体 model id 时，才考虑增加：

``` ts
model.capabilities.effort
```

在此之前不建立猜测式 Model A / B / C effort 矩阵。

------------------------------------------------------------------------

## 10. Session Model Read 的协议错误处理

Capability RPC 与 Session composer 的 `control.session.model.get`
是不同读取入口，但应共享“不能把坏响应当成空目录”的原则。

### 10.1 `getSessionModel()` 严格解析

当前 `bridge-runtime.ts#getSessionModel()` 的 JSON parse catch
返回空列表，必须修复。

建议规则：

- JSON parse 失败：抛出 typed `ModelCatalogProtocolError`。
- 顶层不是 object：typed protocol error。
- `availableModels` 缺失或类型不正确：标记 incomplete /
  unknown，不等于空目录。
- `availableModels: []`：只有在结构完整且 adapter
  确实明确返回空数组时，才分类为 empty。
- 数组元素无效：过滤单个无效项并记录 parse warning；若全部无效，按
  malformed/incomplete 处理。
- `model` / current model 不合法：不覆盖已有合法 current model。

### 10.2 统一 fallback

将当前仅 OMP 使用的 `coldFallbackWhenEmpty` 收敛成结构化 read quality：

``` ts
type NativeModelRead =
  | { status: "complete"; current?: string; available: string[] }
  | { status: "missing" }
  | { status: "malformed"; error: ModelCatalogProtocolError };
```

建议：

- `missing` / `malformed` 且 transport 支持 safe probe：用 exact launch
  的 `inspectAgentModels()` fallback。
- `complete + available: []`：保留 empty，不自动当作解析失败。
- fallback 失败时保留原始 native read error，除非原始结果本来就是完整
  empty。
- `refresh: true` 始终绕过 native Session read 和所有 cache，执行精确
  launch probe。

------------------------------------------------------------------------

## 11. API、Relay 与 UI 行为

### 11.1 Control API

保留 `control.agents.capabilities.get`，不新增另一个并行模型目录 API。

现有输入保持：

``` ts
{
  agent: string;
  workspace: string;
  botId?: string;
  probe?: boolean;
}
```

`probe: true` 继续代表显式重新验证。V2 可增加可选
`refreshMode`，但第一阶段不需要；不要把普通 `get` 改成必定冷启动 Agent。

### 11.2 后台刷新事件

建议增加 instance-scoped `agent-capabilities-changed` control event：

``` ts
{
  agent: string;
  workspace: string;
}
```

不发送 fingerprint、cwd、command、argv、auth revision、Bot hidden alias
或凭证。

Web 收到事件后：

1.  失效该 instance + agent + workspace 下的 capability 短缓存。
2.  如果相关对话框仍打开，重新读取 capability。
3.  如果没有相关 UI，不必主动创建新 RPC。
4.  旧请求仍通过 request sequence / context revision
    fencing，不能覆盖新结果。

### 11.3 ModelPicker

保留当前单一 `ModelPicker.vue`，不为 Bot / New Session 再建两套。

| 状态               | UI                                                          |
|--------------------|-------------------------------------------------------------|
| loading            | loading 文案                                                |
| ready + fresh      | 正常模型列表                                                |
| ready + stale      | 显示上次验证时间和 stale 提示；提供 Refresh                 |
| ready + refreshing | 保留旧列表，显示后台更新中                                  |
| empty              | 说明 Agent 响应成功但没有模型选项；保留 default / custom id |
| unsupported        | 说明该 adapter 不提供枚举；保留 default / custom id         |
| needs-setup        | 显示认证提示                                                |
| error              | 显示错误与 retry                                            |

继续遵守：

- suggestions 与 adapter models 分组。
- 默认模型和自定义 ID 始终可用。
- selectedModelId 与 appliedModelId 不混为一谈。
- 显式 Fetch models 永远 bypass cache。
- stale models 可以显示，但不能显示成“刚验证”。
- 失败时保留上次有效目录，不因一次探测失败而清空选择器。

### 11.4 Web 短缓存

现有 60 秒 Web cache 只负责 RPC 去重，不负责 Agent 模型真实性。

保留其 instance + agent + workspace + bot 作用域和 in-flight
合并；补充：

- `agent-capabilities-changed` 事件失效。
- probe response sequence fencing。
- instance online/offline、workspace changed、bots changed 继续失效。
- 不要因每次打开对话框都无条件清空 cache，避免失去短缓存价值。

------------------------------------------------------------------------

## 12. 超时、取消与资源清理

### 12.1 超时预算

建议初始值：

| 阶段                                  |                    建议 |
|---------------------------------------|------------------------:|
| Agent startup + ACP Session discovery |                   75 秒 |
| Probe service 总预算                  |                   90 秒 |
| Hub / Relay RPC 上限                  | 继续低于现有 120 秒约束 |

具体值应受 `sessionInitTimeoutMs` 约束，不能超过上层 RPC budget。

### 12.2 取消规则

- `inspectAgentModels()` 接收 AbortSignal。
- 用户关闭弹窗不应默认取消全局 single-flight：同一 fingerprint
  的其他调用可能仍在等待。
- 只有 probe owner / daemon shutdown / 明确全局取消才取消底层探测。
- 一个 Web waiter 取消时，只解除该 waiter；不能取消其他 waiter
  共用的探测。
- daemon shutdown 必须取消或等待所有 probe settle。

### 12.3 清理规则

- 不再自行执行 `sessions close` 和删除 ACPX record。
- 由 `inspectAgentModels()` 拥有并关闭其 ACP Client。
- 不要在 Promise.race 超时后直接返回并遗弃仍在运行的 inspector；必须等待
  inspector 自己完成 abort + close 流程。
- 清理异常不得写入成功 cache。
- 明确记录 Agent 可能保留 native history；这不是 acpx record
  泄漏，也不能未经授权删除 Agent 原生历史。

------------------------------------------------------------------------

## 13. Observability

建议新增结构化事件：

| Event                                      | 触发点                                          |
|--------------------------------------------|-------------------------------------------------|
| `agent.model_discovery.cache_hit`          | 命中 fresh cache                                |
| `agent.model_discovery.cache_stale`        | 命中 stale cache                                |
| `agent.model_discovery.probe_started`      | inspector 开始                                  |
| `agent.model_discovery.probe_succeeded`    | 获得有效模型目录                                |
| `agent.model_discovery.probe_empty`        | 明确空目录                                      |
| `agent.model_discovery.probe_unsupported`  | 未公布模型信息                                  |
| `agent.model_discovery.probe_failed`       | timeout / auth / transport / protocol / cleanup |
| `agent.model_discovery.cache_invalidated`  | 配置或认证变化                                  |
| `agent.model_discovery.cache_write_failed` | 持久化失败                                      |

建议字段：

- `agent`
- `driver`
- `source`
- `outcome`
- `durationMs`
- `modelCount`
- `cacheAgeMs`
- `fingerprintPrefix`
- `acpxVersion`
- `background` / `explicit`

严禁记录：

- env 值、token、API key
- 完整 command / argv
- auth 文件内容
- hidden alias / ACPX record id
- 用户 Prompt

第一阶段至少能回答：

1.  哪些 driver 探测成功率最低？
2.  哪些 driver 平均冷启动时间最长？
3.  空列表究竟来自 empty advertisement、unsupported 还是 malformed
    response？
4.  stale cache 最常见的刷新失败原因是什么？
5.  acpx inspector 替换后，是否仍有 Session / record 残留问题？

------------------------------------------------------------------------

## 14. 迁移与兼容策略

### 14.1 代码迁移

- 保留 `control.agents.capabilities.get` RPC 名称。
- 保留 PR \#393 的 `ready / unsupported / needs-setup / error`
  语义；新增 `empty` 和 freshness 元数据。
- `AgentCapabilityProbeRequest` 继续携带 driver、settingsPolicy 和
  launch identity。
- `AgentCapabilityProbeResult` 改为明确表达 effort
  unavailable，而不是用空数组代表 known-empty。
- `CapabilityCacheRecord` 增加 schema / fingerprint version。
- V1 cache 不作为 V2 fresh cache 使用。
- 不改 `acpx` 版本，不引入额外依赖。
- `acpx/runtime` 新 import 必须经受控边界和 lint allowlist。

### 14.2 Runtime / CLI Engine 边界

模型探测是 agent-level 操作，不是某个逻辑 Session 的 Runtime 操作。

- 保留 EngineRouter 把 cold probe 路由到 CLI Engine 的原则。
- 不为了模型目录创建 Runtime Worker。
- Runtime Engine 仍不需要把探测 Session 绑定到某个逻辑 alias。
- Bridge / CLI 两条入口最终应调用同一 `AcpxModelInspector`
  封装，避免两份探测实现行为漂移。
- acpx CLI 命令仍用于正常 Session 管理；V2 只替换模型冷探测，不改普通
  prompt / session 控制路径。

### 14.3 发布兼容

- Core、Relay Protocol、Connector、Relay Web 的新增状态需要同版本发布。
- 老 connector 返回 `unknown-type` 时，继续显示功能不可用 /
  升级提示，不退化成空模型列表。
- 新 Web 遇到旧 Core 的不完整 payload，继续走
  `parseAgentCapabilityState()` 的 fail-closed 分支。
- `state.json` 旧字段保持可读；V2 cache 记录通过版本字段区分。

------------------------------------------------------------------------

## 15. 分阶段实施计划

### Phase 0 — 锁定契约和测试基线

**目标：** 先证明 launch resolver 和 acpx inspector 的接口接线正确。

任务：

1.  新增 `AcpxModelInspector` 单元测试，覆盖上游返回 `undefined`、空
    models、非空 models、throw、abort、timeout。
2.  为每类 Agent 验证 `resolveModelProbeLaunch()` 的 argv 与正常 Session
    实际 launch 完全一致。
3.  验证 Claude settingsPolicy 对 `agentProcessEnv` 的影响。
4.  更新 acpx import lint allowlist。
5.  不改 UI、不改 cache 行为。

验收：probe 使用的 Agent argv 与正常 Session 的 launch identity
一致；没有新增 acpx 私有 import。

### Phase 1 — 修复错误分类与 fingerprint v2

任务：

1.  修复 `getSessionModel()` JSON parse fail-open-to-empty。
2.  引入 `ModelCatalogProtocolError` / `NativeModelRead` 结构化结果。
3.  新增 `CapabilityFingerprintV2`。
4.  把 driver、settingsPolicy、adapter version/registry 和 auth/config
    revision 纳入 fingerprint。
5.  V1 cache 失效策略落地。
6.  增加 cache fingerprint migration tests。

验收：不同 driver / settingsPolicy / adapter pin / auth revision
不会互相命中 cache；坏 JSON 不会返回有效空目录。

### Phase 2 — 替换冷探测实现

任务：

1.  新增唯一 `src/transport/acpx-model-inspector.ts`。
2.  通过 `resolveModelProbeLaunch()` 得到真实 Agent argv / cwd / env。
3.  调用 `inspectAgentModels()`。
4.  处理 undefined / empty / non-empty 三种结果。
5.  映射 timeout / auth / transport 错误。
6.  删除 `CAPABILITY_PROBE_SESSION_NAME`、CLI status/show 解析、record
    id 删除路径中仅服务于 capability probe 的代码。
7.  Bridge / CLI 两条入口统一调用同一 inspector。

验收：不创建 xacpx 可见 Bot Topic，不写 ACPX Session Record，不执行用户
Prompt；inspector close 被等待；失败结果不缓存。

### Phase 3 — Cache freshness 与后台刷新

任务：

1.  新增 cache schemaVersion / fingerprintVersion / softExpiresAt。
2.  fresh cache 命中。
3.  stale cache 保留并返回 freshness。
4.  加入 single-flight + generation fencing。
5.  加入 explicit refresh bypass。
6.  加入 stale background refresh。
7.  增加 `agent-capabilities-changed` 事件。
8.  增加 cache retention GC。

验收：旧探测不能覆盖新结果；刷新失败不清空
last-good；后台刷新不阻塞首屏；重启后 stale 时间不被重置。

### Phase 4 — Relay Web 与 effort 语义

任务：

1.  Protocol 增加 `empty` 和 freshness 字段。
2.  Web ModelPicker 增加 stale / refreshing / empty 状态。
3.  新增事件驱动的 Web cache invalidation。
4.  effort 标记 `forModelId` 或明确 current-model scope。
5.  cold inspector 不再产生 `effortKnown: true` 的假设。
6.  保留切换模型后重新读取 effort 的现有流程。
7.  补中英文 i18n parity tests。

验收：没有模型目录、明确空目录、unsupported、unauthenticated 和
transport error 在 UI 中可区分；旧 effort 不会被套用到新模型。

### Phase 5 — 真实 Agent 矩阵与发布门槛

任务：

1.  建立可选运行的真实 Agent smoke suite。
2.  至少覆盖下面测试矩阵。
3.  收集成功率、探测耗时、空目录比例和清理结果。
4.  根据结果调整 15 分钟 TTL 和 75 / 90 秒 timeout。
5.  分别验证 Windows、macOS、Linux。

验收：不能以 mock-only 测试作为 Model Discovery V2 完成标准。

------------------------------------------------------------------------

## 16. 测试策略

### 16.1 单元测试

**Launch resolver**

- built-in driver
- acpx overlay alias
- user argv
- raw command
- managed Codex / Claude adapter pin
- preinstalled adapter release
- local fallback
- Hermes shim
- Windows raw command fail-closed
- Claude provider-only / isolated / full-user env

**Inspector**

- `undefined` result
- `availableModels: []`
- one / many models
- display name absent
- duplicate model IDs
- blank model IDs
- current model not in available list
- timeout
- AbortSignal before spawn / during startup / during session/new
- child close and cleanup completion
- agent native history caveat
- no prompt dispatch

**Cache**

- fresh hit
- stale hit
- expired retention GC
- V1 cache ignored
- fingerprint field changes
- secret never appears in serialized cache / logs
- failed cache write
- failed refresh preserves last-good
- single-flight
- generation fencing
- invalidation during probe
- old flight cannot delete new flight

**Session catalog**

- valid JSON with non-empty models
- valid JSON with explicit empty array
- missing availableModels
- wrong field type
- malformed JSON
- malformed individual entries
- cold fallback for missing / malformed
- no fallback for complete empty result
- `refresh: true` always probes

### 16.2 Control / Relay / Web 测试

- old connector `unknown-type`
- new Core + new Web `empty` state
- new Core + old Web unknown status fail-closed
- stale cache first paint
- background refresh success event
- background refresh failure retains old list
- event invalidates only the right instance / agent / workspace scope
- stale RPC response cannot overwrite a newer explicit probe
- closing one dialog does not cancel another caller’s shared probe
- custom model id remains editable in every non-ready state

### 16.3 真实 Agent 测试矩阵

| Agent / Driver | 必测配置                                 | 关键验证                                             |
|----------------|------------------------------------------|------------------------------------------------------|
| Claude Code    | OAuth / API Key / Gateway（可用时）      | 模型广告、settingsPolicy、认证失败、Gateway 动态模型 |
| Codex          | ChatGPT 登录 / 可用的其他认证形态        | 模型广告、CLI 版本变化、账号模型缓存                 |
| OMP            | 不同模型和实际配置                       | 空目录、模型恢复、effort 随模型变化                  |
| OpenCode       | 至少两个 Provider                        | Provider 模型列表、认证变化                          |
| Cursor         | 当前可运行版本                           | 实际模型广告和启动超时                               |
| Gemini ACP     | 已认证 / 未认证                          | unsupported / needs-setup 分类                       |
| 其他 ACP Agent | 至少一个模型枚举 Agent、一个不枚举 Agent | 通用 ACP 兼容性                                      |

每次真实测试保存结构化结果，不保存凭证：

``` ts
interface ModelDiscoverySmokeResult {
  driver: string;
  adapterVersion?: string;
  platform: NodeJS.Platform;
  outcome: "ready" | "empty" | "unsupported" | "needs-setup" | "error";
  modelCount: number;
  durationMs: number;
  cleanupCompleted: boolean;
  cacheRoundTrip: boolean;
}
```

### 16.4 回归测试

必须确认：

- 新建 Session 的 model / effort 选择行为不回退。
- Bot 默认模型仍按保存配置生效。
- Session composer 仍可即时切换模型。
- 不会因 stale model 选择失败而误报为已应用。
- `setModel` 的真实执行结果仍由 runtime / adapter 确认。
- 模型探测不会改变 Session engine affinity。
- 不会产生可见的 `xacpx-capability-probe` Session。
- 不会删除正常用户 ACPX Session Record。
- `scripts/lint-acpx-imports.mjs` 通过。

------------------------------------------------------------------------

## 17. 验收标准

V2 只有同时满足以下条件才算完成：

### 正确性

- [ ] cold probe 使用 `acpx/runtime.inspectAgentModels()`。
- [ ] probe argv 与正常 Session 的有效 Agent launch 完全一致。
- [ ] 不发送用户 Prompt。
- [ ] 不创建 xacpx Bot Topic 或 ACPX 持久化 Session Record。
- [ ] `undefined` / explicit empty / malformed / unauthenticated /
  timeout 可区分。
- [ ] malformed status JSON 不会被转换成成功空列表。
- [ ] stale cache 不会冒充 fresh cache。
- [ ] 不同 driver / settingsPolicy / adapter version / auth revision
  不会误用同一 cache。
- [ ] 旧 probe 不会覆盖新 generation 的结果。
- [ ] 刷新失败保留 last-good cache。

### UI

- [ ] ready、stale、refreshing、empty、unsupported、needs-setup、error
  有清晰反馈。
- [ ] default / custom ID / suggestions 继续可用且互不混淆。
- [ ] effort 只显示当前模型有证据支持的选项。
- [ ] explicit refresh 确实绕过所有 cache。
- [ ] 后台更新不会让用户丢失当前选择。

### 质量

- [ ] 单元测试、Protocol 测试、Web 测试通过。
- [ ] 真实 Agent smoke matrix 至少覆盖 Claude、Codex、OMP、OpenCode
  中可运行的环境。
- [ ] 至少 macOS / Windows / Linux 中两种平台完成真实 probe
  验证，第三种至少完成 CI / mock process coverage。
- [ ] 日志不泄漏凭证、argv、hidden alias。
- [ ] acpx import lint 通过。
- [ ] 没有引入 acpx 私有 API 或上游 patch。

------------------------------------------------------------------------

## 18. 风险与待确认问题

| 问题                                                        | 当前判断                                                             | 处理                                              |
|-------------------------------------------------------------|----------------------------------------------------------------------|---------------------------------------------------|
| `inspectAgentModels()` 是否适用于所有 acpx registry Agent？ | API 通用，但具体 adapter 可能不广告 models                           | 用真实矩阵确认；unsupported 是合法结果            |
| Agent 原生 history 是否会增加记录？                         | 上游注释明确允许 Agent 创建 native session history                   | 接受该限制；不要擅自删除 Agent 原生历史           |
| `agentCommand` 是否能对所有 custom raw command 无损解析？   | 必须与 acpx 正常 launch 语义一致                                     | Phase 0 建立 parity tests；不能证明时 fail closed |
| 外部 CLI 登录变化如何即时检测？                             | xacpx 不一定收到登录事件                                             | auth file metadata + TTL + explicit refresh       |
| stale cache 是否允许选择？                                  | 建议允许，但明确 stale                                               | 执行阶段由 adapter 再验证                         |
| 15 分钟 TTL 是否适合所有 Agent？                            | 初始值，不是固定真理                                                 | 依据真实 smoke 数据调整                           |
| 是否需要 Model Manifest？                                   | xacpx 以 ACP 动态广告为主，暂时没有足够收益                          | V2 不引入全局静态目录                             |
| 是否应支持 Runtime Engine 自己执行 cold probe？             | agent-level probe 当前由 EngineRouter 路由 CLI，避免绑定逻辑 Session | V2 保持，不创建 Runtime Worker                    |
| per-model effort 能否提前发现？                             | 当前 `inspectAgentModels()` 不提供                                   | 暂不支持静态矩阵；使用当前 Session 实时读取       |

------------------------------------------------------------------------

## 19. 关键文件清单

### 核心实现

- `src/agents/capability-discovery.ts`
- `src/agents/capability-cache.ts`
- `src/agents/capability-probe.ts`
- `src/transport/types.ts`
- `src/transport/session-model-catalog.ts`
- `src/transport/acpx-cli/acpx-cli-transport.ts`
- `src/bridge/bridge-runtime.ts`
- `src/bridge/engine/engine-router.ts`
- `src/bridge/engine/runtime-engine.ts`
- `src/bridge/bridge-server.ts`
- `src/transport/agent-registry.ts`
- `src/config/resolve-agent-command.ts`
- `src/config/agent-launch.ts`
- `src/sessions/session-service.ts`

### Relay / Web

- `packages/relay-protocol/src/agent-capability.ts`
- `packages/relay-protocol/src/messages.ts`
- `packages/relay-web/src/stores/instances.ts`
- `packages/relay-web/src/components/ModelPicker.vue`
- `packages/relay-web/src/i18n/messages/en.ts`
- `packages/relay-web/src/i18n/messages/zh-CN.ts`

### Tests / Gates

- `tests/unit/agents/capability-discovery.test.ts`
- `tests/unit/agents/capability-cache.test.ts`
- `tests/unit/agents/capability-probe.test.ts`
- `tests/unit/transport/session-model-catalog.test.ts`
- `tests/unit/commands/transport-invoker-model-catalog.test.ts`
- `packages/relay-web/src/__tests__/model-picker.test.ts`
- `packages/relay-web/src/__tests__/instances.test.ts`
- `scripts/lint-acpx-imports.mjs`

------------------------------------------------------------------------

## 20. 参考资料

### xacpx

- [PR \#393 — Agent capability
  state](https://github.com/gadzan/xacpx/pull/393)
- [capability-discovery.ts](https://github.com/gadzan/xacpx/blob/main/src/agents/capability-discovery.ts)
- [capability-probe.ts](https://github.com/gadzan/xacpx/blob/main/src/agents/capability-probe.ts)
- [session-model-catalog.ts](https://github.com/gadzan/xacpx/blob/main/src/transport/session-model-catalog.ts)
- [agent-capability.ts](https://github.com/gadzan/xacpx/blob/main/packages/relay-protocol/src/agent-capability.ts)
- [relay-web-module.md](https://github.com/gadzan/xacpx/blob/main/docs/relay-web-module.md)
- [acpx 0.16.0 → 0.19.5 upgrade
  plan](https://github.com/gadzan/xacpx/blob/main/docs/superpowers/plans/2026-10-13-acpx-0.16.0-to-0.19.5-upgrade-plan.md)

### acpx 0.19.5

- [inspectAgentModels
  implementation](https://github.com/openclaw/acpx/blob/v0.19.5/src/runtime/public/probe.ts)
- [Runtime public
  contract](https://github.com/openclaw/acpx/blob/v0.19.5/src/runtime/public/contract.ts)
- [Runtime public
  exports](https://github.com/openclaw/acpx/blob/v0.19.5/src/runtime.ts)

### T3 Code（参考思路，不照搬 Provider 特有实现）

- [ProviderRegistry.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/ProviderRegistry.ts)
- [providerStatusCache.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/providerStatusCache.ts)
- [ACP Registry
  driver](https://github.com/pingdotgg/t3code/blob/main/packages/provider-acp-registry/src/server/driver.ts)
- [CodexProvider.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/CodexProvider.ts)

------------------------------------------------------------------------

## 最终建议

实施顺序不要从 UI 开始，也不要先做一套复杂的通用模型 Manifest。

**先完成 Phase 0 和 Phase 1：证明探测命令与正常 Agent launch
一致，并修复 fingerprint / 空目录 / 协议解析问题。然后再替换冷探测
API。**

这三个基础问题解决后，TTL、stale refresh 和 UI
状态才有可靠的事实源。否则只是把不准确的数据更快地缓存和展示出来。
