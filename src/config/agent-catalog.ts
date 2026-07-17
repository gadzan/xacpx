import { createRequire } from "node:module";

import type { AppLogger } from "../logging/app-logger";

import type { AcpAgentRegistry } from "acpx/runtime";

import type { AppConfig } from "./types";
import { listAgentTemplates } from "./agent-templates";
import { isExecutableOnPath } from "./local-agent-bin";

export interface AgentCatalogEntry {
  driver: string;
  configured: boolean;
  installed: "builtin" | "yes" | "unknown";
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

const require = createRequire(import.meta.url);

/**
 * acpx's own agent registry, or null when acpx cannot be resolved.
 *
 * Lazy `require` rather than a static `import` on purpose. This module is reachable from
 * src/main.ts on EVERY command path, and acpx is not guaranteed to resolve: resolve-acpx-command.ts
 * treats it as possibly-absent (try/catch around `require.resolve("acpx/package.json")`, falling
 * back to a PATH `acpx`), and CLAUDE.md lists PATH as a supported way to supply it. A static import
 * would abort the entire CLI with an unhandled ERR_MODULE_NOT_FOUND — `--version` and `status`
 * included, and `doctor` worst of all, since doctor exists to REPORT an unresolvable acpx
 * (acpx-check.ts has a `severity:"fail"` branch a static import would make unreachable).
 *
 * Cached on BOTH outcomes, so a broken install costs one failed resolve, not one per call.
 *
 * `require` of an ESM module (acpx is `type: "module"`) is only unflagged from node 22.12, which
 * is why package.json's `engines` demands it: on 22.0–22.11 this throws ERR_REQUIRE_ESM and every
 * driver silently degrades to the bare-name probe — i.e. the bug this module exists to fix. The
 * unit tests cannot catch that, because they run under bun, which supports require(ESM) natively.
 * Hence the log below: a degradation this invisible must at least be diagnosable from app.log.
 *
 * Precedent for reaching acpx from src/config/ at all: resolve-acpx-command.ts:43 already does
 * `require.resolve("acpx/package.json")` here.
 */
let cachedRegistry: AcpAgentRegistry | null | undefined;

function loadAgentRegistry(logger?: AppLogger): AcpAgentRegistry | null {
  if (cachedRegistry !== undefined) return cachedRegistry;
  try {
    const runtime = require("acpx/runtime") as {
      createAgentRegistry: (params?: { overrides?: Record<string, string> }) => AcpAgentRegistry;
    };
    cachedRegistry = runtime.createAgentRegistry();
  } catch (error) {
    cachedRegistry = null;
    // Once per process (the null is cached). Names the user-visible consequence, because the
    // symptom — an installed agent labelled "CLI not detected" and greyed out — points nowhere.
    void logger?.error("config.agent_catalog.registry_unavailable", "could not read acpx's agent registry; install hints fall back to probing the driver name, so an installed CLI may show as not detected", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return cachedRegistry;
}

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
 * The probe target is derived from acpx's own registry — `createAgentRegistry()` from
 * `acpx/runtime`, a public typed subpath export — so it can't drift from acpx the way a
 * hand-copied table did. It resolves aliases too (`factory-droid` and `factorydroid` both
 * reach `droid exec --output-format acp`). What we derive is acpx's DEFAULT command for a
 * driver: its registry accepts an `overrides` map (which acpx populates from ~/.acpx/config.json)
 * that we do not reconstruct, and xacpx itself may substitute a local CLI at spawn time
 * (resolveLocalAgentCommand). Neither changes the answer for any driver today.
 *
 * `resolve()` does not throw on an unknown name — it echoes the name back — so a driver acpx
 * has dropped degrades to probing a binary of the same name.
 *
 * `probe` and `registry` are injectable for tests; `logger` reports an unreadable registry.
 */
export function listAgentCatalog(
  config: AppConfig,
  probe: (binary: string) => boolean = (binary) => isExecutableOnPath(binary),
  registry?: AcpAgentRegistry | null,
  logger?: AppLogger,
): AgentCatalogEntry[] {
  // `undefined` = resolve it; an explicit `null` = the caller is testing the degraded path.
  const acpxRegistry = registry === undefined ? loadAgentRegistry(logger) : registry;
  const agents = config.agents ?? {};
  const driverConfigured = (driver: string): boolean =>
    Object.entries(agents).some(([name, a]) => name === driver || a.driver === driver);

  return listAgentTemplates().map((driver) => {
    // No registry (acpx unresolvable) -> probe the bare driver name: exactly the pre-fix
    // behaviour, and the same guess `resolve()` makes for a name acpx has dropped. That user
    // gets the qoder-class mislabel back — their acpx comes from PATH, so its registry isn't
    // ours to read — which is strictly better than a CLI that refuses to start.
    const binary = probeTarget(acpxRegistry?.resolve(driver) ?? driver);
    // npx/uvx fetch the agent on demand, so there is no local binary worth probing.
    // (`pi` is the one npx entry acpx pins without `-y` — `npx pi-acp@^0.0.26` — so on a cold
    // npx cache it errors instead of installing. It is still "builtin": no `pi` binary exists
    // to probe, and "unknown" would disable it outright rather than surface that fixable error.)
    const installed: AgentCatalogEntry["installed"] =
      binary === "npx" || binary === "uvx" ? "builtin" : probe(binary) ? "yes" : "unknown";
    return { driver, configured: driverConfigured(driver), installed };
  });
}
