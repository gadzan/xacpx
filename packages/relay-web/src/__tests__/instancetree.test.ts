import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import InstanceTree from "../components/InstanceTree.vue";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { settleConfirm, useConfirmState } from "../lib/use-confirm";

const instance = (sessions: unknown[] = [], sessionsLoaded = true) => ({
  id: "i1", name: "pc", online: true, lastSeenAt: null, sessions, sessionsLoaded, agents: [], workspaces: [],
});

describe("InstanceTree session management", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => settleConfirm(false)); // clear any dangling global confirm

  it("opens the new-session dialog from the + new session button", async () => {
    const store = useInstancesStore();
    store.instances = [instance()] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.findComponent({ name: "NewSessionDialog" }).exists()).toBe(false);
    await w.find('[data-test="new-session"]').trigger("click");
    const dialog = w.findComponent({ name: "NewSessionDialog" });
    expect(dialog.exists()).toBe(true);
    expect(dialog.props("instanceId")).toBe("i1");
    dialog.vm.$emit("close");
    await w.vm.$nextTick();
    expect(w.findComponent({ name: "NewSessionDialog" }).exists()).toBe(false);
  });

  it("opens a popup confirm and deletes only after confirming", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false }])] as never;
    const remove = vi.spyOn(store, "removeSession").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    // Clicking the trash opens the global confirm, but does NOT delete yet.
    await w.find('[data-test="delete-session"]').trigger("click");
    expect(remove).not.toHaveBeenCalled();
    expect(useConfirmState().value?.title).toBe("Delete session?");
    // Confirming resolves the dialog → delete fires.
    settleConfirm(true);
    await flushPromises();
    expect(remove).toHaveBeenCalledWith("i1", "backend");
  });

  it("does not delete when the confirm is cancelled", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false }])] as never;
    const remove = vi.spyOn(store, "removeSession").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    await w.find('[data-test="delete-session"]').trigger("click");
    settleConfirm(false);
    await flushPromises();
    expect(remove).not.toHaveBeenCalled();
  });

  it("mounts with an empty chat store and shows no attention dot for idle sessions", () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false }])] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="attention-dot"]').exists()).toBe(false);
  });

  it("renders a working dot when the chat store reports a live turn", () => {
    const instances = useInstancesStore();
    instances.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false }])] as never;
    const chat = useChatStore();
    chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    const dot = w.find('[data-test="attention-dot"]');
    expect(dot.exists()).toBe(true);
    expect(dot.attributes("data-attention")).toBe("working");
  });

  it("renders an unread dot for a finished, unviewed session", () => {
    const instances = useInstancesStore();
    instances.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false }])] as never;
    const chat = useChatStore();
    chat.select("i1", "other"); // not viewing backend
    chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "backend", ok: true } } as never);
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="attention-dot"]').attributes("data-attention")).toBe("unread");
  });

  it("shows an empty-state row only once sessions have loaded", () => {
    const store = useInstancesStore();
    store.instances = [instance([], true)] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="no-sessions"]').exists()).toBe(true);
  });

  it("shows a loading row (not the empty state) before sessions have loaded", () => {
    const store = useInstancesStore();
    store.instances = [instance([], false)] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="sessions-loading"]').exists()).toBe(true);
    expect(w.find('[data-test="no-sessions"]').exists()).toBe(false);
  });

  it("renders an elapsed badge for a working session", () => {
    const instances = useInstancesStore();
    instances.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false }])] as never;
    const chat = useChatStore();
    chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    const badge = w.find('[data-test="session-elapsed"]');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toMatch(/^\d+[smh]$/);
  });

  it("shows no elapsed badge for an idle session", () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false }])] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="session-elapsed"]').exists()).toBe(false);
  });
});
