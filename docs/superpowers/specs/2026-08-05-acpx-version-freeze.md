# acpx 与 adapter 升级目标版本冻结

> 冻结日期：2026-08-05。查询源：`https://registry.npmjs.org/`。
> 对应计划：`docs/superpowers/plans/2026-08-05-acpx-latest-upgrade.md` Phase 0 / Task 0。

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

## acpx 0.13.0 能力核查（2026-08-05 真实运行确认）

对已发布 tarball（`dist/*.js`）与 `../acpx` 源码核查，并用真实 CLI + mock ACP agent 跑通：

1. **结构化 CLI argv flag：不存在，且不依赖。** 已发布 0.13.0 只有全局 `--agent <command>` raw escape hatch（Windows 拒绝）。`agentArgv` 只来自 acpx 配置文件 `agents.<name>.argv` 与内建 registry——这正是 xacpx namespaced overlay 架构的基础（见计划 Phase 1 Task 2）。
2. **config `{argv}` + positional alias：已确认可用。** 配置 `agents.<alias>.argv` 后，`acpx <alias> sessions new` 真实创建 record：`agent_command` = `renderArgvIdentity(argv)`、`agent_argv` = 原样数组。
3. **session record：** schema `acpx.session.v1`，序列化含 `agent_argv` 字段；旧 record（raw `--agent` 产生）只有 `agent_command`、无 `agent_argv`。真实 fixture 见 `tests/fixtures/acpx-compat/`。
4. **Pool / ZeroClaw：已包含。** 0.13.0 内建 registry 已含二者。
5. **index tmp 命名：** 当前为 `index.json.<pid>.<timestamp>.<unique-id>.tmp`（UUID 可含 `-`）；legacy 为 `index.json.<pid>.<timestamp>.tmp`。
6. **`__queue-owner`：** 私有兼容 seam，由 Task 9 compat smoke 覆盖。

## 结论

- `../acpx` 全程只读：不提交上游改动、不 vendor patch、不依赖未发布功能（计划 Global constraints）。
- 不再需要上游 patch；`ACPX_TARGET` 保持 `0.13.0`。
- `CODEX_TARGET` / `CLAUDE_TARGET` 不变（`1.1.9` / `0.64.2`，initialize 探针均通过）。
- 本文档冻结值在实施期间不变。
