import { ConversationError } from "../conversations/conversation-error";
import { isHiddenProductSessionOwner, type LogicalSession } from "../state/types";
import type { AgentSession, ResolvedSession } from "../transport/types";

/**
 * Native-session addressability is product ownership of the agent-native
 * rollout, not alias prefix and not the ordinary Sessions list.
 *
 * A hidden Bot/Group LogicalSession may hold the same underlying native ID
 * (`agent_session_id`, or the live identity from `getAgentSessionId`). Ordinary
 * native list/attach must not remount that model context as a second Session.
 */
export interface NativeSessionOwnershipLookup {
  sessions: {
    listLogicalSessionRecords(): LogicalSession[];
    getResolvedSessionByInternalAlias(alias: string): ResolvedSession | null;
  };
  transport: {
    getAgentSessionId?(session: ResolvedSession): Promise<string | undefined>;
  };
}

export interface ProductOwnedNativeIdentityInspection {
  /** Proven native IDs owned by product LogicalSessions for this agent/workspace. */
  ownedIds: Set<string>;
  /**
   * True when at least one product-owned candidate exists in this agent/workspace
   * whose native identity could not be proven. Attach must fail closed rather
   * than guess "not conflicting". List filtering still only hides proven IDs.
   */
  unproven: boolean;
}

function sameAgentWorkspace(session: LogicalSession, agent: string, workspace: string): boolean {
  return session.agent === agent && session.workspace === workspace;
}

export async function inspectProductOwnedNativeSessions(
  lookup: NativeSessionOwnershipLookup,
  agent: string,
  workspace: string,
): Promise<ProductOwnedNativeIdentityInspection> {
  const ownedIds = new Set<string>();
  let unproven = false;
  const candidates = lookup.sessions
    .listLogicalSessionRecords()
    .filter((session) => sameAgentWorkspace(session, agent, workspace) && isHiddenProductSessionOwner(session.owner));

  for (const record of candidates) {
    const persisted = record.agent_session_id?.trim();
    if (persisted) {
      ownedIds.add(persisted);
      continue;
    }
    const resolved = lookup.sessions.getResolvedSessionByInternalAlias(record.alias);
    if (!resolved || !lookup.transport.getAgentSessionId) {
      unproven = true;
      continue;
    }
    try {
      const lookedUp = (await lookup.transport.getAgentSessionId(resolved))?.trim();
      if (lookedUp) {
        ownedIds.add(lookedUp);
      } else {
        unproven = true;
      }
    } catch {
      unproven = true;
    }
  }

  return { ownedIds, unproven };
}

/**
 * Authoritative attach guard. List filtering is presentation only: submitting a
 * hidden native ID directly must still fail, and an unproven product-owned
 * candidate must not be treated as "not conflicting".
 */
export async function assertNativeSessionAddressable(
  lookup: NativeSessionOwnershipLookup,
  agent: string,
  workspace: string,
  agentSessionId: string,
): Promise<void> {
  const requested = agentSessionId.trim();
  const { ownedIds, unproven } = await inspectProductOwnedNativeSessions(lookup, agent, workspace);
  if (unproven || (requested.length > 0 && ownedIds.has(requested))) {
    throw new ConversationError(
      "hidden_session",
      "product-owned native sessions are not addressable via ordinary Session APIs",
    );
  }
}

/** Presentation filter for the public native catalog. Not a security boundary. */
export async function filterAddressableNativeSessions(
  lookup: NativeSessionOwnershipLookup,
  agent: string,
  workspace: string,
  sessions: AgentSession[],
): Promise<AgentSession[]> {
  const { ownedIds } = await inspectProductOwnedNativeSessions(lookup, agent, workspace);
  if (ownedIds.size === 0) {
    return sessions;
  }
  return sessions.filter((session) => !ownedIds.has(session.sessionId));
}
