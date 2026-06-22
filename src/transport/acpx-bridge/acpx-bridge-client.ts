import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import {
  type BridgeMethod,
  type BridgeMessage,
  type BridgeResponse,
  type EnsureSessionProgressStage,
  encodeBridgeRequest,
} from "./acpx-bridge-protocol";
import { PromptCommandError } from "../prompt-output";
import { MissingOptionalDepError } from "../../recovery/errors";
import { terminateProcessTree } from "../../process/terminate-process-tree";
import type { PlanEntry, ToolUseEvent } from "../../channels/types.js";
import type { AgentCommand, UsageBreakdown, UsageCost } from "../types";
import { getLocale } from "../../i18n";
import { resolveDefaultXacpxCommand } from "../acpx-queue-owner-launcher";

// `boolean | void` return mirrors Writable.write: `false` only signals
// backpressure (the line is still queued and delivered), never failure.
// Real write failures are reported through the optional callback.
type WriteLine = (line: string, onWriteError?: (error?: Error | null) => void) => boolean | void;

export type BridgeEvent =
  | { type: "prompt.segment"; text: string }
  | { type: "prompt.tool_event"; event: ToolUseEvent }
  | { type: "prompt.thought"; text: string }
  | { type: "prompt.plan"; entries: PlanEntry[] }
  | { type: "prompt.usage"; used: number; size: number; cost?: UsageCost; breakdown?: UsageBreakdown }
  | { type: "prompt.commands"; commands: AgentCommand[] }
  | { type: "session.progress"; stage: EnsureSessionProgressStage }
  | { type: "session.note"; text: string };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  onEvent?: (event: BridgeEvent) => void;
}

export class AcpxBridgeClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private terminalError: Error | null = null;

  constructor(private readonly writeLine: WriteLine) {}

  request<TResult>(
    method: BridgeMethod,
    params: Record<string, unknown>,
    onEvent?: (event: BridgeEvent) => void,
  ): Promise<TResult> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }

    const id = String(this.nextId);
    this.nextId += 1;

    return awaitable<TResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        onEvent,
      });

      try {
        // A `false` return only signals backpressure (the line is still
        // queued and delivered), so it is deliberately ignored here. Only a
        // real write error — reported via the callback — fails the request.
        this.writeLine(
          encodeBridgeRequest({
            id,
            method,
            params,
          }),
          (error) => {
            if (error && this.pending.delete(id)) {
              reject(error);
            }
          },
        );
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  handleLine(line: string): void {
    let message: BridgeMessage;
    try {
      message = JSON.parse(line) as BridgeMessage;
    } catch {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    if ("event" in message) {
      if (message.event === "prompt.segment") {
        pending.onEvent?.({
          type: "prompt.segment",
          text: message.text,
        });
      } else if (message.event === "prompt.tool_event") {
        pending.onEvent?.({
          type: "prompt.tool_event",
          event: message.toolEvent,
        });
      } else if (message.event === "prompt.thought") {
        pending.onEvent?.({
          type: "prompt.thought",
          text: message.text,
        });
      } else if (message.event === "prompt.plan") {
        pending.onEvent?.({
          type: "prompt.plan",
          entries: message.entries,
        });
      } else if (message.event === "prompt.usage") {
        pending.onEvent?.({
          type: "prompt.usage",
          used: message.used,
          size: message.size,
          ...(message.cost ? { cost: message.cost } : {}),
          ...(message.breakdown ? { breakdown: message.breakdown } : {}),
        });
      } else if (message.event === "prompt.commands") {
        pending.onEvent?.({
          type: "prompt.commands",
          commands: message.commands,
        });
      } else if (message.event === "session.progress") {
        pending.onEvent?.({
          type: "session.progress",
          stage: message.stage,
        });
      } else if (message.event === "session.note") {
        pending.onEvent?.({
          type: "session.note",
          text: message.text,
        });
      }
      return;
    }

    const response = message as BridgeResponse;
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.result);
      return;
    }

    if (response.error.kind === "missing_optional_dep" && response.error.data) {
      pending.reject(
        new MissingOptionalDepError({
          package: response.error.data.package,
          parentPackagePath: response.error.data.parentPackagePath,
          rawMessage: response.error.message,
        }),
      );
      return;
    }

    if (response.error.details?.exitCode !== undefined) {
      pending.reject(
        new PromptCommandError(response.error.message, {
          code: response.error.details.exitCode,
          stdout: response.error.details.stdout ?? "",
          stderr: response.error.details.stderr ?? "",
        }),
      );
      return;
    }

    pending.reject(new Error(response.error.message));
  }

  handleExit(error: Error): void {
    this.terminalError = error;
    const pendingRequests = [...this.pending.values()];
    this.pending.clear();

    for (const pending of pendingRequests) {
      pending.reject(error);
    }
  }
}

export interface ManagedBridgeClient extends AcpxBridgeClient {
  waitUntilReady(): Promise<void>;
  dispose(): Promise<void>;
}

interface SpawnedBridgeClientOptions {
  acpxCommand?: string;
  /**
   * The xacpx CLI command the bridge's queue-owner launcher should use to spawn the
   * `mcp-stdio` coordinator server for each agent. MUST point at the CLI entry (cli.js),
   * not the bridge entry: the launcher runs *inside* this bridge subprocess, where
   * `process.argv[1]` is `bridge-main.js` — which only speaks the bridge protocol, so an
   * agent's MCP `initialize` handshake against it never completes and stalls ~30s per
   * prompt. Defaults to the console's own resolved command (see resolveDefaultXacpxCommand).
   */
  cliCommand?: string;
  bridgeEntryPath?: string;
  cwd?: string;
  permissionMode?: string;
  nonInteractivePermissions?: string;
  permissionPolicy?: string;
  queueOwnerTtlSeconds?: number;
  sessionInitTimeoutMs?: number;
}

export function buildBridgeSpawnEnv(
  options: SpawnedBridgeClientOptions = {},
): Record<string, string> {
  return {
    XACPX_LANG: getLocale(),
    // Resolved in the console process (where argv[1] is the CLI entry) and handed to the
    // bridge so its queue-owner launcher points each agent's `mcp-stdio` coordinator server
    // at the real CLI instead of bridge-main.js. resolveDefaultXacpxCommand honors an
    // explicit XACPX_CLI_COMMAND first, so a user/operator override still wins.
    XACPX_CLI_COMMAND: options.cliCommand ?? resolveDefaultXacpxCommand(process.env),
    XACPX_BRIDGE_ACPX_COMMAND: options.acpxCommand ?? "acpx",
    XACPX_BRIDGE_PERMISSION_MODE: options.permissionMode ?? "approve-all",
    XACPX_BRIDGE_NON_INTERACTIVE_PERMISSIONS: options.nonInteractivePermissions ?? "deny",
    ...(typeof options.permissionPolicy === "string" && options.permissionPolicy.trim().length > 0
      ? { XACPX_BRIDGE_PERMISSION_POLICY: options.permissionPolicy }
      : {}),
    ...(typeof options.queueOwnerTtlSeconds === "number" && Number.isFinite(options.queueOwnerTtlSeconds)
      ? { XACPX_BRIDGE_QUEUE_OWNER_TTL_SECONDS: String(options.queueOwnerTtlSeconds) }
      : {}),
    ...(typeof options.sessionInitTimeoutMs === "number"
      && Number.isFinite(options.sessionInitTimeoutMs)
      && options.sessionInitTimeoutMs > 0
      ? { XACPX_BRIDGE_SESSION_INIT_TIMEOUT_MS: String(options.sessionInitTimeoutMs) }
      : {}),
  };
}

export function buildBridgeSpawnSpec(options: {
  execPath: string;
  bridgeEntryPath: string;
}): { command: string; args: string[] } {
  if (options.execPath.endsWith("bun")) {
    return {
      command: options.execPath,
      args: ["run", options.bridgeEntryPath],
    };
  }

  return {
    command: options.execPath,
    args: [options.bridgeEntryPath],
  };
}

export async function spawnAcpxBridgeClient(
  options: SpawnedBridgeClientOptions = {},
): Promise<ManagedBridgeClient> {
  const bridgeEntryPath =
    options.bridgeEntryPath ?? fileURLToPath(new URL("../../bridge/bridge-main.ts", import.meta.url));
  const spawnSpec = buildBridgeSpawnSpec({
    execPath: process.execPath,
    bridgeEntryPath,
  });
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...buildBridgeSpawnEnv(options),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const client = manageBridgeChild(child);
  await client.waitUntilReady();
  return client;
}

/**
 * Minimal child-process surface needed by manageBridgeChild; lets tests drive a
 * fake child without spawning a real bridge process.
 */
export interface BridgeChildProcess {
  pid?: number | undefined;
  stdin: {
    write(chunk: string, callback?: (error?: Error | null) => void): boolean;
    end(): void;
    on(event: "error", listener: (error: Error) => void): unknown;
  };
  stdout: NodeJS.ReadableStream;
  on(event: "exit", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** Wire a spawned bridge child process into a managed bridge client. */
export function manageBridgeChild(child: BridgeChildProcess): ManagedBridgeClient {
  const client = new AcpxBridgeClient(
    (line, onWriteError) => child.stdin.write(line, onWriteError),
  ) as ManagedBridgeClient;

  // Per Node stream semantics a failed stdin write is reported through the
  // write callback (which rejects the pending request) AND as an 'error' event
  // on the stream. Without a listener that event becomes an uncaught exception
  // that kills the daemon; bridge death itself is handled by the 'exit' handler.
  child.stdin.on("error", () => {});

  const output = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  output.on("line", (line) => {
    client.handleLine(line);
  });

  child.on("exit", () => {
    output.close();
    client.handleExit(new Error("bridge process exited before responding"));
  });
  child.on("error", (error: Error) => {
    client.handleExit(error);
  });

  client.waitUntilReady = async () => {
    await client.request("ping", {});
  };
  client.dispose = async () => {
    try {
      await client.request("shutdown", {});
    } finally {
      child.stdin.end();
      await terminateProcessTree(child.pid ?? 0, { detachedProcessGroup: false });
    }
  };

  return client;
}

function awaitable<TResult>(
  executor: (resolve: (value: TResult) => void, reject: (error: unknown) => void) => void,
): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    executor(resolve, reject);
  });
}
