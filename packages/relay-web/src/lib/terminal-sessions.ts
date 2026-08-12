/** @deprecated Legacy per-session PTY id map. RMUX terminals do not persist terminalId. */
const KEY = "xacpx.terminal-ids.v1";

/** One-shot best-effort migration: drop leftover PTY ids from pre-RMUX builds. */
export function migrateAwayFromLegacyTerminalIds(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* storage disabled — ignore */
  }
}

// Call once at module load so any import path clears the legacy map.
migrateAwayFromLegacyTerminalIds();

/** @deprecated No-op — RMUX identity is server-side; local tabs only persist layout. */
export function saveTerminalId(_sessionKey: string, _id: string): void {}

/** @deprecated Always null after migration. */
export function loadTerminalId(_sessionKey: string): string | null {
  return null;
}

/** @deprecated No-op after migration. */
export function clearTerminalId(_sessionKey: string): void {}
