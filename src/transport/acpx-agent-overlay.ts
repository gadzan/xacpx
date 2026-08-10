import { chmod, readFile, stat } from "node:fs/promises";

import { join } from "node:path";

import { isRecord } from "../config/load-config";
import { resolveAcpxHomeDir } from "./acpx-session-files";
import { resolveConfiguredAgentLaunch } from "../config/resolve-agent-command";
import type { AppConfig } from "../config/types";
import { retryTransientWriteErrors, withPrivateFileLock } from "../util/private-file";
import type { AppState } from "../state/types";
import { deriveAgentAlias } from "../config/agent-launch";

export const ACPX_MANAGED_ALIAS_PREFIX = "xacpx-managed-";

export interface AcpxAgentOverlayEntry {
  alias: string;
  argv: string[];
}

export type AgentOverlayOutcome = "provisioned" | "noop" | "rejected";

export interface EnsureAgentOverlaysResult {
  outcomes: Record<string, AgentOverlayOutcome>;
  /** True when the config changed while waiting for the lock; the merge then
   * ran against the fresh content instead of the pre-lock snapshot. */
  raced: boolean;
}

export interface EnsureAgentOverlaysDeps {
  home?: string;
  readFileFn?: typeof readFile;
  statFn?: typeof stat;
  chmodFn?: typeof chmod;
  lockFn?: <T>(
    path: string,
    fn: (writeLocked: (content: string) => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  writeAtomicFn?: (path: string, content: string) => Promise<void>;
  platform?: NodeJS.Platform;
  delay?: (ms: number) => Promise<void>;
}

export function acpxConfigPath(home: string): string {
  return join(home, ".acpx", "config.json");
}

/**
 * Overlay entries required by the current config: one per configured agent
 * whose launch spec is a structured argv (managed codex/claude, hermes shim,
 * local fallback, user argv). Bare built-in drivers (pool, zeroclaw, gemini,
 * ...) resolve positionally and never get an overlay entry.
 */
export function computeAgentOverlayEntries(config: AppConfig): AcpxAgentOverlayEntry[] {
  const entries: AcpxAgentOverlayEntry[] = [];
  const seen = new Set<string>();
  for (const agent of Object.values(config.agents)) {
    const spec = resolveConfiguredAgentLaunch(agent, config.transport);
    if (!spec.agentArgv || !spec.acpxAgent.startsWith(ACPX_MANAGED_ALIAS_PREFIX)) {
      continue;
    }
    if (seen.has(spec.acpxAgent)) continue;
    seen.add(spec.acpxAgent);
    entries.push({ alias: spec.acpxAgent, argv: spec.agentArgv });
  }
  return entries;
}

/**
 * Overlay entries required by session-local argv persistence. Each session
 * whose `transport_acpx_agent` + `transport_agent_argv` is set (via the
 * session-local structured migration, or already-present in state) needs the
 * matching `xacpx-managed-<driver>-<hash>` alias present in
 * `~/.acpx/config.json` so acpx can resolve `--agent <alias>` to the exact
 * argv. Deduped by alias (content-hash on argv → identical argv shares an
 * alias → one overlay entry per unique argv across all sessions).
 */
export function computeSessionOverlayEntries(state: AppState): AcpxAgentOverlayEntry[] {
  const entries: AcpxAgentOverlayEntry[] = [];
  const seen = new Set<string>();
  for (const session of Object.values(state.sessions)) {
    const acpxAgent = session.transport_acpx_agent;
    const argv = session.transport_agent_argv;
    if (typeof acpxAgent !== "string" || acpxAgent.length === 0) continue;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((e) => typeof e === "string")) continue;
    if (seen.has(acpxAgent)) continue;
    seen.add(acpxAgent);
    entries.push({ alias: acpxAgent, argv: argv as string[] });
  }
  return entries;
}

/**
 * Pure merge of one overlay entry into a parsed acpx config object.
 * Throws on a malformed config; never overwrites an existing conflicting alias.
 */
export function mergeAcpxAgentOverlayEntry(
  raw: unknown,
  entry: AcpxAgentOverlayEntry,
): { config: Record<string, unknown>; outcome: AgentOverlayOutcome } {
  if (!isRecord(raw) || Array.isArray(raw)) {
    throw new Error("acpx config must be a JSON object");
  }
  if ("agents" in raw && (!isRecord(raw.agents) || Array.isArray(raw.agents))) {
    throw new Error('acpx config "agents" must be an object');
  }
  const agents = isRecord(raw.agents) ? raw.agents : {};
  if (Object.hasOwn(agents, entry.alias)) {
    const existing = agents[entry.alias];
    if (isRecord(existing) && argvEquals(existing.argv, entry.argv)) {
      return { config: raw, outcome: "noop" };
    }
    return { config: raw, outcome: "rejected" };
  }
  return {
    config: { ...raw, agents: { ...agents, [entry.alias]: { argv: [...entry.argv] } } },
    outcome: "provisioned",
  };
}

function argvEquals(existing: unknown, target: readonly string[]): boolean {
  return (
    Array.isArray(existing) &&
    existing.length === target.length &&
    existing.every((entry, index) => entry === target[index])
  );
}

interface ConfigSnapshot {
  content: string | null;
  mode: number | undefined;
}

async function readConfigSnapshot(
  path: string,
  readFileFn: typeof readFile,
  statFn: typeof stat,
): Promise<ConfigSnapshot> {
  try {
    const [content, info] = await Promise.all([readFileFn(path, "utf8"), statFn(path)]);
    return { content, mode: info.mode };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { content: null, mode: undefined };
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function serializeAcpxConfig(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Ensures every required overlay alias exists in `~/.acpx/config.json` with the
 * exact argv, merging under a proper-lockfile and never touching user agent
 * entries. Fails closed: corrupt/conflicting configs throw without writing.
 */
export async function ensureAgentOverlays(
  entries: AcpxAgentOverlayEntry[],
  deps: EnsureAgentOverlaysDeps = {},
): Promise<EnsureAgentOverlaysResult> {
  if (entries.length === 0) {
    return { outcomes: {}, raced: false };
  }

  const path = acpxConfigPath(deps.home ?? resolveAcpxHomeDir());
  const readFileFn = deps.readFileFn ?? readFile;
  const statFn = deps.statFn ?? stat;
  const chmodFn = deps.chmodFn ?? chmod;
  const lockFn = deps.lockFn ?? withPrivateFileLock;
  const writeAtomicFn = deps.writeAtomicFn;
  const platform = deps.platform ?? process.platform;

  // Snapshot before locking so a concurrent modification while we wait can be
  // detected and reported. Content equality is the invariant that matters;
  // mtime granularity is too coarse on some filesystems.
  const snapshot = await readConfigSnapshot(path, readFileFn, statFn);
  const result: EnsureAgentOverlaysResult = { outcomes: {}, raced: false };

  await lockFn(path, async (writeLocked) => {
    const current = await readConfigSnapshot(path, readFileFn, statFn);
    // proper-lockfile only serializes xacpx writers; a non-cooperative writer
    // (user edit, other tool) can change the file while we waited. Merge against
    // the FRESH content — merging is purely additive, so nothing is clobbered.
    const base = current.content !== snapshot.content ? current : snapshot;
    result.raced = current.content !== snapshot.content;

    let parsed: Record<string, unknown>;
    if (base.content === null) {
      parsed = {};
    } else {
      let value: unknown;
      try {
        value = JSON.parse(base.content) as unknown;
      } catch {
        throw new Error(`acpx config is not valid JSON: ${path}`);
      }
      if (!isRecord(value) || Array.isArray(value)) {
        throw new Error(`acpx config must be a JSON object: ${path}`);
      }
      parsed = value;
    }

    let next: Record<string, unknown> = parsed;
    let changed = false;
    for (const entry of entries) {
      const merged = mergeAcpxAgentOverlayEntry(next, entry);
      result.outcomes[entry.alias] = merged.outcome;
      if (merged.outcome === "rejected") {
        // Fail closed: the on-disk alias holds a DIFFERENT argv than the launch
        // xacpx computed. Continuing would let acpx execute the disk entry's
        // command — silently launching a different agent than configured.
        throw new Error(
          `acpx config agent alias ${entry.alias} already exists with a different argv ` +
            `(${path}); refusing to overwrite. Remove or fix the conflicting entry, then restart.`,
        );
      }
      if (merged.outcome === "provisioned") {
        next = merged.config;
        changed = true;
      }
    }
    if (!changed) {
      return;
    }

    const serialized = serializeAcpxConfig(next);
    // writeLocked is the lock-scoped atomic writer (no re-lock, which would
    // deadlock against the held proper-lockfile). writeAtomicFn is a test seam.
    await retryTransientWriteErrors(
      () => (deps.writeAtomicFn ? deps.writeAtomicFn(path, serialized) : writeLocked(serialized)),
      { platform, delay: deps.delay },
    );
    // Preserve the mode of an existing user config; new files get 0600 from the
    // atomic writer.
    if (snapshot.mode !== undefined) {
      await chmodFn(path, snapshot.mode).catch(() => {});
    }
    await verifyAcpxConfigWrite(path, next, readFileFn);
  });

  return result;
}

/** After a write, re-read and confirm nothing was lost or mangled. */
async function verifyAcpxConfigWrite(
  path: string,
  expected: Record<string, unknown>,
  readFileFn: typeof readFile,
): Promise<void> {
  const raw = JSON.parse(await readFileFn(path, "utf8")) as unknown;
  if (!isRecord(raw) || Array.isArray(raw)) {
    throw new Error(`acpx config write verification failed (not an object): ${path}`);
  }
  for (const key of Object.keys(expected)) {
    if (!(key in raw)) {
      throw new Error(`acpx config write verification failed (missing key "${key}"): ${path}`);
    }
  }
  if (isRecord(expected.agents) && isRecord(raw.agents)) {
    for (const [name, expectedEntry] of Object.entries(expected.agents)) {
      if (!(name in raw.agents)) {
        throw new Error(`acpx config write verification failed (missing agent "${name}"): ${path}`);
      }
      if (!deepEqual(raw.agents[name], expectedEntry)) {
        throw new Error(`acpx config write verification failed (agent "${name}" mangled): ${path}`);
      }
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/** Parse and validate the bridge env-carried overlay list (`{alias, argv}[]`). */
export function parseAgentOverlayEntries(raw: string): AcpxAgentOverlayEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("XACPX_BRIDGE_AGENT_OVERLAYS is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("XACPX_BRIDGE_AGENT_OVERLAYS must be a JSON array");
  }
  return parsed.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.alias !== "string" || !entry.alias) {
      throw new Error(`XACPX_BRIDGE_AGENT_OVERLAYS[${index}] must have a non-empty alias`);
    }
    if (!Array.isArray(entry.argv) || entry.argv.length === 0 || entry.argv.some((a) => typeof a !== "string")) {
      throw new Error(`XACPX_BRIDGE_AGENT_OVERLAYS[${index}] argv must be a non-empty string array`);
    }
    return { alias: entry.alias, argv: [...entry.argv] as string[] };
  });
}
