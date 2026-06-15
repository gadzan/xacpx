import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  ApiError: class extends Error { constructor(public code: string, public status: number) { super(code); } },
  api: { get: vi.fn(), rpc: vi.fn() },
}));

import ChatPane from "../components/ChatPane.vue";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";
import { useFilesStore } from "../stores/files";

beforeEach(() => setActivePinia(createPinia()));

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

it("hides the HUD when no turn is active", () => {
  const chat = useChatStore();
  chat.select("i1", "backend");
  const w = mount(ChatPane);
  expect(w.find('[data-test="turn-hud"]').exists()).toBe(false);
});

it("cycles the working verb every ~4s while the turn runs", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const chat = useChatStore();
  chat.select("i1", "backend");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  expect(w.find('[data-test="turn-hud"]').text()).toContain("Working"); // bucket 0
  vi.advanceTimersByTime(5000); // 5s → bucket 1, also drives the 1Hz clock
  await w.vm.$nextTick();
  const t = w.find('[data-test="turn-hud"]').text();
  expect(t).not.toContain("Working");
  expect(t).toContain("Thinking");
  vi.useRealTimers();
});
