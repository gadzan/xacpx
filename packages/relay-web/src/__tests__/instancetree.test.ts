import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import InstanceTree from "../components/InstanceTree.vue";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";

const instance = (sessions: unknown[] = [], sessionsLoaded = true) => ({
  id: "i1", name: "pc", online: true, lastSeenAt: null, sessions, sessionsLoaded, agents: [], workspaces: [],
});

describe("InstanceTree session management", () => {
  beforeEach(() => setActivePinia(createPinia()));

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

  it("deletes a session only after confirming (two-step)", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false }])] as never;
    const remove = vi.spyOn(store, "removeSession").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    // First click only arms the confirm — it must NOT delete.
    await w.find('[data-test="delete-session"]').trigger("click");
    expect(remove).not.toHaveBeenCalled();
    expect(w.find('[data-test="confirm-delete"]').exists()).toBe(true);
    // Confirming deletes.
    await w.find('[data-test="confirm-delete"]').trigger("click");
    expect(remove).toHaveBeenCalledWith("i1", "backend");
  });

  it("cancels a pending delete without removing", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false }])] as never;
    const remove = vi.spyOn(store, "removeSession").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    await w.find('[data-test="delete-session"]').trigger("click");
    await w.find('[data-test="cancel-delete"]').trigger("click");
    expect(remove).not.toHaveBeenCalled();
    // Confirm UI is gone; the trash affordance is back.
    expect(w.find('[data-test="confirm-delete"]').exists()).toBe(false);
    expect(w.find('[data-test="delete-session"]').exists()).toBe(true);
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
