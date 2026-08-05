import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { garbageCollectAdapterReleases } from "../../../src/adapters/adapter-gc";
import { preinstallAdapter, type InstalledAdapterManifest } from "../../../src/adapters/adapter-preinstall";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "adapter-gc-"));
  roots.push(runtimeRoot);
  const node = join(runtimeRoot, "runtime", "node");
  await mkdir(dirname(node), { recursive: true });
  await writeFile(node, "#!/bin/sh\n");
  await chmod(node, 0o755);
  const installPackage = async (staging: string, packageSpec: string) => {
    const packageRoot = join(staging, "node_modules", "@agentclientprotocol", "codex-acp");
    const version = packageSpec.endsWith("1.1.3") ? "1.1.3" : "1.1.4";
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "@agentclientprotocol/codex-acp",
      version,
      bin: { "codex-acp": "bin/codex-acp.js" },
    }));
    await writeFile(join(packageRoot, "bin", "codex-acp.js"), "export {};\n");
  };
  const uuidValues = [
    "11111111-0000-4000-8000-000000000000", "12121212-0000-4000-8000-000000000000",
    "22222222-0000-4000-8000-000000000000", "23232323-0000-4000-8000-000000000000",
  ];
  const install = async (version: "1.1.3" | "1.1.4") => await preinstallAdapter({
    runtimeRoot,
    id: "codex",
    version,
    registry: "https://registry.npmjs.org",
    nodeExecutable: node,
    uuid: () => uuidValues.shift()!,
    installPackage,
    verify: async () => {},
  });
  const old = await install("1.1.3");
  const active = await install("1.1.4");
  const command = (release: { releaseDir: string; manifest: InstalledAdapterManifest }) =>
    `${JSON.stringify(node)} ${JSON.stringify(join(release.releaseDir, release.manifest.entryRelPath))}`;
  const writeState = async (commands: string[]) => {
    await writeFile(join(runtimeRoot, "state.json"), JSON.stringify({
      sessions: Object.fromEntries(commands.map((value, index) => [`s${index}`, { transport_agent_command: value }])),
    }));
  };
  return { runtimeRoot, node, old, active, command, writeState };
}

const noLock = async <T>(critical: () => Promise<T>) => await critical();

test("protects active and state-referenced releases, then removes an unreferenced immutable release", async () => {
  const f = await fixture();
  await f.writeState([f.command(f.old)]);
  expect(await garbageCollectAdapterReleases({
    runtimeRoot: f.runtimeRoot, id: "codex", platform: "linux", withLock: noLock,
  })).toEqual([
    { id: "codex", releaseId: f.old.manifest.releaseId, disposition: "referenced" },
    { id: "codex", releaseId: f.active.manifest.releaseId, disposition: "active" },
  ]);
  await f.writeState([]);
  expect(await garbageCollectAdapterReleases({
    runtimeRoot: f.runtimeRoot, id: "codex", releaseId: f.old.manifest.releaseId,
    platform: "linux", withLock: noLock,
  })).toEqual([{ id: "codex", releaseId: f.old.manifest.releaseId, disposition: "removed" }]);
  await expect(stat(f.old.releaseDir)).rejects.toMatchObject({ code: "ENOENT" });
});

test("uses args[1] as the release reference and rejects an untrusted args[0] node", async () => {
  const f = await fixture();
  const untrusted = join(f.runtimeRoot, "other", "node");
  await mkdir(dirname(untrusted), { recursive: true });
  await writeFile(untrusted, "#!/bin/sh\n");
  await chmod(untrusted, 0o755);
  const entry = join(f.old.releaseDir, f.old.manifest.entryRelPath);
  await f.writeState([`${JSON.stringify(untrusted)} ${JSON.stringify(entry)}`]);
  await expect(garbageCollectAdapterReleases({
    runtimeRoot: f.runtimeRoot, id: "codex", releaseId: f.old.manifest.releaseId,
    platform: "linux", withLock: noLock,
  })).rejects.toThrow("decoded safely");
  expect((await stat(f.old.releaseDir)).isDirectory()).toBe(true);
});

test("fails closed on malformed active pointer, state, release manifest, or unknown managed reference", async () => {
  for (const corruption of ["pointer", "state", "manifest", "unknown-reference"] as const) {
    const f = await fixture();
    if (corruption === "pointer") await writeFile(join(f.runtimeRoot, "adapters", "codex", "active.json"), "{");
    if (corruption === "state") await writeFile(join(f.runtimeRoot, "state.json"), "{");
    if (corruption === "manifest") await writeFile(join(f.old.releaseDir, "installed.json"), "{}");
    if (corruption === "unknown-reference") {
      const unknown = f.command(f.old).replace(f.old.manifest.releaseId, "9.9.9-aaaaaaaa-bbbbbbbb");
      await f.writeState([unknown]);
    }
    await expect(garbageCollectAdapterReleases({
      runtimeRoot: f.runtimeRoot, id: "codex", releaseId: f.old.manifest.releaseId,
      platform: "linux", withLock: noLock,
    })).rejects.toThrow();
    expect((await stat(f.old.releaseDir)).isDirectory()).toBe(true);
  }
});

test("Windows scans orphan categories in canonical order and abandons deletion on migration revision change", async () => {
  const f = await fixture();
  await f.writeState([]);
  const categories: string[][] = [];
  let scan = 0;
  const result = await garbageCollectAdapterReleases({
    runtimeRoot: f.runtimeRoot,
    id: "codex",
    releaseId: f.old.manifest.releaseId,
    platform: "win32",
    withLock: noLock,
    orphanRegistry: {
      listOwnerAgentCommands: async (value) => {
        categories.push([...value]);
        scan += 1;
        return {
          commands: scan === 1 ? [] : [f.command(f.old)],
          snapshotRevision: `revision-${scan}`,
        };
      },
    },
  });
  expect(categories).toEqual([
    ["intents", "owners", "residuals"],
    ["intents", "owners", "residuals"],
  ]);
  expect(result).toEqual([{ id: "codex", releaseId: f.old.manifest.releaseId, disposition: "changed" }]);
  expect((await stat(f.old.releaseDir)).isDirectory()).toBe(true);
});

test("double scan also detects state publication between candidate selection and deletion", async () => {
  const f = await fixture();
  await f.writeState([]);
  const result = await garbageCollectAdapterReleases({
    runtimeRoot: f.runtimeRoot,
    id: "codex",
    releaseId: f.old.manifest.releaseId,
    platform: "linux",
    withLock: noLock,
    beforeSecondScan: async () => { await f.writeState([f.command(f.old)]); },
  });
  expect(result[0]?.disposition).toBe("changed");
  expect((await stat(f.old.releaseDir)).isDirectory()).toBe(true);
});

test("missing target is idempotent and invalid release ids never become filesystem paths", async () => {
  const f = await fixture();
  expect(await garbageCollectAdapterReleases({
    runtimeRoot: f.runtimeRoot, id: "codex", releaseId: "1.1.2-aaaaaaaa-bbbbbbbb",
    platform: "linux", withLock: noLock,
  })).toEqual([{ id: "codex", releaseId: "1.1.2-aaaaaaaa-bbbbbbbb", disposition: "missing" }]);
  await expect(garbageCollectAdapterReleases({
    runtimeRoot: f.runtimeRoot, id: "codex", releaseId: "../../escape",
    platform: "linux", withLock: noLock,
  })).rejects.toThrow("invalid adapter release id");
  expect(await readFile(join(f.runtimeRoot, "state.json"), "utf8").catch(() => "missing")).toBe("missing");
});
