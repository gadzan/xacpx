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
  return { instances, account, setNow: (iso: string) => { now = new Date(iso); } };
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

test("touch updates last_seen; listByAccount scopes; remove enforces ownership", async () => {
  const { instances, account, setNow } = await makeStores();
  const redeemed = instances.redeemPairingToken(
    instances.issuePairingToken(account.id, "pc", 600_000).token,
  )!;
  setNow("2026-06-13T10:05:00.000Z");
  instances.touch(redeemed.instanceId);
  const listed = instances.listByAccount(account.id);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.lastSeenAt).toBe("2026-06-13T10:05:00.000Z");
  expect(instances.listByAccount("other-account")).toEqual([]);
  expect(instances.remove(redeemed.instanceId, "other-account")).toBe(false);
  expect(instances.remove(redeemed.instanceId, account.id)).toBe(true);
  expect(instances.listByAccount(account.id)).toEqual([]);
});
