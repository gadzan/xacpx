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

test("pure: noop when transport_agent_argv already present", () => {
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({ transport_agent_argv: ["kimi", "acp"] }),
    { driver: "kimi" },
    ["kimi", "acp"],
  );
  expect(result.status).toBe("noop");
});

test("pure: noop when transport_agent_command is single-token", () => {
  const result = evaluateStateSessionArgvMigration(
    sessionFixture({ transport_agent_command: "kimi" }),
    { driver: "kimi" },
    ["kimi", "acp"],
  );
  expect(result.status).toBe("noop");
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

test("io: migrates state and config when acpx record corroborates identity", async () => {
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
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      logger: createNoopAppLogger(),
    });
    expect(result.migrated).toEqual([
      { alias: "relay:demo", agent: "kimi", argv: ["kimi", "acp"] },
    ]);
    expect(result.configUpdates).toEqual([
      { agent: "kimi", argv: ["kimi", "acp"] },
    ]);
    expect(result.skipped).toEqual([]);

    const stateAfter = await readJson(statePath);
    const sessionAfter = (stateAfter.sessions as Record<string, Record<string, unknown>>)["relay:demo"]!;
    expect(sessionAfter.transport_agent_argv).toEqual(["kimi", "acp"]);
    expect(sessionAfter.transport_agent_command).toBe("kimi acp");

    const configAfter = await readJson(configPath);
    const agentAfter = (configAfter.agents as Record<string, Record<string, unknown>>).kimi!;
    expect(agentAfter.argv).toEqual(["kimi", "acp"]);
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
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
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
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
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

test("io: idempotent on second run", async () => {
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
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
    });
    expect(first.migrated).toHaveLength(1);
    expect(first.configUpdates).toHaveLength(1);

    const second = await migrateStateAgentArgv({
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
    });
    expect(second.migrated).toEqual([]);
    expect(second.configUpdates).toEqual([]);
    expect(second.skipped).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("io: dry-run reports plan without writing", async () => {
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
      statePath, configPath, acpxSessionsDir: acpxDir,
      logger: createNoopAppLogger(),
      dryRun: true,
    });
    expect(result.migrated).toEqual([{ alias: "relay:demo", agent: "kimi", argv: ["kimi", "acp"] }]);
    expect(result.configUpdates).toEqual([{ agent: "kimi", argv: ["kimi", "acp"] }]);

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
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
    });
    expect(result).toEqual({ migrated: [], skipped: [], configUpdates: [], errors: [] });
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
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      readAcpxRecord: throwingReader,
      logger: createNoopAppLogger(),
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
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
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

test("issue 1: per-agent all-or-nothing when sessions have conflicting target identities", async () => {
  // Two sessions for the same driver (`kimi`) with DIFFERENT recorded commands.
  // Each is individually backfillable from its own acpx record, but the per-agent
  // target identities disagree. The migration must NOT silently pick one and
  // re-key the other onto it; both must be rejected and the config untouched.
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
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
    });
    expect(result.migrated).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    const aliases = result.skipped.map((s) => s.alias).sort();
    expect(aliases).toEqual(["relay:demo-a", "relay:demo-b"]);
    for (const s of result.skipped) {
      expect(s.reason).toMatch(/conflicting (recorded commands|target identities|argv identities)|refusing to pick one|different argv identities/);
    }
    expect(result.errors).toEqual([]);

    // Config and state should be unchanged.
    const configAfter = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const agentAfter = (configAfter.agents as Record<string, Record<string, unknown>>).kimi!;
    expect(agentAfter.argv).toBeUndefined();
    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const sessionsAfter = stateAfter.sessions as Record<string, Record<string, unknown>>;
    expect(sessionsAfter["relay:demo-a"]!.transport_agent_argv).toBeUndefined();
    expect(sessionsAfter["relay:demo-b"]!.transport_agent_argv).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 1: agents with unanimous argv identity are migrated together", async () => {
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
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
    });
    expect(result.migrated).toHaveLength(2);
    expect(result.configUpdates).toEqual([{ agent: "kimi", argv: ["kimi", "acp"] }]);
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
          // Concurrently written argv on disk — migration sees this on re-read
          // and treats A as already migrated.
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
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      readFile: customReadFile,
      logger: createNoopAppLogger(),
    });
    // A was already migrated in the fresh snapshot; we count it as migrated.
    expect(result.migrated).toEqual([
      { alias: "relay:demo", agent: "kimi", argv: ["kimi", "acp"] },
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);

    // Critical assertion: chat_contexts from the fresh snapshot MUST survive.
    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    expect(stateAfter.chat_contexts).toEqual({
      "weixin:user": { current_session: "relay:demo" },
    });
    // Config argv is still written — the plan was valid against the planning
    // snapshot, and the re-read only confirmed A didn't need re-migration.
    const configAfter = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect((configAfter.agents as Record<string, Record<string, unknown>>).kimi!.argv)
      .toEqual(["kimi", "acp"]);
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
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      readFile: customReadFile,
      logger: createNoopAppLogger(),
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
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
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
    const throwingReader = async () => {
      throw new Error("simulated EIO reading state.json");
    };
    const result = await migrateStateAgentArgv({
      statePath,
      configPath,
      acpxSessionsDir: "/nonexistent",
      readFile: throwingReader,
      logger: createNoopAppLogger(),
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

test("issue 5: surfaces config-patch failure and aborts state write", async () => {
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
    const beforeState = await readFile(statePath, "utf8");

    const result = await migrateStateAgentArgv({
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      patchConfig: async () => {
        throw new Error("simulated EIO writing config.json");
      },
      logger: createNoopAppLogger(),
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/config\.json patch failed.*simulated EIO/);
    // State MUST be untouched when config patch fails.
    expect(await readFile(statePath, "utf8")).toBe(beforeState);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


// is now obsolete: under the all-or-nothing transactional ordering, the
// config patch only runs AFTER fresh-state validation succeeds AND before
// the state write. If the state write fails, no config was ever written
// (or it was written together with the validation gate - abort happens
// before either write). The new tests below cover the abort paths.

test("issue 2 v2: fresh-state re-read failure aborts BOTH config and state writes", async () => {
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
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      readFile: customReadFile,
      logger: createNoopAppLogger(),
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

test("issue 2 v2: config patch conflict (existing argv differs) aborts state write", async () => {
  // Planning: A is backfillable from acpx record. Between planning and
  // the locked transaction, a concurrent writer sets kimi.argv to a
  // different identity. patchConfig (the dep) sees the conflict and
  // marks configOutcome.conflicted; the transaction must abort.
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
    await writeFile(statePath, stateRaw);
    // Initial config has matching argv (planning succeeds).
    await writeFile(configPath, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1, perf: { enabled: false, maxSizeBytes: 1, maxFiles: 0, retentionDays: 1 } },
      channel: { type: "weixin", replyMode: "stream" },
      channels: [], plugins: [],
      agents: { kimi: { driver: "kimi", argv: ["kimi", "acp"] } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    // Inject a patchConfig that simulates the post-planning conflict: the
    // live config has a DIFFERENT argv identity, so the mutator counts it
    // as a conflict and does not write.
    const customPatchConfig = async (mutate: (raw: Record<string, unknown>) => void): Promise<void> => {
      const raw = {
        transport: { type: "acpx-bridge" },
        agents: { kimi: { driver: "kimi", argv: ["kimi", "--other"] } },
      };
      mutate(raw);
    };

    const result = await migrateStateAgentArgv({
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      patchConfig: customPatchConfig,
      logger: createNoopAppLogger(),
    });

    // Session is not in skipped (fresh-state validation passed) and not
    // in migrated (config patch aborted). errors carries the conflict
    // reason so the operator sees what happened.
    expect(result.migrated).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.errors.some((e) => /conflicted|conflict/i.test(e))).toBe(true);
    // State stays untouched.
    expect(await readFile(statePath, "utf8")).toBe(stateRaw);
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
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      readAcpxRecord: throwingReader,
      logger: createNoopAppLogger(),
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
      statePath,
      configPath,
      acpxSessionsDir: acpxDir,
      logger: createNoopAppLogger(),
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

test("issue 1 v3: multi-token backfillable + single-token legacy raw => entire agent rejected", async () => {
  // A is backfillable (whitespace raw "kimi acp" with acpx record proving
  // argv). B has single-token raw "custom-agent.exe" with no argv. The
  // v2 per-agent bucket only saw A and would have written
  // agents.kimi.argv = ["kimi", "acp"]; B's resolveLaunchSpec would
  // then silently re-key onto the new argv via step 3. v3 must catch B
  // in the safety bucket and reject the whole agent.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportA = "demo:relay:demo-a:reset-1";
    const transportB = "demo:relay:demo-b:reset-2";
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
          transport_session: transportB,
          transport_agent_command: "custom-agent.exe",
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
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
    });
    expect(result.migrated).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    const aliases = result.skipped.map((s) => s.alias).sort();
    expect(aliases).toEqual(["relay:demo-a", "relay:demo-b"]);
    for (const s of result.skipped) {
      expect(s.reason).toMatch(/different argv identities/);
    }
    // Config and state should be unchanged.
    const configAfter = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const agentAfter = (configAfter.agents as Record<string, Record<string, unknown>>).kimi!;
    expect(agentAfter.argv).toBeUndefined();
    const stateAfter = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    const sessionsAfter = stateAfter.sessions as Record<string, Record<string, unknown>>;
    expect(sessionsAfter["relay:demo-a"]!.transport_agent_argv).toBeUndefined();
    expect(sessionsAfter["relay:demo-b"]!.transport_agent_argv).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
    });
    // A is migrated (backfilled); C is noop (already correct).
    expect(result.migrated.length).toBeGreaterThanOrEqual(1);
    expect(result.migrated.some((m) => m.alias === "relay:demo-a")).toBe(true);
    expect(result.skipped).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 1 v3: bucket of all noop sessions is steady state, not a skip", async () => {
  // Both sessions for the agent already have argv matching the planned
  // identity. Per-agent bucket is unanimous and all entries are noop;
  // result should be a noop, not a reject.
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
        "relay:demo-b": {
          alias: "relay:demo-b", agent: "kimi", workspace: "demo",
          transport_session: "demo:relay:demo-b:reset-2",
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
      agents: { kimi: { driver: "kimi", argv: ["kimi", "acp"] } },
      workspaces: { demo: { cwd: "C:\\demo" } },
      later: { defaultMode: "temp" },
    }));

    const result = await migrateStateAgentArgv({
      statePath, configPath, acpxSessionsDir: acpxDir, logger: createNoopAppLogger(),
    });
    expect(result.skipped).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.migrated).toEqual([]);
    expect(result.errors).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 2 v3: fresh state per-agent recheck catches new conflicting session added between planning and lock", async () => {
  // Planning: A = "kimi acp" (backfillable). No other sessions in the
  // bucket. Lock-acquired re-read of state reveals a new session B =
  // "kimi --other" for the same agent. The fresh per-agent recheck
  // must abort the whole transaction — without it, A would be migrated
  // and B would be silently re-keyed to A's argv via config step 3.
  const { dir, statePath, configPath, acpxDir } = await setupFixtureDir();
  try {
    const transportA = "demo:relay:demo-a:reset-1";
    const transportB = "demo:relay:demo-b:reset-2";
    await writeAcpxRecord(acpxDir, transportA, "kimi acp", ["kimi", "acp"]);
    const planningState = JSON.stringify({
      version: 1,
      sessions: {
        "relay:demo-a": {
          alias: "relay:demo-a", agent: "kimi", workspace: "demo",
          transport_session: transportA,
          transport_agent_command: "kimi acp",
          created_at: "2026-08-10T09:00:00.000Z", last_used_at: "2026-08-10T09:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
      scheduled_tasks: {},
    });
    // Fresh state: same as planning PLUS a new session B with a different identity.
    const freshState = JSON.stringify({
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
    });
    await writeFile(statePath, planningState);

    let readCount = 0;
    const nodeReadFile = (await import("node:fs/promises")).readFile;
    const customReadFile = async (path: string): Promise<string> => {
      if (path !== statePath) return await nodeReadFile(path, "utf8");
      readCount += 1;
      return readCount === 1 ? planningState : freshState;
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
      statePath, configPath, acpxSessionsDir: acpxDir,
      readFile: customReadFile, logger: createNoopAppLogger(),
    });

    expect(result.migrated).toEqual([]);
    expect(result.configUpdates).toEqual([]);
    expect(result.skipped.some((s) => s.alias === "relay:demo-b")).toBe(true);
    expect(result.errors.some((e) => /fresh state contains a session|fresh state.*differs from planned/.test(e))).toBe(true);
    // Both files untouched.
    expect(await readFile(statePath, "utf8")).toBe(planningState);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue 3 v3: result.configUpdates is empty when patchConfig throws", async () => {
  // The mutator pushes to a queue. If the actual config write throws
  // (simulated), result.configUpdates must NOT contain the queued
  // updates. result.errors gets the failure.
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
      statePath, configPath, acpxSessionsDir: acpxDir,
      patchConfig: async () => { throw new Error("simulated EIO writing config.json"); },
      logger: createNoopAppLogger(),
    });

    // patchConfig threw before the actual file write; result.configUpdates
    // was not committed.
    expect(result.configUpdates).toEqual([]);
    expect(result.migrated).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/config\.json patch failed.*simulated EIO/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
