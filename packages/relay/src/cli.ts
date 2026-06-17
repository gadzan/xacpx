import { createRelayRuntime, startRelayServer } from "./server.js";

export interface RelayCliIo {
  print(line: string): void;
}

const USAGE = [
  "Usage: xacpx-relay <command>",
  "  start        --db <path> [--http-port 8787] [--ws-port 8788] [--host 0.0.0.0] [--web-root <dir>] [--history-retention-days <n>] [--request-timeout-ms 120000] [--trust-proxy]",
  "  user new     --account <label> --db <path>",
  "  user token   --account <label> [--label <l>] --db <path>",
  "  user ls      --db <path>",
  "  user rm      --account <label> [--force] --db <path>",
  "  token revoke --id <login-token-id> --db <path>",
  "  pair         --account <label> [--name <l>] [--ttl-minutes 10] --db <path>",
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

  // user new --account <label> --db <path>
  if (args[0] === "user" && args[1] === "new") {
    const username = flag(args, "--account");
    if (!username) {
      io.print(USAGE);
      return 1;
    }
    const runtime = await createRelayRuntime(dbPath);
    try {
      let acc;
      try {
        acc = runtime.accounts.createAccount(username);
      } catch (e) {
        if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
          io.print(`account already exists: ${username}`);
          return 1;
        }
        throw e;
      }
      const { token } = runtime.accounts.createLoginToken(acc.id);
      io.print(`login token: ${token}`);
      io.print("(store it now — not shown again)");
      return 0;
    } finally {
      runtime.close();
    }
  }

  // user token --account <label> [--label <l>] --db <path>
  if (args[0] === "user" && args[1] === "token") {
    const username = flag(args, "--account");
    if (!username) {
      io.print(USAGE);
      return 1;
    }
    const runtime = await createRelayRuntime(dbPath);
    try {
      const acc = runtime.accounts.findByUsername(username);
      if (!acc) {
        io.print(`no such account: ${username}`);
        return 1;
      }
      const label = flag(args, "--label");
      const { token } = runtime.accounts.createLoginToken(acc.id, label);
      io.print(`login token: ${token}`);
      io.print("(store it now — not shown again)");
      return 0;
    } finally {
      runtime.close();
    }
  }

  // user ls --db <path>
  if (args[0] === "user" && args[1] === "ls") {
    const runtime = await createRelayRuntime(dbPath);
    try {
      const accounts = runtime.accounts.listAccounts();
      if (accounts.length === 0) {
        io.print("(no accounts)");
        return 0;
      }
      io.print("account               created               tokens  instances");
      io.print("--------------------  --------------------  ------  ---------");
      for (const a of accounts) {
        const created = a.createdAt.slice(0, 19).replace("T", " ");
        io.print(`${a.username.slice(0, 20).padEnd(20)}  ${created}  ${String(a.tokenCount).padStart(6)}  ${String(a.instanceCount).padStart(9)}`);
      }
      return 0;
    } finally {
      runtime.close();
    }
  }

  // user rm --account <label> [--force] --db <path>
  if (args[0] === "user" && args[1] === "rm") {
    const username = flag(args, "--account");
    if (!username) {
      io.print(USAGE);
      return 1;
    }
    const runtime = await createRelayRuntime(dbPath);
    try {
      const acc = runtime.accounts.findByUsername(username);
      if (!acc) {
        io.print(`no such account: ${username}`);
        return 1;
      }
      const n = runtime.accounts.countInstances(acc.id);
      if (n > 0 && !hasFlag(args, "--force")) {
        io.print(`account "${username}" owns ${n} instance(s). Use --force to delete anyway.`);
        return 1;
      }
      runtime.accounts.deleteAccountCascade(acc.id);
      io.print(`account "${username}" deleted`);
      return 0;
    } finally {
      runtime.close();
    }
  }

  // token revoke --id <login-token-id> --db <path>
  if (args[0] === "token" && args[1] === "revoke") {
    const tokenId = flag(args, "--id");
    if (!tokenId) {
      io.print(USAGE);
      return 1;
    }
    const runtime = await createRelayRuntime(dbPath);
    try {
      const ok = runtime.accounts.revokeLoginToken(tokenId);
      if (!ok) {
        io.print(`login token not found: ${tokenId}`);
        return 1;
      }
      io.print(`login token revoked: ${tokenId}`);
      return 0;
    } finally {
      runtime.close();
    }
  }

  // pair --account <label> [--name <l>] [--ttl-minutes 10] --db <path>
  if (args[0] === "pair") {
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
      const ttlRaw = flag(args, "--ttl-minutes") ?? "10";
      const ttlMinutes = Number(ttlRaw);
      if (Number.isNaN(ttlMinutes) || ttlMinutes <= 0) {
        io.print(`invalid --ttl-minutes value: ${ttlRaw}`);
        return 1;
      }
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
