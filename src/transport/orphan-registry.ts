import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { parseCanonicalFileTime } from "../process/windows-process-identity";
import { queryWindowsProcessIdentity } from "../process/windows-process-tree";

export const ORPHAN_CATEGORIES = ["intents", "owners", "residuals"] as const;
export type OrphanCategory = typeof ORPHAN_CATEGORIES[number];

export interface DaemonIdentity {
  generationId: string;
  daemonPid: number;
  daemonCreationDate: string | null;
  configRoot: string;
}

export interface LaunchIntentRecord {
  schemaVersion: 1;
  kind: "intent";
  token: string;
  launcherPid: number;
  launcherCreationDate: string;
  generationId: string;
  configRoot: string;
  queueHash: string;
  agentCommand: string;
  createdAt: string;
}

export interface OwnerFingerprint {
  executablePath: string;
  commandLine: string;
  creationDate: string;
}

export interface OwnerRecord {
  schemaVersion: 1;
  token: string;
  pid: number;
  queueHash: string;
  acpxRecordId: string;
  generationId: string;
  configRoot: string;
  startedAt: string;
  agentCommand: string;
  fingerprint: OwnerFingerprint | null;
  killAttempts: number;
}

export interface ResidualRecord {
  kind: "residual";
  ownerToken: string;
  pid: number;
  creationDate: string;
  commandLine: string;
  executablePath: string;
  agentCommand: string;
  generationId: string;
  killAttempts: number;
}

type OrphanRecord = LaunchIntentRecord | OwnerRecord | ResidualRecord;

export interface OrphanRegistryFaults {
  onBoundary?: (boundary: string, path: string) => void | Promise<void>;
}

export async function createDaemonIdentity(input: {
  configRoot: string;
  pid?: number;
  platform?: NodeJS.Platform;
  generationId?: string;
  queryIdentity?: typeof queryWindowsProcessIdentity;
}): Promise<DaemonIdentity> {
  const pid = input.pid ?? process.pid;
  const platform = input.platform ?? process.platform;
  const processIdentity = platform === "win32"
    ? await (input.queryIdentity ?? queryWindowsProcessIdentity)(pid)
    : null;
  return {
    generationId: input.generationId ?? randomUUID(),
    daemonPid: pid,
    daemonCreationDate: processIdentity?.creationDate ?? null,
    configRoot: input.configRoot,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

function positivePid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isoDate(value: unknown): value is string {
  return nonempty(value) && Number.isFinite(Date.parse(value));
}

function baseRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function decodeLaunchIntent(value: unknown): LaunchIntentRecord | null {
  const item = baseRecord(value);
  if (!item || item.schemaVersion !== 1 || item.kind !== "intent" || !UUID.test(String(item.token))
    || !positivePid(item.launcherPid) || parseCanonicalFileTime(item.launcherCreationDate) === null
    || !UUID.test(String(item.generationId)) || !nonempty(item.configRoot) || !nonempty(item.queueHash)
    || !nonempty(item.agentCommand) || !isoDate(item.createdAt)) return null;
  return item as unknown as LaunchIntentRecord;
}

function decodeFingerprint(value: unknown): OwnerFingerprint | null | undefined {
  if (value === null) return null;
  const item = baseRecord(value);
  if (!item || !nonempty(item.executablePath) || !nonempty(item.commandLine) || parseCanonicalFileTime(item.creationDate) === null) return undefined;
  return item as unknown as OwnerFingerprint;
}

export function decodeOwnerRecord(value: unknown): OwnerRecord | null {
  const item = baseRecord(value);
  if (!item || item.schemaVersion !== 1 || !UUID.test(String(item.token))
    || !positivePid(item.pid) || !nonempty(item.queueHash) || !nonempty(item.acpxRecordId)
    || !UUID.test(String(item.generationId)) || !nonempty(item.configRoot) || !isoDate(item.startedAt)
    || !nonempty(item.agentCommand) || !nonNegativeInteger(item.killAttempts)) return null;
  const fingerprint = decodeFingerprint(item.fingerprint);
  if (fingerprint === undefined) return null;
  return { ...(item as unknown as OwnerRecord), fingerprint };
}

export function decodeResidualRecord(value: unknown): ResidualRecord | null {
  const item = baseRecord(value);
  if (!item || item.kind !== "residual" || !UUID.test(String(item.ownerToken)) || !positivePid(item.pid)
    || parseCanonicalFileTime(item.creationDate) === null || !nonempty(item.commandLine)
    || !nonempty(item.executablePath) || !nonempty(item.agentCommand)
    || !UUID.test(String(item.generationId)) || !nonNegativeInteger(item.killAttempts)) return null;
  return item as unknown as ResidualRecord;
}

function decodeForCategory(category: OrphanCategory, value: unknown): OrphanRecord | null {
  if (category === "intents") return decodeLaunchIntent(value);
  if (category === "owners") return decodeOwnerRecord(value);
  return decodeResidualRecord(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stableJson(item[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class OrphanRegistry {
  readonly root: string;

  constructor(runtimeRoot: string, private readonly faults: OrphanRegistryFaults = {}) {
    this.root = join(runtimeRoot, "orphans");
  }

  private categoryPath(category: OrphanCategory): string {
    return join(this.root, category);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const category of ORPHAN_CATEGORIES) await mkdir(this.categoryPath(category), { recursive: true });
    await this.cleanupTemporaryDebris();
  }

  async writeGeneration(identity: DaemonIdentity): Promise<void> {
    if (!UUID.test(identity.generationId) || !positivePid(identity.daemonPid)
      || (identity.daemonCreationDate !== null && parseCanonicalFileTime(identity.daemonCreationDate) === null)
      || !nonempty(identity.configRoot)) throw new Error("invalid daemon identity");
    await this.durableWrite(join(this.root, "generation.json"), identity);
  }

  async readGeneration(): Promise<DaemonIdentity | null> {
    try {
      const item = JSON.parse(await readFile(join(this.root, "generation.json"), "utf8")) as Record<string, unknown>;
      if (!UUID.test(String(item.generationId)) || !positivePid(item.daemonPid)
        || (item.daemonCreationDate !== null && parseCanonicalFileTime(item.daemonCreationDate) === null)
        || !nonempty(item.configRoot)) return null;
      return item as unknown as DaemonIdentity;
    } catch { return null; }
  }

  async writeIntent(record: LaunchIntentRecord): Promise<void> {
    if (!decodeLaunchIntent(record)) throw new Error("invalid intent record");
    await this.durableWrite(join(this.categoryPath("intents"), `${record.token}.json`), record);
  }

  async deleteIntent(token: string): Promise<void> {
    if (!UUID.test(token)) throw new Error("invalid intent token");
    await rm(join(this.categoryPath("intents"), `${token}.json`), { force: true });
  }

  async writeOwner(record: OwnerRecord): Promise<string> {
    if (!decodeOwnerRecord(record) || !SAFE_KEY.test(record.queueHash)) throw new Error("invalid owner record");
    const name = `${record.queueHash}-${record.generationId}-${record.pid}.json`;
    await this.durableWrite(join(this.categoryPath("owners"), name), record);
    return name;
  }

  async deleteOwner(filename: string): Promise<void> {
    this.assertRecordFilename(filename, "owner");
    await rm(join(this.categoryPath("owners"), filename), { force: true });
  }

  async writeResidual(record: ResidualRecord): Promise<string> {
    if (!decodeResidualRecord(record)) throw new Error("invalid residual record");
    const name = `${record.ownerToken}-${record.pid}.json`;
    await this.durableWrite(join(this.categoryPath("residuals"), name), record);
    return name;
  }

  async deleteResidual(filename: string): Promise<void> {
    this.assertRecordFilename(filename, "residual");
    await rm(join(this.categoryPath("residuals"), filename), { force: true });
  }

  async migrateIntentToOwner(token: string, owner: OwnerRecord): Promise<void> {
    if (owner.token !== token) throw new Error("intent and owner tokens differ");
    await this.writeOwner(owner);
    await this.deleteIntent(token);
  }

  async migrateOwnerToResiduals(ownerFilename: string, residuals: ResidualRecord[]): Promise<void> {
    this.assertRecordFilename(ownerFilename, "owner");
    for (const residual of residuals) await this.writeResidual(residual);
    await this.deleteOwner(ownerFilename);
  }

  async readCategory(category: OrphanCategory): Promise<Array<{ filename: string; record: OrphanRecord }> | null> {
    try {
      const entries = (await readdir(this.categoryPath(category), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.includes(".tmp-"))
        .sort((left, right) => left.name.localeCompare(right.name));
      const result: Array<{ filename: string; record: OrphanRecord }> = [];
      for (const entry of entries) {
        const value = JSON.parse(await readFile(join(this.categoryPath(category), entry.name), "utf8"));
        const record = decodeForCategory(category, value);
        if (!record) return null;
        result.push({ filename: entry.name, record });
      }
      return result;
    } catch { return null; }
  }

  async listOwnerAgentCommands(
    categories: readonly OrphanCategory[],
  ): Promise<{ commands: string[]; snapshotRevision: string } | null> {
    if (categories.length !== ORPHAN_CATEGORIES.length || categories.some((value, index) => value !== ORPHAN_CATEGORIES[index])) {
      throw new Error("orphan categories must be exactly intents, owners, residuals");
    }
    const commands: string[] = [];
    const revision = createHash("sha256");
    for (const category of categories) {
      const records = await this.readCategory(category);
      if (!records) return null;
      for (const { filename, record } of records) {
        if (!nonempty(record.agentCommand)) return null;
        commands.push(record.agentCommand);
        revision.update(category).update("\0").update(filename).update("\0").update(stableJson(record)).update("\0");
      }
    }
    return { commands, snapshotRevision: revision.digest("hex") };
  }

  async cleanupTemporaryDebris(): Promise<void> {
    const directories = [this.root, ...ORPHAN_CATEGORIES.map((category) => this.categoryPath(category))];
    for (const directory of directories) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (entry.name.includes(".tmp-")) await rm(join(directory, entry.name), { recursive: true, force: true });
      }
    }
  }

  private async durableWrite(path: string, value: unknown): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    const tmp = `${path}.tmp-${randomUUID()}`;
    await this.faults.onBoundary?.("before-write", path);
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await this.faults.onBoundary?.("before-rename", path);
    await rename(tmp, path);
    await this.faults.onBoundary?.("after-rename", path);
  }

  private assertRecordFilename(filename: string, kind: "owner" | "residual"): void {
    if (basename(filename) !== filename || !filename.endsWith(".json") || filename.includes(".tmp-")) {
      throw new Error(`invalid ${kind} filename`);
    }
  }
}
