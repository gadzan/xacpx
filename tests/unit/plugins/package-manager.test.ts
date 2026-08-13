import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installPluginPackage, pluginRegistryInstallArgs, removePluginPackage, updatePluginPackage } from "../../../src/plugins/package-manager";

const registryArgs = pluginRegistryInstallArgs();

test("installPluginPackage runs add in plugin home", async () => {
  const calls: unknown[] = [];
  await installPluginPackage({
    packageName: "weacpx-channel-demo",
    pluginHome: "/tmp/weacpx-plugins",
    packageManager: "npm",
    runCommand: async (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); },
  });

  expect(calls).toEqual([{ command: "npm", args: ["install", "weacpx-channel-demo", ...registryArgs], cwd: "/tmp/weacpx-plugins" }]);
});

test("installPluginPackage appends version range", async () => {
  const calls: unknown[] = [];
  await installPluginPackage({
    packageName: "weacpx-channel-demo",
    version: "^1.2.0",
    pluginHome: "/tmp/weacpx-plugins",
    packageManager: "bun",
    runCommand: async (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); },
  });

  expect(calls).toEqual([{ command: "bun", args: ["add", "weacpx-channel-demo@^1.2.0", ...registryArgs], cwd: "/tmp/weacpx-plugins" }]);
});

test("updatePluginPackage reuses package-manager add semantics", async () => {
  const calls: unknown[] = [];
  await updatePluginPackage({
    packageName: "weacpx-channel-demo",
    version: "2.0.0",
    pluginHome: "/tmp/weacpx-plugins",
    packageManager: "npm",
    runCommand: async (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); },
  });

  expect(calls).toEqual([{ command: "npm", args: ["install", "weacpx-channel-demo@2.0.0", ...registryArgs], cwd: "/tmp/weacpx-plugins" }]);
});

test("updatePluginPackage without version uses bare package name", async () => {
  const calls: unknown[] = [];
  await updatePluginPackage({
    packageName: "weacpx-channel-demo",
    pluginHome: "/tmp/weacpx-plugins",
    packageManager: "bun",
    runCommand: async (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); },
  });

  expect(calls).toEqual([{ command: "bun", args: ["add", "weacpx-channel-demo", ...registryArgs], cwd: "/tmp/weacpx-plugins" }]);
});

test("installPluginPackage repairs duplicate dependency keys before installing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-pm-"));
  try {
    const manifest = join(dir, "package.json");
    // Pre-existing corruption (a different package than the one being added).
    await writeFile(
      manifest,
      '{\n  "dependencies": {\n    "@scope/feishu": "0.2.1",\n    "@scope/feishu": "/local/feishu"\n  }\n}\n',
    );
    const calls: unknown[] = [];
    await installPluginPackage({
      packageName: "@scope/yuanbao",
      pluginHome: dir,
      packageManager: "bun",
      runCommand: async (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); },
    });

    // Assert on the raw on-disk text: the duplicate key must be physically gone
    // (JSON.parse would mask it, so checking the parsed object is not enough).
    const rawAfter = await readFile(manifest, "utf8");
    const occurrences = rawAfter.split('"@scope/feishu"').length - 1;
    expect(occurrences).toBe(1);
    expect(calls).toEqual([{ command: "bun", args: ["add", "@scope/yuanbao", ...registryArgs], cwd: dir }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installPluginPackage honors XACPX_PLUGIN_REGISTRY", async () => {
  const previous = process.env.XACPX_PLUGIN_REGISTRY;
  process.env.XACPX_PLUGIN_REGISTRY = "https://registry.example.com/npm/";
  try {
    const calls: unknown[] = [];
    await installPluginPackage({
      packageName: "@ganglion/xacpx-channel-relay",
      pluginHome: "/tmp/weacpx-plugins",
      packageManager: "bun",
      runCommand: async (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); },
    });
    expect(calls).toEqual([{
      command: "bun",
      args: [
        "add",
        "@ganglion/xacpx-channel-relay",
        "--registry=https://registry.example.com/npm",
        "--@ganglion:registry=https://registry.example.com/npm",
      ],
      cwd: "/tmp/weacpx-plugins",
    }]);
  } finally {
    if (previous === undefined) delete process.env.XACPX_PLUGIN_REGISTRY;
    else process.env.XACPX_PLUGIN_REGISTRY = previous;
  }
});

test("installPluginPackage rejects a non-URL XACPX_PLUGIN_REGISTRY", async () => {
  const previous = process.env.XACPX_PLUGIN_REGISTRY;
  process.env.XACPX_PLUGIN_REGISTRY = "not a url";
  try {
    await expect(installPluginPackage({
      packageName: "@ganglion/xacpx-channel-relay",
      pluginHome: "/tmp/weacpx-plugins",
      packageManager: "bun",
      runCommand: async () => {},
    })).rejects.toThrow("XACPX_PLUGIN_REGISTRY must be a valid http(s) URL");
  } finally {
    if (previous === undefined) delete process.env.XACPX_PLUGIN_REGISTRY;
    else process.env.XACPX_PLUGIN_REGISTRY = previous;
  }
});

test("removePluginPackage runs remove in plugin home", async () => {
  const calls: unknown[] = [];
  await removePluginPackage({
    packageName: "weacpx-channel-demo",
    pluginHome: "/tmp/weacpx-plugins",
    packageManager: "npm",
    runCommand: async (command, args, options) => { calls.push({ command, args, cwd: options.cwd }); },
  });

  expect(calls).toEqual([{ command: "npm", args: ["uninstall", "weacpx-channel-demo"], cwd: "/tmp/weacpx-plugins" }]);
});
