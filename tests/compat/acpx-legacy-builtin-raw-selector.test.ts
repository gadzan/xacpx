/**
 * Windows legacy raw `--agent` selector vs acpx@0.13.0.
 *
 * Proves historical built-in sessions resume when xacpx passes only the raw
 * command as selector — no xacpx-managed migration overlay, no guessed argv.
 * Parameterized over acpx-cli and the default acpx-bridge path.
 *
 * Case A: built-in `agent_command` ("kimi acp") without `agent_argv` → success.
 * Case B: custom raw without argv → acpx fail-closed.
 */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAcpxCommand } from "../../src/config/resolve-acpx-command";
import { resolveBridgeEntryPath } from "../../src/main";
import { AcpxBridgeTransport } from "../../src/transport/acpx-bridge/acpx-bridge-transport";
import { spawnAcpxBridgeClient } from "../../src/transport/acpx-bridge/acpx-bridge-client";
import { AcpxCliTransport } from "../../src/transport/acpx-cli/acpx-cli-transport";
import { terminateAcpxQueueOwner } from "../../src/transport/acpx-queue-owner-launcher";
import type { ResolvedSession, SessionTransport } from "../../src/transport/types";

const MOCK_AGENT = fileURLToPath(new URL("../fixtures/mock-acp-agent.mjs", import.meta.url));
const ACPX = resolveAcpxCommand({ configuredCommand: undefined });

type TransportKind = "cli" | "bridge";

// Windows queue-owner IPC pipes are keyed by record id globally (not per HOME),
// so CLI and bridge cases must not share ids or the second run hits generation /
// listen races against a leftover owner from the first.
const RECORD_IDS: Record<TransportKind, { legacy: string; custom: string }> = {
  cli: {
    legacy: "b2c3d4e5-1111-2222-3333-444455556666",
    custom: "c3d4e5f6-1111-2222-3333-444455556666",
  },
  bridge: {
    legacy: "d4e5f6a7-2222-3333-4444-555566667777",
    custom: "e5f6a7b8-3333-4444-5555-666677778888",
  },
};

interface Harness {
  home: string;
  ws: string;
  bin: string;
  acpxDir: string;
  sessionsDir: string;
  dispose: () => Promise<void>;
}

const savedEnv = new Map<string, string | undefined>();

async function makeHarness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "xacpx-legacy-raw-home-"));
  const ws = await mkdtemp(join(tmpdir(), "xacpx-legacy-raw-ws-"));
  const bin = await mkdtemp(join(tmpdir(), "xacpx-legacy-raw-bin-"));
  for (const key of ["HOME", "USERPROFILE", "PATH"]) {
    savedEnv.set(key, process.env[key]);
  }
  process.env.HOME = home;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
  return {
    home,
    ws,
    bin,
    acpxDir: join(home, ".acpx"),
    sessionsDir: join(home, ".acpx", "sessions"),
    dispose: async () => {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      savedEnv.clear();
      for (const dir of [home, ws, bin]) {
        for (let attempt = 0; attempt < 15; attempt += 1) {
          try {
            await rm(dir, { recursive: true, force: true });
            break;
          } catch {
            await Bun.sleep(200);
          }
        }
      }
    },
  };
}

/** Windows/Unix shim so `["kimi","acp"]` launches the mock ACP agent. */
async function installKimiShim(bin: string): Promise<void> {
  if (process.platform === "win32") {
    await writeFile(
      join(bin, "kimi.cmd"),
      `@echo off\r\nnode "${MOCK_AGENT}" %*\r\n`,
      "utf8",
    );
    return;
  }
  await writeFile(join(bin, "kimi"), `#!/usr/bin/env bash\nexec node "${MOCK_AGENT}" "$@"\n`, {
    mode: 0o755,
  });
}

async function plantLegacyRecord(
  h: Harness,
  params: {
    recordId: string;
    name: string;
    agentCommand: string;
    agentArgv?: string[];
  },
): Promise<void> {
  await mkdir(h.sessionsDir, { recursive: true });
  const record: Record<string, unknown> = {
    schema: "acpx.session.v1",
    acpx_record_id: params.recordId,
    acp_session_id: "legacy-builtin-acp-session",
    agent_command: params.agentCommand,
    cwd: h.ws,
    name: params.name,
    created_at: "2026-08-05T00:00:00.000Z",
    last_used_at: "2026-08-05T00:00:00.000Z",
    last_seq: 0,
    event_log: [],
    messages: [],
    updated_at: "2026-08-05T00:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {},
    closed: false,
  };
  if (params.agentArgv) {
    record.agent_argv = params.agentArgv;
  }
  await writeFile(
    join(h.sessionsDir, `${params.recordId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function rawSelectorSession(
  h: Harness,
  name: string,
  rawCommand: string,
): ResolvedSession {
  return {
    alias: name,
    agent: "kimi",
    driver: "kimi",
    rawCommand,
    agentCommand: rawCommand,
    // Deliberately omit acpxAgent + agentArgv: selector only.
    workspace: "ws",
    transportSession: name,
    cwd: h.ws,
  };
}

async function readAcpxConfig(h: Harness): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(h.acpxDir, "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function managedAliases(config: Record<string, unknown> | null): string[] {
  const agents = config?.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return [];
  return Object.keys(agents as Record<string, unknown>).filter((name) =>
    name.startsWith("xacpx-managed-"),
  );
}

async function readRecord(h: Harness, recordId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(h.sessionsDir, `${recordId}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

async function makeTransport(kind: TransportKind): Promise<SessionTransport> {
  if (kind === "cli") {
    return new AcpxCliTransport({
      command: ACPX,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      queueOwnerTtlSeconds: 5,
      sessionInitTimeoutMs: 60_000,
    });
  }
  const client = await spawnAcpxBridgeClient({
    acpxCommand: ACPX,
    bridgeEntryPath: resolveBridgeEntryPath(),
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    queueOwnerTtlSeconds: 5,
    sessionInitTimeoutMs: 60_000,
  });
  return new AcpxBridgeTransport(client);
}

const TRANSPORTS: TransportKind[] = ["cli", "bridge"];

for (const kind of TRANSPORTS) {
  test(`Case A (${kind}): Windows legacy built-in raw selector resumes via acpx 0.13 backfill (no managed overlay)`, async () => {
    // Windows-first: skip elsewhere so CI Unix stays green.
    if (process.platform !== "win32") {
      return;
    }

    const recordId = RECORD_IDS[kind].legacy;
    const h = await makeHarness();
    const sessionName = `legacy-kimi-${kind}`;
    try {
      await installKimiShim(h.bin);
      await plantLegacyRecord(h, {
        recordId,
        name: sessionName,
        agentCommand: "kimi acp",
        // agent_argv intentionally absent
      });

      // Config override must NOT redirect the historical selector.
      await mkdir(h.acpxDir, { recursive: true });
      await writeFile(
        join(h.acpxDir, "config.json"),
        `${JSON.stringify({
          agents: {
            kimi: { argv: ["different-kimi", "--acp"] },
          },
        }, null, 2)}\n`,
      );

      expect(managedAliases(await readAcpxConfig(h))).toEqual([]);

      const transport = await makeTransport(kind);
      try {
        const spec = rawSelectorSession(h, sessionName, "kimi acp");
        await transport.ensureSession(spec);

        const cold = await transport.prompt(spec, "cold-start");
        expect(cold.text).toContain("reply=cold-start");
        // Spawn used structured argv ["kimi","acp"] (shim + "acp"), not a raw string split.
        expect(cold.text).toContain('"acp"');

        const afterCold = await readRecord(h, recordId);
        expect(afterCold.acpx_record_id).toBe(recordId);
        expect(afterCold.agent_command).toBe("kimi acp");
        expect(afterCold.acp_session_id).toBe("legacy-builtin-acp-session");

        const warm = await transport.prompt(spec, "warm-reuse");
        expect(warm.text).toContain("reply=warm-reuse");

        const afterWarm = await readRecord(h, recordId);
        expect(afterWarm.acpx_record_id).toBe(recordId);
      } finally {
        await transport.dispose?.();
      }

      expect(managedAliases(await readAcpxConfig(h))).toEqual([]);
      const recordFiles = (await readdir(h.sessionsDir)).filter(
        (name) => name.endsWith(".json") && name !== "index.json",
      );
      expect(recordFiles).toContain(`${recordId}.json`);
    } finally {
      await terminateAcpxQueueOwner(recordId).catch(() => {});
      await h.dispose();
    }
  }, { timeout: 180_000 });

  test(`Case B (${kind}): Windows custom raw without argv still fail-closed in acpx (no guessed overlay)`, async () => {
    if (process.platform !== "win32") {
      return;
    }

    const recordId = RECORD_IDS[kind].custom;
    const h = await makeHarness();
    const sessionName = `legacy-custom-${kind}`;
    const raw = "some-custom-agent --foo";
    try {
      await plantLegacyRecord(h, {
        recordId,
        name: sessionName,
        agentCommand: raw,
      });

      const transport = await makeTransport(kind);
      try {
        const spec = rawSelectorSession(h, sessionName, raw);
        // Ensure may succeed (record lookup only); the spawn path must fail closed.
        await transport.ensureSession(spec);

        let message = "";
        try {
          await transport.prompt(spec, "should-fail");
          expect.unreachable("custom raw without argv must fail on Windows");
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        // Bridge wraps the owner exit; accept either the acpx spawn guidance or
        // a queue-owner start failure that still proves no managed overlay.
        expect(message.toLowerCase()).toMatch(
          /argv|raw agent command|windows|queue owner|failed to start/,
        );
        expect(message).not.toMatch(/xacpx-managed-/);
      } finally {
        await transport.dispose?.();
      }

      expect(managedAliases(await readAcpxConfig(h))).toEqual([]);
      const after = await readRecord(h, recordId);
      expect(after.acpx_record_id).toBe(recordId);
      expect(after.agent_command).toBe(raw);
      expect(after.agent_argv).toBeUndefined();
    } finally {
      await terminateAcpxQueueOwner(recordId).catch(() => {});
      await h.dispose();
    }
  }, { timeout: 180_000 });
}

test("sanity: installed acpx is 0.13.x (spike depends on built-in backfill)", async () => {
  const versionFile = join(process.cwd(), "node_modules", "acpx", "package.json");
  const pkg = JSON.parse(await readFile(versionFile, "utf8")) as { version: string };
  expect(pkg.version.startsWith("0.13.")).toBe(true);
  expect(ACPX.length).toBeGreaterThan(0);
});
