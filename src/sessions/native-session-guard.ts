import { ConversationError } from "../conversations/conversation-error";
import { isHiddenProductSessionOwner, type LogicalSession } from "../state/types";
import type { AgentSession, ResolvedSession } from "../transport/types";
import { isSamePath } from "../util/path";

/**
 * Native-session addressability is product ownership of the agent-native
 * rollout, not alias prefix and not the ordinary Sessions list.
 *
 * The native catalog is a physical execution namespace (cwd + resolved launch),
 * not a config label. Two workspace names that share a cwd, or two agent aliases
 * that resolve to the same launch, occupy the same catalog.
 */
export interface NativeCatalogIdentity {
  cwd: string;
  agentCommand?: string;
  acpxAgent?: string;
  rawCommand?: string;
  driver?: string;
}

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
  /** Proven native IDs owned by product LogicalSessions in this native catalog. */
  ownedIds: Set<string>;
  /**
   * True when at least one product-owned candidate in this native catalog
   * could not prove its native identity, or a product-owned session could not
   * be resolved far enough to prove it lives in a different catalog. Attach
   * must fail closed rather than guess "not conflicting". List filtering still
   * only hides proven IDs.
   */
  unproven: boolean;
}

export function nativeCatalogIdentity(input: NativeCatalogIdentity): NativeCatalogIdentity {
  return {
    cwd: input.cwd,
    ...(input.agentCommand ? { agentCommand: input.agentCommand } : {}),
    ...(input.acpxAgent ? { acpxAgent: input.acpxAgent } : {}),
    ...(input.rawCommand ? { rawCommand: input.rawCommand } : {}),
    ...(input.driver ? { driver: input.driver } : {}),
  };
}

export function nativeCatalogFromResolved(
  session: Pick<ResolvedSession, "cwd" | "agentCommand" | "acpxAgent" | "rawCommand" | "driver">,
): NativeCatalogIdentity {
  return nativeCatalogIdentity({
    cwd: session.cwd,
    agentCommand: session.agentCommand,
    acpxAgent: session.acpxAgent,
    rawCommand: session.rawCommand,
    driver: session.driver,
  });
}

function nativeLaunchKey(identity: NativeCatalogIdentity): string {
  return [
    identity.driver ?? "",
    identity.rawCommand ?? "",
    identity.agentCommand ?? "",
    identity.acpxAgent ?? "",
  ].join("\0");
}

/** True when two identities select the same acpx native-session catalog. */
export function sameNativeCatalog(left: NativeCatalogIdentity, right: NativeCatalogIdentity): boolean {
  if (!left.cwd.trim() || !right.cwd.trim()) {
    return false;
  }
  return isSamePath(left.cwd, right.cwd) && nativeLaunchKey(left) === nativeLaunchKey(right);
}

export async function inspectProductOwnedNativeSessions(
  lookup: NativeSessionOwnershipLookup,
  catalog: NativeCatalogIdentity,
): Promise<ProductOwnedNativeIdentityInspection> {
  const ownedIds = new Set<string>();
  let unproven = false;
  const candidates = lookup.sessions
    .listLogicalSessionRecords()
    .filter((session) => isHiddenProductSessionOwner(session.owner));

  for (const record of candidates) {
    const resolved = lookup.sessions.getResolvedSessionByInternalAlias(record.alias);
    if (!resolved) {
      // Cannot prove this hidden owner lives in a different physical catalog.
      unproven = true;
      continue;
    }
    const ownedCatalog = nativeCatalogFromResolved(resolved);
    if (!ownedCatalog.cwd.trim()) {
      unproven = true;
      continue;
    }
    if (!sameNativeCatalog(ownedCatalog, catalog)) {
      continue;
    }
    const persisted = record.agent_session_id?.trim();
    if (persisted) {
      ownedIds.add(persisted);
      continue;
    }
    if (!lookup.transport.getAgentSessionId) {
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
 * candidate in this native catalog must not be treated as "not conflicting".
 */
export async function assertNativeSessionAddressable(
  lookup: NativeSessionOwnershipLookup,
  catalog: NativeCatalogIdentity,
  agentSessionId: string,
): Promise<void> {
  if (!catalog.cwd.trim()) {
    throw new ConversationError(
      "hidden_session",
      "product-owned native sessions are not addressable via ordinary Session APIs",
    );
  }
  const requested = agentSessionId.trim();
  const { ownedIds, unproven } = await inspectProductOwnedNativeSessions(lookup, catalog);
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
  catalog: NativeCatalogIdentity,
  sessions: AgentSession[],
): Promise<AgentSession[]> {
  const { ownedIds } = await inspectProductOwnedNativeSessions(lookup, catalog);
  if (ownedIds.size === 0) {
    return sessions;
  }
  return sessions.filter((session) => !ownedIds.has(session.sessionId));
}
