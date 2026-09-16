// Minimal SQLite adapter copied from the relay hub pattern: bun:sqlite under
// Bun (tests), node:sqlite under Node. Do not import packages/relay from core.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, params?: ReadonlyArray<string | number | bigint | null>): void;
  get<T>(sql: string, params?: ReadonlyArray<string | number | bigint | null>): T | undefined;
  all<T>(sql: string, params?: ReadonlyArray<string | number | bigint | null>): T[];
  /**
   * Run `fn` inside one SQLite transaction. NOT re-entrant.
   * `immediate` uses BEGIN IMMEDIATE so concurrent writers serialize on the
   * reserved lock instead of racing `SELECT MAX(seq)+1` outside a write lock.
   */
  transaction<T>(fn: () => T, mode?: "deferred" | "immediate"): T;
  close(): void;
}

type SqlParams = ReadonlyArray<string | number | bigint | null>;

function beginSql(mode: "deferred" | "immediate"): string {
  return mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN";
}

function configurePragmas(exec: (sql: string) => void, path: string): void {
  exec("PRAGMA busy_timeout = 5000");
  exec("PRAGMA foreign_keys = OFF");
  if (path !== ":memory:") {
    exec("PRAGMA journal_mode = WAL");
    exec("PRAGMA synchronous = NORMAL");
  }
}

export async function createSqlDriver(path: string): Promise<SqlDriver> {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path);
    configurePragmas((sql) => db.exec(sql), path);
    let inTransaction = false;
    return {
      exec: (sql) => db.exec(sql),
      run: (sql, params: SqlParams = []) => {
        db.query(sql).run(...(params as (string | number | bigint | null)[]));
      },
      get: <T>(sql: string, params: SqlParams = []) =>
        (db.query(sql).get(...(params as (string | number | bigint | null)[])) ?? undefined) as T | undefined,
      all: <T>(sql: string, params: SqlParams = []) =>
        db.query(sql).all(...(params as (string | number | bigint | null)[])) as T[],
      transaction: <T>(fn: () => T, mode: "deferred" | "immediate" = "immediate"): T => {
        if (inTransaction) throw new Error("nested SQLite transaction");
        inTransaction = true;
        try {
          db.exec(beginSql(mode));
          const result = fn();
          db.exec("COMMIT");
          return result;
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // The BEGIN itself may have failed (SQLITE_BUSY); ROLLBACK is then a no-op error.
          }
          throw err;
        } finally {
          inTransaction = false;
        }
      },
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  configurePragmas((sql) => db.exec(sql), path);
  let inTransaction = false;
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params: SqlParams = []) => {
      db.prepare(sql).run(...(params as (string | number | bigint | null)[]));
    },
    get: <T>(sql: string, params: SqlParams = []) =>
      (db.prepare(sql).get(...(params as (string | number | bigint | null)[])) ?? undefined) as T | undefined,
    all: <T>(sql: string, params: SqlParams = []) =>
      db.prepare(sql).all(...(params as (string | number | bigint | null)[])) as T[],
    transaction: <T>(fn: () => T, mode: "deferred" | "immediate" = "immediate"): T => {
      if (inTransaction) throw new Error("nested SQLite transaction");
      inTransaction = true;
      try {
        db.exec(beginSql(mode));
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // BEGIN may have failed.
        }
        throw err;
      } finally {
        inTransaction = false;
      }
    },
    close: () => db.close(),
  };
}

export function isSqliteUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}
