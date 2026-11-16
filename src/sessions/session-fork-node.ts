import { createHash } from "node:crypto";

import type { NativeHistoryMessage } from "../transport/native-session-history";
import type { SessionForkTurnNode } from "./session-fork-store";

/** Digest of the exact prompt text a turn handed to the agent. The acpx record
 *  stores that same string, so equality identifies the turn without relying on
 *  provider-managed ids (acpx mints its own random user-message ids). */
export function sessionForkPromptDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Digest of the rows a node fork renders. Growth appends after the prefix and
 *  leaves it unchanged; a reset, clear, or rewrite changes it. */
export function sessionForkPrefixAnchor(history: readonly NativeHistoryMessage[]): string {
  const hash = createHash("sha256");
  for (const message of history) {
    hash.update(message.role === "user" ? "u" : "a");
    hash.update("\0");
    hash.update(message.text);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export type SessionForkNodeFailure =
  | "node-unavailable"
  | "node-ambiguous"
  | "source-changed";

export type SessionForkNodeResolution =
  | { ok: true; prefix: NativeHistoryMessage[]; userTurnIndex: number; anchor: string }
  | { ok: false; reason: SessionForkNodeFailure };

/**
 * Cut the source history at one recorded prompt turn: every row up to and
 * including the agent reply that follows the turn, and nothing after the next
 * user turn.
 *
 * The node is located by its prompt digest, never by position: the acpx record
 * can gain turns (growth) or lose its head (its bounded window), and neither
 * may silently move a fork onto a different turn. A duplicated prompt text is
 * ambiguous unless the recorded turn ordinal still points at one of the
 * matches. A recorded anchor (a replay) must match the prefix exactly.
 */
export function resolveSessionForkNode(input: {
  history: readonly NativeHistoryMessage[];
  /** The source session's recorded turns, oldest first; includes the target. */
  nodes: readonly SessionForkTurnNode[];
  nodeId: string;
  /** Anchor stored when this fork was first resolved (a pending replay). */
  expectedAnchor?: string;
}): SessionForkNodeResolution {
  const target = input.nodes.find((node) => node.nodeId === input.nodeId);
  if (!target) return { ok: false, reason: "node-unavailable" };

  const userIndexes: number[] = [];
  for (let index = 0; index < input.history.length; index += 1) {
    if (input.history[index]!.role === "user") userIndexes.push(index);
  }
  const matches: number[] = [];
  for (const index of userIndexes) {
    if (sessionForkPromptDigest(input.history[index]!.text) === target.promptDigest) {
      matches.push(index);
    }
  }
  if (matches.length === 0) return { ok: false, reason: "source-changed" };

  let userTurnIndex: number;
  if (matches.length === 1) {
    userTurnIndex = userIndexes.indexOf(matches[0]!);
  } else {
    // Two prompts with identical text are indistinguishable by content. The
    // recorded ordinal disambiguates only when it still indexes one of them;
    // otherwise the caller must fail closed rather than pick a guess.
    const hinted = target.sequence < userIndexes.length ? target.sequence : -1;
    if (hinted < 0 || !matches.includes(userIndexes[hinted]!)) {
      return { ok: false, reason: "node-ambiguous" };
    }
    userTurnIndex = hinted;
  }

  const nodeIndex = userIndexes[userTurnIndex]!;
  const nextUser = userIndexes.find((index) => index > nodeIndex);
  const prefix = input.history.slice(0, nextUser ?? input.history.length);
  const anchor = sessionForkPrefixAnchor(prefix);
  if (input.expectedAnchor !== undefined && input.expectedAnchor !== anchor) {
    return { ok: false, reason: "source-changed" };
  }
  return { ok: true, prefix, userTurnIndex, anchor };
}
