import type { ToolUseEvent } from "../channels/types.js";
import type { AppLogger } from "../logging/app-logger.js";
import {
  asyncAgentId,
  followBackgroundTurn as defaultFollowBackgroundTurn,
  isAsyncAgentLaunch,
  type BackgroundFollowupOptions,
  type BackgroundFollowupResult,
} from "./background-followup.js";
import type { PromptOptions, SessionTransport } from "./types.js";

type FollowBackgroundTurn = (options: BackgroundFollowupOptions) => Promise<BackgroundFollowupResult>;

// Preserve the established telemetry namespace so existing log queries and
// alerts keep working while the public code surface moves to provider-neutral names.
const LEGACY_LOG_EVENT_PREFIX = "transport.claude_background_followup";

export interface BackgroundFollowupTransportOptions {
  logger: AppLogger;
  followBackgroundTurn?: FollowBackgroundTurn;
  resolveDriver?: (agent: string) => string | undefined;
}

/** Transport decorator that owns the native-transcript continuation for
 * Claude Code-compatible drivers (claude, qoder). Command routing remains
 * driver-agnostic; optional transport capabilities stay intact because every
 * property except prompt is read directly from the delegate. */
export function createBackgroundFollowupTransport(
  delegate: SessionTransport,
  options: BackgroundFollowupTransportOptions,
): SessionTransport {
  const runBackgroundFollowup = options.followBackgroundTurn ?? defaultFollowBackgroundTurn;

  const prompt: SessionTransport["prompt"] = async (session, text, reply, replyContext, promptOptions) => {
    const latestToolEvents = new Map<string, ToolUseEvent>();
    const pendingToolEvents = new Map<string, ToolUseEvent>();
    const asyncToolCallIds = new Set<string>();
    const subagentIdsByToolCallId = new Map<string, string>();
    const downstreamToolEvent = promptOptions?.onToolEvent;
    const forwardToolEvent = downstreamToolEvent
      ? async (event: ToolUseEvent): Promise<void> => {
          latestToolEvents.set(event.toolCallId, event);
          if (event.status === "running") pendingToolEvents.set(event.toolCallId, event);
          else pendingToolEvents.delete(event.toolCallId);
          if (event.isSubagent && isAsyncAgentLaunch(event)) {
            asyncToolCallIds.add(event.toolCallId);
            const agentId = asyncAgentId(event);
            if (agentId) subagentIdsByToolCallId.set(event.toolCallId, agentId);
          }
          await downstreamToolEvent(event);
        }
      : undefined;

    const result = await delegate.prompt(session, text, reply, replyContext, {
      ...promptOptions,
      ...(forwardToolEvent ? { onToolEvent: forwardToolEvent } : {}),
    });

    const driver = (options.resolveDriver?.(session.agent) ?? session.agent).trim().toLowerCase();
    const supportsFollowup = driver === "claude" || driver === "qoder";
    if (!supportsFollowup || asyncToolCallIds.size === 0 || !reply || !forwardToolEvent) return result;

    let agentSessionId = session.agentSessionId;
    if (!agentSessionId) {
      try {
        agentSessionId = await delegate.getAgentSessionId?.(session);
      } catch (error) {
        await options.logger.error(
          `${LEGACY_LOG_EVENT_PREFIX}.session_id_failed`,
          "failed to resolve agent session id for background follow-up",
          { alias: session.alias, error: error instanceof Error ? error.message : String(error) },
        );
      }
    }
    if (!agentSessionId) {
      for (const event of [...pendingToolEvents.values()]) {
        await forwardToolEvent({
          ...event,
          rawOutput: { message: "background continuation could not be tracked: session id unavailable" },
          status: "error",
        });
      }
      return result;
    }

    await options.logger.info(
      `${LEGACY_LOG_EVENT_PREFIX}.started`,
      "following background-agent continuation",
      { alias: session.alias, agentSessionId, driver, taskCount: asyncToolCallIds.size },
    );
    const followup = await runBackgroundFollowup({
      cwd: session.cwd,
      sessionId: agentSessionId,
      driver,
      launchedToolCallIds: asyncToolCallIds,
      initialToolEvents: latestToolEvents.values(),
      subagentIdsByToolCallId,
      ...(promptOptions?.signal ? { signal: promptOptions.signal } : {}),
      onText: async (chunk) => {
        await promptOptions?.onSegment?.(chunk);
        await reply(chunk);
      },
      ...(promptOptions?.onThought ? { onThought: promptOptions.onThought } : {}),
      onToolEvent: forwardToolEvent,
    });

    const failedToolCallIds = new Set(followup.failedToolCallIds);
    const hasFailedAncestor = (event: ToolUseEvent): boolean => {
      let toolCallId: string | undefined = event.toolCallId;
      const seen = new Set<string>();
      while (toolCallId && !seen.has(toolCallId)) {
        if (failedToolCallIds.has(toolCallId)) return true;
        seen.add(toolCallId);
        toolCallId = latestToolEvents.get(toolCallId)?.parentToolCallId;
      }
      return false;
    };
    for (const event of [...pendingToolEvents.values()]) {
      const failed = hasFailedAncestor(event);
      await forwardToolEvent({
        ...event,
        status: followup.status === "completed" && !failed ? "success" : "error",
        ...(followup.status === "completed" && !failed
          ? {}
          : { rawOutput: { message: failed ? "background Agent failed" : `background continuation ${followup.status}` } }),
      });
    }
    await options.logger.info(
      `${LEGACY_LOG_EVENT_PREFIX}.${followup.status}`,
      `background-agent follow-up ${followup.status}`,
      {
        alias: session.alias,
        agentSessionId,
        driver,
        completedTaskCount: followup.completedToolCallIds.length,
        failedTaskCount: followup.failedToolCallIds.length,
      },
    );
    return result;
  };

  return new Proxy(delegate, {
    get(target, property, receiver) {
      if (property === "prompt") return prompt;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
