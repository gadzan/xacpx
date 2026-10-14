# Relay Web 自定义动态 Bot 头像方案

日期：2026-10-14。
状态：方案已确认并实施；实现与验证记录见第 8、10 节。
范围：Bot 头像编辑、持久化、Direct 和 Group 展示，以及真实任务状态动画。

本文记录已确认的设计决策与本分支实施结果。头像属于 Bot 人设；发布时按既有 Relay stack 流程配套升级，不改变普通 Session 的 Agent 品牌用途。

## 1. 目标与边界

用户在 Bot 编辑弹层中选择形状、颜色和默认表情，预览动画，然后保存。保存后的头像在侧栏、私聊和群聊中保持一致。任务执行时，头像根据当前 Run 或 MemberTurn 的真实状态变化。

本方案中的头像属于 Bot 人设，不属于 `config.agents` 中的 Agent 启动定义。同一个 Codex 或 Claude Agent 可以服务多个外观不同的 Bot。普通 Session 和 Agent 品牌标识继续使用 `AgentIcon.vue`。

完整交付包含以下能力。

- 可视化选择动态角色外观，提供预设和分别调整的入口。
- 即时预览外观、动画和实际展示尺寸。
- 保存到 daemon 管理的 Bot profile，刷新和重启后不丢失。
- 所有 Bot 身份展示位置使用同一份配置。
- 根据当前对话任务显示工作、输出、等待和终态。
- 保留旧头像值、已有 Bot 默认外观和历史任务记录。
- 支持移动端、键盘操作、浅色主题、深色主题和减少动态效果模式。

以下能力不在本次范围内。

- 图片上传、外部头像资源托管和新增图片下载能力。
- GIF、PNG、SVG 和 MP4 导出。
- 用户编排动画时间轴或修改动画曲线。
- 修改普通 Session 的头像配置。
- 新增全局 Bot 忙碌状态服务、动画 RPC、轮询或遥测。
- 修改 Agent 启动参数、模型提示词、权限或任务调度。

## 2. 调研依据

### 2.1 当前实现

调研时，`BotProfile.avatar` 和 Relay DTO 中的 `avatar` 都是可选字符串。`BotService` 将非空字符串限制为 512 个字符。更新时，`avatar: null` 清除配置。

`BotDialog.vue` 用文本框编辑头像，占位提示是 URL 或图标标识。侧栏、Direct 顶栏、消息行和 Group 入口仍按 Agent driver 渲染品牌图标，没有读取头像配置作为展示内容。

本地隔离 dashboard 的实际操作验证了这一点。创建 Bot 时填入 `🤖`，保存后重新打开编辑框仍能读到该值，但侧栏、Direct 顶栏和会话空态仍显示品牌图标。

头像还存在于 Bot profile snapshot 和已移除 Bot 的记录中。因此，结构化配置不能只修改 Web 表单和 DTO。

相关实现位置见 [第 8 节](#8-实现归属与调用点)。

### 2.2 bloub 的可复用部分

参考项目是 [jeremy-prt/bloub](https://github.com/jeremy-prt/bloub)，在线演示是 [bloub.vercel.app](https://bloub.vercel.app/)。调研验证了形状、颜色、表情切换，以及待机和时间轴播放时 SVG 画面的变化。

| 能力 | 上游实现 | 本方案选择 |
| --- | --- | --- |
| 形状 | 8 种参数化形状 | 保留目录，按 xacpx 风格调整角色视觉 |
| 颜色 | 12 种预设颜色 | 保留色板，不增加任意 SVG 或 CSS 输入 |
| 默认表情 | 16 种眼睛表情 | 提供常用入口和完整目录 |
| 动画状态 | 14 种展示状态 | 选择并调整适合真实任务的动作 |
| 渲染 | SVG 和 TypeScript 动画核心 | 复用必要几何、眼睛和过渡逻辑 |
| 播放控制 | 时间轴、循环、导出 | 不移植，以任务状态控制头像 |

上游的动画核心不依赖 Vue 或内部时钟。`sample(t)` 根据时间采样画面，支持静态缩略图与可重现的动画检查。Vue 组件负责时钟、指针和播放器交互。

上游只在部分动画状态保留用户选择的形状。其他状态会把身体变成圆点、感叹号或其他轮廓。本方案要求任务动画保留角色身份，不原样使用这些会替换身体的动作。

来源如下。

- [项目说明](https://github.com/jeremy-prt/bloub/blob/main/README.md)。
- [动画核心架构](https://github.com/jeremy-prt/bloub/blob/main/docs/architecture.md)。
- [自定义界面](https://github.com/jeremy-prt/bloub/blob/main/src/components/Customizer.vue)。
- [Vue 渲染组件](https://github.com/jeremy-prt/bloub/blob/main/src/components/BloubBot.vue)。
- [形状和色板目录](https://github.com/jeremy-prt/bloub/blob/main/src/bot/skins.ts)。
- [表情目录](https://github.com/jeremy-prt/bloub/blob/main/src/bot/expressions.ts)。

## 3. 主要设计决策

| 选择 | 理由 | 不采用的方案 |
| --- | --- | --- |
| 参数化 SVG 角色 | 外观可编辑，小尺寸清晰，能切换任务状态 | 以 GIF 或动态图片作为核心头像 |
| 同一 Bot 弹层内编辑 | 保留保存和取消的统一语义 | 在编辑框上再叠加头像编辑弹窗 |
| 结构化头像配置 | 在边界校验字段，支持明确迁移和快照 | 在字符串中编码 `bloub:{...}` |
| 外观与任务状态分开 | 任务变化不写 profile，不把预览态保存成运行态 | 把 `thinking` 等状态写入头像配置 |
| 一个 `BotAvatar` 组件 | 各处共享外观、尺寸和静态渲染规则 | 每个页面独立解析头像或接收全局事件 |
| 当前任务范围内的动画 | 避免跨 Bot、跨 Topic 和跨 Run 串显 | 根据任意一条 Agent 活动推断 Bot 全局忙碌 |

本方案应用 Experience First 原则。先完成编辑、保存和统一展示，不搬入完整动画编辑器。

本方案应用 Model the Domain 原则。外观使用有类型的配置，动画使用独立的展示状态，避免散落的字符串解析和布尔条件。

## 4. 编辑弹层与交互

### 4.1 布局

`BotDialog.vue` 分为 **基本设置** 和 **头像外观** 两个标签页。名称、角色、Agent、workspace、instructions、model、effort 和 enabled 仍在基本设置中。

下图是静态布局示意，不是已实现页面。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 840 470" fill="none">
  <g font-family="sans-serif" font-size="14" fill="var(--fg)">
    <rect x="12" y="12" width="816" height="446" rx="16" fill="none" stroke="var(--border)"/>
    <text x="36" y="47" font-size="18" font-weight="600">编辑 Bot</text>
    <text x="790" y="47" fill="var(--muted)">×</text>
    <path d="M12 65H828" stroke="var(--border)"/>
    <text x="36" y="96" fill="var(--muted)">基本设置</text>
    <text x="144" y="96" fill="var(--accent)" font-weight="600">头像外观</text>
    <path d="M140 109H204" stroke="var(--accent)" stroke-width="3"/>
    <path d="M12 114H828" stroke="var(--border)"/>
    <path d="M310 136V390" stroke="var(--border)"/>
    <text x="43" y="153" fill="var(--muted)">实时预览</text>
    <path d="M106 219C93 195 109 174 134 179C147 151 184 156 194 177C226 170 247 199 233 222C254 253 229 277 201 271C180 292 151 283 140 274C109 284 87 253 106 219Z" fill="var(--accent)"/>
    <rect x="145" y="209" width="13" height="33" rx="6.5" transform="rotate(-15 145 209)" fill="var(--surface)"/>
    <rect x="182" y="203" width="13" height="33" rx="6.5" transform="rotate(-15 182 203)" fill="var(--surface)"/>
    <text x="135" y="313" font-weight="600">代码助手</text>
    <text x="111" y="338" fill="var(--muted)">待机 · 自然眨眼</text>
    <text x="58" y="375" fill="var(--muted)">展示尺寸</text>
    <circle cx="175" cy="370" r="10" fill="var(--accent)"/>
    <circle cx="217" cy="370" r="14" fill="var(--accent)"/>
    <circle cx="265" cy="370" r="18" fill="var(--accent)"/>
    <text x="336" y="151" font-weight="600">形状</text>
    <g fill="var(--accent)">
      <circle cx="358" cy="187" r="13"/>
      <ellipse cx="415" cy="187" rx="15" ry="12" transform="rotate(-14 415 187)"/>
      <rect x="458" y="174" width="26" height="26" rx="8"/>
      <rect x="508" y="179" width="35" height="17" rx="8"/>
      <path d="M584 173L600 200H568Z"/>
      <path d="M632 173H645L653 187L645 201H632L624 187Z"/>
      <rect x="671" y="164" width="48" height="46" rx="9" fill="none" stroke="var(--accent)" stroke-width="2"/>
      <path d="M682 187C679 179 686 177 691 179C697 172 704 179 703 183C714 184 710 198 701 197C692 203 680 197 682 187Z"/>
      <path d="M754 173C750 183 741 188 742 194C743 207 765 207 766 194C766 187 760 182 754 173Z"/>
    </g>
    <text x="336" y="238" font-weight="600">颜色</text>
    <circle cx="351" cy="262" r="11" fill="var(--fg)"/>
    <circle cx="388" cy="262" r="11" fill="var(--c1)"/>
    <circle cx="425" cy="262" r="11" fill="var(--c2)"/>
    <circle cx="462" cy="262" r="11" fill="var(--c3)"/>
    <circle cx="499" cy="262" r="11" fill="var(--c4)"/>
    <circle cx="536" cy="262" r="11" fill="var(--c5)"/>
    <circle cx="573" cy="262" r="11" fill="var(--accent)"/>
    <circle cx="573" cy="262" r="15" fill="none" stroke="var(--accent)"/>
    <text x="606" y="267" fill="var(--muted)">更多颜色</text>
    <text x="336" y="306" font-weight="600">默认表情</text>
    <rect x="334" y="318" width="72" height="32" rx="8" fill="none" stroke="var(--accent)"/>
    <text x="354" y="339" fill="var(--accent)">好奇</text>
    <text x="431" y="339">专注</text>
    <text x="507" y="339">开心</text>
    <text x="583" y="339">困倦</text>
    <text x="671" y="339" fill="var(--muted)">查看全部</text>
    <text x="336" y="384">启用动画</text>
    <rect x="418" y="368" width="38" height="22" rx="11" fill="var(--accent)"/>
    <circle cx="444" cy="379" r="8" fill="var(--surface)"/>
    <text x="480" y="384" fill="var(--muted)">跟随 Bot 运行状态</text>
    <path d="M12 408H828" stroke="var(--border)"/>
    <text x="36" y="440" fill="var(--muted)">使用 Agent 默认图标</text>
    <rect x="656" y="421" width="66" height="28" rx="7" fill="none" stroke="var(--border)"/>
    <text x="675" y="440">取消</text>
    <rect x="736" y="421" width="66" height="28" rx="7" fill="var(--accent)"/>
    <text x="755" y="440" fill="var(--surface)">保存</text>
  </g>
</svg>
```

桌面端扩大头像标签页的可用宽度。移动端采用上下布局，预览在上，选项在下。沿用当前弹层的 Teleport、安全区留白、表单滚动和固定操作栏，不让内容撑出视口。

### 4.2 外观选择

- 提供搭配好的预设。选择预设一次性更新形状、颜色和默认表情。
- 提供全部形状、色板和表情。每个选项具有名称和可见选中态，不能只靠颜色区分。
- 常用表情优先展示，完整目录在当前标签页内展开，不另开模态弹窗。
- 形状和表情切换平滑过渡。选项缩略图始终静态，不能每个选项都启动动画循环。
- 大预览与实际展示使用相同底板和对比策略。浅色角色在浅色主题、深色角色在深色主题中仍可辨认。
- 预览区提供侧栏和消息头像尺寸检查，避免大图好看、小图无法识别。

新建 Bot 的 Web 表单默认选择动态角色。已有 Bot 不自动换脸。没有头像配置的已有 Bot 仍使用 Agent 默认图标。

**使用 Agent 默认图标** 只修改草稿。保存后才清除 profile 中的头像配置。

### 4.3 动画预览

提供待机、工作、输出、等待和完成的临时预览入口。预览只改变弹层内的大头像，不影响后台任务、其他展示位置或保存内容。

预览默认处于待机。切换标签页不丢失外观草稿。动画开关控制角色运动，不隐藏真实状态文字。

鼠标跟随仅用于大预览。触摸设备不保留手指离开后的追踪目标。使用键盘时，角色仍按正常待机规则展示。

### 4.4 保存、取消与并发更新

沿用当前 `BotDialog` 的字段 dirty 标记和详情回填规则。

- 用户首次修改预设或任意外观字段后，将头像字段标记为 dirty。
- 详情请求或更新事件到达时，只回填未修改的头像草稿。
- 用户修改后又选回原值，仍不能把该字段当作未触碰。
- 编辑提交仅包含用户修改的字段，不能顺带提交旧的 instructions、model 或 enabled。
- 用户点击保存后，只有服务端确认成功才展示成功反馈并更新权威配置。
- 保存结果未知时，沿用现有 Bot 更新错误处理并重新读取详情，不提前把乐观预览当作保存成功。
- 取消或关闭弹层丢弃未保存草稿。

结构化头像的缓存比较使用字段值，不用对象引用判断相等。改变任意外观字段后，已打开的页面必须读取新配置。

## 5. 头像数据模型

### 5.1 持久配置

继续使用 Bot profile 的 `avatar` 字段，但将运行时和新写入数据统一为结构化配置。以下类型是拟议契约，不是当前导出类型。

```typescript
type BotAvatarConfig =
	| {
		version: 1;
		kind: "character";
		shape: ShapeId;
		color: ColorId;
		expression: ExpressionId;
		motion: "auto" | "off";
	}
	| {
		version: 1;
		kind: "text";
		value: string;
	};
```

`ShapeId`、`ColorId` 和 `ExpressionId` 来自固定目录。目录 ID 是持久协议值，不使用翻译后的名称。采用上游目录时，保留其已有 ID，不能在存储中随语言切换改变 ID。

`avatar` 缺省表示使用 Agent 默认图标，不另存 `kind: "default"`。

`kind: "text"` 用于保留旧字符串头像和安全的静态文本展示。旧值在弹层中完整可见。小尺寸显示文本时允许截断，但不改变保存值。URL 形式的旧值仍按文本处理，不自动下载，也不执行 HTML 或 SVG。当前产品本来没有网络头像渲染，本次不暗中增加该能力。

主要编辑入口是动态角色和 Agent 默认图标。旧文本可以保留、替换为动态角色或清除，不再保留原来的 URL 或图标标识输入框。

### 5.2 写入与清除

- 创建时可省略 `avatar`，保持现有默认图标行为。Web 新建表单主动提交默认动态角色配置。
- 更新时不提交 `avatar` 表示不修改头像。
- 更新时提交 `avatar: null` 表示清除头像配置。
- 非空配置必须通过版本、类型和目录 ID 校验。
- 新文本写入保留现有 512 字符上限；历史原始字符串与已迁移文本对象读取保留完整值，即使超过该上限。角色配置按固定字段校验，不套用字符串长度检查。
- 未知版本、未知目录 ID 或非法 motion 值在写入边界报错，不静默保存成另一个头像。
- 预览状态、动画时钟、指针坐标、Run ID 和错误状态不进入配置。

头像修改沿用 Bot profile revision 机制，不新建独立头像版本计数。

### 5.3 历史迁移

迁移对象包括 `state.json` 的 Bot profile、已移除 Bot 记录、SQLite 中的 Run 和 MemberTurn profile snapshot，以及读取这些数据的 control DTO 映射。

读取历史数据时，非空字符串归一化为 `kind: "text"`，空值归一化为缺省头像。归一化后，下游只处理 `BotAvatarConfig`，不继续传播 `string | BotAvatarConfig`。

历史记录可以在读取时归一化，随原有写入流程写成新格式。无需为了头像批量改写历史 Run 或重建 SQLite 表，也不能把显示配置迁移伪装成一次新任务。

当前 `StateStore` 会丢弃头像类型不合法的整个 Bot 记录。SQLite 快照解码失败会产生 `member_turn_corrupt`。实施时必须同时修改这些读取边界，不能先写入对象、后补解码器。

头像变成对象后，profile snapshot 必须拥有独立的配置值。用户随后修改头像不能改变已接受 Run 的快照对象。

当前 UI 的身份头像使用最新 Bot profile。已移除 Bot 使用可用的保留资料和现有名称回退。任务 snapshot 保持接受任务时的配置，不为展示最新头像而修改历史快照。

### 5.4 协议 cutover

daemon、control DTO、relay-protocol、relay connector 和 relay-web 需要同步更新类型与校验。新的运行契约只提交结构化配置，不保留字符串 setter 或字符串编码方案。

磁盘历史字符串属于数据迁移输入，不是新增的长期线缆契约。旧 daemon 不支持结构化配置，不能与新头像编辑器混搭。发布按现有 Relay stack 流程配套升级，验证错误信息与版本不匹配行为，不让保存请求被旧端静默吞掉。

## 6. 任务状态与动画

### 6.1 状态来源

外观属于 Bot profile，活动状态属于当前任务。动画状态由父组件从已校验作用域的 store 状态派生，再传给 `BotAvatar`。

Direct 使用当前 Conversation、Topic 和 Run。Group 在这些身份之外，还需要 `botId` 和 `memberTurnId`。不能只按 Agent driver、Bot 名称或收到事件的先后顺序归属动画。

`liveTurn.status === "streaming"` 表示当前 turn 已有文本输出。现有 store 在 `turn-output` 时设置该值，`turn-thought` 和工具事件本身不设置 streaming。它不是精确的逐 token 活动计时器，因此界面使用 **输出中**，不声称正在进行语音或持续吐字。

Group 的 MemberTurn 没有 `waiting-human` 状态。不能把 Run 的等待态直接赋给所有成员。只有有精确归属的待处理交互，才能让对应 Bot 显示等待提示。没有成员归属的 Router 等待由现有 Run 提示承担。

实施中，真实 elicitation 最初只携带 Conversation / Topic，无法证明 Run 或 MemberTurn。现在通过已有、已授权的 `trustedConversationExecution` 将五个产品 ID 固定在精确 turn context，并交给只读频道请求与既有 Relay DTO；不扩展权限、隐私或调度规则，不推断最新 alias。

### 6.2 动作映射

| 展示状态 | 权威依据 | 角色动作 |
| --- | --- | --- |
| 待机 | 没有当前活动任务 | 自然眨眼和低幅视线变化 |
| 排队 | Run queued，或成员 queued、dispatched | 低频外圈脉冲 |
| 工作中 | 当前任务 running，live turn 为 working 或尚无文本输出 | 专注眼神和轻微形变 |
| 输出中 | 当前任务 running，live turn 为 streaming | 更活跃的眼睛和短周期律动 |
| 等待用户 | 当前任务明确等待，或有精确归属的待处理交互 | 提示角标，保留等待文案 |
| 完成 | 当前任务从非终态进入 completed | 短暂眨眼或微笑，随后恢复待机 |
| 失败 | 当前任务 failed | 静态警示表情或角标，不循环夸张动画 |
| 已取消 | 当前任务 cancelled | 恢复静态姿态，保留取消状态 |
| 结果未知 | 当前任务 indeterminate | 静态未知状态角标，不播放完成动作 |
| 实例离线 | 实例连接状态明确离线 | 停止工作循环，保留离线提示 |

任务动画始终保留用户选定的身体轮廓和颜色。工作态可以调整眼睛姿态，任务结束后回到用户选择的默认表情。

### 6.3 状态优先级与恢复

活动展示按以下顺序处理。

1. 已移除状态阻止显示仍可工作的 Bot。
2. 实例离线停止工作循环，不假装能够确认后台进度。
3. 当前任务已进入终态时，终态优先于残留 live turn 数据。
4. 精确归属的等待交互优先于 running 和 streaming。
5. 当前任务 running 时，根据 live turn 区分工作和输出。
6. 当前任务排队时显示排队。
7. 没有活动时显示待机。

`enabled: false` 是配置状态，不等于任务停止。禁用 Bot 的已运行任务仍显示真实活动，禁用以独立角标或现有文字表达。未运行的禁用 Bot 使用静态头像，不把禁用绘制成 cancelled。

首次加载、重连快照和历史数据读取不触发完成庆祝。只有当前已观察到的任务终态转换触发一次完成动作。切换 Bot 或 Topic 后不能回放前一个任务的动作。

Group 同一 Bot 可以有多个 MemberTurn 记录。实时任务行按各自 MemberTurn 展示，不聚合成一个推测状态。若某个位置缺少唯一当前活动的证据，就只显示身份头像。

侧栏本次只显示身份头像和现有启用状态，不新增跨 Conversation 的全局任务聚合。侧栏可见角色允许低幅待机动画，不宣称 Bot 全局空闲。

### 6.4 哪些位置会动

| 位置 | 渲染规则 |
| --- | --- |
| 编辑器大预览 | 播放待机或用户选定的预览状态 |
| 选项缩略图 | 固定采样时刻，始终静态 |
| 侧栏 Bot 行 | 身份头像，可见时低幅待机，不显示推测忙碌 |
| Direct 顶栏 | 当前 Topic 的任务状态 |
| Direct 实时消息行 | 当前 live turn 状态 |
| Group 实时成员任务行 | 该 MemberTurn 的任务状态 |
| 历史消息 | 静态身份头像，不播放历史任务动画 |
| 成员选择器与交接双头像 | 静态身份头像 |
| 会话空态 | 可见且启用时播放待机动作 |

## 7. 渲染、性能与无障碍

### 7.1 组件边界

新增 `BotAvatar.vue` 作为身份头像入口。组件接收已归一化的外观、Agent driver、展示状态、尺寸和静态模式，不读取全局 store，不请求 Bot 详情，也不自行订阅任务事件。

新增头像编辑组件，由 `BotDialog.vue` 管理草稿与提交。固定目录、几何、眼睛和过渡逻辑放在 relay-web 的头像模块。该模块不导入 Vue，不直接读取浏览器时间。

复用上游必要核心，不直接复制 `BloubBot.vue` 的播放器、时间轴游标、导出接口和全局指针监听。组件层只负责时钟、可见性、主题和 DOM 渲染。

`TranscriptRow.vue` 为 Bot 消费方提供具名头像 slot，默认仍渲染现有 `AgentIcon`。这样 Direct 和 Group 注入 `BotAvatar`，普通 Session 不需要提供 Bot profile。保留原有头像外层、`data-avatar-key`、sticky 布局和 `hideLeadingAvatar` 行为。

### 7.2 动画资源

- 静态模式不启动 requestAnimationFrame，不注册指针监听器。
- 动态模式仅为可见头像采样。IntersectionObserver 控制离屏暂停，页面可见性控制隐藏页面暂停。
- 可见动态头像共享调度时钟。只有存在订阅者时运行，最后一个订阅者释放后停止。
- 头像订阅自身画面更新，不让全 transcript 在每一帧重新渲染。
- 关闭弹层、切换 Topic 和卸载组件后释放监听与订阅。
- 隐藏后恢复不追赶已错过的动画，也不补播历史完成动作。
- 固定目录和校正几何在初始化时计算，不能在每帧求解眼睛适配或重建目录。

动画保留上游的平滑过渡机制，连续切换时从当前混合画面过渡，不能先跳回旧姿态再开始下一次动作。

主题底板颜色必须来自实际展示容器。不能沿用上游固定浅色 `paper`，否则眼睛和遮罩在深色主题中会露出错误底色。

### 7.3 无障碍与安全

- `motion: "off"` 或 `prefers-reduced-motion` 生效时，停止眨眼、形变、光环循环、鼠标跟随和庆祝动作。状态角标与文字仍显示。
- 形状和表情选项支持键盘操作，颜色选项提供名称，选中态使用 `aria-pressed` 或等价选择语义。
- 标签页、焦点约束和 Escape 关闭沿用现有模态无障碍机制。
- 状态文字沿用现有 HUD、MemberTurn chip 和终态提示。不能只靠颜色或动作表达失败、等待和离线。
- 交接双头像继续是装饰内容，语义由交接按钮承担，避免读屏重复朗读。
- 动态帧不逐帧写入 aria-live。
- 用户配置只引用固定目录或按纯文本渲染。不能把用户输入传给 `v-html`，不能执行用户提供的 SVG、HTML、CSS 或脚本。

## 8. 实现归属与调用点

以下是已发现的修改边界。实施时仍需查询导出类型引用，覆盖未列出的调用方。

| 归属 | 当前文件 | 需要处理的内容 |
| --- | --- | --- |
| Bot 领域 | [bot-types.ts](../../../src/bots/bot-types.ts) | presentation、profile、snapshot 的头像类型与快照值隔离 |
| Bot 写入 | [bot-service.ts](../../../src/bots/bot-service.ts) | create、update、校验与清除语义 |
| 已移除 Bot | [bot-removal.ts](../../../src/bots/bot-removal.ts) | 保留资料解析、旧值归一化和结构化保存 |
| State 读取 | [state-store.ts](../../../src/state/state-store.ts) | Bot profile 的历史字符串归一化 |
| 历史快照 | [sqlite-conversation-store.ts](../../../src/conversations/sqlite-conversation-store.ts) | Run 和 MemberTurn snapshot 解码 |
| Control | [conversation-control-dtos.ts](../../../src/control/conversation-control-dtos.ts)、[control-service.ts](../../../src/control/control-service.ts) | 请求、响应、列表、详情和已移除 Bot 映射 |
| Relay DTO | [dtos.ts](../../../packages/relay-protocol/src/dtos.ts) | Bot summary、detail 和 profile snapshot |
| Relay 请求 | [messages.ts](../../../packages/relay-protocol/src/messages.ts)、[payload-validators.ts](../../../packages/relay-protocol/src/payload-validators.ts) | create、update 与边界校验 |
| Web 编辑 | [BotDialog.vue](../../../packages/relay-web/src/components/BotDialog.vue) | 标签页、头像草稿、dirty、保存和取消 |
| Web 缓存 | [direct-bots.ts](../../../packages/relay-web/src/stores/direct-bots.ts) | 请求类型、配置值比较、资料同步 |
| 侧栏与 Direct | [InstanceTree.vue](../../../packages/relay-web/src/components/InstanceTree.vue)、[DirectBotPane.vue](../../../packages/relay-web/src/components/DirectBotPane.vue)、[ConversationMessageList.vue](../../../packages/relay-web/src/components/ConversationMessageList.vue) | Bot 行、顶栏、空态、历史与实时消息 |
| 共享消息行 | [TranscriptRow.vue](../../../packages/relay-web/src/components/TranscriptRow.vue) | 头像 slot，保留普通 Session 默认实现 |
| Group | [GroupTranscript.vue](../../../packages/relay-web/src/components/GroupTranscript.vue)、[GroupComposer.vue](../../../packages/relay-web/src/components/GroupComposer.vue)、[GroupHandoffEntry.vue](../../../packages/relay-web/src/components/GroupHandoffEntry.vue) | 消息、成员任务、选择器和交接双头像 |
| Group 状态 | [groups.ts](../../../packages/relay-web/src/stores/groups.ts) | 复用精确作用域的 live turn 和 MemberTurn 数据 |

新增类型采用仓库现有 domain 与 protocol 映射边界，不为共用类型让 daemon 依赖 Web 模块。固定目录 ID 在领域校验和 Web 渲染之间保持一致，不建立两套互不校验的目录。

新增 Web 文案同时提供中文和英文。普通 Session、Agent 选择器和 workspace 分组中的品牌标识不替换成 Bot 头像。

## 9. 落地顺序

以下步骤是同一完整功能的实施顺序，不是允许单独交付的缩水版本。

1. 完成结构化类型、边界校验、历史读取、快照隔离和协议 cutover。用实际 create、get、update、clear 验证持久化链路。
2. 接入必要的动画核心、`BotAvatar` 和编辑器。验证草稿、预览、保存、取消及刷新后的外观。
3. 迁移所有 Bot 展示位置。验证最新资料同步、已移除 Bot 回退和普通 Session 不变。
4. 接入 Direct 与 Group 状态，完成静态模式、主题、资源释放和无障碍行为。
5. 完成真实界面验收，并更新模块文档和发布说明。删除原头像文本输入框与已被替代的 Bot 品牌头像分支，不留下第二条写入或渲染路径。

## 10. 验收标准

| 编号 | 场景 | 通过条件 |
| --- | --- | --- |
| A1 | 新建与编辑 | 预设及形状、颜色、表情选择即时改变预览，保存的配置与预览一致 |
| A2 | 保存与恢复 | 保存后刷新页面、重新打开编辑框和重启隔离 daemon，外观不丢失 |
| A3 | 取消与默认图标 | 取消丢弃草稿，使用默认图标只在保存后清除配置 |
| A4 | 并发详情更新 | 迟到详情不覆盖用户头像草稿，保存只修改 dirty 字段 |
| A5 | 全部展示位置 | 侧栏、Direct、Group、成员选择器与交接入口使用一致外观，Agent 品牌用途不变 |
| A6 | 真实任务状态 | 排队、工作、文本输出、等待和各终态符合第 6 节，不把工具事件当文本输出 |
| A7 | Group 归属 | 一个成员工作不会让其他成员头像一起忙碌，无精确归属的 Router 等待不分配给成员 |
| A8 | Topic 与重连 | 切换话题、断线、重连和首次加载不残留旧任务动画，不补播完成动作 |
| A9 | 禁用与移除 | 禁用不掩盖已运行任务，已移除 Bot 不显示仍可工作的动画 |
| A10 | 历史迁移 | 旧字符串 Bot、已移除资料、Run 和 MemberTurn snapshot 可读取，不丢 Bot、不产生头像引起的 member_turn_corrupt |
| A11 | 快照值隔离 | 修改当前头像不改变已接受任务的头像快照 |
| A12 | 动画连续性 | 连续切换形状、表情和任务状态没有跳回旧姿态，眼睛不越界或抖动 |
| A13 | 主题与尺寸 | 两种主题和实际小尺寸均能辨认角色与眼睛，底板与遮罩没有错误底色 |
| A14 | 手机与键盘 | 无横向溢出，选项与保存入口可触达，键盘可完成选择和保存 |
| A15 | 减少动态效果 | 系统设置或头像开关关闭运动后不启动持续循环，真实状态仍可读取 |
| A16 | 动画资源释放 | 静态缩略图无循环，离屏和隐藏页面暂停，关闭与卸载后没有遗留订阅或指针监听 |
| A17 | 输入安全 | 非法版本和目录 ID 被拒绝，旧文本不触发外部图片请求，不执行用户 HTML 或 SVG |

真实界面验证使用 [隔离 verification stack](../../verification-stack.md)。执行过程记录实际命令、场景和观察结果，完成后运行 `down` 与 `doctor`，确认没有遗留进程、端口和状态目录。

自动化回归聚焦消费方行为，包括旧记录读取、清除语义、配置同步、快照隔离、任务归属、终态恢复和草稿不被覆盖。视觉效果用浏览器检查和固定时间采样验证，不用源代码字符串、CSS 类名或组件接线断言替代验收。

### 实施验证记录

- `bun run build:packages` 完成；随后对精确交互归属补丁重建 CLI、plugin API 与 relay connector。根类型检查使用实际项目编译器 `bun run tsc --noEmit`；本机 `npx tsc` 未解析到 TypeScript 编译器，不能把该输出当作通过。
- 最终协调构建后，后端头像与交互回归合计 15 个文件、429 项通过（头像 167、交互内核 242、Relay 交互 20）；完整 Web 166 个文件、2,227 项通过。最终桌面 / 手机弹层 Playwright 8 项通过。
- 隔离真实 daemon + Hub + dashboard，使用真实 ACP 进程协议 fixture（不是外部模型服务）：验证创建、保存、取消、清除默认图标、刷新与 daemon 重启；当前资料改为红色 / 关闭运动后，已接受任务仍保留紫色 / 自动运动的 revision-1 快照。
- 实际 Run 记录 queued → working → streaming → completed 始终使用同一 SVG clip；完成时眼睛短暂闭合再恢复。真实 q2 交互具有与当前任务完全一致的 Bot / Run / MemberTurn ID，头像显示 waiting，回答后显示 completed；结构化 ACP 错误显示 failed，实际流式 Stop 显示 cancelled，未知结果不伪装成完成。
- Group 实际成员任务保持各自终态；真实 `group_send` MCP 调用产生公开交接，两个 24px 静态头像保留不同外观，详情与接收方实际回复可展开。禁用运行中的 Bot 仍显示 working 并持续更新；未运行的禁用终态静止。
- 浅色 / 深色及 20 / 28 / 36px 实际预览已检查；390×844 弹层左右留白 16px、表单横向溢出 0。键盘切换标签页保留预览模式。关闭运动或系统减少动态效果时采样 25 帧仅有一个画面；离屏大预览同样静止。
- Chromium 实际监听检查：可见大预览有四个 pointer 监听；离屏与关闭后均为零。旧 SVG/URL 文本无脚本执行与外部图片请求；非法版本 / 目录 ID 被实际 RPC 拒绝。
- 实际 daemon 重启读取 744 字符的历史原始 URL，返回完整 `kind: text`、原 revision；受控移除后 tombstone 仍保留相同完整值。实例断开时，两个 Group 成员头像都变为 offline，不继续工作循环。
- 实际 Group 状态记录中，发送方 completed 后接收方才进入 working / streaming；发送方始终保持自己的 completed，不随接收方一起忙碌。切到新 Topic 后旧成员任务头像不残留。
- 全量 `npm test` 在未修改的 Windows Hermes URL fixture 处失败；此前宽范围单元运行有环境依赖与超时，未宣称全量通过。未运行需要真实微信与模型服务的 `tests/smoke`。
- `node scripts/verify-stack.mjs down` 与 `doctor` 完成：无残留进程、端口、状态目录或 scheduled task，operator home 未改动；临时 ACP / MCP verifier 与浏览器诊断已删除。

## 11. 授权与发布

bloub 使用 [MIT 许可证](https://github.com/jeremy-prt/bloub/blob/main/LICENSE)。复制或实质复用代码时保留 Jérémy Perret 的版权声明与许可证文本，并在引入记录中注明实际使用的上游 commit。

上游 README 明确区分代码授权与其模仿的 x.ai 视觉设计。xacpx 采用自己的配色、角色视觉和任务交互，不使用 Grok 或 x.ai 标识，不声称获得其认可。

实施完成后，更新 [Relay Web 模块文档](../../relay-web-module.md)、[Control 模块文档](../../control-module.md)、[Relay 模块文档](../../relay-module.md) 和 [Conversation runtime 文档](../../conversation-runtime.md) 中受影响的头像字段与迁移说明。协议和相关包按 [Relay 发布流程](../../relay-release.md) 配套发布。
