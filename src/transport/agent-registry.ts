import { createRequire } from "node:module";
import type { AgentCommandRegistry } from "../config/agent-catalog";
import type { AppLogger } from "../logging/app-logger";

interface AcpxRuntime {
  createAgentRegistry(params?: { overrides?: Record<string, string> }): AgentCommandRegistry;
}

export interface AcpxAgentRegistryLoaderDeps {
  logger?: Pick<AppLogger, "error">;
  /** Test seam; production lazily requires the optional acpx runtime subpath. */
  loadRuntime?: () => AcpxRuntime;
}

const require = createRequire(import.meta.url);
const loadRuntime = (): AcpxRuntime => require("acpx/runtime") as AcpxRuntime;

/** Creates a lazy registry loader that caches both success and failure. Keeping the runtime
 * import here preserves src/transport as the only production boundary that executes acpx APIs. */
export function createAcpxAgentRegistryLoader(
  deps: AcpxAgentRegistryLoaderDeps = {},
): () => AgentCommandRegistry | null {
  let cached: AgentCommandRegistry | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    try {
      cached = (deps.loadRuntime ?? loadRuntime)().createAgentRegistry();
    } catch (error) {
      cached = null;
      void deps.logger?.error(
        "transport.agent_registry.unavailable",
        "could not read acpx's agent registry; install hints fall back to probing the driver name, so an installed CLI may show as not detected",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
    return cached;
  };
}
