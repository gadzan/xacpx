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

test("initSchema adds structured to a pre-existing messages table (migration)", async () => {
  const db = await createSqlDriver(":memory:");
  // Simulate an old deployment: messages table without the structured column.
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT NOT NULL, session_alias TEXT NOT NULL,
    direction TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)`);
  initSchema(db);
  const cols = db.all<{ name: string }>("PRAGMA table_info(messages)").map((c) => c.name);
  expect(cols).toContain("structured");
  db.close();
});

// ── Legacy DB migration tests ────────────────────────────────────────────────

const LEGACY_SCHEMA = `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','member')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES accounts(id),
    expires_at TEXT NOT NULL,
    used_by TEXT
  );
  CREATE TABLE web_sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    expires_at TEXT NOT NULL
  );
  CREATE TABLE pairing_tokens (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    name TEXT,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE instances (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    credential_hash TEXT NOT NULL,
    core_version TEXT,
    last_seen_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL REFERENCES instances(id),
    session_alias TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    structured TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (instance_id, session_alias, id);
`;

function seedLegacyDb(db: ReturnType<typeof createSqlDriver> extends Promise<infer T> ? T : never) {
  db.exec(LEGACY_SCHEMA);
  db.run("INSERT INTO accounts (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)", [
    "acc1", "alice", "hash123", "admin", "2024-01-01T00:00:00Z",
  ]);
  db.run("INSERT INTO invites (token_hash, created_by, expires_at) VALUES (?, ?, ?)", [
    "inv_hash1", "acc1", "2025-01-01T00:00:00Z",
  ]);
  db.run("INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?, ?, ?, ?, ?)", [
    "inst1", "acc1", "mybox", "cred_hash1", "2024-01-01T00:00:00Z",
  ]);
  db.run(
    "INSERT INTO web_sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)",
    ["sess_hash1", "acc1", "2025-01-01T00:00:00Z"]
  );
  db.run(
    "INSERT INTO messages (instance_id, session_alias, direction, text, created_at) VALUES (?, ?, ?, ?, ?)",
    ["inst1", "s1", "in", "hello", "2024-01-01T00:00:00Z"]
  );
}

test("migration: accounts loses password_hash/role, preserves ids", async () => {
  const db = await createSqlDriver(":memory:");
  seedLegacyDb(db);
  initSchema(db);
  const cols = db.all<{ name: string }>("PRAGMA table_info(accounts)").map((c) => c.name);
  expect(cols).not.toContain("password_hash");
  expect(cols).not.toContain("role");
  expect(cols).toContain("id");
  expect(cols).toContain("username");
  expect(cols).toContain("created_at");
  // Original account row preserved
  const acc = db.get<{ id: string; username: string }>("SELECT id, username FROM accounts WHERE id = ?", ["acc1"]);
  expect(acc).toBeDefined();
  expect(acc!.username).toBe("alice");
  db.close();
});

test("migration: login_tokens table and idx_web_sessions_login_token created", async () => {
  const db = await createSqlDriver(":memory:");
  seedLegacyDb(db);
  initSchema(db);
  // login_tokens exists
  const ltCols = db.all<{ name: string }>("PRAGMA table_info(login_tokens)").map((c) => c.name);
  expect(ltCols).toContain("id");
  expect(ltCols).toContain("token_hash");
  // index exists
  const idx = db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_web_sessions_login_token'"
  );
  expect(idx).toBeDefined();
  db.close();
});

test("migration: web_sessions gains login_token_id, legacy row value IS NULL", async () => {
  const db = await createSqlDriver(":memory:");
  seedLegacyDb(db);
  initSchema(db);
  const cols = db.all<{ name: string }>("PRAGMA table_info(web_sessions)").map((c) => c.name);
  expect(cols).toContain("login_token_id");
  const sess = db.get<{ login_token_id: string | null }>(
    "SELECT login_token_id FROM web_sessions WHERE token_hash = ?",
    ["sess_hash1"]
  );
  expect(sess).toBeDefined();
  expect(sess!.login_token_id).toBeNull();
  db.close();
});

test("migration: invites table is dropped", async () => {
  const db = await createSqlDriver(":memory:");
  seedLegacyDb(db);
  initSchema(db);
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((row) => row.name);
  expect(tables).not.toContain("invites");
  db.close();
});

test("migration: instances and messages rows still present (no orphan)", async () => {
  const db = await createSqlDriver(":memory:");
  seedLegacyDb(db);
  initSchema(db);
  const inst = db.get<{ id: string }>("SELECT id FROM instances WHERE id = ?", ["inst1"]);
  expect(inst).toBeDefined();
  const msg = db.get<{ instance_id: string }>("SELECT instance_id FROM messages WHERE instance_id = ?", ["inst1"]);
  expect(msg).toBeDefined();
  db.close();
});

test("idempotency: running initSchema 3× on migrated DB is stable", async () => {
  const db = await createSqlDriver(":memory:");
  seedLegacyDb(db);
  initSchema(db);
  initSchema(db);
  initSchema(db);
  // Schema is stable — no error, correct columns
  const cols = db.all<{ name: string }>("PRAGMA table_info(accounts)").map((c) => c.name);
  expect(cols).not.toContain("password_hash");
  expect(cols).not.toContain("role");
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((row) => row.name);
  expect(tables).not.toContain("invites");
  expect(tables).toContain("login_tokens");
  db.close();
});

test("idempotency: running initSchema 2× on a fresh (non-seeded) DB is stable", async () => {
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

// ── FK regression tests (node:sqlite emulation) ─────────────────────────────
// node:sqlite defaults foreign_keys = ON (enableForeignKeyConstraints defaults
// true). initSchema's accounts rebuild (DROP TABLE accounts) fails with
// "FOREIGN KEY constraint failed" when child rows in instances/web_sessions
// reference accounts(id) and FKs are ON. The fix: initSchema issues
// PRAGMA foreign_keys = OFF before any other DDL (must be outside a
// transaction, which it is at the top of initSchema).

test("node:sqlite emulation: initSchema survives accounts rebuild when FKs are forced ON", async () => {
  const db = await createSqlDriver(":memory:");
  seedLegacyDb(db);
  // Emulate node:sqlite's default — foreign_keys ON — BEFORE calling initSchema.
  // Without Part B (PRAGMA foreign_keys = OFF at top of initSchema), this throws:
  //   SqliteError: FOREIGN KEY constraint failed
  // because DROP TABLE accounts is blocked by child rows in instances/web_sessions.
  db.exec("PRAGMA foreign_keys = ON");
  // Must complete without throwing.
  expect(() => initSchema(db)).not.toThrow();
  // Migration succeeded: accounts has no legacy columns.
  const cols = db.all<{ name: string }>("PRAGMA table_info(accounts)").map((c) => c.name);
  expect(cols).not.toContain("password_hash");
  expect(cols).not.toContain("role");
  expect(cols).toContain("id");
  // Account id preserved.
  const acc = db.get<{ id: string; username: string }>("SELECT id, username FROM accounts WHERE id = ?", ["acc1"]);
  expect(acc).toBeDefined();
  expect(acc!.username).toBe("alice");
  // Child rows survived (no orphan caused by FK enforcement).
  const inst = db.get<{ id: string }>("SELECT id FROM instances WHERE id = ?", ["inst1"]);
  expect(inst).toBeDefined();
  const sess = db.get<{ token_hash: string }>("SELECT token_hash FROM web_sessions WHERE token_hash = ?", ["sess_hash1"]);
  expect(sess).toBeDefined();
  db.close();
});

test("node:sqlite emulation: initSchema leaves foreign_keys OFF after completion", async () => {
  const db = await createSqlDriver(":memory:");
  seedLegacyDb(db);
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  // initSchema must leave FKs disabled (the invariant the codebase depends on).
  const fk = db.get<{ foreign_keys: number }>("PRAGMA foreign_keys");
  expect(fk?.foreign_keys).toBe(0);
  db.close();
});

test("half-rename recovery: accounts_new exists, accounts missing → migration completes", async () => {
  const db = await createSqlDriver(":memory:");
  // Simulate a crash after DROP accounts but before RENAME accounts_new -> accounts:
  // accounts_new (new shape, with a row) exists, accounts does NOT exist.
  db.exec(
    "CREATE TABLE accounts_new (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)"
  );
  db.run("INSERT INTO accounts_new (id, username, created_at) VALUES (?, ?, ?)", [
    "acc1", "alice", "2024-01-01T00:00:00Z",
  ]);
  initSchema(db);
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((row) => row.name);
  expect(tables).toContain("accounts");
  expect(tables).not.toContain("accounts_new");
  const acc = db.get<{ id: string; username: string }>(
    "SELECT id, username FROM accounts WHERE id = ?",
    ["acc1"]
  );
  expect(acc).toBeDefined();
  expect(acc!.username).toBe("alice");
  db.close();
});
