import { loadTerminalId, clearTerminalId } from "./terminal-sessions";
import type { useTerminalStore } from "../stores/terminal";

/** Kill a session's live terminal PTY (if any) and forget its persisted id. Called from every
 *  EXPLICIT close/prune path (tab close, dead-session reconcile, session archive/delete) — NOT
 *  from a refresh unmount, so a reload can still re-attach. No-op when the session has no terminal. */
export function killSessionTerminal(
  sessionKey: string,
  instanceId: string,
  terminals: ReturnType<typeof useTerminalStore>,
): void {
  const id = loadTerminalId(sessionKey);
  if (id) terminals.close(instanceId, id);
  clearTerminalId(sessionKey);
}
