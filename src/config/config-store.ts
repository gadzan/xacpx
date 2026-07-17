import { readFile } from "node:fs/promises";

import { withPrivateFileLock } from "../util/private-file.js";

import { loadConfig, parseConfig } from "./load-config";
import type { AdapterVersionOverrides } from "../adapters/adapter-catalog";
import type { AgentConfig, AppConfig, ChannelRuntimeConfig, PluginConfig } from "./types";

/**
 * Raw-patch config persistence.
 *
 * The parsed `AppConfig` is a READ model only: parsing drops unknown keys
 * (e.g. `workspaces.*.allowed_agents`), expands `~` in workspace cwds, and
 * materializes every default. Serializing it back would destroy a hand-edited
 * config.json. Every mutation therefore patches the raw JSON document read
 * straight from disk, touching only the targeted subtree, and never writes a
 * parsed config object.
 */

export type RawConfigPathSegment =
  | string
  | {
      /** Addresses the entry of a JSON array whose `id` property equals this value. */
      id: string;
      /** When set, a missing entry is materialized from this template on writes. */
      createWith?: Record<string, unknown>;
    };

export type RawConfigPath = readonly RawConfigPathSegment[];

export type RawConfigLookup = { present: true; value: unknown } | { present: false };

type RawConfig = Record<string, unknown>;

export class ConfigStore {
  constructor(private readonly path: string) {}

  async load(): Promise<AppConfig> {
    return await loadConfig(this.path);
  }

  /** Reads the raw (unparsed) value at `path`, e.g. to capture it for a rollback. */
  async getRawValue(path: RawConfigPath): Promise<RawConfigLookup> {
    return readRawConfigValue((await this.readRaw()).raw, path);
  }

  async setRawValue(path: RawConfigPath, value: unknown): Promise<AppConfig> {
    return await this.patchRaw((raw) => {
      setRawConfigValue(raw, path, value);
    });
  }

  async unsetRawValue(path: RawConfigPath): Promise<AppConfig> {
    return await this.patchRaw((raw) => {
      unsetRawConfigValue(raw, path);
    });
  }

  async upsertWorkspace(name: string, cwd: string, description?: string): Promise<AppConfig> {
    assertSafeConfigKey(name);
    return await this.patchRaw((raw) => {
      const workspaces = ensureRecordAt(raw, "workspaces");
      workspaces[name] = {
        cwd,
        ...(description ? { description } : {}),
      };
    });
  }

  async removeWorkspace(name: string): Promise<AppConfig> {
    assertSafeConfigKey(name);
    return await this.patchRaw((raw) => {
      deleteRecordEntry(raw, "workspaces", name);
    });
  }

  async upsertAgent(name: string, agent: AgentConfig): Promise<AppConfig> {
    assertSafeConfigKey(name);
    return await this.patchRaw((raw) => {
      const agents = ensureRecordAt(raw, "agents");
      agents[name] = {
        driver: agent.driver,
        ...(agent.command ? { command: agent.command } : {}),
        ...(agent.model ? { model: agent.model } : {}),
      };
    });
  }

  async removeAgent(name: string): Promise<AppConfig> {
    assertSafeConfigKey(name);
    return await this.patchRaw((raw) => {
      deleteRecordEntry(raw, "agents", name);
    });
  }

  /** Sets only the given transport keys; a key explicitly set to `undefined` is removed. */
  async updateTransport(patch: Partial<AppConfig["transport"]>): Promise<AppConfig> {
    return await this.patchRaw((raw) => {
      applyRecordPatch(ensureRecordAt(raw, "transport"), patch);
    });
  }

  /** Replaces only xacpx-managed adapter pins; unrelated transport keys stay untouched. */
  async replaceAdapterVersions(versions: AdapterVersionOverrides): Promise<AppConfig> {
    return await this.patchRaw((raw) => {
      const transport = ensureRecordAt(raw, "transport");
      if (Object.keys(versions).length === 0) {
        delete transport.adapterVersions;
      } else {
        transport.adapterVersions = clonePlain(versions);
      }
    });
  }

  /** Sets only the given channel keys; a key explicitly set to `undefined` is removed. */
  async updateChannel(patch: Partial<AppConfig["channel"]>): Promise<AppConfig> {
    return await this.patchRaw((raw) => {
      applyRecordPatch(ensureRecordAt(raw, "channel"), patch);
    });
  }

  /** Replaces the tool-managed `plugins` array; everything else stays untouched. */
  async replacePlugins(plugins: PluginConfig[]): Promise<AppConfig> {
    return await this.patchRaw((raw) => {
      raw.plugins = clonePlain(plugins);
    });
  }

  /** Replaces the tool-managed `channels` array; everything else stays untouched. */
  async replaceChannels(channels: ChannelRuntimeConfig[]): Promise<AppConfig> {
    return await this.patchRaw((raw) => {
      raw.channels = clonePlain(channels);
    });
  }

  // The whole read→patch→write span runs under ONE file lock: locking only
  // the write (the old shape) let two concurrent mutations read the same
  // snapshot, so the last writer silently erased the other's change.
  private async patchRaw(mutate: (raw: RawConfig) => void): Promise<AppConfig> {
    return await withPrivateFileLock(this.path, async (writeLocked) => {
      const { raw, existed } = await this.readRaw();
      // For a brand-new file, seed the required sections into the WRITTEN doc so
      // the file round-trips through load() (parseConfig requires transport/
      // agents/workspaces to be objects). For an existing file we only patch the
      // targeted subtree and never inject these sections.
      const doc: RawConfig = existed ? raw : { transport: {}, agents: {}, workspaces: {} };
      mutate(doc);
      // Validate the patched document before it lands on disk. The required
      // sections are backfilled for validation so a sparse existing file still
      // parses with defaults, without pinning those defaults into the file.
      const parsed = parseConfig({ transport: {}, agents: {}, workspaces: {}, ...doc });
      await writeLocked(serializeRawConfig(doc));
      return parsed;
    });
  }

  private async readRaw(): Promise<{ raw: RawConfig; existed: boolean }> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return { raw: {}, existed: false };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(
        `refusing to modify ${this.path}: it is not valid JSON (${
          error instanceof Error ? error.message : String(error)
        }); fix the file and retry`,
      );
    }
    if (!isPlainRecord(parsed)) {
      throw new Error(`refusing to modify ${this.path}: the top level must be a JSON object`);
    }
    return { raw: parsed, existed: true };
  }
}

export function serializeRawConfig(raw: Record<string, unknown>): string {
  return `${JSON.stringify(raw, null, 2)}\n`;
}

export function readRawConfigValue(root: Record<string, unknown>, path: RawConfigPath): RawConfigLookup {
  const lastKey = requireObjectKeyTail(path);
  let container: unknown = root;
  for (const segment of path.slice(0, -1)) {
    const next = descendForRead(container, segment);
    if (!next.ok) {
      return { present: false };
    }
    container = next.value;
  }
  if (!isPlainRecord(container) || !Object.hasOwn(container, lastKey)) {
    return { present: false };
  }
  return { present: true, value: container[lastKey] };
}

export function setRawConfigValue(root: Record<string, unknown>, path: RawConfigPath, value: unknown): void {
  const lastKey = requireObjectKeyTail(path);
  let container: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const nextSegment = path[index + 1]!;
    container = descendForWrite(container, segment, typeof nextSegment !== "string", path);
  }
  if (!isPlainRecord(container)) {
    throw new Error(`config path "${describeRawConfigPath(path)}" does not address an object`);
  }
  container[lastKey] = value;
}

export function unsetRawConfigValue(root: Record<string, unknown>, path: RawConfigPath): void {
  const lastKey = requireObjectKeyTail(path);
  let container: unknown = root;
  for (const segment of path.slice(0, -1)) {
    const next = descendForRead(container, segment);
    if (!next.ok) {
      return;
    }
    container = next.value;
  }
  if (isPlainRecord(container)) {
    delete container[lastKey];
  }
}

function descendForRead(
  container: unknown,
  segment: RawConfigPathSegment,
): { ok: true; value: unknown } | { ok: false } {
  if (typeof segment === "string") {
    assertSafeConfigKey(segment);
    if (!isPlainRecord(container) || !Object.hasOwn(container, segment)) {
      return { ok: false };
    }
    return { ok: true, value: container[segment] };
  }
  if (!Array.isArray(container)) {
    return { ok: false };
  }
  const entry = container.find((item) => isPlainRecord(item) && item.id === segment.id);
  return entry === undefined ? { ok: false } : { ok: true, value: entry };
}

function descendForWrite(
  container: unknown,
  segment: RawConfigPathSegment,
  nextIsArrayEntry: boolean,
  path: RawConfigPath,
): unknown {
  if (typeof segment === "string") {
    assertSafeConfigKey(segment);
    if (!isPlainRecord(container)) {
      throw new Error(`config path "${describeRawConfigPath(path)}" does not address an object at "${segment}"`);
    }
    let existing = container[segment];
    if (existing === undefined) {
      existing = nextIsArrayEntry ? [] : {};
      container[segment] = existing;
    }
    if (!isPlainRecord(existing) && !Array.isArray(existing)) {
      throw new Error(
        `refusing to overwrite config key "${segment}" (path "${describeRawConfigPath(path)}"): it is not an object`,
      );
    }
    return existing;
  }

  if (!Array.isArray(container)) {
    throw new Error(`config path "${describeRawConfigPath(path)}" expects an array before [id=${segment.id}]`);
  }
  const entry = container.find((item) => isPlainRecord(item) && item.id === segment.id);
  if (entry !== undefined) {
    return entry;
  }
  if (!segment.createWith) {
    throw new Error(`config path "${describeRawConfigPath(path)}" has no entry with id "${segment.id}"`);
  }
  const created = clonePlain(segment.createWith);
  container.push(created);
  return created;
}

function requireObjectKeyTail(path: RawConfigPath): string {
  const last = path[path.length - 1];
  if (typeof last !== "string") {
    throw new Error("raw config path must end with an object key");
  }
  assertSafeConfigKey(last);
  return last;
}

// Keys that, when used as a property name on a plain object, can mutate the
// prototype chain. They must never be written into (or read out of, defensively)
// the config document — a `/config set agents.__proto__.driver EVIL` from chat
// would otherwise poison Object.prototype in the live daemon.
const PROTOTYPE_POLLUTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function assertSafeConfigKey(key: string): void {
  if (PROTOTYPE_POLLUTING_KEYS.has(key)) {
    throw new Error(`refusing to use unsafe config key "${key}"`);
  }
}

function describeRawConfigPath(path: RawConfigPath): string {
  return path.map((segment) => (typeof segment === "string" ? segment : `[id=${segment.id}]`)).join(".");
}

function ensureRecordAt(raw: RawConfig, key: string): RawConfig {
  const existing = raw[key];
  if (existing === undefined) {
    const created: RawConfig = {};
    raw[key] = created;
    return created;
  }
  if (!isPlainRecord(existing)) {
    throw new Error(`refusing to overwrite config key "${key}": it is not a JSON object`);
  }
  return existing;
}

function deleteRecordEntry(raw: RawConfig, section: string, name: string): void {
  const record = raw[section];
  if (isPlainRecord(record)) {
    delete record[name];
  }
}

function applyRecordPatch(target: RawConfig, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
