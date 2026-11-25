import { spawn } from "node:child_process";

import { resolveSpawnCommand } from "../../process/spawn-command";
import {
  defaultAcpxPtyRunner,
  defaultAcpxRunner,
  managementTimeoutError,
  resolvePtyChildEnvironment,
  runWithSpawnTimeout,
  type AcpxSpawnOptions,
  type AcpxSpawnResult,
} from "../acpx-spawn";
import {
  resolveClaudeSpawnEnvironment,
  type ClaudeExecutionSettings,
} from "../../adapters/claude-settings-policy";
import type { NonInteractivePermissions, PermissionMode } from "../../config/types";
import type { PlanEntry, ToolUseEvent } from "../../channels/types.js";
import type {
  AgentCommand,
  AgentCapabilityProbeRequest,
  AgentCapabilityProbeResult,
  AgentSessionListQuery,
  AgentSessionListResult,
  EnsureSessionProgress,
  PermissionPolicy,
  PromptOptions,
  PromptUsage,
  ReplyQuotaContext,
  ResolvedSession,
  SessionMessageInput,
  SessionMessageReceipt,
  SessionTransport,
  SessionEffortState,
} from "../types";
import { getPromptText, normalizeCommandError } from "../prompt-output";
import { runAcpxControlCommand } from "../acpx-owner-control-retry";
import { isModelNotAdvertisedError } from "../model-not-advertised";
import {
  assertNoActiveNativeRestore,
  runSetModelWithNativeRestore,
  type NativeModelRestoreSession,
} from "../native-model-restore";
import { createStructuredPromptFile } from "../prompt-media";
import { createSerializedCallbackQueue } from "../serialized-callback-queue";
import {
  buildOverflowSummary,
  createQuotaGatedReplySink,
  createVerbatimReplySink,
} from "../quota-gated-reply-sink";
import { explainSessionSpawnFailure } from "../session-spawn-failure";
import { AcpxQueueOwnerLauncher, readQueueOwnerPid, terminateAcpxQueueOwner, terminateAcpxQueueOwnerVerified, type LaunchQueueOwnerInput, type QueueOwnerAdapterContext } from "../acpx-queue-owner-launcher";
import { classifyPreinstalledAdapterCommandShape } from "../../adapters/adapter-catalog";
import { migrateSessionArgvFile } from "../acpx-session-argv-migration";
import { renderAgentArgvIdentity } from "../../config/agent-launch";
import { isProcessAlive } from "../../daemon/daemon-files";
import { resolveToolEventMode, type ToolEventMode } from "../tool-event-mode.js";
import { runAgentSessionList } from "../agent-session-list";
import { CODEX_AGENT_NAME, codexSubagentPredicate } from "../codex-subagent-filter";
import { deleteAcpxSessionFiles } from "../acpx-session-files";
import { ACPX_MODEL_INSPECT_TIMEOUT_MS, probeAgentCapabilitiesViaInspector, type AcpxModelInspectFn } from "../acpx-model-inspector";
import { parseSessionStatusCatalog } from "../session-model-catalog";
import type { AgentCommandRegistry } from "../../config/agent-catalog";
import { parseSessionEffortRecord, requireAdvertisedSessionEffort, sessionEffortToReapply } from "../session-effort";
import {
  DEFAULT_MANAGEMENT_COMMAND_TIMEOUT_MS,
  type AcpxCommandStage,
} from "../command-timeouts";
import {
  buildPermissionArgs as sharedBuildPermissionArgs,
  buildSessionArgs as sharedBuildSessionArgs,
  buildAgentQueryArgs as sharedBuildAgentQueryArgs,
  buildPromptArgs as sharedBuildPromptArgs,
  buildQueueMessagePromptArgs as sharedBuildQueueMessagePromptArgs,
  isMissingAcpxSessionError,
  parseAcpxSessionRecordId,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_NON_INTERACTIVE,
} from "../acpx-command-builder";
import { MessageInjectionError } from "../message-injection";
import { AcpxQueueOverflowError, isAcpxQueueMessageOverflow, type AcpxQueueCleanupResult } from "../acpx-queue-overflow";
import { resolveAcpxHostPolicyEnv, resolveEffectiveAcpxEnv } from "../acpx-host-policy";
import {
  buildQueueOwnerLaunchInput,
  cleanupOverflowedOwnerFlow,
  coolQueueOwnerWith,
  ensureMcpQueueOwnerLaunched,
  probeInspectTimeout,
  queueOwnerRefFromResolvedSession,
  syncPersistedSessionEffortFlow,
  willReplaceQueueOwner,
} from "../acpx-session-ops";
import { runEnsureSessionFlow } from "../acpx-ensure-session";
import { runStreamingPromptFlow } from "../acpx-streaming-prompt";

interface AcpxCliTransportOptions {
  command?: string;
  sessionInitTimeoutMs?: number;
  /**
   * Time bound for one-shot management commands (sessions show/close, cancel,
   * set-mode, set model/effort, status, history). A hung acpx here would otherwise
   * wedge the session's serial request lane forever. Defaults to 30s.
   */
  managementCommandTimeoutMs?: number;
  permissionMode?: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissions;
  permissionPolicy?: string;
  /** Idle TTL (seconds) passed to acpx as `--ttl` on prompt; 0 = keep alive forever. */
  queueOwnerTtlSeconds?: number;
  /**
   * Advanced acpx host ceilings (plan B5, acpx 0.15.1+). `null`/absent follows
   * upstream defaults. Baked into the queue-owner HOST base env at
   * construction; warm owners keep startup values until recycled. Flows from
   * TransportConfig via the `{...config.transport}` spread.
   */
  acpxMaxIncomingMessageBytes?: number | null;
  acpxTerminalMaxOutputBytes?: number | null;
  /** Test seam for filtered per-agent process environments. */
  resolveSpawnEnvironment?: (input: ClaudeExecutionSettings) => NodeJS.ProcessEnv | undefined;
  createAdapterContext?: (input: {
    id: "codex" | "claude";
    sessionKey: string;
    agentCommand: string;
  }) => QueueOwnerAdapterContext;
  /** Test seams for the omp native model-restore recovery path. */
  ompModelRecovery?: { recoverOmpSessionModel: typeof import("../omp-model-recovery").recoverOmpSessionModel };
  queueOwnerAbsence?: { assertAcpxQueueOwnerAbsent: typeof import("../acpx-queue-owner-launcher").assertAcpxQueueOwnerAbsent };
  /** acpx registry for bare-driver probes; without it a bare driver is probe-unavailable. */
  loadAgentRegistry?: () => AgentCommandRegistry | null;
  /** Test seam for the model inspector (production calls acpx/runtime). */
  inspectAgentModels?: AcpxModelInspectFn;
}

// Unified spawn types (canonical definitions live in ../acpx-spawn.ts).
type CommandResult = AcpxSpawnResult;
type RunOptions = AcpxSpawnOptions;

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

interface StreamingPromptHooks {
  spawnPrompt?: (command: string, args: string[]) => PromptStreamProcess;
  setIntervalFn?: (fn: () => void, delay: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
  maxSegmentWaitMs?: number;
  flushCheckIntervalMs?: number;
  now?: () => number;
}

type CommandRunner = (command: string, args: string[], options?: RunOptions) => Promise<CommandResult>;
type PtyRunner = (command: string, args: string[], options?: RunOptions) => Promise<CommandResult>;
const defaultRunner = defaultAcpxRunner;

const defaultPtyRunner = defaultAcpxPtyRunner;

type QueueOwnerLaunchPort = Pick<AcpxQueueOwnerLauncher, "launch"> & {
  wouldReuse?(input: LaunchQueueOwnerInput): Promise<boolean>;
  cool?(acpxRecordId: string): Promise<void>;
};

export class AcpxCliTransport implements SessionTransport {
  private readonly command: string;
  private readonly sessionInitTimeoutMs: number;
  private readonly managementCommandTimeoutMs: number;
  private permissionMode: PermissionMode;
  private nonInteractivePermissions: NonInteractivePermissions;
  private permissionPolicy: string | undefined;
  private readonly hostPolicyEnv: Record<string, string>;
  /** True when any ceiling is configured; gates env attachment so unset policy stays bit-identical. */
  private readonly hostPolicyConfigured: boolean;
  private readonly queueOwnerTtlSeconds: number | undefined;
  private readonly runCommand: CommandRunner;
  private readonly runPtyCommand: PtyRunner;
  private readonly ompModelRecovery: AcpxCliTransportOptions["ompModelRecovery"];
  private readonly queueOwnerAbsence: AcpxCliTransportOptions["queueOwnerAbsence"];
  private readonly queueOwnerLauncher: QueueOwnerLaunchPort;
  private readonly streamingHooks: StreamingPromptHooks;
  private readonly resolveSpawnEnvironment: (input: ClaudeExecutionSettings) => NodeJS.ProcessEnv | undefined;
  private readonly createAdapterContext?: AcpxCliTransportOptions["createAdapterContext"];
  private readonly probeLoadAgentRegistry: AcpxCliTransportOptions["loadAgentRegistry"];
  private readonly probeInspectAgentModels: AcpxCliTransportOptions["inspectAgentModels"];

  constructor(
    options: AcpxCliTransportOptions,
    runCommand: CommandRunner = defaultRunner,
    runPtyCommand: PtyRunner = defaultPtyRunner,
    queueOwnerLauncher?: QueueOwnerLaunchPort,
    streamingHooks: StreamingPromptHooks = {},
  ) {
    this.command = options.command ?? "acpx";
    this.sessionInitTimeoutMs = options.sessionInitTimeoutMs ?? 120_000;
    this.managementCommandTimeoutMs = options.managementCommandTimeoutMs ?? DEFAULT_MANAGEMENT_COMMAND_TIMEOUT_MS;
    this.permissionMode = options.permissionMode ?? DEFAULT_PERMISSION_MODE;
    this.nonInteractivePermissions = options.nonInteractivePermissions ?? DEFAULT_NON_INTERACTIVE;
    this.permissionPolicy = options.permissionPolicy;
    this.queueOwnerTtlSeconds = options.queueOwnerTtlSeconds;
    this.runCommand = runCommand;
    this.runPtyCommand = runPtyCommand;
    // Plan B5: host ceilings ride every acpx child env on this lane (not just
    // the queue-owner base): agent-specific env first, policy overlaid last so
    // config can never be shadowed by inheritance.
    this.hostPolicyEnv = resolveAcpxHostPolicyEnv({
      acpxMaxIncomingMessageBytes: options.acpxMaxIncomingMessageBytes,
      acpxTerminalMaxOutputBytes: options.acpxTerminalMaxOutputBytes,
    });
    this.hostPolicyConfigured = Object.keys(this.hostPolicyEnv).length > 0;
    this.queueOwnerLauncher = queueOwnerLauncher ?? new AcpxQueueOwnerLauncher({
      ...(this.hostPolicyConfigured ? { baseEnv: { ...process.env, ...this.hostPolicyEnv } } : {}),
      acpxCommand: this.command,
      // Coordinator sessions pre-spawn the queue owner here (before `acpx prompt`),
      // so the owner's warm window must be set at launch — the prompt's `--ttl`
      // can't extend an already-running owner. Launcher ttl is milliseconds.
      ...(typeof this.queueOwnerTtlSeconds === "number" && Number.isFinite(this.queueOwnerTtlSeconds)
        ? { ttlMs: this.queueOwnerTtlSeconds * 1000 }
        : {}),
    });
    this.streamingHooks = streamingHooks;
    this.resolveSpawnEnvironment = options.resolveSpawnEnvironment ?? resolveClaudeSpawnEnvironment;
    this.createAdapterContext = options.createAdapterContext;
    this.probeLoadAgentRegistry = options.loadAgentRegistry;
    this.probeInspectAgentModels = options.inspectAgentModels;
    this.ompModelRecovery = options.ompModelRecovery;
    this.queueOwnerAbsence = options.queueOwnerAbsence;
  }

  // Defense-in-depth for the affinity/transport boundary: a session whose
  // persisted affinity selects the Runtime engine must never be executed by
  // the CLI transport (which would bypass the Runtime ownership fence and
  // start a second, CLI-owned queue owner for the same physical session).
  private assertCliAffinity(session: ResolvedSession): void {
    if (session.transportEngine === "runtime") {
      throw new Error(
        `transport mismatch: session "${session.alias}" is bound to engine "runtime" but the active transport is acpx-cli; refusing to execute on the wrong engine (migrate the binding to cli or switch transport.type to acpx-bridge)`,
      );
    }
  }

  // acpx-cli transport does not stream stderr back to the caller, so "note" progress
  // is never emitted. Users on this transport still see the initial "spawn" hint from
  // CommandRouter (emitted before the call) but will not receive mid-flight updates.
  async ensureSession(session: ResolvedSession, _onProgress?: (progress: EnsureSessionProgress) => void): Promise<void> {
    this.assertCliAffinity(session);
    this.invalidateRecordIdCache(session);
    try {
      await this.runEnsureSession(session);
    } catch (error) {
      // Different agent adapters advertise model ids in different formats (e.g. the two
      // codex adapters disagree: `gpt-5.5[high]` vs `gpt-5.5/high`), so a model valid for
      // one adapter is rejected by another and acpx hard-fails session creation. A stale /
      // cross-adapter / mistyped model override must never make a session uncreatable —
      // drop it and retry once, falling back to the agent adapter's default model.
      const requestedModel = session.model?.trim();
      if (requestedModel && isModelNotAdvertisedError(error instanceof Error ? error.message : null)) {
        try {
          await this.runEnsureSession({ ...session, model: undefined });
        } catch (retryError) {
          throw explainSessionSpawnFailure(session, retryError);
        }
        return;
      }
      throw explainSessionSpawnFailure(session, error);
    }
  }

  private async runEnsureSession(session: ResolvedSession): Promise<void> {
    // Session-create vehicle: the plain runner when an explicit agent command
    // is set, the pty runner for bare agents. Chosen once, like the bridge's
    // run-vs-runSessionCreate split, so the shared flow needs no pty flag.
    const createRunner = session.agentCommand ? this.runCommand : this.runPtyCommand;
    const runCreateStep = (tail: string[], opts: { timeoutMs: number }): Promise<CommandResult> =>
      this.runCommandWithTimeout(createRunner, this.buildArgs(session, tail), {
        timeoutMs: opts.timeoutMs,
        env: this.effectiveSpawnEnvironment(session),
      });
    const outcome = await runEnsureSessionFlow(
      {
        migrateLegacyArgv: () => this.migrateLegacySessionArgvIfNeeded(session),
        runEnsure: runCreateStep,
        // The show probe resolves through `run` (never pty) and reports
        // success as a bare ok: any failure — missing session, timeout,
        // crash — means the session must be created fresh (tolerateShowFailure).
        runShow: async (tail, opts) => {
          await this.run(this.buildArgs(session, tail, "quiet"), {
            timeoutMs: opts.timeoutMs,
            env: this.effectiveSpawnEnvironment(session),
          });
          return { code: 0, stdout: "", stderr: "" };
        },
        runCreate: runCreateStep,
        repairSessionIndex: async () => false,
      },
      {
        sessionName: session.transportSession,
        sessionInitTimeoutMs: this.sessionInitTimeoutMs,
        showTimeoutCapMs: this.managementCommandTimeoutMs,
        verboseFallback: false,
        epermRepair: false,
        tolerateEnsureFailure: true,
        tolerateShowFailure: true,
        mapTimeoutError: (error) => { throw error; },
      },
    );
    if (!outcome.ok) {
      // `sessions new` settled non-zero: same text the old `run()` throw
      // produced, so the outer explainSessionSpawnFailure mapping is unchanged.
      const failed = outcome.failure.created ?? outcome.failure.ensured;
      const detail = failed
        ? normalizeCommandError(failed) ?? `command failed with exit code ${failed.code}`
        : "command failed";
      throw new Error(detail);
    }
  }

  async listAgentSessions(query: AgentSessionListQuery): Promise<AgentSessionListResult | undefined> {
    return await runAgentSessionList({
      filterCwd: query.filterCwd,
      runList: async (includeFilterCwd) => {
        const args = this.buildAgentQueryArgs(query, "json", [
          "sessions",
          "list",
          ...(includeFilterCwd && query.filterCwd ? ["--filter-cwd", query.filterCwd] : []),
          ...(query.cursor ? ["--cursor", query.cursor] : []),
        ]);
        return await this.runCommandWithTimeout(this.runCommand, args, {
          timeoutMs: this.sessionInitTimeoutMs,
          env: this.effectiveSpawnEnvironment(query),
        });
      },
      formatError: (result) => normalizeCommandError(result) ?? `command failed with exit code ${result.code}`,
      // Codex's session list leaks native subagent threads; hide them (fail-open).
      // Gate on driver so custom-named codex agents (driver "codex") are covered too.
      isSubagentSession: (query.driver ?? query.agent) === CODEX_AGENT_NAME ? codexSubagentPredicate() : undefined,
    });
  }

  async tailSessionHistory(session: ResolvedSession, lines: number): Promise<{ text: string }> {
    this.assertCliAffinity(session);
    const candidates = [
      ["sessions", "history", session.transportSession, "--limit", String(lines)],
      ["sessions", "history", "quiet", "-s", session.transportSession, String(lines)],
      ["sessions", "history", "quiet", session.transportSession, String(lines)],
      ["sessions", "history", "-s", session.transportSession, "--tail", String(lines)],
      ["sessions", "history", session.transportSession, "--tail", String(lines)],
      ["sessions", "history", "--name", session.transportSession, "--tail", String(lines)],
    ];

    // One shared deadline across all candidate invocations so a hung acpx
    // bounds the whole method at managementCommandTimeoutMs, not per candidate.
    const deadline = Date.now() + this.managementCommandTimeoutMs;
    let lastResult: CommandResult | undefined;
    for (const tail of candidates) {
      const args = this.buildArgs(session, tail);
      const result = await this.runCommandWithTimeout(this.runCommand, args, {
        timeoutMs: Math.max(deadline - Date.now(), 1),
        stage: "session-history",
        env: this.effectiveSpawnEnvironment(session),
      });
      if (result.code === 0) {
        return { text: result.stdout.trimEnd() };
      }
      lastResult = result;
    }

    const detail = lastResult ? normalizeCommandError(lastResult) ?? `command failed with exit code ${lastResult.code}` : "command failed";
    throw new Error(detail);
  }

  async prompt(
    session: ResolvedSession,
    text: string,
    reply?: (text: string) => Promise<void>,
    replyContext?: ReplyQuotaContext,
    options?: PromptOptions,
  ): Promise<{ text: string }> {
    this.assertCliAffinity(session);
    this.assertNoActiveRecovery(session);
    await this.syncPersistedSessionEffort(session);
    await this.launchMcpQueueOwnerIfNeeded(session);
    const structuredPrompt = await createStructuredPromptFile(text, options?.media);
    const args = this.buildPromptArgs(session, text, structuredPrompt?.filePath);
    try {
      if (reply || options?.onSegment || options?.onToolEvent || options?.onThought || options?.onPlan || options?.onUsage || options?.onCommands) {
        const effectiveReplyMode = session.effectiveReplyMode ?? session.replyMode;
        const formatToolCalls = (effectiveReplyMode ?? "verbose") === "verbose";
        // replyMode "stream" → raw token streaming (one live bubble, low latency).
        const rawStream = effectiveReplyMode === "stream";
        let toolEventMode = resolveToolEventMode(options);
        // Safety net: structured/both without an onToolEvent handler would
        // silently drop tool calls. Demote to 'text' so verbose tool calls
        // still surface in the reply stream.
        if ((toolEventMode === "structured" || toolEventMode === "both") && !options?.onToolEvent) {
          toolEventMode = "text";
        }
        const { result, overflowCount } = await this.runStreamingPrompt(
          this.command,
          args,
          reply,
          formatToolCalls,
          toolEventMode,
          replyContext,
          options?.onSegment,
          options?.onToolEvent,
          options?.onThought,
          options?.onPlan,
          options?.onUsage,
          options?.onCommands,
          rawStream,
          this.effectiveSpawnEnvironment(session),
          session.driver ?? session.agent,
        );
        const baseText = getPromptText(result);
        if (!reply) {
          return { text: baseText };
        }
        const summary = buildOverflowSummary(overflowCount);
        // Streaming mode already pushed every segment through reply() (mid quota).
        // Returning baseText again would duplicate what the user just saw. Only
        // surface a final-tier text when overflow happened — in that case the
        // summary is new info AND baseText carries the agent's final answer that
        // may have been partially or fully dropped from the stream.
        return { text: summary ? `${summary}\n\n${baseText}` : "" };
      }
      // Prompts are deliberately NOT bounded by a total-duration timeout:
      // long agent turns are legitimate (see command-timeouts.ts).
      const spawnOptions = this.withSpawnEnvironment(session);
      const result = spawnOptions
        ? await this.runCommand(this.command, args, spawnOptions)
        : await this.runCommand(this.command, args);
      return { text: getPromptText(result) };
    } catch (error) {
      if (!isAcpxQueueMessageOverflow(error)) {
        throw error;
      }
      const cleanup = await this.cleanupOverflowedOwner(session);
      throw new AcpxQueueOverflowError(cleanup);
    } finally {
      try {
        await structuredPrompt?.cleanup();
      } catch {
        // Prompt outcome is more important than best-effort temp file cleanup.
      }
    }
  }

  async injectMessage(
    session: ResolvedSession,
    input: SessionMessageInput,
  ): Promise<SessionMessageReceipt> {
    this.assertCliAffinity(session);
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

    this.assertNoActiveRecovery(session);
    await this.syncPersistedSessionEffort(session);
    await this.launchMcpQueueOwnerIfNeeded(session);
    await this.run(
      sharedBuildQueueMessagePromptArgs(
        { ...this.sessionInput(session), queueOwnerTtlSeconds: this.queueOwnerTtlSeconds },
        session.transportSession,
        input.text,
      ),
      this.withSpawnEnvironment(session, {
        timeoutMs: this.managementCommandTimeoutMs,
        stage: "inject-message",
      }),
    );
    return { status: "queued", modeUsed: "queue" };
  }

  async setMode(session: ResolvedSession, modeId: string): Promise<void> {
    this.assertCliAffinity(session);
    this.assertNoActiveRecovery(session);
    await this.runControl(this.buildArgs(session, [
      "set-mode",
      "-s",
      session.transportSession,
      modeId,
    ]), this.withSpawnEnvironment(session, {
      timeoutMs: this.managementCommandTimeoutMs,
      stage: "set-mode",
    }));
  }

  /**
   * Native-recovery lease maps and key helpers now live in
   * ../native-model-restore.ts (shared across lanes so two transports on the
   * same physical OMP session contend for one recovery).
   */

  /**
   * Native-restore identity for a lane session. Both lanes build the same
   * shape (CLI: transportSession; bridge: name).
   */
  private nativeRestoreSession(session: ResolvedSession): NativeModelRestoreSession {
    return {
      transportSession: session.transportSession,
      cwd: session.cwd,
      agent: session.agent,
      ...(session.driver ? { driver: session.driver } : {}),
      ...(session.agentCommand ? { agentCommand: session.agentCommand } : {}),
      ...(session.acpxAgent ? { acpxAgent: session.acpxAgent } : {}),
      ...(session.rawCommand ? { rawCommand: session.rawCommand } : {}),
      ...(session.agentArgv ? { agentArgv: session.agentArgv } : {}),
    };
  }

  /**
   * Native-restore guard lives in ../native-model-restore.ts (shared). Kept
   * as a method so the five guarded paths read unchanged.
   */
  private assertNoActiveRecovery(session: ResolvedSession): void {
    assertNoActiveNativeRestore(this.nativeRestoreSession(session));
  }

  private buildSetModelArgs(session: ResolvedSession, modelId: string): string[] {
    return this.buildArgs({ ...session, model: modelId }, [
      "set",
      "-s",
      session.transportSession,
      "model",
      modelId,
    ]);
  }

  // acpx's generic config setter: `<agent> set -s <name> model '<id>'`. Build args
  // with the NEW model so the global --model and the `set model` value agree.
  // acpx validates the id against the agent's advertised models and applies it to
  // a live queue owner immediately (or persists it for the next turn when idle).
  //
  // OMP native model-restore recovery now lives in ../native-model-restore.ts
  // (shared with the bridge); only the I/O closures below are lane-specific.
  async setModel(session: ResolvedSession, modelId: string): Promise<void> {
    this.assertCliAffinity(session);
    await runSetModelWithNativeRestore(
      this.nativeRestoreSession(session),
      modelId,
      {
        readSessionRecord: (timeoutMs) => this.readSessionRecord(session, timeoutMs),
        runSetModel: (id, opts) => this.runControl(
          this.buildSetModelArgs(session, id),
          this.withSpawnEnvironment({ ...session, model: id }, {
            timeoutMs: opts.timeoutMs,
            stage: "set-model",
          }),
          opts.deadlineAt,
        ),
        envForModel: (id?) => this.effectiveSpawnEnvironment(
          id === undefined ? session : { ...session, model: id },
        ),
        managementTimeoutMs: this.managementCommandTimeoutMs,
        ...(this.ompModelRecovery ? { ompModelRecovery: this.ompModelRecovery } : {}),
        ...(this.queueOwnerAbsence ? { queueOwnerAbsence: this.queueOwnerAbsence } : {}),
      },
    );
  }

  // Read the session's current model and the agent-advertised available ids from
  // `<agent> status --format json`. A broken payload throws instead of posing
  // as an empty catalog.
  async prepareSessionCommands(session: ResolvedSession): Promise<AgentCommand[] | undefined> {
    await this.ensureSession(session);
    const args = this.buildAgentQueryArgs(this.sessionInput(session), 'json', ['status','-s',session.transportSession]);
    const result = await this.runCommandWithTimeout(this.runCommand,args,{timeoutMs:this.managementCommandTimeoutMs,stage:'get-session-model',env:this.effectiveSpawnEnvironment(session)});
    if(result.code !== 0) {
      const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
      throw new Error(detail);
    }
    const raw = JSON.parse(result.stdout) as {availableCommands?: AgentCommand[]};
    return raw.availableCommands;
  }

  async getSessionModel(session: ResolvedSession): Promise<{ current?: string; available: string[] }> {
    this.assertCliAffinity(session);
    const args = this.buildAgentQueryArgs(
      this.sessionInput(session),
      "json",
      ["status", "-s", session.transportSession],
    );
    const result = await this.runCommandWithTimeout(this.runCommand, args, {
      timeoutMs: this.managementCommandTimeoutMs,
      stage: "get-session-model",
      env: this.effectiveSpawnEnvironment(session),
    });
    if (result.code !== 0) {
      const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
      throw new Error(detail);
    }
    return parseSessionStatusCatalog(result.stdout, `session "${session.transportSession}"`);
  }

  async probeAgentCapabilities(input: AgentCapabilityProbeRequest): Promise<AgentCapabilityProbeResult> {
    return probeAgentCapabilitiesViaInspector(input, {
      timeoutMs: probeInspectTimeout(this.sessionInitTimeoutMs),
      ...(this.probeLoadAgentRegistry ? { loadAgentRegistry: this.probeLoadAgentRegistry } : {}),
      ...(this.probeInspectAgentModels ? { inspectAgentModels: this.probeInspectAgentModels } : {}),
    });
  }

  async getSessionEffort(session: ResolvedSession): Promise<SessionEffortState> {
    this.assertCliAffinity(session);
    const output = await this.run(this.buildArgs(session, [
      "sessions",
      "show",
      session.transportSession,
    ], "json"), this.withSpawnEnvironment(session, {
      timeoutMs: this.managementCommandTimeoutMs,
      stage: "get-session-effort",
    }));
    const effort = parseSessionEffortRecord(output);
    return effort
      ? { current: effort.current, available: effort.available }
      : { available: [] };
  }

  async setSessionEffort(session: ResolvedSession, effort: string): Promise<void> {
    this.assertCliAffinity(session);
    this.assertNoActiveRecovery(session);
    const record = await this.readSessionEffortRecord(session);
    await this.applyAdvertisedSessionEffort(session, effort, record);
  }

  private async syncPersistedSessionEffort(session: ResolvedSession): Promise<void> {
    // Orchestration lives in ../acpx-session-ops.ts; only the I/O is lane-specific.
    await syncPersistedSessionEffortFlow(
      session.effort,
      (record) => parseAcpxSessionRecordId(record)?.acpxRecordId,
      {
        readRecord: () => this.readSessionEffortRecord(session),
        ownerWillBeReplaced: (recordId) => this.queueOwnerWillBeReplaced(session, recordId),
        coolOwner: (recordId) => this.coolQueueOwner(recordId),
        applyEffort: (effort, record) => this.applyAdvertisedSessionEffort(session, effort, record),
      },
    );
  }

  private async coolQueueOwner(acpxRecordId: string): Promise<void> {
    await coolQueueOwnerWith(this.queueOwnerLauncher, acpxRecordId);
  }

  private async queueOwnerWillBeReplaced(
    session: ResolvedSession,
    acpxRecordId: string | undefined,
  ): Promise<boolean> {
    return await willReplaceQueueOwner({
      coordinatorSession: session.mcpCoordinatorSession,
      acpxRecordId,
      wouldReuse: this.queueOwnerLauncher.wouldReuse?.bind(this.queueOwnerLauncher),
      buildLaunchInput: (recordId) => this.queueOwnerLaunchInput(session, recordId),
    });
  }

  private queueOwnerLaunchInput(session: ResolvedSession, acpxRecordId: string): LaunchQueueOwnerInput {
    return buildQueueOwnerLaunchInput(queueOwnerRefFromResolvedSession(session), acpxRecordId, {
      agentEnv: this.spawnEnvironment(session),
      hostPolicyEnv: this.hostPolicyEnv,
      permissionMode: this.permissionMode,
      nonInteractivePermissions: this.nonInteractivePermissions,
      ...(this.createAdapterContext ? { createAdapterContext: this.createAdapterContext } : {}),
    });
  }

  private async readSessionEffortRecord(session: ResolvedSession): Promise<string> {
    return await this.run(this.buildArgs(session, [
      "sessions",
      "show",
      session.transportSession,
    ], "json"), this.withSpawnEnvironment(session, {
      timeoutMs: this.managementCommandTimeoutMs,
      stage: "get-session-effort",
    }));
  }

  private async applyAdvertisedSessionEffort(
    session: ResolvedSession,
    effort: string,
    record: string,
  ): Promise<void> {
    const advertised = requireAdvertisedSessionEffort(record, effort);
    await this.runControl(this.buildArgs(session, [
      "set",
      "-s",
      session.transportSession,
      advertised.configId,
      effort,
    ]), this.withSpawnEnvironment(session, {
      timeoutMs: this.managementCommandTimeoutMs,
      stage: "set-session-effort",
    }));
  }

  async cancel(session: ResolvedSession): Promise<{ cancelled: boolean; message: string }> {
    this.assertCliAffinity(session);
    const output = await this.runControl(this.buildArgs(session, [
      "cancel",
      "-s",
      session.transportSession,
    ]), this.withSpawnEnvironment(session, {
      timeoutMs: this.managementCommandTimeoutMs,
      stage: "cancel",
    }));
    return {
      cancelled: true,
      message: output.trim(),
    };
  }

  async resumeAgentSession(session: ResolvedSession, agentSessionId: string): Promise<void> {
    this.assertCliAffinity(session);
    this.invalidateRecordIdCache(session);
    const args = this.buildArgs(session, [
      "sessions",
      "new",
      "--name",
      session.transportSession,
      "--resume-session",
      agentSessionId,
    ]);
    const runResume = session.agentCommand ? this.run : this.runWithPty;
    try {
      await runResume.call(this, args, {
        timeoutMs: this.sessionInitTimeoutMs,
        env: this.effectiveSpawnEnvironment(session),
      });
    } catch (error) {
      throw explainSessionSpawnFailure(session, error);
    }
  }


  async updatePermissionPolicy(policy: PermissionPolicy): Promise<void> {
    this.permissionMode = policy.permissionMode;
    this.nonInteractivePermissions = policy.nonInteractivePermissions;
    this.permissionPolicy = policy.permissionPolicy;
  }

  async removeSession(session: ResolvedSession): Promise<void> {
    this.assertCliAffinity(session);
    this.invalidateRecordIdCache(session);
    const result = await runAcpxControlCommand(() => this.runCommandWithTimeout(this.runCommand, this.buildArgs(session, [
      "sessions",
      "close",
      session.transportSession,
    ]), this.withSpawnEnvironment(session, {
      timeoutMs: this.managementCommandTimeoutMs,
      stage: "remove-session",
    })));
    if (result.code === 0) {
      return;
    }
    if (isMissingAcpxSessionError(result.stderr, result.stdout)) {
      return;
    }
    const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
    throw new Error(detail);
  }

  async deleteSession(session: ResolvedSession): Promise<void> {
    this.assertCliAffinity(session);
    let acpxRecordId: string;
    try {
      ({ acpxRecordId } = await this.readSessionRecord(session));
    } catch {
      return; // acpx session already gone → nothing to delete
    }
    // Close the acpx session (terminates the queue owner + agent process since
    // acpx >=0.10), then unlink its on-disk files. See deleteAcpxSessionFiles for
    // the residual orphan-stream-file risk this leaves (a file-unlink timing /
    // Windows file-lock issue, not a live process — notably on Windows).
    await this.removeSession(session);
    await deleteAcpxSessionFiles({ acpxRecordId });
  }

  async freeWarmProcess(session: ResolvedSession): Promise<void> {
    this.assertCliAffinity(session);
    let acpxRecordId: string;
    try {
      ({ acpxRecordId } = await this.readSessionRecord(session));
    } catch {
      return; // acpx session already gone → no warm process to free
    }
    // Kill ONLY the warm queue-owner process; do NOT `sessions close` it. Closing
    // marks the record `closed` (acpx excludes it from name lookup → unresumable,
    // history lost on next prompt). Terminating the owner leaves the record open,
    // so the next prompt resumes the same conversation with full history.
    await terminateAcpxQueueOwner(acpxRecordId);
  }

  private readonly recordIdCache = new Map<string, string>();

  // Same composite key as reapQueueOwners/defaultResolveRecordId — the record
  // id is stable for a given transport session, so cache it to avoid spawning
  // `acpx sessions show` on every poll tick.
  private recordIdCacheKey(session: ResolvedSession): string {
    return JSON.stringify([session.agent, session.agentCommand ?? null, session.cwd, session.transportSession]);
  }

  // Any lifecycle op that can create/close a record under the same transport
  // session name (notably native re-attach after delete reuses the name) must
  // drop the cached record id, or warmth polls keep reading the dead record's
  // lock forever.
  private invalidateRecordIdCache(session: ResolvedSession): void {
    this.recordIdCache.delete(this.recordIdCacheKey(session));
  }

  async isSessionWarm(session: ResolvedSession): Promise<boolean> {
    this.assertCliAffinity(session);
    const cacheKey = this.recordIdCacheKey(session);
    let acpxRecordId = this.recordIdCache.get(cacheKey);
    if (!acpxRecordId) {
      try {
        ({ acpxRecordId } = await this.readSessionRecord(session));
      } catch {
        return false; // acpx session gone → nothing can be warm
      }
      this.recordIdCache.set(cacheKey, acpxRecordId);
    }
    const pid = await readQueueOwnerPid(acpxRecordId);
    if (pid === undefined) {
      return false;
    }
    return isProcessAlive(pid);
  }

  async hasSession(session: ResolvedSession): Promise<boolean> {
    this.assertCliAffinity(session);
    const result = await this.runCommandWithTimeout(this.runCommand, this.buildArgs(session, [
      "sessions",
      "show",
      session.transportSession,
    ]), this.withSpawnEnvironment(session, {
      timeoutMs: this.managementCommandTimeoutMs,
      stage: "has-session",
    }));

    return result.code === 0;
  }

  private async launchMcpQueueOwnerIfNeeded(session: ResolvedSession): Promise<void> {
    // Bot-owned logical sessions auto-ensure their record here (readOwned
    // keeps that CLI-only behavior); the bridge reads strictly instead.
    await ensureMcpQueueOwnerLaunched({
      coordinatorSession: session.mcpCoordinatorSession,
      readRecord: () => this.readOwnedSessionRecord(session),
      launch: (input) => this.queueOwnerLauncher.launch(input),
      onPreparedAgentCommand: (agentCommand) => { session.agentCommand = agentCommand; },
      buildLaunchInput: (recordId) => this.queueOwnerLaunchInput(session, recordId),
    });
  }

  // A bot-owned Conversation session (Direct or Group member) is created as a
  // logical row only; nothing ensures its acpx record, so the first turn
  // arrives with no named session and every lookup here and in `prompt` fails.
  // Missing is not "the caller's intent is broken": create the record, then read
  // it back. Any other read failure still fails closed.
  private async readOwnedSessionRecord(session: ResolvedSession): Promise<{ acpxRecordId: string; agentSessionId?: string; acpSessionId?: string }> {
    try {
      return await this.readSessionRecord(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isMissingAcpxSessionError("", message)) {
        throw error;
      }
    }
    await this.ensureSession(session);
    return await this.readSessionRecord(session);
  }

  private async readSessionRecord(session: ResolvedSession, timeoutMs = this.managementCommandTimeoutMs): Promise<{ acpxRecordId: string; agentSessionId?: string; acpSessionId?: string }> {
    const result = await this.runCommandWithTimeout(this.runCommand, this.buildArgs(session, [
      "sessions",
      "show",
      session.transportSession,
    ], "json"), this.withSpawnEnvironment(session, {
      timeoutMs,
      stage: "read-session-record",
    }));
    if (result.code !== 0) {
      const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
      throw new Error(detail);
    }
    const record = parseAcpxSessionRecordId(result.stdout);
    if (!record) {
      throw new Error("failed to resolve acpx session record id");
    }
    // The ACP session id is the native id for adapters that expose one (OMP
    // returns its own session id as the ACP id); the provider id is the
    // fallback for adapters that only publish a provider-native id.
    let acpSessionId: string | undefined;
    try {
      const parsed = JSON.parse(result.stdout) as { acpSessionId?: unknown };
      acpSessionId = typeof parsed.acpSessionId === "string" && parsed.acpSessionId.length > 0
        ? parsed.acpSessionId
        : undefined;
    } catch {
      acpSessionId = undefined;
    }
    return { ...record, ...(acpSessionId ? { acpSessionId } : {}) };
  }

  private async cleanupOverflowedOwner(session: ResolvedSession): Promise<AcpxQueueCleanupResult> {
    return await cleanupOverflowedOwnerFlow({
      cancel: () => this.cancel(session).then(() => {}),
      readRecordId: () => this.readSessionRecord(session).then((record) => record.acpxRecordId),
      terminate: (recordId) => terminateAcpxQueueOwnerVerified(recordId),
    });
  }

  /**
   * Backfill `agent_argv` into a legacy acpx session record before the session is
   * ensured/launched, so Windows can resume it with exact boundaries. Runs only
   * for structured launches (agentArgv present); fails closed on identity or argv
   * mismatches rather than reusing a session that would launch a different agent.
   */
  private async migrateLegacySessionArgvIfNeeded(session: ResolvedSession): Promise<void> {
    if (!session.agentArgv || session.agentArgv.length === 0) {
      return;
    }
    let recordId: string | null = null;
    try {
      ({ acpxRecordId: recordId } = await this.readSessionRecord(session));
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
    const result = await migrateSessionArgvFile(recordId, {
      agentCommand: renderAgentArgvIdentity(session.agentArgv),
      agentArgv: session.agentArgv,
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

  async getAgentSessionId(session: ResolvedSession): Promise<string | undefined> {
    this.assertCliAffinity(session);
    const record = await this.readSessionRecord(session);
    return record.agentSessionId;
  }

  private async run(args: string[], options?: RunOptions): Promise<string> {
    const result = await this.runCommandWithTimeout(this.runCommand, args, options);
    if (result.code !== 0) {
      const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
      throw new Error(detail);
    }
    return result.stdout;
  }

  /** `run` for owner-IPC control commands (cancel / sessions close / set-mode /
   *  set), retrying the acpx 0.19.x queue-owner shutdown race. See
   *  runAcpxControlCommand. */
  private async runControl(args: string[], options?: RunOptions, deadlineAt?: number): Promise<string> {
    const abortController = deadlineAt === undefined ? undefined : new AbortController();
    let deadlineTimer: NodeJS.Timeout | undefined;
    const run = async () => {
      const result = await runAcpxControlCommand(() => {
        if (deadlineAt === undefined) {
          return this.runCommandWithTimeout(this.runCommand, args, options);
        }
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0 || abortController!.signal.aborted) {
          throw managementTimeoutError(args, { ...options, timeoutMs: this.managementCommandTimeoutMs });
        }
        return this.runCommandWithTimeout(this.runCommand, args, {
          ...options,
          timeoutMs: remaining,
          signal: abortController!.signal,
        });
      });
      if (result.code !== 0) {
        const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
        throw new Error(detail);
      }
      return result.stdout;
    };
    if (deadlineAt === undefined) return run();
    const runPromise = run();
    try {
      return await Promise.race([
        runPromise,
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => {
            abortController!.abort();
            // Adopt run()'s own settlement: the inner timeout error carries
            // the subprocess output tails (the stage assertion depends on
            // them); a fresh error here would discard them. This only fires
            // when the deadline beats every inner bound, so run() settles
            // momentarily after the abort.
            void Promise.resolve(runPromise).then(
              () => reject(managementTimeoutError(args, { ...options, timeoutMs: this.managementCommandTimeoutMs })),
              (error) => reject(error),
            );
          }, Math.max(deadlineAt - Date.now(), 0));
        }),
      ]);
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  private async runWithPty(args: string[], options?: RunOptions): Promise<string> {
    const result = await this.runCommandWithTimeout(this.runPtyCommand, args, options);
    if (result.code !== 0) {
      const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
      throw new Error(detail);
    }
    return result.stdout;
  }

  private async runCommandWithTimeout(
    runner: CommandRunner | PtyRunner,
    args: string[],
    options?: RunOptions,
  ): Promise<CommandResult> {
    // Unified abort-racing timeout (see ../acpx-spawn.ts); the rendered
    // timeout message keeps the `--format`/`--cwd` redaction.
    return await runWithSpawnTimeout(runner, this.command, args, options);
  }

  private async runStreamingPrompt(
    command: string,
    args: string[],
    reply: ((text: string) => Promise<void>) | undefined,
    formatToolCalls: boolean = false,
    toolEventMode: ToolEventMode = "text",
    replyContext?: ReplyQuotaContext,
    onSegment?: (text: string) => void | Promise<void>,
    onToolEvent?: (event: ToolUseEvent) => void | Promise<void>,
    onThought?: (chunk: string) => void | Promise<void>,
    onPlan?: (entries: PlanEntry[]) => void | Promise<void>,
    onUsage?: (usage: PromptUsage) => void | Promise<void>,
    onCommands?: (commands: AgentCommand[]) => void | Promise<void>,
    rawStream: boolean = false,
    env?: NodeJS.ProcessEnv,
    driver?: string,
  ): Promise<{ result: CommandResult; overflowCount: number }> {
    const hooks = this.streamingHooks;
    const doSpawn = hooks.spawnPrompt
      ?? ((cmd, spawnArgs) => spawn(cmd, spawnArgs, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as PromptStreamProcess);
    // Shell lives in ../acpx-streaming-prompt.ts; the CLI keeps its delivery
    // semantics here: quota/verbatim reply sink, serialized callback queue,
    // and plan/usage/commands chains with first-error-wins collection.
    const transcriptEvents = createSerializedCallbackQueue();
    let planChain = Promise.resolve();
    let planError: unknown;
    let usageChain = Promise.resolve();
    let usageError: unknown;
    let commandsChain = Promise.resolve();
    let commandsError: unknown;
    const sink = reply
      ? rawStream
        ? createVerbatimReplySink(reply)
        : createQuotaGatedReplySink({
            reply,
            ...(replyContext ? { replyContext } : {}),
          })
      : null;
    const spawnSpec = resolveSpawnCommand(command, args);
    const { code, stdout, stderr, overflowCount } = await runStreamingPromptFlow({
      command: spawnSpec.command,
      args: spawnSpec.args,
      formatToolCalls,
      toolEventMode,
      ...(driver ? { driver } : {}),
      rawStream,
      spawnPrompt: doSpawn,
      ...(hooks.setIntervalFn ? { setIntervalFn: hooks.setIntervalFn } : {}),
      ...(hooks.clearIntervalFn ? { clearIntervalFn: hooks.clearIntervalFn } : {}),
      ...(hooks.maxSegmentWaitMs !== undefined ? { maxSegmentWaitMs: hooks.maxSegmentWaitMs } : {}),
      ...(hooks.flushCheckIntervalMs !== undefined ? { flushCheckIntervalMs: hooks.flushCheckIntervalMs } : {}),
      ...(hooks.now ? { now: hooks.now } : {}),
      handlers: {
        ...(onToolEvent
          ? {
              onToolEvent: (event) => {
                transcriptEvents.enqueue(() => onToolEvent(event));
              },
            }
          : {}),
        ...(onThought
          ? {
              onThought: (chunk) => {
                transcriptEvents.enqueue(() => onThought(chunk));
              },
            }
          : {}),
        ...(onPlan
          ? {
              onPlan: (entries) => {
                // Serialize handler invocations; first error wins.
                planChain = planChain
                  .then(() => onPlan(entries))
                  .catch((error) => {
                    planError ??= error;
                  });
              },
            }
          : {}),
        ...(onUsage
          ? {
              onUsage: (usage) => {
                // Serialize handler invocations; first error wins.
                usageChain = usageChain
                  .then(() => onUsage(usage))
                  .catch((error) => {
                    usageError ??= error;
                  });
              },
            }
          : {}),
        ...(onCommands
          ? {
              onCommands: (commands) => {
                // Serialize handler invocations; first error wins.
                commandsChain = commandsChain
                  .then(() => onCommands(commands))
                  .catch((error) => {
                    commandsError ??= error;
                  });
              },
            }
          : {}),
      },
      emitter: {
        emitSegment: (segment) => {
          transcriptEvents.enqueue(async () => {
            const segmentResult = onSegment?.(segment);
            sink?.feedSegment(segment);
            await segmentResult;
          });
        },
        finish: async () => {
          await Promise.all([
            transcriptEvents.drain(),
            planChain,
            usageChain,
            commandsChain,
          ]);
          // All queued text must reach the sink before it is finalized. This also
          // preserves ACP's text → activity → text order across async callbacks.
          const { overflowCount } = sink?.finalize() ?? { overflowCount: 0 };
          // Note: any aggregator trailing text is folded into the overflow
          // summary path via the final agent message (caller appends summary).
          // Wait for all in-flight reply() rejections to settle before deciding
          // whether to reject the prompt with a QuotaDeferredError.
          await (sink?.drain({ timeoutMs: 30_000 }) ?? Promise.resolve());
          const deferred = sink?.getPendingError();
          if (deferred) throw deferred;
          const transcriptError = transcriptEvents.getError();
          if (transcriptError) throw transcriptError;
          if (planError) throw planError;
          if (usageError) throw usageError;
          if (commandsError) throw commandsError;
          return overflowCount;
        },
      },
    });
    return { result: { code, stdout, stderr }, overflowCount };
  }

  private permissionInput() {
    return {
      permissionMode: this.permissionMode,
      nonInteractivePermissions: this.nonInteractivePermissions,
      permissionPolicy: this.permissionPolicy,
    };
  }

  /**
   * Effective acpx-host env for one child: agent env (or inheritance) with
   * configured ceilings overlaid last. Returns undefined when there is
   * neither agent env nor policy, preserving the legacy inherit path
   * (and warm-owner fingerprint stability) bit-identically.
   */
  private effectiveSpawnEnvironment(input: ClaudeExecutionSettings): NodeJS.ProcessEnv | undefined {
    const agentEnv = this.spawnEnvironment(input);
    if (!agentEnv && !this.hostPolicyConfigured) return undefined;
    return resolveEffectiveAcpxEnv(agentEnv, this.hostPolicyEnv);
  }

  // Internal primitive: agent-specific env only, WITHOUT host policy.
  // Never spawn directly from this — use effectiveSpawnEnvironment() (all
  // child env) or the merged queueOwnerLaunchInput() branch.
  private spawnEnvironment(input: ClaudeExecutionSettings): NodeJS.ProcessEnv | undefined {
    return this.resolveSpawnEnvironment(input);
  }
  private withSpawnEnvironment(
    input: ClaudeExecutionSettings,
    options?: RunOptions,
  ): RunOptions | undefined {
    const env = this.effectiveSpawnEnvironment(input);
    return env ? { ...(options ?? {}), env } : options;
  }

  private sessionInput(session: ResolvedSession) {
    return {
      agent: session.agent,
      agentCommand: session.agentCommand,
      acpxAgent: session.acpxAgent,
      rawCommand: session.rawCommand,
      cwd: session.cwd,
      model: session.model,
      permission: this.permissionInput(),
    };
  }

  private buildArgs(session: ResolvedSession, tail: string[], format: "json" | "quiet" = "quiet"): string[] {
    return sharedBuildSessionArgs(this.sessionInput(session), tail, { format });
  }

  private buildAgentQueryArgs(query: AgentSessionListQuery, format: "json" | "quiet", tail: string[]): string[] {
    return sharedBuildAgentQueryArgs(
      {
        agent: query.agent,
        agentCommand: query.agentCommand,
        acpxAgent: query.acpxAgent,
        rawCommand: query.rawCommand,
        cwd: query.cwd,
        permission: this.permissionInput(),
      },
      format,
      tail,
    );
  }

  private buildPromptArgs(
    session: ResolvedSession,
    text: string,
    promptFile?: string,
  ): string[] {
    const tail = promptFile
      ? ["prompt", "-s", session.transportSession, "--file", promptFile]
      : ["prompt", "-s", session.transportSession, text];

    return sharedBuildPromptArgs(
      { ...this.sessionInput(session), queueOwnerTtlSeconds: this.queueOwnerTtlSeconds },
      tail,
    );
  }

  private buildPermissionArgs(): string[] {
    return sharedBuildPermissionArgs(this.permissionInput());
  }
}

export const __acpxCliTransportForTests = {
  // Historic name; canonical implementation lives in ../acpx-spawn.ts.
  resolveChildEnvironment: resolvePtyChildEnvironment,
};

