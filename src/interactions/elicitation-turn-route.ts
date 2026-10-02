/**
 * Route resolution for Elicitation on a Direct Conversation turn.
 *
 * WHY THIS EXISTS
 *
 * An elicitation can only reach a renderer if the broker can resolve a trusted
 * route for the exact turn. `resolvePermissionTurnRoute` refuses every
 * `bot:<conversation>:<topic>` isolation key, which is correct for permission
 * (a product isolation key must never mint a human permission interaction) but
 * leaves Direct Bot turns with no interactive route at all: no route means no
 * `interactionId`, and the elicitation broker cancels.
 *
 * Direct Bot turns DO have a trusted human identity — the `HumanIngressContext`
 * the hub stamps on the conversation prompt, which reaches the dispatch row with
 * its `authorityEpoch` and survives `bot:` chatKeys. So the route exists; the
 * permission resolver simply was not built to look for it.
 *
 * SEMANTICS, deliberately not "permission but more permissive":
 *
 * - The returned chatKey is the PRODUCT isolation key (`bot:...`), because that
 *   is what TurnQueue and the conversation kernel use. `replyContextToken`
 *   carries the trusted ingress chat key so a renderer that needs a user-facing
 *   address has one.
 * - `origin` is read from the caller, which resolves `authorityEpoch` +
 *   `HumanIngressContext` into `human`/`orchestration` (see
 *   `conversation-execution.ts`). A non-human origin is refused here, matching
 *   the shared resolver, so scheduled and orchestrated turns never get a UI.
 * - Nothing about the DAEMON's trust decision is relaxed: the broker still
 *   re-verifies the responder against the exact turn initiator.
 */
import { isDirectConversationChatKey, parseDirectConversationChatKey } from "../domain/ids.js";
import {
  resolveTurnInteractionRoute,
} from "../permissions/permission-turn-route.js";
import type { PermissionInteractionOrigin, TurnInteractionContext } from "../permissions/permission-types.js";
import type { ChatRequestMetadata } from "../weixin/agent/interface.js";

/** What a Direct Conversation turn supplies so an elicitation can be routed. */
export interface ElicitationRouteInput {
  /** TurnQueue isolation key, e.g. `bot:<conversationId>:<topicId>`. */
  isolationChatKey: string;
  origin?: PermissionInteractionOrigin;
  metadata?: ChatRequestMetadata;
  accountId?: string;
  /**
   * The trusted ingress chat key for this dispatch (`relay:<accountId>` on the
   * relay path), when the caller has it. Used as the reply context so a renderer
   * can address the human without guessing.
   */
  ingressChatKey?: string;
  /** The trusted responder identity (hub account id on the relay path). */
  senderId?: string;
  senderName?: string;
  isOwner?: boolean;
}

/**
 * Resolve the elicitation broker route for a Direct Conversation turn.
 *
 * Returns undefined — no route, hence no UI — when the turn is not a trusted
 * human turn, or when the isolation key is not a Direct Conversation key. The
 * second case matters: an elicitation on an ordinary channel turn keeps using
 * its own channel's route, so this resolver must not claim keys it does not own.
 */
export function resolveElicitationTurnRoute(
  input: ElicitationRouteInput,
): Omit<TurnInteractionContext, "interactionId"> | undefined {
  if (!isDirectConversationChatKey(input.isolationChatKey)) {
    return undefined;
  }
  const parsed = parseDirectConversationChatKey(input.isolationChatKey);
  if (!parsed) return undefined;
  const base = resolveTurnInteractionRoute({
    isolationChatKey: input.isolationChatKey,
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    // `permissionChatKey` is stripped on purpose. The shared resolver prefers it
    // over the isolation key, which is correct for permission — but an
    // elicitation route must stay the PRODUCT isolation key, because that is what
    // TurnQueue, the conversation kernel, and `RelayChannel`'s correlation all
    // read. Forwarding the account-wide ingress key here collapses the route to
    // `relay:<account>`, which is the same address for every topic and loses the
    // `bot:<conversation>:<topic>` split the form has to be placed on.
    // It remains available to a renderer that needs a user-facing address,
    // carried as `replyContextToken` below.
    metadata: {
      ...Object.fromEntries(
        Object.entries(input.metadata ?? {}).filter(([k]) => k !== "permissionChatKey"),
      ),
      ...(input.senderId !== undefined ? { senderId: input.senderId } : {}),
      ...(input.senderName !== undefined ? { senderName: input.senderName } : {}),
      ...(input.isOwner !== undefined ? { isOwner: input.isOwner } : {}),
    } as ChatRequestMetadata,
    ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
    // Direct Conversation keys are exactly what this resolver is FOR.
    acceptDirectConversationKeys: true,
  });
  if (!base) return undefined;
  if (!base.senderId) {
    // No trusted responder identity means no exact-turn ownership: the broker
    // would cancel anyway, so fail here with a clearer reason.
    return undefined;
  }
  // The trusted ingress address, carried out of the metadata that was stripped
  // above. A caller may also supply it directly; an explicit argument wins, since
  // the caller knows what it read off the dispatch row.
  const ingressFromMetadata = input.metadata?.permissionChatKey;
  const ingressChatKey = input.ingressChatKey
    ?? (typeof ingressFromMetadata === "string" && ingressFromMetadata !== ""
      ? ingressFromMetadata
      : undefined);
  return {
    ...base,
    ...(ingressChatKey !== undefined ? { replyContextToken: ingressChatKey } : {}),
  };
}
