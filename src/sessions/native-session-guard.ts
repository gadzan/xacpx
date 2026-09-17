import { isAcpOutputGuardArgv, unwrapAcpOutputGuardArgv } from "../adapters/acp-output-guard";
import { renderAgentArgvIdentity } from "../config/agent-launch";
import { ConversationError } from "../conversations/conversation-error";
import { isHiddenProductSessionOwner, type LogicalSession } from "../state/types";
import type { AgentSession, ResolvedSession } from "../transport/types";
import { isSamePath, normalizePath } from "../util/path";

/**
 * Native-session addressability is product ownership of the agent-native
 * rollout, not alias prefix and not the ordinary Sessions list.
 *
 * The native catalog is a physical execution namespace: path-equivalent cwd plus
 * the underlying agent selector after xacpx-owned ACP transport wrappers are
 * removed. Config labels (`driver`, overlay `acpxAgent`, workspace/agent names)
 * are not part of that store identity. Distinct argv still remain distinct.
 */
export type NativeCatalogSelector =
  | { kind: "argv"; identity: string }
  | { kind: "raw-command"; command: string }
  | { kind: "bare-agent"; agent: string }
  | { kind: "unproven" };

export interface NativeCatalogIdentity {
  cwd: string;
  selector: NativeCatalogSelector;
}

/** Launch fields used to derive {@link NativeCatalogIdentity}. */
export interface NativeCatalogLaunchInput {
  cwd: string;
  driver?: string;
  agentCommand?: string;
  acpxAgent?: string;
  rawCommand?: string;
  agentArgv?: readonly string[];
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
  if (isNativeCatalogUnproven(input)) {
    return { cwd: "", selector: { kind: "unproven" } };
  }
  return {
    cwd: canonicalizeNativeCatalogCwd(input.cwd),
    selector: input.selector,
  };
}

/**
 * Canonical native-session catalog identity: cwd plus the physical agent
 * selector, never ACP spawn wrappers and never config-label aliases.
 *
 * Evidence precedence:
 *   argv (after unwrap)
 *   → explicit rawCommand
 *   → managed overlay acpxAgent without argv (unproven)
 *   → historical agentCommand (guard-shaped → unproven, else raw-command)
 *   → ordinary bare acpxAgent
 *
 * Explicit `rawCommand` proves a raw `--agent` selector. Recorded
 * `agentCommand` is only historical identity and cannot override a managed
 * overlay alias that lost its argv. `driver` / overlay names are otherwise
 * launch-registration metadata, not store identity.
 */
export function nativeCatalogIdentityForLaunch(input: NativeCatalogLaunchInput): NativeCatalogIdentity {
  const cwd = canonicalizeNativeCatalogCwd(input.cwd);
  if (!cwd) {
    return { cwd: "", selector: { kind: "unproven" } };
  }

  const argv = input.agentArgv && input.agentArgv.length > 0 ? [...input.agentArgv] : undefined;
  if (argv) {
    if (isAcpOutputGuardArgv(argv) && unwrapAcpOutputGuardArgv(argv).length === 0) {
      return { cwd: "", selector: { kind: "unproven" } };
    }
    const underlying = unwrapAcpOutputGuardArgv(argv);
    if (underlying.length > 0) {
      return {
        cwd,
        selector: { kind: "argv", identity: renderAgentArgvIdentity(underlying) },
      };
    }
  }

  const rawCommand = input.rawCommand?.trim();
  if (rawCommand) {
    return { cwd, selector: { kind: "raw-command", command: rawCommand } };
  }

  const acpxAgent = input.acpxAgent?.trim();
  if (!argv && acpxAgent && looksLikeManagedOverlayAlias(acpxAgent)) {
    return { cwd: "", selector: { kind: "unproven" } };
  }

  const historical = input.agentCommand?.trim();
  if (historical && !argv) {
    if (looksLikeAcpOutputGuardCommand(historical)) {
      return { cwd: "", selector: { kind: "unproven" } };
    }
    return { cwd, selector: { kind: "raw-command", command: historical } };
  }

  if (acpxAgent) {
    return { cwd, selector: { kind: "bare-agent", agent: acpxAgent } };
  }

  return { cwd: "", selector: { kind: "unproven" } };
}

export function nativeCatalogFromResolved(
  session: Pick<ResolvedSession, "cwd" | "agentCommand" | "acpxAgent" | "rawCommand" | "driver" | "agentArgv">,
): NativeCatalogIdentity {
  return nativeCatalogIdentityForLaunch({
    cwd: session.cwd,
    agentCommand: session.agentCommand,
    acpxAgent: session.acpxAgent,
    rawCommand: session.rawCommand,
    driver: session.driver,
    agentArgv: session.agentArgv,
  });
}

export function isNativeCatalogUnproven(identity: NativeCatalogIdentity): boolean {
  return identity.selector.kind === "unproven" || !identity.cwd.trim();
}

function canonicalizeNativeCatalogCwd(cwd: string): string {
  const trimmed = cwd.trim();
  return trimmed ? normalizePath(trimmed) : "";
}

function looksLikeAcpOutputGuardCommand(command: string | undefined): boolean {
  if (!command) return false;
  const normalized = command.replaceAll("\\", "/");
  return normalized.includes("/acp-output-guard-main.");
}

function looksLikeManagedOverlayAlias(value: string): boolean {
  return value.startsWith("xacpx-managed-");
}

function nativeSelectorKey(identity: NativeCatalogIdentity): string {
  const selector = identity.selector;
  switch (selector.kind) {
    case "argv":
      return `argv\0${selector.identity}`;
    case "raw-command":
      return `raw-command\0${selector.command}`;
    case "bare-agent":
      return `bare-agent\0${selector.agent}`;
    case "unproven":
      return "unproven";
  }
}

/** True when two identities select the same agent-native session catalog. */
export function sameNativeCatalog(left: NativeCatalogIdentity, right: NativeCatalogIdentity): boolean {
  if (isNativeCatalogUnproven(left) || isNativeCatalogUnproven(right)) {
    return false;
  }
  return isSamePath(left.cwd, right.cwd) && nativeSelectorKey(left) === nativeSelectorKey(right);
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
    if (isNativeCatalogUnproven(ownedCatalog)) {
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
  if (isNativeCatalogUnproven(catalog)) {
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
