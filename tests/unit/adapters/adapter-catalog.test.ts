import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adapterRegistryHash8,
  buildManagedAdapterCommand,
  createAdapterReleaseId,
  decodeManagedAdapterCommand,
  effectiveAdapterVersion,
  isExactAdapterVersion,
  isManagedAdapterCommand,
  parseAdapterReleaseId,
} from "../../../src/adapters/adapter-catalog";

test("managed adapters use tested exact defaults and accept local overrides", () => {
  expect(effectiveAdapterVersion("codex", {})).toBe("1.1.4");
  expect(effectiveAdapterVersion("claude", {})).toBe("0.59.0");
  expect(effectiveAdapterVersion("codex", { codex: "1.1.2" })).toBe("1.1.2");
  expect(buildManagedAdapterCommand("codex", "1.1.2")).toBe(
    "npx -y --registry=https://registry.npmjs.org --@agentclientprotocol:registry=https://registry.npmjs.org @agentclientprotocol/codex-acp@1.1.2",
  );
  expect(buildManagedAdapterCommand("codex", "1.1.2", "https://npm.corp.example/repository/npm/")).toBe(
    "npx -y --registry=https://npm.corp.example/repository/npm --@agentclientprotocol:registry=https://npm.corp.example/repository/npm @agentclientprotocol/codex-acp@1.1.2",
  );
});

test("release ids retain prerelease versions and use one canonical registry hash", () => {
  const withSlash = adapterRegistryHash8("https://registry.example/");
  expect(withSlash).toBe(adapterRegistryHash8("  https://registry.example  "));
  const releaseId = createAdapterReleaseId("1.2.0-beta.1", "https://registry.example/", "abcdef01-0000-4000-8000-000000000000");
  expect(releaseId).toBe(`1.2.0-beta.1-${withSlash}-abcdef01`);
  expect(parseAdapterReleaseId(releaseId)).toEqual({
    version: "1.2.0-beta.1", registryHash8: withSlash, uuid8: "abcdef01",
  });
  expect(parseAdapterReleaseId(`1.2.0-beta.1-${withSlash}-ABCDEF01`)).toBeNull();
});

test("shared decoder trusts npx and controlled preinstalled entry commands only", async () => {
  const root = await mkdtemp(join(tmpdir(), "adapter-decoder-"));
  try {
    const adaptersRoot = join(root, "adapters");
    const releaseId = createAdapterReleaseId("1.1.4", "https://registry.npmjs.org", "12345678-0000-4000-8000-000000000000");
    const release = join(adaptersRoot, "codex", "releases", releaseId);
    const entry = join(release, "node_modules", "@agentclientprotocol", "codex-acp", "bin", "codex-acp.js");
    const node = join(root, "runtime", "node");
    await mkdir(join(entry, ".."), { recursive: true });
    await mkdir(join(node, ".."), { recursive: true });
    await writeFile(entry, "export {}\n");
    await writeFile(node, "#!/bin/sh\n");
    await chmod(node, 0o755);
    const otherNode = join(root, "other-node");
    await writeFile(otherNode, "#!/bin/sh\n");
    const command = `"${node}" "${entry}"`;
    expect(await decodeManagedAdapterCommand(command, { adaptersRoot, controlledNodeExecutable: node })).toMatchObject({
      kind: "preinstalled", id: "codex", releaseId,
    });
    expect(await decodeManagedAdapterCommand(command, { adaptersRoot, controlledNodeExecutable: otherNode })).toBeNull();
    const collision = entry.replace(`${releaseId}/`, `${releaseId}-extra/`);
    expect(await decodeManagedAdapterCommand(`"${node}" "${collision}"`, {
      adaptersRoot,
      controlledNodeExecutable: node,
      realpath: async (value) => value,
    })).toBeNull();
    expect(await decodeManagedAdapterCommand("npx -y @agentclientprotocol/codex-acp@1.1.4")).toMatchObject({
      kind: "npx", id: "codex", version: "1.1.4",
    });

    const aliasRoot = join(root, "alias-adapters");
    await symlink(adaptersRoot, aliasRoot, "dir");
    expect(await decodeManagedAdapterCommand(command, { adaptersRoot: aliasRoot, controlledNodeExecutable: node })).toMatchObject({
      kind: "preinstalled", releaseId,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preinstalled decoder applies Windows case folding and path-component boundaries", async () => {
  const releaseId = createAdapterReleaseId("1.1.4", "https://registry.npmjs.org", "87654321-0000-4000-8000-000000000000");
  const node = "C:\\Runtime\\NODE.EXE";
  const entry = `c:\\Xacpx\\adapters\\codex\\releases\\${releaseId}\\node_modules\\@agentclientprotocol\\codex-acp\\bin\\codex-acp.js`;
  const decoded = await decodeManagedAdapterCommand(`"${node}" "${entry}"`, {
    adaptersRoot: "C:\\XACPX\\ADAPTERS",
    controlledNodeExecutable: "c:\\runtime\\node.exe",
    platform: "win32",
    realpath: async (value) => value,
  });
  expect(decoded).toMatchObject({ kind: "preinstalled", id: "codex", releaseId });
  expect(await decodeManagedAdapterCommand(`"${node}" "${entry.replace("\\releases\\", "\\releases-extra\\")}"`, {
    adaptersRoot: "C:\\XACPX\\ADAPTERS",
    controlledNodeExecutable: node,
    platform: "win32",
    realpath: async (value) => value,
  })).toBeNull();
});

test("adapter versions are exact semver values, never ranges or package specs", () => {
  expect(isExactAdapterVersion("1.1.4")).toBe(true);
  expect(isExactAdapterVersion("1.2.0-beta.1")).toBe(true);
  for (const value of [
    "latest",
    "^1.1.4",
    "1.x",
    "1.0.0-01",
    "1.0.0-beta.01",
    "github:user/repo",
    "1.1.4; rm -rf /",
  ]) {
    expect(isExactAdapterVersion(value)).toBe(false);
  }
});

test("recognizes only generated commands for managed adapter packages", () => {
  expect(isManagedAdapterCommand(
    "codex",
    "npx -y --registry=https://registry.npmjs.org/ --@agentclientprotocol:registry=https://registry.npmjs.org/ @agentclientprotocol/codex-acp@1.1.4",
  )).toBe(true);
  expect(isManagedAdapterCommand("codex", "npx -y @agentclientprotocol/codex-acp@1.1.4")).toBe(true);
  expect(isManagedAdapterCommand("codex", "npx -y @agentclientprotocol/codex-acp@^0.0.44")).toBe(true);
  expect(isManagedAdapterCommand("codex", "custom-codex-acp")).toBe(false);
  expect(isManagedAdapterCommand("claude", "npx -y @agentclientprotocol/codex-acp@1.1.4")).toBe(false);
});
