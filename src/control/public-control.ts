import type {
  ControlExecuteCommandInput,
  ControlPromptInput,
  ControlPromptResult,
  ControlService,
  ControlSessionInfo,
} from "./control-service.js";

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
