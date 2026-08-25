# Safari Web Push Support 实现方案

目标：在现有 PR #305 Web Push 架构上增加 **Safari 支持**，覆盖：

* macOS Safari Web Push
* iPhone / iPad Home Screen Web App Web Push
* 保持 Chrome/Chromium 行为不变
* 不削弱现有 SSRF 防护
* 不引入 Apple Developer Program、APNs certificate 等额外依赖

Apple 的 Safari 使用标准 Web Push / VAPID。macOS Safari 16.1+ 支持标准 Web Push；iOS/iPadOS 16.4+ 支持添加到主屏幕的 Web App，并且 Apple 明确要求服务端允许 `*.push.apple.com` Push endpoint。([WebKit][1])

## 1. 当前限制

现有实现前端和 Hub 都只允许两个 FCM origin：

```ts
const ALLOWED_ENDPOINT_ORIGINS = {
  "https://fcm.googleapis.com": true,
  "https://fcm.notifications.google.com": true,
};
```

因此 Safari 虽然可以成功创建 `PushSubscription`，但 Apple 返回的 endpoint 属于：

```text
https://<subdomain>.push.apple.com/...
```

随后会被 xacpx 自己判定为 `push-endpoint-unsupported`。

前端限制位于：

```text
packages/relay-web/src/lib/web-push.ts
```

现有代码也明确注明当前只支持 Chrome。

Hub 同样有独立 endpoint validator：

```text
packages/relay/src/push.ts
```

所以这次必须 **前后端同时扩展**，不能只改一边。

---

# 2. Endpoint validator

不要把 Apple 写成固定 origin，因为 Apple 官方要求的是：

```text
*.push.apple.com
```

也不要简单写这种不安全判断：

```ts
endpoint.includes("push.apple.com")
```

或者：

```ts
hostname.endsWith("push.apple.com")
```

后者会错误接受：

```text
evilpush.apple.com
```

建议前后端统一成这种语义：

```ts
export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);

    if (url.protocol !== "https:") return false;

    // Push services should only be reachable over normal HTTPS.
    // URL.port is "" for implicit 443.
    if (url.port !== "" && url.port !== "443") return false;

    if (
      url.hostname === "fcm.googleapis.com" ||
      url.hostname === "fcm.notifications.google.com"
    ) {
      return true;
    }

    // Apple officially requires allowing any subdomain of push.apple.com.
    if (url.hostname.endsWith(".push.apple.com")) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
```

Apple 官方明确说 Safari Web Push 服务端需要允许 `*.push.apple.com`。([WebKit][1])

### 必须注意

不要接受：

```text
https://push.apple.com.evil.com/...
https://evilpush.apple.com/...
https://push.apple.com@evil.com/...
http://web.push.apple.com/...
https://web.push.apple.com:8443/...
https://example.com/?next=https://web.push.apple.com/
```

应该接受：

```text
https://web.push.apple.com/...
https://foo.push.apple.com/...
https://foo.bar.push.apple.com/...
https://web.push.apple.com:443/...
```

我倾向于**不接受裸的**：

```text
https://push.apple.com/
```

因为 Apple 的公开要求是 `*.push.apple.com`，不是 `push.apple.com`。

---

# 3. Hub 改动

修改：

```text
packages/relay/src/push.ts
```

现有：

```ts
const ALLOWED_ENDPOINT_ORIGINS = {
  "https://fcm.googleapis.com": true,
  "https://fcm.notifications.google.com": true,
};
```

改成支持：

```text
FCM
+
*.push.apple.com
```

继续确保所有客户端提交的 endpoint 都经过这个 validator。

这是一个**安全边界**，不能为了 Safari 改成：

```ts
url.protocol === "https:"
```

因为 Hub 会从服务器网络直接 POST 到客户端提交的 endpoint；允许任意 HTTPS 会重新打开 #305 已经修掉的 blind SSRF。

---

# 4. relay-web 改动

修改：

```text
packages/relay-web/src/lib/web-push.ts
```

把同样的 Apple endpoint 规则加入：

```ts
isAllowedPushEndpoint()
```

现有流程：

```text
PushManager.subscribe()
        ↓
检查 endpoint
        ↓
unsupported -> unsubscribe
        ↓
PUT Hub
```

这个顺序保持不变。

Safari subscription 应该现在通过本地 validator，然后正常：

```ts
await api.put("/api/web-push/subscriptions", sub.toJSON());
```

不要为 Safari 写特殊 subscription payload。

Safari 使用的仍然是标准：

```ts
{
  endpoint,
  keys: {
    p256dh,
    auth
  }
}
```

现有 VAPID public/private key 也继续使用，不需要 Apple 专用 key。

Apple 明确说明这是标准 Web Push，而且**不需要加入 Apple Developer Program**。([WebKit][1])

---

# 5. 不要做 browser detection 来决定是否支持

核心能力判断继续使用：

```ts
"serviceWorker" in navigator &&
"PushManager" in window &&
"Notification" in window
```

不要这样：

```ts
if (isSafari) ...
if (isChrome) ...
```

Apple 自己也建议标准 Web Push 应该通过 feature detection，而不是排除 Safari 的 browser detection。([WebKit][2])

换句话说：

```text
Chrome → 标准 Push API
Safari → 标准 Push API
未来 Firefox → 也是标准 Push API
```

provider 差异只应该体现在 **服务器安全 endpoint allowlist**。

---

# 6. macOS Safari

目标至少覆盖：

```text
Safari 16.1+
macOS Ventura+
```

Safari 在 macOS 上不要求安装 PWA。

普通网页：

```text
打开 relay-web
→ Settings
→ Desktop Notifications
→ 点击 Enable
→ Safari permission prompt
→ PushManager.subscribe()
→ *.push.apple.com endpoint
→ Hub 保存
→ task-completion
→ Apple Push Service
→ Safari/macOS notification
```

Safari 甚至没有运行时，也可以由系统投递 Web Push。([WebKit][2])

---

# 7. iPhone / iPad

这里必须明确处理产品语义。

iOS/iPadOS Web Push 的经典要求是：

```text
iOS/iPadOS 16.4+
+
网站添加到 Home Screen
+
以 Home Screen Web App 打开
+
用户主动点击 Enable
```

Apple 明确要求 notification permission 必须由用户操作触发，例如点击订阅按钮。([WebKit][1])

现有 Settings 中用户主动点击 Enable 已经满足 user gesture 要求。

## PWA manifest

现有 xacpx 已经有：

```ts
manifest: {
  name: "XACPX HUB",
  short_name: "XACPX",
  display: "standalone",
  start_url: "/",
  scope: "/",
  ...
}
```

所以 PWA 基础已经满足，不需要重新搭 PWA。

Apple 对 iOS Home Screen Web App 的 Web Push 支持就是建立在这套标准能力上的。([WebKit][1])

---

# 8. Settings UX

建议顺便补 Safari/iOS 用户提示，但**不要让 UI browser detection 成为能力安全判断**。

例如增加一个说明：

中文：

```text
iPhone/iPad 需要先将 XACPX 添加到主屏幕，并从主屏幕打开后才能启用通知。
```

英文：

```text
On iPhone and iPad, add XACPX to the Home Screen and open it from there before enabling notifications.
```

可以一直作为辅助文本显示，不必精准检测 Safari。

或者，仅为了 UX 使用 iOS detection 显示这句也可以，但：

```text
UA detection only controls hint text
```

不能控制：

```text
pushSupported()
endpoint validation
subscription behavior
```

---

# 9. Service Worker

当前：

```text
packages/relay-web/public/push-sw.js
```

逻辑本身是标准 API：

```js
self.addEventListener("push", ...)
self.registration.showNotification(...)
self.addEventListener("notificationclick", ...)
```

没有 Chrome 专用 API，所以**不要为了 Safari 重写 Service Worker**。

现有：

```js
showNotification(title, {
  body,
  tag,
  icon,
  data
})
```

以及：

```js
clients.matchAll()
client.focus()
clients.openWindow()
```

应继续保留。

Safari 可能忽略部分 notification presentation option，例如某些 icon/tag 表现，但这不应该影响基础 Push 支持。

本 PR 不需要引入 Apple 2025 年新增的 Declarative Web Push。现有 Service Worker Web Push 在当前 Safari/iOS 上仍然是兼容路径；Declarative Web Push 属于未来优化，不是此 PR 的必要条件。([WebKit][3])

---

# 10. 单元测试：安全矩阵

这是本次最重要的自动化测试。

前端和 Hub 的 `isAllowedPushEndpoint()` 都必须覆盖完全一致的 corpus。

### Accept

```ts
[
  "https://fcm.googleapis.com/fcm/send/abc",
  "https://fcm.notifications.google.com/fcm/send/abc",

  "https://web.push.apple.com/Q...",
  "https://foo.push.apple.com/abc",
  "https://foo.bar.push.apple.com/abc",
  "https://web.push.apple.com:443/abc",
]
```

全部：

```ts
expect(isAllowedPushEndpoint(endpoint)).toBe(true)
```

### Reject：SSRF

```ts
[
  "http://web.push.apple.com/abc",
  "https://web.push.apple.com:8443/abc",

  "https://push.apple.com.evil.com/abc",
  "https://evilpush.apple.com/abc",
  "https://push.apple.com@evil.com/abc",

  "https://evil.com/push.apple.com",
  "https://127.0.0.1/",
  "https://localhost/",
  "https://169.254.169.254/",
  "https://10.0.0.1/",
  "https://example.com/",
  "not-a-url",
]
```

全部 reject。

再单独加：

```ts
expect(
  isAllowedPushEndpoint(
    "https://foo.push.apple.com.evil.example/path"
  )
).toBe(false);
```

这是防止错误 suffix matcher 的关键回归测试。

---

# 11. relay-web subscription 测试

现有 `web-push` tests 增加真实 Safari-like subscription。

模拟：

```ts
const safariSub = {
  endpoint: "https://web.push.apple.com/Q-xxxxx",
  options: {
    applicationServerKey: ...
  },
  toJSON() {
    return {
      endpoint: this.endpoint,
      keys: {
        p256dh: "...",
        auth: "..."
      }
    };
  }
};
```

验证：

```text
Notification.permission = granted
PushManager.subscribe() -> Safari endpoint
```

结果必须：

```text
不调用 unsubscribe()
PUT /api/web-push/subscriptions
成功
```

关键断言：

```ts
expect(unsubscribe).not.toHaveBeenCalled();
expect(put).toHaveBeenCalledWith(
  "/api/web-push/subscriptions",
  expect.objectContaining({
    endpoint: expect.stringContaining(".push.apple.com"),
  }),
);
```

同时保留：

```text
arbitrary HTTPS endpoint
→ unsubscribe
→ push-endpoint-unsupported
→ no PUT
```

确保 Safari 支持没有破坏 SSRF fail-closed。

---

# 12. Hub API 测试

对：

```text
PUT /api/web-push/subscriptions
```

增加 Safari endpoint。

合法：

```json
{
  "endpoint": "https://web.push.apple.com/...",
  "keys": {
    "p256dh": "<valid key>",
    "auth": "<valid auth>"
  }
}
```

预期：

```text
200
subscription stored
```

恶意：

```text
https://web.push.apple.com.attacker.example/...
```

预期：

```text
400
not stored
```

同时：

```text
https://attacker.example/...
```

必须继续 400。

---

# 13. PushNotifier 测试

增加一条 provider-neutral test。

数据库里放：

```text
Chrome FCM subscription
Safari Apple subscription
```

同一账号收到：

```text
task-completion
```

断言 notifier fan-out 对两个 subscription 都调用：

```ts
sendNotification(...)
```

不要根据 endpoint provider 写不同发送逻辑。

理想结构：

```text
Hub
 ├─ FCM endpoint       → web-push.sendNotification()
 └─ Apple endpoint     → web-push.sendNotification()
```

`web-push` library 负责标准协议发送。

如果 Apple endpoint 返回：

```text
404 / 410
```

现有 stale subscription cleanup 同样应该删除 Apple subscription。

这个行为也补一条 Safari endpoint 测试。

---

# 14. Auth ownership lifecycle 必须继续 provider-neutral

#305 最复杂的安全逻辑不能因为 Safari support 被绕开。

以下全部必须继续适用于 Safari endpoint：

```text
login ownership transfer
logout release
fetchMe same-account reconcile
VAPID rotation
destroyProven()
```

尤其检查：

```ts
transferSubscriptionOwnership()
```

不要有这种 Chrome-only 分支：

```ts
if (!isFcm(sub.endpoint)) destroy...
```

扩展 `isAllowedPushEndpoint()` 后 Safari subscription 应与 FCM subscription 走完全相同的 ownership contract。

建议至少增加一条：

```text
existing Safari PushSubscription
→ login new account
→ matching VAPID
→ PUT succeeds
→ no unsubscribe
```

和：

```text
Safari subscription
→ logout
→ Hub DELETE
→ local unsubscribe
```

---

# 15. VAPID rotation

Safari 必须复用现有逻辑。

场景：

```text
Safari subscription 使用 VAPID key A
Hub 改成 key B
```

应该：

```text
subscriptionMatchesKey() == false
→ destroy old subscription
→ subscribe(applicationServerKey=B)
→ Apple 返回新 endpoint
→ PUT Hub
```

不要为 Apple 创建独立 VAPID key。

也不要：

```text
Chrome key
Safari key
```

一套 Hub VAPID keypair 就够。

---

# 16. notificationclick 手工验收

macOS Safari：

```text
1. 打开 XACPX
2. 开启通知
3. 关闭 tab
4. 触发 task-completion
5. 收到 macOS 通知
6. 点击
7. XACPX 打开到 /
```

还要测试已有 XACPX 窗口：

```text
收到通知
→ click
→ existing window focus
```

iPhone/iPad：

```text
1. Safari 打开 XACPX
2. Add to Home Screen
3. 从 Home Screen 打开 XACPX
4. 登录
5. Settings → Desktop Notifications → Enable
6. Allow
7. 完全关闭/切后台 Web App
8. 从另一个 agent 触发 task-completion
9. Lock Screen / Notification Center 收到通知
10. 点击通知
11. XACPX Home Screen Web App 打开
```

Apple 明确说明 iOS/iPadOS Web Push 通知可以显示在 Lock Screen、Notification Center，并集成 Focus。([WebKit][1])

---

# 17. HTTPS 是硬要求

实际部署测试必须使用：

```text
https://relay.example.com
```

不要拿：

```text
http://LAN-IP:8787
```

判断 Safari Web Push 是否正常。

Service Worker / Push 都依赖 secure context。

localhost 只适合开发环境特殊规则，不是部署验收条件。

---

# 18. 不需要的东西

这次明确 **不要**：

```text
Apple Developer Program
APNs certificate
.p8 APNs key
Bundle ID
native iOS app
Safari Push Package
Website Push ID
Apple proprietary legacy Safari Push
```

这是标准 W3C Web Push。

Apple 官方明确说 Safari 标准 Web Push 不需要 Apple Developer Program。([WebKit][1])

也不要引入：

```text
Firebase SDK
Apple SDK
browser-specific push client
```

---

# 19. 建议改动文件

主要：

```text
packages/relay/src/push.ts

packages/relay-web/src/lib/web-push.ts

packages/relay-web/src/views/SettingsView.vue
```

测试按仓库现有位置补：

```text
tests/unit/packages/relay/...
packages/relay-web/src/__tests__/...
```

如当前 endpoint validator tests 已存在，直接扩充，不要新建重复测试体系。

文档：

```text
docs/relay-module.md
```

把：

```text
Chrome desktop notifications
```

改成：

```text
standards-based Web Push:
- Chrome/Chromium
- Safari on macOS
- Home Screen web apps on iOS/iPadOS
```

同时记录：

```text
Hub outbound network must allow:
- fcm.googleapis.com
- fcm.notifications.google.com
- *.push.apple.com
```

Apple 特别提醒如果服务器管理 outbound endpoints，需要允许 `*.push.apple.com`。([WebKit][1])

---

# 20. PR 验收 Gate

这个 PR 在以下全部满足之前不要合并：

1. Chrome Web Push 现有测试全部不变通过。
2. Hub 和 relay-web 都接受 `*.push.apple.com`。
3. 两边都继续拒绝 arbitrary HTTPS。
4. `evil.push.apple.com.example.com` 必须 reject。
5. Safari-like subscription 能完成 PUT。
6. Safari-like subscription 能进入 `PushNotifier.sendNotification()`。
7. Apple endpoint 404/410 能清理数据库 subscription。
8. login/logout/fetchMe ownership lifecycle 对 Safari subscription 不退化。
9. VAPID rotation 对 Safari subscription 正常。
10. relay 全量测试通过。
11. relay-web 全量 Vitest 通过。
12. TypeScript typecheck 通过。
13. build 通过。
14. Chrome E2E 不回归。
15. 至少完成一次真实 macOS Safari 手工端到端。
16. 最好再完成一次真实 iOS/iPadOS Home Screen Web App 端到端。

---

## 实现原则

最终架构应该保持：

```text
                    PushSubscription
                           │
              ┌────────────┴────────────┐
              │                         │
          Chrome                    Safari
              │                         │
             FCM                       APNs
              │                         │
 fcm.googleapis.com        *.push.apple.com
              │                         │
              └────────────┬────────────┘
                           │
                standards-based Web Push
                           │
                     web-push library
                           │
                       XACPX Hub
```

**provider 只影响 endpoint allowlist，不影响业务逻辑。**

也就是说，不要在 notifier、auth lifecycle、subscription storage 里逐渐长出：

```ts
if (chrome) ...
else if (safari) ...
```

正确方向是：

```ts
valid standard PushSubscription
→ same storage
→ same ownership model
→ same VAPID
→ same notifier
```

这会让后面加 Firefox/Mozilla Push 时也只需要安全地扩展 endpoint provider，而不用再改一遍整个架构。

[1]: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/?utm_source=chatgpt.com "Web Push for Web Apps on iOS and iPadOS | WebKit"
[2]: https://webkit.org/blog/13399/webkit-features-in-safari-16-1/?utm_source=chatgpt.com "WebKit Features in Safari 16.1 | WebKit"
[3]: https://webkit.org/blog/16535/meet-declarative-web-push/?utm_source=chatgpt.com "Meet Declarative Web Push | WebKit"
