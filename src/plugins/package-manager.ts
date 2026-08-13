import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { normalizePluginHomeManifest } from "./plugin-home.js";
import { coreEnv } from "../runtime/core-env.js";

export type PluginPackageManager = "bun" | "npm";

/** Public npm. Plugin add/update pass this so bun/npm do not inherit a
 * company mirror that 404s `@ganglion/xacpx-rmux-bridge-*` optionals. */
export const DEFAULT_PLUGIN_REGISTRY = "https://registry.npmjs.org";

export function pluginRegistryInstallArgs(registry = effectivePluginRegistry()): string[] {
  return [
    `--registry=${registry}`,
    `--@ganglion:registry=${registry}`,
  ];
}

function effectivePluginRegistry(env: NodeJS.ProcessEnv = process.env): string {
  const raw = coreEnv("PLUGIN_REGISTRY", env)?.trim();
  if (!raw) return DEFAULT_PLUGIN_REGISTRY;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("XACPX_PLUGIN_REGISTRY must be a valid http(s) URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) {
    throw new Error("XACPX_PLUGIN_REGISTRY must be a valid http(s) URL");
  }
  return url.toString().replace(/\/+$/, "");
}

export interface RunCommandOptions {
  cwd: string;
}

export type RunCommand = (command: string, args: string[], options: RunCommandOptions) => Promise<void>;

// defaultRunCommand/silentRun only ever run package managers (npm/bun). On
// Windows those resolve to .cmd shims, which Node refuses to spawn without a
// shell since the batch-file security change (EINVAL), so spawn through a
// shell there — same pattern as src/cli-update.ts and src/recovery/*. Going
// through cmd.exe means cmd metacharacters in args would be interpreted, and
// unlike cli-update the specs here may carry semver range characters from the
// owner-writable config (e.g. "pkg@^1.2.0" — `^` is cmd's escape char), so on
// the shell path each arg is additionally wrapped in double quotes, inside
// which cmd treats ^ & < > | literally. Args are npm package names/specs and
// fixed flags — they never contain `"` or spaces themselves. The cwd (plugin
// home, which CAN contain spaces) is passed as a spawn option, not through
// the command line, so it needs no quoting. Do NOT reuse these helpers for
// commands whose args may contain quotes or spaces.
function shellSpawnPlan(args: string[]): { shell: boolean; args: string[] } {
  const shell = process.platform === "win32";
  return { shell, args: shell ? args.map((arg) => `"${arg}"`) : args };
}

async function defaultRunCommand(command: string, args: string[], options: RunCommandOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const plan = shellSpawnPlan(args);
    const child = spawn(command, plan.args, { cwd: options.cwd, stdio: "inherit", shell: plan.shell });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function silentRun(command: string, args: string[], options: RunCommandOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const plan = shellSpawnPlan(args);
    const child = spawn(command, plan.args, { cwd: options.cwd, stdio: "ignore", shell: plan.shell });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

export async function detectPackageManager(runCommand?: RunCommand): Promise<PluginPackageManager> {
  const override = coreEnv("PACKAGE_MANAGER")?.trim().toLowerCase();
  if (override === "bun" || override === "npm") return override;
  const probe = runCommand ?? silentRun;
  try {
    await probe("bun", ["--version"], { cwd: process.cwd() });
    return "bun";
  } catch {
    return "npm";
  }
}

export async function installPluginPackage(input: {
  packageName: string;
  version?: string;
  pluginHome: string;
  packageManager?: PluginPackageManager;
  runCommand?: RunCommand;
}): Promise<void> {
  const runCommand = input.runCommand ?? defaultRunCommand;
  const packageManager = input.packageManager ?? await detectPackageManager();
  // Repair any duplicate dependency keys a prior add may have left (e.g. bun on
  // Windows recording a package under both an npm version and a local path),
  // which would otherwise make the package manager choke on the lockfile.
  await normalizePluginHomeManifest(input.pluginHome);
  // If the lockfile is already corrupt (duplicate keys), delete it so the
  // package manager can regenerate it from a clean slate.
  if (packageManager === "bun") {
    await rm(join(input.pluginHome, "bun.lock"), { force: true }).catch(() => {});
  }
  const spec = input.version ? `${input.packageName}@${input.version}` : input.packageName;
  const registryArgs = pluginRegistryInstallArgs();
  if (packageManager === "bun") {
    await runCommand("bun", ["add", spec, ...registryArgs], { cwd: input.pluginHome });
    return;
  }
  await runCommand("npm", ["install", spec, ...registryArgs], { cwd: input.pluginHome });
}

export async function updatePluginPackage(input: {
  packageName: string;
  version?: string;
  pluginHome: string;
  packageManager?: PluginPackageManager;
  runCommand?: RunCommand;
}): Promise<void> {
  await installPluginPackage(input);
}

export async function removePluginPackage(input: {
  packageName: string;
  pluginHome: string;
  packageManager?: PluginPackageManager;
  runCommand?: RunCommand;
}): Promise<void> {
  const runCommand = input.runCommand ?? defaultRunCommand;
  const packageManager = input.packageManager ?? await detectPackageManager();
  if (packageManager === "bun") {
    await runCommand("bun", ["remove", input.packageName], { cwd: input.pluginHome });
    return;
  }
  await runCommand("npm", ["uninstall", input.packageName], { cwd: input.pluginHome });
}
