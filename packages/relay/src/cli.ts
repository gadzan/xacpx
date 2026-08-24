#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createRelayRuntime, startRelayServer } from "./server.js";
import { handleRelayUpdate } from "./cli-update.js";
import { createRelayLogger } from "./logging.js";
import { vapidFromEnv, type VapidConfig } from "./push.js";
import webpush from "web-push";

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
 *
 * Resolves against this module's own URL (import.meta.url), NOT process.argv[1]:
 * when invoked via the global `xacpx-relay` bin symlink, argv[1] is the symlink
 * path (…/bin/xacpx-relay), not the real cli.js, so an argv-based path would
 * mis-resolve. The `cliJsPath` param exists only for tests.
 */
export function resolveBundledWebRoot(cliJsPath: string = fileURLToPath(import.meta.url)): string | undefined {
  const here = dirname(cliJsPath);
  // 1. Embedded copy shipped inside the published package: build:relay copies
  //    packages/relay-web/dist into dist/relay-web (a sibling of cli.js). This is
  //    the path that exists after `npm i -g @ganglion/xacpx-relay`.
  const embedded = resolve(here, "relay-web");
  if (existsSync(join(embedded, "index.html"))) return embedded;
  // 2. Monorepo sibling — running cli.js straight from source before the embed
  //    copy step has run (e.g. `bun run build:relay` partially, or dev tooling).
  const sibling = resolve(here, "../../relay-web/dist");
  if (existsSync(join(sibling, "index.html"))) return sibling;
  return undefined;
}

const USAGE = [
  "Usage: xacpx-relay <command>",
  "  start      [--db <path>] [--web-root <dir>] [--host 0.0.0.0] [--http-port 8787] [--ws-port <n>] [--history-retention-days 30] [--request-timeout-ms 120000] [--trust-proxy]",
  "             (--ws-port omitted = gateway merged onto the HTTP port; pass it only for a dedicated gateway port)",
  "             [--vapid-subject <s>] [--vapid-public-key <k>] [--vapid-private-key <k>]   (web push; or env XACPX_RELAY_VAPID_*)",
  "  add token  [--label <note>] [--db <path>]",
  "  add invite [--label <note>] [--ttl <n>{m|h|d}] [--url <base>] [--db <path>]",
  "  ls         [--db <path>]",
  "  rm token <value-or-id> [--db <path>]",
  "  rm invite <code-or-id> [--db <path>]",
  "  push-keys generate   (print a VAPID keypair for web push)",
  "  update     [--check]   (self-update @ganglion/xacpx-relay; --check only reports)",
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

/**
 * Parses an invite TTL like "30m", "12h", "7d" into milliseconds.
 * Returns null for malformed input; undefined input yields the 7-day default.
 * Capped at 10 years — beyond that Date arithmetic overflows the ECMAScript
 * time range and toISOString() throws instead of printing usage.
 */
export function parseTtlMs(raw: string | undefined): number | null {
  if (raw === undefined) return 7 * 24 * 60 * 60 * 1000;
  const match = /^(\d+)([mhd])$/.exec(raw);
  if (!match) return null;
  const n = Number(match[1]);
  if (n <= 0) return null;
  const unit = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  const ms = n * unit;
  const maxMs = 10 * 365 * 86_400_000;
  return ms > maxMs ? null : ms;
}

export interface StartOptions {
  dbPath: string;
  httpPort: number;
  /** Dedicated gateway port; undefined (default) merges the gateway onto the HTTP port. */
  wsPort: number | undefined;
  host: string | undefined;
  webRoot: string | undefined;
  historyRetentionDays: number | undefined;
  requestTimeoutMs: number | undefined;
  trustProxy: boolean;
  vapidSubject: string | undefined;
  vapidPublicKey: string | undefined;
  vapidPrivateKey: string | undefined;
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
    wsPort: flag(args, "--ws-port") !== undefined ? Number(flag(args, "--ws-port")) : undefined,
    host: flag(args, "--host"),
    webRoot: flag(args, "--web-root"),
    historyRetentionDays: retentionDays !== undefined && !Number.isNaN(retentionDays) ? retentionDays : undefined,
    requestTimeoutMs: requestTimeoutMs !== undefined && !Number.isNaN(requestTimeoutMs) ? requestTimeoutMs : undefined,
    trustProxy: hasFlag(args, "--trust-proxy"),
    vapidSubject: flag(args, "--vapid-subject"),
    vapidPublicKey: flag(args, "--vapid-public-key"),
    vapidPrivateKey: flag(args, "--vapid-private-key"),
  };
}
export async function runRelayCli(args: string[], io: RelayCliIo): Promise<number> {
  const dbPath = flag(args, "--db") ?? defaultDbPath();


  // push-keys generate — print a VAPID keypair for web push configuration.
  if (args[0] === "push-keys" && args[1] === "generate") {
    const keys = webpush.generateVAPIDKeys();
    io.print(JSON.stringify({ subject: "mailto:you@example.com", publicKey: keys.publicKey, privateKey: keys.privateKey }, null, 2));
    io.print("Set via env XACPX_RELAY_VAPID_SUBJECT / XACPX_RELAY_VAPID_PUBLIC_KEY / XACPX_RELAY_VAPID_PRIVATE_KEY or start flags --vapid-*.");
    return 0;
  }

  // start
  if (args[0] === "start") {
    const startOpts = parseStartOptions(args);
    if (!startOpts.webRoot) {
      startOpts.webRoot = resolveBundledWebRoot();
    }
    const logger = createRelayLogger();
    const vapidFromFlags = startOpts.vapidPublicKey && startOpts.vapidPrivateKey
      ? {
          subject: startOpts.vapidSubject ?? vapidFromEnv(process.env)?.subject ?? "mailto:relay@localhost",
          publicKey: startOpts.vapidPublicKey,
          privateKey: startOpts.vapidPrivateKey,
        }
      : (vapidFromEnv(process.env) as VapidConfig | null);
    const running = await startRelayServer({ ...startOpts, vapid: vapidFromFlags, logger });
    const gatewayDesc = running.wsPort !== null
      ? `instance ws :${running.wsPort}`
      : `instance gateway: merged on http :${running.httpPort} (path / or /gateway)`;
    io.print(`xacpx-relay listening: http :${running.httpPort}, ${gatewayDesc}, db ${startOpts.dbPath}, dashboard: ${startOpts.webRoot ?? "(none)"}`);
    logger.info("relay.start", "relay hub listening", {
      httpPort: running.httpPort,
      wsPort: running.wsPort,
      dbPath: startOpts.dbPath,
      dashboard: Boolean(startOpts.webRoot),
    });
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
      io.print(`hint: use this token for web login AND: xacpx channel add relay --url <host> --token ${token}`);
      return 0;
    } finally {
      runtime.close();
    }
  }

  // add invite [--label <l>] [--ttl <n>{m|h|d}] [--url <base>] --db <path>
  if (args[0] === "add" && args[1] === "invite") {
    const label = flag(args, "--label");
    const ttlRaw = flag(args, "--ttl");
    // A bare --ttl with a missing/flag-like value must error, not silently
    // fall back to the 7-day default — the lifetime is security-relevant.
    if (hasFlag(args, "--ttl") && ttlRaw === undefined) {
      io.print(USAGE);
      return 1;
    }
    const ttlMs = parseTtlMs(ttlRaw);
    if (ttlMs === null) {
      io.print(USAGE);
      return 1;
    }
    const runtime = await createRelayRuntime(dbPath);
    try {
      const { code, expiresAt } = runtime.accounts.issueInviteCode(label, ttlMs);
      io.print(`invite code: ${code}`);
      const baseUrl = flag(args, "--url");
      if (baseUrl) {
        io.print(`redeem link: ${baseUrl.replace(/\/+$/, "")}/invite/${code}`);
      } else {
        io.print(`redeem path: /invite/${code}   (append to your hub URL)`);
      }
      io.print(`(share it now — single-use, not shown again; expires ${expiresAt.slice(0, 16).replace("T", " ")} UTC)`);
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
      } else {
        io.print("id        label                 created               #instances");
        io.print("--------  --------------------  --------------------  ----------");
        for (const t of tokens) {
          const shortId = t.id.slice(0, 8);
          const label = (t.label ?? "").slice(0, 20).padEnd(20);
          const created = t.createdAt.slice(0, 19).replace("T", " ");
          io.print(`${shortId}  ${label}  ${created}  ${String(t.instanceCount).padStart(10)}`);
        }
      }
      const invites = runtime.accounts.listInviteCodes();
      if (invites.length > 0) {
        const nowMs = Date.now();
        io.print("");
        io.print("invites");
        io.print("id        label                 expires (UTC)         status");
        io.print("--------  --------------------  --------------------  -------");
        for (const inv of invites) {
          const shortId = inv.id.slice(0, 8);
          const label = (inv.label ?? "").slice(0, 20).padEnd(20);
          const expires = inv.expiresAt.slice(0, 19).replace("T", " ");
          const status = inv.usedAt !== null ? "used" : new Date(inv.expiresAt).getTime() <= nowMs ? "expired" : "unused";
          io.print(`${shortId}  ${label}  ${expires}  ${status}`);
        }
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
      runtime.pushSubscriptions.deleteByAccount(accountId);
      io.print("removed");
      return 0;
    } finally {
      runtime.close();
    }
  }

  // rm invite <code-or-id> --db <path>
  if (args[0] === "rm" && args[1] === "invite") {
    const valueOrId = args[2];
    if (!valueOrId || valueOrId.startsWith("--")) {
      io.print(USAGE);
      return 1;
    }
    const runtime = await createRelayRuntime(dbPath);
    try {
      const inviteId = runtime.accounts.inviteIdFor(valueOrId);
      if (!inviteId) {
        io.print(`invite not found: ${valueOrId}`);
        return 1;
      }
      runtime.accounts.removeInviteCode(inviteId);
      io.print("removed");
      return 0;
    } finally {
      runtime.close();
    }
  }

  // update [--check]
  if (args[0] === "update") {
    return await handleRelayUpdate(args.slice(1), { print: io.print });
  }

  io.print(USAGE);
  return 1;
}

// bin entry: run only when executed directly, not when imported by tests.
// Use import.meta.main (runtime "am I the entry?" flag) rather than sniffing
// process.argv[1]: the global bin is a symlink (…/bin/xacpx-relay), so argv[1]
// does not end with cli.js and the old check silently skipped the whole CLI.
if (import.meta.main) {
  runRelayCli(process.argv.slice(2), { print: (line) => console.log(line) }).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
