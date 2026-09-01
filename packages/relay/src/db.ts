// Minimal SQLite adapter: bun:sqlite when running under Bun (tests, optional
// deployment), node:sqlite under Node (primary deployment). node:sqlite is NOT
// implemented by Bun 1.3, hence the runtime switch.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params?: ReadonlyArray<string | number | null>): void;
  get<T>(sql: string, params?: ReadonlyArray<string | number | null>): T | undefined;
  all<T>(sql: string, params?: ReadonlyArray<string | number | null>): T[];
  /**
   * Run `fn` inside one SQLite transaction (BEGIN/COMMIT, ROLLBACK on throw).
   * NOT re-entrant: calling `transaction` from inside `fn` (or from a driver
   * method invoked within it) throws, so the outer transaction is never
   * corrupted by a nested BEGIN. All writes made by `fn` (via `run`/`exec`)
   * commit atomically — a crash or throw between them leaves NO partial rows,
   * which is what makes "messages + recovery receipt" a single durable unit.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

type SqlParams = ReadonlyArray<string | number | null>;

export async function createSqlDriver(path: string): Promise<SqlDriver> {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path);
    let inTransaction = false;
    return {
      exec: (sql) => db.exec(sql),
      run: (sql, params: SqlParams = []) => {
        db.query(sql).run(...(params as (string | number | null)[]));
      },
      get: <T>(sql: string, params: SqlParams = []) =>
        (db.query(sql).get(...(params as (string | number | null)[])) ?? undefined) as T | undefined,
      all: <T>(sql: string, params: SqlParams = []) =>
        db.query(sql).all(...(params as (string | number | null)[])) as T[],
      transaction: <T>(fn: () => T): T => {
        if (inTransaction) throw new Error("nested SQLite transaction");
        inTransaction = true;
        try {
          db.exec("BEGIN");
          const result = fn();
          db.exec("COMMIT");
          return result;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        } finally {
          inTransaction = false;
        }
      },
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  // node:sqlite defaults enableForeignKeyConstraints to true (PRAGMA foreign_keys = ON).
  // The codebase invariant is FKs OFF (integrity is enforced by app-level manual cascades;
  // declared FK constraints are decorative). Match bun:sqlite's default explicitly.
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  let inTransaction = false;
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params: SqlParams = []) => {
      db.prepare(sql).run(...(params as (string | number | null)[]));
    },
    get: <T>(sql: string, params: SqlParams = []) =>
      (db.prepare(sql).get(...(params as (string | number | null)[])) ?? undefined) as T | undefined,
    all: <T>(sql: string, params: SqlParams = []) =>
      db.prepare(sql).all(...(params as (string | number | null)[])) as T[],
    transaction: <T>(fn: () => T): T => {
      if (inTransaction) throw new Error("nested SQLite transaction");
      inTransaction = true;
      try {
        db.exec("BEGIN");
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        inTransaction = false;
      }
    },
    close: () => db.close(),
  };
}

export function initSchema(db: SqlDriver): void {
  // ── Fresh CREATE IF NOT EXISTS blocks ────────────────────────────────────
  // This is a create-only initSchema: there are no legacy DBs to migrate
  // (the package is unpublished; the single local DB is already on the current
  // schema). FKs are kept OFF via the driver option
  // (node:sqlite: enableForeignKeyConstraints: false; bun:sqlite: OFF by default).

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS login_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      label TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      login_token_id TEXT REFERENCES login_tokens(id),
      expires_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_web_sessions_login_token ON web_sessions(login_token_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_tokens (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      name TEXT,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS invite_codes (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      label TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      used_account_id TEXT REFERENCES accounts(id)
    );
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      core_version TEXT,
      capabilities_json TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL REFERENCES instances(id),
      session_alias TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      structured TEXT,
      attachments TEXT,
      queue_item_id TEXT,
      queue_fallback INTEGER NOT NULL DEFAULT 0,
      origin_queue_item_id TEXT,
      prompt_request_id TEXT,
      started_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (instance_id, session_alias, id);
    CREATE TABLE IF NOT EXISTS recovery_receipts (
      instance_id TEXT NOT NULL,
      recovery_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, recovery_id)
    );
    CREATE TABLE IF NOT EXISTS pending_completion_routes (
      request_message_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      source_instance_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      source_endpoint_id TEXT NOT NULL,
      target_instance_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      target_endpoint_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      account_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, endpoint)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions (endpoint);
  `);

  // Idempotent column add for pre-existing local dev DBs (create-only schema otherwise).
  // NOTE: the origin_queue_item_id INDEX must be created AFTER the ALTER below — a
  // pre-existing DB lacks the column, so creating the index up front would fail with
  // "no such column" before the migration ever runs.
  const messageCols = db.all<{ name: string }>("PRAGMA table_info(messages)");
  if (!messageCols.some((c) => c.name === "attachments")) {
    db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
  }
  if (!messageCols.some((c) => c.name === "queue_item_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN queue_item_id TEXT");
  }
  const routeCols = db.all<{ name: string }>("PRAGMA table_info(pending_completion_routes)");
  if (!routeCols.some((c) => c.name === "state")) {
    db.exec("ALTER TABLE pending_completion_routes ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'");
  }
  if (!messageCols.some((c) => c.name === "queue_fallback")) {
    db.exec("ALTER TABLE messages ADD COLUMN queue_fallback INTEGER NOT NULL DEFAULT 0");
  }
  if (!messageCols.some((c) => c.name === "origin_queue_item_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN origin_queue_item_id TEXT");
  }
  if (!messageCols.some((c) => c.name === "prompt_request_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN prompt_request_id TEXT");
  }
  if (!messageCols.some((c) => c.name === "started_at")) {
    db.exec("ALTER TABLE messages ADD COLUMN started_at INTEGER");
  }
  const instanceCols = db.all<{ name: string }>("PRAGMA table_info(instances)");
  if (!instanceCols.some((c) => c.name === "capabilities_json")) {
    db.exec("ALTER TABLE instances ADD COLUMN capabilities_json TEXT");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_origin_queue ON messages (instance_id, session_alias, origin_queue_item_id);
    CREATE INDEX IF NOT EXISTS idx_messages_prompt_request ON messages (prompt_request_id);
  `);
}
