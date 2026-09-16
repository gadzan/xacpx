import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";

import type { ConversationTurnCorrelation } from "../control/conversation-control-dtos.js";
import type { ControlPromptResult } from "../control/control-service.js";
import type { PermissionInteractionOrigin } from "../permissions/permission-types.js";

/**
 * Core-private Conversation execution input. `executionOrigin` and `conversation`
 * are store/dispatcher-derived; this type is not part of the public Control
 * contract and must not be filled by channel plugins or Relay callers.
 */
export interface ConversationExecutionPromptInput {
  chatKey: string;
  sessionAlias: string;
  text: string;
  accountId?: string;
  senderId: string;
  isOwner?: boolean;
  media?: PromptAttachmentRef[];
  agentMentions?: Array<{ range: [number, number]; handle: string }>;
  promptRequestId?: string;
  abortSignal?: AbortSignal;
  /**
   * Server-derived execution provenance from the durable MemberTurn after claim.
   * `promptImmediate` fail-closes to orchestration unless this is exactly `"human"`.
   */
  executionOrigin?: PermissionInteractionOrigin;
  /** Exact Conversation/Run/MemberTurn join identity for this claimed turn. */
  conversation: ConversationTurnCorrelation;
}

/**
 * Trusted Conversation execution seam. Only the durable Conversation engine
 * (dispatcher → ControlConversationTurnRunner) may hold this port.
 *
 * Public Control / plugin / Relay callers address Bot / Conversation / Topic /
 * Run IDs and never receive this type.
 */
export interface ConversationExecutionPort {
  promptImmediate(input: ConversationExecutionPromptInput): Promise<ControlPromptResult>;
  cancelTurnForPromptRequest(
    chatKey: string,
    sessionAlias: string,
    promptRequestId: string,
  ): boolean;
  inspectPromptRequest(
    chatKey: string,
    sessionAlias: string,
    promptRequestId: string,
  ): "in-flight" | "settled" | "absent";
  /** Exact queue-item cancel for a Conversation-owned hidden session. */
  cancelQueuedConversationItem(
    chatKey: string,
    sessionAlias: string,
    itemId: string,
  ): { cancelled: boolean };
}
