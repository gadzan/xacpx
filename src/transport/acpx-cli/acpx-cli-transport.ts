import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { spawn as spawnPty } from "node-pty";

import { resolveSpawnCommand } from "../../process/spawn-command";
import type { NonInteractivePermissions, PermissionMode } from "../../config/types";
import type { PlanEntry, ToolUseEvent } from "../../channels/types.js";
import { getLocale } from "../../i18n";
import type {
  AgentCommand,
  AgentSessionListQuery,
  AgentSessionListResult,
  EnsureSessionProgress,
  PermissionPolicy,
  PromptOptions,
  PromptUsage,
  ReplyQuotaContext,
  ResolvedSession,
  SessionTransport,
} from "../types";
import { getPromptText, normalizeCommandError } from "../prompt-output";
import { isModelNotAdvertisedError } from "../model-not-advertised";
import { createStructuredPromptFile } from "../prompt-media";
import { createStreamingPromptState, parseStreamingDataChunk } from "../streaming-prompt";
import {
  buildOverflowSummary,
  createQuotaGatedReplySink,
  createVerbatimReplySink,
} from "../quota-gated-reply-sink";
import { ensureNodePtyHelperExecutable, resolveNodePtyHelperPath } from "./node-pty-helper";
import { terminateProcessTree } from "../../process/terminate-process-tree";
import { AcpxQueueOwnerLauncher, terminateAcpxQueueOwner } from "../acpx-queue-owner-launcher";
import { permissionModeToFlag } from "../permission-mode-flag";
import { resolveToolEventMode, type ToolEventMode } from "../tool-event-mode.js";
import { runAgentSessionList } from "../agent-session-list";
import { CODEX_AGENT_NAME, codexSubagentPredicate } from "../codex-subagent-filter";
import { deleteAcpxSessionFiles } from "../acpx-session-files";

interface AcpxCliTransportOptions {
  command?: string;
  sessionInitTimeoutMs?: number;
  permissionMode?: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissions;
  permissionPolicy?: string;
  /** Idle TTL (seconds) passed to acpx as `--ttl` on prompt; 0 = keep alive forever. */
  queueOwnerTtlSeconds?: number;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
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
const require = createRequire(import.meta.url);

async function defaultRunner(command: string, args: string[], options?: RunOptions): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const spawnSpec = resolveSpawnCommand(command, args);
    const child = spawn(spawnSpec.command, spawnSpec.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const onAbort = () => {
      void terminateProcessTree(child.pid ?? 0, { detachedProcessGroup: false });
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutId = options?.timeoutMs
      ? setTimeout(() => {
          onAbort();
          reject(new Error(`acpx command timed out after ${options.timeoutMs}ms: ${renderCommandForError(args)}`));
        }, options.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      options?.signal?.removeEventListener("abort", onAbort);
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });
    child.on("close", (code) => {
      options?.signal?.removeEventListener("abort", onAbort);
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function defaultPtyRunner(command: string, args: string[], options?: RunOptions): Promise<CommandResult> {
  const helperPath = resolveNodePtyHelperPath(
    require.resolve("node-pty/package.json"),
    process.platform,
    process.arch,
  );
  await ensureNodePtyHelperExecutable(helperPath);

  return await new Promise((resolve, reject) => {
    const spawnSpec = resolveSpawnCommand(command, args);
    const child = spawnPty(spawnSpec.command, spawnSpec.args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env, XACPX_LANG: getLocale() } as Record<string, string>,
    });
    let output = "";

    const onAbort = () => {
      child.kill();
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutId = options?.timeoutMs
      ? setTimeout(() => {
          onAbort();
          reject(new Error(`acpx command timed out after ${options.timeoutMs}ms: ${renderCommandForError(args)}`));
        }, options.timeoutMs)
      : undefined;

    child.onData((chunk) => {
      output += chunk;
    });

    child.onExit(({ exitCode }) => {
      options?.signal?.removeEventListener("abort", onAbort);
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ code: exitCode, stdout: output, stderr: "" });
    });
  });
}

export class AcpxCliTransport implements SessionTransport {
  private readonly command: string;
  private readonly sessionInitTimeoutMs: number;
  private permissionMode: PermissionMode;
  private nonInteractivePermissions: NonInteractivePermissions;
  private permissionPolicy: string | undefined;
  private readonly queueOwnerTtlSeconds: number | undefined;
  private readonly runCommand: CommandRunner;
  private readonly runPtyCommand: PtyRunner;
  private readonly queueOwnerLauncher: Pick<AcpxQueueOwnerLauncher, "launch">;
  private readonly streamingHooks: StreamingPromptHooks;

  constructor(
    options: AcpxCliTransportOptions,
    runCommand: CommandRunner = defaultRunner,
    runPtyCommand: PtyRunner = defaultPtyRunner,
    queueOwnerLauncher?: Pick<AcpxQueueOwnerLauncher, "launch">,
    streamingHooks: StreamingPromptHooks = {},
  ) {
    this.command = options.command ?? "acpx";
    this.sessionInitTimeoutMs = options.sessionInitTimeoutMs ?? 120_000;
    this.permissionMode = options.permissionMode ?? "approve-all";
    this.nonInteractivePermissions = options.nonInteractivePermissions ?? "deny";
    this.permissionPolicy = options.permissionPolicy;
    this.queueOwnerTtlSeconds = options.queueOwnerTtlSeconds;
    this.runCommand = runCommand;
    this.runPtyCommand = runPtyCommand;
    this.queueOwnerLauncher = queueOwnerLauncher ?? new AcpxQueueOwnerLauncher({
      acpxCommand: this.command,
      // Coordinator sessions pre-spawn the queue owner here (before `acpx prompt`),
      // so the owner's warm window must be set at launch — the prompt's `--ttl`
      // can't extend an already-running owner. Launcher ttl is milliseconds.
      ...(typeof this.queueOwnerTtlSeconds === "number" && Number.isFinite(this.queueOwnerTtlSeconds)
        ? { ttlMs: this.queueOwnerTtlSeconds * 1000 }
        : {}),
    });
    this.streamingHooks = streamingHooks;
  }

  // acpx-cli transport does not stream stderr back to the caller, so "note" progress
  // is never emitted. Users on this transport still see the initial "spawn" hint from
  // CommandRouter (emitted before the call) but will not receive mid-flight updates.
  async ensureSession(session: ResolvedSession, _onProgress?: (progress: EnsureSessionProgress) => void): Promise<void> {
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
        await this.runEnsureSession({ ...session, model: undefined });
        return;
      }
      throw error;
    }
  }

  private async runEnsureSession(session: ResolvedSession): Promise<void> {
    const args = this.buildArgs(session, [
      "sessions",
      "new",
      "--name",
      session.transportSession,
    ]);
    const runEnsure = session.agentCommand ? this.run : this.runWithPty;
    await runEnsure.call(this, args, {
      timeoutMs: this.sessionInitTimeoutMs,
    });
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
        });
      },
      formatError: (result) => normalizeCommandError(result) ?? `command failed with exit code ${result.code}`,
      // Codex's session list leaks native subagent threads; hide them (fail-open).
      // Gate on driver so custom-named codex agents (driver "codex") are covered too.
      isSubagentSession: (query.driver ?? query.agent) === CODEX_AGENT_NAME ? codexSubagentPredicate() : undefined,
    });
  }

  async tailSessionHistory(session: ResolvedSession, lines: number): Promise<{ text: string }> {
    const candidates = [
      ["sessions", "history", "quiet", "-s", session.transportSession, String(lines)],
      ["sessions", "history", "quiet", session.transportSession, String(lines)],
      ["sessions", "history", "-s", session.transportSession, "--tail", String(lines)],
      ["sessions", "history", session.transportSession, "--tail", String(lines)],
      ["sessions", "history", "--name", session.transportSession, "--tail", String(lines)],
    ];

    let lastResult: CommandResult | undefined;
    for (const tail of candidates) {
      const args = this.buildArgs(session, tail);
      const result = await this.runCommandWithTimeout(this.runCommand, args);
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
      const result = await this.runCommand(this.command, args);
      return { text: getPromptText(result) };
    } finally {
      try {
        await structuredPrompt?.cleanup();
      } catch {
        // Prompt outcome is more important than best-effort temp file cleanup.
      }
    }
  }

  async setMode(session: ResolvedSession, modeId: string): Promise<void> {
    await this.run(this.buildArgs(session, [
      "set-mode",
      "-s",
      session.transportSession,
      modeId,
    ]));
  }

  // acpx's generic config setter: `<agent> set -s <name> model '<id>'`. Build args
  // with the NEW model so the global --model and the `set model` value agree.
  // acpx validates the id against the agent's advertised models and applies it to
  // a live queue owner immediately (or persists it for the next turn when idle).
  async setModel(session: ResolvedSession, modelId: string): Promise<void> {
    await this.run(this.buildArgs({ ...session, model: modelId }, [
      "set",
      "-s",
      session.transportSession,
      "model",
      modelId,
    ]));
  }

  // Read the session's current model and the agent-advertised available ids from
  // `<agent> status --format json`. Returns an empty list when status output is
  // not parseable, so callers can still show the current model.
  async getSessionModel(session: ResolvedSession): Promise<{ current?: string; available: string[] }> {
    const prefix = ["--format", "json", "--cwd", session.cwd, ...this.buildPermissionArgs()];
    const tail = ["status", "-s", session.transportSession];
    const args = session.agentCommand
      ? [...prefix, "--agent", session.agentCommand, ...tail]
      : [...prefix, session.agent, ...tail];
    const result = await this.runCommandWithTimeout(this.runCommand, args);
    if (result.code !== 0) {
      const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
      throw new Error(detail);
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

  async cancel(session: ResolvedSession): Promise<{ cancelled: boolean; message: string }> {
    const output = await this.run(this.buildArgs(session, [
      "cancel",
      "-s",
      session.transportSession,
    ]));
    return {
      cancelled: true,
      message: output.trim(),
    };
  }

  async resumeAgentSession(session: ResolvedSession, agentSessionId: string): Promise<void> {
    const args = this.buildArgs(session, [
      "sessions",
      "new",
      "--name",
      session.transportSession,
      "--resume-session",
      agentSessionId,
    ]);
    const runResume = session.agentCommand ? this.run : this.runWithPty;
    await runResume.call(this, args, {
      timeoutMs: this.sessionInitTimeoutMs,
    });
  }


  async updatePermissionPolicy(policy: PermissionPolicy): Promise<void> {
    this.permissionMode = policy.permissionMode;
    this.nonInteractivePermissions = policy.nonInteractivePermissions;
    this.permissionPolicy = policy.permissionPolicy;
  }

  async removeSession(session: ResolvedSession): Promise<void> {
    const result = await this.runCommand(this.command, this.buildArgs(session, [
      "sessions",
      "close",
      session.transportSession,
    ]));
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

  async hasSession(session: ResolvedSession): Promise<boolean> {
    const result = await this.runCommand(this.command, this.buildArgs(session, [
      "sessions",
      "show",
      session.transportSession,
    ]));

    return result.code === 0;
  }

  private async launchMcpQueueOwnerIfNeeded(session: ResolvedSession): Promise<void> {
    if (!session.mcpCoordinatorSession) {
      return;
    }
    const record = await this.readSessionRecord(session);
    await this.queueOwnerLauncher.launch({
      acpxRecordId: record.acpxRecordId,
      coordinatorSession: session.mcpCoordinatorSession,
      ...(session.mcpSourceHandle ? { sourceHandle: session.mcpSourceHandle } : {}),
      permissionMode: this.permissionMode,
      nonInteractivePermissions: this.nonInteractivePermissions,
      ...(session.model?.trim() ? { sessionOptions: { model: session.model.trim() } } : {}),
    });
  }

  private async readSessionRecord(session: ResolvedSession): Promise<{ acpxRecordId: string; agentSessionId?: string }> {
    const result = await this.runCommand(this.command, this.buildArgs(session, [
      "sessions",
      "show",
      session.transportSession,
    ]));
    if (result.code !== 0) {
      const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
      throw new Error(detail);
    }
    try {
      const parsed = JSON.parse(result.stdout) as { acpxRecordId?: unknown; id?: unknown; agentSessionId?: unknown };
      const acpxRecordId = typeof parsed.acpxRecordId === "string"
        ? parsed.acpxRecordId
        : typeof parsed.id === "string"
          ? parsed.id
          : undefined;
      const agentSessionId = typeof parsed.agentSessionId === "string" ? parsed.agentSessionId : undefined;
      // Guard the parsed id with the same format check the parse-failure fallback
      // applies, so a malformed/empty id from acpx never flows into file deletion.
      if (acpxRecordId && /^[\w.:-]+$/.test(acpxRecordId) && acpxRecordId.length >= 8) {
        return { acpxRecordId, agentSessionId };
      }
    } catch {
      const firstLine = result.stdout.trim().split(/\r?\n/, 1)[0];
      if (firstLine && /^[\w.:-]+$/.test(firstLine) && firstLine.length >= 8) {
        return { acpxRecordId: firstLine };
      }
    }
    throw new Error("failed to resolve acpx session record id");
  }

  async getAgentSessionId(session: ResolvedSession): Promise<string | undefined> {
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
    const spawnSpec = resolveSpawnCommand(this.command, args);

    if (!options?.timeoutMs) {
      return await runner(spawnSpec.command, spawnSpec.args, undefined);
    }

    const abortController = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;

    return await Promise.race([
      runner(spawnSpec.command, spawnSpec.args, { ...options, signal: abortController.signal }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      }),
      new Promise<CommandResult>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              `acpx command timed out after ${options.timeoutMs}ms: ${renderCommandForError(args)}`,
            ),
          );
          abortController.abort();
        }, options.timeoutMs);
      }),
    ]);
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
  ): Promise<{ result: CommandResult; overflowCount: number }> {
    const hooks = this.streamingHooks;
    const doSpawn = hooks.spawnPrompt
      ?? ((cmd, spawnArgs) => spawn(cmd, spawnArgs, { stdio: ["ignore", "pipe", "pipe"] }) as unknown as PromptStreamProcess);
    const setIntervalFn = hooks.setIntervalFn ?? ((fn, delay) => setInterval(fn, delay));
    const clearIntervalFn = hooks.clearIntervalFn ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
    // Raw streaming drains the buffer on a tight cadence (~5×/s) for low-latency token
    // streaming; the batched paragraph path keeps the long stall-fallback window.
    const maxSegmentWaitMs = hooks.maxSegmentWaitMs ?? (rawStream ? 200 : 30_000);
    const flushCheckIntervalMs = hooks.flushCheckIntervalMs ?? (rawStream ? 80 : 5_000);
    const now = hooks.now ?? (() => Date.now());

    return await new Promise((resolve, reject) => {
      const spawnSpec = resolveSpawnCommand(command, args);
      const child = doSpawn(spawnSpec.command, spawnSpec.args);
      let stdout = "";
      let stderr = "";
      let lastReplyAt = now();
      let segmentChain = Promise.resolve();
      let segmentError: unknown;
      let toolEventChain = Promise.resolve();
      let toolEventError: unknown;
      let thoughtChain = Promise.resolve();
      let thoughtError: unknown;
      let planChain = Promise.resolve();
      let planError: unknown;
      let usageChain = Promise.resolve();
      let usageError: unknown;
      let commandsChain = Promise.resolve();
      let commandsError: unknown;
      const userOnToolEvent = onToolEvent;
      const userOnThought = onThought;
      const userOnPlan = onPlan;
      const userOnUsage = onUsage;
      const userOnCommands = onCommands;

      const state = createStreamingPromptState(formatToolCalls, {
        mode: toolEventMode,
        rawStream,
        ...(userOnToolEvent
          ? {
              onToolEvent: (event) => {
                // Serialize handler invocations; first error wins.
                toolEventChain = toolEventChain
                  .then(() => userOnToolEvent(event))
                  .catch((error) => {
                    toolEventError ??= error;
                  });
              },
            }
          : {}),
        ...(userOnThought
          ? {
              onThought: (chunk) => {
                // Serialize handler invocations; first error wins.
                thoughtChain = thoughtChain
                  .then(() => userOnThought(chunk))
                  .catch((error) => {
                    thoughtError ??= error;
                  });
              },
            }
          : {}),
        ...(userOnPlan
          ? {
              onPlan: (entries) => {
                // Serialize handler invocations; first error wins.
                planChain = planChain
                  .then(() => userOnPlan(entries))
                  .catch((error) => {
                    planError ??= error;
                  });
              },
            }
          : {}),
        ...(userOnUsage
          ? {
              onUsage: (usage) => {
                // Serialize handler invocations; first error wins.
                usageChain = usageChain
                  .then(() => userOnUsage(usage))
                  .catch((error) => {
                    usageError ??= error;
                  });
              },
            }
          : {}),
        ...(userOnCommands
          ? {
              onCommands: (commands) => {
                // Serialize handler invocations; first error wins.
                commandsChain = commandsChain
                  .then(() => userOnCommands(commands))
                  .catch((error) => {
                    commandsError ??= error;
                  });
              },
            }
          : {}),
      });

      const sink = reply
        ? rawStream
          ? createVerbatimReplySink(reply)
          : createQuotaGatedReplySink({
              reply,
              ...(replyContext ? { replyContext } : {}),
            })
        : null;

      const feedSegment = (segment: string) => {
        if (onSegment) {
          segmentChain = segmentChain
            .then(() => onSegment(segment))
            .catch((error) => {
              segmentError ??= error;
            });
        }
        sink?.feedSegment(segment);
        lastReplyAt = now();
      };

      const flushBuffer = () => {
        // Raw streaming forwards the buffer verbatim; the batched path trims edges.
        const remaining = rawStream ? state.buffer : state.buffer.trim();
        if (remaining.length > 0) {
          state.buffer = "";
          feedSegment(remaining);
        }
      };

      // Periodic timer: flush accumulated text if waiting too long
      const timer = setIntervalFn(() => {
        if (state.buffer.trim().length > 0 && now() - lastReplyAt >= maxSegmentWaitMs) {
          flushBuffer();
        }
      }, flushCheckIntervalMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string | Buffer) => {
        stdout += String(chunk);
        parseStreamingDataChunk(state, String(chunk));
        for (const segment of state.segments.splice(0)) {
          feedSegment(segment);
        }
      });

      child.stderr.on("data", (chunk: string | Buffer) => {
        stderr += String(chunk);
      });

      child.on("error", (err) => {
        clearIntervalFn(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearIntervalFn(timer);
        const remaining = state.finalize();
        if (remaining.length > 0) {
          feedSegment(remaining);
        }
        const { overflowCount } = sink?.finalize() ?? { overflowCount: 0 };
        // Note: any aggregator trailing text is folded into the overflow
        // summary path via the final agent message (caller appends summary).
        // Wait for all in-flight reply() rejections to settle before deciding
        // whether to reject the prompt with a QuotaDeferredError. Without
        // draining, the deferred error from an outbound pushReply could
        // arrive after we already resolved, and the wake-coordinator catch
        // would never see it — silently clearing injectionPending.
        void Promise.all([
          sink?.drain({ timeoutMs: 30_000 }) ?? Promise.resolve(),
          segmentChain,
          toolEventChain,
          thoughtChain,
          planChain,
          usageChain,
          commandsChain,
        ]).then(() => {
          const deferred = sink?.getPendingError();
          if (deferred) {
            reject(deferred);
            return;
          }
          if (segmentError) {
            reject(segmentError);
            return;
          }
          if (toolEventError) {
            reject(toolEventError);
            return;
          }
          if (thoughtError) {
            reject(thoughtError);
            return;
          }
          if (planError) {
            reject(planError);
            return;
          }
          if (usageError) {
            reject(usageError);
            return;
          }
          if (commandsError) {
            reject(commandsError);
            return;
          }
          resolve({
            result: { code: code ?? 1, stdout, stderr },
            overflowCount,
          });
        }).catch((error) => {
          reject(error);
        });
      });
    });
  }

  private buildArgs(session: ResolvedSession, tail: string[]): string[] {
    const prefix = [
      "--format",
      "quiet",
      "--cwd",
      session.cwd,
      ...this.buildPermissionArgs(),
      ...this.buildModelArgs(session),
    ];
    if (session.agentCommand) {
      return [...prefix, "--agent", session.agentCommand, ...tail];
    }

    return [...prefix, session.agent, ...tail];
  }

  private buildAgentQueryArgs(query: AgentSessionListQuery, format: "json" | "quiet", tail: string[]): string[] {
    const prefix = ["--format", format, "--cwd", query.cwd, ...this.buildPermissionArgs()];
    if (query.agentCommand) {
      return [...prefix, "--agent", query.agentCommand, ...tail];
    }
    return [...prefix, query.agent, ...tail];
  }

  private buildPromptArgs(session: ResolvedSession, text: string, promptFile?: string): string[] {
    const prefix = [
      "--format",
      "json",
      "--json-strict",
      "--cwd",
      session.cwd,
      ...this.buildPermissionArgs(),
      ...this.buildModelArgs(session),
      ...this.buildQueueOwnerTtlArgs(),
    ];
    const tail = promptFile
      ? ["prompt", "-s", session.transportSession, "--file", promptFile]
      : ["prompt", "-s", session.transportSession, text];

    if (session.agentCommand) {
      return [...prefix, "--agent", session.agentCommand, ...tail];
    }

    return [...prefix, session.agent, ...tail];
  }

  // The session's resolved model id as a global `--model` flag (empty when unset).
  // acpx persists it into the session record and re-applies it on each turn, so
  // passing it on both create and prompt keeps warm and cold paths consistent.
  private buildModelArgs(session: ResolvedSession): string[] {
    const model = session.model?.trim();
    return model ? ["--model", model] : [];
  }

  // `--ttl` only governs the prompt path's queue owner warm window, so it is
  // intentionally limited to buildPromptArgs (not the shared session args).
  private buildQueueOwnerTtlArgs(): string[] {
    if (typeof this.queueOwnerTtlSeconds !== "number" || !Number.isFinite(this.queueOwnerTtlSeconds)) {
      return [];
    }
    return ["--ttl", String(this.queueOwnerTtlSeconds)];
  }

  private buildPermissionArgs(): string[] {
    const modeFlag = permissionModeToFlag(this.permissionMode);

    const args = [modeFlag, "--non-interactive-permissions", this.nonInteractivePermissions];
    if (typeof this.permissionPolicy === "string" && this.permissionPolicy.trim().length > 0) {
      args.push("--permission-policy", this.permissionPolicy);
    }
    return args;
  }
}

function isMissingAcpxSessionError(stderr: string, stdout: string): boolean {
  const combined = `${stderr}\n${stdout}`.toLowerCase();
  return (
    combined.includes("no named session") ||
    combined.includes("no cwd session") ||
    combined.includes("session not found") ||
    combined.includes("unknown session") ||
    combined.includes("no acpx session found")
  );
}

function renderCommandForError(args: string[]): string {
  const rendered: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--format") {
      index += 1;
      continue;
    }

    if (arg === "--cwd") {
      index += 1;
      continue;
    }

    rendered.push(/\s/.test(arg) || arg.includes(":") ? `"${arg}"` : arg);
  }

  return rendered.join(" ");
}
