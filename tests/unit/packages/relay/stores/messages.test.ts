// tests/unit/packages/relay/stores/messages.test.ts
import { expect, test } from "bun:test";
import { createSqlDriver, initSchema } from "../../../../../packages/relay/src/db";
import { MessageStore } from "../../../../../packages/relay/src/stores/messages";

async function freshDb() {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a1", "u1", "t"]);
  db.run("INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)", ["a2", "u2", "t"]);
  db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i1", "a1", "pc", "h", "t"]);
  db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?,?,?,?,?)", ["i2", "a2", "pc", "h", "t"]);
  return db;
}

test("append then listBySession returns rows oldest-first as DTOs", async () => {
  const db = await freshDb();
  let clock = 1000;
  const store = new MessageStore(db, () => new Date(clock));
  store.append("i1", "backend", "in", "hello");
  clock = 2000;
  store.append("i1", "backend", "out", "world");
  const rows = store.listBySession("a1", "i1", "backend");
  expect(rows.map((r) => [r.direction, r.text])).toEqual([["in", "hello"], ["out", "world"]]);
  expect(rows[0]?.instanceId).toBe("i1");
  expect(rows[0]?.createdAt).toBe(new Date(1000).toISOString());
});

test("listBySession is account-scoped: foreign account sees nothing", async () => {
  const db = await freshDb();
  const store = new MessageStore(db);
  store.append("i1", "backend", "in", "secret");
  expect(store.listBySession("a2", "i1", "backend")).toEqual([]);
});

test("listBySession honors the limit, keeping the most recent", async () => {
  const db = await freshDb();
  let clock = 0;
  const store = new MessageStore(db, () => new Date((clock += 1000)));
  for (let i = 0; i < 5; i++) store.append("i1", "backend", "in", `m${i}`);
  const rows = store.listBySession("a1", "i1", "backend", 2);
  expect(rows.map((r) => r.text)).toEqual(["m3", "m4"]);
});
