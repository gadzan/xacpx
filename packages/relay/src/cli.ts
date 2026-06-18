import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createRelayRuntime, startRelayServer } from "./server.js";

export interface RelayCliIo {
  print(line: string): void;
}

/** Fixed absolute default DB path — independent of cwd so `add token` and `start` always hit the same DB. */
export function defaultDbPath(): string {
  return join(homedir(), ".xacpx-relay", "relay.db");
}

/**
 * Locates the bundled relay-web dashboard relative to the compiled cli.js.
 * Returns the path only if `index.html` is present there; otherwise undefined.
 * Defensive: returns undefined if process.argv[1] is not set.
 */
export function resolveBundledWebRoot(): string | undefined {
  const argv1 = process.argv[1];
  if (!argv1) return undefined;
  if (!argv1.endsWith("cli.js")) return undefined;
  const here = dirname(argv1);
  const candidate = resolve(here, "../../relay-web/dist");
  return existsSync(join(candidate, "index.html")) ? candidate : undefined;
}

const USAGE = [
  "Usage: xacpx-relay <command>",
  "  start      [--db <path>] [--web-root <dir>] [--host 0.0.0.0] [--http-port 8787] [--ws-port 8788] [--history-retention-days 30] [--request-timeout-ms 120000] [--trust-proxy]",
  "  add token  [--label <note>] [--db <path>]",
  "  ls         [--db <path>]",
  "  rm token <value-or-id> [--db <path>]",
  "",
  "  Defaults: --db ~/.xacpx-relay/relay.db   --web-root auto-detects the bundled dashboard",
].join("\n");

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

/** Returns true if a presence-only boolean flag (e.g. --trust-proxy) appears in argv. */
function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export interface StartOptions {
  dbPath: string;
  httpPort: number;
  wsPort: number;
  host: string | undefined;
  webRoot: string | undefined;
  historyRetentionDays: number | undefined;
  requestTimeoutMs: number | undefined;
  trustProxy: boolean;
}

/** Pure arg-parser for the `start` subcommand — testable without starting a server. */
export function parseStartOptions(args: string[]): StartOptions {
  const dbPath = flag(args, "--db") ?? defaultDbPath();
  const retentionRaw = flag(args, "--history-retention-days");
  const retentionDays = retentionRaw !== undefined ? Number(retentionRaw) : undefined;
  const requestTimeoutRaw = flag(args, "--request-timeout-ms");
  const requestTimeoutMs = requestTimeoutRaw !== undefined ? Number(requestTimeoutRaw) : undefined;
  return {
    dbPath,
    httpPort: Number(flag(args, "--http-port") ?? "8787"),
    wsPort: Number(flag(args, "--ws-port") ?? "8788"),
    host: flag(args, "--host"),
    webRoot: flag(args, "--web-root"),
    historyRetentionDays: retentionDays !== undefined && !Number.isNaN(retentionDays) ? retentionDays : undefined,
    requestTimeoutMs: requestTimeoutMs !== undefined && !Number.isNaN(requestTimeoutMs) ? requestTimeoutMs : undefined,
    trustProxy: hasFlag(args, "--trust-proxy"),
  };
}

export async function runRelayCli(args: string[], io: RelayCliIo): Promise<number> {
  const dbPath = flag(args, "--db") ?? defaultDbPath();

  // start
  if (args[0] === "start") {
    const startOpts = parseStartOptions(args);
    if (!startOpts.webRoot) {
      startOpts.webRoot = resolveBundledWebRoot();
    }
    const running = await startRelayServer(startOpts);
    io.print(`xacpx-relay listening: http :${running.httpPort}, instance ws :${running.wsPort}, db ${startOpts.dbPath}, dashboard: ${startOpts.webRoot ?? "(none)"}`);
    return await new Promise<number>((resolve) => {
      const shutdown = () => {
        void running.close().then(() => resolve(0));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  }

  // add token [--label <l>] --db <path>
  if (args[0] === "add" && args[1] === "token") {
    const label = flag(args, "--label");
    const runtime = await createRelayRuntime(dbPath);
    try {
      const username = "u-" + randomUUID();
      const acc = runtime.accounts.createAccount(username);
      const { token } = runtime.accounts.createLoginToken(acc.id, label);
      io.print(`access token: ${token}`);
      io.print("(store it now — not shown again)");
      io.print(`hint: use this token for web login AND: xacpx channel add relay --url ws://<host>:<ws-port> --token ${token}`);
      return 0;
    } finally {
      runtime.close();
    }
  }

  // ls --db <path>
  if (args[0] === "ls") {
    const runtime = await createRelayRuntime(dbPath);
    try {
      const tokens = runtime.accounts.listTokens();
      if (tokens.length === 0) {
        io.print("(no tokens)");
        return 0;
      }
      io.print("id        label                 created               #instances");
      io.print("--------  --------------------  --------------------  ----------");
      for (const t of tokens) {
        const shortId = t.id.slice(0, 8);
        const label = (t.label ?? "").slice(0, 20).padEnd(20);
        const created = t.createdAt.slice(0, 19).replace("T", " ");
        io.print(`${shortId}  ${label}  ${created}  ${String(t.instanceCount).padStart(10)}`);
      }
      return 0;
    } finally {
      runtime.close();
    }
  }

  // rm token <value-or-id> --db <path>
  if (args[0] === "rm" && args[1] === "token") {
    const valueOrId = args[2];
    if (!valueOrId || valueOrId.startsWith("--")) {
      io.print(USAGE);
      return 1;
    }
    const runtime = await createRelayRuntime(dbPath);
    try {
      const accountId = runtime.accounts.accountIdForToken(valueOrId);
      if (!accountId) {
        io.print(`token not found: ${valueOrId}`);
        return 1;
      }
      runtime.accounts.deleteAccountCascade(accountId);
      io.print("removed");
      return 0;
    } finally {
      runtime.close();
    }
  }

  io.print(USAGE);
  return 1;
}

// bin entry: run only when executed directly, not when imported by tests.
const isMain = typeof process !== "undefined" && process.argv[1]?.endsWith("cli.js");
if (isMain) {
  runRelayCli(process.argv.slice(2), { print: (line) => console.log(line) }).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
