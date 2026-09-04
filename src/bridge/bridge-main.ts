import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";



import {
  normalizeBridgeNonInteractivePermissions,
  normalizeBridgePermissionMode,
  normalizeBridgePermissionPolicy,
  normalizeBridgeQueueOwnerTtlSeconds,
  normalizeBridgeSessionInitTimeoutMs,
} from "./bridge-env";
import { BridgeServer } from "./bridge-server";
import { BridgeRuntime } from "./bridge-runtime";
import { CliEngine } from "./engine/cli/cli-engine";
import { EngineRouter } from "./engine/engine-router";
import { SessionEngineBinding } from "./engine/session-engine-binding";
import { RuntimeEngine, defaultWorkerEntryCandidates } from "./engine/runtime-engine";
import { coreEnv } from "../runtime/core-env";
import { coreHomeDir } from "../runtime/core-home";
import { resolveAcpxHomeDir } from "../transport/acpx-session-files";
import { ensurePrivateRuntimeDir } from "../daemon/private-runtime-dir";
import { createQueueOwnerAdapterContext } from "../transport/queue-owner-adapter-context";
import { probeWindowsProcessIdentity } from "../process/windows-process-tree";
import { setLocale, resolveLocale } from "../i18n";
import { ensureAgentOverlays, parseAgentOverlayEntries } from "../transport/acpx-agent-overlay";

type BridgeInput = AsyncIterable<string> & {
  close(): void;
};

type BridgeWriter = (chunk: string) => boolean | void;

type BridgeLineHandler = {
  handleLine(line: string, writeLine?: (line: string) => void): Promise<string | null>;
  handleDisconnect?(error?: Error): void;
};

export async function processBridgeInput(options: {
  input: BridgeInput;
  server: BridgeLineHandler;
  write: BridgeWriter;
}): Promise<void> {
  const pendingWrites = new Set<Promise<void>>();
  let firstError: unknown;

  for await (const line of options.input) {
    const pendingWrite = (async () => {
      const response = await options.server.handleLine(line, (chunk) => {
        options.write(chunk);
      });
      if (response !== null) options.write(response);
    })();
    const observedPendingWrite = pendingWrite.catch((error) => {
      if (firstError === undefined) {
        firstError = error;
        options.input.close();
      }
    });

    pendingWrites.add(pendingWrite);
    void observedPendingWrite.finally(() => {
      pendingWrites.delete(pendingWrite);
    });
  }

  options.server.handleDisconnect?.();
  await Promise.allSettled(pendingWrites);

  if (firstError !== undefined) {
    throw firstError;
  }
}

export async function runBridgeMain(): Promise<void> {
  // The console hands the bridge the exact overlay entries it needs; re-provisioning
  // here is idempotent and keeps standalone bridge invocations consistent.
  const overlaysEnv = coreEnv("BRIDGE_AGENT_OVERLAYS");
  if (overlaysEnv) {
    await ensureAgentOverlays(parseAgentOverlayEntries(overlaysEnv));
    // The full argv list must not leak into the environment of the acpx/agent
    // children this bridge spawns (or hit Windows env-block size limits).
    delete process.env.XACPX_BRIDGE_AGENT_OVERLAYS;
  }
  let server: BridgeServer;
  const cliRuntime = new BridgeRuntime(coreEnv("BRIDGE_ACPX_COMMAND") ?? "acpx", undefined, undefined, {
      permissionMode: normalizeBridgePermissionMode(coreEnv("BRIDGE_PERMISSION_MODE")),
      nonInteractivePermissions: normalizeBridgeNonInteractivePermissions(
        coreEnv("BRIDGE_NON_INTERACTIVE_PERMISSIONS"),
      ),
      permissionPolicy: normalizeBridgePermissionPolicy(coreEnv("BRIDGE_PERMISSION_POLICY")),
      queueOwnerTtlSeconds: normalizeBridgeQueueOwnerTtlSeconds(
        coreEnv("BRIDGE_QUEUE_OWNER_TTL_SECONDS"),
      ),
      sessionInitTimeoutMs: normalizeBridgeSessionInitTimeoutMs(
        coreEnv("BRIDGE_SESSION_INIT_TIMEOUT_MS"),
      ),
      createAdapterContext: ({ id, sessionKey, agentCommand }) => createQueueOwnerAdapterContext({
        id,
        sessionKey,
        agentCommand,
        launcherIdentity: async () => {
          if (process.platform !== "win32") return { pid: process.pid, creationDate: "0" };
          const identity = await probeWindowsProcessIdentity(process.pid);
          if (identity.status !== "found") throw new Error("bridge launcher identity is unavailable");
          return { pid: process.pid, creationDate: identity.identity.creationDate };
        },
        requestDaemon: (method, params) => server.requestDaemon(method, params as never),
        readCurrentGeneration: readBridgeGeneration,
      }),
    });
  const cliEngine = new CliEngine(cliRuntime);
  // Explicit production wiring (Activation-E/F/G): RuntimeEngine is now
  // instantiated alongside CliEngine and fronted by EngineRouter.
  // transport.engine selects the executor: "cli" pins CLI, "runtime" is
  // strict Runtime, and "auto" picks Runtime for eligible new sessions
  // (bridge transport + eligible permission/shape/record) else CLI.
  // engine=runtime strict mode works because the Router has a real
  // RuntimeEngine to route to.
  let engine: CliEngine | EngineRouter = cliEngine;
  try {
    const workerEntry = defaultWorkerEntryCandidates().find((p) => {
      try { return statSync(p).isFile(); } catch { return false; }
    });
    if (workerEntry) {
      const bridgeStateDir = coreEnv("BRIDGE_STATE_DIR") ?? join(resolveAcpxHomeDir(), ".acpx", "sessions");
      // Queue journals and worker fences are xacpx-private coordination state:
      // they live under the xacpx-owned durable root, never inside upstream
      // acpx internals next to the sessions dir.
      const durableRoot = coreEnv("BRIDGE_RUNTIME_DURABLE_DIR") ?? join(coreHomeDir(homedir()), "runtime");
      // The durable root holds message journals + ownership fences whose only
      // access control is filesystem permissions: keep it user-private 0700
      // like the daemon runtime dir. Best-effort so a chmod failure never
      // bricks bridge startup; new subdirs are mkdir 0700 on write.
      try {
        await ensurePrivateRuntimeDir(durableRoot);
      } catch {}
      const queueDir = coreEnv("BRIDGE_RUNTIME_QUEUE_DIR") ?? join(durableRoot, "runtime-queue");
      const fenceDir = coreEnv("BRIDGE_RUNTIME_FENCE_DIR") ?? join(durableRoot, "worker-fences");
      try {
        await ensurePrivateRuntimeDir(queueDir);
      } catch {}
      try {
        await ensurePrivateRuntimeDir(fenceDir);
      } catch {}
      const runtimeEngine = new RuntimeEngine({
        stateDir: bridgeStateDir,
        permissionMode: normalizeBridgePermissionMode(coreEnv("BRIDGE_PERMISSION_MODE")),
        nonInteractivePermissions: normalizeBridgeNonInteractivePermissions(coreEnv("BRIDGE_NON_INTERACTIVE_PERMISSIONS")),
        permissionPolicy: normalizeBridgePermissionPolicy(coreEnv("BRIDGE_PERMISSION_POLICY")),
        durableRootDir: durableRoot,
        queueDir,
        fenceDir,
        onPermissionRequest: async (payload) => {
          try {
            const result = await server.requestDaemon("resolvePermissionRequest", payload as unknown as import("../transport/acpx-bridge/acpx-bridge-protocol").ResolvePermissionRequestParams, { timeoutMs: 8000 });
            const outcome = (result as { outcome?: unknown })?.outcome;
            if (outcome === "allow_once" || outcome === "allow_always" || outcome === "reject_once" || outcome === "reject_always" || outcome === "cancel") {
              return { outcome };
            }
            return { outcome: "reject_once" };
          } catch {
            return { outcome: "reject_once" };
          }
        },
        onElicitationRequest: async (payload) => {
          try {
            const result = await server.requestDaemon("resolveElicitationRequest", payload as unknown as import("../transport/acpx-bridge/acpx-bridge-protocol").ResolveElicitationRequestParams, { timeoutMs: 30000 });
            const action = (result as { action?: unknown })?.action;
            if (action === "submit") return { action: "submit", data: (result as { data?: unknown }).data };
            return { action: "cancel" };
          } catch {
            return { action: "cancel" };
          }
        },
      });
      const binding = new SessionEngineBinding();
      engine = new EngineRouter(binding, cliEngine, runtimeEngine);
      try {
        console.error("[bridge] RuntimeEngine wired; queue priming available on daemon request");
      } catch {}
    }
  } catch (e) {
    try { console.error(`[bridge] RuntimeEngine not available, falling back to cli-only: ${e instanceof Error ? e.message : String(e)}`); } catch {}
  }
  server = new BridgeServer(engine as unknown as BridgeRuntime);
  const input = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  await processBridgeInput({
    input,
    server,
    write: (chunk) => {
      process.stdout.write(chunk);
    },
  });
}

async function readBridgeGeneration(): Promise<string | null> {
  const path = coreEnv("BRIDGE_GENERATION_FILE");
  if (!path) return null;
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return typeof value.generationId === "string" && value.terminating !== true ? value.generationId : null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  setLocale(resolveLocale({ configLanguage: process.env.XACPX_LANG }));
  await runBridgeMain();
}
