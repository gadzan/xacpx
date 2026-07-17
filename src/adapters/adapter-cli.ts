import {
  MANAGED_ADAPTERS,
  effectiveAdapterVersion,
  isExactAdapterVersion,
  isManagedAdapterId,
  listManagedAdapterIds,
  type AdapterVersionOverrides,
  type ManagedAdapterId,
} from "./adapter-catalog";
import { t } from "../i18n";
import {
  DEFAULT_ADAPTER_REGISTRY,
  describeAdapterRegistryError,
  effectiveAdapterRegistry,
  normalizeAdapterRegistry,
} from "./adapter-registry";

export interface AdapterCliDeps {
  loadVersions: () => Promise<AdapterVersionOverrides>;
  /** Replaces only transport.adapterVersions in one atomic config write. */
  saveVersions: (versions: AdapterVersionOverrides) => Promise<void>;
  loadRegistry: () => Promise<string | undefined>;
  /** Sets transport.adapterRegistry; undefined removes the override. */
  saveRegistry: (registry: string | undefined) => Promise<void>;
  getLatestVersion: (id: ManagedAdapterId, registry: string) => Promise<string | null>;
  versionExists: (id: ManagedAdapterId, version: string, registry: string) => Promise<boolean>;
  verifyVersion: (id: ManagedAdapterId, version: string, registry: string) => Promise<void>;
  print: (line: string) => void;
}

export async function handleAdapterCli(args: string[], deps: AdapterCliDeps): Promise<number | null> {
  const command = args[0];
  if (command === "list" && args.length === 1) return await listAdapters(deps);
  if (command === "registry") return await handleRegistry(args.slice(1), deps);
  if (command === "check" && args.length <= 2) return await checkAdapters(args[1], deps);
  if (command === "set" && args.length === 3) return await setAdapter(args[1], args[2], deps);
  if (command === "reset" && args.length === 2) return await resetAdapter(args[1], deps);
  if (command === "update" && args.length === 2) {
    const target = args[1]!;
    return await updateAdapters(target === "--all" ? listManagedAdapterIds() : [target], deps);
  }
  return null;
}

async function handleRegistry(args: string[], deps: AdapterCliDeps): Promise<number | null> {
  if (args.length === 0) {
    const configured = await deps.loadRegistry();
    deps.print(t().cli.adapterRegistryCurrent(
      effectiveAdapterRegistry(configured),
      configured ? t().cli.adapterSourceConfigured : t().cli.adapterSourceDefault,
    ));
    return 0;
  }
  if (args.length === 2 && args[0] === "set") {
    try {
      const registry = normalizeAdapterRegistry(args[1]!);
      await deps.saveRegistry(registry);
      deps.print(t().cli.adapterRegistrySaved(registry));
      deps.print(t().cli.adapterRestartRequired);
      return 0;
    } catch (error) {
      deps.print(t().cli.adapterInvalidRegistry(error instanceof Error ? error.message : String(error)));
      return 1;
    }
  }
  if (args.length === 1 && args[0] === "reset") {
    await deps.saveRegistry(undefined);
    deps.print(t().cli.adapterRegistryReset(DEFAULT_ADAPTER_REGISTRY));
    deps.print(t().cli.adapterRestartRequired);
    return 0;
  }
  return null;
}

async function listAdapters(deps: AdapterCliDeps): Promise<number> {
  const versions = await deps.loadVersions();
  deps.print(t().cli.adapterListHeader);
  for (const id of listManagedAdapterIds()) {
    deps.print(t().cli.adapterListRow(
      id,
      effectiveAdapterVersion(id, versions),
      MANAGED_ADAPTERS[id].defaultVersion,
      versions[id] ? t().cli.adapterSourceConfigured : t().cli.adapterSourceDefault,
    ));
  }
  return 0;
}

async function checkAdapters(rawId: string | undefined, deps: AdapterCliDeps): Promise<number> {
  const ids = rawId ? resolveIds([rawId], deps) : listManagedAdapterIds();
  if (!ids) return 1;
  const versions = await deps.loadVersions();
  const registry = effectiveAdapterRegistry(await deps.loadRegistry());
  for (const id of ids) {
    let latest: string | null;
    try {
      latest = await deps.getLatestVersion(id, registry);
    } catch (error) {
      deps.print(t().cli.adapterFailed(id, describeAdapterRegistryError(error)));
      return 1;
    }
    if (!latest) {
      deps.print(t().cli.adapterLatestUnavailable(id));
      return 1;
    }
    deps.print(t().cli.adapterCheckRow(id, effectiveAdapterVersion(id, versions), latest));
  }
  return 0;
}

async function setAdapter(rawId: string | undefined, rawVersion: string | undefined, deps: AdapterCliDeps): Promise<number> {
  const ids = resolveIds(rawId ? [rawId] : [], deps);
  if (!ids || !rawVersion) return 1;
  const version = rawVersion.trim();
  if (!isExactAdapterVersion(version)) {
    deps.print(t().cli.adapterInvalidVersion(rawVersion));
    return 1;
  }
  const id = ids[0]!;
  const registry = effectiveAdapterRegistry(await deps.loadRegistry());
  try {
    if (!await deps.versionExists(id, version, registry)) {
      deps.print(t().cli.adapterVersionUnavailable(id, version));
      return 1;
    }
    deps.print(t().cli.adapterVerifying(id, version));
    await deps.verifyVersion(id, version, registry);
    const versions = await deps.loadVersions();
    await deps.saveVersions({ ...versions, [id]: version });
    deps.print(t().cli.adapterSaved(id, version));
    deps.print(t().cli.adapterRestartRequired);
    return 0;
  } catch (error) {
    deps.print(t().cli.adapterFailed(id, describeAdapterRegistryError(error)));
    return 1;
  }
}

async function updateAdapters(rawIds: string[], deps: AdapterCliDeps): Promise<number> {
  const ids = resolveIds(rawIds, deps);
  if (!ids) return 1;
  const current = await deps.loadVersions();
  const registry = effectiveAdapterRegistry(await deps.loadRegistry());
  const candidates: Array<{ id: ManagedAdapterId; version: string }> = [];
  for (const id of ids) {
    let latest: string | null;
    try {
      latest = await deps.getLatestVersion(id, registry);
    } catch (error) {
      deps.print(t().cli.adapterFailed(id, describeAdapterRegistryError(error)));
      return 1;
    }
    if (!latest) {
      deps.print(t().cli.adapterLatestUnavailable(id));
      return 1;
    }
    if (!isExactAdapterVersion(latest)) {
      deps.print(t().cli.adapterInvalidVersion(latest));
      return 1;
    }
    if (effectiveAdapterVersion(id, current) === latest) {
      deps.print(t().cli.adapterAlreadyLatest(id, latest));
      continue;
    }
    candidates.push({ id, version: latest });
  }

  const next = { ...current };
  let verifyingId: ManagedAdapterId = ids[0]!;
  try {
    for (const candidate of candidates) {
      verifyingId = candidate.id;
      deps.print(t().cli.adapterVerifying(candidate.id, candidate.version));
      await deps.verifyVersion(candidate.id, candidate.version, registry);
      next[candidate.id] = candidate.version;
    }
    if (candidates.length === 0) return 0;
    await deps.saveVersions(next);
    for (const candidate of candidates) deps.print(t().cli.adapterSaved(candidate.id, candidate.version));
    deps.print(t().cli.adapterRestartRequired);
    return 0;
  } catch (error) {
    deps.print(t().cli.adapterFailed(verifyingId, describeAdapterRegistryError(error)));
    return 1;
  }
}

async function resetAdapter(rawId: string | undefined, deps: AdapterCliDeps): Promise<number> {
  const ids = resolveIds(rawId ? [rawId] : [], deps);
  if (!ids) return 1;
  const id = ids[0]!;
  const versions = await deps.loadVersions();
  const next = { ...versions };
  delete next[id];
  await deps.saveVersions(next);
  deps.print(t().cli.adapterReset(id, effectiveAdapterVersion(id, next)));
  deps.print(t().cli.adapterRestartRequired);
  return 0;
}

function resolveIds(rawIds: string[], deps: Pick<AdapterCliDeps, "print">): ManagedAdapterId[] | null {
  const result: ManagedAdapterId[] = [];
  for (const rawId of rawIds) {
    const id = rawId?.trim();
    if (!id || !isManagedAdapterId(id)) {
      deps.print(t().cli.adapterUnsupported(id || ""));
      return null;
    }
    if (!result.includes(id)) result.push(id);
  }
  return result.length > 0 ? result : null;
}
