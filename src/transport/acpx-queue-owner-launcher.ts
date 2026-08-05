import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { NonInteractivePermissions, PermissionMode } from "../config/types";
import { resolveSpawnCommand } from "../process/spawn-command";
import { terminateProcessTree } from "../process/terminate-process-tree";
import { quoteIfNeeded } from "../util/text.js";
import { getLocale } from "../i18n";
import { coreEnv } from "../runtime/core-env";
import { classifyPreinstalledAdapterCommandShape } from "../adapters/adapter-catalog";
import { probeWindowsProcessIdentity, type BatchTarget } from "../process/windows-process-tree";

export interface AcpxMcpServerSpec {
  name: string;
  type: "stdio";
  command: string;
  args: string[];
}

export interface QueueOwnerPayload {
  sessionId: string;
  /** Command selected by the durable adapter transaction for this owner. */
  agentCommand?: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions: NonInteractivePermissions;
  ttlMs: number;
  maxQueueDepth: number;
  promptRetries?: number;
  sessionOptions?: {
    model?: string;
    allowedTools?: string[];
    maxTurns?: number;
    systemPrompt?: string | { append: string };
  };
  mcpServers: AcpxMcpServerSpec[];
}

export type QueueOwnerSpawner = (
  command: string,
  args: string[],
  options: { env: Record<string, string> },
) => Promise<number>;

export type QueueOwnerTerminator = (sessionId: string) => Promise<void>;

export interface AcpxQueueOwnerLauncherOptions {
  acpxCommand: string;
  xacpxCommand?: string;
  spawnOwner?: QueueOwnerSpawner;
  terminateOwner?: QueueOwnerTerminator;
  baseEnv?: NodeJS.ProcessEnv;
  ttlMs?: number;
  maxQueueDepth?: number;
  readOwnerPid?: (sessionId: string) => Promise<number | undefined>;
  probeSpawnedProcess?: (pid: number) => Promise<"alive" | "exited" | "unknown">;
  handshakeTimeoutMs?: number;
  handshakePollMs?: number;
  uuid?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export interface QueueOwnerAdapterContext {
  id: "codex" | "claude";
  sessionKey: string;
  agentCommand: string;
  platform: NodeJS.Platform;
  prepare(intentToken: string): Promise<{ agentCommand: string; generationId?: string }>;
  isGenerationCurrent(generationId: string): Promise<boolean>;
  spawned(intentToken: string): Promise<void>;
  cancel(intentToken: string): Promise<void>;
  settle(input: {
    intentToken: string;
    outcome: "owner-committed" | "launch-failed";
    ownerPid?: number;
    ownerAcpxRecordId?: string;
  }): Promise<void>;
}

export interface LaunchQueueOwnerInput {
  acpxRecordId: string;
  coordinatorSession: string;
  sourceHandle?: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions: NonInteractivePermissions;
  /** Session options forwarded to the warm queue owner (e.g. the resolved model id). */
  sessionOptions?: QueueOwnerPayload["sessionOptions"];
  /** Per-agent environment inherited by the queue owner and its ACP adapter. */
  env?: NodeJS.ProcessEnv;
  /** Required whenever agentCommand has the managed preinstall shape. */
  agentCommand?: string;
  adapterContext?: QueueOwnerAdapterContext;
}

export function buildXacpxMcpServerSpec(input: {
  xacpxCommand: string;
  coordinatorSession: string;
  sourceHandle?: string;
}): AcpxMcpServerSpec {
  const { command, args } = splitCommandLine(input.xacpxCommand);
  return {
    name: "xacpx",
    type: "stdio",
    command,
    args: [
      ...args,
      "mcp-stdio",
      "--coordinator-session",
      input.coordinatorSession,
      ...(input.sourceHandle
        ? ["--source-handle", input.sourceHandle]
        : ["--internal-session-tools"]),
    ],
  };
}

export function buildQueueOwnerPayload(input: {
  sessionId: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions: NonInteractivePermissions;
  mcpServers: AcpxMcpServerSpec[];
  ttlMs?: number;
  maxQueueDepth?: number;
  promptRetries?: number;
  sessionOptions?: QueueOwnerPayload["sessionOptions"];
}): QueueOwnerPayload {
  return {
    sessionId: input.sessionId,
    permissionMode: input.permissionMode,
    nonInteractivePermissions: input.nonInteractivePermissions,
    ttlMs: input.ttlMs ?? 300_000,
    maxQueueDepth: input.maxQueueDepth ?? 16,
    ...(Number.isFinite(input.promptRetries) ? { promptRetries: input.promptRetries } : {}),
    ...(input.sessionOptions ? { sessionOptions: input.sessionOptions } : {}),
    mcpServers: input.mcpServers,
  };
}

export class AcpxQueueOwnerLauncher {
  private readonly acpxCommand: string;
  private readonly xacpxCommand: string;
  private readonly spawnOwner: QueueOwnerSpawner;
  private readonly terminateOwner: QueueOwnerTerminator;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly ttlMs?: number;
  private readonly maxQueueDepth?: number;
  private readonly readOwnerPid: (sessionId: string) => Promise<number | undefined>;
  private readonly probeSpawnedProcess: (pid: number) => Promise<"alive" | "exited" | "unknown">;
  private readonly handshakeTimeoutMs: number;
  private readonly handshakePollMs: number;
  private readonly uuid: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Per-session mutex: serializes terminate+spawn to prevent concurrent clobbering. */
  private readonly launchLocks = new Map<string, Promise<{ agentCommand?: string }>>();

  constructor(options: AcpxQueueOwnerLauncherOptions) {
    this.acpxCommand = options.acpxCommand;
    this.xacpxCommand = options.xacpxCommand ?? resolveDefaultXacpxCommand(options.baseEnv ?? process.env);
    this.spawnOwner = options.spawnOwner ?? defaultQueueOwnerSpawner;
    this.terminateOwner = options.terminateOwner ?? createDefaultQueueOwnerTerminator(options.acpxCommand);
    this.baseEnv = options.baseEnv ?? process.env;
    this.ttlMs = options.ttlMs;
    this.maxQueueDepth = options.maxQueueDepth;
    this.readOwnerPid = options.readOwnerPid ?? readQueueOwnerPid;
    this.probeSpawnedProcess = options.probeSpawnedProcess ?? defaultProbeSpawnedProcess;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.handshakePollMs = options.handshakePollMs ?? 50;
    this.uuid = options.uuid ?? randomUUID;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async launch(input: LaunchQueueOwnerInput): Promise<{ agentCommand?: string }> {
    const key = input.acpxRecordId;
    const previous = this.launchLocks.get(key) ?? Promise.resolve();
    const next = previous.then(
      () => this.doLaunch(input),
      () => this.doLaunch(input),
    );
    // Store a swallowed version so the chain never rejects for the next waiter.
    const tracked = next.catch(() => ({ agentCommand: undefined }));
    this.launchLocks.set(key, tracked);
    void tracked.finally(() => {
      if (this.launchLocks.get(key) === tracked) {
        this.launchLocks.delete(key);
      }
    });
    return next;
  }

  private async doLaunch(input: LaunchQueueOwnerInput): Promise<{ agentCommand?: string }> {
    await this.terminateOwner(input.acpxRecordId);

    const managedShape = classifyPreinstalledAdapterCommandShape(input.agentCommand);
    if (managedShape && !input.adapterContext) {
      throw new Error("managed preinstalled adapter launch is missing adapterContext");
    }
    if (input.adapterContext && input.adapterContext.id !== managedShape) {
      throw new Error("adapterContext does not match the managed command shape");
    }
    const adapter = input.adapterContext;
    const intentToken = adapter ? this.uuid() : undefined;
    let preparedGeneration: string | undefined;
    let launchAgentCommand = input.agentCommand;
    if (adapter && intentToken) {
      let prepared: { agentCommand: string; generationId?: string };
      try {
        prepared = await adapter.prepare(intentToken);
      } catch (error) {
        if (adapter.platform === "win32") await adapter.cancel(intentToken).catch(() => {});
        throw error;
      }
      launchAgentCommand = prepared.agentCommand;
      // Keep the adapter context aligned with the durable command selected for
      // this transaction. Callers use the returned value to build the current
      // prompt/launch, rather than only updating state for a future request.
      adapter.agentCommand = prepared.agentCommand;
      preparedGeneration = prepared.generationId;
      if (adapter.platform === "win32") {
        if (!preparedGeneration || !(await adapter.isGenerationCurrent(preparedGeneration))) {
          await adapter.cancel(intentToken);
          throw new Error("adapter launch generation changed before spawn");
        }
      }
    }

    const payload = buildQueueOwnerPayload({
      sessionId: input.acpxRecordId,
      ...(launchAgentCommand ? { agentCommand: launchAgentCommand } : {}),
      permissionMode: input.permissionMode,
      nonInteractivePermissions: input.nonInteractivePermissions,
      ttlMs: this.ttlMs,
      maxQueueDepth: this.maxQueueDepth,
      ...(input.sessionOptions ? { sessionOptions: input.sessionOptions } : {}),
      mcpServers: [buildXacpxMcpServerSpec({
        xacpxCommand: this.xacpxCommand,
        coordinatorSession: input.coordinatorSession,
        ...(input.sourceHandle ? { sourceHandle: input.sourceHandle } : {}),
      })],
    });
    const spawnSpec = resolveSpawnCommand(this.acpxCommand, [
      "__queue-owner",
      ...(intentToken && adapter?.platform === "win32" ? ["--xacpx-owner-token", intentToken] : []),
    ]);
    const childEnv = input.env ?? this.baseEnv;
    let spawnedPid: number | undefined;
    try {
      spawnedPid = await this.spawnOwner(spawnSpec.command, spawnSpec.args, {
        env: {
          ...stringEnv(childEnv),
          XACPX_LANG: getLocale(),
          ACPX_QUEUE_OWNER_PAYLOAD: JSON.stringify(payload),
        },
      });
    } catch (error) {
      if (adapter && intentToken && adapter.platform === "win32") await adapter.cancel(intentToken);
      throw error;
    }
    if (!adapter || !intentToken || adapter.platform !== "win32") return { agentCommand: launchAgentCommand };

    await adapter.spawned(intentToken);
    const ownerPid = await this.waitForOwnerPid(input.acpxRecordId);
    if (ownerPid !== undefined) {
      await adapter.settle({
        intentToken,
        outcome: "owner-committed",
        ownerPid,
        ownerAcpxRecordId: input.acpxRecordId,
      });
      return { agentCommand: launchAgentCommand };
    }
    const status = await this.probeSpawnedProcess(spawnedPid);
    if (status === "exited") {
      await adapter.settle({ intentToken, outcome: "launch-failed" });
    }
    throw new Error(status === "alive"
      ? `queue owner ${spawnedPid} did not become ready before timeout`
      : status === "exited"
        ? `queue owner ${spawnedPid} exited before becoming ready`
        : `queue owner ${spawnedPid} readiness could not be determined`);
  }

  private async waitForOwnerPid(sessionId: string): Promise<number | undefined> {
    const deadline = Date.now() + this.handshakeTimeoutMs;
    do {
      const pid = await this.readOwnerPid(sessionId);
      if (pid !== undefined) return pid;
      if (Date.now() >= deadline) return undefined;
      await this.sleep(Math.min(this.handshakePollMs, Math.max(0, deadline - Date.now())));
    } while (true);
  }
}

function splitCommandLine(value: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("xacpx MCP command has an unterminated quote");
  }
  if (current.length > 0) {
    parts.push(current);
  }
  if (parts.length === 0) {
    throw new Error("xacpx MCP command must not be empty");
  }
  return { command: parts[0]!, args: parts.slice(1) };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function defaultQueueOwnerSpawner(
  command: string,
  args: string[],
  options: { env: Record<string, string> },
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      env: options.env,
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      const pid = child.pid;
      if (!pid) {
        reject(new Error("queue owner spawned without a process id"));
        return;
      }
      child.unref();
      resolve(pid);
    });
  });
}

async function defaultProbeSpawnedProcess(pid: number): Promise<"alive" | "exited" | "unknown"> {
  if (process.platform === "win32") {
    const probe = await probeWindowsProcessIdentity(pid);
    if (probe.status === "found") return "alive";
    if (probe.status === "missing") return "exited";
    return "unknown";
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "exited" : "unknown";
  }
}

function createDefaultQueueOwnerTerminator(_acpxCommand: string): QueueOwnerTerminator {
  return async (sessionId) => {
    await terminateAcpxQueueOwner(sessionId);
  };
}

export async function readQueueOwnerPid(sessionId: string): Promise<number | undefined> {
  let owner: { pid?: unknown } | undefined;
  try {
    owner = JSON.parse(await readFile(queueLockFilePath(sessionId), "utf8")) as { pid?: unknown };
  } catch {
    return undefined;
  }
  if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
    return owner.pid;
  }
  return undefined;
}

export async function terminateAcpxQueueOwner(sessionId: string): Promise<void> {
  const lockPath = queueLockFilePath(sessionId);
  let owner: { pid?: unknown } | undefined;
  try {
    owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
  } catch {
    return;
  }
  if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
    if (process.platform === "win32") {
      const identity = await probeWindowsProcessIdentity(owner.pid);
      if (identity.status !== "found") return;
      const target: BatchTarget = {
        pid: owner.pid,
        creationDate: identity.identity.creationDate,
        executablePath: identity.identity.executablePath,
      };
      const result = await terminateProcessTree(target, { detachedProcessGroup: true });
      if (!result || !["killed", "already-exited", "skipped-replaced"].includes(result.rootOutcome)) return;
    } else {
      await terminateProcessTree(owner.pid, { detachedProcessGroup: true });
    }
  }
  await unlink(lockPath).catch(() => {});
}

function queueLockFilePath(sessionId: string): string {
  return join(homedir(), ".acpx", "queues", `${shortHash(sessionId, 24)}.lock`);
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function resolveDefaultXacpxCommand(env: NodeJS.ProcessEnv): string {
  const cliCommand = coreEnv("CLI_COMMAND", env);
  if (cliCommand?.trim()) {
    return cliCommand.trim();
  }
  const daemonArg0 = coreEnv("DAEMON_ARG0", env);
  if (daemonArg0?.trim()) {
    return `${quoteCommandPart(process.execPath)} ${quoteCommandPart(daemonArg0.trim())}`;
  }
  if (process.argv[1]) {
    return `${quoteCommandPart(process.execPath)} ${quoteCommandPart(process.argv[1])}`;
  }
  return "xacpx";
}

function quoteCommandPart(value: string): string {
  return quoteIfNeeded(value);
}
