import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initializeWindowsDaemonRuntime } from "../../../src/daemon/windows-daemon-runtime";
import { OrphanRegistry } from "../../../src/transport/orphan-registry";

test("published daemon startup writes and returns durable Windows identity dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "xacpx-windows-daemon-runtime-"));
  const runtimeDir = join(root, "runtime");
  const identity = {
    generationId: "33333333-3333-4333-8333-333333333333",
    daemonPid: 75792,
    daemonCreationDate: "133801632000000000",
    configRoot: root,
  };

  const result = await initializeWindowsDaemonRuntime({
    platform: "win32",
    configPath: join(root, "config.json"),
    runtimeDir,
    createIdentity: async (input) => {
      expect(input).toMatchObject({ configRoot: root, platform: "win32" });
      return identity;
    },
  });

  expect(result.daemonIdentity).toEqual(identity);
  expect(result.orphanRegistry?.root).toBe(join(runtimeDir, "orphans"));
  await expect(result.orphanRegistry?.readGeneration()).resolves.toBeNull();

  await result.publishGeneration?.();
  await expect(result.orphanRegistry?.readGeneration()).resolves.toEqual(identity);

  await rm(root, { recursive: true, force: true });
});

test("non-Windows daemon startup does not create Windows identity state", async () => {
  await expect(initializeWindowsDaemonRuntime({
    platform: "darwin",
    configPath: "/tmp/xacpx/config.json",
    runtimeDir: "/tmp/xacpx/runtime",
  })).resolves.toEqual({});
});

test("preparing a competing Windows runtime does not overwrite the active generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "xacpx-windows-daemon-runtime-"));
  const runtimeDir = join(root, "runtime");
  const registry = new OrphanRegistry(runtimeDir);
  const activeIdentity = {
    generationId: "33333333-3333-4333-8333-333333333333",
    daemonPid: 70001,
    daemonCreationDate: "133801632000000000",
    configRoot: root,
  };
  await registry.initialize();
  await registry.writeGeneration(activeIdentity);

  const competing = await initializeWindowsDaemonRuntime({
    platform: "win32",
    configPath: join(root, "config.json"),
    runtimeDir,
    createRegistry: () => registry,
    createIdentity: async () => ({
      generationId: "44444444-4444-4444-8444-444444444444",
      daemonPid: 70002,
      daemonCreationDate: "133801632000100000",
      configRoot: root,
    }),
  });

  await expect(registry.readGeneration()).resolves.toEqual(activeIdentity);

  await rm(root, { recursive: true, force: true });
});
