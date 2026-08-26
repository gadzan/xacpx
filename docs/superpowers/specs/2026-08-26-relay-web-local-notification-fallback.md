# Relay-Web 前端本地桌面通知 Fallback 方案规范

## 目标

在现有 **服务端 Web Push（W3C VAPID）** 机制的基础上，为 Relay-Web 补充 **前端本地桌面通知（Web Notification API Fallback）** 能力。

### 解决的核心痛点

在特定部署网络环境（如中国大陆境内服务器/私有云且未配置出站 HTTP 代理）下，Hub 向 Google FCM（`fcm.googleapis.com`）推送 Web Push 会因网络不可达而导致 Chrome 用户收不到通知。

开发者日常工作场景中，绝大多数时候会将 Relay-Web 标签页保留在浏览器后台，切换至 VS Code、终端、微信等其他应用工作。此时前端 WebSocket 连接保持活跃，通过 WebSocket 接收到的 `turn-finished` 事件直接调用浏览器本地系统通知，能够实现：
- **100% 本地环境与网络直连可用**（零外部 FCM/APNs 依赖，零代理配置要求）；
- **秒级系统原生横幅弹出**（带提示音、完成摘要、失败错误原因）；
- **点击通知自动聚焦/切换到对应会话**（支持 SW postMessage / deep-link 与 DOM Notification 点击路由）。

---

## 一、双轨互补架构

```text
                               Agent Turn 完成
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
          【通道 A：Web Push】                  【通道 B：本地 Notification】
      Hub → FCM / APNs → 浏览器             Hub → WebSocket → 活跃页面
                   │                                     │
         适合：标签页已完全关闭                 适合：标签页在后台挂着
         限制：需出站网络直连/代理               优势：零外网依赖，直连秒级送达
```

---

## 二、核心设计原则

### 1. 多标签页免打扰前台抑制（Cross-Tab Active Tab Suppression）
- 单标签页判定：若当前标签页正处于前台聚焦并查看该会话（`selected && !document.hidden && document.hasFocus()`），静音不弹通知；
- 跨标签页判定：通过 `localStorage` 维护跨标签页活跃聚焦状态（`xrelay.activeFocus`）。当标签页 A 正在前台查看该会话时，后台的标签页 B 自动识别并抑制本地通知，避免用户正在屏幕前看回复时被后台标签页弹窗打扰；
- 跨标签页并发去重（Slot Claim）：多后台标签页同时收到 `turn-finished` 时，通过 `claimNotificationSlot` 选举唯一通知发送者，避免产生重复弹窗。

### 2. 统一 Tag 会话隔离与去重
- 通知 Tag 采用按会话隔离命名：`xacpx-turn:${instanceId}:${sessionAlias}`；
- 既保证支持平台原生替换合并，又避免同一实例下不同并发会话的完成通知互相覆盖。

### 3. 点击通知路由至目标会话
- **Service Worker 路径**：在 `push-sw.js` 的 `notificationclick` 事件中，优先向已打开的 client 发送 `{ type: "SELECT_SESSION", instanceId, sessionAlias }` 并聚焦窗口；若无已打开窗口则附带 query params 打开新窗口；
- **DOM Notification 路径**：在 `onclick` 中调用全局注册的点击回调，直接切换至目标会话并聚焦窗口；
- **页面挂载**：`DashboardView.vue` 统一监听 SW 消息与 URL query 参数（`instanceId` & `sessionAlias`），实现无缝跳转。

### 4. 独立、持久化的开关控制与 i18n 国际化
- 本地通知受持久化设置 `xrelay.desktopNotificationsEnabled` 控制，用户在 Settings 页面关闭桌面通知后本地通知立即停止；
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
   - 多后台标签页并发去重 slot claim；
   - 点击通知后触发会话选择回调；
   - Service Worker ready 挂起时的超时降级；
   - `cancelled === true` 时不触发通知。
2. **构建与类型验证**：
   - `vue-tsc --noEmit` 0 报错；
   - `vitest run` 全通过。
