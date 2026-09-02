import { expect, test } from "bun:test";
import { createSqlDriver, initSchema } from "../../../../../packages/relay/src/db";
import {
  TurnSlotAnchorStore,
  canonicalRecoveryId,
} from "../../../../../packages/relay/src/stores/turn-slot-anchors";

async function fresh() {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a1", "u1", "t"]);
  db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i1", "a1", "pc", "h", "t"]);
  db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i2", "a1", "pc2", "h", "t"]);
  return { db, store: new TurnSlotAnchorStore(db) };
}

test("take with a non-empty recoveryId miss does not bind a leftover session anchor", async () => {
  const { store } = await fresh();
  store.put({ instanceId: "i1", sessionAlias: "backend", recoveryId: "r-A", slotAfterId: 10 });
  expect(store.take("i1", "backend", "r-B")).toBeUndefined();
  expect(store.get("i1", "r-A")?.slotAfterId).toBe(10);
});

test("empty recoveryId is isolated per session (backend and frontend do not clobber)", async () => {
  const { store } = await fresh();
  store.put({
    instanceId: "i1",
    sessionAlias: "backend",
    recoveryId: canonicalRecoveryId("backend"),
    slotAfterId: 10,
  });
  store.put({
    instanceId: "i1",
    sessionAlias: "frontend",
    recoveryId: canonicalRecoveryId("frontend"),
    slotAfterId: 20,
  });
  expect(store.take("i1", "backend")?.slotAfterId).toBe(10);
  expect(store.take("i1", "frontend")?.slotAfterId).toBe(20);
  expect(store.get("i1", canonicalRecoveryId("backend"))).toBeUndefined();
  expect(store.get("i1", canonicalRecoveryId("frontend"))).toBeUndefined();
});

test("retain drops leftover anchors not in turns ∪ finishedOffline", async () => {
  const { store } = await fresh();
  store.put({ instanceId: "i1", sessionAlias: "backend", recoveryId: "r-A", slotAfterId: 10 });
  store.put({ instanceId: "i1", sessionAlias: "backend", recoveryId: "r-B", slotAfterId: 100 });
  store.put({ instanceId: "i1", sessionAlias: "frontend", recoveryId: "r-C", slotAfterId: 5 });
  store.retain("i1", new Set(["r-B"]));
  expect(store.get("i1", "r-A")).toBeUndefined();
  expect(store.get("i1", "r-B")?.slotAfterId).toBe(100);
  expect(store.get("i1", "r-C")).toBeUndefined();
});

test("deleteBySession and deleteByInstance clear only the targeted rows", async () => {
  const { store } = await fresh();
  store.put({ instanceId: "i1", sessionAlias: "backend", recoveryId: "r-be", slotAfterId: 1 });
  store.put({ instanceId: "i1", sessionAlias: "frontend", recoveryId: "r-fe", slotAfterId: 2 });
  store.put({ instanceId: "i2", sessionAlias: "backend", recoveryId: "r-other", slotAfterId: 3 });
  store.deleteBySession("i1", "backend");
  expect(store.get("i1", "r-be")).toBeUndefined();
  expect(store.get("i1", "r-fe")?.slotAfterId).toBe(2);
  expect(store.get("i2", "r-other")?.slotAfterId).toBe(3);
  store.deleteByInstance("i1");
  expect(store.get("i1", "r-fe")).toBeUndefined();
  expect(store.get("i2", "r-other")?.slotAfterId).toBe(3);
});
