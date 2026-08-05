import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { OrphanRegistry } from "../../../src/transport/orphan-registry";
import { killWindowsOrphansWithConfirmation } from "../../../src/transport/manual-orphan-kill";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

test("manual taskkill path requires explicit confirmation and deletes only confirmed successes", async () => {
  root = await mkdtemp(join(tmpdir(), "xacpx-manual-orphans-"));
  const registry = new OrphanRegistry(root);
  await registry.initialize();
  await registry.writeOwner({
    schemaVersion: 1,
    token: "11111111-1111-4111-8111-111111111111",
    pid: 41,
    queueHash: "queue",
    acpxRecordId: "record",
    generationId: "22222222-2222-4222-8222-222222222222",
    configRoot: "C:\\xacpx",
    startedAt: "2026-08-05T00:00:00.000Z",
    agentCommand: "agent",
    fingerprint: null,
    killAttempts: 0,
  });
  await registry.writeResidual({
    kind: "residual",
    ownerToken: "11111111-1111-4111-8111-111111111111",
    pid: 42,
    creationDate: "133801632000000010",
    commandLine: "child",
    executablePath: "C:\\child.exe",
    agentCommand: "agent",
    generationId: "22222222-2222-4222-8222-222222222222",
    killAttempts: 1,
  });
  await expect(killWindowsOrphansWithConfirmation({ runtimeDir: root, registry, platform: "win32", confirmed: false }))
    .rejects.toThrow("--confirm");
  const seen: number[] = [];
  const result = await killWindowsOrphansWithConfirmation({
    runtimeDir: root,
    registry,
    platform: "win32",
    confirmed: true,
    runTaskkill: async (pid) => { seen.push(pid); return pid === 41; },
  });
  expect(seen).toEqual([41, 42]);
  expect(result).toEqual({ attempted: 2, killed: 1, retained: 1 });
  expect(await registry.readCategory("owners")).toEqual([]);
  expect(await registry.readCategory("residuals")).toHaveLength(1);
});
