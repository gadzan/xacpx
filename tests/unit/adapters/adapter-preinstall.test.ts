import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  preinstallAdapter,
  readActiveAdapterPointer,
  recoverAdapterInstall,
  validateAndReResolveAdapterCommand,
  validateAdapterRelease,
} from "../../../src/adapters/adapter-preinstall";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "adapter-preinstall-"));
  roots.push(runtimeRoot);
  const node = join(runtimeRoot, "runtime", "node");
  await mkdir(dirname(node), { recursive: true });
  await writeFile(node, "#!/bin/sh\n");
  await chmod(node, 0o755);
  const installPackage = async (staging: string) => {
    const packageRoot = join(staging, "node_modules", "@agentclientprotocol", "codex-acp");
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "@agentclientprotocol/codex-acp",
      version: "1.1.4",
      bin: { "codex-acp": "bin/codex-acp.js" },
    }));
    await writeFile(join(packageRoot, "bin", "codex-acp.js"), "export {};\n");
  };
  return { runtimeRoot, node, installPackage };
}

test("installs, validates, probes, renames an immutable release, then atomically publishes active", async () => {
  const { runtimeRoot, node, installPackage } = await fixture();
  const probes: string[] = [];
  const uuids = ["11111111-0000-4000-8000-000000000000", "22222222-0000-4000-8000-000000000000"];
  const installed = await preinstallAdapter({
    runtimeRoot,
    id: "codex",
    version: "1.1.4",
    registry: " https://registry.npmjs.org/ ",
    nodeExecutable: node,
    uuid: () => uuids.shift()!,
    now: () => new Date("2026-08-05T00:00:00.000Z"),
    installPackage,
    verify: async (command, args) => { probes.push(`${command}\0${args.join("\0")}`); },
  });
  expect(installed.manifest.registry).toBe("https://registry.npmjs.org");
  expect(installed.pointer.releaseId).toBe(installed.manifest.releaseId);
  expect((await stat(installed.releaseDir)).isDirectory()).toBe(true);
  expect(probes).toHaveLength(1);
  expect(await readActiveAdapterPointer(runtimeRoot, "codex")).toEqual(installed.pointer);
  await expect(validateAdapterRelease(installed.releaseDir, {
    id: "codex",
    packageName: "@agentclientprotocol/codex-acp",
    version: "1.1.4",
    registry: "https://registry.npmjs.org/",
    releaseId: installed.manifest.releaseId,
  }, { probe: false })).resolves.toMatchObject({ releaseId: installed.manifest.releaseId });
});

test("spawn-time re-resolution accepts only the release manifest's controlled node executable", async () => {
  const { runtimeRoot, node, installPackage } = await fixture();
  const installed = await preinstallAdapter({
    runtimeRoot,
    id: "codex",
    version: "1.1.4",
    registry: "https://registry.npmjs.org",
    nodeExecutable: node,
    uuid: (() => {
      const values = ["55555555-0000-4000-8000-000000000000", "66666666-0000-4000-8000-000000000000"];
      return () => values.shift()!;
    })(),
    installPackage,
    verify: async () => {},
  });
  const entry = join(installed.releaseDir, installed.manifest.entryRelPath);
  await expect(validateAndReResolveAdapterCommand(runtimeRoot, `${JSON.stringify(node)} ${JSON.stringify(entry)}`))
    .resolves.toMatchObject({ id: "codex" });

  const untrustedNode = join(runtimeRoot, "other", "node");
  await mkdir(dirname(untrustedNode), { recursive: true });
  await writeFile(untrustedNode, "#!/bin/sh\n");
  await chmod(untrustedNode, 0o755);
  await expect(validateAndReResolveAdapterCommand(runtimeRoot, `${JSON.stringify(untrustedNode)} ${JSON.stringify(entry)}`))
    .rejects.toThrow("controlled node executable");
});

test("pointer publication failure preserves the old complete active pointer", async () => {
  const { runtimeRoot, node, installPackage } = await fixture();
  const idRoot = join(runtimeRoot, "adapters", "codex");
  await mkdir(idRoot, { recursive: true });
  const old = { version: "1.0.0", releaseId: "1.0.0-aaaaaaaa-bbbbbbbb", activatedAt: "old" };
  await writeFile(join(idRoot, "active.json"), JSON.stringify(old));
  await expect(preinstallAdapter({
    runtimeRoot,
    id: "codex",
    version: "1.1.4",
    registry: "https://registry.npmjs.org",
    nodeExecutable: node,
    uuid: (() => {
      const values = ["33333333-0000-4000-8000-000000000000", "44444444-0000-4000-8000-000000000000"];
      return () => values.shift()!;
    })(),
    installPackage,
    verify: async () => {},
    fault: (boundary) => { if (boundary === "before-rename:active.json") throw new Error("injected"); },
  })).rejects.toThrow("injected");
  expect(JSON.parse(await readFile(join(idRoot, "active.json"), "utf8"))).toEqual(old);
});

test("recovery removes only staging/pointer tmp debris and a dangling pointer", async () => {
  const { runtimeRoot } = await fixture();
  const idRoot = join(runtimeRoot, "adapters", "codex");
  const validRelease = join(idRoot, "releases", "keep-me");
  await mkdir(validRelease, { recursive: true });
  await mkdir(join(idRoot, ".staging-dead"));
  await writeFile(join(idRoot, "active.json.tmp-dead"), "partial");
  await writeFile(join(idRoot, "active.json"), JSON.stringify({ releaseId: "missing", version: "1", activatedAt: "now" }));
  await recoverAdapterInstall(runtimeRoot, "codex");
  expect((await stat(validRelease)).isDirectory()).toBe(true);
  expect(await readActiveAdapterPointer(runtimeRoot, "codex")).toBeNull();
  await expect(stat(join(idRoot, ".staging-dead"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(idRoot, "active.json.tmp-dead"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("validation rejects a directory masquerading as the entry file", async () => {
  const { runtimeRoot, node } = await fixture();
  const releaseId = "1.1.4-036b43b1-12345678";
  const release = join(runtimeRoot, "adapters", "codex", "releases", releaseId);
  const entry = join(release, "node_modules", "@agentclientprotocol", "codex-acp", "bin");
  await mkdir(entry, { recursive: true });
  await writeFile(join(release, "installed.json"), JSON.stringify({
    schemaVersion: 1, id: "codex", packageName: "@agentclientprotocol/codex-acp", version: "1.1.4",
    releaseId, registry: "https://registry.npmjs.org", nodeExecutable: node,
    entryRelPath: "node_modules/@agentclientprotocol/codex-acp/bin", installedAt: "now",
  }));
  await expect(validateAdapterRelease(release, {
    id: "codex", packageName: "@agentclientprotocol/codex-acp", version: "1.1.4",
    releaseId, registry: "https://registry.npmjs.org",
  }, { probe: false })).rejects.toThrow("entry is not a contained file");
});
