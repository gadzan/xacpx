// Pins the Windows spawn behavior of the plugin package-manager helpers:
// npm/bun resolve to .cmd shims on win32, and since Node's batch-file
// security change spawning them without `shell: true` fails (EINVAL/ENOENT)
// — breaking `xacpx plugin add/update/rm` and silently degrading the
// `bun --version` probe to npm. On the shell path each arg must also be
// double-quoted so cmd.exe metacharacters in semver ranges (e.g. the `^` in
// "pkg@^1.2.0", cmd's escape char) survive to the package manager. These
// tests mock node:child_process and assert on the spawn options/args. This
// file must run in isolation (bun test <this file>) because it mocks a
// builtin module.
import { expect, test, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

interface RecordedSpawn {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

const spawnCalls: RecordedSpawn[] = [];

mock.module("node:child_process", () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setTimeout(() => {
      child.stdout.end();
      child.emit("exit", 0);
      child.emit("close", 0);
    }, 0);
    return child;
  },
}));

const { detectPackageManager, installPluginPackage, removePluginPackage } = await import("../../../src/plugins/package-manager");

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

// pluginHome never has to exist for these tests: the manifest normalization
// tolerates a missing package.json and the spawn itself is mocked.
const pluginHome = "/tmp/xacpx-plugin-home-spawn-test";

test("installPluginPackage spawns npm via shell with quoted args on win32", async () => {
  spawnCalls.length = 0;

  await withPlatform("win32", async () => {
    await installPluginPackage({
      packageName: "weacpx-channel-demo",
      version: "^1.2.0",
      pluginHome,
      packageManager: "npm",
      // runCommand deliberately NOT injected: exercise the default spawn path.
    });
  });

  expect(spawnCalls).toHaveLength(1);
  expect(spawnCalls[0]!.command).toBe("npm");
  // Quoting keeps the `^` in the range from being eaten by cmd.exe.
  expect(spawnCalls[0]!.args).toEqual([
    '"install"',
    '"weacpx-channel-demo@^1.2.0"',
    '"--registry=https://registry.npmjs.org"',
    '"--@ganglion:registry=https://registry.npmjs.org"',
  ]);
  expect(spawnCalls[0]!.options.shell).toBe(true);
  expect(spawnCalls[0]!.options.cwd).toBe(pluginHome);
  expect(spawnCalls[0]!.options.stdio).toBe("inherit");
});

test("installPluginPackage spawns npm without a shell and unquoted on posix", async () => {
  spawnCalls.length = 0;

  await withPlatform("linux", async () => {
    await installPluginPackage({
      packageName: "weacpx-channel-demo",
      version: "^1.2.0",
      pluginHome,
      packageManager: "npm",
    });
  });

  expect(spawnCalls).toHaveLength(1);
  expect(spawnCalls[0]!.command).toBe("npm");
  expect(spawnCalls[0]!.args).toEqual([
    "install",
    "weacpx-channel-demo@^1.2.0",
    "--registry=https://registry.npmjs.org",
    "--@ganglion:registry=https://registry.npmjs.org",
  ]);
  expect(spawnCalls[0]!.options.shell).toBe(false);
});

test("removePluginPackage spawns npm via shell with quoted args on win32", async () => {
  spawnCalls.length = 0;

  await withPlatform("win32", async () => {
    await removePluginPackage({
      packageName: "weacpx-channel-demo",
      pluginHome,
      packageManager: "npm",
    });
  });

  expect(spawnCalls).toHaveLength(1);
  expect(spawnCalls[0]!.command).toBe("npm");
  expect(spawnCalls[0]!.args).toEqual(['"uninstall"', '"weacpx-channel-demo"']);
  expect(spawnCalls[0]!.options.shell).toBe(true);
});

test("detectPackageManager probes bun via shell on win32", async () => {
  spawnCalls.length = 0;
  delete process.env.XACPX_PACKAGE_MANAGER;
  delete process.env.WEACPX_PACKAGE_MANAGER;

  const manager = await withPlatform("win32", async () => await detectPackageManager());

  // The mocked probe exits 0, so a shell-spawned `bun --version` must be
  // detected as bun instead of silently falling back to npm.
  expect(manager).toBe("bun");
  expect(spawnCalls).toHaveLength(1);
  expect(spawnCalls[0]!.command).toBe("bun");
  expect(spawnCalls[0]!.args).toEqual(['"--version"']);
  expect(spawnCalls[0]!.options.shell).toBe(true);
  expect(spawnCalls[0]!.options.stdio).toBe("ignore");
});

test("detectPackageManager probes bun without a shell on posix", async () => {
  spawnCalls.length = 0;
  delete process.env.XACPX_PACKAGE_MANAGER;
  delete process.env.WEACPX_PACKAGE_MANAGER;

  const manager = await withPlatform("darwin", async () => await detectPackageManager());

  expect(manager).toBe("bun");
  expect(spawnCalls).toHaveLength(1);
  expect(spawnCalls[0]!.args).toEqual(["--version"]);
  expect(spawnCalls[0]!.options.shell).toBe(false);
});
