import type {
  ControlExecuteCommandInput,
  ControlPromptInput,
  ControlPromptResult,
  ControlService,
  ControlSessionInfo,
} from "./control-service.js";
import type { ConversationPromptRequestDto } from "./conversation-control-dtos.js";
import { ConversationError } from "../conversations/conversation-error.js";

export type {
  ControlExecuteCommandInput,
  ControlPromptInput,
  ControlPromptResult,
  ControlSessionInfo,
};

/** Public interactive prompt input. No writable execution origin or Conversation authority. */
export type PublicControlPromptInput = ControlPromptInput;

const TRUSTED_CONTROL_METHODS = [
  "promptImmediate",
  "cancelTurnForPromptRequest",
  "inspectPromptRequest",
  "cancelQueuedConversationItem",
  "bindConversationRuntime",
  "emitConversationProduct",
  "promptConversationFromHumanIngress",
  "promptConversationWithPolicyFromHumanIngress",
] as const;

type TrustedControlMethod = (typeof TRUSTED_CONTROL_METHODS)[number];

/**
 * Plugin / channel / Relay Control facade. This is the ControlService class
 * type with trusted Conversation execution omitted. Those methods live only on
 * the core-private `conversationKernel()` / ConversationExecutionPort, never as
 * ControlService instance methods.
 */
export type PublicControlService = Omit<ControlService, TrustedControlMethod>;

function isTrustedControlMethod(prop: PropertyKey): prop is TrustedControlMethod {
  return (TRUSTED_CONTROL_METHODS as readonly PropertyKey[]).includes(prop);
}

export function sanitizePublicConversationPrompt(
  input: ConversationPromptRequestDto,
): ConversationPromptRequestDto {
  const target = input.target;
  let sanitized: ConversationPromptRequestDto["target"];
  if (target !== undefined) {
    // The variants are a mutually exclusive union. A target that is present
    // but not a well-formed single variant is NEVER laundered into whichever
    // variant matches first and NEVER silently dropped: dropping would fail
    // Direct open (target is optional there, so the owning bot would execute
    // instead of the route the caller asked for) while Group merely reached
    // `target_required`. Either way the caller's structured routing was
    // rewritten — so reject at the boundary with the same typed code the
    // accept path uses (botId + mode:"automatic" must not become a direct
    // execution of botId).
    const invalid = (): never => {
      throw new ConversationError(
        "invalid-target",
        "conversation prompt target must be exactly one variant: {botId}, {mode:\"members\", botIds}, {mode:\"everyone\"}, or {mode:\"automatic\"}",
      );
    };
    if (target === null || typeof target !== "object") {
      invalid();
    }
    const hasBotId = "botId" in target;
    const hasMode = "mode" in target;
    const hasBotIds = "botIds" in target;
    const mixed = (hasBotId && (hasMode || hasBotIds)) || (hasMode && hasBotIds && target.mode !== "members");
    if (mixed) {
      invalid();
    }
    if (hasBotId && typeof target.botId === "string") {
      sanitized = { botId: target.botId };
    } else if (hasMode && target.mode === "members" && hasBotIds
      && Array.isArray(target.botIds) && target.botIds.every((entry): entry is string => typeof entry === "string")) {
      sanitized = { mode: "members", botIds: [...target.botIds] };
    } else if (hasMode && (target.mode === "everyone" || target.mode === "automatic")) {
      sanitized = { mode: target.mode };
    } else {
      invalid();
    }
  }
  return {
    conversationId: input.conversationId,
    topicId: input.topicId,
    requestId: input.requestId,
    text: input.text,
    ...(sanitized ? { target: sanitized } : {}),
  };
}

export function sanitizePublicPromptInput(input: PublicControlPromptInput): ControlPromptInput {
  return {
    chatKey: input.chatKey,
    sessionAlias: input.sessionAlias,
    text: input.text,
    senderId: input.senderId,
    ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
    ...(input.isOwner !== undefined ? { isOwner: input.isOwner } : {}),
    ...(input.media !== undefined ? { media: input.media } : {}),
    ...(input.agentMentions !== undefined ? { agentMentions: input.agentMentions } : {}),
    ...(input.promptRequestId !== undefined ? { promptRequestId: input.promptRequestId } : {}),
    ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
  };
}

/**
 * Channel injection helper: sanitizes public prompt input and hides trusted
 * method names if they are ever present. Production ControlService instances
 * do not own those methods; Conversation execution uses `conversationKernel()`.
 * `ChannelStartInput.control` must be this object, not a kernel.
 */
export function asPublicControl(control: ControlService): PublicControlService;
export function asPublicControl(control: ControlService | undefined | null): PublicControlService | undefined;
export function asPublicControl(
  control: ControlService | undefined | null,
): PublicControlService | undefined {
  if (control == null) {
    return undefined;
  }
  return new Proxy(control, {
    get(target, prop, receiver) {
      if (isTrustedControlMethod(prop)) {
        return undefined;
      }
      if (prop === "prompt") {
        return (input: PublicControlPromptInput) => target.prompt(sanitizePublicPromptInput(input));
      }
      if (prop === "promptConversation") {
        // Sanitize INSIDE the async body: a malformed target must surface as
        // a rejected promise on every path. Throwing synchronously from the
        // proxy would escape the caller's `.catch` and crash channel code
        // that treats promptConversation as promise-returning.
        return async (input: ConversationPromptRequestDto) =>
          target.promptConversation(sanitizePublicConversationPrompt(input));
      }
      if (prop === "cancelQueuedItem") {
        return (chatKey: string, sessionAlias: string, itemId: string) =>
          target.cancelQueuedItem(chatKey, sessionAlias, itemId);
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    },
    has(target, prop) {
      if (isTrustedControlMethod(prop)) {
        return false;
      }
      return prop in target;
    },
    getOwnPropertyDescriptor(target, prop) {
      if (isTrustedControlMethod(prop)) {
        return undefined;
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((key) => !isTrustedControlMethod(key));
    },
  }) as PublicControlService;
}
