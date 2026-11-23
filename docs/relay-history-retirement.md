# Relay 服务端消息留存退休 + 客户端留存技术方案

> 状态：已实施（2026-11）。本文既是方案也是实施记录：服务端 hub 不再落盘任何消息正文，
> 浏览器 IndexedDB 成为客户端 durable 副本，daemon 自己的 transcript 是真相源。

## 1. 背景与目标

历史结论（此前群内已确认）：relay 把 SQLite `relay.db` 当会话历史缓存，
`messages` 表明文存 prompt / 回复 / tool 输出 / reasoning / 图片预览。
目标：

1. **服务端不落消息记录**——`relay.db` 不再出现任何聊天正文；
2. **更好性能体验**——热路径零磁盘 I/O、无 SQLite 锁、无每小时全表 prune；
3. **客户端留存可用**——刷新/重启不断片，多端语义明确；
4. **上限处理有交代**——每一层存满/到期时的行为、用户可见性都要定义。

非目标：端到端加密。`control.*` 全文仍经过 hub 进程内存 + TLS（代理转发必然），
退休解决的是"落盘留存"，不是"过境可见"。

## 2. 现状盘点：`messages` 表一身四职

| 职责 | 说明 | 退休后去向 |
|---|---|---|
| 历史缓存 API | `GET .../messages` 分页 + `compact` 首屏 + `/:id` 水合 | 客户端 IndexedDB 全量留存（§5），hub 只给本 boot 的行 |
| 排队条 durability | `queue_item_id` 未 drain 行跨刷新恢复 | hub 内存（同 boot）；重启后丢失（daemon 侧队列本就是内存的，行为对齐） |
| 恢复去重 | `origin_queue_item_id` / `prompt_request_id` / `recovery_receipts` | 保留：收据是 SQLite 纯 key（无正文），跨重启仍去重；内存行丢了按"已送达"丢弃重发（§4.3） |
| 排序槽 | `slotAfterId`/`lastId`、`turn_slot_anchors` | anchors 启动时清空（旧 boot id 已无意义），同 boot 内继续工作（§4.4） |

控制面（`accounts`/`login_tokens`/`web_sessions`/`invite_codes`/`instances`/
`push_subscriptions`/`pending_completion_routes`）**全部保留落盘**：只存哈希与路由
元数据、无聊天正文，是鉴权与配对的硬依赖。

## 3. 总体决策

- Hub transcript → **进程内内存环**（`MemoryMessageStore`），与 `MessageStore`
  同接口（`MessageHistoryStore = Pick<…>`），`server.ts` / `http/app.ts` 零逻辑改动。
- 启动时 **DROP 遗留 `messages` 表**（`retireMessageTables()`，上报行数），新库不再建表。
- 客户端 **IndexedDB 全量留存**：`session-tail-cache.ts` 从"尾部 10 行"升级为
  "每会话全量 + 上限裁剪"，hub 页与本地缓存按 id 合并展示。
- `--history-retention-days` 保留解析、打印 deprecation（老部署脚本不炸）；
  `/api/config` 返回 `{ mode: "client-side", days: 30, maxPerSession: 2000 }`——
  数字是旧服务端默认值（老客户端不显示“0 条·0 天”），新客户端只看 `mode`，
  设置页切换为客户端口径展示。

## 4. 服务端改动清单

| 文件 | 改动 |
|---|---|
| `stores/messages-memory.ts`（新） | 与 `MessageStore` 同方法、同语义的内存实现；id 用随机 boot 前缀 + 计数器（秒级有序、boot 内递增、boot 间几乎不撞），客户端可按 id 合并；每会话 500 行环 + 全局 10000 行（ oldest-first 驱逐）；`deleteByInstance` 随实例删除清行 |
| `stores/messages.ts` | 增 `MessageHistoryStore`（`Pick` 全部 21 个方法）；SQLite 类保留（回滚路径 + 单测对象），生产不再接线 |
| `server.ts` | `new MemoryMessageStore(options.now)`；serving 启动（`serving: true`，即 `startRelayServer`）调 `retireMessageTables`（+VACUUM、warn 日志） + `slotAnchors.clearAll()`；管理命令（`ls`/`add token`/`rm token`…）开库不带该 flag，保持无副作用；`--history-retention-days` 标 `@deprecated`；`createApp` 不再传已废弃的 retention 参数；hourly maintenance 只做全局计数 cap（无 age prune） |
| `db.ts` | `initSchema` 不再建 `messages` 表及相关索引/迁移分支；新增 `retireMessageTables()` |
| `stores/accounts.ts` | `deleteAccountCascade` 删除 `messages` 表引用（表已不存在；运行中 hub 的内存行经 `instances` 归属校验已不可达，属有界泄漏，见 §7） |
| `stores/turn-slot-anchors.ts` | 增 `clearAll()`；类注释改为 boot-scoped 语义 |
| `stores/recovery-receipts.ts` | 注释更新：收据可比行活得久，sync 把"有收据无行"视为已送达、丢弃重发 |
| `http/app.ts` | `messages: MessageHistoryStore`；`/api/config` 报 `client-side`（数字段保留旧默认值兼容老客户端）；`deleteBySession`/`markQueued` 等调用不变（内存实现）；DELETE 实例同时调 `deleteByInstance` 清内存行 |
| `cli.ts` | USAGE 去掉 `--history-retention-days`；`start` 时若传入则提示已退休 |

### 4.1 为什么 slot anchors 启动清空（仅 serving 启动）

anchor 存的是"turn-started 时的 hub message id"。id 改为每 boot 重排后，
上个 boot 的 anchor 指向死 id，会污染新 boot 的排序。daemon 重连必带
`state.sync`（内含 running turns 的 prompt），恢复路径用"回填后 lastId"
重建 anchor，语义等价——旧测试 `runtime-restart.test.ts` 已按此重写并通过。
清理只发生在 serving 启动：管理 CLI（`ls`/`add token`/`rm token`…）与运行中 hub
共享同一个 `--db`，开库时不带 `serving` flag，不得把在途 turn 的 anchor 清掉。

### 4.2 为什么 recovery receipts 保留

收据是 `(instance_id, recovery_id)` 纯 key，无正文；daemon 的 finished-offline
FIFO 重发只认"是否 ack"，hub 重启后靠它去重。行丢了 + 有收据 = 之前已展示过，
丢弃是正确动作（daemon 仍有原文）。

### 4.3 跨重启恢复的新语义（测试已锁定）

- B（新 boot）sync → running turn 的 prompt 回填 + finishedOffline 落行；
- 已 ack 又被病态重发的条目 → 有收据 → 丢弃，**不**复活（行随旧 boot 消亡）；
- `slotAfterId` 无 anchor 时为 0（空 transcript），客户端按 `createdAt` 展示。

## 5. 客户端留存设计（`session-tail-cache.ts`）

### 5.1 存储结构（兼容升级，不丢旧缓存）

- `TailRecord` 增可选字段 `full?: MessageRecordDto[]`、`droppedTotal?: number`；
  **DB 版本不升级**——旧记录无 `full` 时回退读 `rows`（10 行尾），用户旧缓存保留。
- 读取校验沿用：TTL 30 天、incarnation（同 alias 重建隔离）、损坏丢弃、LRU touch。

### 5.2 上限（§6 详述处理）

| 层 | 值 | 说明 |
|---|---|---|
| 每会话行数 | `TRANSCRIPT_MAX_ROWS = 1000` | 超出 oldest-first 丢弃 |
| 每会话字节 | `TRANSCRIPT_MAX_BYTES = 8 MB` | 按行字段估算（无全量 `JSON.stringify`，附件只计元数据 + 上限内 preview，不计原始文件 `size`），超出一半一半从最旧砍；入库前剥离超 256KB 的 `previewUrl`（relay 准入上限，正常降采样图远小于此），元数据保留 |
| 全局 | `GLOBAL_BUDGET_BYTES = 64 MB`（既有） | 跨会话 LRU 驱逐（key-cursor，不反序列化 rows） |
| TTL | 30 天（既有） | 过期惰性删除 |
| 配额耗尽 | 既有 fallback | 清库后重试只留当前会话 |

### 5.3 读写路径（`chat.ts`）

- **种子**：`select()` → `readTranscript(limit 50)`，首屏即全量工作集；
  `hasMoreOlder`、`historyCapped` 一并建立。
- **收敛**：`loadHistory()` 取 hub 页（limit 10，本 boot）∪ 本地 transcript，
  按 id 合并取最新 50；`hasMoreOlder = hubHasMore || cacheHasMore || union超窗`。
- **翻页**：`loadOlder()` 双源（hub `before` + `readOlder(beforeId, 50)`）合并前插；
  跨 hub 重启继续翻页（旧 boot 行全在本地）。
- **写回**：500ms 防抖，读-改-写（窗口 ∪ 缓存 by id，不替换）：
  空窗口不删（切会话/空会话不会删除缓存），直播中跳过（收敛后再写），
  本次驱逐 `dropped>0` 时刷新横幅计数。
- **水合**：`ensureFullMessage` 先查本地 `readRow`（full 则直接用），再问 hub；
  hub 404（旧 boot 行）吞掉、保留 compact 卡（best-effort，不弹错）。
- **上限横幅**：`historyCapped = { kept, dropped }`（store）→ `MessageList`
  顶部 `data-test="history-capped"` + `$t("chat.historyCappedNotice")`（中英）；
  切会话/清选择时清零。
- **设置页**：`/api/config` 按 `mode` 渲染——`client-side` 显示
  `retentionClientShort/Body`（引用 `TRANSCRIPT_MAX_ROWS` 常量，不硬编码），
  旧 hub payload 走 legacy 分支（向后兼容）。

## 6. 数据到上限的处理（本方案的核心交代）

| 层级 | 触发 | 处理 | 用户可见 |
|---|---|---|---|
| Hub 内存环（500/会话，10000/全局） | 写入超限 | oldest-first 丢弃（同 boot 内）；`prune()` 同口径 | 不可见——hub 不是档案，只保证直播 + 同 boot 翻页；重启即空是预期 |
| 客户端会话行数（1000） | 写回合并超限 | oldest-first 丢弃，`droppedTotal` 累加 | 横幅："本地历史已达上限，仅保留最近 N 条（已清理 M 条）" |
| 客户端会话字节（8MB） | 字段估算超限 | 从最旧端折半丢弃（log 次估算），`droppedTotal` 累加 | 同上（与行数上限同一横幅） |
| 客户端全局（64MB） | `putAndEvict` 超限 | 按 `[lastAccess, bytes]` LRU 删整会话（写会话除外）；配额异常时清库重试只留当前会话 | 被驱逐的会话下次打开时从 daemon 种子 + 直播重建（可能缺旧段，无横幅——LRU 语义） |
| TTL（30 天） | 读/写时检查 | 惰性删除该会话条目 | 下次打开显示空 + 重新拉取（daemon 在线才有全量） |
| Hub 重启 | 进程退出 | 内存全失；`session-history` 种子 + `state.sync` 回填本 boot 行 | 同 boot 内无感；旧 boot 的行只在**本机缓存**里（换设备 + daemon 离线 = 看不到旧记录，见 §7） |
| Token/实例删除 | `rm token` / `sessionsRemove` | `deleteBySession` 清内存行；`rm token` 跨进程，运行中 hub 的孤儿行残留至多一个环大小、不可达（归属校验失败 → 404） | 无 |

上限选择的理由：1000 行 ≈ 服务端旧上限 2000 的一半（客户端按需翻页，不必一次全驻留；
50 行工作集常驻内存，滚动按 50 行页进）；8MB/会话按真实占用计费（附件只计元数据 +
上限内 preview，原始文件 `size` 不计入），超限才从最旧端驱逐；64MB 全局沿用既有尾缓存预算（浏览器配额数百 MB，留足余量）；
30 天沿用既有 TTL（服务端旧 retention 默认值，心智一致）。

## 7. 已知取舍与风险

1. **换设备 + daemon 离线 = 旧记录不可见**。接受：daemon 在线时只回填 running turn 与未 ack 的 finished turn（见 §4.3）；离线只看本机缓存。
2. **全文搜索/多端同步弱化**：缓存是单机 IndexedDB，无跨端合并。接受（当前无此功能）。
3. **`rm token` 孤儿内存行**：有界（环上限）、不可达、重启清零。可后续给运行中 hub
   加清扫（`deleteAccountCascade` 后广播），暂不做。
4. **审计归档消失**：hub 不再是聊天档案。需要合规归档的部署请在 daemon 侧做。
5. **旧版 relay-web 连新 hub**：hub 页变小（本 boot），`hasMore` 照常工作，只是翻页
   更快见底；`retentionShort` 分支保留，设置页不炸。
6. **新版 relay-web 连旧 hub**：`mode` 缺失 → 走 legacy 设置文案；缓存合并对 SQLite
   小 id 与内存大 id 同样按 id 合并，无碰撞（§4 id 基址设计）。

## 8. 测试矩阵

服务端（`bun test`，本机全绿）：

| 文件 | 动作 |
|---|---|
| `stores-messages.test.ts` ×2（`stores/` 与根各一） | 重写为 `MemoryMessageStore` 行为契约：分页/游标、附件、account 隔离说明、ring 驱逐、跨实例 id 不碰撞、全局 10000 行 oldest-first 驱逐、`deleteByInstance` 按实例清行 |
| `db.test.ts` | 新库无 `messages` 表；`retireMessageTables` 删遗留表并上报行数、幂等；`initSchema` 见遗留表不迁移 |
| `maintenance.test.ts` | prune 改测内存实现（按龄 + 按量） |
| `stores-accounts.test.ts` | cascade 去掉 messages 断言 |
| `http-app.test.ts` | `/api/config` 断言 `client-side`；其余 `new MemoryMessageStore()` 直换；`DELETE /api/instances/:id` 断言清内存行 |
| `runtime-restart.test.ts` | 按 §4.3 新语义重写 6 个用例（行随 boot 消亡、收据跨重启去重、anchor 在 serving 启动时清空、回填重建 slot）；全文件运行时带 `serving: true`；新增管理 CLI 开库无副作用用例（anchor 与遗留表均保留） |
| `runtime-state-sync/fanout/peer-node-stamp/integration/http/messages-endpoint` | 未改——单运行时语义不变，直接通过 |
| `relay-interaction-transport` / `elicitation` / `collaboration-ux` | `new MemoryMessageStore()` 直换 + 类型改为 `MessageHistoryStore` |

客户端（vitest；本机沙箱 16 个既有用例因 `api` mock 拦截失效而失败，
**stash 基线同样 16 失败**，与本次改动无关）：

| 用例 | 状态 |
|---|---|
| 新增 9 个 transcript 契约测试（合并/兼容/行上限/翻页/readRow/空窗口/化身隔离/附件 `size` 不计入字节预算/超限 preview 剥离留元数据） | 全过 |
| `select() seeds…`（种子改走 `readTranscript`） | 过——种子路径已验证 |
| 既有 16 个 store-flow 用例 | 基线同败（环境），CI 复核 |
| 独立 `bun verify-transcript-cache.ts`（19 项，fake-indexeddb 直驱） | 全过（临时脚本，验证后删除） |
| `.vue` script 块 esbuild 转译 | 通过（完整 vue-tsc 在本机缺 .vue 解析，属环境问题） |

## 9. 发布与回滚

- 发布：随 relay 正常发版；升级后首次 serving 启动自动 DROP 遗留表（warn 日志带行数）
  并 VACUUM 回收空间。升级前必须 `cp relay.db relay.db.bak` 备一份——DROP 不可逆，
  无备份无法恢复旧历史；代码侧不保留改名表（`messages_backup` 仍是磁盘明文留存，
  与退休目标相悖）。现网 `x.gadzan.com` 按此执行。
- 回滚：代码回退 + 恢复 DB 备份；`MessageStore`（SQLite）类保留在仓内，
  接线改回只需换 `server.ts` 一行（`new MessageStore(db)`）+ 恢复 `db.ts` 建表。
- 回滚窗口注意：新 hub 运行期间产生的内存行无法写回旧表（重启即失），
  回滚后历史回到备份时刻——需在变更公告里写明。

## 10. 验证步骤（发布前）

1. `bun test tests/unit/packages/relay` 全绿；`bunx tsc -p packages/relay` 零错误。
2. 起两个会话并发 turn：对比 `turn-finished` p99（应去掉 fsync 毛刺）+ `relay.db`
   体积不再增长（`ls -l ~/.xacpx-relay/relay.db`）。
3. 看板刷新 → 首屏 50 行瞬间出；上翻跨页；hub 重启后刷新 → 本机历史仍在、
   新 turn 照常；换浏览器（无缓存）+ daemon 在线 → 种子 + 直播重建。
4. 造 1200 行会话 → 横幅出现，`droppedTotal` 递增；清缓存重进 → 横幅消失。
5. 旧版 relay-web 连新 hub：翻页更快见底、无报错；设置页显示"仅本设备"。
