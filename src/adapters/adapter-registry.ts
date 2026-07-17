export const DEFAULT_ADAPTER_REGISTRY = "https://registry.npmjs.org/";

export class AdapterRegistryPackageNotFoundError extends Error {
  readonly code = "E404";

  constructor(readonly registry: string) {
    super(`adapter package was not found in npm registry ${registry}`);
    this.name = "AdapterRegistryPackageNotFoundError";
  }
}

/** Validates and canonicalizes a registry URL before it reaches config or argv. */
export function normalizeAdapterRegistry(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || /\s/.test(value)) {
    throw new Error("adapter registry must be an http(s) URL without whitespace");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("adapter registry must be a valid http(s) URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) {
    throw new Error("adapter registry must be an http(s) URL");
  }
  if (url.username || url.password) {
    throw new Error("adapter registry must not contain credentials; configure npm auth separately");
  }
  if (url.search || url.hash) {
    throw new Error("adapter registry must not contain a query string or fragment");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  const normalized = url.toString();
  // The runtime value is embedded in acpx's agent-command string. Restrict it
  // to URL characters that cannot become shell/control syntax in downstream
  // command parsing; npm credentials belong in the user's scoped npm config.
  if (!/^[A-Za-z0-9._~:/@%+\[\]-]+$/.test(normalized)) {
    throw new Error("adapter registry contains unsupported command characters");
  }
  return normalized;
}

export function effectiveAdapterRegistry(configured: string | undefined): string {
  return configured ? normalizeAdapterRegistry(configured) : DEFAULT_ADAPTER_REGISTRY;
}

/** npm chooses a scope-specific registry over the generic registry, so both
 * flags are required to override company .npmrc files deterministically. */
export function adapterRegistryNpmArgs(registry: string): string[] {
  const normalized = effectiveAdapterRegistry(registry);
  return [
    `--registry=${normalized}`,
    `--@agentclientprotocol:registry=${normalized}`,
  ];
}

export function adapterRegistryE404Guidance(registry: string): string {
  return [
    `npm registry ${registry} returned E404 for the adapter package.`,
    `Run \`xacpx adapter registry set ${DEFAULT_ADAPTER_REGISTRY}\` to use the public npm registry,`,
    "or ask your registry administrator to proxy/allowlist the @agentclientprotocol scope.",
  ].join(" ");
}

export function describeAdapterRegistryError(error: unknown): string {
  return error instanceof AdapterRegistryPackageNotFoundError
    ? adapterRegistryE404Guidance(error.registry)
    : error instanceof Error ? error.message : String(error);
}
