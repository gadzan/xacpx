import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { garbageCollectAdapterReleases } from "../../../src/adapters/adapter-gc";
import { preinstallAdapter, validateAndReResolveAdapterCommand, type InstalledAdapterManifest } from "../../../src/adapters/adapter-preinstall";
import { LaunchIntentCoordinator } from "../../../src/transport/launch-intent-coordinator";
import { OrphanRegistry } from "../../../src/transport/orphan-registry";
import { sweepWindowsOrphans } from "../../../src/transport/windows-orphan-reaper";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const GENERATION_1 = "22222222-2222-4222-8222-222222222222";
const GENERATION_2 = "33333333-3333-4333-8333-333333333333";
const CREATION = "133801632000000000";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function installFixture() {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "adapter-orphan-e2e-"));
  roots.push(runtimeRoot);
  const node = join(runtimeRoot, "node-runtime", "node");
  await mkdir(dirname(node), { recursive: true });
  await writeFile(node, "#!/bin/sh\n");
  await chmod(node, 0o755);
  const ids = [
    "11111111-0000-4000-8000-000000000000", "12121212-0000-4000-8000-000000000000",
    "22222222-0000-4000-8000-000000000000", "23232323-0000-4000-8000-000000000000",
    "33333333-0000-4000-8000-000000000000", "34343434-0000-4000-8000-000000000000",
  ];
  const installPackage = async (staging: string, packageSpec: string) => {
    const version = packageSpec.slice(packageSpec.lastIndexOf("@") + 1);
    const packageRoot = join(staging, "node_modules", "@agentclientprotocol", "codex-acp");
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "@agentclientprotocol/codex-acp", version, bin: { "codex-acp": "bin/index.js" },
    }));
    await writeFile(join(packageRoot, "bin", "index.js"), "export {};\n");
  };
  const install = async (version: string) => await preinstallAdapter({
    runtimeRoot, id: "codex", version, registry: "https://registry.npmjs.org",
    nodeExecutable: node, uuid: () => ids.shift()!, installPackage, verify: async () => {},
  });
  const command = (release: { releaseDir: string; manifest: InstalledAdapterManifest }) =>
    `${JSON.stringify(node)} ${JSON.stringify(join(release.releaseDir, release.manifest.entryRelPath))}`;
  return { runtimeRoot, node, install, command };
}

test("preinstall -> intent -> owner -> daemon restart/reaper -> GC preserves then releases visibility", async () => {
  const f = await installFixture();
  await f.install("1.1.2");
  const launched = await f.install("1.1.3");
  let stateCommand = f.command(launched);
  await writeState(f.runtimeRoot, stateCommand);

  const registry = new OrphanRegistry(join(f.runtimeRoot, "runtime"));
  await registry.initialize();
  await registry.writeGeneration({
    generationId: GENERATION_1, daemonPid: 10, daemonCreationDate: CREATION, configRoot: f.runtimeRoot,
  });
  const coordinator = new LaunchIntentCoordinator({
    platform: "win32",
    runtimeRoot: f.runtimeRoot,
    configRoot: f.runtimeRoot,
    generationId: GENERATION_1,
    registry,
    classifyAdapter: () => "codex",
    resolveAdapter: async (command) => (await validateAndReResolveAdapterCommand(f.runtimeRoot, command)).agentCommand,
    withSessionLock: async (critical) => await critical({}),
    withAdapterLock: async (_id, critical) => await critical(),
    persistCommand: async (_locked, _sessionKey, command) => { stateCommand = command; await writeState(f.runtimeRoot, command); },
    queryLauncherIdentity: async () => ({ creationDate: CREATION }),
    verifyOwner: async () => ({
      creationDate: CREATION,
      commandLine: `acpx __queue-owner --xacpx-owner-token ${TOKEN}`,
      executablePath: f.node,
    }),
    snapshotToken: async () => [],
  });
  const key = { id: "codex", sessionKey: "logical", intentToken: TOKEN };
  await coordinator.handle("registerAdapterIntent", {
    ...key, agentCommand: stateCommand, launcherPid: 50, launcherCreationDate: CREATION,
  }, { launcherPid: 50 });
  await coordinator.handle("launcherSpawned", key);
  await coordinator.handle("launchSettled", {
    ...key, outcome: "owner-committed", ownerPid: 60, ownerAcpxRecordId: "record-1",
  });
  expect(await registry.readCategory("intents")).toEqual([]);
  expect(await registry.readCategory("owners")).toHaveLength(1);

  const newest = await f.install("1.1.4");
  stateCommand = f.command(newest);
  await writeState(f.runtimeRoot, stateCommand);
  expect((await garbageCollectAdapterReleases({
    runtimeRoot: f.runtimeRoot, id: "codex", releaseId: launched.manifest.releaseId,
    platform: "win32", orphanRegistry: registry, withLock: async (critical) => await critical(),
  }))[0]?.disposition).toBe("referenced");

  await registry.writeGeneration({
    generationId: GENERATION_2, daemonPid: 11, daemonCreationDate: CREATION, configRoot: f.runtimeRoot,
  });
  const sweep = await sweepWindowsOrphans(registry, GENERATION_2, {
    snapshotToken: async () => [{
      pid: 60, creationDate: CREATION,
      commandLine: `acpx __queue-owner --xacpx-owner-token ${TOKEN}`,
      executablePath: f.node,
    }],
    probeIdentity: async () => ({ status: "found", identity: { pid: 60, creationDate: CREATION, executablePath: f.node } }),
    terminateTree: async (root) => ({ rootOutcome: "killed", outcomes: [{ target: root, outcome: "killed" }] }),
  });
  expect(sweep.ownersDeleted).toBe(1);
  expect(await registry.readCategory("owners")).toEqual([]);
  expect((await garbageCollectAdapterReleases({
    runtimeRoot: f.runtimeRoot, id: "codex", releaseId: launched.manifest.releaseId,
    platform: "win32", orphanRegistry: registry, withLock: async (critical) => await critical(),
  }))[0]?.disposition).toBe("removed");
  await expect(stat(launched.releaseDir)).rejects.toMatchObject({ code: "ENOENT" });
});

test("Unix re-resolution persists the active command without creating orphan files", async () => {
  const f = await installFixture();
  const active = await f.install("1.1.4");
  let persisted = "";
  const coordinator = new LaunchIntentCoordinator({
    platform: "linux", runtimeRoot: f.runtimeRoot, configRoot: f.runtimeRoot, generationId: GENERATION_1,
    classifyAdapter: () => "codex",
    resolveAdapter: async (command) => (await validateAndReResolveAdapterCommand(f.runtimeRoot, command)).agentCommand,
    withSessionLock: async (critical) => await critical({}),
    withAdapterLock: async (_id, critical) => await critical(),
    persistCommand: async (_locked, _session, command) => { persisted = command; },
    queryLauncherIdentity: async () => null,
    verifyOwner: async () => null,
    snapshotToken: async () => null,
  });
  const resolved = await coordinator.handle("resolveAdapterCommand", {
    id: "codex", sessionKey: "logical", agentCommand: f.command(active),
  }) as { agentCommand: string };
  expect(persisted).toBe(resolved.agentCommand);
  expect(persisted).toContain(active.manifest.releaseId);
  await expect(stat(join(f.runtimeRoot, "runtime", "orphans"))).rejects.toMatchObject({ code: "ENOENT" });
});

async function writeState(runtimeRoot: string, command: string): Promise<void> {
  await writeFile(join(runtimeRoot, "state.json"), JSON.stringify({
    sessions: { logical: { transport_agent_command: command } },
  }));
}
