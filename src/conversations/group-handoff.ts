import { randomUUID } from "node:crypto";
import { snapshotGroupMemberProfile } from "../bots/bot-types";
import type { BotService } from "../bots/bot-service";
import type { AppState } from "../state/types";
import { ConversationError } from "./conversation-error";
import { emitConversationProductEvent, type ConversationProductEventSink } from "./conversation-product-events";
import type { AcceptPublicHandoffInput, ConversationStore, GroupSendInput, PublicHandoffReceipt } from "./conversation-store";

export const GROUP_EXECUTION_PREFIX = "group-execution:";
export const MAX_GROUP_TASK_LENGTH = 16_000;
export const MAX_GROUP_EXPECTED_OUTPUT_LENGTH = 8_000;

export function parseGroupSend(value: unknown): GroupSendInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationError("invalid_group_send", "group_send requires an object");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["to", "task", "expectedOutput"].includes(key))) {
    throw new ConversationError("invalid_group_send", "group_send accepts only to, task and expectedOutput");
  }
  const bounded = (key: string, limit: number): string => {
    const field = raw[key];
    if (typeof field !== "string" || field.length > limit || !field.trim() || field.includes("\u0000")) {
      throw new ConversationError("invalid_group_send", `${key} must be a nonempty bounded string`);
    }
    return field;
  };
  return {
    to: bounded("to", 128), task: bounded("task", MAX_GROUP_TASK_LENGTH),
    ...(raw.expectedOutput !== undefined ? { expectedOutput: bounded("expectedOutput", MAX_GROUP_EXPECTED_OUTPUT_LENGTH) } : {}),
  };
}

/** Private wire envelope stamped by the MCP server, never model tool args. */
export interface GroupSendInvocation {
  executionToken: string;
  invocationId: string;
  args: unknown;
}

type ExecutionBinding = Omit<AcceptPublicHandoffInput, "args" | "profileSnapshot" | "now" | "invocationId">;

/** Each capability names ONE physical execution, not a reusable session alias.
 * A retired token cannot authorize a later execution. IPC trusts the OS user;
 * this bearer capability does not authenticate the presenting process. */
export class GroupHandoffService {
  private readonly executions = new Map<string, ExecutionBinding>();
  private closed = false;
  constructor(private readonly options: {
    store: ConversationStore;
    bots: BotService;
    state: AppState;
    now?: () => Date;
    onProductEvent?: ConversationProductEventSink;
    wake: () => void;
    beforeCommitGates?: () => Promise<void>;
  }) {}

  bindExecution(binding: ExecutionBinding): { token: string; release: () => void } {
    if (this.closed) throw new ConversationError("runtime_closed", "Group handoff runtime is closed");
    const token = `${GROUP_EXECUTION_PREFIX}${randomUUID()}`;
    this.executions.set(token, Object.freeze({ ...binding }));
    return { token, release: () => { this.executions.delete(token); } };
  }

  close(): void { this.closed = true; this.executions.clear(); }

  memberContext(token: string): string {
    const binding = this.executions.get(token);
    const member = binding ? this.options.store.getMemberTurn(binding.senderMemberTurnId) : undefined;
    const group = member ? this.options.state.conversations[member.conversationId] : undefined;
    if (!group) throw new ConversationError("group_execution_unknown", "Group execution disappeared");
    const quarantine = member ? this.options.store.getRun(member.runId)?.quarantinedBotIds ?? [] : [];
    const members = group.botIds.slice(0, 128).map((id) => ({ botId: id, name: this.options.state.bots[id]?.name?.slice(0, 200),
      enabled: this.options.state.bots[id]?.enabled === true, unavailableForRun: quarantine.includes(id) }));
    return `Public Group members (canonical Bot IDs):\n${JSON.stringify({ members, omittedMemberCount: Math.max(0, group.botIds.length - members.length) })}\nUse group_send for an explicit public downstream assignment. Tool acceptance does not mean execution has started.`;
  }

  async send(input: GroupSendInvocation): Promise<PublicHandoffReceipt> {
    if (this.closed) throw new ConversationError("runtime_closed", "Group handoff runtime is closed");
    const binding = this.executions.get(input.executionToken);
    if (!binding) throw new ConversationError("group_execution_unknown", "group_send requires a live bound Group execution");
    if (typeof input.invocationId !== "string" || !input.invocationId || input.invocationId.length > 128) {
      throw new ConversationError("invalid_group_invocation", "missing bounded runtime invocation identity");
    }
    const args = parseGroupSend(input.args);
    // Durable replays return only the old receipt; they never grant more work,
    // even if cancellation/membership changed after the original commit.
    const prior = this.options.store.getPublicHandoff(binding.sourceTurnId, input.invocationId, args);
    if (prior) return prior;
    const sender = this.options.store.getMemberTurn(binding.senderMemberTurnId);
    if (!sender) throw new ConversationError("group_execution_unknown", "sender execution disappeared");
    // Reject arbitrary target IDs before the permanent per-Bot gate registry
    // sees them. These unlocked reads are only an allocation guard; the
    // authoritative membership/existence checks still run inside the gates.
    const candidateGroup = this.options.state.conversations[sender.conversationId];
    if (!candidateGroup || candidateGroup.kind !== "group"
      || !candidateGroup.botIds.includes(sender.botId) || !candidateGroup.botIds.includes(args.to)) {
      throw new ConversationError("handoff_not_member", "sender and target must be current Group members");
    }
    this.options.bots.getBot(args.to);
    await this.options.beforeCommitGates?.();
    const receipt = await this.options.bots.runLifecycleAll([sender.botId, args.to], async () => {
      if (this.closed || this.executions.get(input.executionToken) !== binding) {
        throw new ConversationError("group_execution_unknown", "sender execution ended");
      }
      const live = this.options.store.getMemberTurn(sender.id);
      const group = this.options.state.conversations[sender.conversationId];
      const topic = this.options.state.conversation_topics[sender.topicId];
      if (!group || group.kind !== "group" || !group.botIds.includes(sender.botId) || !group.botIds.includes(args.to)) {
        throw new ConversationError("handoff_not_member", "sender and target must be current Group members");
      }
      if (args.to === sender.botId) throw new ConversationError("handoff_self_target", "handoff requires another Group member");
      if (group.lifecycle === "deleting" || topic?.status !== "active" || topic.conversationId !== group.id || !topic.executionTarget) {
        throw new ConversationError("topic_not_active", "Group Topic is not active");
      }
      const session = live?.sessionAlias ? this.options.state.sessions[live.sessionAlias] : undefined;
      const owner = session?.owner;
      const runtime = owner?.bindingId ? this.options.state.bot_runtime_bindings[owner.bindingId] : undefined;
      if (!live || live.sourceTurnId !== binding.sourceTurnId || live.state !== "running"
        || owner?.kind !== "group-member" || owner.botId !== sender.botId
        || owner.conversationId !== group.id || owner.topicId !== topic.id
        || session?.logical_session_id !== live.logicalSessionId || runtime?.scope !== "group-member"
        || runtime.botId !== sender.botId || runtime.conversationId !== group.id || runtime.topicId !== topic.id
        || runtime.sessionAlias !== live.sessionAlias || runtime.logicalSessionId !== live.logicalSessionId) {
        throw new ConversationError("group_binding_mismatch", "sender no longer owns the current execution binding");
      }
      const target = this.options.bots.getBot(args.to);
      if (!target.enabled) throw new ConversationError("handoff_disabled_member", "target Bot is disabled");
      const timestamp = (this.options.now?.() ?? new Date()).toISOString();
      // No await between final lifecycle read and the synchronous transaction.
      return this.options.store.acceptPublicHandoff({ ...binding, invocationId: input.invocationId, args,
        profileSnapshot: snapshotGroupMemberProfile(target, topic.executionTarget, timestamp), now: timestamp });
    });
    if (!receipt.reused) {
      emitConversationProductEvent(this.options.onProductEvent, { type: "conversation-message", message: receipt.message });
      emitConversationProductEvent(this.options.onProductEvent, { type: "conversation-run-changed", run: receipt.run });
      this.options.wake();
    }
    return receipt;
  }
}
