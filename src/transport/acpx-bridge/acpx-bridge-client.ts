import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import {
  type BridgeMethod,
  type BridgeMessage,
  type BridgeOriginatedCancel,
  type BridgeOriginatedMethod,
  type BridgeOriginatedRequest,
  type BridgeOriginatedResponse,
  type BridgeResponse,
  type EnsureSessionProgressStage,
  encodeBridgeRequest,
  encodeBridgeOriginatedMessage,
  decodeBridgeOriginatedRequest,
} from "./acpx-bridge-protocol";
import { PromptCommandError } from "../prompt-output";
import { MissingOptionalDepError } from "../../recovery/errors";
import { terminateProcessTree } from "../../process/terminate-process-tree";
import type { PlanEntry, ToolUseEvent } from "../../channels/types.js";
import type { AgentCommand, UsageBreakdown, UsageCost } from "../types";
import { getLocale } from "../../i18n";
import { resolveDefaultXacpxCommand } from "../acpx-queue-owner-launcher";
import type { AcpxAgentOverlayEntry } from "../acpx-agent-overlay";
import {
  BRIDGE_REQUEST_TIMEOUT_GRACE_MS,
  CommandTimeoutError,
  DEFAULT_MANAGEMENT_COMMAND_TIMEOUT_MS,
  DEFAULT_SESSION_INIT_TIMEOUT_MS,
} from "../command-timeouts";
import {
  isMessageInjectionErrorCode,
  MessageInjectionError,
} from "../message-injection";

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

export interface AcpxBridgeClientOptions {
  /**
   * Session-init budget the bridge subprocess runs with (XACPX_BRIDGE_SESSION_INIT_TIMEOUT_MS);
   * used to derive the client-side timeout for ensure/resume/list requests.
   */
  sessionInitTimeoutMs?: number;
  /**
   * Called when the bridge emits a stdout line that is not valid JSON. Such a
   * line is dropped — if it was a response, its request would hang without the
   * per-request timeout — so at minimum it must be observable in logs.
   */
  onMalformedLine?: (line: string) => void;
  /** Test seams for the per-request timeout timer. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (timer: unknown) => void;
  onBridgeRequest?: (
    method: BridgeOriginatedMethod,
    params: Record<string, unknown>,
    context: { signal: AbortSignal; rpcId: string; launcherPid?: number },
  ) => Promise<unknown>;
  bridgeProcessPid?: number;
  onBridgeDisconnect?: (error: Error) => void;
}

/**
 * Client-side backstop timeout per bridge request. Each value sits
 * BRIDGE_REQUEST_TIMEOUT_GRACE_MS above the subprocess-side bound for that
 * method, so the subprocess timeout (better error, kills the hung process
 * tree) fires first and this only catches lost or undecodable responses.
 * `prompt` is unbounded: long streaming agent turns are legitimate.
 */
export function bridgeRequestTimeoutMs(
  method: BridgeMethod,
  sessionInitTimeoutMs: number = DEFAULT_SESSION_INIT_TIMEOUT_MS,
): number | undefined {
  switch (method) {
    case "prompt":
      return undefined;
    case "ensureSession":
    case "resumeAgentSession":
      return sessionInitTimeoutMs + BRIDGE_REQUEST_TIMEOUT_GRACE_MS;
    case "listAgentSessions":
      // The subprocess may run the list twice (--filter-cwd capability
      // fallback), each run bounded by sessionInitTimeoutMs like acpx-cli.
      return 2 * sessionInitTimeoutMs + BRIDGE_REQUEST_TIMEOUT_GRACE_MS;
    case "deleteSession":
    case "freeWarmProcess":
    case "setSessionEffort":
      // Two sequential management commands (sessions show + close/owner kill).
      return 2 * DEFAULT_MANAGEMENT_COMMAND_TIMEOUT_MS + BRIDGE_REQUEST_TIMEOUT_GRACE_MS;
    default:
      return DEFAULT_MANAGEMENT_COMMAND_TIMEOUT_MS + BRIDGE_REQUEST_TIMEOUT_GRACE_MS;
  }
}

const defaultSetTimeoutFn = (fn: () => void, ms: number): unknown => {
  const timer = setTimeout(fn, ms);
  // Never keep the host process alive just for a request-timeout backstop.
  (timer as NodeJS.Timeout).unref?.();
  return timer;
};

export class AcpxBridgeClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private terminalError: Error | null = null;
  private readonly activeBridgeRequests = new Map<string, AbortController>();
  private readonly completedBridgeResponses = new Map<string, string>();

  constructor(
    private readonly writeLine: WriteLine,
    private readonly options: AcpxBridgeClientOptions = {},
  ) {}

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
      const setTimeoutFn = this.options.setTimeoutFn ?? defaultSetTimeoutFn;
      const clearTimeoutFn = this.options.clearTimeoutFn ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
      let timer: unknown;
      const clearTimer = () => {
        if (timer !== undefined) {
          clearTimeoutFn(timer);
          timer = undefined;
        }
      };
      this.pending.set(id, {
        resolve: (value) => {
          clearTimer();
          resolve(value as TResult);
        },
        reject: (error) => {
          clearTimer();
          reject(error);
        },
        onEvent,
      });

      // Backstop: a bridge response that never arrives (subprocess wedged in a
      // way its own timeouts don't cover, or the response line was dropped as
      // malformed) must not hang this session's serial request lane forever.
      const timeoutMs = bridgeRequestTimeoutMs(method, this.options.sessionInitTimeoutMs);
      if (timeoutMs !== undefined) {
        timer = setTimeoutFn(() => {
          if (this.pending.delete(id)) {
            reject(method === "setModel"
              ? new CommandTimeoutError(timeoutMs, `bridge request "${method}"`, { stage: "set-model" })
              : new Error(`bridge request "${method}" timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }

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
              clearTimer();
              reject(error);
            }
          },
        );
      } catch (error) {
        this.pending.delete(id);
        clearTimer();
        reject(error);
      }
    });
  }

  handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      // Dropped line: if it carried a response, the per-request timeout is the
      // safety net that eventually unblocks the caller — but log it so a
      // protocol corruption is diagnosable instead of silent.
      this.options.onMalformedLine?.(line);
      return;
    }

    if (isBridgeOriginatedRequest(parsed)) {
      this.handleBridgeOriginatedRequest(parsed);
      return;
    }
    if (isBridgeOriginatedCancel(parsed)) {
      this.activeBridgeRequests.get(parsed.cancelRpcId)?.abort();
      return;
    }
    if (isMalformedBridgeOriginatedRequest(parsed)) {
      const item = parsed as Record<string, unknown>;
      this.writeLine(encodeBridgeOriginatedMessage({
        direction: "daemon-to-bridge",
        rpcId: String(item.rpcId),
        ok: false,
        error: { code: "BRIDGE_RPC_INVALID", message: "invalid bridge-originated request" },
      }));
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { id?: unknown }).id !== "string") {
      this.options.onMalformedLine?.(line);
      return;
    }
    const message = parsed as BridgeMessage;

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

    if (response.error.timeout) {
      pending.reject(new CommandTimeoutError(
        response.error.timeout.timeoutMs,
        response.error.timeout.command,
        {
          stage: response.error.timeout.stage,
          stdout: response.error.timeout.stdoutTail,
          stderr: response.error.timeout.stderrTail,
        },
      ));
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

    if (isMessageInjectionErrorCode(response.error.code)) {
      pending.reject(new MessageInjectionError(response.error.code, response.error.message));
      return;
    }

    const bridgeError = new Error(response.error.message) as Error & { code?: string };
    bridgeError.code = response.error.code;
    pending.reject(bridgeError);
  }

  handleExit(error: Error): void {
    this.terminalError = error;
    const pendingRequests = [...this.pending.values()];
    this.pending.clear();

    for (const pending of pendingRequests) {
      pending.reject(error);
    }
    for (const controller of this.activeBridgeRequests.values()) controller.abort(error);
    this.activeBridgeRequests.clear();
    this.completedBridgeResponses.clear();
    this.options.onBridgeDisconnect?.(error);
  }

  private handleBridgeOriginatedRequest(request: BridgeOriginatedRequest): void {
    const completed = this.completedBridgeResponses.get(request.rpcId);
    if (completed) {
      this.writeLine(completed);
      return;
    }
    if (this.activeBridgeRequests.has(request.rpcId)) return;
    const controller = new AbortController();
    this.activeBridgeRequests.set(request.rpcId, controller);
    void (async () => {
      let response: BridgeOriginatedResponse;
      try {
        if (!this.options.onBridgeRequest) throw new Error(`unsupported bridge-originated method: ${request.method}`);
        const result = await this.options.onBridgeRequest(request.method, request.params, {
          signal: controller.signal,
          rpcId: request.rpcId,
          ...(this.options.bridgeProcessPid ? { launcherPid: this.options.bridgeProcessPid } : {}),
        });
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error("bridge RPC canceled");
        response = { direction: "daemon-to-bridge", rpcId: request.rpcId, ok: true, result };
      } catch (error) {
        response = {
          direction: "daemon-to-bridge",
          rpcId: request.rpcId,
          ok: false,
          error: {
            code: controller.signal.aborted ? "BRIDGE_RPC_CANCELED" : "BRIDGE_RPC_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      } finally {
        this.activeBridgeRequests.delete(request.rpcId);
      }
      if (this.terminalError) return;
      const encoded = encodeBridgeOriginatedMessage(response);
      this.completedBridgeResponses.set(request.rpcId, encoded);
      // Bound replay memory for a long-lived bridge connection.
      if (this.completedBridgeResponses.size > 256) {
        this.completedBridgeResponses.delete(this.completedBridgeResponses.keys().next().value!);
      }
      try { this.writeLine(encoded); }
      catch { /* child stream failure is handled by handleExit */ }
    })();
  }
}

function isBridgeOriginatedRequest(value: unknown): value is BridgeOriginatedRequest {
  return decodeBridgeOriginatedRequest(value) !== null;
}

function isBridgeOriginatedCancel(value: unknown): value is BridgeOriginatedCancel {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.direction === "bridge-to-daemon" && typeof item.cancelRpcId === "string" && item.cancelRpcId.length > 0;
}

function isMalformedBridgeOriginatedRequest(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.direction === "bridge-to-daemon" && typeof item.rpcId === "string" && "method" in item;
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
  generationFilePath?: string;
  /** Overlay entries the bridge re-provisions into ~/.acpx/config.json at startup. */
  agentOverlays?: AcpxAgentOverlayEntry[];
  /** Forwarded to AcpxBridgeClient: observability for undecodable bridge output lines. */
  onMalformedLine?: (line: string) => void;
  onBridgeRequest?: AcpxBridgeClientOptions["onBridgeRequest"];
  onBridgeDisconnect?: AcpxBridgeClientOptions["onBridgeDisconnect"];
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
    ...(options.generationFilePath ? { XACPX_BRIDGE_GENERATION_FILE: options.generationFilePath } : {}),
    ...(options.agentOverlays && options.agentOverlays.length > 0
      ? { XACPX_BRIDGE_AGENT_OVERLAYS: JSON.stringify(options.agentOverlays) }
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

  const client = manageBridgeChild(child, {
    ...(typeof options.sessionInitTimeoutMs === "number"
      && Number.isFinite(options.sessionInitTimeoutMs)
      && options.sessionInitTimeoutMs > 0
      ? { sessionInitTimeoutMs: options.sessionInitTimeoutMs }
      : {}),
    ...(options.onMalformedLine ? { onMalformedLine: options.onMalformedLine } : {}),
    ...(options.onBridgeRequest ? { onBridgeRequest: options.onBridgeRequest } : {}),
    ...(options.onBridgeDisconnect ? { onBridgeDisconnect: options.onBridgeDisconnect } : {}),
  });
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
export function manageBridgeChild(
  child: BridgeChildProcess,
  options: AcpxBridgeClientOptions = {},
): ManagedBridgeClient {
  const client = new AcpxBridgeClient(
    (line, onWriteError) => child.stdin.write(line, onWriteError),
    { ...options, ...(child.pid ? { bridgeProcessPid: child.pid } : {}) },
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
