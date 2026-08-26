# Relay-Web 前端本地桌面通知 Fallback 方案规范

## 目标

在现有 **服务端 Web Push（W3C VAPID）** 机制的基础上，为 Relay-Web 补充 **前端本地桌面通知（Web Notification API Fallback）** 能力。

### 解决的核心痛点

在特定部署网络环境（如中国大陆境内服务器/私有云且未配置出站 HTTP 代理）下，Hub 向 Google FCM（`fcm.googleapis.com`）推送 Web Push 会因网络不可达而导致 Chrome 用户收不到通知。

开发者日常工作场景中，绝大多数时候会将 Relay-Web 标签页保留在浏览器后台，切换至 VS Code、终端、微信等其他应用工作。此时前端 WebSocket 连接保持活跃，通过 Hub 权威决策广播的 `turn-completion` Web 事件直接调用浏览器本地系统通知，能够实现：
- **100% 本地环境与网络直连可用**（零外部 FCM/APNs 依赖，零代理配置要求）；
- **秒级系统原生横幅弹出**（带提示音、完成摘要、失败错误原因）；
- **点击通知自动聚焦/切换到对应会话**（支持 SW postMessage / deep-link 与 DOM Notification 点击路由）；
- **权威语义隔离**：由 Hub 严格做资格判定与去重，杜绝 scheduled / peer / orchestration worker / recovery replay 的误打扰。

---

## 一、双轨互补架构

```text
                               Agent Turn 完成
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
          【通道 A：Web Push】                  【通道 B：本地 Notification】
      Hub → FCM / APNs → 浏览器             Hub → WebSocket (turn-completion) → 活跃页面
                   │                                     │
         适合：标签页已完全关闭                 适合：标签页在后台挂着
         限制：需出站网络直连/代理               优势：零外网依赖，直连秒级送达
```

---

## 二、核心设计原则

### 1. Hub 权威决策与协议隔离（Security & Provenance Isolation）
- **协议隔离**：`turn-completion` 为 Hub 专属的 `WebServerEvent`，不复用 connector 域的 `InstanceNoticePayload`，connector 无法伪造完成通知；
- **权威判定**：只有经过 Hub 校验（`origin === "relay-web"`、`!peerOrigin`、`!cancelled`、recovery receipt 去重）的交互回合，Hub 才会触发 Web Push 并广播 `turn-completion` WebServerEvent；
- **Recovery/StateSync 补齐**：connector 断线重连后上报的 `finishedOffline` 回合在 Hub 确认接受后，同样触发 Web Push 与 `turn-completion` 广播。

### 2. 多标签页免打扰前台抑制（Cross-Tab Active Tab Suppression）
- 单标签页判定：若当前标签页正处于前台聚焦并查看该会话（`selected && !document.hidden && document.hasFocus()`），静音不弹通知；
- 跨标签页心跳与生命周期：`initTabFocusTracker()` 实时监听 `focus`、`blur`、`visibilitychange`、`beforeunload`。当用户 Alt-Tab 切到 VS Code 时，`blur` 立即释放 focus 锁，保证秒级接收通知；前台停留时通过 1.5s 周期心跳维持跨标签页抑制；
- 跨标签页并发去重（Slot Claim）：多后台标签页同时收到 `turn-completion` 时，按 `notificationId` 选举唯一通知发送者，既防止同一回合多 tab 重复弹窗，又保证同一会话不同回合（不同 notificationId）不被误吃。

### 3. 统一 Tag 会话隔离与点击路由
- 通知 Tag 统一采用按会话隔离命名：`xacpx-turn:${instanceId}:${sessionAlias}`；
- **Service Worker 路径**：在 `push-sw.js` 的 `notificationclick` 事件中，向所有匹配 client 广播 `{ type: "SELECT_SESSION", instanceId, sessionAlias }` 并聚焦窗口；若为无 session 的 task-completion 则执行 `navigate` 回首页；
- **DOM Notification 路径**：在 `onclick` 中调用全局注册的点击回调，直接切换至目标会话并聚焦窗口；
- **页面挂载**：`DashboardView.vue` 统一监听 SW 消息与 URL query 参数（并在消费后通过 `history.replaceState` 清理，避免刷新误跳转）。

### 4. 独立、持久化的单一事实源控制与 i18n
- 本地通知受持久化设置 `xrelay.desktopNotificationsEnabled` 控制，用户在 Settings 页面关闭桌面通知后本地通知与 Web Push 立即全部停止；
- 通知标题与提示文案（如 `Task completed` / `任务已完成`、`Task failed: {error}` / `任务失败: {error}`、`Unknown error` / `未知错误`）严格遵循中英双语目录国际化规范。

### 5. 有界超时的 Service Worker 探测
- 不无条件无限期等待 `navigator.serviceWorker.ready`；
- 先通过 `getRegistration()` 探测活跃 worker，未就绪时设置 250ms 有界竞态超时，超时或无 active worker 立即平滑降级为标准 DOM `new Notification()`。

---

## 三、通知内容规范

| 字段 | 规则 | 示例 |
|---|---|---|
| **title** | `<instance name> · <session alias>` | `MacBook · backend` |
| **body** (成功) | 取 Agent 最终回复前 200 字；空文本回退为国际化 `"Task completed"` | `Fixed unit tests in auth.ts...` |
| **body** (失败) | 国际化格式 `"Task failed: <errorMessage>"` | `Task failed: provider unavailable` |
| **icon** | `/pwa-192x192.png` | |
| **tag** | `xacpx-turn:<instanceId>:<sessionAlias>` | `xacpx-turn:d02c617e-...:backend` |
| **data** | `{ instanceId, sessionAlias, url: "/" }` | |

---

## 四、测试与验证计划

1. **单元测试** (`packages/relay-web/src/__tests__/local-notification.test.ts`)：
   - 权限未授予或设置被用户关闭时不触发通知；
   - 标题、截断 Body、tag 组装与 i18n 翻译；
   - 单标签页与跨标签页前台活跃抑制；
   - `initTabFocusTracker` focus/blur/heartbeat 生命周期；
   - 按 `notificationId` 跨 tab 去重；
   - 点击通知后触发会话选择回调；
   - Service Worker ready 挂起时的超时降级；
   - `turn-completion` 专属事件触发验证与 connector 消息忽略。
2. **构建与类型验证**：
   - `vue-tsc --noEmit` 0 报错；
   - `vitest run` 全通过。
