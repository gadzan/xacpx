import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../i18n";

vi.mock("../api/client", () => ({
  ApiError: class extends Error { constructor(public code: string, public status: number) { super(code); } },
  api: { get: vi.fn(), rpc: vi.fn() },
}));

import ChatPane from "../components/ChatPane.vue";
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

it("stacks the plan panel and working HUD above the composer as overlays", async () => {
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

  const composer = w.find('[data-test="composer-area"]');
  expect(composer.exists()).toBe(true);
  expect(composer.classes()).toContain("relative");

  const overlayStack = composer.find(".absolute.bottom-full");
  expect(overlayStack.exists()).toBe(true);
  expect(overlayStack.find('[data-test="plan-panel"]').exists()).toBe(true);
  expect(overlayStack.find('[data-test="turn-hud"]').exists()).toBe(true);
  expect(overlayStack.find('[data-test="turn-hud"]').classes()).toContain("shadow-e2");
  expect(overlayStack.find('[data-test="turn-hud"]').classes()).toContain("backdrop-blur-md");
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
