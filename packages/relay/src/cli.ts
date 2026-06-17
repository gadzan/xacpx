import { generateToken } from "./auth.js";
import { createRelayRuntime, startRelayServer } from "./server.js";

export interface RelayCliIo {
  print(line: string): void;
}

const USAGE = [
  "Usage: xacpx-relay <command>",
  "  start       --db <path> [--http-port 8787] [--ws-port 8788] [--host 0.0.0.0] [--web-root <dir>] [--history-retention-days <n>] [--request-timeout-ms 120000] [--trust-proxy]",
  "  init-admin  --username <name> [--password <pw>] --db <path>",
  "  token new   --account <username> [--name <label>] [--ttl-minutes 10] --db <path>",
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
  const dbPath = flag(args, "--db") ?? "./relay.db";
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
  const dbPath = flag(args, "--db") ?? "./relay.db";

  if (args[0] === "init-admin") {
    const username = flag(args, "--username");
    if (!username) {
      io.print(USAGE);
      return 1;
    }
    const runtime = await createRelayRuntime(dbPath);
    try {
      if (runtime.accounts.findByUsername(username)) {
        io.print(`account already exists: ${username}`);
        return 1;
      }
      const password = flag(args, "--password") ?? generateToken().slice(0, 16);
      runtime.accounts.createAccount(username, password, "admin");
      io.print(`admin account created: ${username}`);
      io.print(`password: ${password}`);
      io.print("(store it now — it is not shown again)");
      return 0;
    } finally {
      runtime.close();
    }
  }

  if (args[0] === "token" && args[1] === "new") {
    const username = flag(args, "--account");
    if (!username) {
      io.print(USAGE);
      return 1;
    }
    const runtime = await createRelayRuntime(dbPath);
    try {
      const account = runtime.accounts.findByUsername(username);
      if (!account) {
        io.print(`no such account: ${username}`);
        return 1;
      }
      const ttlMinutes = Number(flag(args, "--ttl-minutes") ?? "10");
      const issued = runtime.instances.issuePairingToken(account.id, flag(args, "--name"), ttlMinutes * 60_000);
      io.print(`pairing token: ${issued.token}`);
      io.print(`expires at: ${issued.expiresAt}`);
      io.print(`pair with: xacpx channel add relay --url ws://<relay-host>:<ws-port> --token <the-token>`);
      return 0;
    } finally {
      runtime.close();
    }
  }

  if (args[0] === "start") {
    const startOpts = parseStartOptions(args);
    const running = await startRelayServer(startOpts);
    io.print(`xacpx-relay listening: http :${running.httpPort}, instance ws :${running.wsPort}, db ${startOpts.dbPath}`);
    return await new Promise<number>((resolve) => {
      const shutdown = () => {
        void running.close().then(() => resolve(0));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
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
