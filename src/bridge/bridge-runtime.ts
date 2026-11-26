import { copyFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { spawn } from "node:child_process";

import type { NonInteractivePermissions, PermissionMode, WechatReplyMode } from "../config/types";
import {
  resolveClaudeSpawnEnvironment,
  type ClaudeExecutionSettings,
  type ClaudeSettingsPolicy,
} from "../adapters/claude-settings-policy";
import { resolveSpawnCommand } from "../process/spawn-command";
import {
  defaultAcpxRunner,
  shellSessionCreateRunner,
  spawnCapture,
  type AcpxSpawnOptions,
  type AcpxSpawnResult,
} from "../transport/acpx-spawn";
import { getPromptText, normalizeCommandError } from "../transport/prompt-output";
import type { AgentCommand, UsageBreakdown, UsageCost } from "../transport/types";
import { createStructuredPromptFile } from "../transport/prompt-media";
import { runStreamingPromptFlow } from "../transport/acpx-streaming-prompt";
import { parseMissingOptionalDep } from "./parse-missing-optional-dep";
import { isModelNotAdvertisedError } from "../transport/model-not-advertised";
import { deriveParentPackageName } from "../recovery/discover-parent-package-paths";
import { AcpxQueueOwnerLauncher, terminateAcpxQueueOwnerVerified, type LaunchQueueOwnerInput, type QueueOwnerAdapterContext } from "../transport/acpx-queue-owner-launcher";
import { AcpxQueueOverflowError, isAcpxQueueMessageOverflow, type AcpxQueueCleanupResult } from "../transport/acpx-queue-overflow";
import { queueOwnerBaseEnvOption, resolveAcpxHostPolicyEnv, resolveEffectiveAcpxEnv } from "../transport/acpx-host-policy";
import { classifyPreinstalledAdapterCommandShape } from "../adapters/adapter-catalog";
import { migrateSessionArgvFile } from "../transport/acpx-session-argv-migration";
import { renderAgentArgvIdentity } from "../config/agent-launch";
import { ACPX_MODEL_INSPECT_TIMEOUT_MS, probeAgentCapabilitiesViaInspector, type AcpxModelInspectFn } from "../transport/acpx-model-inspector";
import type { AgentCommandRegistry } from "../config/agent-catalog";
import {
  CommandTimeoutError,
  DEFAULT_MANAGEMENT_COMMAND_TIMEOUT_MS,
  DEFAULT_SESSION_INIT_TIMEOUT_MS,
  type AcpxCommandStage,
} from "../transport/command-timeouts";
export { CommandTimeoutError } from "../transport/command-timeouts";
import type {
  EnsureSessionProgress,
  MissingOptionalDepErrorData,
} from "../transport/acpx-bridge/acpx-bridge-protocol";
import type { AgentCapabilityProbeRequest, AgentCapabilityProbeResult, AgentSessionListResult, PromptMediaInput, SessionEffortState } from "../transport/types";
import type { ToolEventMode } from "../transport/tool-event-mode.js";
import type { PlanEntry, ToolUseEvent } from "../channels/types.js";
import {
  buildSessionArgs as sharedBuildSessionArgs,
  buildPromptArgs as sharedBuildPromptArgs,
  buildQueueMessagePromptArgs as sharedBuildQueueMessagePromptArgs,
  isMissingAcpxSessionError,
  parseAcpxSessionRecordId,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_NON_INTERACTIVE,
} from "../transport/acpx-command-builder";
import { parseSessionEffortRecord, requireAdvertisedSessionEffort } from "../transport/session-effort";
import { runEnsureSessionFlow } from "../transport/acpx-ensure-session";
import {
  assertNoActiveNativeRestore,
  runSetModelWithNativeRestore,
  type NativeModelRestoreSession,
} from "../transport/native-model-restore";
import {
  buildQueueOwnerLaunchInput,
  cleanupOverflowedOwnerFlow,
  coolQueueOwnerWith,
  ensureMcpQueueOwnerLaunched,
  probeInspectTimeout,
  queueOwnerRefFromBridgeInput,
  syncPersistedSessionEffortFlow,
  willReplaceQueueOwner,
} from "../transport/acpx-session-ops";
import {
  runCancelSession,
  runDeleteSession,
  runFreeWarmProcess,
  runGetAgentSessionId,
  runGetSessionModel,
  runHasSession,
  runIsSessionWarm,
  runListAgentSessions,
  runRemoveSession,
  runResumeAgentSession,
  runSetSessionMode,
  runTailSessionHistory,
} from "../transport/acpx-session-commands";
import { runAcpxControlCommand } from "../transport/acpx-owner-control-retry";
import { MessageInjectionError } from "../transport/message-injection";

type BridgePromptStreamEvent =
  | { type: "prompt.segment"; text: string }
  | { type: "prompt.tool_event"; event: ToolUseEvent }
  | { type: "prompt.thought"; text: string }
  | { type: "prompt.plan"; entries: PlanEntry[] }
  | { type: "prompt.usage"; used: number; size: number; cost?: UsageCost; breakdown?: UsageBreakdown }
  | { type: "prompt.commands"; commands: AgentCommand[] };

export class EnsureSessionFailedError extends Error {
  readonly kind: "missing_optional_dep" | "generic";
  readonly data?: MissingOptionalDepErrorData;
  constructor(
    message: string,
    kind: "missing_optional_dep" | "generic",
    data?: MissingOptionalDepErrorData,
  ) {
    super(message);
    this.name = "EnsureSessionFailedError";
    this.kind = kind;
    this.data = data;
  }
}

// Unified spawn types (canonical definitions live in ../transport/acpx-spawn.ts).
type CommandResult = AcpxSpawnResult;
export type CommandRunnerOptions = AcpxSpawnOptions;
type CommandRunner = (command: string, args: string[], options?: CommandRunnerOptions) => Promise<CommandResult>;
type SessionCreateRunner = (command: string, args: string[], cwd: string, options?: CommandRunnerOptions) => Promise<CommandResult>;
export type { SpawnCaptureOptions } from "../transport/acpx-spawn";
export { spawnCapture };
type PromptRunner = typeof runStreamingPrompt;
type RepairSessionIndexFn = () => Promise<boolean>;

interface BridgeSessionInput {
  agent: string;
  driver?: string;
  settingsPolicy?: ClaudeSettingsPolicy;
  agentCommand?: string;
  acpxAgent?: string;
  rawCommand?: string;
  agentArgv?: string[];
  cwd: string;
  name: string;
  sessionKey?: string;
  model?: string;
  effort?: string;
  mcpCoordinatorSession?: string;
  mcpSourceHandle?: string;
  replyMode?: "stream" | "final" | "verbose";
  media?: PromptMediaInput;
  toolEvents?: boolean;
  toolEventMode?: ToolEventMode;
}

interface StreamingPromptRunnerOptions {
  spawnPrompt?: (command: string, args: string[]) => PromptStreamProcess;
  setIntervalFn?: (fn: () => void, delay: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
  maxSegmentWaitMs?: number;
  flushCheckIntervalMs?: number;
  now?: () => number;
  formatToolCalls?: boolean;
  toolEventMode?: ToolEventMode;
  driver?: string;
  rawStream?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface PromptStreamProcess {
  stdout: {
    setEncoding: (encoding: string) => void;
    on: (event: "data", handler: (chunk: string | Buffer) => void) => void;
  };
  stderr: {
    on: (event: "data", handler: (chunk: string | Buffer) => void) => void;
  };
  on: {
    (event: "error", handler: (error: Error) => void): void;
    (event: "close", handler: (code: number | null) => void): void;
  };
}

interface BridgeRuntimeOptions {
  permissionMode?: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissions;
  permissionPolicy?: string;
  /** Idle TTL (seconds) passed to acpx as `--ttl` on prompt; 0 = keep alive forever. */
  queueOwnerTtlSeconds?: number;
  /**
   * Advanced acpx host ceilings (plan B5, acpx 0.15.1+). `null`/absent follows
   * upstream defaults. Baked into the queue-owner HOST base env.
   */
  acpxMaxIncomingMessageBytes?: number | null;
  acpxTerminalMaxOutputBytes?: number | null;
  /** Time bound for session-creation spawns (ensure/new/resume); defaults to 120s like acpx-cli. */
  sessionInitTimeoutMs?: number;
  /**
   * Time bound for one-shot management commands (sessions show/close, cancel,
   * set-mode, set model/effort, status, history, list). A hung acpx here would
   * otherwise wedge the session's serial bridge lane forever. Defaults to 30s.
   */
  managementCommandTimeoutMs?: number;
  /** Test seam: clock used for the shared session-init deadline. */
  now?: () => number;
  /** Test seam for filtered per-agent process environments. */
  resolveSpawnEnvironment?: (input: ClaudeExecutionSettings) => NodeJS.ProcessEnv | undefined;
  createAdapterContext?: (input: {
    id: "codex" | "claude";
    sessionKey: string;
    agentCommand: string;
  }) => QueueOwnerAdapterContext;
  /** Test seam and fail-safe owner terminator for an oversized queue event. */
  terminateQueueOwner?: (acpxRecordId: string) => Promise<void>;
  /** Test seams for the omp native model-restore recovery path (mirrors the CLI lane). */
  ompModelRecovery?: { recoverOmpSessionModel: typeof import("../transport/omp-model-recovery").recoverOmpSessionModel };
  queueOwnerAbsence?: { assertAcpxQueueOwnerAbsent: typeof import("../transport/acpx-queue-owner-launcher").assertAcpxQueueOwnerAbsent };
  /** acpx registry for bare-driver probes; without it a bare driver is probe-unavailable. */
  loadAgentRegistry?: () => AgentCommandRegistry | null;
  /** Test seam for the model inspector (production calls acpx/runtime). */
  inspectAgentModels?: AcpxModelInspectFn;
}

type QueueOwnerLaunchPort = Pick<AcpxQueueOwnerLauncher, "launch"> & {
  wouldReuse?(input: LaunchQueueOwnerInput): Promise<boolean>;
  cool?(acpxRecordId: string): Promise<void>;
};

export class BridgeRuntime {
  // undefined = not yet probed; true/false = probed result.
  // Older acpx builds don't accept --verbose; we feature-detect lazily on first
  // ensure failure that looks like "unknown option", then disable verbose for
  // this runtime's lifetime. A restart re-probes.
  private readonly hostPolicyEnv: Record<string, string>;
  /** Gates env attachment so unset policy stays bit-identical (same as CLI lane). */
  private readonly hostPolicyConfigured: boolean;
  private acpxVerboseSupported: boolean | undefined = undefined;

  constructor(
    private readonly command: string = "acpx",
    private readonly run: CommandRunner = defaultRunner,
    private readonly runSessionCreate: SessionCreateRunner = shellSessionCreateRunner,
    private readonly options: BridgeRuntimeOptions = {},
    private readonly runPromptCommand: PromptRunner = defaultPromptRunner,
    private readonly repairSessionIndex: RepairSessionIndexFn = tryRepairAcpxSessionIndex,
    private readonly queueOwnerLauncher: QueueOwnerLaunchPort = new AcpxQueueOwnerLauncher({
      // Plan B5: host ceilings ride the queue-owner HOST base env.
      ...queueOwnerBaseEnvOption({
        acpxMaxIncomingMessageBytes: options.acpxMaxIncomingMessageBytes,
        acpxTerminalMaxOutputBytes: options.acpxTerminalMaxOutputBytes,
      }),
      acpxCommand: command,
      // Coordinator sessions pre-spawn the queue owner here (before `acpx prompt`),
      // so the owner's warm window must be set at launch — the prompt's `--ttl`
      // can't extend an already-running owner. Launcher ttl is milliseconds.
      ...(typeof options.queueOwnerTtlSeconds === "number" && Number.isFinite(options.queueOwnerTtlSeconds)
        ? { ttlMs: options.queueOwnerTtlSeconds * 1000 }
        : {}),
    }),
  ) {
    // Host ceilings ride every acpx child env on this lane (same as CLI):
    // agent env (or inheritance) with policy overlaid last.
    this.hostPolicyEnv = resolveAcpxHostPolicyEnv({
      acpxMaxIncomingMessageBytes: options.acpxMaxIncomingMessageBytes,
      acpxTerminalMaxOutputBytes: options.acpxTerminalMaxOutputBytes,
    });
    this.hostPolicyConfigured = Object.keys(this.hostPolicyEnv).length > 0;
  }

  async updatePermissionPolicy(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }): Promise<Record<string, never>> {
    this.options.permissionMode = policy.permissionMode;
    this.options.nonInteractivePermissions = policy.nonInteractivePermissions;
    this.options.permissionPolicy = policy.permissionPolicy;
    return {};
  }

  async listAgentSessions(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    cursor?: string;
    filterCwd?: string;
  }): Promise<AgentSessionListResult | undefined> {
    // Shell lives in ../transport/acpx-session-commands.ts; only argv/runner are lane-specific.
    return await runListAgentSessions({
      ...(input.filterCwd ? { filterCwd: input.filterCwd } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.driver ? { driver: input.driver } : {}),
      agent: input.agent,
      timeoutMs: this.sessionInitTimeoutMs(),
      buildListArgv: (includeFilterCwd) => this.buildSessionArgs(input, [
        "sessions",
        "list",
        ...(includeFilterCwd && input.filterCwd ? ["--filter-cwd", input.filterCwd] : []),
        ...(input.cursor ? ["--cursor", input.cursor] : []),
      ], { format: "json" }),
      execute: (argv, timeoutMs) => {
        const spec = resolveSpawnCommand(this.command, argv);
        // Mirrors acpx-cli, which bounds sessions list by sessionInitTimeoutMs.
        return this.run(spec.command, spec.args, this.withSpawnEnvironment(input, {
          timeoutMs,
        }));
      },
    });
  }

  async resumeAgentSession(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
    agentSessionId: string;
  }): Promise<Record<string, never>> {
    this.invalidateRecordIdCache(input);
    const timeoutMs = this.sessionInitTimeoutMs();
    await runResumeAgentSession({
      sessionName: input.name,
      agentSessionId: input.agentSessionId,
      timeoutMs,
      buildArgv: (tail) => this.buildSessionArgs(input, tail, { format: "quiet" }),
      execute: (argv, timeoutMs) => {
        const spec = resolveSpawnCommand(this.command, argv);
        return this.runSessionCreate(
          spec.command,
          spec.args,
          input.cwd,
          this.withSpawnEnvironment(input, { timeoutMs }),
        );
      },
      mapFailure: (result) => {
        throw new Error(normalizeCommandError(result) ?? `command failed with exit code ${result.code}`);
      },
      mapSpawnError: (error) => {
        if (error instanceof CommandTimeoutError) {
          throw new Error(`session initialization timed out after ${timeoutMs / 1000}s`);
        }
        throw error;
      },
    });
    return {};
  }

  private sessionInitTimeoutMs(): number {
    const value = this.options.sessionInitTimeoutMs;
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_SESSION_INIT_TIMEOUT_MS;
  }

  private managementCommandTimeoutMs(): number {
    const value = this.options.managementCommandTimeoutMs;
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_MANAGEMENT_COMMAND_TIMEOUT_MS;
  }

  async hasSession(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
  }): Promise<{ exists: boolean }> {
    const exists = await runHasSession({
      sessionName: input.name,
      timeoutMs: this.managementCommandTimeoutMs(),
      buildArgv: (tail) => this.buildSessionArgs(input, tail),
      execute: (argv, timeoutMs) => {
        const spec = resolveSpawnCommand(this.command, argv);
        return this.run(spec.command, spec.args, this.withSpawnEnvironment(input, {
          timeoutMs,
          stage: "has-session",
        }));
      },
    });
    return { exists };
  }

  async tailSessionHistory(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
    lines: number;
  }): Promise<{ text: string }> {
    return await runTailSessionHistory({
      sessionName: input.name,
      lines: input.lines,
      deadlineBudgetMs: this.managementCommandTimeoutMs(),
      buildArgv: (tail) => this.buildSessionArgs(input, tail),
      execute: (argv, timeoutMs) => {
        const spec = resolveSpawnCommand(this.command, argv);
        return this.run(spec.command, spec.args, this.withSpawnEnvironment(input, {
          timeoutMs,
          stage: "session-history",
        }));
      },
    });
  }

  async ensureSession(
    input: BridgeSessionInput,
    onProgress?: (progress: EnsureSessionProgress) => void,
  ): Promise<Record<string, never>> {
    this.invalidateRecordIdCache(input);
    try {
      return await this.attemptEnsureSession(input, onProgress);
    } catch (error) {
      // Different agent adapters advertise model ids in different formats (e.g. the two
      // codex adapters disagree: `gpt-5.5[high]` vs `gpt-5.5/high`), so a model valid for
      // one adapter is rejected by another and acpx hard-fails session creation. A stale /
      // cross-adapter / mistyped model override must never make a session uncreatable —
      // drop it and retry once, falling back to the agent adapter's default model.
      const requestedModel = input.model?.trim();
      if (
        requestedModel &&
        error instanceof EnsureSessionFailedError &&
        isModelNotAdvertisedError(error.message)
      ) {
        onProgress?.({
          kind: "note",
          text: `agent did not advertise model "${requestedModel}"; retrying with the agent's default model`,
        });
        return await this.attemptEnsureSession({ ...input, model: undefined }, onProgress);
      }
      throw error;
    }
  }

  private async attemptEnsureSession(
    input: BridgeSessionInput,
    onProgress?: (progress: EnsureSessionProgress) => void,
  ): Promise<Record<string, never>> {
    const timeoutMs = this.sessionInitTimeoutMs();
    const sessionInitTimedOutError = () =>
      new EnsureSessionFailedError(
        `session initialization timed out after ${timeoutMs / 1000}s`,
        "generic",
      );
    const onStderrLine = onProgress
      ? (line: string) => {
          const trimmed = line.replace(/\r$/, "").trimEnd();
          if (trimmed.length === 0) return;
          onProgress({ kind: "note", text: trimmed });
        }
      : undefined;

    // Orchestration lives in ../transport/acpx-ensure-session.ts; the bridge
    // keeps its own argv builders, runners, verbose probe, EPERM repair, and
    // failure mapping — only the ensure → show → new skeleton is shared.
    const outcome = await runEnsureSessionFlow(
      {
        // Structured launches first migrate a legacy record (agent_command
        // present, agent_argv missing) so acpx can resume it on Windows with
        // exact argv boundaries. No record → ensure creates one from the overlay argv.
        migrateLegacyArgv: () => this.migrateLegacySessionArgvIfNeeded(input),
        runEnsure: (tail, opts) => {
          const spec = resolveSpawnCommand(
            this.command,
            this.buildSessionArgs(input, tail, { verbose: opts.verbose }),
          );
          return this.run(spec.command, spec.args, this.withSpawnEnvironment(input, {
            onStderrLine: opts.onStderrLine,
            timeoutMs: opts.timeoutMs,
          }));
        },
        runShow: (tail, opts) => {
          const spec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, tail));
          return this.run(spec.command, spec.args, this.withSpawnEnvironment(input, {
            timeoutMs: opts.timeoutMs,
          }));
        },
        runCreate: (tail, opts) => {
          const spec = resolveSpawnCommand(
            this.command,
            this.buildSessionArgs(input, tail, { verbose: opts.verbose }),
          );
          return this.runSessionCreate(spec.command, spec.args, input.cwd, this.withSpawnEnvironment(input, {
            onStderrLine: opts.onStderrLine,
            timeoutMs: opts.timeoutMs,
          }));
        },
        repairSessionIndex: () => this.repairSessionIndex(),
        ...(this.options.now ? { now: this.options.now } : {}),
      },
      {
        sessionName: input.name,
        sessionInitTimeoutMs: timeoutMs,
        verboseFallback: true,
        epermRepair: true,
        tolerateEnsureFailure: false,
        tolerateShowFailure: false,
        isVerboseSupported: () => this.acpxVerboseSupported,
        setVerboseSupported: (supported) => { this.acpxVerboseSupported = supported; },
        ...(onProgress ? { onProgress } : {}),
        ...(onStderrLine ? { onStderrLine } : {}),
        // Agent init hung (auth prompt, network stall): the spawn was already
        // killed by the runner; surface a clear, user-facing error instead of
        // blocking this session's bridge lane forever.
        mapTimeoutError: () => { throw sessionInitTimedOutError(); },
      },
    );
    if (outcome.ok) return {};

    const { ensured, created } = outcome.failure;
    const output = created?.stderr || created?.stdout || "";
    const rawMessage = output || ensured?.stderr || ensured?.stdout || "failed to create session";
    // Strip [acpx] verbose log lines so they can't trigger false-positive optional-dep parsing.
    const parseInput = rawMessage
      .split(/\r\n|\r|\n/)
      .filter((line) => !/^\s*\[acpx\]/.test(line))
      .join("\n");
    const parsed = parseMissingOptionalDep(parseInput);
    if (parsed) {
      const parentPackagePath = this.resolveParentPackagePath(input, parsed.package);
      throw new EnsureSessionFailedError(rawMessage, "missing_optional_dep", {
        package: parsed.package,
        parentPackagePath,
      });
    }
    throw new EnsureSessionFailedError(rawMessage, "generic");
  }

  private resolveParentPackagePath(
    input: { agent: string; agentCommand?: string },
    platformPackage: string,
  ): string | null {
    // Guess parent package name: strip trailing -<os>[-<arch>][-<libc>] suffixes
    const guess = deriveParentPackageName(platformPackage);
    const candidates = [input.agentCommand, input.agent, guess].filter(
      (c): c is string => Boolean(c),
    );
    for (const candidate of candidates) {
      try {
        const resolved = require.resolve(`${candidate}/package.json`, {
          paths: [process.cwd(), ...(require.resolve.paths(candidate) ?? [])],
        });
        return dirname(resolved);
      } catch {
        continue;
      }
    }
    return null;
  }

  async prompt(input: BridgeSessionInput & { text: string }, onEvent?: (event: BridgePromptStreamEvent) => void): Promise<{ text: string }> {
    this.assertNoActiveRecovery(input);
    await this.syncPersistedSessionEffort(input);
    await this.launchMcpQueueOwnerIfNeeded(input);
    const structuredPrompt = await createStructuredPromptFile(input.text, input.media);
    const spawnSpec = resolveSpawnCommand(this.command, this.buildPromptArgs(input, [
      "prompt",
      "-s",
      input.name,
      ...(structuredPrompt ? ["--file", structuredPrompt.filePath] : [input.text]),
    ]));
    const formatToolCalls = (input.replyMode ?? "verbose") === "verbose";
    // replyMode "stream" → raw token streaming (one live bubble, low latency); the
    // batched paragraph path stays for discrete-message channels (WeChat).
    const rawStream = input.replyMode === "stream";
    // toolEventMode (Phase 1) wins; toolEvents:true (Phase 0 legacy) maps to "structured".
    const toolEventMode: ToolEventMode =
      input.toolEventMode ?? (input.toolEvents === true ? "structured" : "text");
    try {
      // Prompts are deliberately NOT bounded by a total-duration timeout:
      // long agent turns are legitimate (see command-timeouts.ts).
      const result = onEvent
        ? await this.runPromptCommand(spawnSpec.command, spawnSpec.args, onEvent, {
            formatToolCalls,
            toolEventMode,
            driver: input.driver ?? input.agent,
            env: this.effectiveSpawnEnvironment(input),
            rawStream,
          })
        : await this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment(input));
      return { text: getPromptText(result) };
    } catch (error) {
      if (!isAcpxQueueMessageOverflow(error)) {
        throw error;
      }

      const cleanup = await this.cleanupOverflowedOwner(input);
      throw new AcpxQueueOverflowError(cleanup);
    } finally {
      try {
        await structuredPrompt?.cleanup();
      } catch {
        // Prompt outcome is more important than best-effort temp file cleanup.
      }
    }
  }

  async injectMessage(input: BridgeSessionInput & {
    text: string;
    mode: "auto" | "steer" | "queue" | "interrupt";
    messageId: string;
  }): Promise<{ status: "queued"; modeUsed: "queue" }> {
    this.assertNoActiveRecovery(input);
    if (input.mode === "steer") {
      throw new MessageInjectionError(
        "TARGET_NOT_STEERABLE",
        "The target does not support same-turn steering.",
      );
    }
    if (input.mode === "interrupt") {
      throw new MessageInjectionError(
        "TARGET_NOT_INTERRUPTIBLE",
        "The target does not support interrupt delivery.",
      );
    }

    await this.syncPersistedSessionEffort(input);
    await this.launchMcpQueueOwnerIfNeeded(input);
    const spawnSpec = resolveSpawnCommand(this.command, sharedBuildQueueMessagePromptArgs(
      {
        agent: input.agent,
        agentCommand: input.agentCommand,
        acpxAgent: input.acpxAgent,
        rawCommand: input.rawCommand,
        cwd: input.cwd,
        model: input.model,
        permission: this.permissionInput(),
        queueOwnerTtlSeconds: this.options.queueOwnerTtlSeconds,
      },
      input.name,
      input.text,
    ));
    const result = await this.run(
      spawnSpec.command,
      spawnSpec.args,
      this.withSpawnEnvironment(input, {
        timeoutMs: this.managementCommandTimeoutMs(),
        stage: "inject-message",
      }),
    );
    if (result.code !== 0) {
      const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
      throw new Error(detail);
    }
    return { status: "queued", modeUsed: "queue" };
  }

  /**
   * A queue client can disconnect after its newline-delimited receive buffer
   * overflows while the queue owner keeps executing the accepted turn. Cancel
   * first when the normal acpx control path is available, then use the existing
   * provenance-aware verified terminator so the owner cannot become a ghost
   * turn. Neither step is allowed to replace the original overflow diagnosis.
   */
  private async cleanupOverflowedOwner(input: BridgeSessionInput): Promise<AcpxQueueCleanupResult> {
    // The bridge honors its terminateQueueOwner override; the CLI always verifies.
    const terminate = this.options.terminateQueueOwner ?? terminateAcpxQueueOwnerVerified;
    return await cleanupOverflowedOwnerFlow({
      cancel: () => this.cancel(input).then(() => {}),
      readRecordId: () => this.readSessionRecord(input).then((record) => record.acpxRecordId),
      terminate: (recordId) => terminate(recordId),
    });
  }

  private async launchMcpQueueOwnerIfNeeded(input: BridgeSessionInput): Promise<void> {
    // Owned record read (Bot auto-ensure): a runtime-lane Bot session that
    // has never been ensured resolves its record by ensuring it first — same
    // as the CLI lane. Strict readSessionRecord stays for the other callers.
    await ensureMcpQueueOwnerLaunched({
      coordinatorSession: input.mcpCoordinatorSession,
      readRecord: () => this.readOwnedSessionRecord(input),
      launch: (launchInput) => this.queueOwnerLauncher.launch(launchInput),
      onPreparedAgentCommand: (agentCommand) => { input.agentCommand = agentCommand; },
      buildLaunchInput: (recordId) => this.queueOwnerLaunchInput(input, recordId),
    });
  }

  private async readRawSessionRecord(
    input: BridgeSessionInput,
    stage: AcpxCommandStage = "read-session-record",
    format: "quiet" | "json" = "quiet",
    timeoutMs = this.managementCommandTimeoutMs(),
  ): Promise<string> {
    const spawnSpec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, [
      "sessions",
      "show",
      input.name,
    ], { format }));
    const result = await this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment(input, {
      timeoutMs,
      stage,
    }));
    if (result.code !== 0) {
      const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
      throw new Error(detail);
    }
    return result.stdout;
  }

  /**
   * Backfill `agent_argv` into a legacy acpx session record before the session is
   * ensured/launched, so Windows can resume it with exact boundaries. Runs only
   * for structured launches (agentArgv present); fails closed on identity or argv
   * mismatches rather than reusing a session that would launch a different agent.
   */
  private async migrateLegacySessionArgvIfNeeded(input: BridgeSessionInput): Promise<void> {
    if (!input.agentArgv || input.agentArgv.length === 0) {
      return;
    }
    let recordId: string | null = null;
    try {
      recordId = parseAcpxSessionRecordId(
        await this.readRawSessionRecord(input, "read-session-record", "quiet"),
      )?.acpxRecordId ?? null;
    } catch (error) {
      // Only a genuinely missing session means "nothing to migrate" — the
      // ensure below creates the record from the overlay argv. Timeouts,
      // crashes, permission errors, or corrupt output must FAIL CLOSED or the
      // follow-up ensure/new could duplicate records and orphan history.
      if (isMissingAcpxSessionError(
        error instanceof Error ? error.message : "",
        "",
      )) {
        return;
      }
      throw error;
    }
    if (!recordId) {
      throw new Error(
        `failed to resolve acpx session record id from successful sessions show output for "${input.name}"`,
      );
    }
    const result = await migrateSessionArgvFile(recordId, {
      agentCommand: renderAgentArgvIdentity(input.agentArgv),
      agentArgv: input.agentArgv,
    }, {
      beforeWrite: (id) => terminateAcpxQueueOwnerVerified(id),
    });
    if (result.status === "rejected" || result.status === "invalid") {
      const detail = result.detail ? `: ${result.detail}` : "";
      throw new Error(
        `session record ${recordId} cannot be migrated to a structured launch${detail}. ` +
          "Recreate the session (sessions close + new) or fix the agent config.",
      );
    }
  }

  private async readOwnedSessionRecord(input: BridgeSessionInput): Promise<{ acpxRecordId: string; agentSessionId?: string; acpSessionId?: string }> {
    try {
      return await this.readSessionRecord(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isMissingAcpxSessionError("", message)) {
        throw error;
      }
    }
    await this.ensureSession(input);
    return await this.readSessionRecord(input);
  }

  private async readSessionRecord(input: BridgeSessionInput, timeoutMs = this.managementCommandTimeoutMs()): Promise<{ acpxRecordId: string; agentSessionId?: string; acpSessionId?: string }> {
    const stdout = await this.readRawSessionRecord(input, "read-session-record", "json", timeoutMs);
    const record = parseAcpxSessionRecordId(stdout);
    if (!record) throw new Error("failed to resolve acpx session record id");
    // The ACP session id is the native id for adapters that expose one (OMP
    // publishes its own session id as the ACP id); the provider id is the
    // fallback for adapters that only publish a provider-native id.
    let acpSessionId: string | undefined;
    try {
      const parsed = JSON.parse(stdout) as { acpSessionId?: unknown };
      acpSessionId = typeof parsed.acpSessionId === "string" && parsed.acpSessionId.length > 0
        ? parsed.acpSessionId
        : undefined;
    } catch {
      acpSessionId = undefined;
    }
    return { ...record, ...(acpSessionId ? { acpSessionId } : {}) };
  }

  /**
   * Native-restore identity for a lane session (bridge: session name).
   * Refuses turns while a native restore holds the physical session — a turn
   * admitted mid-recovery would race the native writer.
   */
  private nativeRestoreSession(input: BridgeSessionInput): NativeModelRestoreSession {
    return {
      transportSession: input.name,
      cwd: input.cwd,
      agent: input.agent,
      ...(input.driver ? { driver: input.driver } : {}),
      ...(input.agentCommand ? { agentCommand: input.agentCommand } : {}),
      ...(input.acpxAgent ? { acpxAgent: input.acpxAgent } : {}),
      ...(input.rawCommand ? { rawCommand: input.rawCommand } : {}),
      ...(input.agentArgv ? { agentArgv: input.agentArgv } : {}),
    };
  }

  private assertNoActiveRecovery(input: BridgeSessionInput): void {
    assertNoActiveNativeRestore(this.nativeRestoreSession(input));
  }

  async getAgentSessionId(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
  }): Promise<{ agentSessionId: string | undefined }> {
    const agentSessionId = await runGetAgentSessionId({
      readRecord: () => this.readSessionRecord(input),
    });
    return { agentSessionId };
  }

  async setMode(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
    modeId: string;
  }): Promise<Record<string, never>> {
    this.assertNoActiveRecovery(input);
    await runSetSessionMode({
      sessionName: input.name,
      modeId: input.modeId,
      timeoutMs: this.managementCommandTimeoutMs(),
      buildArgv: (tail) => this.buildSessionArgs(input, tail),
      execute: (argv, timeoutMs) => {
        const spec = resolveSpawnCommand(this.command, argv);
        return this.run(spec.command, spec.args, this.withSpawnEnvironment(input, {
          timeoutMs,
          stage: "set-mode",
        }));
      },
      control: true,
    });
    return {};
  }

  async setModel(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
    modelId: string;
  }): Promise<Record<string, never>> {
    // Ordinary setter with OMP native-restore recovery (shared with the CLI
    // lane in ../transport/native-model-restore.ts); only the I/O closures
    // below are lane-specific.
    await runSetModelWithNativeRestore(
      this.nativeRestoreSession(input),
      input.modelId,
      {
        readSessionRecord: (timeoutMs) => this.readSessionRecord(input, timeoutMs),
        runSetModel: async (modelId, opts) => {
          const spawnSpec = resolveSpawnCommand(this.command, this.buildSessionArgs({ ...input, model: modelId }, [
            "set",
            "-s",
            input.name,
            "model",
            modelId,
          ]));
          const result = await runAcpxControlCommand(() => this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment({ ...input, model: modelId }, {
            timeoutMs: opts.timeoutMs,
            stage: "set-model",
          })));
          if (result.code !== 0) {
            const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
            throw new Error(detail);
          }
        },
        envForModel: (modelId?) => this.effectiveSpawnEnvironment(
          modelId === undefined ? input : { ...input, model: modelId },
        ),
        managementTimeoutMs: this.managementCommandTimeoutMs(),
        ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.ompModelRecovery ? { ompModelRecovery: this.options.ompModelRecovery } : {}),
        ...(this.options.queueOwnerAbsence ? { queueOwnerAbsence: this.options.queueOwnerAbsence } : {}),
      },
    );
    return {};
  }

  async prepareSessionCommands(input: import('./engine/bridge-engine').EngineSessionInput): Promise<import('../transport/types').AgentCommand[] | undefined> {
    await this.ensureSession(input);
    const spawnSpec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, ['status','-s',input.name], {format:'json'}));
    const result = await this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment(input, {timeoutMs:this.managementCommandTimeoutMs(),stage:'get-session-model'}));
    if(result.code !== 0) {
      const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
      throw new Error(detail);
    }
    const raw = JSON.parse(result.stdout) as {availableCommands?: import('../transport/types').AgentCommand[]};
    return raw.availableCommands;
  }

  async getSessionModel(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
  }): Promise<{ current?: string; available: string[] }> {
    return await runGetSessionModel({
      sessionName: input.name,
      timeoutMs: this.managementCommandTimeoutMs(),
      buildArgv: (tail, format) => this.buildSessionArgs(input, tail, format ? { format } : {}),
      execute: (argv, timeoutMs) => {
        const spec = resolveSpawnCommand(this.command, argv);
        return this.run(spec.command, spec.args, this.withSpawnEnvironment(input, {
          timeoutMs,
          stage: "get-session-model",
        }));
      },
    });
  }

  async probeAgentCapabilities(input: AgentCapabilityProbeRequest): Promise<AgentCapabilityProbeResult> {
    return probeAgentCapabilitiesViaInspector(input, {
      timeoutMs: probeInspectTimeout(this.sessionInitTimeoutMs()),
      ...(this.options.loadAgentRegistry ? { loadAgentRegistry: this.options.loadAgentRegistry } : {}),
      ...(this.options.inspectAgentModels ? { inspectAgentModels: this.options.inspectAgentModels } : {}),
    });
  }

  async getSessionEffort(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
  }): Promise<SessionEffortState> {
    const output = await this.readRawSessionRecord(input, "get-session-effort", "json");
    const effort = parseSessionEffortRecord(output);
    return effort
      ? { current: effort.current, available: effort.available }
      : { available: [] };
  }

  async setSessionEffort(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
    effort: string;
  }): Promise<Record<string, never>> {
    this.assertNoActiveRecovery(input);
    const record = await this.readRawSessionRecord(input, "get-session-effort", "json");
    await this.applyAdvertisedSessionEffort(input, input.effort, record);
    return {};
  }

  private async syncPersistedSessionEffort(input: BridgeSessionInput): Promise<void> {
    // Orchestration lives in ../transport/acpx-session-ops.ts; only the I/O is lane-specific.
    await syncPersistedSessionEffortFlow(
      input.effort,
      (record) => parseAcpxSessionRecordId(record)?.acpxRecordId,
      {
        readRecord: () => this.readRawSessionRecord(input, "get-session-effort", "json"),
        ownerWillBeReplaced: (recordId) => this.queueOwnerWillBeReplaced(input, recordId),
        coolOwner: (recordId) => this.coolQueueOwner(recordId),
        applyEffort: (effort, record) => this.applyAdvertisedSessionEffort(input, effort, record),
      },
    );
  }

  private async coolQueueOwner(acpxRecordId: string): Promise<void> {
    await coolQueueOwnerWith(this.queueOwnerLauncher, acpxRecordId);
  }

  private async queueOwnerWillBeReplaced(
    input: BridgeSessionInput,
    acpxRecordId: string | undefined,
  ): Promise<boolean> {
    return await willReplaceQueueOwner({
      coordinatorSession: input.mcpCoordinatorSession,
      acpxRecordId,
      wouldReuse: this.queueOwnerLauncher.wouldReuse?.bind(this.queueOwnerLauncher),
      buildLaunchInput: (recordId) => this.queueOwnerLaunchInput(input, recordId),
    });
  }

  private queueOwnerLaunchInput(input: BridgeSessionInput, acpxRecordId: string): LaunchQueueOwnerInput {
    return buildQueueOwnerLaunchInput(queueOwnerRefFromBridgeInput(input), acpxRecordId, {
      agentEnv: this.spawnEnvironment(input),
      hostPolicyEnv: this.hostPolicyEnv,
      permissionMode: this.options.permissionMode ?? "approve-all",
      nonInteractivePermissions: this.options.nonInteractivePermissions ?? "deny",
      ...(this.options.createAdapterContext ? { createAdapterContext: this.options.createAdapterContext } : {}),
    });
  }

  private async applyAdvertisedSessionEffort(
    input: BridgeSessionInput,
    effort: string,
    record: string,
  ): Promise<void> {
    const advertised = requireAdvertisedSessionEffort(record, effort);
    const spawnSpec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, [
      "set",
      "-s",
      input.name,
      advertised.configId,
      effort,
    ]));
    const result = await runAcpxControlCommand(() => this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment(input, {
      timeoutMs: this.managementCommandTimeoutMs(),
      stage: "set-session-effort",
    })));
    if (result.code !== 0) {
      const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
      throw new Error(detail);
    }
  }

  async cancel(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
  }): Promise<{ cancelled: boolean; message: string }> {
    return await runCancelSession({
      sessionName: input.name,
      timeoutMs: this.managementCommandTimeoutMs(),
      buildArgv: (tail) => this.buildSessionArgs(input, tail),
      execute: (argv, timeoutMs) => {
        const spec = resolveSpawnCommand(this.command, argv);
        return this.run(spec.command, spec.args, this.withSpawnEnvironment(input, {
          timeoutMs,
          stage: "cancel",
        }));
      },
      control: true,
    });
  }

  async removeSession(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
  }): Promise<Record<string, never>> {
    this.invalidateRecordIdCache(input);
    await runRemoveSession({
      sessionName: input.name,
      timeoutMs: this.managementCommandTimeoutMs(),
      buildArgv: (tail) => this.buildSessionArgs(input, tail),
      execute: (argv, timeoutMs) => {
        const spec = resolveSpawnCommand(this.command, argv);
        return this.run(spec.command, spec.args, this.withSpawnEnvironment(input, {
          timeoutMs,
          stage: "remove-session",
        }));
      },
      control: true,
    });
    return {};
  }

  async deleteSession(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
  }): Promise<Record<string, never>> {
    await runDeleteSession({
      readRecord: () => this.readSessionRecord(input),
      remove: () => this.removeSession(input),
    });
    return {};
  }

  async freeWarmProcess(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
  }): Promise<Record<string, never>> {
    await runFreeWarmProcess({
      readRecord: () => this.readSessionRecord(input),
    });
    return {};
  }

  private readonly recordIdCache = new Map<string, string>();

  // Record ids are stable per transport session — cache to avoid spawning
  // `acpx sessions show` on every warmth poll tick.
  private recordIdCacheKey(input: { agent: string; agentCommand?: string; cwd: string; name: string }): string {
    return JSON.stringify([input.agent, input.agentCommand ?? null, input.cwd, input.name]);
  }

  // Any lifecycle op that can create/close a record under the same transport
  // session name (notably native re-attach after delete reuses the name) must
  // drop the cached record id, or warmth polls keep reading the dead record's
  // lock forever.
  private invalidateRecordIdCache(input: { agent: string; agentCommand?: string; cwd: string; name: string }): void {
    this.recordIdCache.delete(this.recordIdCacheKey(input));
  }

  async isSessionWarm(input: {
    agent: string;
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: string[];
    driver?: string;
    settingsPolicy?: ClaudeSettingsPolicy;
    cwd: string;
    name: string;
  }): Promise<{ warm: boolean }> {
    const warm = await runIsSessionWarm({
      readCachedRecord: async () => {
        const cacheKey = this.recordIdCacheKey(input);
        let acpxRecordId = this.recordIdCache.get(cacheKey);
        if (!acpxRecordId) {
          try {
            ({ acpxRecordId } = await this.readSessionRecord(input));
          } catch {
            return undefined; // acpx session gone → nothing can be warm
          }
          this.recordIdCache.set(cacheKey, acpxRecordId);
        }
        return { acpxRecordId };
      },
    });
    return { warm };
  }

  async shutdown(): Promise<Record<string, never>> {
    return {};
  }

  private buildSessionArgs(
    input: {
      agent: string;
      agentCommand?: string;
      acpxAgent?: string;
      rawCommand?: string;
      agentArgv?: string[];
      cwd: string;
      name?: string;
      model?: string;
    },
    tail: string[],
    options: { verbose?: boolean; format?: "quiet" | "json"; authPolicy?: "skip" | "fail" } = {},
  ): string[] {
    return sharedBuildSessionArgs(
      {
        agent: input.agent,
        agentCommand: input.agentCommand,
        acpxAgent: input.acpxAgent,
        rawCommand: input.rawCommand,
        cwd: input.cwd,
        model: input.model,
        permission: this.permissionInput(),
      },
      tail,
      options,
    );
  }

  private buildPromptArgs(
    input: {
      agent: string;
      agentCommand?: string;
      acpxAgent?: string;
      rawCommand?: string;
      agentArgv?: string[];
      cwd: string;
      name: string;
      model?: string;
    },
    tail: string[],
  ): string[] {
    return sharedBuildPromptArgs(
      {
        agent: input.agent,
        agentCommand: input.agentCommand,
        acpxAgent: input.acpxAgent,
        rawCommand: input.rawCommand,
        cwd: input.cwd,
        model: input.model,
        permission: this.permissionInput(),
        queueOwnerTtlSeconds: this.options.queueOwnerTtlSeconds,
      },
      tail,
    );
  }

  private permissionInput() {
    return {
      permissionMode: this.options.permissionMode ?? DEFAULT_PERMISSION_MODE,
      nonInteractivePermissions: this.options.nonInteractivePermissions ?? DEFAULT_NON_INTERACTIVE,
      permissionPolicy: this.options.permissionPolicy,
    };
  }
  // Internal primitive: agent-specific env only, WITHOUT host policy.
  // Never spawn directly from this — use effectiveSpawnEnvironment() (all
  // child env) or the merged queueOwnerLaunchInput() branch.

  private spawnEnvironment(input: ClaudeExecutionSettings): NodeJS.ProcessEnv | undefined {
    return (this.options.resolveSpawnEnvironment ?? resolveClaudeSpawnEnvironment)(input);
  }

  /**
   * Effective acpx-host env for one child (same contract as the CLI lane):
   * undefined when there is neither agent env nor policy, preserving the
   * legacy inherit path bit-identically.
   */
  private effectiveSpawnEnvironment(input: ClaudeExecutionSettings): NodeJS.ProcessEnv | undefined {
    const agentEnv = this.spawnEnvironment(input);
    if (!agentEnv && !this.hostPolicyConfigured) return undefined;
    return resolveEffectiveAcpxEnv(agentEnv, this.hostPolicyEnv);
  }

  private withSpawnEnvironment(
    input: ClaudeExecutionSettings,
    options?: CommandRunnerOptions,
  ): CommandRunnerOptions | undefined {
    const env = this.effectiveSpawnEnvironment(input);
    return env ? { ...(options ?? {}), env } : options;
  }
}

const defaultRunner = defaultAcpxRunner;

export async function runStreamingPrompt(
  command: string,
  args: string[],
  onEvent?: (event: BridgePromptStreamEvent) => void,
  options: StreamingPromptRunnerOptions = {},
): Promise<CommandResult> {
  const spawnPrompt = options.spawnPrompt ?? ((spawnCommand, spawnArgs) =>
    spawn(spawnCommand, spawnArgs, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as PromptStreamProcess);
  const toolEventMode: ToolEventMode = options.toolEventMode ?? "text";
  // Shell lives in ../transport/acpx-streaming-prompt.ts; the bridge keeps its
  // direct synchronous `onEvent` emission here (no queue, no chains, no sink).
  const { code, stdout, stderr } = await runStreamingPromptFlow({
    command,
    args,
    formatToolCalls: options.formatToolCalls,
    toolEventMode,
    ...(options.driver ? { driver: options.driver } : {}),
    rawStream: options.rawStream,
    spawnPrompt,
    ...(options.setIntervalFn ? { setIntervalFn: options.setIntervalFn } : {}),
    ...(options.clearIntervalFn ? { clearIntervalFn: options.clearIntervalFn } : {}),
    ...(options.maxSegmentWaitMs !== undefined ? { maxSegmentWaitMs: options.maxSegmentWaitMs } : {}),
    ...(options.flushCheckIntervalMs !== undefined ? { flushCheckIntervalMs: options.flushCheckIntervalMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    handlers: {
      ...(onEvent && (toolEventMode === "structured" || toolEventMode === "both")
        ? { onToolEvent: (toolEvent) => onEvent({ type: "prompt.tool_event", event: toolEvent }) }
        : {}),
      // `onEvent` here is the synchronous `writeLine` path in bridge-server —
      // it emits a `prompt.thought` NDJSON line and returns immediately. The
      // async `onThought` chain lives on the client side (acpx-bridge-transport),
      // so this side has no callback to await before resolving the prompt.
      ...(onEvent
        ? { onThought: (chunk: string) => onEvent({ type: "prompt.thought", text: chunk }) }
        : {}),
      ...(onEvent
        ? { onPlan: (entries) => onEvent({ type: "prompt.plan", entries }) }
        : {}),
      ...(onEvent
        ? { onUsage: (usage) => onEvent({ type: "prompt.usage", used: usage.used, size: usage.size, ...(usage.cost ? { cost: usage.cost } : {}), ...(usage.breakdown ? { breakdown: usage.breakdown } : {}) }) }
        : {}),
      ...(onEvent
        ? { onCommands: (commands) => onEvent({ type: "prompt.commands", commands }) }
        : {}),
    },
    emitter: {
      emitSegment: (text) => {
        onEvent?.({ type: "prompt.segment", text });
      },
      finish: async () => 0,
    },
  });
  return { code, stdout, stderr };
}

async function defaultPromptRunner(
  command: string,
  args: string[],
  onEvent?: (event: BridgePromptStreamEvent) => void,
  options?: StreamingPromptRunnerOptions,
): Promise<CommandResult> {
  return await runStreamingPrompt(command, args, onEvent, options);
}

// shellSessionCreateRunner is imported from ../transport/acpx-spawn (unified Phase 1).

export function selectLatestAcpxSessionIndexTmp(files: string[]): string | null {
  let latestTmp: string | null = null;
  let latestTime = 0;

  for (const file of files) {
    // legacy: index.json.<pid>.<timestamp>.tmp
    // current: index.json.<pid>.<timestamp>.<unique-id>.tmp (unique-id may contain dashes)
    const match = file.match(/^index\.json\.(\d+)\.(\d+)(\.[^.]+)?\.tmp$/);
    if (!match) {
      continue;
    }

    const timestamp = Number(match[2]);
    if (timestamp > latestTime) {
      latestTime = timestamp;
      latestTmp = file;
    }
  }

  return latestTmp;
}

interface RepairAcpxSessionIndexDeps {
  platform?: NodeJS.Platform;
  home?: string;
  readdirFn?: typeof readdir;
  copyFileFn?: typeof copyFile;
}

/**
 * On Windows, acpx uses rename() to atomically update the session index,
 * but antivirus or file system lockers can block this operation (EPERM).
 * This function finds the latest tmp file written by acpx and copies it
 * over the index.json as a fallback.
 */
export async function tryRepairAcpxSessionIndex(deps: RepairAcpxSessionIndexDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    return false;
  }

  const home = deps.home ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  if (!home) {
    return false;
  }

  const pathJoin = platform === "win32" ? win32.join : join;
  const sessionsDir = pathJoin(home, ".acpx", "sessions");
  const indexPath = pathJoin(sessionsDir, "index.json");
  const readdirFn = deps.readdirFn ?? readdir;
  const copyFileFn = deps.copyFileFn ?? copyFile;

  let files: string[];
  try {
    files = await readdirFn(sessionsDir);
  } catch {
    return false;
  }

  const latestTmp = selectLatestAcpxSessionIndexTmp(files);
  if (!latestTmp) {
    return false;
  }

  try {
    await copyFileFn(pathJoin(sessionsDir, latestTmp), indexPath);
    return true;
  } catch {
    return false;
  }
}

// isUnknownVerboseOption lives in ../transport/acpx-ensure-session.ts (shared).

// describeCleanupError lives in ../transport/acpx-session-ops.ts (shared).
