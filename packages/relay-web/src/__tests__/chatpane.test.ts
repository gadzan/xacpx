import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../i18n";

vi.mock("../api/client", () => ({
  ApiError: class extends Error { constructor(public code: string, public status: number) { super(code); } },
  api: { get: vi.fn(), rpc: vi.fn() },
}));

import ChatPane from "../components/ChatPane.vue";
import { api } from "../api/client";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";
import { useFilesStore } from "../stores/files";
import { useComposerStore } from "../stores/composer";

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => { i18n.global.locale.value = "en"; });

function seedInstance() {
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "prod-box", online: true, lastSeenAt: null,
    sessions: [{ alias: "backend", agent: "codex", workspace: "gaia" }],
    agents: [], workspaces: [], agentCatalog: [],
  } as never);
}

it("renders workspace, instance and agent context chips for the current session", async () => {
  seedInstance();
  const chat = useChatStore();
  chat.select("i1", "backend");
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  expect(w.find('[data-test="ctx-chip-workspace"]').text()).toContain("gaia");
  expect(w.find('[data-test="ctx-chip-instance"]').text()).toContain("prod-box");
  expect(w.find('[data-test="ctx-chip-agent"]').text()).toContain("codex");
});

it("clicking the workspace chip emits show-files", async () => {
  seedInstance();
  const chat = useChatStore();
  chat.select("i1", "backend");
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  await w.find('[data-test="ctx-chip-workspace"]').trigger("click");
  expect(w.emitted("show-files")).toBeTruthy();
});

it("renders a git summary chip and clicking it opens the Changes tab", async () => {
  seedInstance();
  const chat = useChatStore();
  const files = useFilesStore();
  chat.select("i1", "backend");
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  // Set after mount so the immediate watch (which clears it via the mocked rpc)
  // doesn't overwrite our fixture.
  files.gitSummary = { workspace: "gaia", changedCount: 3 };
  await w.vm.$nextTick();
  const chip = w.find('[data-test="git-summary"]');
  expect(chip.exists()).toBe(true);
  expect(chip.text()).toContain("3 changed");
  await chip.trigger("click");
  expect(files.tab).toBe("changes");
  expect(w.emitted("show-files")).toBeTruthy();
});

it("shows a working HUD while a live turn is active", async () => {
  const chat = useChatStore();
  chat.select("i1", "backend");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  expect(w.find('[data-test="turn-hud"]').exists()).toBe(true);
  expect(w.find('[data-test="turn-hud"]').text()).toContain("Working");
});

it("stacks status, plan, and composer as document-flow layers (status → plan → input)", async () => {
  seedInstance();
  const chat = useChatStore();
  chat.select("i1", "backend");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: {
    type: "plan", sessionAlias: "backend",
    entries: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }],
  } } as never);
  const w = mount(ChatPane);
  await w.vm.$nextTick();

  const area = w.find('[data-test="composer-area"]');
  expect(area.exists()).toBe(true);
  const stack = area.find('[data-test="composer-stack"]');
  expect(stack.exists()).toBe(true);
  expect(stack.classes()).toContain("composer-stack");
  expect(stack.classes()).not.toContain("absolute");

  const status = stack.find('[data-test="turn-hud"]');
  const plan = stack.find('[data-test="plan-panel"]');
  expect(status.exists()).toBe(true);
  expect(plan.exists()).toBe(true);
  expect(status.classes()).toContain("stack-layer--status");
  expect(plan.classes()).toContain("stack-layer--plan");
  expect(plan.classes()).toContain("stack-layer--pull");
  expect(status.classes()).toContain("shadow-e2");
  expect(status.classes()).toContain("backdrop-blur-md");

  // DOM order: status (bottom layer) → plan (middle) → composer (top).
  const stackEl = stack.element as HTMLElement;
  const statusEl = status.element as HTMLElement;
  const planEl = plan.element as HTMLElement;
  const composerEl = stackEl.querySelector(".stack-layer--composer") as HTMLElement | null;
  expect(composerEl).toBeTruthy();
  expect(composerEl!.classList.contains("stack-layer--pull")).toBe(true);
  const kids = [...stackEl.children] as HTMLElement[];
  expect(kids.indexOf(statusEl)).toBeLessThan(kids.indexOf(planEl));
  expect(kids.indexOf(planEl)).toBeLessThan(kids.indexOf(composerEl!));
});

it("grouped sidebar: sleeping row lives only in groupArchived — avatar still shows its driver", async () => {
  // Production shape (grouped sidebar): archived rows are paged into
  // inst.groupArchived[*].sessions and stay OUT of inst.sessions. inst.agents is
  // not loaded. Only the row's own SessionDto.driver can drive the icon.
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "prod-box", online: true, lastSeenAt: null,
    sessions: [{ alias: "active", agent: "codex", workspace: "ws" }],
    groupArchived: {
      "workspace:ws": {
        sessions: [{ alias: "sleepy", agent: "my-kimi", driver: "kimi", workspace: "ws", archived: true }],
        loaded: true, hasMore: false, nextOffset: 1,
      },
    },
    agents: [], workspaces: [], agentCatalog: [],
  } as never);
  const chat = useChatStore();
  chat.select("i1", "sleepy");
  // The avatar rides the assistant bubble row — seed one so it renders.
  chat.messages.push({
    instanceId: "i1", sessionAlias: "sleepy", direction: "out",
    text: "hello", createdAt: new Date().toISOString(),
  } as never);
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  const icon = w.find('[data-test="agent-icon"]');
  expect(icon.exists()).toBe(true);
  expect(icon.attributes("data-driver")).toBe("kimi");
});

it("flat sidebar: archiving the SELECTED session keeps the avatar driver through the real transition", async () => {
  // The full production sequence: row starts ACTIVE (archived:false) →
  // archiveSession RPC → optimistic archived flag → loadSessions replace whose
  // active-only page no longer contains the row → keep-rule retains it →
  // findSessionRow still resolves the open chat's driver.
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "prod-box", online: true, lastSeenAt: null,
    sessions: [{ alias: "main", agent: "my-kimi", driver: "kimi", workspace: "ws", transportSession: "t1", running: false, archived: false }],
    agents: [], workspaces: [], agentCatalog: [],
  } as never);
  const chat = useChatStore();
  chat.select("i1", "main");
  chat.messages.push({
    instanceId: "i1", sessionAlias: "main", direction: "out",
    text: "hello", createdAt: new Date().toISOString(),
  } as never);

  const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id: string, type: string) => {
    if (type === "control.sessions.archive") return {}; // connector returns {} — no row back
    if (type === "control.agents.list") return { agents: [] };
    // Post-archive refresh: active-only page WITHOUT the just-slept row.
    return {
      sessions: [{ alias: "other", agent: "codex", workspace: "ws2", transportSession: "t2", running: false, archived: false }],
      hasMore: false,
    };
  });
  await instances.archiveSession("i1", "main");
  rpc.mockRestore();

  // The optimistic flag + retain rule kept the selected row across the refresh…
  const kept = instances.byId("i1")!.sessions.find((s) => s.alias === "main");
  expect(kept?.archived).toBe(true);
  // …and findSessionRow (what ChatPane resolves with) still yields the driver.
  expect(instances.findSessionRow("i1", "main")?.driver).toBe("kimi");

  const w = mount(ChatPane);
  await w.vm.$nextTick();
  const icon = w.find('[data-test="agent-icon"]');
  expect(icon.exists()).toBe(true);
  expect(icon.attributes("data-driver")).toBe("kimi");
});

it("flat sidebar: a failed archive rolls the optimistic archived flag back (transport throw)", async () => {
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "prod-box", online: true, lastSeenAt: null,
    sessions: [{ alias: "main", agent: "my-kimi", driver: "kimi", workspace: "ws", transportSession: "t1", running: false, archived: false }],
    agents: [], workspaces: [], agentCatalog: [],
  } as never);
  const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id: string, type: string) => {
    if (type === "control.sessions.archive") throw new Error("archive failed");
    if (type === "control.agents.list") return { agents: [] };
    return { sessions: [], hasMore: false };
  });
  await expect(instances.archiveSession("i1", "main")).rejects.toThrow("archive failed");
  rpc.mockRestore();
  // Rollback: the row stays active-looking so the sidebar doesn't grey a live session.
  expect(instances.byId("i1")!.sessions.find((s) => s.alias === "main")?.archived).toBe(false);
});

it("flat sidebar: a connector ErrorPayload (HTTP 200 {error:…}) archive also rolls back", async () => {
  // The control bridge wraps connector business errors as a RESOLVED {error:{code,
  // message}} payload — api.rpc does NOT reject. Only unwrap() surfaces it, so this
  // test locks that archiveSession routes through unwrap and the optimistic flag
  // still rolls back (the gap called out in #304 review round 3).
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "prod-box", online: true, lastSeenAt: null,
    sessions: [{ alias: "main", agent: "my-kimi", driver: "kimi", workspace: "ws", transportSession: "t1", running: false, archived: false }],
    agents: [], workspaces: [], agentCatalog: [],
  } as never);
  const rpc = vi.spyOn(api, "rpc").mockImplementation(async (_id: string, type: string) => {
    if (type === "control.sessions.archive") return { error: { code: "session-still-draining", message: "session \"main\" is still finishing a stopped turn; retry in a moment" } };
    if (type === "control.agents.list") return { agents: [] };
    return { sessions: [], hasMore: false };
  });
  await expect(instances.archiveSession("i1", "main")).rejects.toThrow("still finishing a stopped turn");
  rpc.mockRestore();
  expect(instances.byId("i1")!.sessions.find((s) => s.alias === "main")?.archived).toBe(false);
  // The follow-up refetch never ran either (the RPC aborted before loadSessions).
  expect(rpc).not.toHaveBeenCalledWith("i1", "control.sessions.list", expect.anything());
});

it("localizes the empty-state prompt when locale is zh-CN", () => {
  i18n.global.locale.value = "zh-CN";
  const w = mount(ChatPane); // no session selected → empty state
  expect(w.text()).toContain("选择一个会话");
});

it("hides the HUD when no turn is active", () => {
  const chat = useChatStore();
  chat.select("i1", "backend");
  const w = mount(ChatPane);
  expect(w.find('[data-test="turn-hud"]').exists()).toBe(false);
});

it("clears staged attachments when switching session so they don't leak to the next target", async () => {
  seedInstance();
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "prod-box", online: true, lastSeenAt: null,
    sessions: [{ alias: "frontend", agent: "codex", workspace: "gaia" }],
    agents: [], workspaces: [], agentCatalog: [],
  } as never);
  const chat = useChatStore();
  const composer = useComposerStore();
  chat.select("i1", "backend");
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  // Stage a chip on the current session.
  composer.pending.push({ id: "p1", filename: "a.png", mimeType: "image/png", size: 3, kind: "image", status: "ready" });
  expect(composer.pending).toHaveLength(1);
  // Switch to a different session on the same instance → staged chips drop.
  chat.select("i1", "frontend");
  await w.vm.$nextTick();
  expect(composer.pending).toHaveLength(0);
});

it("shows the booting view (not the composer) for a session that is still creating", async () => {
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "prod-box", online: true, lastSeenAt: null,
    sessions: [{ alias: "backend", agent: "codex", workspace: "gaia", transportSession: "", running: false, archived: false, creating: true, creatingSince: Date.now() - 12_000 }],
    agents: [], workspaces: [], agentCatalog: [],
  } as never);
  const chat = useChatStore();
  chat.select("i1", "backend");
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  const booting = w.find('[data-test="session-booting"]');
  expect(booting.exists()).toBe(true);
  expect(booting.text()).toContain("Starting codex");
  expect(booting.text()).toMatch(/1[12]s/); // elapsed ~12s
  expect(w.find('[data-test="booting-cancel"]').exists()).toBe(true);
});

it("cancelling a booting session drops its row and clears the selection", async () => {
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "prod-box", online: true, lastSeenAt: null,
    sessions: [{ alias: "backend", agent: "codex", workspace: "gaia", transportSession: "", running: false, archived: false, creating: true, creatingSince: Date.now() }],
    agents: [], workspaces: [], agentCatalog: [],
  } as never);
  const chat = useChatStore();
  chat.select("i1", "backend");
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  await w.find('[data-test="booting-cancel"]').trigger("click");
  expect(instances.byId("i1")!.sessions).toHaveLength(0);
  expect(chat.sessionAlias).toBeNull();
});

it("surfaces a create failure in the booting view with a dismiss action", async () => {
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "prod-box", online: true, lastSeenAt: null,
    sessions: [{ alias: "backend", agent: "codex", workspace: "gaia", transportSession: "", running: false, archived: false, creating: false, createError: "agent not installed" }],
    agents: [], workspaces: [], agentCatalog: [],
  } as never);
  const chat = useChatStore();
  chat.select("i1", "backend");
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  const booting = w.find('[data-test="session-booting"]');
  expect(booting.exists()).toBe(true);
  expect(booting.text()).toContain("agent not installed");
  await w.find('[data-test="booting-dismiss"]').trigger("click");
  expect(chat.sessionAlias).toBeNull();
});

it("cycles the working verb every ~10s while the turn runs", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const chat = useChatStore();
  chat.select("i1", "backend");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  expect(w.find('[data-test="turn-hud"]').text()).toContain("Working"); // bucket 0
  vi.advanceTimersByTime(5000); // 5s → still bucket 0 on the calm ~10s cadence
  await w.vm.$nextTick();
  expect(w.find('[data-test="turn-hud"]').text()).toContain("Working");
  vi.advanceTimersByTime(6000); // 11s total → bucket 1, also drives the 1Hz clock
  await w.vm.$nextTick();
  const t = w.find('[data-test="turn-hud"]').text();
  expect(t).not.toContain("Working");
  expect(t).toContain("Thinking");
  vi.useRealTimers();
});
