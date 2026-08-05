import { createHash } from "node:crypto";
import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  classifyPreinstalledAdapterCommandShape,
  decodeManagedAdapterCommand,
  parseAdapterReleaseId,
  type ManagedAdapterId,
} from "./adapter-catalog";
import { validateAdapterRelease, type InstalledAdapterManifest } from "./adapter-preinstall";
import { withAdapterOperationLock } from "./adapter-locks";
import { ORPHAN_CATEGORIES, OrphanRegistry } from "../transport/orphan-registry";

export type AdapterGcDisposition = "removed" | "active" | "referenced" | "changed" | "missing";

export interface AdapterGcResult {
  id: ManagedAdapterId;
  releaseId: string;
  disposition: AdapterGcDisposition;
}

interface ReferenceSnapshot {
  activeReleaseId: string | null;
  referencedReleaseIds: Set<string>;
  revision: string;
}

export interface AdapterGcOptions {
  runtimeRoot: string;
  id: ManagedAdapterId;
  releaseId?: string;
  statePath?: string;
  platform?: NodeJS.Platform;
  orphanRegistry?: Pick<OrphanRegistry, "listOwnerAgentCommands">;
  beforeSecondScan?: (releaseId: string) => void | Promise<void>;
  withLock?: <T>(critical: () => Promise<T>) => Promise<T>;
}

/** Delete unreferenced immutable releases. Every uncertainty rejects the whole run. */
export async function garbageCollectAdapterReleases(options: AdapterGcOptions): Promise<AdapterGcResult[]> {
  const runLocked = options.withLock
    ?? ((critical) => withAdapterOperationLock({ id: options.id, runtimeRoot: options.runtimeRoot }, critical));
  return await runLocked(async () => {
    const releases = await readReleaseManifests(options.runtimeRoot, options.id);
    if (options.releaseId && !parseAdapterReleaseId(options.releaseId)) throw new Error("invalid adapter release id");
    const targets = options.releaseId
      ? releases.filter((item) => item.manifest.releaseId === options.releaseId)
      : releases;
    if (options.releaseId && targets.length === 0) {
      return [{ id: options.id, releaseId: options.releaseId, disposition: "missing" }];
    }
    const first = await scanReferences(options, releases);
    const results: AdapterGcResult[] = [];
    for (const target of targets) {
      const releaseId = target.manifest.releaseId;
      if (first.activeReleaseId === releaseId) {
        results.push({ id: options.id, releaseId, disposition: "active" });
        continue;
      }
      if (first.referencedReleaseIds.has(releaseId)) {
        results.push({ id: options.id, releaseId, disposition: "referenced" });
        continue;
      }
      await options.beforeSecondScan?.(releaseId);
      const secondReleases = await readReleaseManifests(options.runtimeRoot, options.id);
      const second = await scanReferences(options, secondReleases);
      if (second.revision !== first.revision) {
        results.push({ id: options.id, releaseId, disposition: "changed" });
        continue;
      }
      const stillInstalled = secondReleases.find((item) => item.manifest.releaseId === releaseId);
      if (!stillInstalled) {
        results.push({ id: options.id, releaseId, disposition: "missing" });
        continue;
      }
      await rm(stillInstalled.releaseDir, { recursive: true, force: false });
      results.push({ id: options.id, releaseId, disposition: "removed" });
    }
    return results;
  });
}

async function scanReferences(
  options: AdapterGcOptions,
  releases: Array<{ releaseDir: string; manifest: InstalledAdapterManifest }>,
): Promise<ReferenceSnapshot> {
  const active = await readActiveStrict(options.runtimeRoot, options.id);
  const stateCommands = await readStateCommands(options.statePath ?? join(options.runtimeRoot, "state.json"));
  let orphanCommands: string[] = [];
  let orphanRevision = "unix";
  if ((options.platform ?? process.platform) === "win32") {
    if (!options.orphanRegistry) throw new Error("Windows adapter GC requires an orphan registry");
    const snapshot = await options.orphanRegistry.listOwnerAgentCommands(ORPHAN_CATEGORIES);
    if (!snapshot) throw new Error("orphan registry reference scan failed");
    orphanCommands = snapshot.commands;
    orphanRevision = snapshot.snapshotRevision;
  }
  const commands = [...stateCommands, ...orphanCommands];
  const referencedReleaseIds = await decodeReferences(options.runtimeRoot, options.id, commands, releases);
  const revision = createHash("sha256")
    .update(active.raw).update("\0")
    .update(JSON.stringify(stateCommands)).update("\0")
    .update(orphanRevision).digest("hex");
  return { activeReleaseId: active.releaseId, referencedReleaseIds, revision };
}

async function readActiveStrict(runtimeRoot: string, id: ManagedAdapterId): Promise<{ releaseId: string | null; raw: string }> {
  const path = join(runtimeRoot, "adapters", id, "active.json");
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { releaseId: null, raw: "missing" };
    throw error;
  }
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.releaseId !== "string" || !parseAdapterReleaseId(value.releaseId)
    || typeof value.version !== "string" || typeof value.activatedAt !== "string") {
    throw new Error("active adapter pointer is invalid");
  }
  return { releaseId: value.releaseId, raw };
}

async function readStateCommands(path: string): Promise<string[]> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("state.json is invalid");
  if (value.sessions === undefined) return [];
  if (!value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions)) {
    throw new Error("state.json sessions are invalid");
  }
  const commands: string[] = [];
  for (const key of Object.keys(value.sessions as Record<string, unknown>).sort()) {
    const session = (value.sessions as Record<string, unknown>)[key];
    if (!session || typeof session !== "object" || Array.isArray(session)) throw new Error("state.json session is invalid");
    const command = (session as Record<string, unknown>).transport_agent_command;
    if (command === undefined) continue;
    if (typeof command !== "string" || !command) throw new Error("state.json adapter command is invalid");
    commands.push(command);
  }
  return commands;
}

async function readReleaseManifests(
  runtimeRoot: string,
  id: ManagedAdapterId,
): Promise<Array<{ releaseDir: string; manifest: InstalledAdapterManifest }>> {
  const root = join(runtimeRoot, "adapters", id, "releases");
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: Array<{ releaseDir: string; manifest: InstalledAdapterManifest }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (!parseAdapterReleaseId(entry.name)) throw new Error(`invalid release directory: ${entry.name}`);
    const releaseDir = join(root, entry.name);
    const value = JSON.parse(await readFile(join(releaseDir, "installed.json"), "utf8")) as Record<string, unknown>;
    if (!isManifest(value, id, entry.name)) throw new Error(`invalid release manifest: ${entry.name}`);
    const manifest = value as unknown as InstalledAdapterManifest;
    await validateAdapterRelease(releaseDir, {
      id,
      version: manifest.version,
      packageName: manifest.packageName,
      registry: manifest.registry,
      releaseId: manifest.releaseId,
    }, { probe: false });
    result.push({ releaseDir, manifest });
  }
  return result;
}

async function decodeReferences(
  runtimeRoot: string,
  id: ManagedAdapterId,
  commands: string[],
  releases: Array<{ releaseDir: string; manifest: InstalledAdapterManifest }>,
): Promise<Set<string>> {
  const result = new Set<string>();
  const adaptersRoot = join(runtimeRoot, "adapters");
  for (const command of commands) {
    if (classifyPreinstalledAdapterCommandShape(command) !== id) continue;
    let decoded: Awaited<ReturnType<typeof decodeManagedAdapterCommand>> = null;
    for (const release of releases) {
      decoded = await decodeManagedAdapterCommand(command, {
        adaptersRoot,
        controlledNodeExecutable: release.manifest.nodeExecutable,
      });
      if (decoded?.kind === "preinstalled") break;
    }
    if (!decoded || decoded.kind !== "preinstalled" || decoded.id !== id) {
      throw new Error("managed adapter reference could not be decoded safely");
    }
    const referenced = releases.find((item) => item.manifest.releaseId === decoded!.releaseId);
    if (!referenced) throw new Error("managed adapter reference points to an unknown release");
    const trusted = await decodeManagedAdapterCommand(command, {
      adaptersRoot,
      controlledNodeExecutable: referenced.manifest.nodeExecutable,
    });
    if (!trusted || trusted.kind !== "preinstalled" || trusted.releaseId !== referenced.manifest.releaseId) {
      throw new Error("managed adapter reference has an untrusted node executable");
    }
    const canonicalRelease = await realpath(referenced.releaseDir);
    const canonicalEntry = await realpath(trusted.entryPath);
    const rel = relative(canonicalRelease, canonicalEntry);
    if (!(rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))) {
      throw new Error("managed adapter reference escapes its release");
    }
    if (!(await stat(canonicalEntry)).isFile()) throw new Error("managed adapter reference entry is not a file");
    result.add(referenced.manifest.releaseId);
  }
  return result;
}

function isManifest(value: Record<string, unknown>, id: ManagedAdapterId, releaseId: string): boolean {
  return value.schemaVersion === 1 && value.id === id && value.releaseId === releaseId
    && typeof value.packageName === "string" && typeof value.version === "string"
    && typeof value.registry === "string" && typeof value.nodeExecutable === "string"
    && typeof value.entryRelPath === "string" && typeof value.installedAt === "string";
}
