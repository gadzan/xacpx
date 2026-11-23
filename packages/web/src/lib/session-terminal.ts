import { terminalLocalKey, type useTerminalStore } from "../stores/terminal";
import { clearTerminalId } from "./terminal-sessions";
import { sessionKey as makeSessionKey } from "../stores/center-tabs";

/**
 * Best-effort detach for a session's local terminal tab. Does NOT terminate the shared
 * RMUX resource — archive/delete/logout retirement is owned by channel-relay.
 * Also clears any leftover legacy PTY id entry.
 */
export function detachSessionTerminal(
  sessionKey: string,
  instanceId: string,
  sessionAlias: string,
  terminals: ReturnType<typeof useTerminalStore>,
): void {
  terminals.detach(terminalLocalKey(instanceId, sessionAlias));
  clearTerminalId(sessionKey);
}

/** @deprecated Prefer detachSessionTerminal — browser must not kill shared terminals. */
export function killSessionTerminal(
  sessionKey: string,
  instanceId: string,
  terminals: ReturnType<typeof useTerminalStore>,
): void {
  // Infer alias from `${instanceId}::${alias}` sessionKey used by center-tabs.
  const prefix = `${instanceId}::`;
  const alias = sessionKey.startsWith(prefix) ? sessionKey.slice(prefix.length) : "";
  if (alias) detachSessionTerminal(sessionKey, instanceId, alias, terminals);
  else clearTerminalId(sessionKey);
}

export { makeSessionKey };
