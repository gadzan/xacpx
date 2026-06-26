import { defineStore } from "pinia";
import { ref } from "vue";
import { isErrorPayload, type AgentCatalogEntryDto, type AgentDto, type NativeSessionDto, type SessionDto, type SessionModelResult, type WebServerEvent, type WorkspaceDto } from "@ganglion/xacpx-relay-protocol";
import { api, ApiError } from "../api/client";

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

export interface InstanceView {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  // The xacpx core version the connector reported at registration (null for legacy
  // connectors that predate version reporting). Surfaced so operators can spot a
  // version-skewed connector before its missing features fail with `unknown-type`.
  coreVersion?: string | null;
  sessions: SessionDto[];
  // Distinguishes "sessions never fetched" from "fetched and genuinely empty" so the
  // sidebar only shows the "no sessions yet" empty row once a list has actually loaded.
  sessionsLoaded: boolean;
  agents: AgentDto[];
  workspaces: WorkspaceDto[];
  agentCatalog: AgentCatalogEntryDto[];
}

export const useInstancesStore = defineStore("instances", () => {
  const instances = ref<InstanceView[]>([]);

  async function loadInstances(): Promise<void> {
    const { instances: rows } = await api.get<{ instances: Array<Omit<InstanceView, "sessions" | "sessionsLoaded" | "agents" | "workspaces" | "agentCatalog">> }>("/api/instances");
    instances.value = rows.map((r) => {
      const prev = byId(r.id);
      return { ...r, sessions: prev?.sessions ?? [], sessionsLoaded: prev?.sessionsLoaded ?? false, agents: prev?.agents ?? [], workspaces: prev?.workspaces ?? [], agentCatalog: prev?.agentCatalog ?? [] };
    });
    // Eagerly populate the session list for every online instance so the sidebar shows
    // them without the user having to click the instance first. Fire-and-forget: a slow
    // or failing instance must not block the rest of the dashboard from rendering.
    for (const inst of instances.value) {
      if (inst.online && !inst.sessionsLoaded) void loadSessions(inst.id).catch(() => {});
    }
  }

  async function loadSessions(instanceId: string): Promise<void> {
    // Pull the configured agents alongside the session list (once) so the sidebar and chat
    // can map each session's agent NAME → driver for the brand icon. Agents otherwise only
    // load when a create/manage dialog opens (loadFormOptions), so in the normal
    // login→browse→chat flow inst.agents would stay empty and every icon would fall back to
    // the generic glyph. Tolerant + fire-alongside: an agents failure must never block the
    // session list, and it self-heals on the next loadSessions since `agents` stays empty.
    const needAgents = (byId(instanceId)?.agents.length ?? 0) === 0;
    const [{ sessions }, agentsRes] = await Promise.all([
      api.rpc<{ sessions: SessionDto[] }>(instanceId, "control.sessions.list"),
      needAgents
        ? api.rpc<{ agents: AgentDto[] }>(instanceId, "control.agents.list").catch(() => null)
        : Promise.resolve(null),
    ]);
    const inst = byId(instanceId);
    if (inst) {
      inst.sessions = sessions;
      inst.sessionsLoaded = true;
      if (agentsRes && !isErrorPayload(agentsRes) && Array.isArray(agentsRes.agents)) inst.agents = agentsRes.agents;
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
  async function createSession(instanceId: string, alias: string, agent: string, workspace: string, agentSessionId?: string, model?: string): Promise<{ pending: boolean }> {
    try {
      // agentSessionId, when set, resumes an existing agent-native session instead of
      // creating a fresh transport session (the web "attach native session" option).
      // model, when set, overrides the agent's default model for the new session
      // (empty/"default" is omitted so the agent default is used).
      unwrap(await api.rpc(instanceId, "control.sessions.create", { alias, agent, workspace, ...(agentSessionId ? { agentSessionId } : {}), ...(model ? { model } : {}) }));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 504 || e.code === "timeout")) return { pending: true };
      throw e;
    }
    await loadSessions(instanceId);
    return { pending: false };
  }

  // The agent-native (acpx-owned) sessions available to attach for a given agent +
  // workspace — the source list for the add-session dialog's "native" picker.
  async function listNativeSessions(instanceId: string, agent: string, workspace: string): Promise<NativeSessionDto[]> {
    const { sessions } = unwrap(await api.rpc<{ sessions: NativeSessionDto[] }>(instanceId, "control.sessions.native.list", { agent, workspace }));
    return sessions;
  }

  // Best-effort model suggestions for the new-session form's datalist. acpx can't list
  // an agent's models without a live session, so we reuse the advertised `available`
  // list from any EXISTING session of the same agent + workspace. Returns [] when there
  // is no such session (e.g. a brand-new agent) or on any failure — the form then falls
  // back to a plain free-text input defaulting to "default".
  async function listModelSuggestions(instanceId: string, agent: string, workspace: string): Promise<string[]> {
    const inst = byId(instanceId);
    const match = (inst?.sessions ?? []).find((s) => s.agent === agent && s.workspace === workspace);
    if (!match) return [];
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
    await api.rpc(instanceId, "control.sessions.remove", { alias });
    await loadSessions(instanceId);
  }

  async function archiveSession(instanceId: string, alias: string): Promise<void> {
    await api.rpc(instanceId, "control.sessions.archive", { alias });
    await loadSessions(instanceId);
  }

  async function unarchiveSession(instanceId: string, alias: string): Promise<void> {
    await api.rpc(instanceId, "control.sessions.unarchive", { alias });
    await loadSessions(instanceId);
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
        // An instance that just came online may not have had its sessions fetched yet
        // (it was offline at the initial snapshot) — pull them now so the sidebar fills in.
        if (event.online && !inst.sessionsLoaded) void loadSessions(event.instanceId).catch(() => {});
      }
    } else if (event.kind === "control-event" && event.event.type === "sessions-changed") {
      void loadSessions(event.instanceId).catch(() => {});
    } else if (event.kind === "control-event" && event.event.type === "workspaces-changed") {
      // A workspace was added/removed/edited on the instance (e.g. `xacpx workspace add`
      // from the terminal) — re-fetch so the file browser + create-session form reflect it.
      void loadWorkspaces(event.instanceId).catch(() => {});
    }
  }

  function byId(id: string): InstanceView | undefined {
    return instances.value.find((i) => i.id === id);
  }

  return { instances, loadInstances, loadSessions, loadWorkspaces, loadFormOptions, loadAgentCatalog, createWorkspace, createAgent, removeAgent, removeWorkspace, createSession, listNativeSessions, listModelSuggestions, removeSession, archiveSession, unarchiveSession, renameInstance, applyEvent, byId };
});
