/** Per-session terminal-id persistence. A live PTY survives a browser reload (the backend keeps
 *  it until idle-timeout); persisting its terminalId lets the reloaded tab re-attach (replay
 *  scrollback + reconnect) instead of spawning a fresh shell. sessionStorage (tab-scoped) keyed
 *  by `${instanceId}::${alias}`. */
const KEY = "xacpx.terminal-ids.v1";
type Ids = Record<string, string>;

function read(): Ids {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Ids) : {};
  } catch {
    return {};
  }
}
function write(ids: Ids): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    /* storage full / disabled — best-effort */
  }
}

export function saveTerminalId(sessionKey: string, id: string): void {
  if (!sessionKey || !id) return;
  const ids = read();
  ids[sessionKey] = id;
  write(ids);
}
export function loadTerminalId(sessionKey: string): string | null {
  if (!sessionKey) return null;
  return read()[sessionKey] ?? null;
}
export function clearTerminalId(sessionKey: string): void {
  if (!sessionKey) return;
  const ids = read();
  delete ids[sessionKey];
  write(ids);
}
