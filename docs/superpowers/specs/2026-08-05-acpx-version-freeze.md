# acpx 与 adapter 升级目标版本冻结

> 冻结日期：2026-08-05。查询源：`https://registry.npmjs.org/`。
> 对应计划：`docs/superpowers/plans/2026-08-05-acpx-latest-upgrade.md` Phase 0 / Task 0.1。

## 冻结版本

| 常量 | 包 | 版本 | 发布日期 |
|---|---|---|---|
| `ACPX_TARGET` | `acpx` | `0.13.0` | 2026-07-27 |
| `CODEX_TARGET` | `@agentclientprotocol/codex-acp` | `1.1.9` | 2026-08-02 |
| `CLAUDE_TARGET` | `@agentclientprotocol/claude-agent-acp` | `0.64.2` | 2026-08-02 |

## 发布元数据

- acpx `engines.node`: `>=22.13.0`
- acpx tarball: `https://registry.npmjs.org/acpx/-/acpx-0.13.0.tgz`
- acpx integrity: `sha512-EdGgMx5osY4bNpVN+7dTTT67ZXsFqx/itl4QjGYTKH/Nzm3fqGmWL3E6FjRkVrlWRpiFnRNi+J1lxUJPie4lmg==`
- acpx dependencies: `tsx ^4.23.1`, `zod ^4.4.3`, `commander ^15.0.0`, `skillflag ^0.2.1`, `@agentclientprotocol/sdk ^1.3.0`

## Adapter initialize 探针结果

使用现有 `verifyAdapterVersion()`（ACP initialize，protocolVersion 必须为 1）：

- `codex@1.1.9`: **OK**
- `claude@0.64.2`: **OK**

## acpx 0.13.0 能力核查（决定 Task 0.2 是否必需）

对已发布 tarball（`dist/*.js`）与 `../acpx` 源码核查：

1. **结构化 CLI argv flag：不存在。** 已发布 0.13.0 只有全局 `--agent <command>` raw escape hatch（且 Windows 拒绝），没有 `--agent-argv`。`agentArgv` 只来自 acpx 配置文件 `agents.<name>.argv` 与内建 registry。
2. **session record 持久化：存在。** record 序列化已含 `agent_argv` 字段（`serialize.ts`）。
3. **Pool / ZeroClaw：已包含。** 0.13.0 内建 registry 已含二者。
4. **`sessions ensure` 回填 argv：无对外 CLI 入口可传 argv**，因此无法从 CLI 触发回填。

## 结论

- Task 0.2（上游 seam）**必需**：需在 `../acpx` 新增全局 `--agent-argv <json-array>`（含 ensure 回填），发布 patch release。
- patch 发布后，`ACPX_TARGET` 更新为该 release（计划允许不强行停在 0.13.0）；`CODEX_TARGET` / `CLAUDE_TARGET` 不变。
- 本文档在 patch 发布后追加最终 `ACPX_TARGET` 记录。
