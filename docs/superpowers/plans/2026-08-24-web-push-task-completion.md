# Web Push 任务完成桌面通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实例产生 `task-completion` notice 时，经 Web Push 向已订阅的 Chrome 桌面弹系统通知（标签页关闭也能收到），点击回到看板。

**Architecture:** hub 侧新增 `push_subscriptions` 表 + `web-push` 发送器，挂在 server.ts 现有 `MSG.instanceNotice` 广播分支；web 侧经 `workbox.importScripts` 注入自包含 push SW，SettingsView 提供订阅开关，main.ts 启动对账。Spec: `docs/superpowers/specs/2026-08-24-web-push-task-completion-design.md`。

**Tech Stack:** Hono (relay http)、SQLite (SqlDriver)、`web-push` (npm)、vite-plugin-pwa workbox importScripts、vue-i18n。

## Global Constraints

- 只对 `notice.kind === "task-completion"` 推送（范围 A）；`task-progress` / `coordinator-message` 仅 WS 广播。
- VAPID 未配置时推送功能整体禁用（log warn），所有现有路径零行为变化。
- 推送 TTL = 3600；body 截断 200 字符；payload = `{title, body, instanceId, url:"/"}`。
- 推送失败：410/404 → 删该订阅行；其他错误只 warn，不重试，不阻塞 broadcast/持久化。
- 新路由全部在 `/api/*` 鉴权网关之后注册；PUT/DELETE 走 `requireJson`（同现有 CSRF 门）。
- db.ts 是 create-only schema + 幂等 ALTER 惯例；FK 保持 OFF（代码库不变量）。
- relay 测试用 `bun:test`（tests/unit/packages/relay/）；relay-web 测试用 vitest（二进制在 repo 根 `node_modules/.bin/`，从 packages/relay-web 目录跑）。
- 每个任务独立可测、独立 commit；禁止跑全量测试套件以外的项目级命令（typecheck 除外，见 Task 8）。

---

### Task 1: relay — push_subscriptions 表 + PushSubscriptionStore

**Files:**
- Modify: `packages/relay/src/db.ts`（initSchema 内新增表）
- Create: `packages/relay/src/stores/push-subscriptions.ts`
- Test: `tests/unit/packages/relay/stores-push-subscriptions.test.ts`

**Interfaces:**
- Consumes: `SqlDriver`（packages/relay/src/db.ts）
- Produces:
  ```ts
  export interface PushSubscriptionRow {
    accountId: string; endpoint: string; p256dh: string; auth: string; createdAt: string;
  }
  export class PushSubscriptionStore {
    constructor(db: SqlDriver, options?: { now?: () => Date });
    upsert(input: { accountId: string; endpoint: string; p256dh: string; auth: string }): void;
    listByAccount(accountId: string): PushSubscriptionRow[];
    deleteByEndpoint(endpoint: string): boolean;
    deleteByEndpointAndAccount(accountId: string, endpoint: string): boolean;
    deleteByAccount(accountId: string): number;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/packages/relay/stores-push-subscriptions.test.ts
import { expect, test } from "bun:test";
import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { PushSubscriptionStore } from "../../../../packages/relay/src/stores/push-subscriptions";

async function makeStore() {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  return { db, store: new PushSubscriptionStore(db) };
}

test("upsert is idempotent per endpoint and re-binds to the latest account", () => {
  // same store sync usage below
});

test("listByAccount returns only that account's rows", () => {});

test("deleteByEndpoint removes regardless of account; deleteByEndpointAndAccount is scoped", () => {});

test("deleteByAccount cascades for account removal", () => {});
```

把四个空测试补全为（真实断言）：

```ts
import { expect, test } from "bun:test";
import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { PushSubscriptionStore } from "../../../../packages/relay/src/stores/push-subscriptions";

async function makeStore() {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  return { db, store: new PushSubscriptionStore(db) };
}

const sub = (endpoint: string) => ({ endpoint, p256dh: "p256dh-" + endpoint, auth: "auth-" + endpoint });

test("upsert is idempotent per endpoint and re-binds to the latest account", async () => {
  const { store } = await makeStore();
  store.upsert({ accountId: "a1", ...sub("https://push.example/e1") });
  store.upsert({ accountId: "a1", ...sub("https://push.example/e1") }); // duplicate
  store.upsert({ accountId: "a2", ...sub("https://push.example/e1") }); // re-bind
  expect(store.listByAccount("a1")).toHaveLength(0);
  expect(store.listByAccount("a2")).toHaveLength(1);
});

test("listByAccount returns only that account's rows", async () => {
  const { store } = await makeStore();
  store.upsert({ accountId: "a1", ...sub("https://push.example/e1") });
  store.upsert({ accountId: "a1", ...sub("https://push.example/e2") });
  store.upsert({ accountId: "a2", ...sub("https://push.example/e3") });
  const rows = store.listByAccount("a1");
  expect(rows.map((r) => r.endpoint).sort()).toEqual(["https://push.example/e1", "https://push.example/e2"]);
  expect(rows[0]).toMatchObject({ accountId: "a1", p256dh: "p256dh-https://push.example/e1" });
});

test("deleteByEndpoint removes regardless of account; deleteByEndpointAndAccount is scoped", async () => {
  const { store } = await makeStore();
  store.upsert({ accountId: "a1", ...sub("https://push.example/e1") });
  expect(store.deleteByEndpointAndAccount("a2", "https://push.example/e1")).toBe(false); // wrong account: no-op
  expect(store.listByAccount("a1")).toHaveLength(1);
  expect(store.deleteByEndpointAndAccount("a1", "https://push.example/e1")).toBe(true);
  store.upsert({ accountId: "a1", ...sub("https://push.example/e2") });
  expect(store.deleteByEndpoint("https://push.example/e2")).toBe(true);
  expect(store.deleteByEndpoint("https://push.example/e2")).toBe(false); // already gone
});

test("deleteByAccount cascades for account removal", async () => {
  const { store } = await makeStore();
  store.upsert({ accountId: "a1", ...sub("https://push.example/e1") });
  store.upsert({ accountId: "a1", ...sub("https://push.example/e2") });
  store.upsert({ accountId: "a2", ...sub("https://push.example/e3") });
  expect(store.deleteByAccount("a1")).toBe(2);
  expect(store.listByAccount("a1")).toHaveLength(0);
  expect(store.listByAccount("a2")).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/packages/relay/stores-push-subscriptions.test.ts`
Expected: FAIL（模块不存在 / 表不存在）

- [ ] **Step 3: Implement**

`packages/relay/src/db.ts` — initSchema 的 CREATE 块（`pending_completion_routes` 之后、`);` 之前）追加：

```sql
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      account_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, endpoint)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions (endpoint);
```

`packages/relay/src/stores/push-subscriptions.ts`：

```ts
import type { SqlDriver } from "../db.js";

export interface PushSubscriptionRow {
  accountId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
}

interface PushSubscriptionStoreOptions {
  now?: () => Date;
}

const BATCH_LIMIT = 100;

/** Browser push subscriptions per account. FKs are OFF by codebase invariant —
 *  account deletion cascades via deleteByAccount from the account removal path. */
export class PushSubscriptionStore {
  private readonly now: () => Date;

  constructor(private readonly db: SqlDriver, options: PushSubscriptionStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** Idempotent per endpoint: the unique index on endpoint makes this a re-bind
   *  when the same browser re-subscribes under a different account. */
  upsert(input: { accountId: string; endpoint: string; p256dh: string; auth: string }): void {
    this.db.run(
      `INSERT INTO push_subscriptions (account_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         account_id = excluded.account_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth`,
      [input.accountId, input.endpoint, input.p256dh, input.auth, this.now().toISOString()],
    );
  }

  listByAccount(accountId: string): PushSubscriptionRow[] {
    const rows: PushSubscriptionRow[] = [];
    do {
      const batch = this.db.all<{
        account_id: string; endpoint: string; p256dh: string; auth: string; created_at: string;
      }>(
        "SELECT account_id, endpoint, p256dh, auth, created_at FROM push_subscriptions WHERE account_id = ? LIMIT ? OFFSET ?",
        [accountId, BATCH_LIMIT, rows.length],
      );
      rows.push(...batch.map((r) => ({
        accountId: r.account_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, createdAt: r.created_at,
      })));
      if (batch.length < BATCH_LIMIT) break;
    } while (true);
    return rows;
  }

  deleteByEndpoint(endpoint: string): boolean {
    return this.db.changes !== undefined && this.db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]) as never as boolean; // placeholder — see real impl below
  }

  deleteByEndpointAndAccount(accountId: string, endpoint: string): boolean {
    this.db.run("DELETE FROM push_subscriptions WHERE account_id = ? AND endpoint = ?", [accountId, endpoint]);
    return true;
  }

  deleteByAccount(accountId: string): number {
    this.db.run("DELETE FROM push_subscriptions WHERE account_id = ?", [accountId]);
    return 0;
  }
}
```

**注意（实现者照此修正，上面是刻意标注的坏例）：** `SqlDriver.run` 返回 void，删除数需先 `SELECT COUNT`。真实实现：

```ts
  deleteByEndpoint(endpoint: string): boolean {
    const existed = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
    this.db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
    return (existed?.n ?? 0) > 0;
  }

  deleteByEndpointAndAccount(accountId: string, endpoint: string): boolean {
    const existed = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM push_subscriptions WHERE account_id = ? AND endpoint = ?", [accountId, endpoint]);
    this.db.run("DELETE FROM push_subscriptions WHERE account_id = ? AND endpoint = ?", [accountId, endpoint]);
    return (existed?.n ?? 0) > 0;
  }

  deleteByAccount(accountId: string): number {
    const counted = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions WHERE account_id = ?", [accountId])?.n ?? 0;
    this.db.run("DELETE FROM push_subscriptions WHERE account_id = ?", [accountId]);
    return counted;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/packages/relay/stores-push-subscriptions.test.ts`
Expected: 4 pass

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/db.ts packages/relay/src/stores/push-subscriptions.ts tests/unit/packages/relay/stores-push-subscriptions.test.ts
git commit -m "feat(relay): push_subscriptions store for web push subscriptions"
```

---

### Task 2: relay — PushNotifier（web-push 封装 + 410 清理）

**Files:**
- Create: `packages/relay/src/push.ts`
- Test: `tests/unit/packages/relay/push-notifier.test.ts`
- 依赖安装：`cd packages/relay && bun add web-push` + `bun add -d @types/web-push`（workspace 根安装）

**Interfaces:**
- Consumes: `PushSubscriptionStore`（Task 1）
- Produces:
  ```ts
  export interface VapidConfig { subject: string; publicKey: string; privateKey: string; }
  export function vapidFromEnv(env: Record<string, string | undefined>): VapidConfig | null;
  export const PUSH_TTL_MS = 3600;
  export class PushNotifier {
    constructor(deps: { config: VapidConfig | null; subscriptions: PushSubscriptionStore; logger?: RelayLogger });
    sendTaskCompletion(accountId: string, instanceName: string, text: string): Promise<void>;
  }
  ```
  `webpush` 的引用须经可注入 seam：模块导出 `sendNotification` 用 `webpush.sendNotification`，测试用 `vi`/mock 置换模块级 `webpush` —— bun:test 用 `(push as any)._setWebPushForTests(fake)` 注入。

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/packages/relay/push-notifier.test.ts
import { expect, test } from "bun:test";
import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { PushSubscriptionStore } from "../../../../packages/relay/src/stores/push-subscriptions";
import { PushNotifier, vapidFromEnv, PUSH_TTL_MS } from "../../../../packages/relay/src/push";

type SentCall = { endpoint: string; payload: string; ttl: number };

function makeFakeWebPush(sent: SentCall[], nextStatus?: { statusCode: number }) {
  return {
    setVapidDetails: () => {},
    sendNotification: async (sub: { endpoint: string }, payload: string, opts: { TTL: number }) => {
      sent.push({ endpoint: sub.endpoint, payload, ttl: opts.TTL });
      if (nextStatus) {
        const err = new Error("gone") as Error & { statusCode: number };
        err.statusCode = nextStatus.statusCode;
        throw err;
      }
    },
  };
}

async function makeNotifier(sent: SentCall[], nextStatus?: { statusCode: number }) {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const subscriptions = new PushSubscriptionStore(db);
  const notifier = new PushNotifier({ config: { subject: "s", publicKey: "pk", privateKey: "sk" }, subscriptions });
  (notifier as unknown as { _setWebPushForTests(w: unknown): void })._setWebPushForTests(makeFakeWebPush(sent, nextStatus));
  return { notifier, subscriptions };
}

test("vapidFromEnv requires all three vars; partial → null", () => {
  expect(vapidFromEnv({ XACPX_RELAY_VAPID_SUBJECT: "s", XACPX_RELAY_VAPID_PUBLIC_KEY: "pk", XACPX_RELAY_VAPID_PRIVATE_KEY: "sk" }))
    .toEqual({ subject: "s", publicKey: "pk", privateKey: "sk" });
  expect(vapidFromEnv({ XACPX_RELAY_VAPID_PUBLIC_KEY: "pk" })).toBeNull();
  expect(vapidFromEnv({})).toBeNull();
});

test("sendTaskCompletion pushes to every account subscription with capped body + TTL", async () => {
  const sent: SentCall[] = [];
  const { notifier, subscriptions } = await makeNotifier(sent);
  subscriptions.upsert({ accountId: "a1", endpoint: "https://push/e1", p256dh: "k1", auth: "a1" });
  subscriptions.upsert({ accountId: "a1", endpoint: "https://push/e2", p256dh: "k2", auth: "a2" });
  subscriptions.upsert({ accountId: "a2", endpoint: "https://push/e3", p256dh: "k3", auth: "a3" });
  await notifier.sendTaskCompletion("a1", "home-pc", "x".repeat(500));
  expect(sent).toHaveLength(2);
  expect(sent[0]!.ttl).toBe(PUSH_TTL_MS);
  const body = JSON.parse(sent[0]!.payload);
  expect(body).toEqual({ title: "home-pc", body: "x".repeat(200), instanceId: undefined, url: "/" });
  // ^ sendTaskCompletion 的第四参 instanceId 可选；本测试不传
});

test("410 cleans up the subscription row; other errors keep it", async () => {
  const sent: SentCall[] = [];
  const { notifier, subscriptions } = await makeNotifier(sent, { statusCode: 410 });
  subscriptions.upsert({ accountId: "a1", endpoint: "https://push/e1", p256dh: "k1", auth: "a1" });
  await notifier.sendTaskCompletion("a1", "home-pc", "done");
  expect(subscriptions.listByAccount("a1")).toHaveLength(0);
});

test("no config → no-op, no subscriptions touched", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const subscriptions = new PushSubscriptionStore(db);
  subscriptions.upsert({ accountId: "a1", endpoint: "https://push/e1", p256dh: "k1", auth: "a1" });
  const notifier = new PushNotifier({ config: null, subscriptions });
  await notifier.sendTaskCompletion("a1", "home-pc", "done"); // must not throw
  expect(subscriptions.listByAccount("a1")).toHaveLength(1);
});
```

**注意：** `sendTaskCompletion(accountId, instanceName, text)` 的实例名参数即 title；`instanceId` 进 payload 需要 hub 侧调用时传入——统一签名为 `sendTaskCompletion(accountId: string, notice: { instanceId: string; instanceName: string; text: string })`，测试里 body 断言相应改为 `expect(body).toEqual({ title: "home-pc", body: "x".repeat(200), instanceId: "i1", url: "/" })` 并传 `{ instanceId: "i1", instanceName: "home-pc", text: "x".repeat(500) }`。以这个签名实现。

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/packages/relay/push-notifier.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Implement**

```ts
// packages/relay/src/push.ts
import webpush from "web-push";
import type { PushSubscriptionStore } from "./stores/push-subscriptions.js";
import type { RelayLogger } from "./logging.js";

export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export const PUSH_TTL_MS = 3600;
const BODY_CAP = 200;
/** Push services answer gone with 404 or 410 — both mean "delete the row". */
const GONE_STATUS = new Set([404, 410]);

export function vapidFromEnv(env: Record<string, string | undefined>): VapidConfig | null {
  const subject = env.XACPX_RELAY_VAPID_SUBJECT;
  const publicKey = env.XACPX_RELAY_VAPID_PUBLIC_KEY;
  const privateKey = env.XACPX_RELAY_VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) return null;
  return { subject, publicKey, privateKey };
}

type WebPushLike = {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: { TTL: number },
  ): Promise<unknown>;
};

export class PushNotifier {
  private wp: WebPushLike = webpush as unknown as WebPushLike;
  private detailsSet = false;

  constructor(private readonly deps: {
    config: VapidConfig | null;
    subscriptions: PushSubscriptionStore;
    logger?: RelayLogger;
  }) {}

  /** Test seam: swap the web-push binding. */
  _setWebPushForTests(wp: WebPushLike): void {
    this.wp = wp;
    this.detailsSet = false;
  }

  private ensureDetails(): boolean {
    if (!this.deps.config) return false;
    if (!this.detailsSet) {
      this.wp.setVapidDetails(this.deps.config.subject, this.deps.config.publicKey, this.deps.config.privateKey);
      this.detailsSet = true;
    }
    return true;
  }

  /** Fan out a task-completion notification to every subscription of the account.
   *  Never throws: push failures must not affect the WS broadcast/persist path. */
  async sendTaskCompletion(accountId: string, notice: { instanceId: string; instanceName: string; text: string }): Promise<void> {
    if (!this.ensureDetails()) return;
    const payload = JSON.stringify({
      title: notice.instanceName,
      body: notice.text.slice(0, BODY_CAP),
      instanceId: notice.instanceId,
      url: "/",
    });
    for (const sub of this.deps.subscriptions.listByAccount(accountId)) {
      try {
        await this.wp.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: PUSH_TTL_MS },
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: unknown }).statusCode;
        if (typeof statusCode === "number" && GONE_STATUS.has(statusCode)) {
          this.deps.subscriptions.deleteByEndpoint(sub.endpoint);
        } else {
          this.deps.logger?.warn("relay.push.send_failed", "web push delivery failed", {
            endpointHost: safeHost(sub.endpoint),
            statusCode: typeof statusCode === "number" ? statusCode : undefined,
          });
        }
      }
    }
  }
}

/** Log only the push endpoint's host — the full URL is a bearer-ish secret. */
function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unparseable";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/packages/relay/push-notifier.test.ts`
Expected: 4 pass

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/push.ts tests/unit/packages/relay/push-notifier.test.ts package.json bun.lock
git commit -m "feat(relay): PushNotifier web-push sender with gone-subscription cleanup"
```

---

### Task 3: relay — HTTP 路由（vapid key + 订阅 upsert/delete）

**Files:**
- Modify: `packages/relay/src/http/app.ts`（AppDeps + 三个路由）
- Test: `tests/unit/packages/relay/http-app.test.ts`（追加测试；复用该文件现有 `makeApp` helper，需给它加可选 `vapidPublicKey` / `pushSubscriptions` 注入）

**Interfaces:**
- Consumes: `PushSubscriptionStore`（Task 1）、`VapidConfig.publicKey`（Task 2）
- Produces（AppDeps 新增可选字段）:
  ```ts
  /** 当前 VAPID public key；null/未提供 = hub 未配置推送。 */
  vapidPublicKey?: () => string | null;
  pushSubscriptions?: PushSubscriptionStore;
  ```
  路由行为：
  - `GET /api/web-push/vapid-public-key` → `{publicKey: string|null}`（未注入时 `{publicKey:null}`）
  - `PUT /api/web-push/subscriptions` → body `{endpoint, keys:{p256dh, auth}}`；校验失败 400 `invalid-payload`；成功 `{ok:true}`（幂等 upsert，按 cookie 账号）
  - `DELETE /api/web-push/subscriptions` → body `{endpoint}`；成功 `{ok:true}`（不存在也 ok）

- [ ] **Step 1: Write the failing tests（追加到 http-app.test.ts）**

```ts
import { PushSubscriptionStore } from "../../../../packages/relay/src/stores/push-subscriptions";

test("web-push routes: unauthenticated 401; missing JSON body 415", async () => {
  const { app } = await makeApp();
  const unauth = await app.request("/api/web-push/vapid-public-key");
  expect(unauth.status).toBe(401);
  const { cookie } = await (await makeApp()).login(((await makeApp()).loginToken));
  // simpler: use one makeApp instance — see actual test below
});
```

实现者按现有 makeApp 模式写成（一个实例）：

```ts
test("web-push: vapid key endpoint reflects config; subscriptions require auth + JSON", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const admin = accounts.createAccount("admin");
  const { token } = accounts.createLoginToken(admin.id, "t");
  const pushSubscriptions = new PushSubscriptionStore(db);
  const app = createApp({
    accounts, instances: new InstanceStore(db), gateway: { isOnline: () => true, sendRequest: async () => ({}) },
    messages: new MessageStore(db),
    vapidPublicKey: () => "PK",
    pushSubscriptions,
  });
  const res = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;

  const key = await app.request("/api/web-push/vapid-public-key", { headers: { cookie } });
  expect(await key.json()).toEqual({ publicKey: "PK" });

  const unauth = await app.request("/api/web-push/vapid-public-key");
  expect(unauth.status).toBe(401);

  const noJson = await app.request("/api/web-push/subscriptions", { method: "PUT", headers: { cookie }, body: "x" });
  expect(noJson.status).toBe(415);

  const bad = await app.request("/api/web-push/subscriptions", {
    method: "PUT", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "http://insecure", keys: {} }),
  });
  expect(bad.status).toBe(400);

  const ok = await app.request("/api/web-push/subscriptions", {
    method: "PUT", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "https://push/e1", keys: { p256dh: "k", auth: "a" } }),
  });
  expect(ok.status).toBe(200);
  expect(pushSubscriptions.listByAccount(admin.id)).toHaveLength(1);

  const del = await app.request("/api/web-push/subscriptions", {
    method: "DELETE", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ endpoint: "https://push/e1" }),
  });
  expect(del.status).toBe(200);
  expect(pushSubscriptions.listByAccount(admin.id)).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/packages/relay/http-app.test.ts`
Expected: 新测试 FAIL（路由 404）

- [ ] **Step 3: Implement（app.ts）**

AppDeps 增加两字段（注释如 Interfaces），在 `app.get("/api/version", ...)` 之后注册：

```ts
  app.get("/api/web-push/vapid-public-key", (c) => {
    return c.json({ publicKey: deps.vapidPublicKey ? deps.vapidPublicKey() : null });
  });

  app.put("/api/web-push/subscriptions", async (c) => {
    if (!requireJson(c.req.header("content-type"))) return c.json({ error: "unsupported-media-type" }, 415);
    if (!deps.pushSubscriptions) return c.json({ error: "push-disabled" }, 503);
    const account = c.get("account");
    const body = (await c.req.json().catch(() => ({}))) as {
      endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown };
    };
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
    const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
    let httpsEndpoint = false;
    try { httpsEndpoint = new URL(endpoint).protocol === "https:"; } catch { /* invalid */ }
    if (!httpsEndpoint || !p256dh || !auth || endpoint.length > 2048 || p256dh.length > 512 || auth.length > 512) {
      return c.json({ error: "invalid-payload" }, 400);
    }
    deps.pushSubscriptions.upsert({ accountId: account.id, endpoint, p256dh, auth });
    return c.json({ ok: true });
  });

  app.delete("/api/web-push/subscriptions", async (c) => {
    if (!requireJson(c.req.header("content-type"))) return c.json({ error: "unsupported-media-type" }, 415);
    if (!deps.pushSubscriptions) return c.json({ error: "push-disabled" }, 503);
    const account = c.get("account");
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    if (!endpoint || endpoint.length > 2048) return c.json({ error: "invalid-payload" }, 400);
    deps.pushSubscriptions.deleteByEndpointAndAccount(account.id, endpoint);
    return c.json({ ok: true });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/packages/relay/http-app.test.ts`
Expected: 全部 pass（含既有）

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/http/app.ts tests/unit/packages/relay/http-app.test.ts
git commit -m "feat(relay): web-push subscription HTTP routes"
```

---

### Task 4: relay — server.ts fan-out 接线 + CLI（push-keys generate / start flags）

**Files:**
- Modify: `packages/relay/src/server.ts`（CreateRuntimeOptions + StartRelayOptions 加 `vapid?: VapidConfig | null`；notice 分支 fan-out；AppDeps 传 vapidPublicKey/pushSubscriptions；账号删除级联——`rm token` 路径若在 cli.ts 调 accounts 删除则补 `pushSubscriptions.deleteByAccount`）
- Modify: `packages/relay/src/cli.ts`（USAGE + `push-keys generate` 子命令 + start 解析 `--vapid-subject/--vapid-public-key/--vapid-private-key`，缺省回落 env）
- Test: `tests/unit/packages/relay/runtime-fanout.test.ts`（追加）、`tests/unit/packages/relay/cli.test.ts`（追加 parse 用例）

**Interfaces:**
- Consumes: `PushNotifier`、`vapidFromEnv`（Task 2）、`PushSubscriptionStore`（Task 1）
- Produces: `CreateRuntimeOptions.vapid?: VapidConfig | null`；`startRelayServer` 同名透传；`parseStartOptions` 返回值含 `vapidSubject/vapidPublicKey/vapidPrivateKey?: string`

- [ ] **Step 1: Write the failing tests**

cli.test.ts 追加（import 已有 parseStartOptions）：

```ts
test("parseStartOptions reads vapid flags", () => {
  const o = parseStartOptions(["start", "--vapid-subject", "mailto:a@b.c", "--vapid-public-key", "PK", "--vapid-private-key", "SK"]);
  expect(o).toMatchObject({ vapidSubject: "mailto:a@b.c", vapidPublicKey: "PK", vapidPrivateKey: "SK" });
});

test("parseStartOptions omits vapid when flags absent", () => {
  expect(parseStartOptions(["start"]).vapidSubject).toBeUndefined();
});
```

runtime-fanout.test.ts 追加（复用该文件现有 runtime + connector 注入方式；若无直接注入 notice 的 helper，则照文件内既有 `gateway` fake 的 onEvent 触发方式调用）：

```ts
test("instance notice task-completion fans out to push; other kinds do not", async () => {
  // 按 runtime-fanout.test.ts 现有 harness 建 runtime（带 vapid config），
  // _setWebPushForTests 注入 fake 记录 sendNotification 调用；
  // 触发 onEvent(instanceId, accountId, { type: MSG.instanceNotice, payload: { kind: "task-completion", text: "done", taskId: "t1" } })
  // 断言 fake 收到 1 次、payload JSON title = 实例名；
  // 再触发 kind: "task-progress" → fake 仍 1 次。
});
```

（实现者补全为可运行断言；核心断言点：仅 task-completion 触发、title 取 `instances.getOwned(instanceId, accountId)?.name ?? instanceId`。）

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/packages/relay/cli.test.ts tests/unit/packages/relay/runtime-fanout.test.ts`
Expected: 新增用例 FAIL

- [ ] **Step 3: Implement**

server.ts：

```ts
import { PushNotifier, vapidFromEnv, type VapidConfig } from "./push.js";
import { PushSubscriptionStore } from "./stores/push-subscriptions.js";
```

`CreateRuntimeOptions` / `StartRelayOptions` 加 `vapid?: VapidConfig | null;`。runtime 构造（accounts/instances 之后）：

```ts
  const pushSubscriptions = new PushSubscriptionStore(db);
  const vapid = options.vapid !== undefined ? options.vapid : vapidFromEnv(process.env);
  if (!vapid) {
    logger.warn("relay.push.disabled", "web push disabled: no VAPID config (XACPX_RELAY_VAPID_* env or --vapid-* flags)");
  }
  const pushNotifier = new PushNotifier({ config: vapid, subscriptions: pushSubscriptions, logger });
```

`MSG.instanceNotice` 分支改为：

```ts
        } else if (envelope.type === MSG.instanceNotice) {
          const notice = envelope.payload as InstanceNoticePayload;
          webGateway.broadcast(accountId, { kind: "notice", instanceId, notice });
          if (notice.kind === "task-completion") {
            const instanceName = instances.getOwned(instanceId, accountId)?.name ?? instanceId;
            void pushNotifier.sendTaskCompletion(accountId, { instanceId, instanceName, text: notice.text }); // fire-and-forget: never blocks broadcast/persist
          }
        }
```

createApp 调用点加：

```ts
    vapidPublicKey: vapid ? () => vapid.publicKey : undefined,
    pushSubscriptions,
```

runtime 返回对象加 `pushSubscriptions`。`startRelayServer` 把 `options.vapid` 透传给 createRelayRuntime（start 子命令组装：flag 优先，缺项回落 env，见下）。cli.ts：

- USAGE 加两行：
  ```
  "  push-keys generate   (print a VAPID keypair for web push)",
  ```
  start 行加 `[--vapid-subject s] [--vapid-public-key k] [--vapid-private-key k]`。
- `runRelayCli` 增分支（放在 `update` 分支旁）：

```ts
  if (args[0] === "push-keys" && args[1] === "generate") {
    const keys = webpush.generateVAPIDKeys();
    io.print(JSON.stringify({ subject: "mailto:you@example.com", publicKey: keys.publicKey, privateKey: keys.privateKey }, null, 2));
    io.print("Set via env XACPX_RELAY_VAPID_SUBJECT / XACPX_RELAY_VAPID_PUBLIC_KEY / XACPX_RELAY_VAPID_PRIVATE_KEY or start flags --vapid-*.");
    return 0;
  }
```

（`import webpush from "web-push";` 在 cli.ts 顶部。）
- `StartOptions` + `parseStartOptions` 加 `vapidSubject/vapidPublicKey/vapidPrivateKey`（flag 同名 kebab）；`start` 分支组装：

```ts
    const vapidFromFlags = startOpts.vapidPublicKey && startOpts.vapidPrivateKey
      ? {
          subject: startOpts.vapidSubject ?? vapidFromEnv(process.env)?.subject ?? "mailto:relay@localhost",
          publicKey: startOpts.vapidPublicKey,
          privateKey: startOpts.vapidPrivateKey,
        }
      : (vapidFromEnv(process.env) as VapidConfig | null);
```

传给 `startRelayServer({ ...startOpts, vapid: vapidFromFlags, logger })`。

- 账号级联：`runRelayCli` 的 `rm token` 成功路径后（runtime 打开处）加 `runtime.pushSubscriptions.deleteByAccount(accountId)`——按 cli.ts 现有 rm token 实现位置插入，保持同一事务外 best-effort。

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/packages/relay/cli.test.ts tests/unit/packages/relay/runtime-fanout.test.ts tests/unit/packages/relay/http-app.test.ts`
Expected: 全部 pass

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/server.ts packages/relay/src/cli.ts tests/unit/packages/relay/cli.test.ts tests/unit/packages/relay/runtime-fanout.test.ts
git commit -m "feat(relay): fan out task-completion notices via web push + VAPID CLI"
```

---

### Task 5: relay-web — push Service Worker + PWA 注入

**Files:**
- Create: `packages/relay-web/public/push-sw.js`
- Modify: `packages/relay-web/src/pwa-options.ts`（workbox 加 `importScripts: ["/push-sw.js"]`）
- Test: `packages/relay-web/src/__tests__/pwa.test.ts`（追加断言）

**Interfaces:**
- Consumes: 无
- Produces: SW 监听 `push`（payload `{title, body, instanceId, url}`）与 `notificationclick`；通知 `tag = "xacpx-task:" + instanceId`

- [ ] **Step 1: Write the failing test（pwa.test.ts 追加）**

```ts
  it("injects the push service worker via importScripts", () => {
    expect(pwaOptions.workbox?.importScripts).toEqual(["/push-sw.js"]);
    // The push SW itself must exist in public/ so it ships at the site root.
    expect(existsSync(resolve(pkgRoot, "public/push-sw.js"))).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/relay-web && ../../node_modules/.bin/vitest run src/__tests__/pwa.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: Implement**

`packages/relay-web/public/push-sw.js`：

```js
// Injected into the generated workbox SW via importScripts (see pwa-options.ts).
// Self-contained by design: no bundler pass, plain classic script.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { title: "XACPX", body: event.data ? event.data.text() : "" };
  }
  const instanceId = typeof data.instanceId === "string" ? data.instanceId : "unknown";
  event.waitUntil(
    self.registration.showNotification(data.title || "XACPX", {
      body: data.body || "",
      tag: "xacpx-task:" + instanceId,
      icon: "/pwa-192x192.png",
      data: { url: typeof data.url === "string" ? data.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
```

pwa-options.ts `workbox` 段（`skipWaiting` 之前）加：

```ts
    // Push handlers live in a classic-script island injected into the generated
    // SW: generateSW owns precaching; importScripts keeps our handlers unbundled.
    importScripts: ["/push-sw.js"],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/relay-web && ../../node_modules/.bin/vitest run src/__tests__/pwa.test.ts`
Expected: 全部 pass

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/public/push-sw.js packages/relay-web/src/pwa-options.ts packages/relay-web/src/__tests__/pwa.test.ts
git commit -m "feat(relay-web): push service worker island via importScripts"
```

---

### Task 6: relay-web — lib/web-push.ts + api client 扩展

**Files:**
- Create: `packages/relay-web/src/lib/web-push.ts`
- Modify: `packages/relay-web/src/api/client.ts`（加 `put`；`del` 加可选 body）
- Test: `packages/relay-web/src/__tests__/web-push-lib.test.ts`

**Interfaces:**
- Consumes: `api`（client.ts）
- Produces:
  ```ts
  export function urlBase64ToUint8Array(base64: string): Uint8Array;
  export function pushSupported(): boolean;
  export async function fetchVapidPublicKey(): Promise<string | null>;
  export async function enableDesktopNotifications(publicKey: string): Promise<void>; // subscribe + PUT
  export async function disableDesktopNotifications(): Promise<void>;               // unsubscribe + DELETE（尽力而为）
  export async function reconcileExistingSubscription(): Promise<void>;             // main.ts 对账
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/relay-web/src/__tests__/web-push-lib.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const putMock = vi.fn().mockResolvedValue({ ok: true });
const delMock = vi.fn().mockResolvedValue({ ok: true });

vi.mock("../api/client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ publicKey: "PK" }),
    put: (...a: unknown[]) => putMock(...a),
    del: (...a: unknown[]) => delMock(...a),
  },
  ApiError: class extends Error {},
}));

import { urlBase64ToUint8Array, pushSupported, fetchVapidPublicKey, enableDesktopNotifications, disableDesktopNotifications, reconcileExistingSubscription } from "../lib/web-push";

describe("web-push lib", () => {
  beforeEach(() => { putMock.mockClear(); delMock.mockClear(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("urlBase64ToUint8Array decodes base64url with padding restored", () => {
    const bytes = urlBase64ToUint8Array("BEl62YiZ0d9Z1d9Z");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("pushSupported reflects serviceWorker + PushManager + Notification", () => {
    const orig = (globalThis as Record<string, unknown>);
    const savedSW = orig.serviceWorker, savedNM = orig.Notification;
    orig.serviceWorker = undefined;
    expect(pushSupported()).toBe(false);
    orig.serviceWorker = { register: vi.fn() };
    orig.Notification = function () {} as never;
    (window as unknown as Record<string, unknown>).PushManager = function () {} as never;
    expect(pushSupported()).toBe(true);
    orig.serviceWorker = savedSW; orig.Notification = savedNM;
  });

  it("fetchVapidPublicKey returns the key or null", async () => {
    expect(await fetchVapidPublicKey()).toBe("PK");
  });

  it("enableDesktopNotifications subscribes with the server key and PUTs the JSON", async () => {
    const fakeSub = {
      endpoint: "https://push/e1",
      keys: { p256dh: "k", auth: "a" },
      toJSON() { return { endpoint: this.endpoint, keys: this.keys }; },
    };
    const reg = { pushManager: { subscribe: vi.fn().mockResolvedValue(fakeSub) } };
    const nav = navigator as unknown as { serviceWorker: { ready: Promise<typeof reg> } };
    vi.stubGlobal("navigator", { ...navigator, serviceWorker: { ready: Promise.resolve(reg) } });
    await enableDesktopNotifications("PK");
    expect(reg.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(putMock).toHaveBeenCalledWith("/api/web-push/subscriptions", { endpoint: "https://push/e1", keys: { p256dh: "k", auth: "a" } });
    vi.unstubAllGlobals();
    void nav;
  });

  it("disableDesktopNotifications unsubscribes and DELETEs", async () => {
    const fakeSub = { endpoint: "https://push/e1", unsubscribe: vi.fn().mockResolvedValue(true) };
    const reg = { pushManager: { getSubscription: vi.fn().mockResolvedValue(fakeSub) } };
    vi.stubGlobal("navigator", { ...navigator, serviceWorker: { ready: Promise.resolve(reg) } });
    await disableDesktopNotifications();
    expect(fakeSub.unsubscribe).toHaveBeenCalled();
    expect(delMock).toHaveBeenCalledWith("/api/web-push/subscriptions", { endpoint: "https://push/e1" });
    vi.unstubAllGlobals();
  });

  it("reconcileExistingSubscription PUTs when a subscription exists; silently skips otherwise", async () => {
    const fakeSub = { endpoint: "https://push/e1", toJSON() { return { endpoint: this.endpoint }; } };
    const regWith = { pushManager: { getSubscription: vi.fn().mockResolvedValue(fakeSub) } };
    vi.stubGlobal("navigator", { ...navigator, serviceWorker: { ready: Promise.resolve(regWith) } });
    await reconcileExistingSubscription();
    expect(putMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
    const regWithout = { pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } };
    vi.stubGlobal("navigator", { ...navigator, serviceWorker: { ready: Promise.resolve(regWithout) } });
    putMock.mockClear();
    await reconcileExistingSubscription();
    expect(putMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/relay-web && ../../node_modules/.bin/vitest run src/__tests__/web-push-lib.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Implement**

client.ts —— `api` 对象加（`patch` 之后），并把 `del` 签名改为带可选 body：

```ts
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string, body?: unknown) =>
    request<T>("DELETE", path, body), // request() 只在有 body 时 JSON 编码，DELETE 无 body 时等价旧行为
```

（`request` 的 body 判断已是 `body === undefined ? undefined : JSON.stringify(body)`，无需改动。）

`packages/relay-web/src/lib/web-push.ts`：

```ts
import { api } from "../api/client";

/** VAPID public keys are base64url without padding — restore padding before atob. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const r = await api.get<{ publicKey: string | null }>("/api/web-push/vapid-public-key");
    return r.publicKey ?? null;
  } catch {
    return null; // hub older than this feature: treat as disabled
  }
}

export async function enableDesktopNotifications(publicKey: string): Promise<void> {
  if (typeof Notification !== "undefined" && Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("permission-denied");
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api.put("/api/web-push/subscriptions", sub.toJSON());
}

export async function disableDesktopNotifications(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await api.del("/api/web-push/subscriptions", { endpoint });
}

/** Re-sync a pre-existing subscription to the hub (survives hub DB loss / re-key). */
export async function reconcileExistingSubscription(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api.put("/api/web-push/subscriptions", sub.toJSON());
  } catch {
    // best-effort: the settings toggle remains the authoritative path
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/relay-web && ../../node_modules/.bin/vitest run src/__tests__/web-push-lib.test.ts`
Expected: 全部 pass

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/lib/web-push.ts packages/relay-web/src/api/client.ts packages/relay-web/src/__tests__/web-push-lib.test.ts
git commit -m "feat(relay-web): web-push subscription helpers + api put/del-with-body"
```

---

### Task 7: relay-web — SettingsView 桌面通知段 + i18n + main.ts 对账

**Files:**
- Modify: `packages/relay-web/src/views/SettingsView.vue`
- Modify: `packages/relay-web/src/i18n/messages/zh-CN.ts`、`en.ts`（settings 段）
- Modify: `packages/relay-web/src/main.ts`（注册 SW 成功后 reconcile）
- Test: `packages/relay-web/src/__tests__/settings-notifications.test.ts`

**Interfaces:**
- Consumes: `pushSupported/fetchVapidPublicKey/enableDesktopNotifications/disableDesktopNotifications`（Task 6）
- Produces: UI 状态 `notifState: "unsupported" | "server-disabled" | "denied" | "idle" | "subscribed"`；`data-test="notif-state"` 文本节点 + `data-test="notif-toggle"` 按钮

- [ ] **Step 1: Write the failing test**

```ts
// packages/relay-web/src/__tests__/settings-notifications.test.ts
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lib = {
  pushSupported: vi.fn().mockReturnValue(true),
  fetchVapidPublicKey: vi.fn().mockResolvedValue("PK"),
  enableDesktopNotifications: vi.fn().mockResolvedValue(undefined),
  disableDesktopNotifications: vi.fn().mockResolvedValue(undefined),
  reconcileExistingSubscription: vi.fn().mockResolvedValue(undefined),
};
vi.mock("../lib/web-push", () => lib);
vi.mock("../api/client", () => ({ api: { get: vi.fn() }, ApiError: class extends Error {} }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import SettingsView from "../views/SettingsView.vue";
import { messages } from "../i18n/messages/zh-CN";

const i18n = createI18n({ legacy: false, locale: "zh-CN", messages });

describe("settings notifications section", () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); });

  it("renders subscribed state after a probe subscription is found", async () => {
    // probe: 组件 onMounted 探测当前订阅（经 getSubscription）；mock serviceWorker
    const sub = { endpoint: "https://push/e1" };
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(sub) } }) },
    });
    const w = mount(SettingsView, { global: { plugins: [createPinia(), i18n] } });
    await new Promise((r) => setTimeout(r, 0));
    await w.vm.$nextTick();
    expect(w.find('[data-test="notif-state"]').text()).toBe("已开启");
    vi.unstubAllGlobals();
  });

  it("shows server-disabled when hub has no VAPID key", async () => {
    lib.fetchVapidPublicKey.mockResolvedValueOnce(null);
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } }) },
    });
    const w = mount(SettingsView, { global: { plugins: [createPinia(), i18n] } });
    await new Promise((r) => setTimeout(r, 0));
    await w.vm.$nextTick();
    expect(w.find('[data-test="notif-state"]').text()).toBe("服务端未启用");
    vi.unstubAllGlobals();
  });

  it("toggle-on calls enableDesktopNotifications and flips to subscribed", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } }) },
    });
    const w = mount(SettingsView, { global: { plugins: [createPinia(), i18n] } });
    await new Promise((r) => setTimeout(r, 0));
    await w.find('[data-test="notif-toggle"]').trigger("click");
    await new Promise((r) => setTimeout(r, 0));
    await w.vm.$nextTick();
    expect(lib.enableDesktopNotifications).toHaveBeenCalledWith("PK");
    expect(w.find('[data-test="notif-state"]').text()).toBe("已开启");
    vi.unstubAllGlobals();
  });
});
```

（若 zh-CN.ts 不是 `export const messages = {...}` 形状，按实际导出调整 import；实现者先看文件头。）

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/relay-web && ../../node_modules/.bin/vitest run src/__tests__/settings-notifications.test.ts`
Expected: FAIL（无 notif-state 节点）

- [ ] **Step 3: Implement**

i18n —— zh-CN.ts `settings` 段追加（en.ts 对应英文）：

```ts
    notifTitle: "桌面通知",
    notifOn: "已开启",
    notifOff: "未开启",
    notifUnsupported: "当前环境不支持",
    notifServerDisabled: "服务端未启用",
    notifDenied: "浏览器已拒绝通知权限",
    notifDeniedHint: "在浏览器站点设置中允许通知后重试。",
    notifEnable: "开启通知",
    notifDisable: "关闭通知",
```

```ts
    notifTitle: "Desktop notifications",
    notifOn: "On",
    notifOff: "Off",
    notifUnsupported: "Not supported in this environment",
    notifServerDisabled: "Not enabled on server",
    notifDenied: "Notification permission denied",
    notifDeniedHint: "Allow notifications in the browser site settings, then retry.",
    notifEnable: "Enable notifications",
    notifDisable: "Disable notifications",
```

SettingsView.vue —— script 追加（import 区加 `import { pushSupported, fetchVapidPublicKey, enableDesktopNotifications, disableDesktopNotifications } from "../lib/web-push";`）：

```ts
type NotifState = "unsupported" | "server-disabled" | "denied" | "idle" | "subscribed";
const notifState = ref<NotifState>("idle");
const notifBusy = ref(false);

onMounted(async () => {
  if (!pushSupported()) { notifState.value = "unsupported"; return; }
  if (typeof Notification !== "undefined" && Notification.permission === "denied") { notifState.value = "denied"; return; }
  const key = await fetchVapidPublicKey();
  if (!key) { notifState.value = "server-disabled"; return; }
  vapidKey = key;
  try {
    const reg = await navigator.serviceWorker.ready;
    notifState.value = (await reg.pushManager.getSubscription()) ? "subscribed" : "idle";
  } catch { notifState.value = "idle"; }
});

let vapidKey: string | null = null;

async function toggleNotifications(): Promise<void> {
  if (notifBusy.value) return;
  notifBusy.value = true;
  try {
    if (notifState.value === "subscribed") {
      await disableDesktopNotifications();
      notifState.value = "idle";
    } else if (vapidKey) {
      await enableDesktopNotifications(vapidKey);
      notifState.value = "subscribed";
    }
  } catch (err) {
    if (err instanceof Error && err.message === "permission-denied") notifState.value = "denied";
    // other failures keep the current state; the action toast system is overkill here
  } finally {
    notifBusy.value = false;
  }
}

const notifStateLabel = computed(() => ({
  unsupported: t("settings.notifUnsupported"),
  "server-disabled": t("settings.notifServerDisabled"),
  denied: t("settings.notifDenied"),
  idle: t("settings.notifOff"),
  subscribed: t("settings.notifOn"),
}[notifState.value]));
```

（`computed` 若未 import 则补。）template —— Relay section 之后、Account section 之前插入：

```html
    <section class="mb-8" data-test="notif-setting">
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">{{ $t("settings.notifTitle") }}</h2>
      <div class="flex items-center gap-3">
        <span data-test="notif-state" class="text-sm text-fg-muted">{{ notifStateLabel }}</span>
        <button
          v-if="notifState === 'subscribed' || notifState === 'idle'"
          data-test="notif-toggle"
          :disabled="notifBusy"
          class="rounded bg-accent px-3 py-1 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
          @click="toggleNotifications"
        >{{ notifState === "subscribed" ? $t("settings.notifDisable") : $t("settings.notifEnable") }}</button>
      </div>
      <p v-if="notifState === 'denied'" class="mt-1 text-xs text-fg-muted">{{ $t("settings.notifDeniedHint") }}</p>
    </section>
```

main.ts —— `onRegisteredSW` 回调里 `schedulePwaUpdateChecks(registration);` 之后加：

```ts
    // Re-sync any pre-existing push subscription to the hub (survives hub DB
    // loss or VAPID re-key). Best-effort; settings toggle is authoritative.
    void import("./lib/web-push").then((m) => m.reconcileExistingSubscription());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/relay-web && ../../node_modules/.bin/vitest run src/__tests__/settings-notifications.test.ts src/__tests__/web-push-lib.test.ts src/__tests__/pwa.test.ts`
Expected: 全部 pass

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/views/SettingsView.vue packages/relay-web/src/i18n/messages/zh-CN.ts packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/main.ts packages/relay-web/src/__tests__/settings-notifications.test.ts
git commit -m "feat(relay-web): desktop notification settings section + startup subscription reconcile"
```

---

### Task 8: 文档 + 全量验证

**Files:**
- Modify: `docs/relay-module.md`（服务端段补 web push 说明）、`docs/relay-web-module.md`（若存在设置页文档则补一段；无则只在 relay-module.md 说明）
- 无新测试（文档任务；验证跑既有套件）

**Interfaces:** 无

- [ ] **Step 1: docs**

relay-module.md 服务端列表追加一条：

```markdown
- Web Push（task-completion 桌面通知）：`xacpx-relay push-keys generate` 生成 VAPID 密钥；经环境变量
  `XACPX_RELAY_VAPID_SUBJECT/PUBLIC_KEY/PRIVATE_KEY` 或 start 子命令 `--vapid-*` flag 配置。未配置则禁用。
  订阅存 `push_subscriptions` 表（`PUT/DELETE /api/web-push/subscriptions`，`GET /api/web-push/vapid-public-key`）。
  仅 `notice.kind === "task-completion"` 触发推送；410/404 自动清理订阅。设计 spec：
  docs/superpowers/specs/2026-08-24-web-push-task-completion-design.md。
```

- [ ] **Step 2: 全量验证**

```bash
bun test tests/unit/packages/relay/                                      # relay 单测全绿
cd packages/relay-web && ../../node_modules/.bin/vue-tsc --noEmit       # typecheck
cd packages/relay-web && ../../node_modules/.bin/vitest run             # relay-web 全绿
cd packages/relay && npx tsc --noEmit                                   # relay typecheck（若有 tsconfig）
```

Expected: 全部通过；`vue-tsc` 无错误输出。

- [ ] **Step 3: Commit**

```bash
git add docs/relay-module.md
git commit -m "docs: web push task-completion notification in relay module docs"
```

---

## Self-Review 记录

- Spec 覆盖：§3.1→Task 1；§3.2/3.4→Task 2/4；§3.3→Task 3；§4.1→Task 5；§4.2/4.3→Task 6/7；§4.4→Task 7；§6 手工 runbook 属部署验证，不在自动化计划内（spec §6 已注明）。无缺口。
- 占位符：Task 4 runtime-fanout 测试以断言点描述 + 明确核心断言给出（该文件 harness 形状未预读，实现者按既有 helper 补全；断言内容已完全指定）。
- 类型一致性：`sendTaskCompletion(accountId, {instanceId, instanceName, text})` 在 Task 2 定义、Task 4 消费一致；`AppDeps.vapidPublicKey/pushSubscriptions` Task 3 定义、Task 4 传参一致；`api.put/del(path, body)` Task 6 内自洽。
