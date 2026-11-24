import { relayFieldsFrom, type RelayInteractionOutcome } from "@ganglion/xacpx-control-bridge";
import type { InteractionRequestDto } from "@ganglion/xacpx-relay-protocol";
import type {
  ChannelElicitationDecision,
  ChannelElicitationRequest,
  ChannelPermissionDecision,
  ChannelPermissionRequest,
} from "xacpx/plugin-api";

export const LOCAL_OWNER_ID = "local";

export interface OpenInteraction {
  chatKey: string;
  sessionAlias: string;
  interaction: InteractionRequestDto;
  resolve: (outcome: RelayInteractionOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface InteractionWire {
  chatKey: string;
  sessionAlias: string;
  interaction: InteractionRequestDto;
}

export interface InteractionFrame {
  type: "interaction-opened" | "interaction-closed";
  chatKey: string;
  sessionAlias: string;
  requestId: string;
  reason?: "resolved" | "withdrawn" | "expired";
  interaction?: InteractionRequestDto;
}

export class LocalInteractions {
  private readonly pending = new Map<string, OpenInteraction>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
    private readonly emit: (frame: InteractionFrame) => void = () => undefined,
  ) {}

  list(): InteractionWire[] {
    const now = this.now();
    return [...this.values()]
      .filter((entry) => entry.interaction.expiresAt > now)
      .map((entry) => ({
        chatKey: entry.chatKey,
        sessionAlias: entry.sessionAlias,
        interaction: entry.interaction,
      }));
  }

  peek(requestId: string): InteractionWire | undefined {
    const entry = this.pending.get(requestId);
    if (!entry) return undefined;
    return {
      chatKey: entry.chatKey,
      sessionAlias: entry.sessionAlias,
      interaction: entry.interaction,
    };
  }

  openPermission(request: ChannelPermissionRequest): Promise<ChannelPermissionDecision> {
    const interaction: InteractionRequestDto = {
      requestId: request.requestId,
      kind: "permission",
      sessionAlias: request.chatKey,
      expiresAt: request.expiresAt,
      permission: {
        ...(request.title ? { title: request.title } : {}),
        ...(request.kind ? { kind: request.kind } : {}),
        ...(request.summary ? { summary: request.summary } : {}),
        availableOutcomes: [...request.availableOutcomes],
      },
    };
    // The permission request has no session alias. The chat key is the only
    // place the card can be attached until core carries the session with it.
    return this.hold(request.chatKey, request.chatKey, interaction).then((outcome) => {
      if (!outcome.responded) throw new Error(outcome.reason);
      const action = outcome.response.action;
      if (!request.availableOutcomes.includes(action as typeof request.availableOutcomes[number])) {
        throw new Error("unsupported-action");
      }
      return {
        outcome: action as ChannelPermissionDecision["outcome"],
        responderId: outcome.response.responderId,
      };
    });
  }

  openElicitation(request: ChannelElicitationRequest): Promise<ChannelElicitationDecision> {
    if (request.chatType !== "direct") return Promise.reject(new Error("not-direct"));
    const fields = relayFieldsFrom(request.fields);
    if (fields === null) return Promise.reject(new Error("unsupported"));
    const conversation = request.conversation;
    const interaction: InteractionRequestDto = {
      requestId: request.requestId,
      kind: "elicitation",
      ...(conversation ? { conversation: { ...conversation } } : {}),
      ...(!conversation && request.agent.sessionAlias ? { sessionAlias: request.agent.sessionAlias } : {}),
      expiresAt: request.expiresAt,
      elicitation: {
        mode: "form",
        message: request.message,
        fields,
        ...(request.schemaTitle !== undefined ? { schemaTitle: request.schemaTitle } : {}),
        ...(request.schemaDescription !== undefined ? { schemaDescription: request.schemaDescription } : {}),
        agent: {
          name: request.agent.name,
          ...(request.agent.sessionAlias !== undefined ? { sessionAlias: request.agent.sessionAlias } : {}),
        },
      },
    };
    const sessionAlias = request.agent.sessionAlias ?? request.chatKey;
    return this.hold(request.chatKey, sessionAlias, interaction).then((outcome) => {
      if (!outcome.responded) throw new Error(outcome.reason);
      const response = outcome.response;
      if (response.action === "accept") {
        return { action: "accept", responderId: response.responderId, content: response.content };
      }
      if (response.action === "decline" || response.action === "cancel") {
        return { action: response.action, responderId: response.responderId };
      }
      throw new Error("unsupported-action");
    });
  }

  answer(requestId: string, outcome: RelayInteractionOutcome): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.clearTimer(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(outcome);
    const reason = outcome.responded
      ? "resolved"
      : outcome.reason === "expired" ? "expired" : "withdrawn";
    this.emit({
      type: "interaction-closed",
      chatKey: entry.chatKey,
      sessionAlias: entry.sessionAlias,
      requestId,
      reason,
    });
    return true;
  }

  closeAll(reason: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.answer(requestId, { responded: false, reason });
    }
  }

  private hold(chatKey: string, sessionAlias: string, interaction: InteractionRequestDto): Promise<RelayInteractionOutcome> {
    return new Promise((resolve) => {
      const wait = Math.max(0, interaction.expiresAt - this.now());
      const timer = this.setTimer(() => {
        this.answer(interaction.requestId, { responded: false, reason: "expired" });
      }, wait);
      this.pending.set(interaction.requestId, { chatKey, sessionAlias, interaction, resolve, timer });
      this.emit({
        type: "interaction-opened",
        chatKey,
        sessionAlias,
        requestId: interaction.requestId,
        interaction,
      });
    });
  }

  private values(): OpenInteraction[] {
    return [...this.pending.values()];
  }
}
