import { createHash, randomUUID } from "node:crypto";
import {
  encodeAgentHandle,
  decodeAgentHandle,
} from "../orchestration/agent-handle";
import type {
  AgentEndpointView,
  AgentSenderBinding,
  AgentMessageSendInput,
  AgentMessageReceipt,
} from "../orchestration/agent-messaging-types";
import type { AppState } from "../state/types";
import type { BotService } from "../bots/bot-service";
import type { ConversationStore } from "./conversation-store";
import type { ConversationRunService } from "./conversation-run-service";
import type { AgentMention } from "@ganglion/xacpx-relay-protocol";
import type { ResolvedDirectMention } from "./direct-input-metadata";
import { ConversationError } from "./conversation-error";
export const DIRECT_EXECUTION_PREFIX = "direct-execution:";
interface Binding {
  memberTurnId: string;
  sourceTurnId: string;
  dispatchId: string;
  owner: string;
  generation: number;
}
/** Same-instance product Endpoint registry. Handles are identities, never authority. */
export class DirectBotEndpointRegistry {
  constructor(
    private readonly state: AppState,
    private readonly bots: BotService,
    private readonly nodeId: string,
  ) {}
  list(senderBotId: string): AgentEndpointView[] {
    const sender = this.bots.getBot(senderBotId);
    this.bots.assertAcceptsWork(sender.id);
    if (!sender.enabled)
      throw new ConversationError("bot_disabled", "sender Bot disabled");
    return this.bots
      .listBots()
      .filter((b) => b.id !== senderBotId && b.enabled)
      .filter((b) => {
        try {
          this.bots.assertAcceptsWork(b.id);
          return true;
        } catch {
          return false;
        }
      })
      .map((b) => ({
        address: { nodeId: this.nodeId, endpointId: "product-bot-" + b.id },
        handle: this.handle(b.id),
        node: this.nodeId,
        displayName: b.name,
        agent: b.agent,
        workspace: b.workspace,
        state: "idle" as const,
        activity: { status: "idle" as const },
        capabilities: {
          receive: true,
          queue: true,
          steer: false,
          interrupt: false,
          conversation: false,
          completion: false,
        },
      }));
  }
  handle(botId: string): string {
    return encodeAgentHandle({
      nodeId: this.nodeId,
      endpointId: "product-bot-" + botId,
    });
  }
  resolve(
    senderBotId: string,
    handle: string,
  ): { botId: string; endpoint: AgentEndpointView } {
    const address = decodeAgentHandle(handle);
    const endpoint = this.list(senderBotId).find((e) => e.handle === handle);
    if (
      !address ||
      !endpoint ||
      address.nodeId !== this.nodeId ||
      !address.endpointId.startsWith("product-bot-")
    )
      throw new ConversationError(
        "target_unavailable",
        "reference target is no longer authorized",
      );
    return { botId: address.endpointId.slice("product-bot-".length), endpoint };
  }
  mentions(botId: string, mentions: AgentMention[]): ResolvedDirectMention[] {
    return mentions.map((m) => {
      const { botId: target, endpoint } = this.resolve(botId, m.handle);
      return {
        ...m,
        range: [...m.range] as [number, number],
        botId: target,
        agent: endpoint.agent,
        workspace: endpoint.workspace!,
        displayName: endpoint.displayName!,
      };
    });
  }
  revalidate(botId: string, mentions: ResolvedDirectMention[]): void {
    for (const m of mentions) {
      const target = this.resolve(botId, m.handle);
      if (
        target.botId !== m.botId ||
        target.endpoint.agent !== m.agent ||
        target.endpoint.workspace !== m.workspace
      )
        throw new ConversationError(
          "target_unavailable",
          "accepted reference identity changed",
        );
    }
  }
}
export class DirectMessagingService {
  readonly registry: DirectBotEndpointRegistry;
  private readonly bindings = new Map<string, Binding>();
  private readonly sent = new Map<string, Set<string>>();
  private closed = false;
  constructor(
    private readonly input: {
      state: AppState;
      bots: BotService;
      store: ConversationStore;
      runs: ConversationRunService;
      nodeId: string;
      now?: () => Date;
    },
  ) {
    this.registry = new DirectBotEndpointRegistry(
      input.state,
      input.bots,
      input.nodeId,
    );
  }
  bindExecution(binding: Binding): { token: string; release: () => void } {
    if (this.closed)
      throw new ConversationError("runtime_closed", "Direct messaging closed");
    const token = DIRECT_EXECUTION_PREFIX + randomUUID();
    this.bindings.set(token, Object.freeze({ ...binding }));
    return {
      token,
      release: () => {
        this.bindings.delete(token);
        this.sent.delete(token);
      },
    };
  }
  close(): void {
    this.closed = true;
    this.bindings.clear();
    this.sent.clear();
  }
  private sender(binding: AgentSenderBinding) {
    const token = binding.sourceHandle;
    const execution =
      token && binding.coordinatorSession === token
        ? this.bindings.get(token)
        : undefined;
    const member = execution
      ? this.input.store.getMemberTurn(execution.memberTurnId)
      : undefined;
    const run = member ? this.input.store.getRun(member.runId) : undefined;
    const dispatch = member
      ? this.input.store.getDispatchForMemberTurn(member.id)
      : undefined;
    const session = member?.sessionAlias
      ? this.input.state.sessions[member.sessionAlias]
      : undefined;
    const owner = session?.owner;
    const runtime = owner?.bindingId
      ? this.input.state.bot_runtime_bindings[owner.bindingId]
      : undefined;
    const topic = member
      ? this.input.state.conversation_topics[member.topicId]
      : undefined;
    if (
      this.closed ||
      !execution ||
      !member ||
      !run ||
      run.state !== "running" ||
      run.completionReason !== undefined ||
      member.state !== "running" ||
      member.sourceTurnId !== execution.sourceTurnId ||
      dispatch?.state !== "claimed" ||
      dispatch.id !== execution.dispatchId ||
      dispatch.owner !== execution.owner ||
      dispatch.generation !== execution.generation ||
      !dispatch.leaseExpiresAt ||
      Date.parse(dispatch.leaseExpiresAt) <=
        (this.input.now?.() ?? new Date()).getTime() ||
      owner?.kind !== "bot-direct" ||
      owner.botId !== member.botId ||
      owner.conversationId !== member.conversationId ||
      owner.topicId !== member.topicId ||
      session?.logical_session_id !== member.logicalSessionId ||
      runtime?.scope !== "bot-direct" ||
      runtime.sessionAlias !== member.sessionAlias ||
      runtime.logicalSessionId !== member.logicalSessionId ||
      runtime.botId !== member.botId ||
      runtime.conversationId !== member.conversationId ||
      runtime.topicId !== member.topicId ||
      topic?.status !== "active" ||
      topic.conversationId !== member.conversationId ||
      (runtime.contextGeneration ?? 1) !== (topic.contextGeneration ?? 1) ||
      this.input.state.conversations[member.conversationId]?.kind !== "bot" ||
      this.input.state.conversations[member.conversationId]?.lifecycle ===
        "deleting" ||
      this.input.store.isConversationDeleting(member.conversationId) ||
      this.input.store.isTopicDeleting(member.topicId) ||
      this.input.store.isTopicResetting(member.topicId) ||
      member.effect === "read-only"
    )
      throw new ConversationError(
        "direct_execution_unknown",
        "Direct messaging requires the current unrestricted execution",
      );
    const bot = this.input.bots.getBot(member.botId);
    this.input.bots.assertAcceptsWork(bot.id);
    if (!bot.enabled)
      throw new ConversationError("bot_disabled", "sender disabled");
    if (
      bot.profileRevision !==
      (member.profileSnapshot ?? run.profileSnapshot).revision
    )
      throw new ConversationError(
        "direct_execution_unknown",
        "sender profile revision changed",
      );
    return member;
  }
  listReachable(binding: AgentSenderBinding): AgentEndpointView[] {
    return this.registry.list(this.sender(binding).botId);
  }
  async send(
    binding: AgentSenderBinding,
    args: AgentMessageSendInput,
  ): Promise<AgentMessageReceipt> {
    const source = this.sender(binding);
    if (
      (args.mode && !["auto", "queue"].includes(args.mode)) ||
      args.replyTo ||
      (args.completion && args.completion !== "none")
    )
      throw new ConversationError(
        "messaging_mode_unavailable",
        "Direct V1 supports one-way queue/auto only; no reply/completion",
      );
    if (
      typeof args.content !== "string" ||
      !args.content.trim() ||
      Buffer.byteLength(args.content) > 16000 ||
      args.content.includes("\0")
    )
      throw new ConversationError(
        "invalid-message",
        "message must be nonempty and at most 16000 bytes",
      );
    if (!args.to || args.selector)
      throw new ConversationError(
        "invalid-target",
        "Direct messaging requires an exact authorized handle",
      );
    const { botId: targetBotId } = this.registry.resolve(source.botId, args.to);
    const request = this.input.store.getMessage(
      this.input.store.getRun(source.runId)!.requestMessageId,
    );
    const depth = (request?.inputMetadata?.peer?.depth ?? 0) + 1;
    if (
      depth > 8 ||
      /^(ok|ack|received|收到|好的)[.!。！\s]*$/i.test(args.content.trim())
    )
      throw new ConversationError(
        "message_budget_exceeded",
        "peer depth budget or acknowledgement loop rejected",
      );
    // Stable per-execution/message id makes repeated identical calls replay durable admission.
    const messageId =
      "msg_direct_" +
      createHash("sha256")
        .update(JSON.stringify([source.sourceTurnId, args.to, args.content]))
        .digest("hex")
        .slice(0, 40);
    const sent = this.sent.get(binding.sourceHandle!) ?? new Set<string>();
    if (!sent.has(messageId) && sent.size >= 16)
      throw new ConversationError(
        "message_budget_exceeded",
        "at most 16 messages per execution",
      );
    sent.add(messageId);
    this.sent.set(binding.sourceHandle!, sent);
    const scope = {
      sourceConversationId: source.conversationId,
      sourceTopicId: source.topicId,
      sourceBotId: source.botId,
    };
    const topic = await this.input.runs.ensurePeerTopic(targetBotId, scope);
    this.sender(binding);
    this.registry.resolve(source.botId, args.to);
    const accepted = await this.input.runs.acceptDirectPrompt({
      botId: targetBotId,
      conversationId: topic.conversationId,
      topicId: topic.id,
      requestId: messageId,
      content: args.content,
      peerInput: { version: 1, peer: { messageId, ...scope, depth } },
      beforeCommit: () => {
        this.sender(binding);
        this.registry.resolve(source.botId, args.to!);
      },
    });
    return {
      messageId,
      status: "queued",
      modeUsed: "queue",
      route: "local",
      ...(accepted.reused ? { deduplicated: true } : {}),
    };
  }
}
