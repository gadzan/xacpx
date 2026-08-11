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

test("transaction commits all writes atomically", async () => {
  const db = await createSqlDriver(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
  db.transaction(() => {
    db.run("INSERT INTO t (id) VALUES (?)", ["a"]);
    db.run("INSERT INTO t (id) VALUES (?)", ["b"]);
  });
  expect(db.all<{ id: string }>("SELECT id FROM t ORDER BY id")).toEqual([{ id: "a" }, { id: "b" }]);
  db.close();
});

test("transaction rolls back every write when the body throws", async () => {
  const db = await createSqlDriver(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
  expect(() => db.transaction(() => {
    db.run("INSERT INTO t (id) VALUES (?)", ["a"]);
    throw new Error("boom");
  })).toThrow("boom");
  expect(db.all<{ id: string }>("SELECT id FROM t")).toEqual([]);
  db.close();
});

test("nested transaction is rejected instead of corrupting the outer one", async () => {
  const db = await createSqlDriver(":memory:");
  db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
  expect(() => db.transaction(() => {
    db.run("INSERT INTO t (id) VALUES (?)", ["a"]);
    db.transaction(() => db.run("INSERT INTO t (id) VALUES (?)", ["b"]));
  })).toThrow(/nested SQLite transaction/);
  // The outer transaction aborted on the throw — nothing committed.
  expect(db.all<{ id: string }>("SELECT id FROM t")).toEqual([]);
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

test("initSchema migrates a pre-origin_queue_item_id messages table without failing", async () => {
  const db = await createSqlDriver(":memory:");
  // Simulate a DB created by an earlier relay version: messages lacks
  // origin_queue_item_id (the index for it must be created AFTER the ALTER, or
  // initSchema fails with "no such column" before the migration ever runs).
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      session_alias TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      structured TEXT,
      attachments TEXT,
      queue_item_id TEXT,
      queue_fallback INTEGER NOT NULL DEFAULT 0
    );
  `);
  initSchema(db); // must not throw
  const cols = db.all<{ name: string }>("PRAGMA table_info(messages)").map((c) => c.name);
  expect(cols).toContain("origin_queue_item_id");
  const idx = db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_origin_queue'"
  );
  expect(idx).toBeDefined();
  db.close();
});

test("fresh DB: instances has capabilities_json column", async () => {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const cols = db.all<{ name: string }>("PRAGMA table_info(instances)").map((c) => c.name);
  expect(cols).toContain("capabilities_json");
  db.close();
});

test("initSchema migrates a pre-capabilities_json instances table without failing", async () => {
  const db = await createSqlDriver(":memory:");
  db.exec(`
    CREATE TABLE instances (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      core_version TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
  initSchema(db);
  const cols = db.all<{ name: string }>("PRAGMA table_info(instances)").map((c) => c.name);
  expect(cols).toContain("capabilities_json");
  db.close();
});
