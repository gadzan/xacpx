import type { AppConfig } from "./types";
import { listAgentTemplates } from "./agent-templates";
import { isExecutableOnPath } from "./local-agent-bin";

export interface AgentCatalogEntry {
  driver: string;
  configured: boolean;
  installed: "builtin" | "yes" | "unknown";
}

/** Narrow view of acpx's registry supplied by the transport boundary. */
export interface AgentCommandRegistry {
  resolve(driver: string): string;
}

export interface ListAgentCatalogOptions {
  registry: AgentCommandRegistry | null;
  probe?: (binary: string) => boolean;
}

/**
 * `installed` semantics (three states, deliberately — do not add a fourth):
 *  - "builtin": acpx launches it via npx/uvx, so nothing needs pre-installing.
 *  - "yes":     needs a native CLI, and that CLI is on PATH.
 *  - "unknown": needs a native CLI, not found.
 *
 * "unknown" is not cosmetic — it DISABLES the driver in both web surfaces:
 * NewSessionDialog.vue (option `disabled`, and skipped when picking a default) and
 * AgentsManager.vue's own add-agent picker. A user who hits a false "unknown" therefore
 * cannot reach that agent from the web at all; their recourse is the WeChat `/agent add`
 * command (which never consults this field) or hand-editing config.json. Once configured,
 * a driver moves to the picker's configured group, which is never disabled. A false "yes",
 * by contrast, costs only one clear spawn-time error. Hence: derive, never guess.
 */

/**
 * Which CLI to probe for a driver: the first token of the command acpx would run.
 * The `?? ""` is unreachable (split always yields >= 1 element) but noUncheckedIndexedAccess
 * types `[0]` as possibly-undefined.
 */
function probeTarget(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

/**
 * Catalog of every acpx driver xacpx knows (from `listAgentTemplates()`), each tagged with
 * whether it's already configured and a best-effort install hint.
 *
 * The probe target is derived from the acpx registry supplied by the transport boundary,
 * so it can't drift from acpx the way a hand-copied table did. It resolves aliases too
 * (`factory-droid` and `factorydroid` both reach `droid exec --output-format acp`). What we
 * derive is acpx's DEFAULT command for a
 * driver: its registry accepts an `overrides` map (which acpx populates from ~/.acpx/config.json)
 * that we do not reconstruct, and xacpx itself may substitute a local CLI at spawn time
 * (resolveLocalAgentCommand). Neither changes the answer for any driver today.
 *
 * `resolve()` does not throw on an unknown name — it echoes the name back — so a driver acpx
 * has dropped degrades to probing a binary of the same name.
 *
 * The transport layer supplies `registry`; `probe` remains injectable for tests.
 */
export function listAgentCatalog(
  config: AppConfig,
  { registry, probe = (binary) => isExecutableOnPath(binary) }: ListAgentCatalogOptions,
): AgentCatalogEntry[] {
  const agents = config.agents ?? {};
  const driverConfigured = (driver: string): boolean =>
    Object.entries(agents).some(([name, a]) => name === driver || a.driver === driver);

  return listAgentTemplates().map((driver) => {
    // No registry (acpx unresolvable) -> probe the bare driver name: exactly the pre-fix
    // behaviour, and the same guess `resolve()` makes for a name acpx has dropped. That user
    // gets the qoder-class mislabel back — their acpx comes from PATH, so its registry isn't
    // ours to read — which is strictly better than a CLI that refuses to start.
    const binary = probeTarget(registry?.resolve(driver) ?? driver);
    // npx/uvx fetch the agent on demand, so there is no local binary worth probing.
    // (`pi` is the one npx entry acpx pins without `-y` — `npx pi-acp@^0.0.26` — so on a cold
    // npx cache it errors instead of installing. It is still "builtin": no `pi` binary exists
    // to probe, and "unknown" would disable it outright rather than surface that fixable error.)
    const installed: AgentCatalogEntry["installed"] =
      binary === "npx" || binary === "uvx" ? "builtin" : probe(binary) ? "yes" : "unknown";
    return { driver, configured: driverConfigured(driver), installed };
  });
}
