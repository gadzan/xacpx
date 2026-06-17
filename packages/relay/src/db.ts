// Minimal SQLite adapter: bun:sqlite when running under Bun (tests, optional
// deployment), node:sqlite under Node (primary deployment). node:sqlite is NOT
// implemented by Bun 1.3, hence the runtime switch.
export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params?: ReadonlyArray<string | number | null>): void;
  get<T>(sql: string, params?: ReadonlyArray<string | number | null>): T | undefined;
  all<T>(sql: string, params?: ReadonlyArray<string | number | null>): T[];
  close(): void;
}

type SqlParams = ReadonlyArray<string | number | null>;

export async function createSqlDriver(path: string): Promise<SqlDriver> {
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
  const db = new DatabaseSync(path);
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
  // Helper predicates used in migration guards below.
  // `t` is always an internal constant (PRAGMA can't be parameterized).
  const cols = (t: string) => db.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
  const tableExists = (t: string) =>
    !!db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]);

  // Recover a crashed accounts rebuild BEFORE the fresh CREATE blocks: if a
  // prior migration died after `DROP TABLE accounts` but before
  // `RENAME accounts_new -> accounts`, finish the rename now. This must run
  // first — otherwise the `CREATE TABLE IF NOT EXISTS accounts` below would
  // create an empty `accounts`, orphaning the real data in `accounts_new`.
  if (tableExists("accounts_new") && !tableExists("accounts")) {
    db.exec("ALTER TABLE accounts_new RENAME TO accounts");
  }

  // ── Fresh CREATE IF NOT EXISTS blocks ────────────────────────────────────
  // accounts: new shape — NO password_hash / role.
  // On a legacy DB this is a no-op (table already exists); the migration block
  // below handles rebuilding the legacy table.
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

  // Index co-located with the table for the fresh-DB path. Guarded on the
  // column existing because on a legacy DB web_sessions predates login_token_id
  // (it is added by the ALTER in the migration block below, which then also
  // (re)creates this index). Both creates are IF NOT EXISTS — running both is a
  // no-op.
  if (cols("web_sessions").includes("login_token_id")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_web_sessions_login_token ON web_sessions(login_token_id);
    `);
  }

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
      structured TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (instance_id, session_alias, id);
  `);

  // ── Migrations ───────────────────────────────────────────────────────────
  // SQLite DDL (CREATE/DROP/ALTER/RENAME TABLE) is fully transactional in every
  // journal mode, so this BEGIN/COMMIT makes the whole migration atomic: a
  // mid-migration crash rolls back cleanly, leaving no half-rebuilt schema.
  db.exec("BEGIN");
  try {
    // Migration 1: older deployments have `messages` without `structured`.
    const hasStructured = db
      .all<{ name: string }>("PRAGMA table_info(messages)")
      .some((c) => c.name === "structured");
    if (!hasStructured) {
      db.exec("ALTER TABLE messages ADD COLUMN structured TEXT");
    }

    // Migration 2: add login_token_id to web_sessions on an existing DB that
    // has the old shape. Plain TEXT — no REFERENCES clause (SQLite forbids
    // constraint-carrying ALTER ADD COLUMN).
    if (tableExists("web_sessions") && !cols("web_sessions").includes("login_token_id")) {
      db.exec("ALTER TABLE web_sessions ADD COLUMN login_token_id TEXT");
      // Ensure the index exists after adding the column.
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_web_sessions_login_token ON web_sessions(login_token_id)"
      );
    }

    // Migration 3: drop legacy invites table before rebuilding accounts (no FKs
    // are enforced, but drop it early to keep things clean).
    db.exec("DROP TABLE IF EXISTS invites");

    // Migration 4: rebuild accounts to drop password_hash / role columns.
    // The half-renamed case (accounts_new exists, accounts gone) is normally
    // already recovered by the early step at the top of initSchema; the
    // `halfRenamed` guard here is belt-and-suspenders for any residual state.
    const accountsCols = tableExists("accounts") ? cols("accounts") : [];
    const needsRebuild =
      accountsCols.includes("password_hash") || accountsCols.includes("role");
    const halfRenamed = tableExists("accounts_new") && !tableExists("accounts");
    if (needsRebuild || halfRenamed) {
      if (!halfRenamed) {
        db.exec(
          "CREATE TABLE IF NOT EXISTS accounts_new (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)"
        );
        db.exec(
          "INSERT INTO accounts_new (id, username, created_at) SELECT id, username, created_at FROM accounts"
        );
        db.exec("DROP TABLE accounts");
      }
      db.exec("ALTER TABLE accounts_new RENAME TO accounts");
    }

    // Ensure the index exists on both fresh and migrated DBs. This is a no-op
    // if Migration 2 already created it or if it was part of the fresh CREATE.
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_web_sessions_login_token ON web_sessions(login_token_id)"
    );

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
