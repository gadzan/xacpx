import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AcpxCliTransport } from "../../src/transport/acpx-cli/acpx-cli-transport";
import { AcpxBridgeTransport } from "../../src/transport/acpx-bridge/acpx-bridge-transport";
import { spawnAcpxBridgeClient } from "../../src/transport/acpx-bridge/acpx-bridge-client";
import { resolveAcpxCommand } from "../../src/config/resolve-acpx-command";
import { deriveAgentAlias, renderAgentArgvIdentity } from "../../src/config/agent-launch";
import { migrateSessionArgvFile } from "../../src/transport/acpx-session-argv-migration";
import { reapQueueOwners } from "../../src/transport/queue-owner-reaper";
import { terminateProcessTree } from "../../src/process/terminate-process-tree";
import { readQueueOwnerPid, terminateAcpxQueueOwner } from "../../src/transport/acpx-queue-owner-launcher";
import { resolveBridgeEntryPath } from "../../src/main";
import type { ResolvedSession, SessionTransport } from "../../src/transport/types";

// Real-target compat smoke: runs the npm-installed acpx against a mock ACP agent
// in an isolated HOME. No WeChat, no credentials, no network beyond npm.

const MOCK_AGENT = fileURLToPath(new URL("../fixtures/mock-acp-agent.mjs", import.meta.url));
const ACPX = resolveAcpxCommand({ configuredCommand: undefined });

// Boundary torture: path with spaces, argument with spaces, backslash, empty
// string, and a Windows-style path on every platform.
const BOUNDARY_ARGV = ["node", MOCK_AGENT, "--acp", "arg with space", "back\\slash", "", "C:\\Program Files\\x"];
const BOUNDARY_ALIAS = deriveAgentAlias("custom", BOUNDARY_ARGV);
const BOUNDARY_IDENTITY = renderAgentArgvIdentity(BOUNDARY_ARGV);

interface Harness {
  home: string;
  ws: string;
  acpxDir: string;
  sessionsDir: string;
  dispose: () => Promise<void>;
}

const savedEnv = new Map<string, string | undefined>();

async function makeHarness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "xacpx-compat-home-"));
  const ws = await mkdtemp(join(tmpdir(), "xacpx-compat-ws-"));
  for (const key of ["HOME", "USERPROFILE"]) {
    savedEnv.set(key, process.env[key]);
  }
  process.env.HOME = home;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  return {
    home,
    ws,
    acpxDir: join(home, ".acpx"),
    sessionsDir: join(home, ".acpx", "sessions"),
    dispose: async () => {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      savedEnv.clear();
      await rm(home, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    },
  };
}

async function writeOverlay(h: Harness, alias: string, argv: string[]): Promise<void> {
  await mkdir(h.acpxDir, { recursive: true });
  await writeFile(join(h.acpxDir, "config.json"), `${JSON.stringify({
    agents: { [alias]: { argv } },
  }, null, 2)}\n`);
}

function session(alias: string, argv: string[], h: Harness, extra: Partial<ResolvedSession> = {}): ResolvedSession {
  return {
    alias,
    agent: "custom",
    acpxAgent: deriveAgentAlias("custom", argv),
    agentCommand: renderAgentArgvIdentity(argv),
    agentArgv: argv,
    driver: "custom",
    workspace: "ws",
    transportSession: alias,
    cwd: h.ws,
    ...extra,
  };
}

function parseEchoArgv(text: string): string[] {
  const line = text.split(/\r?\n/).find((l) => l.startsWith("argv="));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice("argv=".length)) as string[];
}

async function latestRecord(h: Harness): Promise<{ recordId: string; record: Record<string, unknown> }> {
  const files = (await readdir(h.sessionsDir)).filter((name) => name.endsWith(".json") && name !== "index.json");
  expect(files.length).toBeGreaterThan(0);
  const name = files.sort().at(-1)!;
  const recordId = decodeURIComponent(name.slice(0, -".json".length));
  return { recordId, record: JSON.parse(await readFile(join(h.sessionsDir, name), "utf8")) as Record<string, unknown> };
}

async function makeCliTransport(h: Harness): Promise<AcpxCliTransport> {
  return new AcpxCliTransport({
    command: ACPX,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    queueOwnerTtlSeconds: 5,
    sessionInitTimeoutMs: 60_000,
  });
}

async function makeBridgeTransport(h: Harness): Promise<SessionTransport> {
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

async function runLifecycle(transport: SessionTransport, h: Harness, label: string): Promise<void> {
  const spec = session(`${label}-demo`, BOUNDARY_ARGV, h);
  await writeOverlay(h, spec.acpxAgent!, BOUNDARY_ARGV);
  try {
    await transport.ensureSession(spec);

    const first = await transport.prompt(spec, "hello");
    // Exact boundaries: every payload argument arrives as ONE element, never
    // re-split (spaces, backslashes, empty strings, Windows-style paths).
    const echoed = parseEchoArgv(first.text);
    expect(echoed.length).toBe(BOUNDARY_ARGV.length);
    expect(echoed.slice(1)).toEqual(BOUNDARY_ARGV.slice(1));

    // Follow-up prompt reuses the same session and history.
    const second = await transport.prompt(spec, "follow-up");
    expect(second.text).toContain("reply=follow-up");

    const list = await transport.listAgentSessions?.({
      agent: spec.agent,
      acpxAgent: spec.acpxAgent,
      cwd: h.ws,
    });
    expect(list?.sessions.length).toBeGreaterThanOrEqual(1);

    // Canonical identity is what acpx persists — never the alias.
    const { record } = await latestRecord(h);
    expect(record.agent_command).toBe(BOUNDARY_IDENTITY);
    expect(record.agent_argv).toEqual(BOUNDARY_ARGV);

    const cancel = await transport.cancel(spec);
    expect(cancel.cancelled).toBe(true);

    await transport.removeSession?.(spec);
    // acpx keeps the record for history; close marks it closed rather than
    // deleting it, so `sessions show` still resolves it.
    const afterClose = await latestRecord(h);
    expect(afterClose.record.closed).toBe(true);
  } finally {
    await transport.dispose?.();
  }
}

test("acpx-cli lifecycle: ensure → prompt → follow-up → list → cancel → close, with exact argv boundaries", async () => {
  const h = await makeHarness();
  try {
    await runLifecycle(await makeCliTransport(h), h, "cli");
  } finally {
    await h.dispose();
  }
}, { timeout: 180_000 });

test("acpx-bridge lifecycle: ensure → prompt → follow-up → list → cancel → close, with exact argv boundaries", async () => {
  const h = await makeHarness();
  try {
    await runLifecycle(await makeBridgeTransport(h), h, "bridge");
  } finally {
    await h.dispose();
  }
}, { timeout: 180_000 });

test("legacy record without agent_argv is backfilled and resumed with the same record id", async () => {
  const h = await makeHarness();
  const legacyRecordId = "a1b2c3d4-1111-2222-3333-444455556666";
  try {
    const spec = session("legacy-demo", BOUNDARY_ARGV, h);
    await writeOverlay(h, spec.acpxAgent!, BOUNDARY_ARGV);

    // Seed a legacy record exactly like acpx <=0.12 wrote it: agent_command set,
    // agent_argv absent, identity matching the overlay argv.
    await mkdir(h.sessionsDir, { recursive: true });
    const legacy: Record<string, unknown> = {
      schema: "acpx.session.v1",
      acpx_record_id: legacyRecordId,
      acp_session_id: "legacy-acp-session",
      agent_command: BOUNDARY_IDENTITY,
      cwd: h.ws,
      name: "legacy-demo",
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
    await writeFile(join(h.sessionsDir, `${legacyRecordId}.json`), `${JSON.stringify(legacy, null, 2)}\n`);

    // First "daemon": migration runs during ensure and backfills the record.
    const transport1 = await makeCliTransport(h);
    try {
      await transport1.ensureSession(spec);
    } finally {
      await transport1.dispose?.();
    }
    const migrated = JSON.parse(
      await readFile(join(h.sessionsDir, `${legacyRecordId}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(migrated.agent_argv).toEqual(BOUNDARY_ARGV);
    expect(migrated.acpx_record_id).toBe(legacyRecordId);
    expect(migrated.agent_command).toBe(BOUNDARY_IDENTITY);

    // "Restart": a fresh transport resumes the SAME record id and prompts.
    const transport2 = await makeCliTransport(h);
    try {
      await transport2.ensureSession(spec);
      const reply = await transport2.prompt(spec, "after-restart");
      expect(reply.text).toContain("reply=after-restart");
      const { recordId, record } = await latestRecord(h);
      expect(recordId).toBe(legacyRecordId);
      expect(record.acp_session_id).toBe("legacy-acp-session");
    } finally {
      await transport2.dispose?.();
    }
  } finally {
    // `acpx prompt --ttl` spawns its own owner even without a coordinator; free it.
    await terminateAcpxQueueOwner(legacyRecordId).catch(() => {});
    await h.dispose();
  }
}, { timeout: 180_000 });

test("mcpCoordinatorSession spawns a warm queue owner that the second turn reuses, and the reaper frees it without closing the session", async () => {
  const h = await makeHarness();
  const transport = await makeCliTransport(h);
  try {
    const spec = session("warm-demo", BOUNDARY_ARGV, h, { mcpCoordinatorSession: "coord-1" });
    await writeOverlay(h, spec.acpxAgent!, BOUNDARY_ARGV);

    await transport.ensureSession(spec);
    const first = await transport.prompt(spec, "warm-up");
    expect(first.text).toContain("reply=warm-up");

    const { recordId } = await latestRecord(h);
    const ownerPid1 = await readQueueOwnerPid(recordId);
    expect(ownerPid1).toBeDefined();

    const second = await transport.prompt(spec, "second-turn");
    expect(second.text).toContain("reply=second-turn");
    const ownerPid2 = await readQueueOwnerPid(recordId);
    expect(ownerPid2).toBe(ownerPid1);

    // Reaper terminates the owner by record id but does NOT close the session.
    const ownerBeforeReap = ownerPid1;
    const reaped = await reapQueueOwners(ACPX, [{
      agent: spec.agent,
      acpxAgent: spec.acpxAgent,
      cwd: spec.cwd,
      transportSession: spec.transportSession,
    }], { timeoutMs: 30_000 });
    expect(reaped.terminated).toBe(1);
    let ownerStillAlive = false;
    try { process.kill(ownerBeforeReap!, 0); ownerStillAlive = true; } catch { /* gone */ }
    console.log("[compat] after reap: pid=%s alive=%s", ownerBeforeReap, ownerStillAlive);

    const ownerAfter = await readQueueOwnerPid(recordId);
    expect(ownerAfter).toBeUndefined();

    // Session still open and promptable (cold start).
    const third = await transport.prompt(spec, "after-reap");
    expect(third.text).toContain("reply=after-reap");
  } finally {
    // The final prompt re-spawns an owner; free it so no process outlives the test.
    try {
      const recordId = (await latestRecord(h)).recordId;
      // The last prompt's owner may still be writing its lock; wait briefly so a
      // race cannot orphan the owner (and its mock agent) after the test ends.
      let pid: number | undefined;
      for (let attempt = 0; attempt < 20 && pid === undefined; attempt += 1) {
        pid = await readQueueOwnerPid(recordId);
        if (pid === undefined) await Bun.sleep(100);
      }
      console.log("[compat] cleanup record=%s pid=%s", recordId, pid ?? "none");
      if (pid !== undefined) {
        await terminateProcessTree(pid, { detachedProcessGroup: true });
      }
      await terminateAcpxQueueOwner(recordId);
    } catch {
      // best-effort; the owner expires on its own TTL
    }
    await transport.dispose?.();
    await h.dispose();
  }
}, { timeout: 180_000 });

test("migration rejects an identity mismatch and preserves the record", async () => {
  const h = await makeHarness();
  try {
    const recordId = "b2c3d4e5-2222-3333-4444-555566667777";
    const identity = renderAgentArgvIdentity(["node", "/elsewhere/agent.js"]);
    await mkdir(h.sessionsDir, { recursive: true });
    await writeFile(join(h.sessionsDir, `${recordId}.json`), `${JSON.stringify({
      schema: "acpx.session.v1",
      acpx_record_id: recordId,
      acp_session_id: "other",
      agent_command: identity,
      cwd: h.ws,
      name: "other",
      created_at: "2026-08-05T00:00:00.000Z",
      last_used_at: "2026-08-05T00:00:00.000Z",
      last_seq: 0,
      event_log: [],
      messages: [],
      updated_at: "2026-08-05T00:00:00.000Z",
      cumulative_token_usage: {},
      request_token_usage: {},
      closed: false,
    }, null, 2)}\n`);

    const result = await migrateSessionArgvFile(recordId, {
      agentCommand: BOUNDARY_IDENTITY,
      agentArgv: BOUNDARY_ARGV,
    }, { sessionsDir: h.sessionsDir });
    expect(result.status).toBe("rejected");
    const record = JSON.parse(
      await readFile(join(h.sessionsDir, `${recordId}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(record.agent_argv).toBeUndefined();
  } finally {
    await h.dispose();
  }
});
