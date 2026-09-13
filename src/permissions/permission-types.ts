/**
 * Core-private permission interaction types.
 *
 * The broker owns exact-turn routing. Runtime/worker layers must never see
 * Discord/Feishu channel ids, sender ids, or reply tokens — only the opaque
 * interactionId created at prompt dispatch.
 */

export type PermissionOutcome =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always"
  | "cancel";

export const PERMISSION_OUTCOMES: readonly PermissionOutcome[] = [
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
  "cancel",
] as const;

export function isPermissionOutcome(value: unknown): value is PermissionOutcome {
  return (
    value === "allow_once" ||
    value === "allow_always" ||
    value === "reject_once" ||
    value === "reject_always" ||
    value === "cancel"
  );
}

export type PermissionInteractionOrigin = "human" | "scheduled" | "peer" | "orchestration";

export interface TurnInteractionContext {
  interactionId: string;
  chatKey: string;
  accountId?: string;
  replyContextToken?: string;
  senderId?: string;
  senderName?: string;
  isOwner?: boolean;
  origin: PermissionInteractionOrigin;
}

/**
 * Runtime-side permission request as seen by the daemon broker.
 * Extends the bridge ResolvePermissionRequestParams with the opaque
 * interaction id and the normalized ACP-supported outcomes.
 */
export interface RuntimePermissionInteractionRequest {
  logicalSessionId?: string;
  sessionKey?: string;
  requestId: string;
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  policyGeneration: number;
  workerGeneration: string;
  interactionId?: string;
  availableOutcomes?: PermissionOutcome[];
}
