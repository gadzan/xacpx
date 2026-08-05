import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { LaunchIntentCoordinator, type LaunchIntentCoordinatorDeps } from "../../../src/transport/launch-intent-coordinator";
import { OrphanRegistry, type OwnerRecord } from "../../../src/transport/orphan-registry";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const GENERATION = "22222222-2222-4222-8222-222222222222";
const CREATION = "133801632000000000";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(overrides: Partial<LaunchIntentCoordinatorDeps<{ persist(command: string): Promise<void> }>> = {}) {
  const root = await mkdtemp(join(tmpdir(), "xacpx-launch-intent-"));
  roots.push(root);
  const registry = overrides.registry ?? new OrphanRegistry(root);
  await registry.initialize();
  const events: string[] = [];
  const deps: LaunchIntentCoordinatorDeps<{ persist(command: string): Promise<void> }> = {
    platform: "win32",
    runtimeRoot: root,
    configRoot: root,
    generationId: GENERATION,
    registry,
    classifyAdapter: () => "codex",
    resolveAdapter: async () => { events.push("resolve"); return "resolved-adapter"; },
    withSessionLock: async (critical) => {
      events.push("session:lock");
      try { return await critical({ persist: async (command) => { events.push(`persist:${command}`); } }); }
      finally { events.push("session:release"); }
    },
    withAdapterLock: async (_id, critical) => {
      events.push("adapter:lock");
      try { return await critical(); }
      finally { events.push("adapter:release"); }
    },
    persistCommand: async (locked, _sessionKey, command) => locked.persist(command),
    queryLauncherIdentity: async () => ({ creationDate: CREATION }),
    verifyOwner: async (_pid, token) => token === TOKEN ? {
      creationDate: CREATION,
      commandLine: `agent --xacpx-owner-token ${TOKEN}`,
      executablePath: "C:\\agent.exe",
    } : null,
    snapshotToken: async () => [],
    now: () => new Date("2026-08-05T00:00:00.000Z"),
    ...overrides,
  };
  return { root, registry, events, coordinator: new LaunchIntentCoordinator(deps) };
}

function register(overrides: Record<string, unknown> = {}) {
  return {
    id: "launch-1",
    sessionKey: "session-key",
    agentCommand: "preinstalled-adapter",
    intentToken: TOKEN,
    launcherPid: 500,
    launcherCreationDate: CREATION,
    ...overrides,
  };
}

function token() { return { id: "launch-1", sessionKey: "session-key", intentToken: TOKEN }; }

test("register holds session then adapter lock through durable state and intent publication", async () => {
  const { coordinator, registry, events } = await setup();
  const ack = await coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 });
  expect(ack).toEqual({ agentCommand: "resolved-adapter", intentToken: TOKEN, generationId: GENERATION });
  expect(events).toEqual([
    "session:lock", "adapter:lock", "resolve", "persist:resolved-adapter", "adapter:release", "session:release",
  ]);
  const intents = await registry.readCategory("intents");
  expect(intents).toHaveLength(1);
  expect((intents?.[0]?.record as { launcherPid: number }).launcherPid).toBe(500);
  expect(coordinator.stateFor(token())).toBe("registered");
});

test("state durability failure aborts launch before any intent write", async () => {
  const value = await setup({
    persistCommand: async () => { throw new Error("saveNow failed"); },
  });
  await expect(value.coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 }))
    .rejects.toThrow("saveNow failed");
  expect(await value.registry.readCategory("intents")).toEqual([]);
  expect(value.coordinator.stateFor(token())).toBe("aborted");
  expect(value.events).toContain("adapter:release");
  expect(value.events).toContain("session:release");
});

test("duplicate registering calls share one in-flight durable operation", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let resolves = 0;
  const value = await setup({
    resolveAdapter: async () => { resolves += 1; await gate; return "resolved-adapter"; },
  });
  const first = value.coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 });
  await Promise.resolve();
  const duplicate = value.coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 });
  release();
  await expect(Promise.all([first, duplicate])).resolves.toEqual([
    { agentCommand: "resolved-adapter", intentToken: TOKEN, generationId: GENERATION },
    { agentCommand: "resolved-adapter", intentToken: TOKEN, generationId: GENERATION },
  ]);
  expect(resolves).toBe(1);
});

test("registered replay is idempotent, changed payload and post-spawn replay are rejected", async () => {
  const { coordinator, registry } = await setup();
  const ack = await coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 });
  await expect(coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 })).resolves.toEqual(ack);
  await expect(coordinator.handle("registerAdapterIntent", register({ agentCommand: "different" }), { launcherPid: 500 }))
    .rejects.toThrow("payload mismatch");
  expect(await registry.readCategory("intents")).toHaveLength(1);
  await coordinator.handle("launcherSpawned", token());
  await expect(coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 })).rejects.toThrow("spawn-committed");
});

test("cancel before register rejects late registration; cancel during registering leaves no intent", async () => {
  const first = await setup();
  await first.coordinator.handle("cancelAdapterIntent", token());
  await expect(first.coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 })).rejects.toThrow();
  expect(await first.registry.readCategory("intents")).toEqual([]);

  let releaseResolve!: () => void;
  const gate = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const second = await setup({ resolveAdapter: async () => { await gate; return "resolved-adapter"; } });
  const registering = second.coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 });
  await Promise.resolve();
  await second.coordinator.handle("cancelAdapterIntent", token());
  releaseResolve();
  await expect(registering).rejects.toThrow("aborted before intent write");
  expect(await second.registry.readCategory("intents")).toEqual([]);
  expect(second.coordinator.stateFor(token())).toBe("canceled");
});

test("disconnect checkpoints abort before write and delete a just-renamed intent", async () => {
  let coordinator!: LaunchIntentCoordinator<{ persist(command: string): Promise<void> }>;
  const root = await mkdtemp(join(tmpdir(), "xacpx-launch-intent-race-"));
  roots.push(root);
  const registry = new OrphanRegistry(root, {
    onBoundary: (boundary, path) => {
      if (boundary === "after-rename" && path.includes("intents")) coordinator.disconnect();
    },
  });
  const value = await setup({ registry });
  coordinator = value.coordinator;
  await expect(coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 })).rejects.toThrow("aborted after intent write");
  expect(await registry.readCategory("intents")).toEqual([]);
  expect(coordinator.stateFor(token())).toBe("aborted");
});

test("disconnect after registered or spawned conservatively retains intent", async () => {
  for (const spawned of [false, true]) {
    const { coordinator, registry } = await setup();
    await coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 });
    if (spawned) await coordinator.handle("launcherSpawned", token());
    coordinator.disconnect();
    expect(await registry.readCategory("intents")).toHaveLength(1);
    expect(coordinator.stateFor(token())).toBe(spawned ? "spawn-committed" : "registered");
  }
});

test("owner settlement trusts daemon verification, migrates durably, and replays same terminal outcome", async () => {
  const { coordinator, registry } = await setup();
  await coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 });
  await coordinator.handle("launcherSpawned", token());
  const settled = { ...token(), outcome: "owner-committed", ownerPid: 600, ownerAcpxRecordId: "record-1" };
  await coordinator.handle("launchSettled", settled);
  await expect(coordinator.handle("launchSettled", settled)).resolves.toEqual({});
  expect(await registry.readCategory("intents")).toEqual([]);
  const owners = await registry.readCategory("owners");
  expect((owners?.[0]?.record as OwnerRecord).fingerprint?.commandLine).toContain(TOKEN);
  await expect(coordinator.handle("launchSettled", { ...token(), outcome: "launch-failed" })).rejects.toThrow("owner-committed");
});

test("owner verification and launch-failed token uncertainty retain the intent", async () => {
  const badOwner = await setup({ verifyOwner: async () => null });
  await badOwner.coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 });
  await badOwner.coordinator.handle("launcherSpawned", token());
  await expect(badOwner.coordinator.handle("launchSettled", {
    ...token(), outcome: "owner-committed", ownerPid: 600, ownerAcpxRecordId: "record",
  })).rejects.toThrow("verification failed");
  expect(await badOwner.registry.readCategory("intents")).toHaveLength(1);

  for (const snapshot of [null, [{}]]) {
    const failed = await setup({ snapshotToken: async () => snapshot });
    await failed.coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 });
    await failed.coordinator.handle("launcherSpawned", token());
    await expect(failed.coordinator.handle("launchSettled", { ...token(), outcome: "launch-failed" }))
      .rejects.toThrow("snapshot");
    expect(await failed.registry.readCategory("intents")).toHaveLength(1);
  }
});

test("Unix resolve command has no token state or orphan writes", async () => {
  const { coordinator, registry, events } = await setup({ platform: "linux", registry: undefined });
  await expect(coordinator.handle("resolveAdapterCommand", {
    id: "resolve-1", sessionKey: "session-key", agentCommand: "preinstalled-adapter",
  })).resolves.toEqual({ agentCommand: "resolved-adapter" });
  expect(events.slice(0, 4)).toEqual(["session:lock", "adapter:lock", "resolve", "persist:resolved-adapter"]);
  expect(await registry.readCategory("intents")).toEqual([]);
  await expect(coordinator.handle("registerAdapterIntent", register(), { launcherPid: 500 })).rejects.toThrow("Windows-only");
});
