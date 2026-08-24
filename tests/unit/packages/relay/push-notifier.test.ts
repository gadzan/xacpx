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
  await notifier.sendTaskCompletion("a1", { instanceId: "i1", instanceName: "home-pc", text: "x".repeat(500) });
  expect(sent).toHaveLength(2);
  expect(sent[0]!.ttl).toBe(PUSH_TTL_MS);
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
