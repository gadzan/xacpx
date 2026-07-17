export const MANAGED_ADAPTERS = {
  codex: {
    packageName: "@agentclientprotocol/codex-acp",
    binName: "codex-acp",
    defaultVersion: "1.1.4",
  },
  claude: {
    packageName: "@agentclientprotocol/claude-agent-acp",
    binName: "claude-agent-acp",
    defaultVersion: "0.59.0",
  },
} as const;

export type ManagedAdapterId = keyof typeof MANAGED_ADAPTERS;
export type AdapterVersionOverrides = Partial<Record<ManagedAdapterId, string>>;

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

export function buildManagedAdapterCommand(id: ManagedAdapterId, version: string): string {
  if (!isExactAdapterVersion(version)) throw new Error(`invalid adapter version: ${version}`);
  const spec = MANAGED_ADAPTERS[id];
  return `npx -y ${spec.packageName}@${version}`;
}

export function resolveManagedAdapterCommand(
  driver: string,
  overrides?: AdapterVersionOverrides,
): string | undefined {
  if (!isManagedAdapterId(driver)) return undefined;
  return buildManagedAdapterCommand(driver, effectiveAdapterVersion(driver, overrides));
}

export function isManagedAdapterCommand(driver: string, command: string | undefined): boolean {
  if (!command || !isManagedAdapterId(driver)) return false;
  const prefix = `npx -y ${MANAGED_ADAPTERS[driver].packageName}@`;
  return command.startsWith(prefix) && command.length > prefix.length && !/\s/.test(command.slice(prefix.length));
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
