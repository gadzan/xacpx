// Durable terminal registry schema — spec §10.1
// (docs/superpowers/specs/2026-08-10-relay-web-rmux-terminal-design.md).
//
// This module only defines the on-disk shapes. Viewer, controller and
// recovery-cursor state are intentionally NOT modeled here: they are
// ephemeral per-connection state that never touches disk.

/** `<dir>/terminal-owner.json` — stable identity, decoupled from hub instanceId. */
export interface TerminalOwnerFileV1 {
  schemaVersion: 1;
  /** Random UUID, generated once, stable across re-pairing with the hub. */
  installationId: string;
}

/** `<dir>/terminals.json` — write-ahead registry of terminal resources. */
export interface TerminalRegistryFileV1 {
  schemaVersion: 1;
  /** Monotonically increasing; incremented on every successful mutation. */
  revision: number;
  terminals: Record<string, TerminalRecordV1>;
}

export type TerminalState = "creating" | "live" | "reaping";

export type TerminalReapReason =
  | "explicit-close"
  | "archive"
  | "delete"
  | "idle"
  | "disabled"
  | "orphan"
  | "exited";

export interface TerminalRecordV1 {
  terminalId: string;
  logicalSessionId: string;
  internalAliasSnapshot: string;
  rmuxSessionName: string;
  rmuxSessionId?: string;
  generation: string;
  state: TerminalState;
  createdAt: string;
  lastInputAt: string;
  reapReason?: TerminalReapReason;
}

export const TERMINAL_STATES: readonly TerminalState[] = ["creating", "live", "reaping"];

export const TERMINAL_REAP_REASONS: readonly TerminalReapReason[] = [
  "explicit-close",
  "archive",
  "delete",
  "idle",
  "disabled",
  "orphan",
  "exited",
];
