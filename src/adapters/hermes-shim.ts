import { fileURLToPath } from "node:url";

/**
 * hermes-agent violates the ACP spec by replaying the full transcript on
 * `session/resume` (NousResearch/hermes-agent#32201). acpx suppresses replay only on
 * its `session/load` path and prefers resume when both capabilities are advertised,
 * so every hermes turn re-emits all prior turns into the reply stream AND into acpx's
 * on-disk session records (O(N²) growth). The shim interposes on hermes's stdio and
 * strips the advertised `sessionCapabilities.resume`, forcing acpx onto the guarded
 * load path. Remove this whole module once the upstream fix ships.
 */

const DEFAULT_HERMES_COMMAND = "hermes acp";

/** The command the 0.19.2 template baked into configs; treated as "no explicit
 * command" so those configs migrate onto the shim without hand-editing. */
export function isDefaultHermesCommand(command: string): boolean {
  return command.trim().replaceAll(/\s+/g, " ") === DEFAULT_HERMES_COMMAND;
}

/** A recorded shim command is derived, machine-specific state — the current
 * install's shim (whose dist path may differ after an upgrade) must replace it.
 * The leading separator keeps user wrappers like `my-hermes-acp-shim.sh` custom. */
export function isHermesShimCommand(command: string): boolean {
  return command.includes("/hermes-acp-shim.") || command.includes("\\hermes-acp-shim.");
}

const DIST_MARKER = "/dist/";

/**
 * Path to the shim entry script. Unbundled dev runs (module URL still ends in .ts)
 * resolve the sibling .ts source, which the dev runtime (bun) executes directly —
 * checked FIRST so a checkout path that happens to contain `/dist/` cannot
 * misresolve. Bundled builds (cli.js AND bridge/bridge-main.js both sit under
 * dist/) anchor on the last `/dist/` segment.
 */
export function resolveHermesAcpShimEntry(moduleUrl: string = import.meta.url): string {
  if (moduleUrl.endsWith(".ts")) {
    return fileURLToPath(new URL("./hermes-acp-shim.ts", moduleUrl));
  }
  const idx = moduleUrl.lastIndexOf(DIST_MARKER);
  if (idx !== -1) {
    return fileURLToPath(new URL(`${moduleUrl.slice(0, idx + DIST_MARKER.length)}adapters/hermes-acp-shim.js`));
  }
  return fileURLToPath(new URL("./hermes-acp-shim.js", moduleUrl));
}

/** Quote one token for acpx's `--agent` parser (double quotes; `\` and `"` escaped —
 * its splitCommandLine treats backslash as an escape inside double quotes). */
export function quoteAgentCommandToken(token: string): string {
  return `"${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Runtime-only agent command for the hermes driver: never persisted to config.
 *
 * Tradeoff: the string embeds `process.execPath` and this install's dist path,
 * and acpx keys its backend session records by EXACT agentCommand equality — so a
 * node upgrade (nvm paths embed the version) or an install relocation re-keys
 * hermes session identity: acpx starts a fresh backend record and the old queue
 * owner ages out via TTL. Accepted because the alternative (a stable bin shim)
 * isn't worth the packaging surface for a workaround slated for removal. */
export function hermesAcpShimCommand(
  execPath: string = process.execPath,
  shimEntry: string = resolveHermesAcpShimEntry(),
): string {
  return [
    quoteAgentCommandToken(execPath),
    quoteAgentCommandToken(shimEntry),
    "hermes",
    "acp",
  ].join(" ");
}

/**
 * If `line` is the initialize response advertising `sessionCapabilities.resume`,
 * return the same frame re-serialized without it; otherwise null (caller forwards
 * the original bytes untouched).
 */
export function stripResumeCapability(line: string): string | null {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;
  const result = (message as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;
  const capabilities = (result as { agentCapabilities?: unknown }).agentCapabilities;
  if (!capabilities || typeof capabilities !== "object") return null;
  const sessionCapabilities = (capabilities as { sessionCapabilities?: unknown }).sessionCapabilities;
  if (!sessionCapabilities || typeof sessionCapabilities !== "object") return null;
  if (!Object.hasOwn(sessionCapabilities, "resume")) return null;
  delete (sessionCapabilities as Record<string, unknown>).resume;
  return JSON.stringify(message);
}

/** Is `line` an initialize response (the only frame carrying agentCapabilities)?
 * Lets the shim latch to raw passthrough even when hermes stops advertising
 * `resume` after the upstream fix, instead of parsing every line forever. */
export function isInitializeResponse(line: string): boolean {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return false;
  }
  if (!message || typeof message !== "object") return false;
  const result = (message as { result?: unknown }).result;
  if (!result || typeof result !== "object") return false;
  const capabilities = (result as { agentCapabilities?: unknown }).agentCapabilities;
  return Boolean(capabilities) && typeof capabilities === "object";
}
