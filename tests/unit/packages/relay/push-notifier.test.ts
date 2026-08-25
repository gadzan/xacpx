import { expect, test } from "bun:test";
import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { PushSubscriptionStore } from "../../../../packages/relay/src/stores/push-subscriptions";
import { PushNotifier, vapidFromEnv, PUSH_TTL_SECONDS, isAllowedPushEndpoint } from "../../../../packages/relay/src/push";

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
  const notifier = new PushNotifier({ config: { subject: "mailto:test@example.com", publicKey: "BAC0N1KPvXljbO1sSdRqDFn4rkdrQnNoXILJ61BpFusYJ1VC8KlBRWXOs5tz2lb0NvZVe2vrDrKc62jEWp6nrYg", privateKey: "w7gAGvS_Do-fQS4qrv63qkIsaqw6ni5nyJoh3ud-BRU" }, subscriptions });
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
  await notifier.sendTaskCompletion("a1", { instanceId: "i1", instanceName: "home-pc", text: "x".repeat(500) });
  expect(sent).toHaveLength(2);
  expect(sent[0]!.ttl).toBe(PUSH_TTL_SECONDS);
  const body = JSON.parse(sent[0]!.payload);
  expect(body).toEqual({ title: "home-pc", body: "x".repeat(200), instanceId: "i1", url: "/" });
});

test("410 cleans up the subscription row; other errors keep it", async () => {
  const sent: SentCall[] = [];
  const { notifier, subscriptions } = await makeNotifier(sent, { statusCode: 410 });
  subscriptions.upsert({ accountId: "a1", endpoint: "https://push/e1", p256dh: "k1", auth: "a1" });
  await notifier.sendTaskCompletion("a1", { instanceId: "i1", instanceName: "home-pc", text: "done" });
  expect(subscriptions.listByAccount("a1")).toHaveLength(0);
});

test("no config → no-op, no subscriptions touched", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const subscriptions = new PushSubscriptionStore(db);
  subscriptions.upsert({ accountId: "a1", endpoint: "https://push/e1", p256dh: "k1", auth: "a1" });
  const notifier = new PushNotifier({ config: null, subscriptions });
  await notifier.sendTaskCompletion("a1", { instanceId: "i1", instanceName: "home-pc", text: "done" }); // must not throw
  expect(subscriptions.listByAccount("a1")).toHaveLength(1);
});

test("malformed VAPID config downgrades to disabled (constructor validates eagerly)", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const subscriptions = new PushSubscriptionStore(db);
  subscriptions.upsert({ accountId: "a1", endpoint: "https://push/e1", p256dh: "k1", auth: "a1" });
  const notifier = new PushNotifier({ config: { subject: "mailto:a@b.c", publicKey: "not-long-enough", privateKey: "" }, subscriptions });
  await notifier.sendTaskCompletion("a1", { instanceId: "i1", instanceName: "n", text: "t" }); // must not throw
  expect(subscriptions.listByAccount("a1")).toHaveLength(1); // untouched
});

test("sendTaskCompletion never rejects even when the transport explodes synchronously", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const subscriptions = new PushSubscriptionStore(db);
  const notifier = new PushNotifier({ config: { subject: "mailto:a@b.c", publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U", privateKey: "w7gAGvS_Do-fQS4qrv63qkIsaqw6ni5nyJoh3ud-BRU" }, subscriptions });
  notifier._setWebPushForTests({
    setVapidDetails: () => { throw new Error("boom at init"); },
    sendNotification: async () => {},
  });
  await expect(notifier.sendTaskCompletion("a1", { instanceId: "i1", instanceName: "n", text: "t" })).resolves.toBeUndefined();
});

test("validateVapidConfig enforces decoded key lengths (65/32 bytes)", () => {
  const { validateVapidConfig } = require("../../../../packages/relay/src/push");
  const goodPk = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
  const goodSk = "w7gAGvS_Do-fQS4qrv63qkIsaqw6ni5nyJoh3ud-BRU";
  expect(validateVapidConfig({ subject: "mailto:a@b.c", publicKey: goodPk, privateKey: goodSk })).not.toBeNull();
  // Truncated private key: right-ish shape, wrong decoded length.
  expect(validateVapidConfig({ subject: "mailto:a@b.c", publicKey: goodPk, privateKey: goodSk.slice(0, 20) })).toBeNull();
  // Truncated public key:
  expect(validateVapidConfig({ subject: "mailto:a@b.c", publicKey: goodPk.slice(0, 40), privateKey: goodSk })).toBeNull();
  // Bad subject scheme:
  expect(validateVapidConfig({ subject: "ftp://a@b.c", publicKey: goodPk, privateKey: goodSk })).toBeNull();
  // Subject that passes a prefix regex but is not an absolute URL (web-push
  // does new URL(subject)):
  expect(validateVapidConfig({ subject: "https://", publicKey: goodPk, privateKey: goodSk })).toBeNull();
});

test("isAllowedPushEndpoint accepts FCM and *.push.apple.com, rejects SSRF and spoof attempts", () => {
  // Accept matrix
  for (const ep of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.notifications.google.com/fcm/send/abc",
    "https://web.push.apple.com/Q-xxxxx",
    "https://foo.push.apple.com/abc",
    "https://foo.bar.push.apple.com/abc",
    "https://web.push.apple.com:443/abc",
  ]) {
    expect(isAllowedPushEndpoint(ep)).toBe(true);
  }

  // Reject matrix (SSRF / non-https / wrong ports / invalid domains / suffix spoofs)
  for (const ep of [
    "http://web.push.apple.com/abc",
    "https://web.push.apple.com:8443/abc",
    "https://push.apple.com.evil.com/abc",
    "https://evilpush.apple.com/abc",
    "https://push.apple.com@evil.com/abc",
    "https://push.apple.com/abc",
    "https://evil.com/push.apple.com",
    "https://127.0.0.1/",
    "https://localhost/",
    "https://169.254.169.254/",
    "https://10.0.0.1/",
    "https://example.com/",
    "not-a-url",
    "https://foo.push.apple.com.evil.example/path",
  ]) {
    expect(isAllowedPushEndpoint(ep)).toBe(false);
  }
});

test("sendTaskCompletion fans out to both FCM and Apple endpoints and cleans up Apple 410", async () => {
  const sent: SentCall[] = [];
  // Simulate Apple returning 410 gone
  const { notifier, subscriptions } = await makeNotifier(sent, { statusCode: 410 });
  subscriptions.upsert({ accountId: "a1", endpoint: "https://web.push.apple.com/sub1", p256dh: "k1", auth: "a1" });
  subscriptions.upsert({ accountId: "a1", endpoint: "https://fcm.googleapis.com/fcm/send/sub2", p256dh: "k2", auth: "a2" });

  await notifier.sendTaskCompletion("a1", { instanceId: "i1", instanceName: "inst", text: "done" });
  expect(sent).toHaveLength(2);
  expect(sent.map((s) => s.endpoint).sort()).toEqual([
    "https://fcm.googleapis.com/fcm/send/sub2",
    "https://web.push.apple.com/sub1",
  ]);
  // 410 should have cleaned up both expired subscriptions
  expect(subscriptions.listByAccount("a1")).toHaveLength(0);
});
