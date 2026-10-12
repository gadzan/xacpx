import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import {
  ROUTER_CONFIG_PATH,
  type RouterAvailability,
  type RouterFailedCode,
} from "@ganglion/xacpx-relay-protocol";
import type { AppConfig, ConversationRouterConfig } from "../config/types";
import { resolveSpawnCommand } from "../process/spawn-command";
import { ConversationError } from "./conversation-error";
import {
  isRouterCapabilityRestricted,
  parseRoutingDecision,
  type ConversationRouter,
  type RouterCapabilityRestriction,
  type RoutingInput,
} from "./conversation-router-types";

const CAPABILITY_KEYS = [
  "toolsDisabled",
  "filesystemDisabled",
  "terminalDisabled",
  "permissionInteractionDisabled",
  "messagingDisabled",
  "orchestrationDisabled",
  "structuredOutputOnly",
] as const;

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_STDOUT_LIMIT = 64 * 1024;
const DECIDE_STDOUT_LIMIT = 256 * 1024;

export interface ProductionRouterResolution {
  availability: RouterAvailability;
  router?: ConversationRouter;
}

export interface ResolveProductionRouterInput {
  config: Pick<AppConfig, "conversations">;
  env: NodeJS.ProcessEnv;
  probeTimeoutMs?: number;
}

export function disabledRouterAvailability(): RouterAvailability {
  return {
    status: "disabled-by-config",
    configPath: ROUTER_CONFIG_PATH,
    reason: { code: "disabled", message: "Automatic collaboration is off." },
  };
}

export function unprovenRouterAvailability(): RouterAvailability {
  return {
    status: "unsupported",
    configPath: ROUTER_CONFIG_PATH,
    reason: {
      code: "restriction-unproven",
      message: "The router did not prove that tools, filesystem, terminal, permission interaction, messaging, and orchestration are disabled.",
    },
  };
}

function failedAvailability(code: RouterFailedCode, message: string): RouterAvailability {
  return { status: "failed", configPath: ROUTER_CONFIG_PATH, reason: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify a capability report. A report that names the seven flags and is
 * not fully restricted is unsupported. Anything else is an unreadable report.
 * The caller must already have exited the probe successfully.
 */
export function classifyCapabilityReport(raw: unknown):
  | { kind: "restricted"; restriction: RouterCapabilityRestriction }
  | { kind: "unproven" }
  | { kind: "malformed" } {
  if (!isRecord(raw)) return { kind: "malformed" };
  const keys = Object.keys(raw);
  if (keys.length !== CAPABILITY_KEYS.length || CAPABILITY_KEYS.some((key) => !keys.includes(key))) {
    return { kind: "malformed" };
  }
  if (CAPABILITY_KEYS.some((key) => typeof raw[key] !== "boolean")) return { kind: "malformed" };
  if (!CAPABILITY_KEYS.every((key) => raw[key] === true)) return { kind: "unproven" };
  const restriction = {
    toolsDisabled: true,
    filesystemDisabled: true,
    terminalDisabled: true,
    permissionInteractionDisabled: true,
    messagingDisabled: true,
    orchestrationDisabled: true,
    structuredOutputOnly: true,
  } satisfies RouterCapabilityRestriction;
  return isRouterCapabilityRestricted(restriction) ? { kind: "restricted", restriction } : { kind: "unproven" };
}

async function commandInstalled(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!command || command.includes("\0") || command.length > 4096) return false;
  const spec = resolveSpawnCommand(command, []);
  if (spec.command === process.execPath && spec.args[0]) {
    try {
      await access(spec.args[0], constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      await access(join(dir, command), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

function runCommand(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxStdout: number;
}): Promise<CommandResult> {
  if (input.signal?.aborted) {
    return Promise.reject(input.signal.reason instanceof Error ? input.signal.reason : new Error("router command aborted"));
  }
  const spec = resolveSpawnCommand(input.command, input.args);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    let timedOut = false;
    let abortError: Error | undefined;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const kill = () => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    };
    const timer = input.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      kill();
    }, input.timeoutMs);
    const onAbort = () => {
      abortError = input.signal?.reason instanceof Error ? input.signal.reason : new Error("router command aborted");
      kill();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > input.maxStdout) {
        kill();
        fail(new Error("router command output exceeded its limit"));
      }
    });
    child.on("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      fail(error);
    });
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if (abortError) fail(abortError);
      else finish({ code, stdout, timedOut });
    });
    if (input.stdin !== undefined) child.stdin.end(input.stdin);
    else child.stdin.end();
  });
}

function routerFor(command: string, env: NodeJS.ProcessEnv, restriction: RouterCapabilityRestriction): ConversationRouter {
  return {
    capabilityRestriction: restriction,
    async decide(input: RoutingInput, options?: { signal: AbortSignal }) {
      const result = await runCommand({
        command,
        args: ["--decide"],
        env,
        stdin: JSON.stringify(input),
        signal: options?.signal,
        maxStdout: DECIDE_STDOUT_LIMIT,
      });
      if (result.code !== 0) {
        throw new ConversationError("router-execution-failed", "Router decision process failed");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new ConversationError("router-execution-failed", "Router decision was not JSON");
      }
      return parseRoutingDecision(parsed);
    },
  };
}

async function resolveEnabled(
  router: ConversationRouterConfig,
  env: NodeJS.ProcessEnv,
  probeTimeoutMs: number,
): Promise<ProductionRouterResolution> {
  if (!router.command) {
    return { availability: failedAvailability("command-missing", "conversations.router.command is missing.") };
  }
  if (!(await commandInstalled(router.command, env))) {
    return { availability: failedAvailability("command-missing", "conversations.router.command is not installed.") };
  }
  if (router.authEnv) {
    const secret = env[router.authEnv];
    if (typeof secret !== "string" || secret.trim() === "") {
      return { availability: failedAvailability("auth-missing", `Environment variable ${router.authEnv} is empty.`) };
    }
  }
  // The probe is the proof. It exits before any decision process starts.
  // A later instruction prompt cannot establish this limit.
  let probed: CommandResult;
  try {
    probed = await runCommand({
      command: router.command,
      args: ["--capabilities"],
      env,
      timeoutMs: probeTimeoutMs,
      maxStdout: PROBE_STDOUT_LIMIT,
    });
  } catch {
    return { availability: failedAvailability("probe-failed", "The router capability probe failed.") };
  }
  if (probed.timedOut) {
    return { availability: failedAvailability("probe-timeout", "The router capability probe timed out.") };
  }
  if (probed.code !== 0) {
    return { availability: failedAvailability("probe-failed", "The router capability probe failed.") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(probed.stdout);
  } catch {
    return { availability: failedAvailability("malformed-capabilities", "The router capability probe did not return JSON.") };
  }
  const report = classifyCapabilityReport(parsed);
  if (report.kind === "malformed") {
    return { availability: failedAvailability("malformed-capabilities", "The router capability probe returned an unreadable report.") };
  }
  if (report.kind === "unproven") return { availability: unprovenRouterAvailability() };
  return {
    availability: { status: "ready", configPath: ROUTER_CONFIG_PATH },
    router: routerFor(router.command, env, report.restriction),
  };
}

/** Read production config and probe before any decision process exists. */
export async function resolveProductionRouter(input: ResolveProductionRouterInput): Promise<ProductionRouterResolution> {
  const router = input.config.conversations?.router;
  if (!router || router.enabled !== true) {
    return { availability: disabledRouterAvailability() };
  }
  try {
    return await resolveEnabled(router, input.env, input.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
  } catch {
    return { availability: failedAvailability("probe-failed", "The router check failed before initialization.") };
  }
}
