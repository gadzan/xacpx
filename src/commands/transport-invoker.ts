import type { AppConfig, TransportConfig } from "../config/types";
import type { AppLogger } from "../logging/app-logger";
import type { SessionService } from "../sessions/session-service";
import type { AgentCommand, EnsureSessionProgress, PromptMediaInput, PromptUsage, ReplyQuotaContext, ResolvedSession, SessionTransport } from "../transport/types";
import type { PerfSpan } from "../perf/perf-tracer";
import type { SessionAgentCommandResolver } from "../transport/acpx-session-index";
import { PromptCommandError } from "../transport/prompt-output";
import type { PlanEntry, ToolUseEvent } from "../channels/types.js";
import { AutoInstallFailedError, MissingOptionalDepError } from "../recovery/errors";
import type { autoInstallOptionalDep as defaultAutoInstall } from "../recovery/auto-install-optional-dep";
import type { discoverParentPackagePaths as defaultDiscoverPaths } from "../recovery/discover-parent-package-paths";
import { translateAcpxNote } from "./translate-acpx-note";
import {
  summarizeTransportDiagnostic,
  summarizeTransportDiagnosticTail,
  summarizeTransportNdjson,
} from "./transport-diagnostics";
import { t } from "../i18n";
import { stableCoordinatorSession } from "../orchestration/coordinator-identity";
import {
  followClaudeBackgroundTurn,
  isClaudeAsyncAgentLaunch,
} from "../transport/claude-background-followup";

type AutoInstallFn = typeof defaultAutoInstall;
type DiscoverPathsFn = typeof defaultDiscoverPaths;
type FollowClaudeBackgroundTurnFn = typeof followClaudeBackgroundTurn;

export interface TransportInvokerDeps {
  transport: SessionTransport;
  logger: AppLogger;
  config?: AppConfig;
  sessions: SessionService;
  resolveSessionAgentCommand: SessionAgentCommandResolver;
  autoInstall: AutoInstallFn;
  discoverPaths: DiscoverPathsFn;
  /** Test seam for Claude's native-transcript continuation follower. */
  followClaudeBackgroundTurn?: FollowClaudeBackgroundTurnFn;
}

export class TransportInvoker {
  private readonly transport: SessionTransport;
  private readonly logger: AppLogger;
  private readonly config?: AppConfig;
  private readonly sessions: SessionService;
  private readonly resolveSessionAgentCommand: SessionAgentCommandResolver;
  private readonly autoInstall: AutoInstallFn;
  private readonly discoverPaths: DiscoverPathsFn;
  private readonly followClaudeBackgroundTurn: FollowClaudeBackgroundTurnFn;

  constructor(deps: TransportInvokerDeps) {
    this.transport = deps.transport;
    this.logger = deps.logger;
    this.config = deps.config;
    this.sessions = deps.sessions;
    this.resolveSessionAgentCommand = deps.resolveSessionAgentCommand;
    this.autoInstall = deps.autoInstall;
    this.discoverPaths = deps.discoverPaths;
    this.followClaudeBackgroundTurn = deps.followClaudeBackgroundTurn ?? followClaudeBackgroundTurn;
  }

  private async measureTransportCall<T>(
    operation: string,
    session: ResolvedSession,
    callback: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await callback();
      await this.logger.info(`transport.${operation}`, "transport operation completed", {
        operation,
        agent: session.agent,
        workspace: session.workspace,
        alias: session.alias,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      const diagnosticContext = error instanceof PromptCommandError
        ? {
            exitCode: error.exitCode,
            stdoutPreview: summarizeTransportDiagnostic(error.stdout),
            stdoutTailPreview: summarizeTransportDiagnosticTail(error.stdout),
            stdoutLength: error.stdout.length,
            ...summarizeTransportNdjson(error.stdout, "stdout"),
            stderrPreview: summarizeTransportDiagnostic(error.stderr),
            stderrTailPreview: summarizeTransportDiagnosticTail(error.stderr),
            stderrLength: error.stderr.length,
            ...summarizeTransportNdjson(error.stderr, "stderr"),
          }
        : {};
      await this.logger.error(`transport.${operation}.failed`, "transport operation failed", {
        operation,
        agent: session.agent,
        workspace: session.workspace,
        alias: session.alias,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        ...diagnosticContext,
      });
      throw error;
    }
  }

  private createProgressHandler(
    session: ResolvedSession,
    reply?: (text: string) => Promise<void>,
  ): { handler: (progress: EnsureSessionProgress) => void; dispose: () => void } {
    const startedAt = Date.now();
    let lastMessageAt = 0;
    const DEBOUNCE_MS = 3000;
    const HEARTBEAT_MS = 30_000;
    // Suppression window smaller than the interval: a message sent within the
    // last HEARTBEAT_SUPPRESS_MS silences the next heartbeat. Using `<
    // HEARTBEAT_MS` here would skip the first heartbeat at t=30s because the
    // `spawn` message near t=0 falls just inside a 30s window due to timer jitter.
    const HEARTBEAT_SUPPRESS_MS = 10_000;

    const sendHeartbeat = (): void => {
      if (!reply) return;
      const now = Date.now();
      if (now - lastMessageAt < HEARTBEAT_SUPPRESS_MS) return;
      const elapsed = Math.floor((now - startedAt) / 1000);
      void reply(t().router.agentHeartbeat(session.agent, elapsed)).catch(() => {});
      lastMessageAt = now;
    };
    const heartbeatTimer = reply
      ? setInterval(sendHeartbeat, HEARTBEAT_MS)
      : undefined;

    const handler = (progress: EnsureSessionProgress): void => {
      if (!reply) return;
      const now = Date.now();
      if (typeof progress === "string") {
        if (progress === "spawn") {
          void reply(t().router.agentSpawning(session.agent)).catch(() => {});
          lastMessageAt = now;
        } else if (progress === "initializing") {
          if (now - lastMessageAt >= DEBOUNCE_MS) {
            const elapsed = Math.floor((now - startedAt) / 1000);
            void reply(t().router.agentInitializing(session.agent, elapsed)).catch(() => {});
            lastMessageAt = now;
          }
        }
        return;
      }
      // progress.kind === "note"
      if (now - lastMessageAt < DEBOUNCE_MS) return;
      const translated = translateAcpxNote(progress.text);
      if (!translated) return;
      const elapsed = Math.floor((now - startedAt) / 1000);
      void reply(t().router.acpxNoteElapsed(translated, elapsed)).catch(() => {});
      lastMessageAt = now;
    };

    const dispose = (): void => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    };

    return { handler, dispose };
  }

  async ensureTransportSession(
    session: ResolvedSession,
    reply?: (text: string) => Promise<void>,
    perfSpan?: PerfSpan,
  ): Promise<void> {
    const attemptSession = (operation: string): Promise<void> => {
      const { handler, dispose } = this.createProgressHandler(session, reply);
      return this.measureTransportCall(operation, session, () =>
        this.transport.ensureSession(session, handler),
      ).finally(dispose);
    };

    try {
      await attemptSession("ensure_session");
      perfSpan?.mark("session.ready");
    } catch (err) {
      if (!(err instanceof MissingOptionalDepError)) throw err;
      await reply?.(t().router.depMissing(err.package));

      const paths = await this.discoverPaths(err.package, err.parentPackagePath, {
        cwd: session.cwd,
      });
      const result = await this.autoInstall(err.package, paths, {
        verify: async () => {
          await reply?.(t().router.depInstallVerifying);
          try {
            await attemptSession("ensure_session.verify");
            perfSpan?.mark("session.ready");
            return true;
          } catch (retryErr) {
            if (retryErr instanceof MissingOptionalDepError) return false;
            throw retryErr;
          }
        },
      });

      if (!result.ok) {
        throw new AutoInstallFailedError(err, result.errors, result.logPath);
      }
    }
  }

  async checkTransportSession(session: ResolvedSession): Promise<boolean> {
    return await this.measureTransportCall("has_session", session, () => this.transport.hasSession(session));
  }

  async promptTransportSession(
    session: ResolvedSession,
    text: string,
    reply?: (text: string) => Promise<void>,
    replyContext?: ReplyQuotaContext,
    media?: PromptMediaInput,
    abortSignal?: AbortSignal,
    onToolEvent?: (event: ToolUseEvent) => void | Promise<void>,
    onThought?: (chunk: string) => void | Promise<void>,
    perfSpan?: PerfSpan,
    onPlan?: (entries: PlanEntry[]) => void | Promise<void>,
    onUsage?: (usage: PromptUsage) => void | Promise<void>,
    onCommands?: (commands: AgentCommand[]) => void | Promise<void>,
  ) {
    session.mcpCoordinatorSession ??= stableCoordinatorSession(session.transportSession);
    // `done` closes the race window between prompt resolving and the abort
    // listener firing: once we're in finally we suppress any late abort so
    // it can't cancel a *follow-up* prompt that happens to reuse this session.
    let done = false;
    let abortRequested = false;
    let cancelOnAbort: (() => void) | undefined;
    const fireCancel = (): void => {
      abortRequested = true;
      if (done) return;
      try {
        const result = this.transport.cancel(session);
        if (result && typeof (result as { catch?: unknown }).catch === "function") {
          (result as Promise<unknown>).catch(async (error) => {
            await this.logger.error("transport.cancel_on_abort_failed", "transport cancel triggered by abort signal failed", {
              agent: session.agent,
              workspace: session.workspace,
              alias: session.alias,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
      } catch (error) {
        void this.logger.error("transport.cancel_on_abort_failed", "transport cancel triggered by abort signal threw synchronously", {
          agent: session.agent,
          workspace: session.workspace,
          alias: session.alias,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    let localOutcome: "ok" | "error" | "aborted" = "ok";
    if (abortSignal) {
      if (abortSignal.aborted) {
        // Already aborted before we even started — don't pre-emptively call
        // cancel (the transport hasn't seen a prompt yet on this session
        // necessarily, and some transports throw on cancel-without-active).
        // Instead, enter the unified try/finally path so perf records the
        // aborted prompt lifecycle, then throw before dispatching transport.prompt.
        abortRequested = true;
      } else {
        cancelOnAbort = fireCancel;
        abortSignal.addEventListener("abort", cancelOnAbort, { once: true });
      }
    }
    let firstChunkFired = false;
    const onSegment = (_segment: string): void => {
      if (!firstChunkFired) {
        firstChunkFired = true;
        perfSpan?.mark("transport.first_chunk");
      }
    };
    const asyncClaudeToolCallIds = new Set<string>();
    const pendingToolEvents = new Map<string, ToolUseEvent>();
    const forwardToolEvent = onToolEvent
      ? async (event: ToolUseEvent): Promise<void> => {
          if (event.status === "running") pendingToolEvents.set(event.toolCallId, event);
          else pendingToolEvents.delete(event.toolCallId);
          if (isClaudeAsyncAgentLaunch(event)) asyncClaudeToolCallIds.add(event.toolCallId);
          await onToolEvent(event);
        }
      : undefined;
    try {
      if (abortRequested) {
        throw new DOMException("Aborted before prompt started", "AbortError");
      }
      perfSpan?.mark("transport.prompt_dispatched", {
        transportKind: this.config?.transport.type ?? inferTransportKind(this.transport),
      });
      return await this.measureTransportCall("prompt", session, async () => {
        const result = await this.transport.prompt(session, text, reply, replyContext, {
          ...(media ? { media } : {}),
          ...(reply ? { onSegment } : {}),
          ...(forwardToolEvent ? { onToolEvent: forwardToolEvent } : {}),
          ...(onThought ? { onThought } : {}),
          ...(onPlan ? { onPlan } : {}),
          ...(onUsage ? { onUsage } : {}),
          ...(onCommands ? { onCommands } : {}),
        });

        const isClaude = (this.config?.agents[session.agent]?.driver ?? session.agent) === "claude";
        if (!isClaude || asyncClaudeToolCallIds.size === 0 || !reply || !forwardToolEvent) {
          return result;
        }

        let agentSessionId = session.agentSessionId;
        if (!agentSessionId) {
          try {
            agentSessionId = await this.transport.getAgentSessionId?.(session);
          } catch (error) {
            await this.logger.error(
              "transport.claude_background_followup.session_id_failed",
              "failed to resolve Claude session id for background follow-up",
              { alias: session.alias, error: error instanceof Error ? error.message : String(error) },
            );
          }
        }
        if (!agentSessionId) {
          for (const event of [...pendingToolEvents.values()]) {
            await forwardToolEvent({
              ...event,
              rawOutput: { message: "Claude background continuation could not be tracked: session id unavailable" },
              status: "error",
            });
          }
          return result;
        }

        await this.logger.info(
          "transport.claude_background_followup.started",
          "following Claude background-agent continuation",
          { alias: session.alias, agentSessionId, taskCount: asyncClaudeToolCallIds.size },
        );
        const followup = await this.followClaudeBackgroundTurn({
          cwd: session.cwd,
          sessionId: agentSessionId,
          launchedToolCallIds: asyncClaudeToolCallIds,
          ...(abortSignal ? { signal: abortSignal } : {}),
          onText: async (chunk) => {
            onSegment(chunk);
            await reply(chunk);
          },
          ...(onThought ? { onThought } : {}),
          onToolEvent: forwardToolEvent,
        });

        if (followup.status === "completed") {
          // Child tool updates can arrive after ACP's response without an explicit
          // terminal status, or disappear with the closed request entirely. Once
          // Claude's resumed main turn is complete, no tool from the original ACP
          // turn can still be running; close any remaining cards deterministically.
          for (const event of [...pendingToolEvents.values()]) {
            await forwardToolEvent({ ...event, status: "success" });
          }
        } else {
          for (const event of [...pendingToolEvents.values()]) {
            await forwardToolEvent({
              ...event,
              rawOutput: { message: `Claude background continuation ${followup.status}` },
              status: "error",
            });
          }
        }
        await this.logger.info(
          `transport.claude_background_followup.${followup.status}`,
          `Claude background-agent follow-up ${followup.status}`,
          {
            alias: session.alias,
            agentSessionId,
            completedTaskCount: followup.completedToolCallIds.length,
          },
        );
        return result;
      });
    } catch (error) {
      localOutcome = isAbortError(error) || abortRequested ? "aborted" : "error";
      throw error;
    } finally {
      if (abortRequested && localOutcome === "ok") {
        localOutcome = "aborted";
      }
      perfSpan?.mark("transport.prompt_done", { localOutcome });
      done = true;
      if (cancelOnAbort && abortSignal) {
        abortSignal.removeEventListener("abort", cancelOnAbort);
      }
    }
  }

  async setModeTransportSession(session: ResolvedSession, modeId: string) {
    return await this.measureTransportCall("set_mode", session, () => this.transport.setMode(session, modeId));
  }

  async setModelTransportSession(session: ResolvedSession, modelId: string) {
    if (!this.transport.setModel) {
      throw new Error("the active transport does not support switching models");
    }
    const setModel = this.transport.setModel.bind(this.transport);
    return await this.measureTransportCall("set_model", session, () => setModel(session, modelId));
  }

  async getModelTransportSession(session: ResolvedSession): Promise<{ current?: string; available: string[] }> {
    if (!this.transport.getSessionModel) {
      // Transport can't query acpx; fall back to the resolved model with no catalog.
      return { current: session.model, available: [] };
    }
    const getSessionModel = this.transport.getSessionModel.bind(this.transport);
    return await this.measureTransportCall("get_model", session, () => getSessionModel(session));
  }

  async cancelTransportSession(session: ResolvedSession) {
    return await this.measureTransportCall("cancel", session, () => this.transport.cancel(session));
  }

  async refreshSessionTransportAgentCommand(alias: string): Promise<void> {
    const session = await this.sessions.getSession(alias);
    if (!session) {
      return;
    }

    const transportAgentCommand = await this.resolveSessionAgentCommand(session);
    if (!transportAgentCommand) {
      return;
    }

    await this.sessions.setSessionTransportAgentCommand(alias, transportAgentCommand);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function inferTransportKind(transport: SessionTransport): TransportConfig["type"] {
  return transport.constructor.name.includes("Bridge") ? "acpx-bridge" : "acpx-cli";
}
