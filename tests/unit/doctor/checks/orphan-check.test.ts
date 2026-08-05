import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkOrphans } from "../../../../src/doctor/checks/orphan-check";
import { OrphanRegistry } from "../../../../src/transport/orphan-registry";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("reports persistent intents and unverifiable owners as degraded without mutating them", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "xacpx-doctor-orphans-"));
  roots.push(runtimeDir);
  const registry = new OrphanRegistry(runtimeDir);
  await registry.initialize();
  await registry.writeIntent({
    schemaVersion: 1,
    kind: "intent",
    token: "11111111-1111-4111-8111-111111111111",
    launcherPid: 50,
    launcherCreationDate: "133801632000000000",
    generationId: "22222222-2222-4222-8222-222222222222",
    configRoot: "C:\\xacpx",
    queueHash: "queue",
    agentCommand: "agent",
    createdAt: "2026-08-05T00:00:00.000Z",
  });
  await registry.writeOwner({
    schemaVersion: 1,
    token: "33333333-3333-4333-8333-333333333333",
    pid: 60,
    queueHash: "queue2",
    acpxRecordId: "record",
    generationId: "22222222-2222-4222-8222-222222222222",
    configRoot: "C:\\xacpx",
    startedAt: "2026-08-05T00:00:00.000Z",
    agentCommand: "agent",
    fingerprint: null,
    killAttempts: 0,
  });
  const result = await checkOrphans({
    runtimeDir,
    platform: "win32",
    registry,
    now: () => Date.parse("2026-08-05T00:02:00.001Z"),
  });
  expect(result.severity).toBe("warn");
  expect(result.details).toContain("intents: 1 (1 older than 60s)");
  expect(result.details).toContain("owners: 1 (1 without a killable fingerprint)");
  expect(await registry.readCategory("intents")).toHaveLength(1);
});

test("reports malformed registries as degraded and Unix as skipped", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "xacpx-doctor-orphans-"));
  roots.push(runtimeDir);
  const registry = new OrphanRegistry(runtimeDir);
  await registry.initialize();
  await writeFile(join(registry.root, "intents", "broken.json"), "{");
  expect((await checkOrphans({ runtimeDir, platform: "win32", registry })).summary).toContain("unreadable");
  expect((await checkOrphans({ runtimeDir, platform: "linux", registry })).severity).toBe("skip");
});
