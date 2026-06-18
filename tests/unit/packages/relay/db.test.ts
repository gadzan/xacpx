import { expect, test } from "bun:test";

import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";

test("driver run/get/all/exec roundtrip on :memory:", async () => {
  const db = await createSqlDriver(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
  db.run("INSERT INTO t (id, n) VALUES (?, ?)", ["a", 1]);
  db.run("INSERT INTO t (id, n) VALUES (?, ?)", ["b", 2]);
  expect(db.get<{ n: number }>("SELECT n FROM t WHERE id = ?", ["a"])).toEqual({ n: 1 });
  expect(db.get("SELECT n FROM t WHERE id = ?", ["zz"])).toBeUndefined();
  expect(db.all<{ id: string }>("SELECT id FROM t ORDER BY id")).toEqual([{ id: "a" }, { id: "b" }]);
  db.close();
});

test("fresh DB: accounts has exactly id/username/created_at (no password_hash/role)", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const cols = db.all<{ name: string }>("PRAGMA table_info(accounts)").map((c) => c.name);
  expect(cols).toContain("id");
  expect(cols).toContain("username");
  expect(cols).toContain("created_at");
  expect(cols).not.toContain("password_hash");
  expect(cols).not.toContain("role");
  db.close();
});

test("fresh DB: login_tokens table exists with expected columns", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const cols = db.all<{ name: string }>("PRAGMA table_info(login_tokens)").map((c) => c.name);
  expect(cols).toContain("id");
  expect(cols).toContain("token_hash");
  expect(cols).toContain("account_id");
  expect(cols).toContain("label");
  expect(cols).toContain("created_at");
  expect(cols).toContain("last_used_at");
  db.close();
});

test("fresh DB: web_sessions has login_token_id column", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const cols = db.all<{ name: string }>("PRAGMA table_info(web_sessions)").map((c) => c.name);
  expect(cols).toContain("login_token_id");
  db.close();
});

test("fresh DB: invites table is absent", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((row) => row.name);
  expect(tables).not.toContain("invites");
  db.close();
});

test("fresh DB: idx_web_sessions_login_token index exists", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const idx = db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_web_sessions_login_token'"
  );
  expect(idx).toBeDefined();
  db.close();
});

test("messages table has a structured column after initSchema", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const cols = db.all<{ name: string }>("PRAGMA table_info(messages)").map((c) => c.name);
  expect(cols).toContain("structured");
  db.close();
});

test("idempotency: running initSchema 2× on a fresh DB is stable", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  initSchema(db); // second run must not throw
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((row) => row.name);
  for (const expected of ["accounts", "instances", "login_tokens", "messages", "pairing_tokens", "web_sessions"]) {
    expect(tables).toContain(expected);
  }
  expect(tables).not.toContain("invites");
  const idx = db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_web_sessions_login_token'"
  );
  expect(idx).toBeDefined();
  db.close();
});
