import { expect, test } from "bun:test";
import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { AccountStore } from "../../../../packages/relay/src/stores/accounts";
import { InstanceStore } from "../../../../packages/relay/src/stores/instances";
import { MessageStore } from "../../../../packages/relay/src/stores/messages";
import { RecoveryReceiptStore } from "../../../../packages/relay/src/stores/recovery-receipts";
import { RECOVERY_RECEIPT_TTL_MS, runMaintenance } from "../../../../packages/relay/src/maintenance";

async function freshDb() {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  return db;
}

test("MessageStore.prune deletes rows older than maxAgeMs", async () => {
  const db = await freshDb();
  const acc = new AccountStore(db);
  const a = acc.createAccount("u");
  db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)",
    ["inst", a.id, "pc", "h", new Date("2020-01-01").toISOString()]);
  db.run("INSERT INTO messages (instance_id, session_alias, direction, text, created_at) VALUES (?,?,?,?,?)",
    ["inst", "s", "in", "old", new Date("2020-01-01").toISOString()]);
  db.run("INSERT INTO messages (instance_id, session_alias, direction, text, created_at) VALUES (?,?,?,?,?)",
    ["inst", "s", "in", "new", new Date("2020-06-01").toISOString()]);
  const messages = new MessageStore(db, () => new Date("2020-06-02"));
  const deleted = messages.prune({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
  expect(deleted).toBe(1);
  expect(messages.listBySession(a.id, "inst", "s").messages.map((r) => r.text)).toEqual(["new"]);
});

test("MessageStore.prune enforces maxPerSession keeping newest", async () => {
  const db = await freshDb();
  const acc = new AccountStore(db);
  const a = acc.createAccount("u");
  db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)",
    ["inst", a.id, "pc", "h", new Date().toISOString()]);
  const messages = new MessageStore(db);
  for (let i = 0; i < 5; i++) messages.append("inst", "s", "in", `m${i}`);
  const deleted = messages.prune({ maxPerSession: 2 });
  expect(deleted).toBe(3);
  expect(messages.listBySession(a.id, "inst", "s").messages.map((r) => r.text)).toEqual(["m3", "m4"]);
});

test("AccountStore.pruneExpired removes expired web sessions", async () => {
  const db = await freshDb();
  const acc = new AccountStore(db, { now: () => new Date("2020-01-01") });
  const a = acc.createAccount("u");
  const { id: loginTokenId } = acc.createLoginToken(a.id);
  acc.createWebSession(a.id, loginTokenId, 1000);
  const removed = acc.pruneExpired(new Date("2020-02-01"));
  expect(removed).toBeGreaterThanOrEqual(1);
});

test("InstanceStore.prunePairingTokens removes expired tokens", async () => {
  const db = await freshDb();
  const acc = new AccountStore(db);
  const a = acc.createAccount("u");
  const instances = new InstanceStore(db, { now: () => new Date("2020-01-01") });
  instances.issuePairingToken(a.id, "pc", 1000);
  const removed = instances.prunePairingTokens(new Date("2020-02-01"));
  expect(removed).toBe(1);
});

test("runMaintenance runs all prunes without throwing", async () => {
  const db = await freshDb();
  const acc = new AccountStore(db);
  const instances = new InstanceStore(db);
  const messages = new MessageStore(db);
  const recoveryReceipts = new RecoveryReceiptStore(db);
  const summary = runMaintenance({ accounts: acc, instances, messages, recoveryReceipts }, { historyRetentionDays: 30, maxPerSession: 2000, now: () => new Date() });
  expect(summary).toMatchObject({ messagesDeleted: expect.any(Number), sessionsDeleted: expect.any(Number), pairingTokensDeleted: expect.any(Number), inviteCodesDeleted: expect.any(Number), receiptsDeleted: expect.any(Number) });
});

test("runMaintenance prunes expired invite codes and reports the count", async () => {
  const db = await freshDb();
  const acc = new AccountStore(db, { now: () => new Date("2020-01-01") });
  const instances = new InstanceStore(db);
  const messages = new MessageStore(db);
  const recoveryReceipts = new RecoveryReceiptStore(db);
  acc.issueInviteCode("old", 1000);
  const summary = runMaintenance(
    { accounts: acc, instances, messages, recoveryReceipts },
    { historyRetentionDays: 30, maxPerSession: 2000, now: () => new Date("2020-02-01") },
  );
  expect(summary.inviteCodesDeleted).toBe(1);
});

test("recovery receipts past their TTL are pruned; fresh ones survive", async () => {
  const db = await freshDb();
  const acc = new AccountStore(db);
  const instances = new InstanceStore(db);
  const messages = new MessageStore(db);
  const receipts = new RecoveryReceiptStore(db);
  receipts.remember("i1", "fresh");
  receipts.remember("i1", "stale", new Date("2019-12-20").toISOString());
  const summary = runMaintenance(
    { accounts: acc, instances, messages, recoveryReceipts: receipts },
    { historyRetentionDays: 30, maxPerSession: 2000, recoveryReceiptTtlMs: RECOVERY_RECEIPT_TTL_MS, now: () => new Date("2020-01-08") },
  );
  expect(summary.receiptsDeleted).toBe(1);
  expect(receipts.has("i1", "fresh")).toBe(true);
  expect(receipts.has("i1", "stale")).toBe(false);
});
