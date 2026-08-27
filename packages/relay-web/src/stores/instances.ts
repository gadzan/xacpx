import { defineStore } from "pinia";
import { ref } from "vue";
import {
  RELAY_CAPABILITIES,
  isErrorPayload,
  type AgentCatalogEntryDto,
  type AgentDto,
  type NativeSessionDto,
  type PublishedAgentEndpointDto,
  type SessionDto,
  type SessionModelResult,
  type WebAgentDirectoryEndpointDto,
  type WebServerEvent,
  type WorkspaceDto,
} from "@ganglion/xacpx-relay-protocol";
import { api, ApiError } from "../api/client";
import { useChatStore } from "./chat";
import { useAuthStore } from "./auth";
import { dropSession as dropSessionViewSnapshots } from "../lib/view-snapshot-cache";
import { loadGroupMode, saveGroupMode, type SidebarGroupMode } from "../lib/sidebar-group-mode";

// An instance-side RPC error comes back as a 200 with an `{error:{code,message}}`
// payload (the gateway resolves, it does not reject), so api.rpc won't throw.
// Surface it as a real rejection so callers (the create-session dialog) can show it.
function unwrap<T>(result: T | { error: { code: string; message: string } }): T {
  if (isErrorPayload(result)) {
    // `unknown-type` means the connector's relay channel doesn't implement this RPC —
    // i.e. it runs an older xacpx core than the features this dashboard expects. Turn
    // the raw "unsupported rpc type: …" into an actionable upgrade hint.
    if (result.error.code === "unknown-type") {
      throw new Error("This feature needs a newer connector — rebuild and reconnect the relay channel on that instance.");
    }
    throw new Error(result.error.message || result.error.code);
  }
  return result;
}

// A session as the dashboard tracks it: the wire DTO plus web-only fields for an
// OPTIMISTIC row — one inserted the instant the user hits Create, before the
// (slow, cold-agent-start) create RPC resolves. The real row from `loadSessions`
// replaces it on success; these extras are absent on every server-sourced row.
export type SessionRow = SessionDto & {
  /** The create RPC for this row is still in flight (cold agent start). */
  creating?: boolean;
  /** Epoch ms when creation began — drives the "starting… Ns" elapsed display. */
  creatingSince?: number;
  /** Background creation failed; message surfaced in the booting pane. */
  createError?: string;
  /** Materialised from the create RPC response but not yet seen in a list
   *  snapshot. Survives page-1 replaces while `sessionsHasMore` may hide it
   *  (the server appends new sessions last); cleared once a snapshot contains
   *  the alias, or dropped when a complete list (hasMore false) omits it. */
  justCreated?: boolean;
};

export interface InstanceView {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  // The xacpx core version the connector reported at registration (null for legacy
  // connectors that predate version reporting). Surfaced so operators can spot a
  // version-skewed connector before its missing features fail with `unknown-type`.
  coreVersion?: string | null;
  /** Last known connector capabilities; missing API field normalizes to [] on load. */
  capabilities?: string[];
  sessions: SessionRow[];
  // Distinguishes "sessions never fetched" from "fetched and genuinely empty" so the
  // sidebar only shows the "no sessions yet" empty row once a list has actually loaded.
  sessionsLoaded: boolean;
  sessionsHasMore?: boolean;
  sessionsNextOffset?: number;
  sessionsLoading?: boolean;
  archivedSessionsLoaded?: boolean;
  archivedSessionsLoading?: boolean;
  // Grouped sidebar modes page sleeping sessions PER GROUP from the server instead of
  // merging them into `sessions` (flat mode's one-shot snapshot). Keyed `${mode}:${groupKey}`.
  groupArchived?: Record<string, GroupArchivedState>;
  agents: AgentDto[];
  workspaces: WorkspaceDto[];
  agentCatalog: AgentCatalogEntryDto[];
}

/** True when the instance is online and advertises both RMUX terminal capabilities. */
export function supportsRmuxTerminal(instance: {
  online: boolean;
  capabilities?: string[] | null;
}): boolean {
  if (!instance.online) return false;
  const caps = instance.capabilities ?? [];
  return caps.includes(RELAY_CAPABILITIES.terminalRmuxRecoveryV1)
    && caps.includes(RELAY_CAPABILITIES.terminalMultiViewV1);
}

/** Sidebar grouping modes that support per-group sleeping-session pages. */
export type GroupArchivedMode = "workspace" | "agent";

export interface GroupArchivedState {
  sessions: SessionRow[];
  loaded: boolean;
  hasMore: boolean;
  nextOffset: number;
  loading?: boolean;
}

export function groupArchivedKey(mode: GroupArchivedMode, groupKey: string): string {
  return `${mode}:${groupKey}`;
}

/** Inverse of {@link groupArchivedKey}; null for keys not in `${mode}:${groupKey}` form. */
export function parseGroupArchivedKey(key: string): { mode: GroupArchivedMode; groupKey: string } | null {
  const sep = key.indexOf(":");
  if (sep < 0) return null;
  const mode = key.slice(0, sep);
  if (mode !== "workspace" && mode !== "agent") return null;
  return { mode, groupKey: key.slice(sep + 1) };
}

export const useInstancesStore = defineStore("instances", () => {
  const agentDirectory = ref<WebAgentDirectoryEndpointDto[]>([]);

  async function loadAgentDirectory(): Promise<void> {
    try {
      const res = await api.get<{ endpoints: WebAgentDirectoryEndpointDto[] }>("/api/agent-directory");
      agentDirectory.value = res.endpoints ?? [];
    } catch {
      /* best effort */
    }
  }

  const instances = ref<InstanceView[]>([]);
  const pendingSessionRenames = new Map<string, {
    latestRevision: number;
    confirmedRevision: number;
    desiredDisplayName?: string;
    confirmedDisplayName?: string;
  }>();
  const sessionRenameTails = new Map<string, Promise<void>>();
  let sessionRenameRevision = 0;

  function sessionRenameKey(instanceId: string, alias: string): string {
    return JSON.stringify([instanceId, alias]);
  }

  // Snapshot pending-rename confirmation revisions at request time so a stale list
  // response cannot downgrade a rename confirmed while the request was in flight.
  function renameRevisionsAtRequest(): Map<string, number> {
    return new Map([...pendingSessionRenames].map(([key, pending]) => [key, pending.confirmedRevision]));
  }

  function emptyGroupArchivedState(): GroupArchivedState {
    return { sessions: [], loaded: false, hasMore: false, nextOffset: 0 };
  }

  function groupArchivedFilter(mode: GroupArchivedMode, groupKey: string): { workspace: string } | { agent: string } {
    return mode === "workspace" ? { workspace: groupKey } : { agent: groupKey };
  }

  // Optimistic active↔sleeping hand-off for the per-group pages. The grouped sidebar
  // renders a group's active rows from inst.sessions and its sleeping rows from
  // groupArchived pages; flipping the archived flag alone therefore makes a row fall
  // out of the active list while it is still missing from the (stale) page — it
  // vanishes and only reappears when the post-RPC refetch publishes. Mirroring the
  // flip INTO the loaded pages at the same moment lets the row move sections in one
  // render; the authoritative refresh converges to the same content.
  function groupModesForRow(row: Pick<SessionRow, "workspace" | "agent">): Array<{ mode: GroupArchivedMode; groupKey: string }> {
    return [
      { mode: "workspace", groupKey: row.workspace },
      { mode: "agent", groupKey: row.agent },
    ];
  }

  /** Mirror `archived` for `row` into every LOADED group page covering it.
   *  Unloaded pages are skipped — they must not materialise half-truths. */
  function handOffRowToGroups(instanceId: string, row: SessionRow, archived: boolean): void {
    const inst = byId(instanceId);
    if (!inst?.groupArchived) return;
    for (const { mode, groupKey } of groupModesForRow(row)) {
      const key = groupArchivedKey(mode, groupKey);
      const state = inst.groupArchived[key];
      if (!state?.loaded) continue;
      if (archived) {
        if (state.sessions.some((s) => s.alias === row.alias)) continue;
        // Clone: page rows stay independent of the live inst.sessions object.
        inst.groupArchived[key] = { ...state, sessions: [...state.sessions, { ...row }] };
      } else if (state.sessions.some((s) => s.alias === row.alias)) {
        inst.groupArchived[key] = { ...state, sessions: state.sessions.filter((s) => s.alias !== row.alias) };
      }
    }
  }

  /** Pop a sleeping row out of the loaded group pages on wake, returning a copy for
   *  re-insertion into inst.sessions (undefined when no page held it). */
  function takeRowFromGroups(instanceId: string, alias: string): SessionRow | undefined {
    const inst = byId(instanceId);
    let woken: SessionRow | undefined;
    if (!inst?.groupArchived) return woken;
    for (const [key, state] of Object.entries(inst.groupArchived)) {
      if (!state.loaded) continue;
      if (!state.sessions.some((s) => s.alias === alias)) continue;
      woken ??= { ...state.sessions.find((s) => s.alias === alias)! };
      inst.groupArchived[key] = { ...state, sessions: state.sessions.filter((s) => s.alias !== alias) };
    }
    return woken;
  }

  // Discard-and-refetch idiom shared by every session-list loader: an event that
  // lands while a fetch is in flight leaves a pending mark; once the fetch settles,
  // re-run the work until no new mark survives a full pass.
  async function drainPendingRefresh(pending: Set<string>, key: string, work: () => Promise<void>): Promise<void> {
    do {
      pending.delete(key);
      await work();
    } while (pending.has(key));
  }

  function overlaySessionRename(instanceId: string, session: SessionDto, confirmedRevisionsAtRequest: Map<string, number>): SessionRow {
    const key = sessionRenameKey(instanceId, session.alias);
    const pending = pendingSessionRenames.get(key);
    if (!pending) return session;
    if (
      confirmedRevisionsAtRequest.get(key) === pending.confirmedRevision
      && pending.latestRevision === pending.confirmedRevision
      && session.displayName === pending.confirmedDisplayName
    ) {
      pendingSessionRenames.delete(key);
      return session;
    }
    return { ...session, displayName: pending.desiredDisplayName };
  }

  // Per-instance sidebar grouping mode (flat / by-workspace / by-agent). Reactive
  // mirror of the localStorage preference so the sidebar re-renders the moment the
  // manage dialog changes it. Reads are pure (no render-phase writes): until the
  // first setGroupMode we fall through to localStorage directly.
  const groupModes = ref<Record<string, SidebarGroupMode>>({});

  function groupModeFor(instanceId: string): SidebarGroupMode {
    return groupModes.value[instanceId] ?? loadGroupMode(instanceId);
  }

  function setGroupMode(instanceId: string, mode: SidebarGroupMode): void {
    groupModes.value[instanceId] = mode;
    saveGroupMode(instanceId, mode);
  }

  async function loadInstances(): Promise<void> {
    const { instances: rows } = await api.get<{ instances: Array<Omit<InstanceView, "sessions" | "sessionsLoaded" | "agents" | "workspaces" | "agentCatalog" | "capabilities"> & { capabilities?: string[] }> }>("/api/instances");
    instances.value = rows.map((r) => {
      const prev = byId(r.id);
      return {
        ...r,
        capabilities: Array.isArray(r.capabilities) ? r.capabilities : [],
        sessions: prev?.sessions ?? [],
        sessionsLoaded: prev?.sessionsLoaded ?? false,
        sessionsHasMore: prev?.sessionsHasMore ?? false,
        sessionsNextOffset: prev?.sessionsNextOffset ?? 0,
        sessionsLoading: false,
        archivedSessionsLoaded: prev?.archivedSessionsLoaded ?? false,
        archivedSessionsLoading: false,
        groupArchived: prev?.groupArchived,
        agents: prev?.agents ?? [],
        workspaces: prev?.workspaces ?? [],
        agentCatalog: prev?.agentCatalog ?? [],
      };
    });
    void loadAgentDirectory();
  }

  const pendingSessionRefreshes = new Set<string>();
  const pendingArchivedRefreshes = new Set<string>();

  async function loadSessions(instanceId: string): Promise<void> {
    const inst = byId(instanceId);
    if (inst?.sessionsLoading) {
      pendingSessionRefreshes.add(instanceId);
      return;
    }
    await drainPendingRefresh(pendingSessionRefreshes, instanceId, () => fetchSessionsPage(instanceId, 0, true));
  }

  async function loadMoreSessions(instanceId: string): Promise<void> {
    const inst = byId(instanceId);
    if (!inst || !inst.sessionsHasMore || inst.sessionsLoading) return;
    await fetchSessionsPage(instanceId, inst.sessionsNextOffset ?? inst.sessions.length, false);
    if (pendingSessionRefreshes.has(instanceId)) await loadSessions(instanceId);
  }

  // Auto-load entry point: fire session fetches for every online instance not yet
  // loaded (the dashboard calls this on mount and on reconnect). loadSessions
  // coalesces, so re-firing for an in-flight instance is harmless.
  function loadSessionsForOnlineInstances(): void {
    for (const inst of instances.value) {
      if (inst.online && !inst.sessionsLoaded && !inst.sessionsLoading) {
        void loadSessions(inst.id).catch(() => {});
      }
    }
  }

  /** Load the full session set only when the user asks to recover sleeping sessions. */
  async function loadArchivedSessions(instanceId: string): Promise<void> {
    const inst = byId(instanceId);
    if (inst?.archivedSessionsLoading) {
      pendingArchivedRefreshes.add(instanceId);
      return;
    }
    if (inst) inst.archivedSessionsLoading = true;
    try {
      await drainPendingRefresh(pendingArchivedRefreshes, instanceId, async () => {
        const confirmedRevisionsAtRequest = renameRevisionsAtRequest();
        let offset = 0;
        const all: SessionDto[] = [];
        let hasMore = true;
        while (hasMore) {
          const page = await api.rpc<{ sessions: SessionDto[]; hasMore?: boolean; nextOffset?: number }>(instanceId, "control.sessions.list", { offset, limit: 20, includeArchived: true });
          all.push(...page.sessions.map((session) => overlaySessionRename(instanceId, session, confirmedRevisionsAtRequest)));
          hasMore = page.hasMore === true;
          const nextOffset = page.nextOffset ?? offset + page.sessions.length;
          if (hasMore && nextOffset <= offset) break;
          offset = nextOffset;
        }
        // If an event arrived while this snapshot was in flight, discard it and
        // immediately fetch a fresh authoritative snapshot before publishing.
        if (pendingArchivedRefreshes.has(instanceId)) return;
        const current = byId(instanceId);
        if (current) {
          // The full response is authoritative. Keep only local transient rows that
          // have not materialised server-side yet; never retain deleted sleeping rows.
          const transient = current.sessions.filter((session) => session.creating || session.createError);
          const byAlias = new Map(all.map((session) => [session.alias, session]));
          for (const session of transient) {
            if (!byAlias.has(session.alias)) byAlias.set(session.alias, session);
          }
          current.sessions = [...byAlias.values()];
          current.archivedSessionsLoaded = true;
        }
        useChatStore().reconcileTailCache(instanceId, all.map((s) => ({ alias: s.alias, incarnation: s.transportSession })));
      });
    } finally {
      const current = byId(instanceId);
      if (current) current.archivedSessionsLoading = false;
    }
  }

  // Per-group sleeping-session paging for the grouped sidebar modes. Unlike flat
  // mode's one-shot `loadArchivedSessions`, these pages stay OUTSIDE `inst.sessions`
  // and never call reconcileTailCache (a partial page would purge valid tails).
  const GROUP_ARCHIVED_PAGE = 5;
  const pendingGroupArchivedRefreshes = new Set<string>();

  function groupArchivedPendingKey(instanceId: string, mode: GroupArchivedMode, groupKey: string): string {
    return `${instanceId}|${groupArchivedKey(mode, groupKey)}`;
  }

  function groupArchivedStateFor(instanceId: string, mode: GroupArchivedMode, groupKey: string): GroupArchivedState | undefined {
    return byId(instanceId)?.groupArchived?.[groupArchivedKey(mode, groupKey)];
  }

  /** Merge a patch into a group's archived state, creating the record if needed. */
  function patchGroupArchivedState(instanceId: string, mode: GroupArchivedMode, groupKey: string, patch: Partial<GroupArchivedState>): void {
    const inst = byId(instanceId);
    if (!inst) return;
    inst.groupArchived ??= {};
    const key = groupArchivedKey(mode, groupKey);
    const prev = inst.groupArchived[key] ?? emptyGroupArchivedState();
    inst.groupArchived[key] = { ...prev, ...patch };
  }

  async function loadGroupArchivedSessions(instanceId: string, mode: GroupArchivedMode, groupKey: string, append = false): Promise<void> {
    const pk = groupArchivedPendingKey(instanceId, mode, groupKey);
    const state = groupArchivedStateFor(instanceId, mode, groupKey);
    if (state?.loading) {
      if (!append) pendingGroupArchivedRefreshes.add(pk);
      return;
    }
    let appendPage = append;
    let rerun = false;
    await drainPendingRefresh(pendingGroupArchivedRefreshes, pk, async () => {
      const current = groupArchivedStateFor(instanceId, mode, groupKey);
      const offset = appendPage && current ? current.nextOffset : 0;
      // A pending refresh re-enters through loadGroupArchivedSessions (offset 0, replace):
      // fetchGroupArchivedPage's loading guard would otherwise bail and drop the refresh.
      if (appendPage) await fetchGroupArchivedPage(instanceId, mode, groupKey, offset, GROUP_ARCHIVED_PAGE, true);
      else if (rerun) await loadGroupArchivedSessions(instanceId, mode, groupKey, false);
      else await fetchGroupArchivedPage(instanceId, mode, groupKey, 0, GROUP_ARCHIVED_PAGE, false);
      appendPage = false;
      rerun = true;
    });
  }

  async function fetchGroupArchivedPage(instanceId: string, mode: GroupArchivedMode, groupKey: string, offset: number, limit: number, append: boolean): Promise<void> {
    if (groupArchivedStateFor(instanceId, mode, groupKey)?.loading) return;
    patchGroupArchivedState(instanceId, mode, groupKey, { loading: true });
    const confirmedRevisionsAtRequest = renameRevisionsAtRequest();
    try {
      const page = await api.rpc<{ sessions: SessionDto[]; hasMore?: boolean; nextOffset?: number }>(instanceId, "control.sessions.list", {
        offset, limit, archivedOnly: true,
        ...groupArchivedFilter(mode, groupKey),
      });
      const inst = byId(instanceId);
      if (inst) {
        const key = groupArchivedKey(mode, groupKey);
        const rows = page.sessions.filter((session) => session.archived).map((session) => overlaySessionRename(instanceId, session, confirmedRevisionsAtRequest));
        const base = append ? (inst.groupArchived?.[key]?.sessions ?? []) : [];
        patchGroupArchivedState(instanceId, mode, groupKey, {
          sessions: [...base, ...rows.filter((row) => !base.some((old) => old.alias === row.alias))],
          loaded: true,
          hasMore: page.hasMore === true,
          nextOffset: page.nextOffset ?? offset + page.sessions.length,
        });
      }
    } finally {
      patchGroupArchivedState(instanceId, mode, groupKey, { loading: false });
    }
  }

  /** Re-fetch every already-loaded group page (e.g. after sessions-changed). Never loads unloaded groups. */
  function refreshLoadedGroupArchivedSessions(instanceId: string): void {
    const inst = byId(instanceId);
    if (!inst?.groupArchived) return;
    for (const [key, state] of Object.entries(inst.groupArchived)) {
      if (!state.loaded) continue;
      const parsed = parseGroupArchivedKey(key);
      if (!parsed) continue;
      // Loading groups are NOT skipped: refetchGroupArchived waits for the in-flight
      // page and lets its pending-drain perform the discard-and-refetch.
      void refetchGroupArchived(instanceId, parsed.mode, parsed.groupKey, state.sessions.length).catch(() => {});
    }
  }

  // Refetch a loaded group's rows atomically (collect all pages first, publish once)
  // so a refresh never flickers rows away. An empty group still probes one page so a
  // newly archived session surfaces without hide/show.
  async function refetchGroupArchived(instanceId: string, mode: GroupArchivedMode, groupKey: string, loadedCount: number): Promise<void> {
    const pk = groupArchivedPendingKey(instanceId, mode, groupKey);
    // A page load may already be in flight for this group. Its own pending-drain loop
    // performs the discard-and-refetch, so mark pending and wait for it to settle
    // instead of racing a second fetch (a bare return would leave the mark un-consumed).
    while (groupArchivedStateFor(instanceId, mode, groupKey)?.loading) {
      pendingGroupArchivedRefreshes.add(pk);
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (!pendingGroupArchivedRefreshes.has(pk)) return;
    }
    const confirmedRevisionsAtRequest = renameRevisionsAtRequest();
    patchGroupArchivedState(instanceId, mode, groupKey, { loading: true });
    try {
      await drainPendingRefresh(pendingGroupArchivedRefreshes, pk, async () => {
        const target = Math.max(GROUP_ARCHIVED_PAGE, loadedCount);
        let offset = 0;
        const all: SessionRow[] = [];
        let hasMore = false;
        let nextOffset = 0;
        while (all.length < target) {
          const page = await api.rpc<{ sessions: SessionDto[]; hasMore?: boolean; nextOffset?: number }>(instanceId, "control.sessions.list", {
            offset, limit: Math.min(100, target - all.length), archivedOnly: true,
            ...groupArchivedFilter(mode, groupKey),
          });
          all.push(...page.sessions.filter((session) => session.archived).map((session) => overlaySessionRename(instanceId, session, confirmedRevisionsAtRequest)));
          hasMore = page.hasMore === true;
          nextOffset = page.nextOffset ?? offset + page.sessions.length;
          if (!hasMore || nextOffset <= offset) break;
          offset = nextOffset;
        }
        if (pendingGroupArchivedRefreshes.has(pk)) return;
        patchGroupArchivedState(instanceId, mode, groupKey, { sessions: all, loaded: true, hasMore, nextOffset });
      });
    } finally {
      patchGroupArchivedState(instanceId, mode, groupKey, { loading: false });
    }
  }

  async function fetchSessionsPage(instanceId: string, offset: number, replace: boolean): Promise<void> {
    const instBefore = byId(instanceId);
    if (instBefore?.sessionsLoading) return;
    if (instBefore) instBefore.sessionsLoading = true;
    const confirmedRevisionsAtRequest = renameRevisionsAtRequest();
    // Pull the configured agents alongside the session list (once) so the sidebar and chat
    // can map each session's agent NAME → driver for the brand icon. Agents otherwise only
    // load when a create/manage dialog opens (loadFormOptions), so in the normal
    // login→browse→chat flow inst.agents would stay empty and every icon would fall back to
    // the generic glyph. Tolerant + fire-alongside: an agents failure must never block the
    // session list, and it self-heals on the next loadSessions since `agents` stays empty.
    const needAgents = (byId(instanceId)?.agents.length ?? 0) === 0;
    try {
      const [{ sessions, hasMore = false, nextOffset }, agentsRes] = await Promise.all([
        api.rpc<{ sessions: SessionDto[]; hasMore?: boolean; nextOffset?: number }>(instanceId, "control.sessions.list", { offset, limit: 20 }),
        needAgents
          ? api.rpc<{ agents: AgentDto[] }>(instanceId, "control.agents.list").catch(() => null)
          : Promise.resolve(null),
      ]);
      const inst = byId(instanceId);
      if (inst) {
        const rows = sessions.map((session) => overlaySessionRename(instanceId, session, confirmedRevisionsAtRequest));
        const archived = replace && inst.archivedSessionsLoaded ? inst.sessions.filter((session) => session.archived) : [];
        if (replace) {
          // A replace snapshot is authoritative for the rows it contains, but these
          // kinds of local row must survive it:
          //  - an optimistic create still booting (RPC in flight, or a 504 whose
          //    session arrives later via sessions-changed) — dropping it would
          //    blank the selected session's pane mid-boot;
          //  - a row materialised from the create RPC response that this page-1
          //    snapshot cannot contain: the server appends new sessions last, so
          //    with more actives than one page the new one sits past the boundary.
          //    Kept only while hasMore — a COMPLETE list omitting the alias is the
          //    server saying the session is gone.
          //  - the SELECTED session if it just went archived: archive → sessions-changed
          //    → this replace runs before any full archived snapshot loads, and the
          //    active-only page no longer contains the row. Dropping it would blank the
          //    open chat's header/driver. Kept until a full snapshot (loadArchivedSessions)
          //    re-homes it authoritatively.
          // Mirrors loadArchivedSessions' transient handling.
          const chat = useChatStore();
          const keep = inst.sessions.filter((row) =>
            row.creating
            || row.createError
            || (row.justCreated === true && hasMore && !rows.some((r) => r.alias === row.alias))
            || (row.archived === true && instanceId === chat.instanceId && row.alias === chat.sessionAlias),
          );
          for (const row of keep) {
            if (!rows.some((r) => r.alias === row.alias)) {
              rows.push(row);
            }
          }
        }
        inst.sessions = replace
          ? [...rows, ...archived.filter((old) => !rows.some((row) => row.alias === old.alias))]
          : [...inst.sessions, ...rows.filter((row) => !inst.sessions.some((old) => old.alias === row.alias))];
        inst.sessionsLoaded = true;
        inst.sessionsHasMore = hasMore;
        inst.sessionsNextOffset = nextOffset ?? offset + sessions.length;
        if (agentsRes && !isErrorPayload(agentsRes) && Array.isArray(agentsRes.agents)) inst.agents = agentsRes.agents;
      }
    } finally {
      const inst = byId(instanceId);
      if (inst) inst.sessionsLoading = false;
    }
  }

  // Just the workspaces (for the file browser) — lighter than loadFormOptions, which
  // also pulls agents + the driver catalog.
  async function loadWorkspaces(instanceId: string): Promise<void> {
    const { workspaces } = await api.rpc<{ workspaces: WorkspaceDto[] }>(instanceId, "control.workspaces.list");
    const inst = byId(instanceId);
    if (inst) inst.workspaces = workspaces;
  }

  // Pull the instance's configured agents + workspaces to drive the create-session
  // form's dropdowns. Called when the dialog opens.
  async function loadFormOptions(instanceId: string): Promise<void> {
    const [{ agents }, { workspaces }, { agents: catalog }] = await Promise.all([
      api.rpc<{ agents: AgentDto[] }>(instanceId, "control.agents.list"),
      api.rpc<{ workspaces: WorkspaceDto[] }>(instanceId, "control.workspaces.list"),
      api.rpc<{ agents: AgentCatalogEntryDto[] }>(instanceId, "control.agents.catalog"),
    ]);
    const inst = byId(instanceId);
    if (inst) {
      inst.agents = agents;
      inst.workspaces = workspaces;
      inst.agentCatalog = catalog;
    }
  }

  // Pull the full driver catalog (every acpx driver + configured/install hints) so
  // the create-session picker can show un-configured, installable drivers too.
  async function loadAgentCatalog(instanceId: string): Promise<void> {
    const { agents } = await api.rpc<{ agents: AgentCatalogEntryDto[] }>(instanceId, "control.agents.catalog");
    const inst = byId(instanceId);
    if (inst) inst.agentCatalog = agents;
  }

  // loadFormOptions already refreshes agents + workspaces + catalog in one shot,
  // so we don't also call loadAgentCatalog here (it would race a duplicate write).
  async function createAgent(instanceId: string, name: string, driver: string): Promise<void> {
    unwrap(await api.rpc(instanceId, "control.agents.create", { name, driver }));
    await loadFormOptions(instanceId);
  }

  async function removeAgent(instanceId: string, name: string): Promise<void> {
    unwrap(await api.rpc(instanceId, "control.agents.remove", { name }));
    await loadFormOptions(instanceId);
  }

  async function removeWorkspace(instanceId: string, name: string): Promise<void> {
    unwrap(await api.rpc(instanceId, "control.workspaces.remove", { name }));
    await loadFormOptions(instanceId);
  }

  async function createWorkspace(instanceId: string, name: string, cwd: string, description?: string): Promise<WorkspaceDto> {
    const { workspace } = unwrap(await api.rpc<{ workspace: WorkspaceDto }>(instanceId, "control.workspaces.create", { name, cwd, description }));
    const inst = byId(instanceId);
    if (inst && !inst.workspaces.some((w) => w.name === workspace.name)) inst.workspaces = [...inst.workspaces, workspace];
    return workspace;
  }

  // A dashboard-created session now runs the full acpx transport lifecycle, so a cold
  // agent start can block the create RPC past the gateway's 120s timeout (504). The
  // session is usually still created server-side and arrives via `sessions-changed`,
  // so a timeout is reported as `{pending:true}` (not a hard error). Every other
  // failure — including the instance-side `{error}` payload surfaced by `unwrap` —
  // is a real failure and rethrows.
  //
  // The RPC returns the ACTUAL alias chosen by the backend, which may differ from
  // the request alias when the desired name collides with an existing archived
  // session (the backend derives `<alias>-2`, `<alias>-3`, …). On success the
  // optimistic row is materialised from the response (final alias, real transport
  // session, boot state cleared) BEFORE the list reload, and when the alias changed
  // the chat selection follows it — so `loadSessions` matches the real row against
  // the corrected one and the user never lands on a stale name.
  async function createSession(instanceId: string, alias: string, agent: string, workspace: string, agentSessionId?: string, model?: string): Promise<{ pending: boolean }> {
    let result: SessionDto | undefined;
    try {
      // agentSessionId, when set, resumes an existing agent-native session instead of
      // creating a fresh transport session (the web "attach native session" option).
      // model, when set, overrides the agent's default model for the new session
      // (empty/"default" is omitted so the agent default is used).
      result = unwrap(await api.rpc<SessionDto>(instanceId, "control.sessions.create", { alias, agent, workspace, ...(agentSessionId ? { agentSessionId } : {}), ...(model ? { model } : {}) }));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 504 || e.code === "timeout")) return { pending: true };
      throw e;
    }
    if (result) {
      const inst = byId(instanceId);
      const idx = inst?.sessions.findIndex((s) => s.alias === alias && !!s.creating) ?? -1;
      if (idx >= 0 && inst) {
        // Materialise the row from the server response: adopt the final alias (the
        // backend derives `<alias>-2`, … on a collision), real transportSession and
        // flags, and clear the optimistic boot state. `justCreated` lets the row
        // survive the page-1 reload below when the instance has more actives than
        // one page — the server appends new sessions last, so the snapshot cannot
        // contain it yet and a dropped row would blank the session the user is on.
        inst.sessions.splice(idx, 1, { ...inst.sessions[idx]!, ...result, creating: undefined, creatingSince: undefined, createError: undefined, justCreated: true });
      }
      if (typeof result.alias === "string" && result.alias !== alias) {
        // The backend derived a different alias — the view (and persisted selection)
        // must follow the session the user just created, not stay pointed at a name
        // that never materialised.
        const chat = useChatStore();
        if (chat.instanceId === instanceId && chat.sessionAlias === alias) {
          chat.select(instanceId, result.alias);
        }
      }
    }
    await loadSessions(instanceId);
    return { pending: false };
  }

  // Optimistic create: insert a "creating" row and switch to it IMMEDIATELY, then run
  // the (slow) create RPC in the background. A cold agent start blocks `createSession`
  // for 10–40s; awaiting it before closing the dialog traps the user in a frozen modal.
  // Instead the booting row lets them watch progress (or navigate away) while it spins
  // up. On success `createSession` materialises the row from the RPC response and
  // `loadSessions` swaps in the list row; on a 504 the optimistic row simply persists
  // until `sessions-changed` lands; a hard failure flips the row to an error the
  // booting pane shows.
  //
  // The row is appended at the END of the active rows, not prepended: the server list
  // appends new sessions last (creation order), so the optimistic row sits exactly
  // where the real row will land — the sidebar order never jumps when creation
  // completes.
  // Returns false WITHOUT starting creation when the alias is already taken (or the
  // instance is gone): firing the create RPC anyway would only get rejected as a
  // duplicate, and that rejection would land on the pre-existing row (creating=false)
  // and be swallowed — leaving the user no failure signal. The caller surfaces the
  // false return as a duplicate-alias error instead.
  function beginSessionCreation(instanceId: string, alias: string, agent: string, workspace: string, agentSessionId?: string, model?: string): boolean {
    const inst = byId(instanceId);
    if (!inst || inst.sessions.some((s) => s.alias === alias && !s.archived)) return false;
    const active = inst.sessions.filter((s) => !s.archived);
    const archived = inst.sessions.filter((s) => s.archived);
    const optimisticRow: SessionRow = {
      alias,
      agent,
      workspace,
      transportSession: "",
      running: false,
      archived: false,
      creating: true,
      creatingSince: Date.now(),
      ...(agentSessionId ? { native: true } : {}),
    };
    inst.sessions = [...active, optimisticRow, ...archived];
    void createSession(instanceId, alias, agent, workspace, agentSessionId, model).catch((e) => {
      const row = byId(instanceId)?.sessions.find((s) => s.alias === alias);
      if (row?.creating) {
        row.creating = false;
        row.createError = e instanceof Error ? e.message : "create failed";
      }
    });
    return true;
  }

  // Drop an optimistic row the user dismissed (still creating, or failed). Guarded so a
  // real session that has since materialised (creating/createError cleared) is never
  // removed — if the RPC actually succeeded, the genuine row stays in the list.
  function cancelSessionCreation(instanceId: string, alias: string): void {
    const inst = byId(instanceId);
    if (inst) inst.sessions = inst.sessions.filter((s) => !(s.alias === alias && (s.creating || s.createError)));
  }

  // The agent-native (acpx-owned) sessions available to attach for a given agent +
  // workspace — the source list for the add-session dialog's "native" picker.
  async function listNativeSessions(instanceId: string, agent: string, workspace: string): Promise<NativeSessionDto[]> {
    const { sessions } = unwrap(await api.rpc<{ sessions: NativeSessionDto[] }>(instanceId, "control.sessions.native.list", { agent, workspace }));
    return sessions;
  }

  // Best-effort model suggestions for the new-session form's datalist. acpx can't list
  // an agent's models without a live session, so we reuse the advertised `available`
  // list from an EXISTING session of the same agent + workspace. Returns [] when there
  // is no such session (e.g. a brand-new agent) or on any failure — the form then falls
  // back to a plain free-text input defaulting to "default".
  async function listModelSuggestions(instanceId: string, agent: string, workspace: string): Promise<string[]> {
    const inst = byId(instanceId);
    // Only consider live (non-archived) same-agent+workspace sessions — a fresh session
    // resembles a live one, not an archived rollout.
    const candidates = (inst?.sessions ?? []).filter((s) => s.agent === agent && s.workspace === workspace && !s.archived);
    if (candidates.length === 0) return [];
    // Different adapter versions of the same agent advertise model ids in incompatible
    // formats (e.g. codex: `gpt-5.5[high]` vs `gpt-5.5/high`). Seeding a NEW session's
    // picker from a session running a DIFFERENT adapter would propose ids the new adapter
    // rejects. We can't know the new session's adapter ahead of creation, so this is a
    // best-effort gate: only reuse when every candidate shares ONE resolved adapter
    // command; suppress (→ free-text default) when they visibly diverge. It can't catch
    // every case — `agentCommand` is undefined whenever acpx didn't record the session's
    // adapter (so two such sessions collapse to one value and still reuse) — but the
    // transport's model-not-advertised fallback (drop the rejected `--model`, use the
    // agent default) is the actual guarantee that a bad pick never bricks creation.
    if (new Set(candidates.map((s) => s.agentCommand ?? "")).size > 1) return [];
    const match = candidates[0];
    try {
      const r = unwrap(await api.rpc<SessionModelResult>(instanceId, "control.session.model.get", { sessionAlias: match.alias }));
      const seen = new Set<string>();
      const out: string[] = [];
      for (const m of [...(r.current ? [r.current] : []), ...r.available]) {
        if (m && !seen.has(m)) { seen.add(m); out.push(m); }
      }
      return out;
    } catch {
      return [];
    }
  }

  async function removeSession(instanceId: string, alias: string): Promise<void> {
    // unwrap: a connector-side business error arrives as HTTP 200 {error:…} —
    // without this the purge below would run on a failed removal.
    unwrap(await api.rpc(instanceId, "control.sessions.remove", { alias }));
    // Event-driven tail-cache purge (spec #205): a removed session must never
    // resurface as a ghost transcript from the cache. Routed through the chat
    // store so a pending debounced write-back targeting it is cancelled too.
    useChatStore().purgeTailCache(instanceId, alias);
    const user = useAuthStore().account?.username;
    if (user) await dropSessionViewSnapshots(user, instanceId, alias);
    await loadSessions(instanceId);
  }

  async function archiveSession(instanceId: string, alias: string): Promise<void> {
    // Optimistic archived flag: the connector's archive RPC returns {} without the
    // updated row, and core's `sessions-changed` only triggers a refetch — nothing
    // else flips the local row. Marking it here (rolling back on failure, mirroring
    // chat.send's warm/archived optimistic clear) lets the post-archive
    // loadSessions replace recognize the selected row as archived and retain it,
    // instead of dropping it from the active list mid-transition.
    const sessionRow = byId(instanceId)?.sessions.find((s) => s.alias === alias);
    const prevArchived = sessionRow?.archived === true;
    if (sessionRow) {
      sessionRow.archived = true;
      // Move the row into any LOADED per-group sleeping page in the same tick so the
      // grouped sidebar shows it as sleeping immediately (no remove-then-reappear).
      // On failure the rollback below undoes both flips.
      handOffRowToGroups(instanceId, sessionRow, true);
    }
    try {
      // unwrap: a connector business error (e.g. session-missing, still draining)
      // arrives as HTTP 200 {error:…} and must also trigger the rollback below.
      unwrap(await api.rpc(instanceId, "control.sessions.archive", { alias }));
    } catch (error) {
      if (sessionRow && !prevArchived) {
        sessionRow.archived = false;
        // Mirror the rollback: pull the row back out of any loaded group page so
        // the sidebar returns to its pre-archive state.
        takeRowFromGroups(instanceId, alias);
      }
      throw error;
    }
    // No cache purge: a sleeping session stays resumable, and its cached tail
    // lets waking it paint instantly.
    await loadSessions(instanceId);
    if (byId(instanceId)?.archivedSessionsLoaded) await loadArchivedSessions(instanceId);
    refreshLoadedGroupArchivedSessions(instanceId);
  }

  async function unarchiveSession(instanceId: string, alias: string): Promise<void> {
    // Wake is also optimistic-first: pull the row out of any LOADED per-group page
    // and re-insert it into the active list in the same tick, so the grouped sidebar
    // moves it between sections in one render instead of remove-then-reappear.
    const inst = byId(instanceId);
    const woken = takeRowFromGroups(instanceId, alias);
    if (inst && woken) {
      woken.archived = false;
      if (!inst.sessions.some((s) => s.alias === alias)) inst.sessions = [woken, ...inst.sessions];
    }
    try {
      unwrap(await api.rpc(instanceId, "control.sessions.unarchive", { alias }));
      if (inst && woken) woken.archived = false; // confirm the optimistic flip
    } catch (error) {
      // Roll back both halves: out of the active list, back into the group pages
      // with its sleeping state intact.
      if (inst && woken) {
        if (!woken.archived) woken.archived = true;
        handOffRowToGroups(instanceId, woken, true);
        inst.sessions = inst.sessions.filter((s) => s.alias !== alias);
      }
      throw error;
    }
    if (inst?.archivedSessionsLoaded) await loadArchivedSessions(instanceId);
    else await loadSessions(instanceId);
    refreshLoadedGroupArchivedSessions(instanceId);
  }

  // The display label lives in core session state. Update the local row before the
  // RPC settles so Enter has immediate visual feedback; a failed request restores
  // the previous value only when this optimistic value is still current.
  async function renameSession(instanceId: string, alias: string, displayName: string): Promise<void> {
    const trimmed = displayName.trim();
    const row = byId(instanceId)?.sessions.find((s) => s.alias === alias);
    const previousDisplayName = row?.displayName;
    const nextDisplayName = trimmed || undefined;
    const key = sessionRenameKey(instanceId, alias);
    const revision = ++sessionRenameRevision;
    const existingPending = pendingSessionRenames.get(key);
    if (existingPending) {
      existingPending.latestRevision = revision;
      existingPending.desiredDisplayName = nextDisplayName;
    } else {
      pendingSessionRenames.set(key, {
        latestRevision: revision,
        confirmedRevision: 0,
        desiredDisplayName: nextDisplayName,
        confirmedDisplayName: previousDisplayName,
      });
    }
    if (row) row.displayName = nextDisplayName;

    const execute = async (): Promise<void> => {
      try {
        unwrap(await api.rpc(instanceId, "control.sessions.rename", { alias, displayName: trimmed }));
        const pending = pendingSessionRenames.get(key);
        if (!pending) return;
        pending.confirmedDisplayName = nextDisplayName;
        pending.confirmedRevision = revision;
        if (pending.latestRevision === revision) {
          // Keep the optimistic overlay until a list request started after this
          // successful write confirms the same value. This prevents a list that
          // was already in flight from repainting the old display name.
          await loadSessions(instanceId).catch(() => {});
        }
      } catch (error) {
        const pending = pendingSessionRenames.get(key);
        if (pending?.latestRevision === revision) {
          pendingSessionRenames.delete(key);
          const current = byId(instanceId)?.sessions.find((s) => s.alias === alias);
          if (current && current.displayName === nextDisplayName) current.displayName = pending.confirmedDisplayName;
        }
        throw error;
      }
    };

    // Preserve request order for repeated renames of one session, while keeping
    // different sessions independent. The first request starts synchronously so
    // existing callers still observe the RPC in the same turn.
    const previousTail = sessionRenameTails.get(key);
    const operation = previousTail
      ? previousTail.catch(() => {}).then(execute)
      : execute();
    sessionRenameTails.set(key, operation);
    const cleanup = () => {
      if (sessionRenameTails.get(key) === operation) sessionRenameTails.delete(key);
    };
    void operation.then(cleanup, cleanup);
    await operation;
  }

  // The instance name lives solely in the relay DB (not on the connector), so this
  // is a plain relay HTTP PATCH — no control RPC. On success we mutate the local
  // view so the sidebar/dialog reflect the new name without a full reload.
  async function renameInstance(id: string, name: string): Promise<void> {
    await api.patch(`/api/instances/${id}`, { name });
    const inst = byId(id);
    if (inst) inst.name = name;
  }

  function applyEvent(event: WebServerEvent): void {
    if (event.kind === "instance-status") {
      const inst = byId(event.instanceId);
      if (inst) {
        inst.online = event.online;
        // An instance that just came online needs its sessions fetched regardless of
        // prior state (auto-load covers instances that were offline at mount too).
        if (event.online) {
          void loadSessions(event.instanceId).catch(() => {});
          refreshLoadedGroupArchivedSessions(event.instanceId);
        }
      }
    } else if (event.kind === "control-event" && event.event.type === "sessions-changed") {
      const inst = byId(event.instanceId);
      if (inst?.sessionsLoaded) void loadSessions(event.instanceId).catch(() => {});
      if (inst?.archivedSessionsLoaded) void loadArchivedSessions(event.instanceId).catch(() => {});
      if (inst) refreshLoadedGroupArchivedSessions(event.instanceId);
    } else if (event.kind === "control-event" && event.event.type === "workspaces-changed") {
      // A workspace was added/removed/edited on the instance (e.g. `xacpx workspace add`
      // from the terminal) — re-fetch so the file browser + create-session form reflect it.
      void loadWorkspaces(event.instanceId).catch(() => {});
    } else if (event.kind === "agent-directory") {
      agentDirectory.value = event.endpoints;
    }
  }

  function byId(id: string): InstanceView | undefined {
    return instances.value.find((i) => i.id === id);
  }
  /** Resolve a session row by alias across EVERY list the dashboard keeps it in:
   *  the active list AND per-group sleeping pages. Sleeping rows deliberately live
   *  outside `sessions` (grouped sidebar), and flat-mode archive can drop the
   *  selected row entirely until a full snapshot loads — consumers that must keep
   *  working while a sleeping session is selected (chat header/avatar, driver)
   *  resolve through here instead of `inst.sessions.find`. */
  function findSessionRow(instanceId: string, alias: string): SessionRow | undefined {
    const inst = byId(instanceId);
    if (!inst) return undefined;
    const active = inst.sessions.find((s) => s.alias === alias);
    if (active) return active;
    for (const state of Object.values(inst.groupArchived ?? {})) {
      const row = state.sessions.find((s) => s.alias === alias);
      if (row) return row;
    }
    return undefined;
  }

  return { agentDirectory, loadAgentDirectory, instances, groupModes, groupModeFor, setGroupMode, loadInstances, loadSessions, loadMoreSessions, loadSessionsForOnlineInstances, loadArchivedSessions, loadGroupArchivedSessions, refreshLoadedGroupArchivedSessions, loadWorkspaces, loadFormOptions, loadAgentCatalog, createWorkspace, createAgent, removeAgent, removeWorkspace, createSession, beginSessionCreation, cancelSessionCreation, listNativeSessions, listModelSuggestions, removeSession, archiveSession, unarchiveSession, renameSession, renameInstance, applyEvent, byId, findSessionRow };
});
