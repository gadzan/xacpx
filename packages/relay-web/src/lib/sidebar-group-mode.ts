// Sidebar grouping: per-instance view preference (flat instance list vs second-level
// grouping by workspace or agent) plus the pure grouping/dedup helpers the tree renders
// from. Preference is a pure view concern → persisted in localStorage, never the server.

export type SidebarGroupMode = "instance" | "workspace" | "agent";

const KEY_PREFIX = "xacpx.sidebar.groupMode.";

const MODES: readonly SidebarGroupMode[] = ["instance", "workspace", "agent"];

export function loadGroupMode(instanceId: string): SidebarGroupMode {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + instanceId);
    if (raw && (MODES as readonly string[]).includes(raw)) return raw as SidebarGroupMode;
  } catch {
    // localStorage unavailable (private mode) → fall through to default
  }
  return "instance";
}

export function saveGroupMode(instanceId: string, mode: SidebarGroupMode): void {
  try {
    if (mode === "instance") localStorage.removeItem(KEY_PREFIX + instanceId);
    else localStorage.setItem(KEY_PREFIX + instanceId, mode);
  } catch {
    // best-effort: the in-memory mode still applies for this page's lifetime
  }
}

export interface SessionGroup<T> {
  /** The workspace or agent name this group collects. */
  key: string;
  sessions: T[];
}

/**
 * Archived sessions sink below active ones (stable: both halves keep their
 * incoming order) — shared by the flat list and every group.
 */
export function archivedLast<T extends { archived?: boolean }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => Number(a.archived ?? false) - Number(b.archived ?? false));
}

/**
 * Derive second-level groups from the sessions themselves (never from the
 * workspaces/agents catalogs — no empty groups, and the catalogs may not be
 * loaded when sessions arrive). Groups appear in first-appearance (server)
 * order; within a group actives keep server order and archived sink last.
 */
export function groupSessions<T extends { workspace: string; agent: string; archived?: boolean }>(
  sessions: T[],
  mode: "workspace" | "agent",
): Array<SessionGroup<T>> {
  const byKey = new Map<string, T[]>();
  for (const s of sessions) {
    const key = mode === "workspace" ? s.workspace : s.agent;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(s);
    else byKey.set(key, [s]);
  }
  return [...byKey.entries()].map(([key, list]) => ({ key, sessions: archivedLast(list) }));
}

/**
 * Display-layer dedup of the auto-alias pattern `<workspace>-<agent>`: inside a
 * workspace group drop the leading "<group>-", inside an agent group drop the
 * trailing "-<group>". Only when a non-empty remainder is left; the real alias
 * is untouched (hover title always shows the full name).
 */
export function dedupedSessionName(name: string, groupKey: string, mode: "workspace" | "agent"): string {
  if (mode === "workspace" && name.startsWith(`${groupKey}-`)) {
    const rest = name.slice(groupKey.length + 1);
    if (rest) return rest;
  }
  if (mode === "agent" && name.endsWith(`-${groupKey}`)) {
    const rest = name.slice(0, name.length - groupKey.length - 1);
    if (rest) return rest;
  }
  return name;
}
