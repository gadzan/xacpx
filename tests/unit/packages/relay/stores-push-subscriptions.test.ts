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
