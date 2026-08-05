import type {
  AgentSessionListQuery,
  AgentSessionListResult,
  EnsureSessionProgress,
  EnsureSessionProgressStage,
  PermissionPolicy,
  PromptOptions,
  ReplyQuotaContext,
  ResolvedSession,
  SessionTransport,
  SessionEffortState,
} from "../types";
import {
  buildOverflowSummary,
  createQuotaGatedReplySink,
  createVerbatimReplySink,
} from "../quota-gated-reply-sink";
import { createSerializedCallbackQueue } from "../serialized-callback-queue";
import { resolveToolEventMode } from "../tool-event-mode.js";
import type { BridgeMethod } from "./acpx-bridge-protocol";
import type { BridgeEvent } from "./acpx-bridge-client";

interface BridgeRequestClient {
  request<TResult>(
    method: BridgeMethod,
    params: Record<string, unknown>,
    onEvent?: (event: BridgeEvent) => void,
  ): Promise<TResult>;
}

export class AcpxBridgeTransport implements SessionTransport {
  constructor(private readonly client: BridgeRequestClient & { dispose?: () => Promise<void> }) {}

  async ensureSession(session: ResolvedSession, onProgress?: (progress: EnsureSessionProgress) => void): Promise<void> {
    await this.client.request("ensureSession", this.toParams(session), onProgress
      ? (event) => {
          if (event.type === "session.progress" && event.stage) {
            onProgress(event.stage as EnsureSessionProgressStage);
          } else if (event.type === "session.note") {
            onProgress({ kind: "note", text: event.text });
          }
        }
      : undefined);
  }

  async tailSessionHistory(session: ResolvedSession, lines: number): Promise<{ text: string }> {
    return await this.client.request("tailSessionHistory", {
      ...this.toParams(session),
      lines,
    });
  }

  async listAgentSessions(query: AgentSessionListQuery): Promise<AgentSessionListResult | undefined> {
    return await this.client.request("listAgentSessions", { ...query });
  }

  async resumeAgentSession(session: ResolvedSession, agentSessionId: string): Promise<void> {
    await this.client.request("resumeAgentSession", {
      agent: session.agent,
      driver: session.driver,
      settingsPolicy: session.settingsPolicy,
      ...(session.agentCommand ? { agentCommand: session.agentCommand } : {}),
      cwd: session.cwd,
      name: session.transportSession,
      agentSessionId,
    });
  }

  async prompt(
    session: ResolvedSession,
    text: string,
    reply?: (text: string) => Promise<void>,
    replyContext?: ReplyQuotaContext,
    options?: PromptOptions,
  ): Promise<{ text: string }> {
    const streamMode = (session.effectiveReplyMode ?? session.replyMode) === "stream";
    const sink = reply
      ? streamMode
        ? createVerbatimReplySink(reply)
        : createQuotaGatedReplySink({
            reply,
            ...(replyContext ? { replyContext } : {}),
          })
      : null;
    const transcriptEvents = createSerializedCallbackQueue();
    let planError: unknown;
    let planChain = Promise.resolve();
    let usageError: unknown;
    let usageChain = Promise.resolve();
    let commandsError: unknown;
    let commandsChain = Promise.resolve();
    let toolEventMode = resolveToolEventMode(options);
    // Safety net: structured/both without an onToolEvent handler would
    // silently drop tool calls. Demote to 'text' so verbose tool calls
    // still surface in the reply stream.
    if ((toolEventMode === "structured" || toolEventMode === "both") && !options?.onToolEvent) {
      toolEventMode = "text";
    }
    const result = await this.client.request<{ text: string }>("prompt", {
      ...this.toParams(session),
      sessionKey: session.alias,
      text,
      ...(options?.media ? { media: options.media } : {}),
      // Back-compat: older bridge subprocesses key on `toolEvents: true` rather
      // than `toolEventMode`. Only set it when the mode requires structured events
      // so an old subprocess still emits them correctly.
      ...(toolEventMode === "structured" || toolEventMode === "both" ? { toolEvents: true } : {}),
      toolEventMode,
    }, (event) => {
      if (event.type === "prompt.segment") {
        const onSegment = options?.onSegment;
        const segmentText = event.text;
        transcriptEvents.enqueue(async () => {
          const segmentResult = onSegment?.(segmentText);
          sink?.feedSegment(segmentText);
          await segmentResult;
        });
        return;
      }
      if (event.type === "prompt.tool_event") {
        const onToolEvent = options?.onToolEvent;
        if (onToolEvent) {
          const toolEvent = event.event;
          transcriptEvents.enqueue(() => onToolEvent(toolEvent));
        }
        return;
      }
      if (event.type === "prompt.thought") {
        const onThought = options?.onThought;
        if (onThought) {
          const thoughtText = event.text;
          transcriptEvents.enqueue(() => onThought(thoughtText));
        }
        return;
      }
      if (event.type === "prompt.plan") {
        const onPlan = options?.onPlan;
        if (onPlan) {
          const entries = event.entries;
          // Serialize handler invocations; first error wins.
          planChain = planChain
            .then(() => onPlan(entries))
            .catch((error) => {
              planError ??= error;
            });
        }
        return;
      }
      if (event.type === "prompt.usage") {
        const onUsage = options?.onUsage;
        if (onUsage) {
          const usage = { used: event.used, size: event.size, ...(event.cost ? { cost: event.cost } : {}), ...(event.breakdown ? { breakdown: event.breakdown } : {}) };
          // Serialize handler invocations; first error wins.
          usageChain = usageChain
            .then(() => onUsage(usage))
            .catch((error) => {
              usageError ??= error;
            });
        }
        return;
      }
      if (event.type === "prompt.commands") {
        const onCommands = options?.onCommands;
        if (onCommands) {
          const commands = event.commands;
          commandsChain = commandsChain
            .then(() => onCommands(commands))
            .catch((error) => {
              commandsError ??= error;
            });
        }
        return;
      }
    });
    await transcriptEvents.drain();
    await planChain;
    await usageChain;
    await commandsChain;
    if (sink) {
      const { overflowCount } = sink.finalize();
      // Drain in-flight reply() promises and propagate any QuotaDeferredError
      // captured by the sink so callers (e.g. wakeCoordinator) can detect that
      // the outbound pushReply was deferred mid-stream and preserve
      // injectionPending instead of marking the wake as completed.
      await sink.drain({ timeoutMs: 30_000 });
      const deferred = sink.getPendingError();
      if (deferred) {
        throw deferred;
      }
      const summary = buildOverflowSummary(overflowCount);
      // Streaming mode already pushed every segment through reply() (mid quota).
      // Returning result.text again would duplicate what the user just saw. Only
      // surface a final-tier text when overflow happened — in that case the
      // summary is new info AND result.text carries the agent's final answer
      // that may have been partially or fully dropped from the stream.
      const transcriptError = transcriptEvents.getError();
      if (transcriptError) {
        throw transcriptError;
      }
      if (planError) {
        throw planError;
      }
      if (usageError) {
        throw usageError;
      }
      if (commandsError) {
        throw commandsError;
      }
      return { text: summary ? `${summary}\n\n${result.text}` : "" };
    }
    const transcriptError = transcriptEvents.getError();
    if (transcriptError) {
      throw transcriptError;
    }
    if (planError) {
      throw planError;
    }
    if (usageError) {
      throw usageError;
    }
    if (commandsError) {
      throw commandsError;
    }
    return result;
  }

  async setMode(session: ResolvedSession, modeId: string): Promise<void> {
    await this.client.request("setMode", {
      ...this.toParams(session),
      modeId,
    });
  }

  async setModel(session: ResolvedSession, modelId: string): Promise<void> {
    // Carry the NEW model so the global --model and the `set model` value agree.
    await this.client.request("setModel", {
      ...this.toParams({ ...session, model: modelId }),
      modelId,
    });
  }

  async getSessionModel(session: ResolvedSession): Promise<{ current?: string; available: string[] }> {
    return await this.client.request("getSessionModel", this.toParams(session));
  }

  async setSessionEffort(session: ResolvedSession, effort: string): Promise<void> {
    await this.client.request("setSessionEffort", { ...this.toParams(session), effort });
  }

  async getSessionEffort(session: ResolvedSession): Promise<SessionEffortState> {
    return await this.client.request("getSessionEffort", this.toParams(session));
  }

  async cancel(session: ResolvedSession): Promise<{ cancelled: boolean; message: string }> {
    return await this.client.request("cancel", this.toParams(session));
  }

  async removeSession(session: ResolvedSession): Promise<void> {
    await this.client.request("removeSession", this.toParams(session));
  }

  async deleteSession(session: ResolvedSession): Promise<void> {
    await this.client.request("deleteSession", this.toParams(session));
  }

  async freeWarmProcess(session: ResolvedSession): Promise<void> {
    await this.client.request("freeWarmProcess", this.toParams(session));
  }

  async isSessionWarm(session: ResolvedSession): Promise<boolean> {
    const result = await this.client.request<{ warm: boolean }>("isSessionWarm", this.toParams(session));
    return result.warm === true;
  }

  async getAgentSessionId(session: ResolvedSession): Promise<string | undefined> {
    const result = await this.client.request<{ agentSessionId?: string }>(
      "getAgentSessionId",
      this.toParams(session),
    );
    return result.agentSessionId;
  }

  async hasSession(session: ResolvedSession): Promise<boolean> {
    const result = await this.client.request<{ exists: boolean }>("hasSession", this.toParams(session));
    return result.exists;
  }

  async updatePermissionPolicy(policy: PermissionPolicy): Promise<void> {
    await this.client.request("updatePermissionPolicy", { ...policy });
  }
  async dispose(): Promise<void> {
    await this.client.dispose?.();
  }

  private toParams(session: ResolvedSession): Record<string, unknown> {
    return {
      agent: session.agent,
      driver: session.driver,
      settingsPolicy: session.settingsPolicy,
      agentCommand: session.agentCommand,
      cwd: session.cwd,
      name: session.transportSession,
      mcpCoordinatorSession: session.mcpCoordinatorSession,
      mcpSourceHandle: session.mcpSourceHandle,
      replyMode: session.effectiveReplyMode ?? session.replyMode ?? "verbose",
      ...(session.model?.trim() ? { model: session.model.trim() } : {}),
      ...(session.effort?.trim() ? { effort: session.effort.trim() } : {}),
    };
  }
}
