# xacpx 群组使用指南

这份指南讲两件事：**什么时候该把单个子任务委派出去、什么时候该开一个任务组**，以及如何停止或清理组工作。下面的描述与 `/help group` / `/help orchestration` 当前的命令行为保持一致。

> **并没有** `/group delete`，也**没有** `/groups clean`。要停止一个组里还没做完的工作，用 `/group cancel <groupId>`；要清理已完成的任务记录，用 `/tasks clean`。

## 委派还是开组？

当前会话就是主控会话。被委派出去的子任务会以一个独立的 worker 会话运行。

| | 委派单个子任务 | 开一个任务组 |
|---|---|---|
| 命令 | `/dg <agent> <task>`（或 `/delegate …`） | `/group new <title>`，然后每一块用一次 `/group add <groupId> <agent> <task>` |
| 形态 | 一个任务，一个 worker | 多个任务，多个 worker |
| 适用场景 | 工作是一块定义清晰的内容；你只要一个结果回来 | 工作能拆成多块互不依赖、可以并行执行的内容；你想一起盯着它们的进度 |
| 审批 | 被委派的任务可能停在 `needs_confirmation`——看 `/tasks`，然后 `/task approve <id>` 或 `/task reject <id>` | 组内同样是逐任务审批 |

经验法则：

- **一件事 → 委派。** `/dg claude Review the 3 highest-risk points of the current plan`
- **几件互不相关的事 → 开组。** `/group new review-batch`，然后每一块用一次 `/group add`。
- **互相依赖的事 → 不要并行。** 如果 B 需要 A 的结果，就按顺序委派，不要把两个都塞进同一个组；组是用来放可以同时跑的工作的。
- **你可以把已委派的任务加进已有的组：** `/delegate <agent> --group <groupId> <task>`。
- **角色模板可以塑造这两条路径：** `/delegate <agent> --role <role> <task>` 或 `/group add <groupId> <agent> --role <role> <task>`。

### 和 dashboard 里的 Group Conversation 不是同一个“组”

relay dashboard 还有第二种组：Group Conversation——一个持久的多 bot 会话，成员以轮次（圆桌，1–3 轮）讨论，或在自动路由下工作。它和上面的聊天 `/group` 任务组是另一套系统：它住在 dashboard / Control API 里，不在 `/group new` 里，而且成员之间互相说话（`group_send`），而不是向一个主控会话汇报。如果你想让 bot 们互相讨论协作，用 Group Conversation；如果你想让多个子任务跑在你当前会话之下，用聊天任务组。会话模型见 [conversation-runtime.md](../conversation-runtime.md)。

## 先记住两个动作

| 命令 | 作用 | 是否影响正在运行的任务？ |
|---|---|---|
| `/group cancel <groupId>` | 停止一个任务组里正在跑的工作 | 是 |
| `/tasks clean` | 清理当前主控会话下已完成的任务和失效的 worker 绑定 | 否 |

一句话：

- **cancel**：先把工作停下来。
- **clean**：清理那些已经完成、可以安全丢弃的任务记录。

`/tasks clean` 是**按任务清理，而不是按组清理**——它清扫的是当前主控会话下所有已完成的任务，而不是删除某个具体的组壳。没有任何命令可以删除单个组。

## `/group cancel <groupId>`

这个命令的目标不是「删除任务组」，而是**停止该组里还在运行的工作**。

它会：

- 对组里所有未完成的任务发起取消
- 跳过已经完成的任务
- 保留任务组本身，方便你之后继续查看、收尾或对结果做判断

适合这些场景：

- 你发现这个组方向跑偏了，想先把它停下来
- 你想保留上下文，但不想再继续执行
- 你还不确定工作是否已经做完，先让它收尾

## `/tasks clean`

这个命令是对当前主控会话下**已完成任务记录的清理**。它会清理：

1. **已完成的任务**（completed、failed、cancelled）
2. 不再使用的 **失效 worker 绑定**

它不会动还在执行的任务，也不会替你取消正在运行的任务。它的范围限定在当前主控会话的主线上，不会触及其他主控会话的任务。

适合这些场景：

- 你想一次性清掉当前主线下那些已经完成的任务记录
- 你只关心当前主控会话的主线，不想跨主线动到别人的任务

如果某个组还有未完成的任务，先用 `/group cancel <groupId>` 取消，再用 `/tasks clean` 清理已完成的记录。

## 什么时候用哪个

- **你只是想停止还在运行的工作**：用 `/group cancel <groupId>`
- **你想清理当前主线下已经完成的任务记录**：用 `/tasks clean`

动手之前想先看清楚：用 `/groups` 查看各个组及其状态，用 `/group <id>` 看单个组的详情，用 `/tasks`（必要时配合 `/task <id>`）查看单个任务。

## 最小决策流程

1. 这个组还在跑你已经不想要的工作吗？
   - 是：先 `/group cancel <groupId>`，然后等正在运行的任务停下来
   - 否：继续下一步
2. 你想清理已完成的任务记录吗？
   - 是：运行 `/tasks clean`，清掉当前主控会话下已完成的任务和失效绑定
   - 否：无需其它操作；任务组会被保留以供查看

## 示例

```text
/dg claude Review the 3 highest-risk points of the current plan   # 一件事：委派
/group new review-batch                                            # 几件互不相关的事：开组
/group add review-batch claude Review the interface design
/group add review-batch codex --role reviewer Review test coverage
/group cancel review-batch   # 停止 review-batch 里未完成的工作（组会被保留）
/tasks clean                 # 清理当前主控会话下已完成的任务和失效绑定
```

当你查看 `/group` 详情时，如果发现：

- 组里还有正在运行的任务：先用 `/group cancel <groupId>` 取消
- 组里已经没有存活任务：用 `/tasks clean` 清理已完成的记录
