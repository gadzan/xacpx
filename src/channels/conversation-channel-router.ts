import type { Agent, ChatRequest, ChatResponse } from "../weixin/agent/interface";
import type { ConversationRuntime } from "../conversations/conversation-composition";
import type { ControlEventBus } from "../control/control-event-bus";
import { ConversationError } from "../conversations/conversation-error";
import type { ConversationRouteSnapshot } from "../conversations/conversation-bindings";
import type { ConversationChannelAgent, ConversationIngressPreparation } from "./types";
import { isLocalWeixinSlashCommand } from "../weixin/messaging/slash-commands";

function preparedAgent(execute: (request: ChatRequest, admitted: (result?: ConversationIngressPreparation) => void) => Promise<ChatResponse>): ConversationChannelAgent {
  let prepared: { request: ChatRequest; identity: string; admission: Promise<ConversationIngressPreparation | void>; response: Promise<ChatResponse> } | undefined;
  const identity = (input: ChatRequest) => JSON.stringify([input.accountId, input.conversationId, input.text,
    Array.isArray(input.media) && input.media.length === 0 ? null : input.media ?? null,
    input.metadata?.channel, input.metadata?.channelMessageId, input.metadata?.senderId, input.metadata?.origin,
    input.metadata?.authenticatedHuman, input.metadata?.hadInboundMedia ?? false, input.metadata?.conversationTarget ?? null]);
  const start = (request: ChatRequest) => {
    if (prepared) {
      if (prepared.identity !== identity(request) || prepared.request.abortSignal !== request.abortSignal
        || prepared.request.humanStopSignal !== request.humanStopSignal) {
        throw new ConversationError("external_ingress_invalid", "prepared channel request changed");
      }
      return prepared;
    }
    const admission = Promise.withResolvers<ConversationIngressPreparation | void>();
    const response = execute(request, (result) => admission.resolve(result));
    // UI setup can still be pending when lifecycle cancellation detaches us.
    response.catch((error) => admission.reject(error));
    admission.promise.catch(() => {});
    prepared = { request, identity: identity(request), admission: admission.promise, response };
    return prepared;
  };
  return { prepareConversation: (request) => start(request).admission, chat: (request) => start(request).response };
}

/** Select before Session binding. The ordinary Agent is never wrapped. */
export function createConversationChannelRouter(channelId: string, agent: Agent,
  runtime: ConversationRuntime, events: ControlEventBus, daemonSignal: AbortSignal): (request: ChatRequest) => ConversationChannelAgent | undefined {
  const conversationAgent = (selected: ConversationRouteSnapshot) => preparedAgent(async (request, admitted) => {
      const accepted = await runtime.withOperation(() => runtime.bindings.accept(channelId, request, daemonSignal, selected));
      if (!accepted) throw new ConversationError("binding_changed", "selected Conversation binding is no longer available");
      admitted();
      // The acceptance lease is released before waiting. Shutdown must be able
      // to drain/cancel the dispatcher while this channel waits for settlement.
      return new Promise<ChatResponse>((resolve, reject) => {
        let done = false;
        let stopping = false;
        let unsubscribe = () => {};
        const finish = (error?: unknown, response?: ChatResponse) => {
          if (done) return;
          done = true;
          unsubscribe();
          request.humanStopSignal?.removeEventListener("abort", stop);
          request.abortSignal?.removeEventListener("abort", onChannelAbort);
          daemonSignal.removeEventListener("abort", shutdown);
          if (error) reject(error); else resolve(response ?? { silent: true });
        };
        const inspect = () => {
          if (done || stopping) return;
          try {
            const run = runtime.store.getRun(accepted.run.id);
            if (!run) throw new ConversationError("run_not_found", "bound Run was deleted");
            if (run.state === "queued" || run.state === "running") return;
            const results = runtime.store.listMemberTurns(run.id).flatMap((member) => {
              const message = runtime.store.getMemberResult(member);
              return message ? [`${member.profileSnapshot?.presentation.name ?? member.botId}:\n${message.content}`] : [];
            });
            const status = [`Conversation ${run.state}${run.completionReason ? ` (${run.completionReason})` : ""}.`,
              ...(run.waitingQuestion ? [run.waitingQuestion] : [])].join("\n");
            finish(undefined, { text: results.length
              ? [...results, ...(run.state === "completed" ? [] : [status])].join("\n\n") : status });
          } catch (error) { finish(error); }
        };
        const stop = () => {
          if (daemonSignal.aborted) { shutdown(); return; }
          stopping = true;
          void runtime.withOperation(() => runtime.runs.cancelRun(accepted.run.id))
            .then(() => finish(undefined, { silent: true }), (error) => finish(error));
        };
        const shutdown = () => finish(new ConversationError("runtime_closed", "channel stopped while awaiting Conversation"));
        const onChannelAbort = () => { if (!request.humanStopSignal?.aborted) shutdown(); };
        unsubscribe = events.subscribe((event) => {
          if ((event.type === "conversation-run-changed" || event.type === "member-turn-finished") && event.run.id === accepted.run.id) inspect();
        });
        request.humanStopSignal?.addEventListener("abort", stop, { once: true });
        request.abortSignal?.addEventListener("abort", onChannelAbort, { once: true });
        daemonSignal.addEventListener("abort", shutdown, { once: true });
        if (daemonSignal.aborted) shutdown();
        else if (request.humanStopSignal?.aborted) stop();
        else if (request.abortSignal?.aborted) shutdown();
        else inspect();
      });
  });
  const stopAgent = (request: ChatRequest) => preparedAgent(async (input, admitted) => {
    if (input.conversationId !== request.conversationId || input.accountId !== request.accountId
      || input.metadata?.senderId !== request.metadata?.senderId) throw new ConversationError("external_ingress_invalid", "Stop route changed");
    return runtime.withOperation(async () => {
      const receipt = runtime.bindings.acceptStop(channelId, input);
      admitted({ stopPendingAcceptance: !receipt.reused });
      await runtime.bindings.stopSelected(channelId, input, receipt.targetRunIds);
      return { text: receipt.targetRunIds.length ? "Conversation stop requested." : "No active Conversation Run." };
    });
  });
  return (request) => {
    if (request.metadata?.origin === "scheduled") return undefined;
    const humanStop = request.metadata?.humanStopRequested || /^(?:\/(?:stop|cancel|abort)|stop|abort|interrupt)$/i.test(request.text.trim());
    try {
      // Durable source identity outranks mutable command vocabularies and text.
      const kind = runtime.bindings.receiptKind(channelId, request);
      if (kind === "prompt") return conversationAgent({ chatKey: request.conversationId });
      if (kind === "stop") return stopAgent(request);
      const knownCommand = agent.isKnownCommand?.(request.text)
        || (channelId === "weixin" && isLocalWeixinSlashCommand(request.text));
      if (!humanStop && knownCommand) return undefined;
      runtime.assertOpen();
      if (humanStop) {
        const bound = runtime.bindings.hasRoute(channelId, request);
        if (!bound && (request.metadata?.origin !== "human" || request.metadata?.authenticatedHuman !== true)) return undefined;
        if (bound || runtime.bindings.stopTargets(channelId, request).length) return stopAgent(request);
      }
      if (knownCommand) return undefined;
      const selected = runtime.bindings.selectRoute(channelId, request);
      return selected ? conversationAgent(selected) : undefined;
    }
    catch (error) {
      // Corrupt/retired routing must stay out of ordinary Session lifecycle,
      // while the adapter's existing error delivery and cleanup still apply.
      return preparedAgent(async () => { throw error; });
    }
  };
}
