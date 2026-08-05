import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ORPHAN_CATEGORIES,
  OrphanRegistry,
  createDaemonIdentity,
  decodeLaunchIntent,
  decodeOwnerRecord,
  decodeResidualRecord,
  type LaunchIntentRecord,
  type OwnerRecord,
  type ResidualRecord,
} from "../../../src/transport/orphan-registry";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const token = "11111111-1111-4111-8111-111111111111";
const generationId = "22222222-2222-4222-8222-222222222222";

function intent(overrides: Partial<LaunchIntentRecord> = {}): LaunchIntentRecord {
  return {
    schemaVersion: 1, kind: "intent", token, launcherPid: 101,
    launcherCreationDate: "133830000000000000", generationId, configRoot: "C:\\xacpx",
    queueHash: "queue-hash", agentCommand: "node adapter.js", createdAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

function owner(overrides: Partial<OwnerRecord> = {}): OwnerRecord {
  return {
    schemaVersion: 1, token, pid: 202, queueHash: "queue-hash", acpxRecordId: "record-1234",
    generationId, configRoot: "C:\\xacpx", startedAt: "2026-08-05T00:00:01.000Z",
    agentCommand: "node adapter.js", fingerprint: {
      executablePath: "C:\\node.exe", commandLine: "node adapter.js --xacpx-owner-token token",
      creationDate: "133830000000000100",
    }, killAttempts: 0,
    ...overrides,
  };
}

function residual(pid: number, overrides: Partial<ResidualRecord> = {}): ResidualRecord {
  return {
    kind: "residual", ownerToken: token, pid, creationDate: String(133830000000000000n + BigInt(pid)),
    commandLine: `agent-${pid}`, executablePath: `C:\\agent-${pid}.exe`, agentCommand: "node adapter.js",
    generationId, killAttempts: 0, ...overrides,
  };
}

async function fixture(faults?: ConstructorParameters<typeof OrphanRegistry>[1]) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "orphan-registry-"));
  roots.push(runtimeRoot);
  const registry = new OrphanRegistry(runtimeRoot, faults);
  await registry.initialize();
  return { runtimeRoot, registry };
}

test("strict decoders reject noncanonical ticks and incomplete fingerprints", () => {
  expect(decodeLaunchIntent(intent())).not.toBeNull();
  expect(decodeLaunchIntent(intent({ launcherCreationDate: "0133830000000000000" }))).toBeNull();
  expect(decodeOwnerRecord(owner())).not.toBeNull();
  expect(decodeOwnerRecord(owner({ fingerprint: { executablePath: "x", commandLine: "", creationDate: "1" } }))).toBeNull();
  expect(decodeResidualRecord(residual(303))).not.toBeNull();
  expect(decodeResidualRecord(residual(303, { creationDate: "1.0" }))).toBeNull();
});

test("daemon identity is created before composition and Windows identity failure remains null", async () => {
  const captured = await createDaemonIdentity({
    configRoot: "C:\\xacpx",
    pid: 55,
    platform: "win32",
    generationId,
    queryIdentity: async () => ({ pid: 55, creationDate: "133830000000000000", executablePath: "C:\\node.exe" }),
  });
  expect(captured).toEqual({
    generationId, daemonPid: 55, daemonCreationDate: "133830000000000000", configRoot: "C:\\xacpx",
  });
  const unavailable = await createDaemonIdentity({
    configRoot: "C:\\xacpx", pid: 55, platform: "win32", generationId, queryIdentity: async () => null,
  });
  expect(unavailable.daemonCreationDate).toBeNull();
  const unix = await createDaemonIdentity({ configRoot: "/tmp/xacpx", pid: 55, platform: "linux", generationId });
  expect(unix.daemonCreationDate).toBeNull();
});

test("writes generation and records durably and scans in the required stable order", async () => {
  const { registry } = await fixture();
  await registry.writeGeneration({ generationId, daemonPid: 99, daemonCreationDate: "133830000000000000", configRoot: "C:\\xacpx" });
  expect(await registry.readGeneration()).toMatchObject({ generationId, daemonPid: 99 });
  await registry.writeIntent(intent());
  await registry.writeOwner(owner({ token: "33333333-3333-4333-8333-333333333333", pid: 203 }));
  await registry.writeResidual(residual(303));
  const first = await registry.listOwnerAgentCommands(ORPHAN_CATEGORIES);
  expect(first?.commands).toEqual(["node adapter.js", "node adapter.js", "node adapter.js"]);
  expect(first?.snapshotRevision).toMatch(/^[0-9a-f]{64}$/);
  await expect(registry.listOwnerAgentCommands(["owners", "intents", "residuals"])).rejects.toThrow("exactly");
  await registry.writeResidual(residual(304));
  const second = await registry.listOwnerAgentCommands(ORPHAN_CATEGORIES);
  expect(second?.snapshotRevision).not.toBe(first?.snapshotRevision);
});

test("intent to owner migration writes the owner before deleting intent", async () => {
  const events: string[] = [];
  const { registry } = await fixture({ onBoundary: (boundary, path) => events.push(`${boundary}:${path}`) });
  await registry.writeIntent(intent());
  events.length = 0;
  await registry.migrateIntentToOwner(token, owner());
  expect((await registry.readCategory("intents"))?.length).toBe(0);
  expect((await registry.readCategory("owners"))?.length).toBe(1);
  expect(events.some((event) => event.startsWith("after-rename:") && event.includes("owners"))).toBe(true);
});

test("partial owner-to-residual failure preserves owner and already durable residuals", async () => {
  let residualWrites = 0;
  const { registry } = await fixture({
    onBoundary: (boundary, path) => {
      if (boundary === "before-write" && path.includes("residuals")) {
        residualWrites += 1;
        if (residualWrites === 2) throw new Error("injected residual failure");
      }
    },
  });
  const ownerFilename = await registry.writeOwner(owner());
  await expect(registry.migrateOwnerToResiduals(ownerFilename, [residual(301), residual(302)]))
    .rejects.toThrow("injected residual failure");
  expect((await registry.readCategory("owners"))?.length).toBe(1);
  expect((await registry.readCategory("residuals"))?.map((entry) => entry.record.pid)).toEqual([301]);
});

test("invalid or missing categories return null and startup cleans only tmp debris", async () => {
  const { runtimeRoot, registry } = await fixture();
  await writeFile(join(registry.root, "intents", "broken.json"), "not-json");
  expect(await registry.listOwnerAgentCommands(ORPHAN_CATEGORIES)).toBeNull();
  await rm(join(registry.root, "intents", "broken.json"));
  await writeFile(join(registry.root, "intents", "keep.json.tmp-dead"), "partial");
  await writeFile(join(registry.root, "intents", "keep.txt"), "keep");
  await registry.cleanupTemporaryDebris();
  await expect(stat(join(registry.root, "intents", "keep.json.tmp-dead"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(registry.root, "intents", "keep.txt"), "utf8")).toBe("keep");
  await rm(join(registry.root, "owners"), { recursive: true });
  expect(await registry.listOwnerAgentCommands(ORPHAN_CATEGORIES)).toBeNull();
  expect(runtimeRoot).toBeTruthy();
});
