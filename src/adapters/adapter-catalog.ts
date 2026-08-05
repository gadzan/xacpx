import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

import {
  DEFAULT_ADAPTER_REGISTRY,
  adapterRegistryNpmArgs,
  normalizeAdapterRegistry,
} from "./adapter-registry";

export const MANAGED_ADAPTERS = {
  codex: {
    packageName: "@agentclientprotocol/codex-acp",
    binName: "codex-acp",
    defaultVersion: "1.1.9",
  },
  claude: {
    packageName: "@agentclientprotocol/claude-agent-acp",
    binName: "claude-agent-acp",
    defaultVersion: "0.64.2",
  },
} as const;

export type ManagedAdapterId = keyof typeof MANAGED_ADAPTERS;
export type AdapterVersionOverrides = Partial<Record<ManagedAdapterId, string>>;

export interface ManagedNpxCommand {
  kind: "npx";
  id: ManagedAdapterId;
  version: string;
  registry?: string;
}

export interface ManagedPreinstalledCommand {
  kind: "preinstalled";
  id: ManagedAdapterId;
  releaseId: string;
  nodeExecutable: string;
  entryPath: string;
}

export type DecodedManagedAdapterCommand = ManagedNpxCommand | ManagedPreinstalledCommand;

const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isManagedAdapterId(value: string): value is ManagedAdapterId {
  return Object.hasOwn(MANAGED_ADAPTERS, value);
}

export function listManagedAdapterIds(): ManagedAdapterId[] {
  return Object.keys(MANAGED_ADAPTERS) as ManagedAdapterId[];
}

export function isExactAdapterVersion(value: string): boolean {
  if (!EXACT_SEMVER.test(value)) return false;
  const prerelease = value.split("+", 1)[0]!.split("-", 2)[1];
  return !prerelease?.split(".").some((identifier) => /^0\d+$/.test(identifier));
}

export function effectiveAdapterVersion(
  id: ManagedAdapterId,
  overrides: AdapterVersionOverrides | undefined,
): string {
  return overrides?.[id] ?? MANAGED_ADAPTERS[id].defaultVersion;
}

export function buildManagedAdapterArgv(
  id: ManagedAdapterId,
  version: string,
  registry: string = DEFAULT_ADAPTER_REGISTRY,
): string[] {
  if (!isExactAdapterVersion(version)) throw new Error(`invalid adapter version: ${version}`);
  const spec = MANAGED_ADAPTERS[id];
  return [
    "npx",
    "-y",
    ...adapterRegistryNpmArgs(registry),
    `${spec.packageName}@${version}`,
  ];
}

export function buildManagedAdapterCommand(
  id: ManagedAdapterId,
  version: string,
  registry: string = DEFAULT_ADAPTER_REGISTRY,
): string {
  return buildManagedAdapterArgv(id, version, registry).join(" ");
}

export function resolveManagedAdapterArgv(
  driver: string,
  overrides?: AdapterVersionOverrides,
  registry?: string,
): string[] | undefined {
  if (!isManagedAdapterId(driver)) return undefined;
  return buildManagedAdapterArgv(driver, effectiveAdapterVersion(driver, overrides), registry);
}

export function resolveManagedAdapterCommand(
  driver: string,
  overrides?: AdapterVersionOverrides,
  registry?: string,
): string | undefined {
  if (!isManagedAdapterId(driver)) return undefined;
  return buildManagedAdapterCommand(driver, effectiveAdapterVersion(driver, overrides), registry);
}

export function isManagedAdapterCommand(driver: string, command: string | undefined): boolean {
  return isManagedAdapterId(driver) && parseManagedAdapterCommand(command)?.id === driver;
}

export function managedAdapterRegistryFromCommand(command: string | undefined): string | undefined {
  return parseManagedAdapterCommand(command)?.registry;
}

function parseManagedAdapterCommand(
  command: string | undefined,
): ManagedNpxCommand | undefined {
  if (!command) return undefined;
  const parts = command.split(" ");
  const hasLegacyShape = parts.length === 3 && parts[0] === "npx" && parts[1] === "-y";
  const hasRegistryShape = Boolean((parts.length === 4 || parts.length === 5)
    && parts[0] === "npx"
    && parts[1] === "-y"
    && parts[2]?.startsWith("--registry=")
    && (parts.length === 4 || parts[3]?.startsWith("--@agentclientprotocol:registry=")));
  if (!hasLegacyShape && !hasRegistryShape) return undefined;

  const packageValue = parts.at(-1) ?? "";
  const id = listManagedAdapterIds().find((candidate) => {
    const prefix = `${MANAGED_ADAPTERS[candidate].packageName}@`;
    return packageValue.startsWith(prefix) && packageValue.length > prefix.length;
  });
  if (!id) return undefined;
  const version = packageValue.slice(`${MANAGED_ADAPTERS[id].packageName}@`.length);
  if (hasLegacyShape) return { kind: "npx", id, version };

  const genericRegistry = parts[2]!.slice("--registry=".length);
  const scopedRegistry = parts.length === 5
    ? parts[3]!.slice("--@agentclientprotocol:registry=".length)
    : genericRegistry;
  try {
    const registry = normalizeAdapterRegistry(genericRegistry);
    if (normalizeAdapterRegistry(scopedRegistry) !== registry) return undefined;
    return { kind: "npx", id, version, registry };
  } catch {
    return undefined;
  }
}

export function canonicalAdapterRegistry(registry: string): string {
  return normalizeAdapterRegistry(registry);
}

export function adapterRegistryHash8(registry: string): string {
  return createHash("sha256").update(canonicalAdapterRegistry(registry)).digest("hex").slice(0, 8);
}

export function createAdapterReleaseId(version: string, registry: string, uuid: string = randomUUID()): string {
  if (!isExactAdapterVersion(version)) throw new Error(`invalid adapter version: ${version}`);
  const uuid8 = uuid.replaceAll("-", "").slice(0, 8).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(uuid8)) throw new Error("invalid release UUID");
  return `${version}-${adapterRegistryHash8(registry)}-${uuid8}`;
}

export function parseAdapterReleaseId(releaseId: string): { version: string; registryHash8: string; uuid8: string } | null {
  const match = /^(.+)-([0-9a-f]{8})-([0-9a-f]{8})$/.exec(releaseId);
  if (!match || !isExactAdapterVersion(match[1]!)) return null;
  return { version: match[1]!, registryHash8: match[2]!, uuid8: match[3]! };
}

export function splitAdapterCommand(command: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const input = command.trim();
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'" && (input[index + 1] === quote || input[index + 1] === "\\")) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/.test(character)) {
      if (current) { parts.push(current); current = ""; }
    } else current += character;
  }
  if (escaped || quote) return null;
  if (current) parts.push(current);
  return parts;
}

/** Structural preinstall classifier used only to decide whether launch fencing is mandatory. */
export function classifyPreinstalledAdapterCommandShape(command: string | undefined): ManagedAdapterId | null {
  if (!command) return null;
  const args = splitAdapterCommand(command);
  if (!args || args.length !== 2) return null;
  const entry = args[1]!.replaceAll("\\", "/").toLowerCase();
  for (const id of ["codex", "claude"] as const) {
    if (entry.includes(`/adapters/${id}/releases/`)) return id;
  }
  return null;
}

export interface DecodeManagedAdapterCommandOptions {
  adaptersRoot?: string;
  controlledNodeExecutable?: string;
  platform?: NodeJS.Platform;
  realpath?: (path: string) => Promise<string>;
}

/** The single trust-boundary decoder used by classification and GC. */
export async function decodeManagedAdapterCommand(
  command: string | undefined,
  options: DecodeManagedAdapterCommandOptions = {},
): Promise<DecodedManagedAdapterCommand | null> {
  const npx = parseManagedAdapterCommand(command);
  if (npx) return npx;
  if (!command || !options.adaptersRoot || !options.controlledNodeExecutable) return null;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const args = splitAdapterCommand(command);
  if (!args || args.length !== 2 || !pathApi.isAbsolute(args[0]!) || !pathApi.isAbsolute(args[1]!)) return null;
  const fold = (value: string) => platform === "win32" ? value.toLowerCase() : value;
  const resolveRealpath = options.realpath ?? realpath;
  const expectedNode = fold(await resolveRealpath(options.controlledNodeExecutable));
  const actualNode = fold(await resolveRealpath(args[0]!));
  if (actualNode !== expectedNode) return null;
  const root = fold(await resolveRealpath(options.adaptersRoot));
  const entry = fold(await resolveRealpath(args[1]!));
  const rel = pathApi.relative(root, entry);
  if (!rel || rel === ".." || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel)) return null;
  const segments = rel.split(/[\\/]+/);
  if (segments.length < 7) return null;
  const [id, releases, releaseId, nodeModules, scope, packageLeaf] = segments;
  if (!id || !isManagedAdapterId(id) || releases !== "releases" || nodeModules !== "node_modules") return null;
  if (`${scope}/${packageLeaf}` !== MANAGED_ADAPTERS[id].packageName || !parseAdapterReleaseId(releaseId!)) return null;
  return { kind: "preinstalled", id, releaseId: releaseId!, nodeExecutable: args[0]!, entryPath: args[1]! };
}

/** A recorded generated command is derived state, so a newer configured/default
 * version replaces it. Truly custom commands remain sticky for session identity. */
export function preferCurrentManagedAdapterCommand(
  driver: string,
  recorded: string | undefined,
  current: string | undefined,
): string | undefined {
  if (current && isManagedAdapterCommand(driver, current) && (!recorded || isManagedAdapterCommand(driver, recorded))) {
    return current;
  }
  return recorded ?? current;
}
