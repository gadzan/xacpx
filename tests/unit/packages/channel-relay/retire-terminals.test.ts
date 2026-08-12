import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RelayChannel } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";
import { InMemoryRmuxDriver } from "../../../../packages/channel-relay/src/terminal/in-memory-rmux-driver";
import { TerminalRegistryStore } from "../../../../packages/channel-relay/src/terminal/terminal-registry-store";
import { retireRelayTerminals } from "../../../../packages/channel-relay/src/terminal/retire-terminals";
import type {
  SessionResourceCatalog,
  SessionResourceDescriptor,
  SessionResourceLifecycleEvent,
} from "xacpx/plugin-api";

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load() { return this.value; }
  save(credential: RelayCredential) { this.value = credential; }
  clear() { this.value = null; }
}

class FakeCatalog implements SessionResourceCatalog {
  constructor(private readonly rows: SessionResourceDescriptor[] = []) {}
  async resolve(_c: string, alias: string) {
    return this.rows.find((r) => r.displayAlias === alias) ?? null;
  }
  async list(channelId: string) {
    return this.rows.filter((r) => r.channelId === channelId);
  }
  subscribe(_l: (e: SessionResourceLifecycleEvent) => void) {
    return () => {};
  }
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function descriptor(): SessionResourceDescriptor {
  return {
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    channelId: "relay",
    internalAlias: "demo",
    displayAlias: "demo",
    workspace: "ws",
    cwd: "/tmp/ws",
    archived: false,
  };
}

async function seedLiveTerminal(dir: string, driver: InMemoryRmuxDriver): Promise<{
  terminalId: string;
  sessionId: string;
}> {
  // Simulate a previous process that left durable live + an RMUX session.
  // Process-owned stop() would kill, so we seed registry/driver directly.
  const registry = new TerminalRegistryStore({ dir });
  await registry.load();
  const installationId = registry.getSnapshot().installationId;
  const terminalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const generation = "gen-seed";
  const name = `xacpx-relay-${installationId.slice(0, 8)}-${terminalId.replaceAll("-", "")}`;
  const created = await driver.create({
    name,
    cwd: "/tmp/ws",
    cols: 80,
    rows: 24,
    historyLimit: 1000,
    tags: [
      "xacpx:relay",
      `owner:${installationId}`,
      "logical:11111111-1111-4111-8111-111111111111",
      `terminal:${terminalId}`,
      `generation:${generation}`,
      "schema:1",
    ],
    ownerLeaseTtlSeconds: 90,
  });
  let snap = registry.getSnapshot();
  await registry.upsertCreating({
    terminalId,
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    internalAliasSnapshot: "demo",
    rmuxSessionName: name,
    generation,
  });
  snap = registry.getSnapshot();
  await registry.markLive(terminalId, { rmuxSessionId: created.sessionId });
  return { terminalId, sessionId: created.sessionId };
}

test("retireRelayTerminals is idle when registry is empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retire-empty-"));
  dirs.push(dir);
  const result = await retireRelayTerminals({ registryDir: dir });
  expect(result).toEqual({ status: "idle" });
});

test("retireRelayTerminals durable-reaps then kills without hub", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retire-live-"));
  dirs.push(dir);
  const driver = new InMemoryRmuxDriver();
  await seedLiveTerminal(dir, driver);
  expect((await driver.list()).length).toBe(1);

  const result = await retireRelayTerminals({
    registryDir: dir,
    createDriver: () => driver,
  });
  expect(result.status).toBe("terminated");
  expect((await driver.list()).length).toBe(0);

  const registry = new TerminalRegistryStore({ dir });
  await registry.load();
  expect(Object.keys(registry.getSnapshot().terminals)).toEqual([]);
  // Owner identity must survive so a later process can still fence/reconcile.
  expect(registry.getSnapshot().installationId.length).toBeGreaterThan(0);
});

test("retireRelayTerminals is idempotent after a successful cleanup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retire-idem-"));
  dirs.push(dir);
  const driver = new InMemoryRmuxDriver();
  await seedLiveTerminal(dir, driver);
  await retireRelayTerminals({ registryDir: dir, createDriver: () => driver });
  const again = await retireRelayTerminals({ registryDir: dir, createDriver: () => driver });
  expect(again).toEqual({ status: "idle" });
});

function makeStartInput(overrides: Record<string, unknown> = {}) {
  return {
    agent: { chat: async () => ({ text: "" }) },
    abortSignal: new AbortController().signal,
    quota: {} as never,
    logger: { info: async () => {}, error: async () => {}, debug: async () => {} },
    control: {
      events: { subscribe: () => () => {} },
      listSessions: () => [],
      listScheduledTasks: () => [],
      listOrchestrationTasks: () => [],
      runScheduledTurn: async () => ({ ok: true }),
    },
    coreVersion: "0.17.0",
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await Bun.sleep(5);
  }
}

test("bootstrap with terminal.enabled=false retires leftover registry records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retire-boot-"));
  dirs.push(dir);
  const driver = new InMemoryRmuxDriver();
  await seedLiveTerminal(dir, driver);
  expect((await driver.list()).length).toBe(1);

  let clientStarted = false;
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t" }, // terminal defaults disabled
    {
      credentialStore: new MemoryCredentialStore(),
      terminalRegistryDir: dir,
      createTerminalDriver: () => driver,
      createClient: () => {
        clientStarted = true;
        return { start: () => {}, stop: () => {}, sendEvent: () => {} };
      },
    },
  );
  const controller = new AbortController();
  const started = channel.start(
    makeStartInput({ abortSignal: controller.signal }) as never,
  );
  await waitFor(() => clientStarted);
  expect((await driver.list()).length).toBe(0);
  controller.abort();
  await started;
});

test("retireRelayTerminals returns cleanup-pending when kill cannot confirm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retire-pending-"));
  dirs.push(dir);
  const driver = new InMemoryRmuxDriver();
  await seedLiveTerminal(dir, driver);
  driver.configureFailure("kill", new Error("rmux-unreachable"));

  const result = await retireRelayTerminals({
    registryDir: dir,
    createDriver: () => driver,
  });
  expect(result.status).toBe("cleanup-pending");

  const registry = new TerminalRegistryStore({ dir });
  await registry.load();
  const remaining = Object.values(registry.getSnapshot().terminals);
  expect(remaining.length).toBeGreaterThan(0);
  expect(remaining.every((r) => r.state === "reaping")).toBe(true);
  expect(registry.getSnapshot().installationId.length).toBeGreaterThan(0);
});

test("logout clears credentials only after terminateAll attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retire-logout-"));
  dirs.push(dir);
  const driver = new InMemoryRmuxDriver();
  const creds = new MemoryCredentialStore({
    instanceId: "inst",
    credential: "cred",
    relayUrl: "ws://h:1",
  });

  let clientStarted = false;
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t", terminal: { enabled: true } },
    {
      credentialStore: creds,
      terminalRegistryDir: dir,
      createTerminalDriver: () => driver,
      createClient: () => {
        clientStarted = true;
        return { start: () => {}, stop: () => {}, sendEvent: () => {} };
      },
    },
  );
  const controller = new AbortController();
  const started = channel.start(
    makeStartInput({
      abortSignal: controller.signal,
      sessionResources: new FakeCatalog([descriptor()]),
    }) as never,
  );
  await waitFor(() => clientStarted && channel.getTerminalRuntimeForTests() !== null);

  const runtime = channel.getTerminalRuntimeForTests()!;
  await runtime.openOrResume({
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v1",
    cols: 80,
    rows: 24,
  });
  expect((await driver.list()).length).toBe(1);
  expect(creds.load()).not.toBeNull();

  await channel.logout();
  expect(creds.load()).toBeNull();
  expect((await driver.list()).length).toBe(0);

  controller.abort();
  await started;
});
