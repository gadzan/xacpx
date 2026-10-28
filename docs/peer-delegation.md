# Peer Delegation (prototype)

> 状态：原型分支，仅供评审。**不合并、不上线、不改现有调度。**
> 定位：会话间点对点委派路径，与幕僚长自顶向下分发**并行存在**，不是替代。

## 这是什么

会话 A 不经过 coordinator，直接把任务委派给会话 B；A 能观察 B 的任务状态直到落定；A、B
互发消息走已有的 `agent_send`；B 完成时，带署名的结果按 `requestId` 回填到 A 的委派记录；
A 验证后才算交付；B 也能反向委派给 A。

## 怎么做（按纠正后的模型）

- **coordinator 是会话身份，不是职位**。本路径不设 coordinator，不碰 orchestration
  的 delegate 审批语义，不动 group 会话，不动幕僚长分发链路。
- **审批是一任务一审，没有 plan 级确认门**。`peer_delegate` 只创建
  `needs_confirmation` 记录，**未批准的委派永远不执行**；`peer_approve` 是唯一的操作者
  授权步骤。
- **不打断对端**。执行走 transport `prompt`，由 acpx 队列排在对端当前 turn 之后；
  本服务从不调用 cancel / interrupt。
- **完成不等于正确**。`peer_watch` 返回终态结果后，发起方必须用 `peer_confirm`
  验证，记录才变为 `delivered`；只有发起方能确认自己的委派。
- **超时不是重发理由**。`peer_watch` 的超时（默认 60s，上限 20min）只结束监听，
  任务继续跑；同一 `requestId` 重发返回同一记录，换新 UUID 重发视为新请求、
  须重新授权（被禁止的操作模式）。
- **绝不借用对方身份**。执行 prompt 带发起方署名与 `requestId`，对端可见是谁委派的；
  回执按 `requestId` 对应，错配（未知 id、非 running 记录）一律拒绝。
- **消息不另起一套**。会话间消息直接复用 `agent_send`（one-way + delivery ACK +
  `replyTo` 关联）及其已实现的信封、去重、FIFO；本模块不含任何消息通道。

## MCP 工具（`src/mcp/xacpx-mcp-tools.ts`）

| 工具 | 作用 |
|---|---|
| `peer_delegate` | 创建委派，返回 `requestId` 与 `needs_confirmation`；不执行 |
| `peer_approve` | 操作者授权后开始执行，后台运行，立即返回 `running` |
| `peer_watch` | 观察委派直到终态（completed / failed / delivered）或监听超时 |
| `peer_confirm` | 发起方验证结果，标记 `delivered` |

四个工具经 `XacpxMcpTransport` 的可选 peer 方法绑定（与 `groupSend` 同款模式）；
未绑定时工具直接报错，不会假装能跑。**取消的 `peer_message` 不存在**：消息往来
就是 `agent_send`。

## 实现落点（`src/peer/`，全部新增代码放一处，便于评审与回滚）

- `peer-types.ts`：`PeerRequest`（requestId、发起方/目标会话身份、prompt、状态、
  结果、时间戳）与监听结果类型。
- `peer-store.ts`：请求记录持久化。文件与 `state.json` 同目录
  （`peer-requests.json`），daemon 重启后仍可查；回执对应不依赖内存。
  写操作经 promise 链串行化，临时文件 + 改名落盘。
- `peer-service.ts`：解析目标会话（显示别名 → 内部别名 → transport 会话名，
  transport 名一律从 state 里取，不手拼）→ 批准后经 transport prompt 投递 →
  结果按 requestId 回填 → 状态观察 → 发起方确认。

## 本 PR 明确不含（后续集成点，见验证记录）

- Daemon RPC 绑定：`peer.*` 尚未接进 orchestration IPC，MCP 工具目前经可选
  transport 方法绑定；接进 daemon RPC 是下一步，不在本 PR 里偷偷做。
- `peer_cancel`：尚无取消工具；未批准的请求永不执行（fail-closed），
  已批准的请求只能跑到终态。
- Bridge lane 下的存活与收敛、真 adapter（codex/claude）下 agent 主动发起
  peer 委派、真 adapter 的 load 完整度与冷启动耗时：均未验证，与本 PR 无关，
  不混写。

## 验证

- 单元：`tests/unit/peer/peer-service.test.ts`（requestId 去重、回执错配拒绝、
  重启后记录可查、监听超时语义、确认权限）与 `tests/unit/mcp/peer-tools.test.ts`
  （工具注册、未批准不执行、未绑定报错）。
- 集成：`tests/integration/peer-delegation.test.ts`——真实 buildApp + mock agent +
  隔离 HOME：双会话完成一次互相委派、一次状态观察（先超时、后终态）、
  一次 `agent_send` 消息往来、两次发起方确认、重启后记录可查。
- 演示：`scripts/peer-demo.ts`，隔离 HOME 下双会话走完委派→观察→消息→完成→
  反向委派全程；日志见验证记录（仓库外）。

## 回滚

关 PR + 删分支即回滚。PR 不合并即不产生任何线上影响；新增文件只在
`src/peer/`、`src/mcp/` 追加、`tests/`、`docs/`，不碰现有分发语义、版本号与
release 相关文件。
