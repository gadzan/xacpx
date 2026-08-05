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
  let server: BridgeServer;
  const runtime = new BridgeRuntime(coreEnv("BRIDGE_ACPX_COMMAND") ?? "acpx", undefined, undefined, {
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
  server = new BridgeServer(runtime);
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
