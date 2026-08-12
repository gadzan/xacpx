import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  evaluateStateSessionArgvMigration,
  migrateStateAgentArgv,
  type AcpxRecordReader,
} from "../../../src/state/auto-migrate-agent-argv";
import type { LogicalSession } from "../../../src/state/types";
import { createNoopAppLogger } from "../../../src/logging/app-logger";
import {
  resolveManagedAdapterArgv,
  resolveManagedAdapterCommand,
} from "../../../src/adapters/adapter-catalog";
import { deriveAgentAlias } from "../../../src/config/agent-launch";

function sessionFixture(overrides: Partial<LogicalSession> = {}): LogicalSession {
  return {
    alias: "relay:demo",
    agent: "kimi",
    workspace: "demo",
    transport_session: "demo:relay:demo:reset-1",
    created_at: "2026-08-10T09:00:00.000Z",
    last_used_at: "2026-08-10T09:00:00.000Z",
    transport_agent_command: "kimi acp",
    ...overrides,
  };
}

test("pure: noop when transport_agent_argv + canonical acpx alias already present", () => {
  const argv = ["kimi", "acp"] as string[];
  const canonical = deriveAgentAlias("kimi", argv);
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({
      transport_agent_argv: argv,
      transport_acpx_agent: canonical,
    }),
    { driver: "kimi" },
    argv,
  );
  expect(result.status).toBe("noop");
});

test("pure: argv-only session is a repair backfill (not noop)", () => {
  const argv = ["kimi", "acp"] as string[];
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({ transport_agent_argv: argv }),
    { driver: "kimi" },
    argv,
  );
  expect(result.status).toBe("backfilled");
  expect(result.targetArgv).toEqual(argv);
});

test("pure: wrong/non-canonical alias is a repair backfill", () => {
  const argv = ["kimi", "acp"] as string[];
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({
      transport_agent_argv: argv,
      transport_acpx_agent: "kimi", // bare name — not owned
    }),
    { driver: "kimi" },
    argv,
  );
  expect(result.status).toBe("backfilled");
  expect(result.targetArgv).toEqual(argv);
});

test("pure: historical self-proving alias stays noop after current driver rename", () => {
  // Session migrated under driver=kimi; config later says driver=qwen.
  // Self-proof must not false-repair using the new driver.
  const argv = ["kimi", "acp"] as string[];
  const historical = deriveAgentAlias("kimi", argv);
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({
      agent: "foo",
      transport_agent_argv: argv,
      transport_acpx_agent: historical,
    }),
    { driver: "qwen" },
    undefined,
  );
  expect(result.status).toBe("noop");
});

test("pure: single-token command is backfillable as [command]", () => {
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({ transport_agent_command: "kimi" }),
    { driver: "kimi" },
    ["kimi", "acp"],
  );
  expect(result.status).toBe("backfilled");
  expect(result.targetArgv).toEqual(["kimi"]);
});

test("pure: noop when transport_agent_command is missing", () => {
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({ transport_agent_command: undefined }),
    { driver: "kimi" },
    ["kimi", "acp"],
  );
  expect(result.status).toBe("noop");
});

test("pure: rejected when agent is no longer configured", () => {
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({ agent: "ghost-agent" }),
    undefined,
    ["kimi", "acp"],
  );
  expect(result.status).toBe("rejected");
  expect(result.reason).toMatch(/ghost-agent/);
});

const defaultArgvResolver = (agentName: string): string[] | undefined => {
  if (agentName === "kimi") return ["kimi", "acp"];
  if (agentName === "qwen") return ["qwen", "acp"];
  if (agentName === "opencode") return ["opencode", "acp"];
  return undefined;
};

test("pure: backfilled from config argv when identity matches", () => {
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({ transport_agent_command: "kimi acp" }),
    { driver: "kimi", argv: ["kimi", "acp"] },
    undefined,
  );
  expect(result.status).toBe("backfilled");
  expect(result.targetArgv).toEqual(["kimi", "acp"]);
});

test("pure: rejected when config argv identity differs", () => {
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({ transport_agent_command: "kimi acp" }),
    { driver: "kimi", argv: ["kimi", "--different"] },
    undefined,
  );
  expect(result.status).toBe("rejected");
  expect(result.reason).toMatch(/does not match/);
});

test("pure: rejected when config still uses raw command", () => {
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({ transport_agent_command: "kimi acp" }),
    { driver: "kimi", command: "kimi acp" },
    undefined,
  );
  expect(result.status).toBe("rejected");
  expect(result.reason).toMatch(/raw command/);
});

test("pure: rejected when no acpx record corroborates identity", () => {
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({ transport_agent_command: "kimi acp" }),
    { driver: "kimi" },
    undefined,
  );
  expect(result.status).toBe("rejected");
  expect(result.reason).toMatch(/cannot prove identity/);
});

test("pure: backfilled from acpx record when present", () => {
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({ transport_agent_command: "kimi acp" }),
    { driver: "kimi" },
    ["kimi", "acp"],
  );
  expect(result.status).toBe("backfilled");
  expect(result.targetArgv).toEqual(["kimi", "acp"]);
});

async function setupFixtureDir(): Promise<{
  dir: string;
  statePath: string;
  configPath: string;
  acpxDir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-argv-migration-"));
  const statePath = join(dir, "state.json");
  const configPath = join(dir, "config.json");
  const acpxDir = join(dir, "acpx-sessions");
  await mkdir(acpxDir, { recursive: true });
  return { dir, statePath, configPath, acpxDir };
}

async function writeAcpxRecord(
  acpxDir: string,
  transportSession: string,
  agentCommand: string,
  agentArgv: string[] | undefined,
): Promise<void> {
  // Mirror acpx's on-disk layout: the file name uses encodeURIComponent so
  // transport_session values with `:` (Windows-illegal in filenames) survive.
  const fileName = `${encodeURIComponent(transportSession)}.json`;
  const record = {
    schema: "acpx.session.v1",
    acpx_record_id: transportSession,
    acp_session_id: transportSession,
    agent_command: agentCommand,
    ...(agentArgv ? { agent_argv: agentArgv } : {}),
    cwd: "C:\\demo",
    name: transportSession,
    created_at: "2026-08-10T09:00:00.000Z",
    last_used_at: "2026-08-10T09:00:00.000Z",
    event_log: { active_path: "", segment_count: 0, max_segment_bytes: 0, max_segments: 0 },
  };
  const indexPath = join(acpxDir, "index.json");
  let entries: Array<Record<string, unknown>> = [];
  try {
    const existing = JSON.parse(await readFile(indexPath, "utf8")) as { entries?: unknown };
    if (Array.isArray(existing.entries)) entries = existing.entries as Array<Record<string, unknown>>;
  } catch {
    /* fresh */
  }
  entries.push({
    file: fileName,
    acpxRecordId: transportSession,
    acpSessionId: transportSession,
    agentCommand,
    cwd: "C:\\demo",
    name: transportSession,
    closed: false,
    lastUsedAt: "2026-08-10T09:00:00.000Z",
  });
  await writeFile(indexPath, JSON.stringify({ schema: "acpx.session-index.v1", files: [fileName], entries }));
  await writeFile(join(acpxDir, fileName), JSON.stringify(record, null, 2));
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("io: migrates state to session-local structured argv via overlay alias", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transportSession, "kimi acp", ["kimi", "acp"]);
    const stateBefore = {
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo",
          agent: "kimi",
          workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z",
          last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    };
    await writeFile(statePath, JSON.stringify(stateBefore));
    const configBefore = {
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [],
      plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    };
    await writeFile(configPath, JSON.stringify(configBefore));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([
      { alias: "relay:demo", agent: "kimi", argv: ["kimi", "acp"], acpxAgent: deriveAgentAlias("kimi", ["kimi", "acp"]) },
    ]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toEqual([]);

    const stateAfter = await readJson(statePath);
    const sessionAfter = (stateAfter.sessions as Record<string, Record<string, unknown>>)["relay:demo"]!;
    expect(sessionAfter.transport_acpx_agent).toBe(deriveAgentAlias("kimi", ["kimi", "acp"]));
    expect(sessionAfter.transport_agent_argv).toEqual(["kimi", "acp"]);
    expect(sessionAfter.transport_agent_command).toBe("kimi acp");

    const configAfter = await readJson(configPath);
    const agentAfter = (configAfter.agents as Record<string, Record<string, unknown>>).kimi!;
    expect(agentAfter.argv).toBeUndefined();
    expect(agentAfter.command).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("io: backfills only state when config already has matching argv", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transportSession, "kimi acp", ["kimi", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi", argv: ["kimi", "acp"] } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toHaveLength(1);
    expect(result.configUpdates).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("io: skips session when acpx record is missing", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: "demo:relay:demo:reset-1",
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.alias).toBe("relay:demo");
    expect(result.skipped[0]!.reason).toMatch(/cannot prove identity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("io: idempotent on second run (session-local alias is content-stable)", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transportSession, "kimi acp", ["kimi", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const first = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(first.migrated).toHaveLength(1);
    expect(first.migrated[0]?.acpxAgent).toBe(deriveAgentAlias("kimi", ["kimi", "acp"]));
    expect(first.configUpdates).toHaveLength(0);
    expect(first.skipped).toHaveLength(0);

    const second = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(second.migrated).toEqual([]);
    expect(second.configUpdates).toEqual([]);
    expect(second.skipped).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("io: dry-run reports session-local plan without writing", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transportSession, "kimi acp", ["kimi", "acp"]);
    const stateRaw = JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    });
    const configRaw = JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    });
    await writeFile(statePath, stateRaw);
    await writeFile(configPath, configRaw);

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir,
      logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
      dryRun: true,
    });
    expect(result.migrated).toEqual([{ alias: "relay:demo", agent: "kimi", argv: ["kimi", "acp"], acpxAgent: deriveAgentAlias("kimi", ["kimi", "acp"]) }]);
    expect(result.configUpdates).toEqual([]);

    expect(await readFile(statePath, "utf8")).toBe(stateRaw);
    expect(await readFile(configPath, "utf8")).toBe(configRaw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("io: returns empty result when state.json is missing", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result).toEqual({ migrated: [], skipped: [], configUpdates: [], errors: [], stateWriteFailed: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("io: skips silently when acpx record read throws", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: "demo:relay:demo:reset-1",
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const throwingReader: AcpxRecordReader = async () => {
      throw new Error("simulated EIO");
    };
    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      readAcpxRecord: throwingReader,
      logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/cannot prove identity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("io: skips session when acpx record exists but agent_command mismatches", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    // Acpx record was made under a different command — proves identity is suspect.
    await writeAcpxRecord(acpxDir, transportSession, "kimi --something-else", ["kimi", "--something-else"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/cannot prove identity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Reviewer-driven regression tests (see PR #264 review notes)
// ============================================================================

test("issue 1: Path A migrates matching session independently of a conflicting sibling", async () => {
  // Two sessions for the same driver (`kimi`) with DIFFERENT recorded commands.
  // Under Path A each session is planned independently: the default-matching
  // "kimi acp" session is migrated; the custom "kimi --other" session is
  // skipped. Neither blocks the other, and xacpx config stays untouched.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportA = "demo:relay:demo-a:reset-1";
    const transportB = "demo:relay:demo-b:reset-2";
    await writeAcpxRecord(acpxDir, transportA, "kimi acp", ["kimi", "acp"]);
    await writeAcpxRecord(acpxDir, transportB, "kimi --other", ["kimi", "--other"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo-a": {
          alias: "relay:demo-a", agent: "kimi", workspace: "demo",
          transport_session: transportA,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
        "relay:demo-b": {
          alias: "relay:demo-b", agent: "kimi", workspace: "demo",
          transport_session: transportB,
          transport_agent_command: "kimi --other",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([
      {
        alias: "relay:demo-a",
        agent: "kimi",
        argv: ["kimi", "acp"],
        acpxAgent: deriveAgentAlias("kimi", ["kimi", "acp"]),
      },
    ]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.alias).toBe("relay:demo-b");
    expect(result.skipped[0]!.reason).toMatch(/does not match the current driver's default launch/);
    expect(result.errors).toEqual([]);

    const configAfter = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const agentAfter = (configAfter.agents as Record<string, Record<string, unknown>>).kimi!;
    expect(agentAfter.argv).toBeUndefined();
    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const sessionsAfter = stateAfter.sessions as Record<string, Record<string, unknown>>;
    expect(sessionsAfter["relay:demo-a"]!.transport_agent_argv).toEqual(["kimi", "acp"]);
    expect(sessionsAfter["relay:demo-a"]!.transport_acpx_agent).toBe(
      deriveAgentAlias("kimi", ["kimi", "acp"]),
    );
    expect(sessionsAfter["relay:demo-b"]!.transport_agent_argv).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 1: agents with unanimous argv identity get a shared session-local alias", async () => {
  // Same driver, two sessions, identical recorded command and identical argv
  // identity — should backfill both, write argv to config exactly once.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportA = "demo:relay:demo-a:reset-1";
    const transportB = "demo:relay:demo-b:reset-2";
    await writeAcpxRecord(acpxDir, transportA, "kimi acp", ["kimi", "acp"]);
    await writeAcpxRecord(acpxDir, transportB, "kimi acp", ["kimi", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo-a": {
          alias: "relay:demo-a", agent: "kimi", workspace: "demo",
          transport_session: transportA,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
        "relay:demo-b": {
          alias: "relay:demo-b", agent: "kimi", workspace: "demo",
          transport_session: transportB,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toHaveLength(2);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 2: state read-modify-write re-reads fresh under lock; concurrent write does not lose data", async () => {
  // Pre-write state with session A needing migration. The custom readFile
  // returns the stale snapshot on the first call (planning read), then a
  // fresh snapshot on subsequent calls (lock-acquired re-read) where A has
  // already been migrated and chat_contexts has a concurrent daemon write.
  // The migration must preserve chat_contexts and not clobber A's argv.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transportSession, "kimi acp", ["kimi", "acp"]);
    const planningState = {
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    };
    const freshState = {
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "kimi acp",
          // Concurrently written argv on disk WITHOUT acpx alias — Path A
          // must repair by writing the canonical transport_acpx_agent.
          transport_agent_argv: ["kimi", "acp"],
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      // Concurrent daemon write to chat_contexts that the planning read did
      // not see. The lock-acquired re-read MUST preserve this; the migration
      // would otherwise overwrite it with the stale planning snapshot.
      chat_contexts: {
        "weixin:user": { current_session: "relay:demo" },
      },
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    };
    await writeFile(statePath, JSON.stringify(planningState));

    let readCount = 0;
    const customReadFile = async (path: string): Promise<string> => {
      if (path !== statePath) {
        return await readFile(path, "utf8");
      }
      readCount += 1;
      // First call (planning) sees stale; later calls (lock re-read) see fresh.
      return JSON.stringify(readCount === 1 ? planningState : freshState);
    };

    const configRaw = JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    });
    await writeFile(configPath, configRaw);

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      readFile: customReadFile,
      logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    // Fresh snapshot had argv-only; repair writes the canonical alias.
    expect(result.migrated).toEqual([
      { alias: "relay:demo", agent: "kimi", argv: ["kimi", "acp"], acpxAgent: deriveAgentAlias("kimi", ["kimi", "acp"]) },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);

    // Critical assertion: chat_contexts from the fresh snapshot MUST survive.
    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    expect(stateAfter.chat_contexts).toEqual({
      "weixin:user": { current_session: "relay:demo" },
    });
    const sessionAfter = (stateAfter.sessions as Record<string, Record<string, unknown>>)["relay:demo"]!;
    expect(sessionAfter.transport_agent_argv).toEqual(["kimi", "acp"]);
    expect(sessionAfter.transport_acpx_agent).toBe(deriveAgentAlias("kimi", ["kimi", "acp"]));
    const configAfter = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    // Under path A the migration never writes the xacpx config — the
    // historical session is pinned to a session-local overlay alias in
    // acpx's config, and `agents.kimi.argv` is deliberately NOT created
    // so future bare kimi sessions still honor `.acpxrc.json` /
    // `~/.acpx/config.json` overrides.
    expect((configAfter.agents as Record<string, Record<string, unknown>>).kimi!.argv)
      .toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 2: state write aborts when lock-acquired re-read sees session deleted", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transportSession, "kimi acp", ["kimi", "acp"]);
    const planningState = {
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    };
    // Fresh state: session was deleted between planning and lock acquire.
    const freshState = { version: 1, sessions: {}, chat_contexts: {}, orchestration: { tasks: {}, workerBindings: {}, groups: {} }, scheduled_tasks: {} };
    await writeFile(statePath, JSON.stringify(planningState));

    let readCount = 0;
    const customReadFile = async (path: string): Promise<string> => {
      if (path !== statePath) return await readFile(path, "utf8");
      readCount += 1;
      return JSON.stringify(readCount === 1 ? planningState : freshState);
    };

    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      readFile: customReadFile,
      logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([]);
    // Session was gone by the time we held the lock; not a hard error, just
    // nothing to do. (Config may still have been patched — that's a separate
    // question. Here we don't care since we're testing the state-write path.)
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 4: rejects acpx record whose argv and agent_command disagree", async () => {
  // A corrupt/inconsistent record: agent_command says "kimi acp" but the
  // argv's canonical identity is "other --agent". The pure decision must
  // refuse to use this record as identity proof — adopting the argv would
  // silently re-key the session onto a different acpx record.
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({ transport_agent_command: "kimi acp" }),
    { driver: "kimi" },
    ["other", "--agent"],  // canonical identity != "kimi acp"
  );
  expect(result.status).toBe("rejected");
  expect(result.reason).toMatch(/record is inconsistent|argv identity does not match/);
});

test("io: rejects acpx record with mismatched argv identity at the I/O seam", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    // Write a corrupt record directly: agent_command and agent_argv disagree.
    const fileName = `${encodeURIComponent(transportSession)}.json`;
    await writeFile(join(acpxDir, "index.json"), JSON.stringify({
      schema: "acpx.session-index.v1",
      files: [fileName],
      entries: [{
        file: fileName,
        acpxRecordId: transportSession,
        acpSessionId: transportSession,
        agentCommand: "kimi acp",
        cwd: "C:\\demo",
        name: transportSession,
        closed: false,
        lastUsedAt: "2026-08-10T09:00:00.000Z",
      }],
    }));
    await writeFile(join(acpxDir, fileName), JSON.stringify({
      schema: "acpx.session.v1",
      acpx_record_id: transportSession,
      acp_session_id: transportSession,
      agent_command: "kimi acp",
      agent_argv: ["other", "--agent"],  // inconsistent with agent_command
      cwd: "C:\\demo",
      name: transportSession,
      created_at: "2026-08-10T09:00:00.000Z",
      last_used_at: "2026-08-10T09:00:00.000Z",
    }));

    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/cannot prove identity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 5: surfaces I/O errors in result.errors and skips writes", async () => {
  const { dir, statePath, configPath } = await setupFixtureDir();
  try {
    const nodeReadFile = (await import("node:fs/promises")).readFile;
    const throwingReader = async (path: string): Promise<string> => {
      if (path === statePath) {
        throw new Error("simulated EIO reading state.json");
      }
      // Everything else (config, acpx config) reads normally; the acpx
      // config path points at a non-existent fixture file so the reader
      // must not touch the real ~/.acpx/config.json.
      return await nodeReadFile(path, "utf8");
    };
    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath,
      configPath,
      acpxSessionsDir: "/nonexistent",
      acpxConfigPath: join(dir, "acpx-config.json"),
      readFile: throwingReader,
      logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/state\.json.*simulated EIO/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});




test("issue 2 v2: fresh-state re-read failure aborts the migration", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transportSession, "kimi acp", ["kimi", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));
    const configBefore = await readFile(configPath, "utf8");
    const stateBefore = await readFile(statePath, "utf8");

    // First read succeeds (planning), second read (lock-acquired re-read) throws.
    let readCount = 0;
    const nodeReadFile = (await import("node:fs/promises")).readFile;
    const customReadFile = async (path: string): Promise<string> => {
      if (path !== statePath) return await nodeReadFile(path, "utf8");
      readCount += 1;
      if (readCount === 1) return await nodeReadFile(path, "utf8");
      throw new Error("simulated EIO re-reading state.json under lock");
    };

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      readFile: customReadFile,
      logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });

    // Neither file is touched.
    expect(result.configUpdates).toEqual([]);
    expect(result.migrated).toEqual([]);
    expect(result.errors.some((e) => e.includes("simulated EIO re-reading state.json"))).toBe(true);
    expect(await readFile(configPath, "utf8")).toBe(configBefore);
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("issue 3 v2: acpx record read failure populates errors", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: "demo:relay:demo:reset-1",
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const throwingReader: AcpxRecordReader = async () => {
      throw new Error("simulated EIO reading acpx record");
    };
    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      readAcpxRecord: throwingReader,
      logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/cannot prove identity/);
    // The EIO is now in errors (issue 3 v2).
    expect(result.errors.some((e) => /simulated EIO reading acpx record/.test(e))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 3 v2: corrupt acpx index.json propagates as error (not silent fallback)", async () => {
  // Previously defaultReadAcpxRecord silently swallowed index.json parse
  // errors. Now it throws, and the error surfaces in result.errors so the
  // CLI can report "your acpx index is corrupt" instead of the generic
  // "cannot prove identity" skip.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    // Write state with a session whose only identity proof path is the acpx
    // record (config has no argv).
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: "demo:relay:demo:reset-1",
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));
    // Corrupt index.json - triggers the new throw.
    await writeFile(join(acpxDir, "index.json"), "{ this is not valid JSON");

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([]);
    expect(result.errors.some((e) => /failed to parse acpx session index/.test(e))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// v3: per-agent safety bucket now covers single-token sessions + fresh per-agent recheck
// ============================================================================


test("issue 1 v3: sticky session is excluded from the safety bucket", async () => {
  // A is backfillable (whitespace raw). C is sticky: has both
  // transport_acpx_agent and transport_agent_argv. Per-agent bucket
  // should include only A; C is excluded because step 2 sticky wins
  // over config argv.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportA = "demo:relay:demo-a:reset-1";
    const transportC = "demo:relay:demo-c:reset-2";
    await writeAcpxRecord(acpxDir, transportA, "kimi acp", ["kimi", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo-a": {
          alias: "relay:demo-a", agent: "kimi", workspace: "demo",
          transport_session: transportA,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
        "relay:demo-c": {
          alias: "relay:demo-c", agent: "kimi", workspace: "demo",
          transport_session: transportC,
          transport_agent_command: "kimi acp",
          transport_acpx_agent: "xacpx-managed-kimi-abc123",
          transport_agent_argv: ["kimi", "acp"],
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    // A is migrated (backfilled); C is noop (already correct).
    expect(result.migrated.length).toBeGreaterThanOrEqual(1);
    expect(result.migrated.some((m) => m.alias === "relay:demo-a")).toBe(true);
    expect(result.skipped).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 1 v3: bucket of fully-migrated sessions is steady state, not a skip", async () => {
  // Both sessions already have argv + canonical alias. Result should be a
  // noop, not a reject or a re-migration.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const alias = deriveAgentAlias("kimi", ["kimi", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo-a": {
          alias: "relay:demo-a", agent: "kimi", workspace: "demo",
          transport_session: "demo:relay:demo-a:reset-1",
          transport_agent_command: "kimi acp",
          transport_agent_argv: ["kimi", "acp"],
          transport_acpx_agent: alias,
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
        "relay:demo-b": {
          alias: "relay:demo-b", agent: "kimi", workspace: "demo",
          transport_session: "demo:relay:demo-b:reset-2",
          transport_agent_command: "kimi acp",
          transport_agent_argv: ["kimi", "acp"],
          transport_acpx_agent: alias,
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi", argv: ["kimi", "acp"] } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.skipped).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.migrated).toEqual([]);
    expect(result.errors).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 1 v3: argv-only sessions are repaired with canonical alias", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo-a": {
          alias: "relay:demo-a", agent: "kimi", workspace: "demo",
          transport_session: "demo:relay:demo-a:reset-1",
          transport_agent_command: "kimi acp",
          transport_agent_argv: ["kimi", "acp"],
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([
      {
        alias: "relay:demo-a",
        agent: "kimi",
        argv: ["kimi", "acp"],
        acpxAgent: deriveAgentAlias("kimi", ["kimi", "acp"]),
      },
    ]);
    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const sessionAfter = (stateAfter.sessions as Record<string, Record<string, unknown>>)["relay:demo-a"]!;
    expect(sessionAfter.transport_acpx_agent).toBe(deriveAgentAlias("kimi", ["kimi", "acp"]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});



// ============================================================================
// v4 + v5: shared isDerivedAgentArgv + unknown-identity safety +
//          planned-driver fence for both fresh-state and config patch
// ============================================================================

test("issue 1 v4: derived-argv session (opencode [driver, acp]) is NOT sticky even with transport_acpx_agent set", async () => {
  // A is backfillable with a custom argv (NOT derived). B has the opencode
  // default argv ["opencode", "acp"] which `isDerivedAgentArgv("opencode", ...)`
  // returns true for. The naive isSticky (transport_acpx_agent + argv) would
  // have excluded B from the safety bucket, letting the migration write
  // foo.argv = ["opencode", "--custom-acp"] and silently re-key B via
  // step 3. v4 uses the same `isDerivedAgentArgv` as SessionService.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportA = "demo:relay:demo-a:reset-1";
    const transportB = "demo:relay:demo-b:reset-2";
    await writeAcpxRecord(acpxDir, transportA, "opencode --custom-acp", ["opencode", "--custom-acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo-a": {
          alias: "relay:demo-a", agent: "foo", workspace: "demo",
          transport_session: transportA,
          transport_agent_command: "opencode --custom-acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
        "relay:demo-b": {
          alias: "relay:demo-b", agent: "foo", workspace: "demo",
          transport_session: transportB,
          transport_agent_command: "opencode acp",
          transport_acpx_agent: "xacpx-managed-opencode-abcdef",
          transport_agent_argv: ["opencode", "acp"],
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { foo: { driver: "opencode" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    const skippedAliases = result.skipped.map((s) => s.alias).sort();
    expect(skippedAliases).toEqual(["relay:demo-a", "relay:demo-b"]);
    for (const s of result.skipped) {
      expect(s.reason).toMatch(
        /does not match the current driver's default launch|matches a derived launch/,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 1 v4: truly-sticky session (custom argv + transport_acpx_agent) is excluded", async () => {
  // A is backfillable with custom argv. C has a custom argv (NOT derived)
  // + transport_acpx_agent — truly sticky per resolveLaunchSpec step 2.
  // C should be excluded from the safety bucket.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportA = "demo:relay:demo-a:reset-1";
    const transportC = "demo:relay:demo-c:reset-2";
    await writeAcpxRecord(acpxDir, transportA, "kimi acp", ["kimi", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo-a": {
          alias: "relay:demo-a", agent: "kimi", workspace: "demo",
          transport_session: transportA,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
        "relay:demo-c": {
          alias: "relay:demo-c", agent: "kimi", workspace: "demo",
          transport_session: transportC,
          transport_agent_command: "kimi acp",
          transport_acpx_agent: "xacpx-managed-kimi-abc",
          transport_agent_argv: ["kimi", "acp"],
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated.some((m) => m.alias === "relay:demo-a")).toBe(true);
    expect(result.skipped).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 2 v4: Path A migrates a safe session even when a sibling has unknown identity", async () => {
  // A is backfillable with "kimi acp". B has no recorded command and no
  // argv. Under Path A (session-local), B cannot be re-keyed by A's alias,
  // so A migrates and B is left alone (noop — nothing to migrate).
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportA = "demo:relay:demo-a:reset-1";
    await writeAcpxRecord(acpxDir, transportA, "kimi acp", ["kimi", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo-a": {
          alias: "relay:demo-a", agent: "kimi", workspace: "demo",
          transport_session: transportA,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
        "relay:demo-b": {
          alias: "relay:demo-b", agent: "kimi", workspace: "demo",
          transport_session: "demo:relay:demo-b:reset-2",
          // no recorded_agent_command, no argv, no transport_acpx_agent
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([
      {
        alias: "relay:demo-a",
        agent: "kimi",
        argv: ["kimi", "acp"],
        acpxAgent: deriveAgentAlias("kimi", ["kimi", "acp"]),
      },
    ]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped.some((s) => s.alias === "relay:demo-b")).toBe(false);
    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const sessionsAfter = stateAfter.sessions as Record<string, Record<string, unknown>>;
    expect(sessionsAfter["relay:demo-a"]!.transport_acpx_agent).toBe(
      deriveAgentAlias("kimi", ["kimi", "acp"]),
    );
    expect(sessionsAfter["relay:demo-b"]!.transport_agent_argv).toBeUndefined();
    expect(sessionsAfter["relay:demo-b"]!.transport_acpx_agent).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});





test("production: acpx builtin default argv (kimi) becomes a session-local overlay alias WITHOUT an injected resolver", async () => {
  // Reviewer finding (v6): the production `computeDefaultAgentArgv` must
  // know acpx's builtin default argv (kimi -> ["kimi","acp"]). The old
  // implementation only returned structured argv for codex/claude/hermes/
  // opencode/kilocode and returned undefined for bare builtins, so the
  // core PR scenario (a historical "kimi acp" session) was misjudged as
  // custom and never migrated. No `resolveDefaultArgv` is injected here:
  // the acpx registry is the oracle, exactly as in the daemon.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transportSession, "kimi acp", ["kimi", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir,
      // Missing fixture acpx config → no acpx-level overrides → registry is
      // the oracle. Never read the real ~/.acpx/config.json in a unit test.
      acpxConfigPath: join(dir, "acpx-config.json"),
      logger: createNoopAppLogger(),
    });
    expect(result.migrated).toEqual([
      { alias: "relay:demo", agent: "kimi", argv: ["kimi", "acp"], acpxAgent: deriveAgentAlias("kimi", ["kimi", "acp"]) },
    ]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toEqual([]);
    const configAfter = await readJson(configPath);
    // No global config write under path A: the historical session sticks to
    // its session-local overlay alias, future bare sessions still resolve
    // through acpx (honoring `.acpxrc.json` / `~/.acpx/config.json` overrides).
    expect((configAfter.agents as Record<string, Record<string, unknown>>).kimi!.argv)
      .toBeUndefined();
    const stateAfter = await readJson(statePath);
    const sessionAfter = (stateAfter.sessions as Record<string, Record<string, unknown>>)["relay:demo"]!;
    expect(sessionAfter.transport_acpx_agent).toBe(deriveAgentAlias("kimi", ["kimi", "acp"]));
    expect(sessionAfter.transport_agent_argv).toEqual(["kimi", "acp"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 1 v5: historical custom argv is left untouched (no global write, no session-local write)", async () => {
  // Reviewer finding (v6): a historical custom argv (proven by an acpx
  // record) must not become the global agents.<name>.argv when it does not
  // match the CURRENT driver's default launch — that would re-key every
  // future session of the agent. It must also NOT be written as a
  // session-local `transport_agent_argv`: without a matching
  // `transport_acpx_agent` + provisioned overlay, resolveLaunchSpec step 2
  // cannot use it and the raw command keeps failing closed on Windows, so
  // the state write would be pure noise on top of the fail-closed command
  // it discards. The session is left untouched (fail closed).
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transportSession, "kimi acp", ["kimi", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "foo", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    // Agent foo now uses driver qwen (default ["qwen","acp"]) — the
    // historical session was launched under kimi. Elevating it would
    // permanently re-key every future foo session to kimi.
    const configBefore = JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { foo: { driver: "qwen" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    });
    await writeFile(configPath, configBefore);

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.alias).toBe("relay:demo");
    expect(result.skipped[0]!.reason).toMatch(/does not match the current driver's default launch/);
    // No partial state write: the session keeps its raw command (fail
    // closed on Windows until the user migrates manually).
    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const sessionAfter = (stateAfter.sessions as Record<string, Record<string, unknown>>)["relay:demo"]!;
    expect(sessionAfter.transport_agent_argv).toBeUndefined();
    expect(sessionAfter.transport_agent_command).toBe("kimi acp");
    // Config byte-for-byte unchanged.
    expect(await readFile(configPath, "utf8")).toBe(configBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pure: single-token non-lossless command (windows path) is not blindly backfilled", () => {
  // Reviewer finding (v6): `[command]` is only lossless when the canonical
  // identity round-trips. "C:\\tools\\agent.exe" renders JSON-quoted, so
  // writing it as argv would re-key the acpx record. Without a provable
  // source the session must fail closed.
  const command = "C:\\tools\\agent.exe";
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({ transport_agent_command: command }),
    { driver: "kimi" },
    undefined,
  );
  expect(result.status).toBe("rejected");
  expect(result.reason).toMatch(/cannot prove identity/);
  // Even a self-consistent record cannot prove a lossless conversion for a
  // non-lossless raw command (identity of [command] != command).
  const withRecord = evaluateStateSessionArgvMigration(
    sessionFixture({ transport_agent_command: command }),
    { driver: "kimi" },
    [command],
  );
  expect(withRecord.status).toBe("rejected");
});

test("io: single-token non-lossless command consults the acpx record (no whitespace early-return)", async () => {
  // Reviewer finding (v6): the acpx-record reader must not skip
  // single-token commands outright. For a non-lossless token the record is
  // the only remaining proof source (it fails closed here, which is the
  // correct outcome) — but the reader has to actually be consulted, not
  // short-circuited by a whitespace check.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    let recordCalls = 0;
    const readAcpxRecord: AcpxRecordReader = async (transport, expectedCommand) => {
      recordCalls += 1;
      expect(transport).toBe(transportSession);
      expect(expectedCommand).toBe("C:\\tools\\agent.exe");
      return null;
    };
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "C:\\tools\\agent.exe",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir,
      readAcpxRecord, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(recordCalls).toBe(1);
    expect(result.migrated).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/cannot prove identity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});




test("issue 1 v7: derived-launch default (resolver source=derived) is never elevated into explicit argv", async () => {
  // The resolver reports the planned argv as a DERIVED launch (managed pin /
  // hermes shim / local fallback). Even though it matches the current
  // default, writing it into explicit agents.<name>.argv would make step 3
  // permanently win over step 5 — freezing a launch that resolveLaunchSpec
  // deliberately recomputes on restart. Elevation must be refused.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transportSession, "opencode acp", ["opencode", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "foo", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "opencode acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    const configBefore = JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { foo: { driver: "opencode" } },
      workspaces: { demo: { cwd: "C:\demo" } },
      later: { defaultMode: "temp" },
    });
    await writeFile(configPath, configBefore);
    const stateBefore = await readFile(statePath, "utf8");

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      acpxConfigPath: join(dir, "acpx-config.json"),
      resolveDefaultArgv: (n: string) =>
        n === "foo"
          ? { argv: ["opencode", "acp"], source: "derived" }
          : defaultArgvResolver(n),
    });

    expect(result.migrated).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/derived launch/);
    expect(await readFile(configPath, "utf8")).toBe(configBefore);
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 1 v7: production managed codex pin (derived) is NOT elevated, no overlay provisioned", async () => {
  // No resolver injection: the PRODUCTION computeDefaultAgentArgv must
  // classify the managed codex npx pin as source=derived and refuse to write
  // it into agents.codex.argv — otherwise a later adapter-version bump would
  // be permanently shadowed by the frozen explicit argv.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const codexArgv = resolveManagedAdapterArgv("codex")!;
    const codexCommand = resolveManagedAdapterCommand("codex")!;
    const transportSession = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transportSession, codexCommand, codexArgv);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "codex", workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: codexCommand,
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    const configBefore = JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { codex: { driver: "codex" } },
      workspaces: { demo: { cwd: "C:\demo" } },
      later: { defaultMode: "temp" },
    });
    await writeFile(configPath, configBefore);
    const stateBefore = await readFile(statePath, "utf8");

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      acpxConfigPath: join(dir, "acpx-config.json"),
    });

    expect(result.migrated).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/derived launch/);
    expect(await readFile(configPath, "utf8")).toBe(configBefore);
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});





test("issue 1 v8 (HIGH): .acpxrc.json project override is honored — migration never freezes acpx config", async () => {
  // The reviewer's regression: xacpx writes `agents.<name>.argv` to
  // `~/.xacpx/config.json` (the xacpx config). The migration elevates
  // that to a structured argv which becomes a `xacpx-managed-*` alias on
  // acpx's side. If xacpx then always launches via that alias (because
  // `agents.<name>.argv` is set), FUTURE new sessions of the driver can
  // never resolve through acpx's normal bare-driver path — and acpx's
  // project-level `.acpxrc.json` (`agents.<driver>` with cwd) and
  // global-level `~/.acpx/config.json` (`agents.<driver>`) user overrides
  // become permanently shadowed.
  //
  // Under path A the migration is session-local: it writes a
  // `xacpx-managed-*` alias + overlays into acpx's config, and persists
  // `transport_acpx_agent` + `transport_agent_argv` on the historical
  // session. The historical session sticks to that alias (resolveLaunchSpec
  // step 2). NEW bare sessions of the same driver still go through bare
  // driver resolution in acpx, which honors `.acpxrc.json` (per-cwd) and
  // `~/.acpx/config.json` (global) overrides. So a project override
  // installed today (or added after the migration) continues to take effect
  // for new sessions.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportSession = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transportSession, "kimi acp", ["kimi", "acp"]);
    const stateBefore = {
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo",
          agent: "kimi",
          workspace: "demo",
          transport_session: transportSession,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z",
          last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    };
    await writeFile(statePath, JSON.stringify(stateBefore));
    const configBefore = {
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    };
    await writeFile(configPath, JSON.stringify(configBefore));

    // Tracking provisioner: record what the migration tries to overlay.
    const overlayCalls: { alias: string; argv: string[] }[] = [];
    const result = await migrateStateAgentArgv({
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
      provisionOverlays: async (entries) => { overlayCalls.push(...entries); },
    });

    // (a) xacpx config.json: no `agents.kimi.argv` written — global
    // bare-driver resolution is preserved for new sessions, so they
    // continue to honor `.acpxrc.json` project and `~/.acpx/config.json`
    // global user overrides.
    const configAfter = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const agentAfter = (configAfter.agents as Record<string, Record<string, unknown>>).kimi!;
    expect(agentAfter.argv).toBeUndefined();
    expect(agentAfter.command).toBeUndefined();
    expect(configAfter).toEqual(configBefore);

    // (b) The historical session got a session-local structured argv
    // (alias + argv). It sticks to the alias via resolveLaunchSpec step 2.
    expect(result.configUpdates).toEqual([]);
    expect(result.migrated).toEqual([
      { alias: "relay:demo", agent: "kimi", argv: ["kimi", "acp"], acpxAgent: deriveAgentAlias("kimi", ["kimi", "acp"]) },
    ]);
    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const sessionAfter = (stateAfter.sessions as Record<string, Record<string, unknown>>)["relay:demo"]!;
    expect(sessionAfter.transport_acpx_agent).toBe(deriveAgentAlias("kimi", ["kimi", "acp"]));
    expect(sessionAfter.transport_agent_argv).toEqual(["kimi", "acp"]);

    // (c) The session overlay was provisioned into acpx's config (the
    // content-hashed `xacpx-managed-kimi-...` alias for the session's argv).
    expect(overlayCalls).toEqual([
      { alias: deriveAgentAlias("kimi", ["kimi", "acp"]), argv: ["kimi", "acp"] },
    ]);

    // (d) The `.acpxrc.json` would affect NEW bare kimi sessions (not the
    // migrated historical one, which is pinned to its alias). The migration
    // never reads or writes acpx's config (no `acpxConfigPath` dep, no
    // project scan) — it ONLY provisions the session overlay — so the
    // user's project override remains authoritative for new sessions.
    // (We do not simulate the full acpx resolution here; the absence of
    // any global config write is the structural guarantee.)
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("High: fresh-config fence skips when explicit argv B lands between planning and commit", async () => {
  // Planning sees default A=["kimi","acp"]. Concurrent edit sets
  // agents.kimi.argv=B=["kimi","--new"] before the lock-side fence.
  // Elevating A into sticky step 2 would permanently shadow B — skip.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transport = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transport, "kimi acp", ["kimi", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transport,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));

    const configA = {
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    };
    const configB = {
      ...configA,
      agents: { kimi: { driver: "kimi", argv: ["kimi", "--new"] } },
    };
    await writeFile(configPath, JSON.stringify(configA));

    let configReads = 0;
    const customReadFile = async (path: string): Promise<string> => {
      if (path === configPath) {
        configReads += 1;
        // Planning: readConfigAgentsMap + readFullConfig (2 reads) see A.
        // Apply fence: later reads see B.
        return JSON.stringify(configReads <= 2 ? configA : configB);
      }
      return await readFile(path, "utf8");
    };

    const overlayCalls: Array<{ alias: string; argv: string[] }> = [];
    const result = await migrateStateAgentArgv({
      provisionOverlays: async (entries) => {
        for (const e of entries) overlayCalls.push(e);
      },
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      readFile: customReadFile,
      logger: createNoopAppLogger(),
      resolveDefaultArgv: (agentName, fullConfig) => {
        const agents = (fullConfig.agents ?? {}) as Record<string, { argv?: string[] }>;
        const agent = agents[agentName];
        if (Array.isArray(agent?.argv) && agent.argv.length > 0) {
          return { argv: [...agent.argv], source: "explicit-config" as const };
        }
        return defaultArgvResolver(agentName);
      },
    });

    expect(result.migrated).toEqual([]);
    expect(overlayCalls).toEqual([]);
    expect(result.skipped.some((s) => s.alias === "relay:demo")).toBe(true);
    expect(result.skipped.find((s) => s.alias === "relay:demo")?.reason).toMatch(
      /fresh config|does not match the current driver's default/,
    );

    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const sessionAfter = (stateAfter.sessions as Record<string, Record<string, unknown>>)["relay:demo"]!;
    expect(sessionAfter.transport_agent_argv).toBeUndefined();
    expect(sessionAfter.transport_acpx_agent).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("High: config lock freezes fence→commit against concurrent ConfigStore.patchRaw", async () => {
  // After fence passes under the config lock, a concurrent ConfigStore
  // writer must block until elevate commits — it cannot insert argv B in
  // the fence→commit window.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transport = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transport, "kimi acp", ["kimi", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transport,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    let resolveFenceHeld!: () => void;
    const fenceHeld = new Promise<void>((resolve) => { resolveFenceHeld = resolve; });
    let resolveAllowCommit!: () => void;
    const allowCommit = new Promise<void>((resolve) => { resolveAllowCommit = resolve; });

    let patchCompleted = false;
    const migrationPromise = migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
      afterFreshConfigFence: async () => {
        resolveFenceHeld();
        await allowCommit;
      },
    });

    await fenceHeld;

    const { ConfigStore } = await import("../../../src/config/config-store");
    const store = new ConfigStore(configPath);
    const patchPromise = store.patchRaw((raw) => {
      const agents = (raw.agents ?? {}) as Record<string, Record<string, unknown>>;
      const kimi = { ...(agents.kimi ?? { driver: "kimi" }), argv: ["kimi", "--new"] };
      agents.kimi = kimi;
      raw.agents = agents;
    }).then((cfg) => {
      patchCompleted = true;
      return cfg;
    });

    // While migration still holds the config lock, patchRaw must not finish.
    await new Promise((r) => setTimeout(r, 400));
    expect(patchCompleted).toBe(false);

    resolveAllowCommit();
    const result = await migrationPromise;
    expect(result.migrated).toEqual([
      {
        alias: "relay:demo",
        agent: "kimi",
        argv: ["kimi", "acp"],
        acpxAgent: deriveAgentAlias("kimi", ["kimi", "acp"]),
      },
    ]);

    await patchPromise;
    expect(patchCompleted).toBe(true);

    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const sessionAfter = (stateAfter.sessions as Record<string, Record<string, unknown>>)["relay:demo"]!;
    expect(sessionAfter.transport_agent_argv).toEqual(["kimi", "acp"]);
    expect(sessionAfter.transport_acpx_agent).toBe(deriveAgentAlias("kimi", ["kimi", "acp"]));

    const configAfter = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect((configAfter.agents as Record<string, Record<string, unknown>>).kimi!.argv)
      .toEqual(["kimi", "--new"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Medium: historical self-proving pair is steady after driver rename (no skip)", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const argv = ["kimi", "acp"];
    const historical = deriveAgentAlias("kimi", argv);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "foo", workspace: "demo",
          transport_session: "demo:relay:demo:reset-1",
          transport_agent_command: "kimi acp",
          transport_agent_argv: argv,
          transport_acpx_agent: historical,
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    // Config driver renamed after the original kimi migration.
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { foo: { driver: "qwen" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => (n === "foo" ? ["qwen", "acp"] : defaultArgvResolver(n)),
    });
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.stateWriteFailed).toBe(false);

    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const sessionAfter = (stateAfter.sessions as Record<string, Record<string, unknown>>)["relay:demo"]!;
    expect(sessionAfter.transport_acpx_agent).toBe(historical);
    expect(sessionAfter.transport_agent_argv).toEqual(argv);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Medium: unique index row without agentCommand still migrates via record self-proof", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transport = "demo:relay:demo:reset-1";
    const fileName = `${encodeURIComponent(transport)}.json`;
    await writeFile(join(acpxDir, fileName), JSON.stringify({
      schema: "acpx.session.v1",
      name: transport,
      agent_command: "kimi acp",
      agent_argv: ["kimi", "acp"],
      cwd: "C:\\demo",
    }));
    // Index metadata omits agentCommand (optional in acpx contract).
    await writeFile(join(acpxDir, "index.json"), JSON.stringify({
      schema: "acpx.session-index.v1",
      files: [fileName],
      entries: [{ file: fileName, name: transport, cwd: "C:\\demo", closed: false }],
    }));
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transport,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
    });
    expect(result.migrated).toEqual([
      {
        alias: "relay:demo",
        agent: "kimi",
        argv: ["kimi", "acp"],
        acpxAgent: deriveAgentAlias("kimi", ["kimi", "acp"]),
      },
    ]);
    expect(result.skipped).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("High: partial state write failure sets stateWriteFailed and leaves partial file", async () => {
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transport = "demo:relay:demo:reset-1";
    await writeAcpxRecord(acpxDir, transport, "kimi acp", ["kimi", "acp"]);
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo": {
          alias: "relay:demo", agent: "kimi", workspace: "demo",
          transport_session: transport,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    }));
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi" } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const { withPrivateFileLock } = await import("../../../src/util/private-file");
    const result = await migrateStateAgentArgv({
      provisionOverlays: async () => {},
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
      resolveDefaultArgv: (n: string) => defaultArgvResolver(n),
      withStateFileLock: async (path, fn) =>
        withPrivateFileLock(path, async () =>
          fn(async () => {
            // Simulate Windows direct-write fallback that truncates then fails.
            await writeFile(path, "{partial");
            throw new Error("simulated windows direct-write failure");
          }),
        ),
    });

    expect(result.stateWriteFailed).toBe(true);
    expect(result.errors.some((e) => /partial|write|elevate/i.test(e))).toBe(true);
    expect(result.migrated).toEqual([]);
    const raw = await readFile(statePath, "utf8");
    expect(raw).toBe("{partial");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
