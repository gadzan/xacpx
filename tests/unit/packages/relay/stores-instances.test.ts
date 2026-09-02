import { expect, test } from "bun:test";

import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { AccountStore } from "../../../../packages/relay/src/stores/accounts";
import { InstanceStore } from "../../../../packages/relay/src/stores/instances";

async function makeStores(nowIso = "2026-06-13T10:00:00.000Z") {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  let now = new Date(nowIso);
  const accounts = new AccountStore(db, { now: () => now });
  const instances = new InstanceStore(db, { now: () => now });
  const account = accounts.createAccount("alice");
  return { db, instances, account, setNow: (iso: string) => { now = new Date(iso); } };
}

test("pairing token redeems once into an instance with a fresh credential", async () => {
  const { instances, account } = await makeStores();
  const issued = instances.issuePairingToken(account.id, "home-pc", 600_000);
  const redeemed = instances.redeemPairingToken(issued.token, "0.11.0");
  expect(redeemed).not.toBeNull();
  expect(redeemed?.accountId).toBe(account.id);
  expect(redeemed?.name).toBe("home-pc");
  expect(instances.redeemPairingToken(issued.token)).toBeNull(); // single-use

  const verified = instances.verifyCredential(redeemed!.instanceId, redeemed!.credential);
  expect(verified?.accountId).toBe(account.id);
  expect(instances.verifyCredential(redeemed!.instanceId, "wrong")).toBeNull();
  expect(instances.verifyCredential("ghost", redeemed!.credential)).toBeNull();
});

test("expired pairing token cannot be redeemed", async () => {
  const { instances, account, setNow } = await makeStores();
  const issued = instances.issuePairingToken(account.id, undefined, 60_000);
  setNow("2026-06-13T10:02:00.000Z");
  expect(instances.redeemPairingToken(issued.token)).toBeNull();
});

test("registerInstanceForAccount creates instance with verifiable credential", async () => {
  const { instances, account } = await makeStores();
  const result = instances.registerInstanceForAccount(account.id, "home-pc", "0.11.0");
  expect(result.instanceId).toBeString();
  expect(result.credential).toBeString();
  expect(result.accountId).toBe(account.id);
  expect(result.name).toBe("home-pc");

  const verified = instances.verifyCredential(result.instanceId, result.credential);
  expect(verified?.accountId).toBe(account.id);
  expect(verified?.name).toBe("home-pc");
  expect(instances.verifyCredential(result.instanceId, "wrong")).toBeNull();
});

test("registerInstanceForAccount with undefined name generates a default name", async () => {
  const { instances, account } = await makeStores();
  const result = instances.registerInstanceForAccount(account.id, undefined);
  expect(result.name).toMatch(/^instance-[0-9a-f]{8}$/);
  expect(result.name).toBe(result.name); // stable
});

test("registerInstanceForAccount multiple calls create independent instances", async () => {
  const { instances, account } = await makeStores();
  const a = instances.registerInstanceForAccount(account.id, "box-a");
  const b = instances.registerInstanceForAccount(account.id, "box-b");
  expect(a.instanceId).not.toBe(b.instanceId);
  expect(a.credential).not.toBe(b.credential);
  const listed = instances.listByAccount(account.id);
  expect(listed.length).toBe(2);
});

test("rename updates the name for an owned instance", async () => {
  const { instances, account } = await makeStores();
  const created = instances.registerInstanceForAccount(account.id, "old-name");
  expect(instances.rename(created.instanceId, account.id, "new name")).toBe(true);
  expect(instances.getOwned(created.instanceId, account.id)?.name).toBe("new name");
});

test("rename of an instance owned by a different account returns false and does not change the name", async () => {
  const { instances, account } = await makeStores();
  const created = instances.registerInstanceForAccount(account.id, "old-name");
  expect(instances.rename(created.instanceId, "other-account", "hijacked")).toBe(false);
  expect(instances.getOwned(created.instanceId, account.id)?.name).toBe("old-name");
});

test("rename of a non-existent instance returns false", async () => {
  const { instances, account } = await makeStores();
  expect(instances.rename("ghost", account.id, "whatever")).toBe(false);
});

test("touch updates last_seen; listByAccount scopes; remove enforces ownership", async () => {
  const { db, instances, account, setNow } = await makeStores();
  const redeemed = instances.redeemPairingToken(
    instances.issuePairingToken(account.id, "pc", 600_000).token,
  )!;
  setNow("2026-06-13T10:05:00.000Z");
  instances.touch(redeemed.instanceId);
  db.run(
    "INSERT INTO turn_slot_anchors (instance_id, session_alias, recovery_id, slot_after_id) VALUES (?,?,?,?)",
    [redeemed.instanceId, "backend", "r-1", 1],
  );
  const listed = instances.listByAccount(account.id);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.lastSeenAt).toBe("2026-06-13T10:05:00.000Z");
  expect(listed[0]?.capabilities).toEqual([]);
  expect(instances.listByAccount("other-account")).toEqual([]);
  expect(instances.remove(redeemed.instanceId, "other-account")).toBe(false);
  expect(instances.remove(redeemed.instanceId, account.id)).toBe(true);
  expect(instances.listByAccount(account.id)).toEqual([]);
  expect(db.get("SELECT 1 FROM turn_slot_anchors WHERE instance_id = ?", [redeemed.instanceId])).toBeUndefined();
});

test("setCapabilities replaces the full set; missing column/null reads as empty", async () => {
  const { instances, account } = await makeStores();
  const created = instances.registerInstanceForAccount(account.id, "pc");
  expect(instances.getOwned(created.instanceId, account.id)?.capabilities).toEqual([]);

  instances.setCapabilities(created.instanceId, [
    "terminal.rmux.recovery.v1",
    "terminal.multi-view.v1",
    "future.cap.v9",
  ]);
  expect(instances.getOwned(created.instanceId, account.id)?.capabilities).toEqual([
    "terminal.rmux.recovery.v1",
    "terminal.multi-view.v1",
    "future.cap.v9",
  ]);

  instances.setCapabilities(created.instanceId, ["terminal.multi-view.v1"]);
  expect(instances.listByAccount(account.id)[0]?.capabilities).toEqual(["terminal.multi-view.v1"]);
});

test("touch with capabilities writes capabilities_json on auth-style updates", async () => {
  const { instances, account } = await makeStores();
  const created = instances.registerInstanceForAccount(account.id, "pc");
  instances.touch(created.instanceId, "0.12.0", ["terminal.rmux.recovery.v1"]);
  const row = instances.verifyCredential(created.instanceId, created.credential);
  expect(row?.coreVersion).toBe("0.12.0");
  expect(row?.capabilities).toEqual(["terminal.rmux.recovery.v1"]);
});
