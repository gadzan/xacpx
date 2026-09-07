import { createRequire } from "node:module";
import { statSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { RuntimeEngine, defaultWorkerEntryCandidates } from "./runtime-engine";
import type { BridgeEngineCapabilities } from "../../transport/acpx-bridge/acpx-bridge-protocol";

export interface ProbeEngineCapabilitiesOptions {
  workerEntryPath?: string;
  loadRuntime?: () => Promise<unknown> | unknown;
  loadAcpxVersion?: () => Promise<string | undefined> | string | undefined;
  createRuntimeEngine?: (options: unknown) => unknown;
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export async function probeEngineCapabilities(
  options: ProbeEngineCapabilitiesOptions = {},
): Promise<BridgeEngineCapabilities> {
  let acpxVersion: string | undefined;
  if (options.loadAcpxVersion) {
    try {
      acpxVersion = await options.loadAcpxVersion();
    } catch {
      acpxVersion = undefined;
    }
  } else {
    try {
      const require = createRequire(import.meta.url);
      const pkgPath = require.resolve("acpx/package.json");
      const content = readFileSync(pkgPath, "utf8");
      const parsed = JSON.parse(content) as { version?: unknown };
      if (typeof parsed.version === "string") {
        acpxVersion = parsed.version;
      }
    } catch {
      try {
        const candidates = [
          resolvePath(process.cwd(), "node_modules/acpx/package.json"),
        ];
        for (const p of candidates) {
          if (fileExists(p)) {
            const content = readFileSync(p, "utf8");
            const parsed = JSON.parse(content) as { version?: unknown };
            if (typeof parsed.version === "string") {
              acpxVersion = parsed.version;
              break;
            }
          }
        }
      } catch {
        acpxVersion = undefined;
      }
    }
  }

  let runtimeMod: Record<string, unknown> | null = null;
  try {
    if (options.loadRuntime) {
      runtimeMod = (await options.loadRuntime()) as Record<string, unknown>;
    } else {
      const require = createRequire(import.meta.url);
      runtimeMod = require("acpx/runtime") as Record<string, unknown>;
    }
  } catch (error) {
    return {
      runtimeAvailable: false,
      runtimeImportOk: false,
      contractProbeOk: false,
      acpxVersion,
      reason: `acpx/runtime import failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!runtimeMod || typeof runtimeMod !== "object") {
    return {
      runtimeAvailable: false,
      runtimeImportOk: false,
      contractProbeOk: false,
      acpxVersion,
      reason: "acpx/runtime export is not an object",
    };
  }

  const missingExports: string[] = [];
  if (typeof runtimeMod.createAcpRuntime !== "function") missingExports.push("createAcpRuntime");
  if (typeof runtimeMod.createRuntimeStore !== "function") missingExports.push("createRuntimeStore");
  if (typeof runtimeMod.createAgentRegistry !== "function") missingExports.push("createAgentRegistry");

  if (missingExports.length > 0) {
    return {
      runtimeAvailable: false,
      runtimeImportOk: true,
      contractProbeOk: false,
      acpxVersion,
      reason: `acpx/runtime contract check failed: missing required exports [${missingExports.join(", ")}]`,
    };
  }

  try {
    const workerExists = options.workerEntryPath
      ? fileExists(options.workerEntryPath)
      : defaultWorkerEntryCandidates().some((p) => fileExists(p));

    if (!workerExists) {
      return {
        runtimeAvailable: false,
        runtimeImportOk: true,
        contractProbeOk: true,
        acpxVersion,
        reason: "runtime worker entry not found or not built",
      };
    }

    if (options.createRuntimeEngine) {
      options.createRuntimeEngine({
        permissionMode: "approve-all",
        ...(options.workerEntryPath ? { workerEntryPath: options.workerEntryPath } : {}),
      });
    } else {
      new RuntimeEngine({
        permissionMode: "approve-all",
        ...(options.workerEntryPath ? { workerEntryPath: options.workerEntryPath } : {}),
      });
    }
  } catch (error) {
    return {
      runtimeAvailable: false,
      runtimeImportOk: true,
      contractProbeOk: false,
      acpxVersion,
      reason: `RuntimeEngine construction failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    runtimeAvailable: true,
    runtimeImportOk: true,
    contractProbeOk: true,
    acpxVersion,
  };
}
