import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";

import {
  normalizeBridgeNonInteractivePermissions,
  normalizeBridgePermissionMode,
  normalizeBridgePermissionPolicy,
  normalizeBridgeQueueOwnerTtlSeconds,
  normalizeBridgeSessionInitTimeoutMs,
} from "./bridge-env";
import { BridgeServer } from "./bridge-server";
import { BridgeRuntime } from "./bridge-runtime";
import { coreEnv } from "../runtime/core-env";
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
  // PR6-8: construct dormant RuntimeEngine for queue/permission/MCP fences and Host restart prime
  // It is dormant because EngineRouter defaults to CLI unless a session explicitly declares transportEngine runtime
  let runtimeEngine: import("./engine/runtime-engine.js").RuntimeEngine | undefined;
  try {
    const { RuntimeEngine, defaultWorkerEntryCandidates } = await import("./engine/runtime-engine.js");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { coreHomeDir } = await import("../runtime/core-home.js");
    const { resolveAcpxHomeDir } = await import("../transport/acpx-session-files.js");
    const { existsSync } = await import("node:fs");
    const candidates = defaultWorkerEntryCandidates();
    const entry = candidates.find((c) => { try { return existsSync(c); } catch { return false; } });
    if (entry) {
      const xacpxRuntime = join(coreHomeDir(homedir()), "runtime");
      const acpxSessions = join(resolveAcpxHomeDir(), ".acpx", "sessions");
      runtimeEngine = new RuntimeEngine({
        workerEntryPath: entry,
        permissionMode: normalizeBridgePermissionMode(coreEnv("BRIDGE_PERMISSION_MODE")),
        nonInteractivePermissions: normalizeBridgeNonInteractivePermissions(coreEnv("BRIDGE_NON_INTERACTIVE_PERMISSIONS")),
        permissionPolicy: normalizeBridgePermissionPolicy(coreEnv("BRIDGE_PERMISSION_POLICY")),
        queueOwnerTtlSeconds: normalizeBridgeQueueOwnerTtlSeconds(coreEnv("BRIDGE_QUEUE_OWNER_TTL_SECONDS")),
        queueDir: join(xacpxRuntime, "runtime-queue"),
        fenceDir: join(xacpxRuntime, "worker-fences"),
        stateDir: acpxSessions,
      });
    }
  } catch {}
  const { EngineRouter } = await import("./engine/engine-router.js");
  const { SessionEngineBinding } = await import("./engine/session-engine-binding.js");
  const { CliEngine } = await import("./engine/cli/cli-engine.js");
  const router = runtimeEngine
    ? new EngineRouter(new SessionEngineBinding(), new CliEngine(cliRuntime), runtimeEngine)
    : new EngineRouter(new SessionEngineBinding(), new CliEngine(cliRuntime));
  server = new BridgeServer(router as unknown as BridgeRuntime);
  // PR6: real Host restart recovery — prime durable queues from persisted state
  try {
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { coreHomeDir } = await import("../runtime/core-home.js");
    const { readFile } = await import("node:fs/promises");
    const statePath = join(coreHomeDir(homedir()), "state.json");
    const raw = await readFile(statePath, "utf8").catch(() => null);
    if (raw) {
      const parsed = JSON.parse(raw) as { sessions?: Record<string, { alias: string; agent: string; cwd: string; logicalSessionId?: string; transportEngine?: string; mcpCoordinatorSession?: string; mcpSourceHandle?: string }> | Array<{ alias: string; agent: string; cwd: string; logicalSessionId?: string; transportEngine?: string; mcpCoordinatorSession?: string; mcpSourceHandle?: string }> };
      const sessionsRecord = parsed.sessions;
      const sessionsList = Array.isArray(sessionsRecord) ? sessionsRecord : sessionsRecord ? Object.values(sessionsRecord) : [];
      // Authoritative EngineSessionInput requires physical transport_session as name, logical_session_id as identity,
      // and workspace-resolved cwd (not raw workspace name). Fail closed if any required field missing.
      let workspaces: Record<string, { cwd: string }> = {};
      try {
        const cfgRaw = await readFile(join(coreHomeDir(homedir()), "config.json"), "utf8").catch(() => null);
        if (cfgRaw) workspaces = (JSON.parse(cfgRaw).workspaces ?? {}) as Record<string, { cwd: string }>;
      } catch {}
      const sessions = sessionsList
        .filter((s) => {
          const rec = s as unknown as Record<string, unknown>;
          const eng = (rec.transportEngine ?? rec["transportEngine"] ?? rec["transport_engine"]) as string | undefined;
          return eng === "runtime";
        })
        .map((s) => {
          const rec = s as unknown as Record<string, unknown>;
          const transportSession = rec.transport_session ?? rec["transport_session"] ?? rec["transportSession"];
          const logicalId = rec.logical_session_id ?? rec["logical_session_id"] ?? rec.logicalSessionId ?? rec["logicalSessionId"];
          const wsName = rec.workspace ?? rec["workspace"];
          let cwd = "/";
          if (typeof wsName === "string" && workspaces[wsName]?.cwd) cwd = workspaces[wsName].cwd;
          else if (typeof rec.cwd === "string") cwd = rec.cwd as string;
          else if (typeof rec["cwd"] === "string") cwd = rec["cwd"] as string;
          const agent = rec.agent ?? rec["agent"];
          const mcpCoord = rec.mcpCoordinatorSession ?? rec["mcpCoordinatorSession"];
          const mcpSrc = rec.mcpSourceHandle ?? rec["mcpSourceHandle"];
          if (typeof transportSession !== "string" || !transportSession) return null as unknown as { name: string };
          if (typeof logicalId !== "string" || !logicalId) return null as unknown as { name: string };
          if (typeof agent !== "string" || !agent) return null as unknown as { name: string };
          return {
            agent: String(agent),
            cwd: String(cwd),
            name: String(transportSession),
            logicalSessionId: String(logicalId),
            ...(typeof mcpCoord === "string" ? { mcpCoordinatorSession: mcpCoord } : {}),
            ...(typeof mcpSrc === "string" ? { mcpSourceHandle: mcpSrc } : {}),
            // Launch identity requires resolved command/model/effort when available on the logical session
            ...(typeof rec.transport_agent_command === "string" ? { agentCommand: rec.transport_agent_command as string } : {}),
            ...(typeof rec.model === "string" ? { model: rec.model as string } : {}),
            ...(typeof rec.effort === "string" ? { effort: rec.effort as string } : {}),
          };
        })
        .filter((s) => s && s.name) as Array<{ agent: string; cwd: string; name: string; logicalSessionId: string; mcpCoordinatorSession?: string; mcpSourceHandle?: string; agentCommand?: string; model?: string; effort?: string }>;
      if (sessions.length > 0) {
        const maybePrime = (server as unknown as { primeRuntimeQueues?: (s: unknown[]) => Promise<void> }).primeRuntimeQueues;
        if (typeof maybePrime === "function") await maybePrime.call(server, sessions);
      }
    } else {
      // No runtime sessions to prime — not an error
    }
  } catch (e) {
    // Prime is best-effort at startup; log but don't crash bridge on corrupt state
    console.error("[bridge] primeRuntimeQueues failed", e);
  }
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
