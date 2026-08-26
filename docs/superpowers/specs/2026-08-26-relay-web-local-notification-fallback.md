# Relay-Web 前端本地桌面通知 Fallback 方案规范

## 目标

在现有 **服务端 Web Push（W3C VAPID）** 机制的基础上，为 Relay-Web 补充 **前端本地桌面通知（Web Notification API Fallback）** 能力。

### 解决的核心痛点

在特定部署网络环境（如中国大陆境内服务器/私有云且未配置出站 HTTP 代理）下，Hub 向 Google FCM（`fcm.googleapis.com`）推送 Web Push 会因网络不可达而导致 Chrome 用户收不到通知。

开发者日常工作场景中，绝大多数时候会将 Relay-Web 标签页保留在浏览器后台，切换至 VS Code、终端、微信等其他应用工作。此时前端 WebSocket 连接保持活跃，通过 WebSocket 接收到的 `turn-finished` 事件直接调用浏览器本地系统通知，能够实现：
- **100% 本地环境与网络直连可用**（零外部 FCM/APNs 依赖，零代理配置要求）；
- **秒级系统原生横幅弹出**（带提示音、完成摘要、失败错误原因）；
- **点击通知自动聚焦/切换到对应会话**。

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

### 1. 免打扰前台抑制（Active Tab Suppression）
只有当 **用户未在当前标签页聚焦关注该会话** 时，才发出桌面通知：
- 页面处于后台或最小化：`document.hidden === true`；
- 浏览器窗口未聚焦（用户在其他软件中）：`!document.hasFocus()`；
- 用户在 Relay-Web 中正在查看其他会话：`!isViewingThisSession`。

如果用户当前正停留在该会话、窗口处于聚焦状态盯着屏幕看 Agent 输出，则**静音不弹通知**，避免干扰。

### 2. 与 Web Push 统一 Tag 去重
- 本地通知与 Web Push 使用完全相同的 `tag`（`xacpx-task:${instanceId}`）。
- 操作系统通知中心会自动按 `tag` 覆盖合并，确保即便两条路径均送达，也绝不会出现重复横幅。

### 3. 取消（Cancelled）不通知
- 用户主动点击 Cancel / Stop（`e.cancelled === true`）不发出通知。
- 仅在正常完成（`status === "done"`）或失败报错（`status === "error"`）时触发。

### 4. 零配置与权限复用
- 复用现有 Settings 页面「桌面通知」权限。
- 只要浏览器授予了 `Notification.permission === "granted"`，本地通知即自动生效，无需额外配置开关。

---

## 三、通知内容规范

| 字段 | 规则 | 示例 |
|---|---|---|
| **title** | `<instance name> · <session alias>` | `MacBook · backend` |
| **body** (成功) | 取 Agent 最终回复前 200 字；空文本回退为 `"Task completed"` | `Fixed unit tests in auth.ts...` |
| **body** (失败) | `Task failed: <errorMessage>` | `Task failed: provider unavailable` |
| **icon** | `/pwa-192x192.png` | |
| **tag** | `xacpx-task:<instanceId>` | `xacpx-task:d02c617e-...` |
| **data** | `{ instanceId, sessionAlias, url: "/" }` | |

---

## 四、技术实现设计

### 1. 独立工具模块：`packages/relay-web/src/lib/local-notification.ts`

```ts
export interface LocalTurnNotificationInput {
  instanceId: string;
  instanceName: string;
  sessionAlias: string;
  ok: boolean;
  text?: string;
  errorMessage?: string;
}

const BODY_CAP = 200;

export async function showLocalTurnNotification(input: LocalTurnNotificationInput): Promise<void> {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  const title = `${input.instanceName} · ${input.sessionAlias}`;
  let body: string;
  if (input.ok) {
    const trimmed = (input.text ?? "").trim();
    body = (trimmed.length > 0 ? trimmed : "Task completed").slice(0, BODY_CAP);
  } else {
    const errMsg = (input.errorMessage ?? "").trim();
    body = `Task failed: ${errMsg || "Unknown error"}`.slice(0, BODY_CAP);
  }

  const options: NotificationOptions = {
    body,
    tag: `xacpx-task:${input.instanceId}`,
    icon: "/pwa-192x192.png",
    data: {
      instanceId: input.instanceId,
      sessionAlias: input.sessionAlias,
      url: "/",
    },
  };

  // 1. 优先通过 ServiceWorker 发送（支持点击自动导航并复用 push-sw.js）
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if (reg && "showNotification" in reg) {
        await reg.showNotification(title, options);
        return;
      }
    }
  } catch {
    // 降级使用标准 Notification API
  }

  // 2. 降级使用标准 Notification API
  try {
    const n = new Notification(title, options);
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // 忽略特定环境不支持的抛错
  }
}
```

### 2. 接缝调用：`packages/relay-web/src/stores/chat.ts`

在 `applyEvent` 处理 `turn-finished` 时：
```ts
    } else if (e.type === "turn-finished") {
      const status: TurnStatus = e.cancelled ? "cancelled" : e.ok ? "done" : "error";
      const selected = event.instanceId === instanceId.value && e.sessionAlias === sessionAlias.value;
      ...
      // 本地桌面通知 Fallback（后台免打扰抑制）：
      if (!e.cancelled && (status === "done" || status === "error")) {
        const isViewingThisSession = selected && typeof document !== "undefined" && !document.hidden && (typeof document.hasFocus !== "function" || document.hasFocus());
        if (!isViewingThisSession) {
          const instancesStore = useInstancesStore();
          const instName = instancesStore.byId(event.instanceId)?.name ?? event.instanceId;
          void showLocalTurnNotification({
            instanceId: event.instanceId,
            instanceName: instName,
            sessionAlias: e.sessionAlias,
            ok: e.ok,
            text: e.text,
            errorMessage: e.errorMessage,
          });
        }
      }
```

---

## 五、测试与验证计划

1. **单元测试** (`packages/relay-web/src/__tests__/local-notification.test.ts`)
   - 验证权限未授予时不触发通知；
   - 验证成功与失败时标题、截断 Body、tag 组装；
   - 验证 `cancelled === true` 时不触发通知；
   - 验证 `document.hidden` 及跨 Session 查看场景下的触发条件。
2. **构建与类型验证**
   - `vue-tsc --noEmit` 0 报错；
   - `vitest run` 全通过。
