import type { Agent, ChatRequest, ChatResponse } from "../weixin/agent/interface";
import type { ConversationRuntime } from "../conversations/conversation-composition";
import type { ControlEventBus } from "../control/control-event-bus";
import { ConversationError } from "../conversations/conversation-error";

/** Wrap channel ingress only. Never wrap the provider/ConsoleAgent globally. */
export function createConversationChannelAgent(channelId: string, agent: Agent,
  runtime: ConversationRuntime, events: ControlEventBus, daemonSignal: AbortSignal): Agent {
  return {
    ...(agent.isKnownCommand ? { isKnownCommand: agent.isKnownCommand.bind(agent) } : {}),
    ...(agent.clearSession ? { clearSession: agent.clearSession.bind(agent) } : {}),
    async chat(request: ChatRequest): Promise<ChatResponse> {
      if (agent.isKnownCommand?.(request.text) || request.metadata?.origin === "scheduled") return agent.chat(request);
      const accepted = await runtime.withOperation(() => runtime.bindings.accept(channelId, request, daemonSignal));
      if (!accepted) return agent.chat(request);
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
          request.abortSignal?.removeEventListener("abort", stop);
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
        unsubscribe = events.subscribe((event) => {
          if ((event.type === "conversation-run-changed" || event.type === "member-turn-finished") && event.run.id === accepted.run.id) inspect();
        });
        request.abortSignal?.addEventListener("abort", stop, { once: true });
        daemonSignal.addEventListener("abort", shutdown, { once: true });
        if (daemonSignal.aborted) shutdown();
        else if (request.abortSignal?.aborted) stop();
        else inspect();
      });
    },
  };
}
