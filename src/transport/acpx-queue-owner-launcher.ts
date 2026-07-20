import { createHash } from "node:crypto";
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

export interface AcpxMcpServerSpec {
  name: string;
  type: "stdio";
  command: string;
  args: string[];
}

export interface QueueOwnerPayload {
  sessionId: string;
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
) => Promise<void>;

export type QueueOwnerTerminator = (sessionId: string) => Promise<void>;

export interface AcpxQueueOwnerLauncherOptions {
  acpxCommand: string;
  xacpxCommand?: string;
  spawnOwner?: QueueOwnerSpawner;
  terminateOwner?: QueueOwnerTerminator;
  baseEnv?: NodeJS.ProcessEnv;
  ttlMs?: number;
  maxQueueDepth?: number;
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
  /** Per-session mutex: serializes terminate+spawn to prevent concurrent clobbering. */
  private readonly launchLocks = new Map<string, Promise<void>>();

  constructor(options: AcpxQueueOwnerLauncherOptions) {
    this.acpxCommand = options.acpxCommand;
    this.xacpxCommand = options.xacpxCommand ?? resolveDefaultXacpxCommand(options.baseEnv ?? process.env);
    this.spawnOwner = options.spawnOwner ?? defaultQueueOwnerSpawner;
    this.terminateOwner = options.terminateOwner ?? createDefaultQueueOwnerTerminator(options.acpxCommand);
    this.baseEnv = options.baseEnv ?? process.env;
    this.ttlMs = options.ttlMs;
    this.maxQueueDepth = options.maxQueueDepth;
  }

  async launch(input: LaunchQueueOwnerInput): Promise<void> {
    const key = input.acpxRecordId;
    const previous = this.launchLocks.get(key) ?? Promise.resolve();
    const next = previous.then(
      () => this.doLaunch(input),
      () => this.doLaunch(input),
    );
    // Store a swallowed version so the chain never rejects for the next waiter.
    const tracked = next.catch(() => {});
    this.launchLocks.set(key, tracked);
    void tracked.finally(() => {
      if (this.launchLocks.get(key) === tracked) {
        this.launchLocks.delete(key);
      }
    });
    return next;
  }

  private async doLaunch(input: LaunchQueueOwnerInput): Promise<void> {
    await this.terminateOwner(input.acpxRecordId);

    const payload = buildQueueOwnerPayload({
      sessionId: input.acpxRecordId,
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
    const spawnSpec = resolveSpawnCommand(this.acpxCommand, ["__queue-owner"]);
    await this.spawnOwner(spawnSpec.command, spawnSpec.args, {
      env: {
        ...stringEnv(this.baseEnv),
        ...stringEnv(input.env ?? {}),
        XACPX_LANG: getLocale(),
        ACPX_QUEUE_OWNER_PAYLOAD: JSON.stringify(payload),
      },
    });
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
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      env: options.env,
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function createDefaultQueueOwnerTerminator(_acpxCommand: string): QueueOwnerTerminator {
  return async (sessionId) => {
    await terminateAcpxQueueOwner(sessionId);
  };
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
    await terminateProcessTree(owner.pid, { detachedProcessGroup: true });
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
