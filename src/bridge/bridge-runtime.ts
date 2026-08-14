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
import { terminateProcessTree } from "../process/terminate-process-tree";
import { getPromptText } from "../transport/prompt-output";
import type { AgentCommand, UsageBreakdown, UsageCost } from "../transport/types";
import { createStructuredPromptFile } from "../transport/prompt-media";
import { createStreamingPromptState, parseStreamingDataChunk } from "../transport/streaming-prompt";
import { parseMissingOptionalDep } from "./parse-missing-optional-dep";
import { isModelNotAdvertisedError } from "../transport/model-not-advertised";
import { deriveParentPackageName } from "../recovery/discover-parent-package-paths";
import { AcpxQueueOwnerLauncher, readQueueOwnerPid, terminateAcpxQueueOwner, terminateAcpxQueueOwnerVerified, type QueueOwnerAdapterContext } from "../transport/acpx-queue-owner-launcher";
import { classifyPreinstalledAdapterCommandShape } from "../adapters/adapter-catalog";
import { migrateSessionArgvFile } from "../transport/acpx-session-argv-migration";
import { renderAgentArgvIdentity } from "../config/agent-launch";
import { isProcessAlive } from "../daemon/daemon-files";
import { runAgentSessionList } from "../transport/agent-session-list";
import { CODEX_AGENT_NAME, codexSubagentPredicate } from "../transport/codex-subagent-filter";
import { deleteAcpxSessionFiles } from "../transport/acpx-session-files";
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
import type { AgentSessionListResult, PromptMediaInput } from "../transport/types";
import type { SessionEffortState } from "../transport/types";
import type { ToolEventMode } from "../transport/tool-event-mode.js";
import type { PlanEntry, ToolUseEvent } from "../channels/types.js";
import {
  buildSessionArgs as sharedBuildSessionArgs,
  buildPromptArgs as sharedBuildPromptArgs,
  isMissingAcpxSessionError,
  parseAcpxSessionRecordId,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_NON_INTERACTIVE,
} from "../transport/acpx-command-builder";
import { parseSessionEffortRecord, requireAdvertisedSessionEffort } from "../transport/session-effort";

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

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunnerOptions {
  onStderrLine?: (line: string) => void;
  /** Kill the spawned process tree and reject with CommandTimeoutError when it runs longer than this. */
  timeoutMs?: number;
  /** Stable operation name included in timeout diagnostics. */
  stage?: AcpxCommandStage;
  /** Per-agent environment; provider credentials never cross the bridge JSON protocol. */
  env?: NodeJS.ProcessEnv;
}
type CommandRunner = (command: string, args: string[], options?: CommandRunnerOptions) => Promise<CommandResult>;
type SessionCreateRunner = (command: string, args: string[], cwd: string, options?: CommandRunnerOptions) => Promise<CommandResult>;
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
}

export class BridgeRuntime {
  // undefined = not yet probed; true/false = probed result.
  // Older acpx builds don't accept --verbose; we feature-detect lazily on first
  // ensure failure that looks like "unknown option", then disable verbose for
  // this runtime's lifetime. A restart re-probes.
  private acpxVerboseSupported: boolean | undefined = undefined;

  constructor(
    private readonly command: string = "acpx",
    private readonly run: CommandRunner = defaultRunner,
    private readonly runSessionCreate: SessionCreateRunner = shellSessionCreateRunner,
    private readonly options: BridgeRuntimeOptions = {},
    private readonly runPromptCommand: PromptRunner = defaultPromptRunner,
    private readonly repairSessionIndex: RepairSessionIndexFn = tryRepairAcpxSessionIndex,
    private readonly queueOwnerLauncher: Pick<AcpxQueueOwnerLauncher, "launch"> = new AcpxQueueOwnerLauncher({
      acpxCommand: command,
      // Coordinator sessions pre-spawn the queue owner here (before `acpx prompt`),
      // so the owner's warm window must be set at launch — the prompt's `--ttl`
      // can't extend an already-running owner. Launcher ttl is milliseconds.
      ...(typeof options.queueOwnerTtlSeconds === "number" && Number.isFinite(options.queueOwnerTtlSeconds)
        ? { ttlMs: options.queueOwnerTtlSeconds * 1000 }
        : {}),
    }),
  ) {}

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
    return await runAgentSessionList({
      filterCwd: input.filterCwd,
      runList: async (includeFilterCwd) => {
        const spec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, [
          "sessions",
          "list",
          ...(includeFilterCwd && input.filterCwd ? ["--filter-cwd", input.filterCwd] : []),
          ...(input.cursor ? ["--cursor", input.cursor] : []),
        ], { format: "json" }));
        // Mirrors acpx-cli, which bounds sessions list by sessionInitTimeoutMs.
        return await this.run(spec.command, spec.args, this.withSpawnEnvironment(input, {
          timeoutMs: this.sessionInitTimeoutMs(),
        }));
      },
      formatError: (result) => result.stderr || result.stdout || `sessions list failed with exit code ${result.code}`,
      // Codex's session list leaks native subagent threads; hide them (fail-open).
      // Gate on driver so custom-named codex agents (driver "codex") are covered too.
      isSubagentSession: (input.driver ?? input.agent) === CODEX_AGENT_NAME ? codexSubagentPredicate() : undefined,
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
    const spawnSpec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, [
      "sessions",
      "new",
      "--name",
      input.name,
      "--resume-session",
      input.agentSessionId,
    ], { format: "quiet" }));
    const timeoutMs = this.sessionInitTimeoutMs();
    let result: CommandResult;
    try {
      result = await this.runSessionCreate(
        spawnSpec.command,
        spawnSpec.args,
        input.cwd,
        this.withSpawnEnvironment(input, { timeoutMs }),
      );
    } catch (error) {
      if (error instanceof CommandTimeoutError) {
        throw new Error(`session initialization timed out after ${timeoutMs / 1000}s`);
      }
      throw error;
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "sessions resume failed");
    }
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
    const spawnSpec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, [
      "sessions",
      "show",
      input.name,
    ]));
    const result = await this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment(input, {
      timeoutMs: this.managementCommandTimeoutMs(),
      stage: "has-session",
    }));

    return { exists: result.code === 0 };
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
    const candidates = [
      ["sessions", "history", input.name, "--limit", String(input.lines)],
      ["sessions", "history", "quiet", "-s", input.name, String(input.lines)],
      ["sessions", "history", "quiet", input.name, String(input.lines)],
      ["sessions", "history", "-s", input.name, "--tail", String(input.lines)],
      ["sessions", "history", input.name, "--tail", String(input.lines)],
      ["sessions", "history", "--name", input.name, "--tail", String(input.lines)],
    ];

    // One shared deadline across all candidate invocations so a hung acpx
    // bounds the whole method at managementCommandTimeoutMs, not per candidate.
    const deadline = Date.now() + this.managementCommandTimeoutMs();
    let lastResult: CommandResult | undefined;
    for (const tailArgs of candidates) {
      const spawnSpec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, tailArgs));
      const result = await this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment(input, {
        timeoutMs: Math.max(deadline - Date.now(), 1),
        stage: "session-history",
      }));
      if (result.code === 0) {
        return { text: result.stdout.trimEnd() };
      }
      lastResult = result;
    }

    const message = lastResult?.stderr || lastResult?.stdout || "sessions history failed";
    throw new Error(message);
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
    onProgress?.("spawn");
    // Structured launches first migrate a legacy record (agent_command present,
    // agent_argv missing) so acpx can resume it on Windows with exact argv
    // boundaries. No record → the ensure below creates one from the overlay argv.
    await this.migrateLegacySessionArgvIfNeeded(input);
    const timeoutMs = this.sessionInitTimeoutMs();
    // One shared deadline for every subprocess step (ensure, show probe, new,
    // verbose-fallback retry): each step only gets the remaining budget so the
    // whole ensure path is bounded by sessionInitTimeoutMs end-to-end, like
    // acpx-cli. The 1ms floor makes an already-expired deadline fail fast via
    // the normal per-spawn timeout instead of granting a fresh slice.
    const now = this.options.now ?? Date.now;
    const deadline = now() + timeoutMs;
    const remainingTimeoutMs = () => Math.max(deadline - now(), 1);
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

    const runWithVerboseFallback = async (
      tailArgs: string[],
      runner: (command: string, args: string[]) => Promise<CommandResult>,
    ): Promise<CommandResult> => {
      try {
        const useVerbose = this.acpxVerboseSupported !== false;
        const spec = resolveSpawnCommand(
          this.command,
          this.buildSessionArgs(input, tailArgs, { verbose: useVerbose }),
        );
        const result = await runner(spec.command, spec.args);
        if (result.code === 0) {
          if (useVerbose) this.acpxVerboseSupported = true;
          return result;
        }
        if (useVerbose && isUnknownVerboseOption(result.stderr, result.stdout)) {
          this.acpxVerboseSupported = false;
          const retrySpec = resolveSpawnCommand(
            this.command,
            this.buildSessionArgs(input, tailArgs, { verbose: false }),
          );
          return await runner(retrySpec.command, retrySpec.args);
        }
        return result;
      } catch (error) {
        // Agent init hung (auth prompt, network stall): the spawn was already
        // killed by the runner; surface a clear, user-facing error instead of
        // blocking this session's bridge lane forever.
        if (error instanceof CommandTimeoutError) {
          throw sessionInitTimedOutError();
        }
        throw error;
      }
    };

    const ensured = await runWithVerboseFallback(
      ["sessions", "ensure", "--name", input.name],
      (command, args) => this.run(command, args, this.withSpawnEnvironment(input, {
        onStderrLine,
        timeoutMs: remainingTimeoutMs(),
      })),
    );
    if (ensured.code === 0) {
      onProgress?.("ready");
      return {};
    }

    const existingSpec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, ["sessions", "show", input.name]));
    const runShowProbe = async (): Promise<CommandResult> => {
      try {
        return await this.run(existingSpec.command, existingSpec.args, this.withSpawnEnvironment(input, {
          timeoutMs: remainingTimeoutMs(),
        }));
      } catch (error) {
        if (error instanceof CommandTimeoutError) {
          throw sessionInitTimedOutError();
        }
        throw error;
      }
    };
    const existing = await runShowProbe();
    if (existing.code === 0) {
      onProgress?.("ready");
      return {};
    }

    onProgress?.("initializing");
    const created = await runWithVerboseFallback(
      ["sessions", "new", "--name", input.name],
      (command, args) => this.runSessionCreate(command, args, input.cwd, this.withSpawnEnvironment(input, {
        onStderrLine,
        timeoutMs: remainingTimeoutMs(),
      })),
    );

    if (created.code === 0) {
      onProgress?.("ready");
      return {};
    }

    const output = created.stderr || created.stdout || "";
    if (output.includes("EPERM") && await this.repairSessionIndex()) {
      const repaired = await runShowProbe();
      if (repaired.code === 0) {
        onProgress?.("ready");
        return {};
      }
    }

    const rawMessage = output || ensured.stderr || ensured.stdout || "failed to create session";
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
    // Same cold-only rule as AcpxCliTransport.prompt: a live queue owner
    // already holds the effort, and `acpx set` would race a second ACP process.
    if (input.effort?.trim() && !(await this.isSessionWarm(input)).warm) {
      await this.reapplySessionEffort(input, input.effort.trim());
    }
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
            rawStream,
            env: this.spawnEnvironment(input),
          })
        : await this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment(input));
      return { text: getPromptText(result) };
    } finally {
      try {
        await structuredPrompt?.cleanup();
      } catch {
        // Prompt outcome is more important than best-effort temp file cleanup.
      }
    }
  }

  private async launchMcpQueueOwnerIfNeeded(input: BridgeSessionInput): Promise<void> {
    if (!input.mcpCoordinatorSession) {
      return;
    }
    const record = await this.readSessionRecord(input);
    const env = this.spawnEnvironment(input);
    const adapterId = classifyPreinstalledAdapterCommandShape(input.agentCommand);
    const adapterContext = adapterId && input.agentCommand
      ? this.options.createAdapterContext?.({
          id: adapterId,
          sessionKey: input.sessionKey ?? input.name,
          agentCommand: input.agentCommand,
        })
      : undefined;
    const prepared = await this.queueOwnerLauncher.launch({
      acpxRecordId: record.acpxRecordId,
      coordinatorSession: input.mcpCoordinatorSession,
      ...(input.mcpSourceHandle ? { sourceHandle: input.mcpSourceHandle } : {}),
      permissionMode: this.options.permissionMode ?? "approve-all",
      nonInteractivePermissions: this.options.nonInteractivePermissions ?? "deny",
      ...(input.model?.trim() ? { sessionOptions: { model: input.model.trim() } } : {}),
      ...(adapterId && input.agentCommand ? { agentCommand: input.agentCommand } : {}),
      ...(adapterContext ? { adapterContext } : {}),
      ...(env ? { env } : {}),
    });
    if (prepared?.agentCommand) input.agentCommand = prepared.agentCommand;
  }

  private async readRawSessionRecord(
    input: BridgeSessionInput,
    stage: AcpxCommandStage = "read-session-record",
    format: "quiet" | "json" = "quiet",
  ): Promise<string> {
    const spawnSpec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, [
      "sessions",
      "show",
      input.name,
    ], { format }));
    const result = await this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment(input, {
      timeoutMs: this.managementCommandTimeoutMs(),
      stage,
    }));
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "sessions show failed");
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

  private async readSessionRecord(input: BridgeSessionInput): Promise<{ acpxRecordId: string; agentSessionId?: string }> {
    const record = parseAcpxSessionRecordId(await this.readRawSessionRecord(input, "read-session-record", "json"));
    if (record) return record;
    throw new Error("failed to resolve acpx session record id");
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
    const record = await this.readSessionRecord(input);
    return { agentSessionId: record.agentSessionId };
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
    const spawnSpec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, [
      "set-mode",
      "-s",
      input.name,
      input.modeId,
    ]));
    const result = await this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment(input, {
      timeoutMs: this.managementCommandTimeoutMs(),
      stage: "set-mode",
    }));

    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "set-mode failed");
    }

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
    // Pass the new model both as the `set model` value and the global --model.
    const spawnSpec = resolveSpawnCommand(this.command, this.buildSessionArgs({ ...input, model: input.modelId }, [
      "set",
      "-s",
      input.name,
      "model",
      input.modelId,
    ]));
    const result = await this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment({ ...input, model: input.modelId }, {
      timeoutMs: this.managementCommandTimeoutMs(),
      stage: "set-model",
    }));

    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "set-model failed");
    }

    return {};
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
    const spawnSpec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, [
      "status",
      "-s",
      input.name,
    ], { format: "json" }));
    const result = await this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment(input, {
      timeoutMs: this.managementCommandTimeoutMs(),
      stage: "get-session-model",
    }));

    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "status failed");
    }

    try {
      const json = JSON.parse(result.stdout) as { model?: string; availableModels?: string[] };
      return {
        current: typeof json.model === "string" ? json.model : undefined,
        available: Array.isArray(json.availableModels) ? json.availableModels.filter((m): m is string => typeof m === "string") : [],
      };
    } catch {
      return { available: [] };
    }
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
    const record = await this.readRawSessionRecord(input, "get-session-effort", "json");
    await this.applyAdvertisedSessionEffort(input, input.effort, record);
    return {};
  }

  private async reapplySessionEffort(input: BridgeSessionInput, effort: string): Promise<void> {
    const record = await this.readRawSessionRecord(input, "get-session-effort", "json");
    const observed = parseSessionEffortRecord(record);
    if (!observed?.available.includes(effort)) {
      return;
    }
    await this.applyAdvertisedSessionEffort(input, effort, record);
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
    const result = await this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment(input, {
      timeoutMs: this.managementCommandTimeoutMs(),
      stage: "set-session-effort",
    }));
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "set effort failed");
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
    const spawnSpec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, [
      "cancel",
      "-s",
      input.name,
    ]));
    const result = await this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment(input, {
      timeoutMs: this.managementCommandTimeoutMs(),
      stage: "cancel",
    }));

    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "cancel failed");
    }

    return {
      cancelled: true,
      message: result.stdout.trim(),
    };
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
    const spawnSpec = resolveSpawnCommand(this.command, this.buildSessionArgs(input, [
      "sessions",
      "close",
      input.name,
    ]));
    const result = await this.run(spawnSpec.command, spawnSpec.args, this.withSpawnEnvironment(input, {
      timeoutMs: this.managementCommandTimeoutMs(),
      stage: "remove-session",
    }));

    if (result.code === 0) {
      return {};
    }
    if (isMissingAcpxSessionError(result.stderr, result.stdout)) {
      return {};
    }
    throw new Error(result.stderr || result.stdout || "sessions close failed");
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
    let acpxRecordId: string;
    try {
      ({ acpxRecordId } = await this.readSessionRecord(input));
    } catch {
      return {}; // acpx session already gone → nothing to delete
    }
    // Close the acpx session (terminates the queue owner + agent process since
    // acpx >=0.10), then unlink its on-disk files. See deleteAcpxSessionFiles for
    // the residual orphan-stream-file risk this leaves (a file-unlink timing /
    // Windows file-lock issue, not a live process — notably on Windows).
    await this.removeSession(input);
    await deleteAcpxSessionFiles({ acpxRecordId });
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
    let acpxRecordId: string;
    try {
      ({ acpxRecordId } = await this.readSessionRecord(input));
    } catch {
      return {}; // acpx session already gone → no warm process to free
    }
    // Kill ONLY the warm queue-owner process; do NOT `sessions close` it (that
    // marks the record `closed` → unresumable, history lost). The record stays
    // open, so the next prompt resumes with full history.
    await terminateAcpxQueueOwner(acpxRecordId);
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
    const cacheKey = this.recordIdCacheKey(input);
    let acpxRecordId = this.recordIdCache.get(cacheKey);
    if (!acpxRecordId) {
      try {
        ({ acpxRecordId } = await this.readSessionRecord(input));
      } catch {
        return { warm: false }; // acpx session gone → nothing can be warm
      }
      this.recordIdCache.set(cacheKey, acpxRecordId);
    }
    const pid = await readQueueOwnerPid(acpxRecordId);
    return { warm: pid !== undefined && isProcessAlive(pid) };
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
    options: { verbose?: boolean; format?: "quiet" | "json" } = {},
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

  private spawnEnvironment(input: ClaudeExecutionSettings): NodeJS.ProcessEnv | undefined {
    return (this.options.resolveSpawnEnvironment ?? resolveClaudeSpawnEnvironment)(input);
  }

  private withSpawnEnvironment(
    input: ClaudeExecutionSettings,
    options?: CommandRunnerOptions,
  ): CommandRunnerOptions | undefined {
    const env = this.spawnEnvironment(input);
    return env ? { ...(options ?? {}), env } : options;
  }
}

export interface SpawnCaptureOptions extends CommandRunnerOptions {
  cwd?: string;
  /** Test seam: replaces node:child_process spawn. */
  spawnFn?: typeof spawn;
  /** Test seam: replaces terminateProcessTree for timeout kills. */
  killProcessTreeFn?: (pid: number) => Promise<void>;
}

export function spawnCapture(
  command: string,
  args: string[],
  options?: SpawnCaptureOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const spawnFn = options?.spawnFn ?? spawn;
    const child = spawnFn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let stderrTail = "";

    const timeoutId =
      typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? setTimeout(() => {
            // Same kill semantics as the acpx-cli transport's timed-out runner:
            // tear down the whole spawned tree so no orphan keeps holding the lane.
            const kill = options.killProcessTreeFn
              ?? ((pid: number) => terminateProcessTree(pid, { detachedProcessGroup: false }));
            void kill(child.pid ?? 0);
            reject(new CommandTimeoutError(options.timeoutMs!, [command, ...args].join(" "), {
              stage: options.stage,
              stdout,
              stderr,
            }));
          }, options.timeoutMs)
        : undefined;

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      if (!options?.onStderrLine) return;
      stderrTail += text;
      // Split on both \n and \r so Windows CRLF and bare-\r progress bars both emit lines.
      const matches = stderrTail.split(/\r\n|\r|\n/);
      // Last element is the unterminated tail (or "" if input ended on a separator).
      stderrTail = matches.pop() ?? "";
      for (const line of matches) {
        options.onStderrLine(line);
      }
    });
    child.on("error", (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });
    child.on("close", (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (options?.onStderrLine && stderrTail.length > 0) {
        options.onStderrLine(stderrTail);
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function defaultRunner(
  command: string,
  args: string[],
  options?: CommandRunnerOptions,
): Promise<CommandResult> {
  return await spawnCapture(command, args, options);
}

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
  const setIntervalFn = options.setIntervalFn ?? ((fn, delay) => setInterval(fn, delay));
  const clearIntervalFn = options.clearIntervalFn ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const rawStream = options.rawStream ?? false;
  // Raw streaming drains the buffer on a tight cadence so the live view updates ~5×/s
  // with low first-token latency. The batched paragraph path keeps the long fallback
  // window (it flushes whole paragraphs on `\n\n` and only times out on a stall).
  const maxSegmentWaitMs = options.maxSegmentWaitMs ?? (rawStream ? 200 : 30_000);
  const flushCheckIntervalMs = options.flushCheckIntervalMs ?? (rawStream ? 80 : 5_000);
  const now = options.now ?? (() => Date.now());

  return await new Promise((resolve, reject) => {
    const child = spawnPrompt(command, args);
    let stdout = "";
    let stderr = "";
    const toolEventMode: ToolEventMode = options.toolEventMode ?? "text";
    let flushPendingText = () => {};
    const state = createStreamingPromptState(options.formatToolCalls ?? false, {
      mode: toolEventMode,
      driver: options.driver,
      rawStream,
      onBeforeActivityEvent: () => {
        flushPendingText();
      },
      ...(onEvent && (toolEventMode === "structured" || toolEventMode === "both")
        ? { onToolEvent: (toolEvent) => onEvent({ type: "prompt.tool_event", event: toolEvent }) }
        : {}),
      // `onEvent` here is the synchronous `writeLine` path in bridge-server —
      // it emits a `prompt.thought` NDJSON line and returns immediately. The
      // async `onThought` chain lives on the client side (acpx-bridge-transport),
      // so this side has no callback to await before resolving the prompt.
      ...(onEvent
        ? { onThought: (chunk) => onEvent({ type: "prompt.thought", text: chunk }) }
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
    });
    let lastReplyAt = now();

    const flushBuffer = () => {
      // Raw streaming forwards the buffer verbatim (the live view concatenates chunks);
      // the batched path trims paragraph edges into discrete segments.
      const remaining = rawStream ? state.buffer : state.buffer.trim();
      if (remaining.length > 0) {
        state.buffer = "";
        onEvent?.({ type: "prompt.segment", text: remaining });
        lastReplyAt = now();
      }
    };

    flushPendingText = () => {
      for (const segment of state.segments.splice(0)) {
        onEvent?.({ type: "prompt.segment", text: segment });
        lastReplyAt = now();
      }
      flushBuffer();
    };

    const timer = setIntervalFn(() => {
      if (state.buffer.trim().length > 0 && now() - lastReplyAt >= maxSegmentWaitMs) {
        flushBuffer();
      }
    }, flushCheckIntervalMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => {
      const text = String(chunk);
      stdout += text;
      parseStreamingDataChunk(state, text);
      for (const segment of state.segments.splice(0)) {
        onEvent?.({ type: "prompt.segment", text: segment });
        lastReplyAt = now();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearIntervalFn(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearIntervalFn(timer);
      const remaining = state.finalize();
      if (remaining.length > 0) {
        onEvent?.({ type: "prompt.segment", text: remaining });
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function defaultPromptRunner(
  command: string,
  args: string[],
  onEvent?: (event: BridgePromptStreamEvent) => void,
  options?: StreamingPromptRunnerOptions,
): Promise<CommandResult> {
  return await runStreamingPrompt(command, args, onEvent, options);
}

async function shellSessionCreateRunner(
  command: string,
  args: string[],
  cwd: string,
  options?: CommandRunnerOptions,
): Promise<CommandResult> {
  return await spawnCapture(command, args, { ...options, cwd });
}

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

function isUnknownVerboseOption(stderr: string, stdout: string): boolean {
  const combined = `${stderr}\n${stdout}`;
  // Commander-style ("error: unknown option '--verbose'"), yargs, and generic "unrecognized".
  return /(unknown|unrecognized)\b[^\n]*--verbose/i.test(combined);
}
