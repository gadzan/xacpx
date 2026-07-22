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
    return {
      exec: (sql) => db.exec(sql),
      run: (sql, params: SqlParams = []) => {
        db.query(sql).run(...(params as (string | number | null)[]));
      },
      get: <T>(sql: string, params: SqlParams = []) =>
        (db.query(sql).get(...(params as (string | number | null)[])) ?? undefined) as T | undefined,
      all: <T>(sql: string, params: SqlParams = []) =>
        db.query(sql).all(...(params as (string | number | null)[])) as T[],
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  // node:sqlite defaults enableForeignKeyConstraints to true (PRAGMA foreign_keys = ON).
  // The codebase invariant is FKs OFF (integrity is enforced by app-level manual cascades;
  // declared FK constraints are decorative). Match bun:sqlite's default explicitly.
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params: SqlParams = []) => {
      db.prepare(sql).run(...(params as (string | number | null)[]));
    },
    get: <T>(sql: string, params: SqlParams = []) =>
      (db.prepare(sql).get(...(params as (string | number | null)[])) ?? undefined) as T | undefined,
    all: <T>(sql: string, params: SqlParams = []) =>
      db.prepare(sql).all(...(params as (string | number | null)[])) as T[],
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
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      core_version TEXT,
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
      queue_item_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (instance_id, session_alias, id);
  `);

  // Idempotent column add for pre-existing local dev DBs (create-only schema otherwise).
  const messageCols = db.all<{ name: string }>("PRAGMA table_info(messages)");
  if (!messageCols.some((c) => c.name === "attachments")) {
    db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
  }
  if (!messageCols.some((c) => c.name === "queue_item_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN queue_item_id TEXT");
  }
}
