# 定时任务

## 概述

`/later`（别名 `/lt`）用于安排一次性定时任务：在指定的未来时间，xacpx 会向某个 agent 会话发送消息，并将回复路由回发起任务的聊天。任务仅触发一次，不会重复执行。

**核心思路：** 安排一条消息在未来某个时间发送，会话创建、消息投递和回复路由均由 xacpx 自动处理。

**主要限制：**

- 创建任务时必须有活跃会话。任务会对当前会话的 agent 和工作区进行快照记录。
- 计划时间必须至少在 10 秒后，且不超过 7 天。
- 只能安排普通的提示消息。以 `/` 开头的消息会被拒绝——请使用普通句子（例如，用 "explain what the /status command does" 替代 `/lt in 1h /status`）。
- 发起任务的聊天频道必须支持定时消息投递。若不支持，任务创建会被立即拒绝，不会留下任何残余任务。
- 支持的频道：微信（内置）、飞书（插件）、元宝（插件）、Discord（插件）。第三方频道插件需实现 `sendScheduledMessage` 才能启用此功能。

完整命令参考请见[命令参考](/zh/reference/commands)。

## 创建定时任务

```text
/later <时间> <消息>
/lt <时间> <消息>
```

默认情况下，xacpx 会为任务创建一个**临时会话**：该会话继承创建时当前会话的 agent 和工作区，拥有独立的对话历史，执行完成后自动销毁。这样可以避免任务结果污染正在进行的对话。

使用 `--bind` 可以将消息发送到当前会话：

```text
/lt in 2h check CI              # 临时会话（默认）
/lt --bind in 2h check CI       # 发送到创建时的当前会话
/lt --temp tomorrow 09:00 review PR   # 显式指定临时会话（默认值已更改时使用）
```

`--bind` 和 `--temp` 互斥，不能同时使用。

默认模式可通过配置键 `later.defaultMode` 修改（`"temp"` | `"bind"`，默认为 `"temp"`）。参见[配置说明](/zh/reference/configuration)。

**确认输出（临时会话）：**

```text
已创建定时任务 #k8f2
执行时间：2026-05-23 周六 21:30
临时会话（backend · codex）
内容：check CI
```

**确认输出（绑定会话）：**

```text
已创建定时任务 #k8f2
执行时间：2026-05-23 周六 21:30
会话：backend-codex
内容：check CI
```

**时间始终按本地系统时区解析。** 确认回复会显示完整的日期和星期，以消除歧义。

### 时间语法

**相对时间——英文（两个词：`in` 加 `<数量><单位>`，例如 `in 10m`）：**

```text
/lt in 10m check CI
/lt in 2h check CI
/lt in 1d summarize progress
```

**相对时间——中文（紧凑格式，中间无空格）：**

```text
/lt 10分钟后 check CI
/lt 2小时后 check CI
/lt 1天后 summarize progress
```

支持的单位：

| 类型 | 可用形式 |
|---|---|
| 分钟 | `m`, `min`, `minute`, `minutes`, `分钟` |
| 小时 | `h`, `hour`, `hours`, `小时` |
| 天 | `d`, `day`, `days`, `天` |

不支持小数（`1.5h`）和中文数字（`一小时后`、`半小时后`）。中文相对时间格式中间不能有空格（`10 分钟后` 带空格无法识别）。

**绝对时间——今天 / 明天 / 后天：**

```text
/lt at 21:30 continue work          # 等同于 "today 21:30"
/lt today 21:30 continue work
/lt tomorrow 09:00 review PR
/lt 后天 14:30 continue debug
```

时间格式：`H:MM` 或 `HH:MM`，24 小时制，分钟必须两位（`09:00` 合法，`9:0` 不合法）。

若 `today` 或 `at` 指定的时间今天已经过去，命令会被拒绝，不会自动顺延到明天：

```text
21:30 today has already passed. Please specify a future time, or use "tomorrow".
```

**绝对时间——星期几：**

```text
/lt 周五 09:00 review PR
/lt fri 09:00 review PR
/lt friday 09:00 review PR
```

解析为 7 天内最近一次出现的该星期几。若今天就是目标星期且时间未过，则安排在今天；若时间已过，则安排在下一周的同一天（仍在 7 天限制内）。

支持全部 7 天，中文（`周日/周天/星期日` … `周六/星期六`）和英文（`sun/sunday` … `sat/saturday`）均可。

**不支持的表达式**（v1 有意排除以下模糊的自然语言形式，以避免误解析）：

```text
明早  今晚  下午三点  周五晚上  下周一  月底  饭后  睡前
```

请改用上述明确的相对/绝对/星期格式。

当时间表达式无法识别时，xacpx 会显示格式提示：

```text
无法识别时间格式。

支持的格式：
- /lt in 2h 消息（2小时后）
- /lt 30分钟后 消息
- /lt tomorrow 09:00 消息
- /lt 周五 09:00 消息
```

## 查看定时任务列表

```text
/lt list
```

显示所有全局待执行任务，不按当前聊天或会话过滤：

```text
待执行定时任务：

#k8f2  2026-05-23 周六 21:30  临时会话（backend · codex）
check CI status

#p91a  2026-05-24 周日 09:00  会话：frontend-claude
continue working through yesterday's issues
```

没有待执行任务时显示：`当前没有待执行定时任务。`

当聊天频道不可用时，也可以通过终端管理任务：

```bash
xacpx later list
xacpx later cancel k8f2
xacpx lt list
xacpx lt cancel #k8f2
```

CLI 仅支持 `list` 和 `cancel`，无法创建任务。

## 查看任务详情

任务详情包含在列表输出和创建确认回复中。v1 没有单独的"查看详情"子命令。

## 取消定时任务

```text
/lt cancel k8f2
/lt cancel #k8f2     # # 前缀可选，不区分大小写
```

能执行 `/lt list`（查看所有全局待执行任务）的用户均可取消任意待执行任务。在群聊中，只有群主才能使用 `/lt cancel`。

## 临时会话

任务以临时会话模式运行时（默认）：

1. xacpx 向发起聊天发送可见通知：`Executing scheduled task #id ...`，说明使用的是临时会话还是绑定会话。
2. xacpx 创建一个全新的会话，继承任务创建时快照的 agent 和工作区，并拥有全新的对话历史。
3. 消息以普通提示的形式发送到该临时会话。
4. agent 的回复通过常规频道投递机制路由回发起聊天。
5. 临时会话在执行完成后销毁。

**临时会话不可恢复。** 如果你回复结果消息，回复会进入当前活跃会话，而不会恢复临时会话。

任务以绑定会话模式（`--bind`）运行时，消息会投递到创建任务时活跃的会话。若执行时该会话已不存在，任务会被记录为 `failed`。

**任务状态机：**

| 状态 | 含义 |
|---|---|
| `pending` | 等待执行（`/lt list` 只显示此状态） |
| `triggering` | 已认领执行，正在投递中 |
| `executed` | 已成功投递 |
| `cancelled` | 通过 `/lt cancel` 取消 |
| `missed` | 守护进程启动时发现任务已过期——不会重新发送 |
| `failed` | 投递失败（绑定会话不存在、agent/工作区已注销、transport 不可用） |

**错过的任务不会重播。** 若守护进程在计划时间到来时未运行，任务会在下次启动时被标记为 `missed`，以防止过期任务意外触发。

**崩溃安全性：** 在 `triggering` 阶段中断的任务，重启后会被标记为 `failed`，而不是重新触发。

## 频道能力要求

发起任务的频道必须支持出站定时消息投递（`sendScheduledMessage`）。若不支持，任务创建会在最开始被拒绝：

```text
This channel does not support scheduled tasks and the task was not created.

Reason: this channel has not implemented scheduled message delivery, so there is
no way to send the result back to this chat when the task fires.
Please switch to a supported channel before using /lt.
```

**微信投递说明：** 微信出站投递依赖会话上下文窗口。若任务安排时间接近 7 天上限，且期间没有新消息发送，投递可能失败。若通知发送失败但仍有可用的投递上下文，agent 仍会执行，最终结果通过备用槽位投递。只有在完全没有可用投递路径时，xacpx 才会中止 agent 执行。

对于长周期任务，请确保频道上有近期的聊天活动，或将计划时间控制在一两天以内。

## 示例

**两小时后执行 CI 检查：**

```text
/lt in 2h check whether CI has recovered and summarize results
```

**安排早晨评审：**

```text
/lt tomorrow 09:00 review open pull requests and flag anything blocking
```

**安排在周五执行：**

```text
/lt friday 17:00 write a progress summary for the week
```

**绑定到当前会话而非使用临时会话：**

```text
/lt --bind in 30m run the full test suite and report results
```

**取消任务：**

```text
/lt list
/lt cancel k8f2
```

**自然语言方式（通过 agent）：** 除 `/lt` 命令外，agent 可通过内置 MCP 工具理解自然语言意图来创建、列出和取消定时任务（例如"明天早上九点提醒我……"）。这些工具仅对管理当前会话的 agent 可用，不通过外部 `xacpx mcp-stdio` 接口暴露。所有限制（时间范围、频道能力检查、群主权限）同样适用。
