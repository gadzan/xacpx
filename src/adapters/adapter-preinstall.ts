import { constants } from "node:fs";
import { accessSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  access, mkdir, open, readFile, readdir, realpath, rename, rm, stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import {
  MANAGED_ADAPTERS,
  adapterRegistryHash8,
  canonicalAdapterRegistry,
  createAdapterReleaseId,
  parseAdapterReleaseId,
  type ManagedAdapterId,
} from "./adapter-catalog";
import { adapterRegistryNpmArgs } from "./adapter-registry";
import { resolveNpmCommand } from "./adapter-npm";
import { resolveStableNodeExecutable } from "./resolve-node-exe";
import { verifyAcpInitialize } from "./adapter-verifier";

export interface InstalledAdapterManifest {
  schemaVersion: 1;
  id: ManagedAdapterId;
  packageName: string;
  version: string;
  releaseId: string;
  registry: string;
  nodeExecutable: string;
  entryRelPath: string;
  installedAt: string;
}

export interface ActiveAdapterPointer {
  version: string;
  releaseId: string;
  activatedAt: string;
}

export interface ValidateReleaseExpected {
  id: ManagedAdapterId;
  version: string;
  packageName: string;
  registry: string;
  releaseId: string;
}

export interface ValidateReleaseOptions {
  probe?: boolean;
  verify?: (command: string, args: string[]) => Promise<void>;
  platform?: NodeJS.Platform;
  staging?: boolean;
}

export interface PreinstallAdapterOptions {
  runtimeRoot: string;
  id: ManagedAdapterId;
  version: string;
  registry: string;
  nodeExecutable?: string;
  now?: () => Date;
  uuid?: () => string;
  installPackage?: (stagingDir: string, packageSpec: string, registry: string) => Promise<void>;
  verify?: (command: string, args: string[]) => Promise<void>;
  fault?: (boundary: string) => void | Promise<void>;
}

function releaseRoot(runtimeRoot: string, id: ManagedAdapterId): string {
  return join(runtimeRoot, "adapters", id, "releases");
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function decodeManifest(value: unknown): InstalledAdapterManifest | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    item.schemaVersion !== 1
    || (item.id !== "codex" && item.id !== "claude")
    || !["packageName", "version", "releaseId", "registry", "nodeExecutable", "entryRelPath", "installedAt"]
      .every((key) => typeof item[key] === "string" && item[key] !== "")
  ) return null;
  return item as unknown as InstalledAdapterManifest;
}

export async function validateAdapterRelease(
  releaseDir: string,
  expected: ValidateReleaseExpected,
  options: ValidateReleaseOptions = {},
): Promise<InstalledAdapterManifest> {
  if (!(await stat(releaseDir)).isDirectory()) throw new Error("adapter release path is not a directory");
  const canonicalRegistry = canonicalAdapterRegistry(expected.registry);
  const canonicalReleaseDir = await realpath(releaseDir);
  const canonicalReleasesRoot = await realpath(dirname(canonicalReleaseDir));
  if ((!options.staging && (!isContained(canonicalReleasesRoot, canonicalReleaseDir) || basename(canonicalReleaseDir) !== expected.releaseId))
    || (options.staging && !basename(canonicalReleaseDir).startsWith(".staging-"))) {
    throw new Error("adapter release escapes its releases root");
  }
  const parsedRelease = parseAdapterReleaseId(expected.releaseId);
  if (!parsedRelease || parsedRelease.version !== expected.version || parsedRelease.registryHash8 !== adapterRegistryHash8(canonicalRegistry)) {
    throw new Error("adapter release id does not match expected version/registry");
  }
  const manifestPath = join(canonicalReleaseDir, "installed.json");
  if (!(await stat(manifestPath)).isFile()) throw new Error("adapter manifest is not a file");
  const manifest = decodeManifest(await readJson(manifestPath));
  if (!manifest) throw new Error("adapter manifest is invalid");
  if (
    manifest.id !== expected.id
    || manifest.version !== expected.version
    || manifest.packageName !== expected.packageName
    || manifest.releaseId !== expected.releaseId
    || canonicalAdapterRegistry(manifest.registry) !== canonicalRegistry
  ) throw new Error("adapter manifest does not match expected release");
  if (!isAbsolute(manifest.nodeExecutable) || !/^(?:node|node\.exe)$/i.test(basename(manifest.nodeExecutable))) {
    throw new Error("adapter Node executable is not controlled");
  }
  const canonicalNode = await realpath(manifest.nodeExecutable);
  if (!(await stat(canonicalNode)).isFile()) throw new Error("adapter Node executable is not a file");
  if ((options.platform ?? process.platform) !== "win32") await access(canonicalNode, constants.X_OK);
  const entryPath = resolve(canonicalReleaseDir, manifest.entryRelPath);
  const canonicalEntry = await realpath(entryPath);
  if (!isContained(canonicalReleaseDir, canonicalEntry) || !(await stat(canonicalEntry)).isFile()) {
    throw new Error("adapter entry is not a contained file");
  }
  if (options.probe !== false) {
    await (options.verify ?? ((command, args) => verifyAcpInitialize(command, args)))(canonicalNode, [canonicalEntry]);
  }
  return { ...manifest, registry: canonicalRegistry, nodeExecutable: canonicalNode };
}

async function durableJson(path: string, value: unknown, fault?: PreinstallAdapterOptions["fault"]): Promise<void> {
  const tmp = `${path}.tmp-${randomUUID()}`;
  await fault?.(`before-write:${basename(path)}`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fault?.(`before-rename:${basename(path)}`);
  await rename(tmp, path);
  await fault?.(`after-rename:${basename(path)}`);
}

async function defaultInstallPackage(stagingDir: string, packageSpec: string, registry: string): Promise<void> {
  const npm = resolveNpmCommand();
  await new Promise<void>((resolveInstall, reject) => {
    const child = spawn(npm.command, [
      ...npm.prefixArgs,
      "install",
      "--prefix", stagingDir,
      "--no-save",
      ...adapterRegistryNpmArgs(registry),
      packageSpec,
    ], { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveInstall() : reject(new Error(`adapter install failed (${code}): ${stderr}`)));
  });
}

async function resolveInstalledEntry(stagingDir: string, id: ManagedAdapterId): Promise<string> {
  const spec = MANAGED_ADAPTERS[id];
  const packageRoot = join(stagingDir, "node_modules", ...spec.packageName.split("/"));
  const packageJson = await readJson(join(packageRoot, "package.json")) as { bin?: unknown };
  const bin = typeof packageJson.bin === "string"
    ? packageJson.bin
    : packageJson.bin && typeof packageJson.bin === "object"
      ? (packageJson.bin as Record<string, unknown>)[spec.binName]
      : undefined;
  if (typeof bin !== "string" || !bin) throw new Error("installed adapter does not declare its expected bin");
  const entry = resolve(packageRoot, bin);
  if (!isContained(packageRoot, entry)) throw new Error("adapter bin escapes its package");
  return relative(stagingDir, entry);
}

export async function preinstallAdapter(options: PreinstallAdapterOptions): Promise<{ releaseDir: string; manifest: InstalledAdapterManifest; pointer: ActiveAdapterPointer }> {
  const registry = canonicalAdapterRegistry(options.registry);
  const spec = MANAGED_ADAPTERS[options.id];
  const releaseId = createAdapterReleaseId(options.version, registry, options.uuid?.());
  const idRoot = join(options.runtimeRoot, "adapters", options.id);
  const releases = releaseRoot(options.runtimeRoot, options.id);
  const staging = join(idRoot, `.staging-${options.uuid?.() ?? randomUUID()}`);
  const finalRelease = join(releases, releaseId);
  await mkdir(releases, { recursive: true });
  await mkdir(staging, { recursive: false });
  await options.fault?.("staging-created");
  try {
    await (options.installPackage ?? defaultInstallPackage)(staging, `${spec.packageName}@${options.version}`, registry);
    const nodeExecutable = options.nodeExecutable ?? await resolveStableNodeExecutable();
    const entryRelPath = await resolveInstalledEntry(staging, options.id);
    const manifest: InstalledAdapterManifest = {
      schemaVersion: 1,
      id: options.id,
      packageName: spec.packageName,
      version: options.version,
      releaseId,
      registry,
      nodeExecutable,
      entryRelPath,
      installedAt: (options.now?.() ?? new Date()).toISOString(),
    };
    await durableJson(join(staging, "installed.json"), manifest, options.fault);
    await validateAdapterRelease(staging, { ...manifest }, { verify: options.verify, staging: true });
    await options.fault?.("before-release-rename");
    await rename(staging, finalRelease);
    await options.fault?.("after-release-rename");
    await validateAdapterRelease(finalRelease, { ...manifest }, { probe: false });
    const pointer: ActiveAdapterPointer = {
      version: options.version,
      releaseId,
      activatedAt: (options.now?.() ?? new Date()).toISOString(),
    };
    await durableJson(join(idRoot, "active.json"), pointer, options.fault);
    return { releaseDir: finalRelease, manifest, pointer };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function recoverAdapterInstall(runtimeRoot: string, id: ManagedAdapterId): Promise<void> {
  const idRoot = join(runtimeRoot, "adapters", id);
  let entries;
  try { entries = await readdir(idRoot, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if ((entry.name.startsWith(".staging-") || entry.name.startsWith("active.json.tmp-"))) {
      await rm(join(idRoot, entry.name), { recursive: true, force: true });
    }
  }
  const pointerPath = join(idRoot, "active.json");
  let pointer: Partial<ActiveAdapterPointer>;
  try {
    pointer = await readJson(pointerPath) as Partial<ActiveAdapterPointer>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    await rm(pointerPath, { force: true });
    return;
  }
  try {
    if (typeof pointer.releaseId !== "string" || !(await stat(join(idRoot, "releases", pointer.releaseId))).isDirectory()) {
      await rm(pointerPath, { force: true });
    }
  } catch {
    await rm(pointerPath, { force: true });
  }
}

export async function readActiveAdapterPointer(runtimeRoot: string, id: ManagedAdapterId): Promise<ActiveAdapterPointer | null> {
  try {
    const value = await readJson(join(runtimeRoot, "adapters", id, "active.json"));
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    if (typeof item.version !== "string" || typeof item.releaseId !== "string" || typeof item.activatedAt !== "string") return null;
    return { version: item.version, releaseId: item.releaseId, activatedAt: item.activatedAt };
  } catch {
    return null;
  }
}

export async function listInstalledAdapterReleases(runtimeRoot: string): Promise<Array<{ id: ManagedAdapterId; releaseId: string; active: boolean }>> {
  const result: Array<{ id: ManagedAdapterId; releaseId: string; active: boolean }> = [];
  for (const id of ["codex", "claude"] as const) {
    const pointer = await readActiveAdapterPointer(runtimeRoot, id);
    let entries: string[];
    try { entries = await readdir(releaseRoot(runtimeRoot, id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const releaseId of entries.sort()) {
      try {
        if (!(await stat(join(releaseRoot(runtimeRoot, id), releaseId))).isDirectory()) continue;
      } catch { continue; }
      result.push({ id, releaseId, active: pointer?.releaseId === releaseId });
    }
  }
  return result;
}

/** Spawn-time static validation. The initialize probe is intentionally skipped. */
export function resolveActiveAdapterCommandSync(
  runtimeRoot: string,
  expected: Omit<ValidateReleaseExpected, "releaseId">,
): string | null {
  try {
    const idRoot = join(runtimeRoot, "adapters", expected.id);
    const pointer = JSON.parse(readFileSync(join(idRoot, "active.json"), "utf8")) as ActiveAdapterPointer;
    if (typeof pointer.releaseId !== "string" || pointer.version !== expected.version) return null;
    const releaseDir = realpathSync(join(idRoot, "releases", pointer.releaseId));
    const releases = realpathSync(join(idRoot, "releases"));
    if (!isContained(releases, releaseDir) || basename(releaseDir) !== pointer.releaseId) return null;
    const releaseIdentity = parseAdapterReleaseId(pointer.releaseId);
    const registry = canonicalAdapterRegistry(expected.registry);
    if (!releaseIdentity || releaseIdentity.version !== expected.version || releaseIdentity.registryHash8 !== adapterRegistryHash8(registry)) return null;
    const manifestPath = join(releaseDir, "installed.json");
    if (!statSync(manifestPath).isFile()) return null;
    const manifest = decodeManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (!manifest
      || manifest.id !== expected.id
      || manifest.version !== expected.version
      || manifest.packageName !== expected.packageName
      || manifest.releaseId !== pointer.releaseId
      || canonicalAdapterRegistry(manifest.registry) !== registry) return null;
    const node = realpathSync(manifest.nodeExecutable);
    if (!isAbsolute(node) || !/^(?:node|node\.exe)$/i.test(basename(node)) || !statSync(node).isFile()) return null;
    if (process.platform !== "win32") accessSync(node, constants.X_OK);
    const entry = realpathSync(resolve(releaseDir, manifest.entryRelPath));
    if (!isContained(releaseDir, entry) || !statSync(entry).isFile()) return null;
    return `${JSON.stringify(node)} ${JSON.stringify(entry)}`;
  } catch {
    return null;
  }
}
