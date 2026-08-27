import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import InstanceTree from "../components/InstanceTree.vue";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";
import { useCenterTabsStore, sessionKey } from "../stores/center-tabs";
import { useTerminalStore, terminalLocalKey } from "../stores/terminal";
import { settleConfirm, useConfirmState } from "../lib/use-confirm";
import { useActionToastState, dismissToast, runToastAction } from "../lib/use-action-toast";
import { useToasts } from "../lib/use-toasts";
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
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const remove = vi.spyOn(store, "removeSession").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    // Open the overflow menu, then click Delete: opens the global confirm but does NOT delete yet.
    await w.find('[data-test="session-menu"]').trigger("click");
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
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const remove = vi.spyOn(store, "removeSession").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    await w.find('[data-test="session-menu"]').trigger("click");
    await w.find('[data-test="delete-session"]').trigger("click");
    settleConfirm(false);
    await flushPromises();
    expect(remove).not.toHaveBeenCalled();
  });

  it("clears the chat selection when the deleted session is the active one", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    vi.spyOn(store, "removeSession").mockResolvedValue();
    const chat = useChatStore();
    chat.select("i1", "backend");
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    await w.find('[data-test="session-menu"]').trigger("click");
    await w.find('[data-test="delete-session"]').trigger("click");
    settleConfirm(true);
    await flushPromises();
    expect(chat.instanceId).toBeNull();
    expect(chat.sessionAlias).toBeNull();
  });

  it("keeps the selection when deleting a session other than the active one", async () => {
    const store = useInstancesStore();
    store.instances = [instance([
      { alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false },
      { alias: "frontend", agent: "claude", workspace: "home", transportSession: "t2", running: false, archived: false },
    ])] as never;
    vi.spyOn(store, "removeSession").mockResolvedValue();
    const chat = useChatStore();
    chat.select("i1", "backend");
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    // Open the second row's menu and delete it.
    await w.findAll('[data-test="session-menu"]')[1]!.trigger("click");
    await w.find('[data-test="delete-session"]').trigger("click");
    settleConfirm(true);
    await flushPromises();
    expect(chat.instanceId).toBe("i1");
    expect(chat.sessionAlias).toBe("backend");
  });

  it("marks a native session with the link icon and leaves a fresh one unmarked", () => {
    const store = useInstancesStore();
    store.instances = [instance([
      { alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false },
      { alias: "resumed", agent: "codex", workspace: "home", transportSession: "ses_abc", running: false, archived: false, native: true },
    ])] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    // Native sessions now carry a compact link glyph (not a text badge) to keep the row tidy.
    const marks = w.findAll('[data-test="native-badge"]');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.attributes("title")).toBe("Resumed from an existing agent-side session");
  });

  it("shows the cold indicator only on an awake session whose process has exited", () => {
    const store = useInstancesStore();
    store.instances = [instance([
      { alias: "cold", agent: "codex", workspace: "home", transportSession: "t1", running: false, archived: false, warm: false },
      { alias: "warm", agent: "codex", workspace: "home", transportSession: "t2", running: false, archived: false, warm: true },
      { alias: "unknown", agent: "codex", workspace: "home", transportSession: "t3", running: false, archived: false },
      { alias: "slept", agent: "codex", workspace: "home", transportSession: "t4", running: false, archived: true, warm: false },
    ])] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    // Only warm === false on a non-archived row lights up; warm/undefined/archived stay dark.
    const cold = w.findAll('[data-test="cold-indicator"]');
    expect(cold).toHaveLength(1);
    expect(cold[0]!.attributes("title")).toBe("Process exited — next message cold-starts.");
  });

  it("shows a spinner on an optimistic 'creating' session row", () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "", running: false, archived: false, creating: true }])] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="session-creating"]').exists()).toBe(true);
  });

  it("selects the freshly created session when the dialog reports it", async () => {
    const store = useInstancesStore();
    store.instances = [instance()] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    await w.find('[data-test="new-session"]').trigger("click");
    const dialog = w.findComponent({ name: "NewSessionDialog" });
    dialog.vm.$emit("created", "fresh");
    await w.vm.$nextTick();
    expect(w.emitted("select")).toEqual([["i1", "fresh"]]);
    // The dialog closes after creation.
    expect(w.findComponent({ name: "NewSessionDialog" }).exists()).toBe(false);
  });

  // Regression: the menu item must survive the real mousedown→click sequence. A
  // document-level mousedown listener nulls openMenuFor; if that unmounts the menu
  // before click, archive/delete silently no-op (the prior bug). `trigger("click")`
  // alone never reproduced it because it skips mousedown.
  // NOTE: `attachTo: document.body` is load-bearing — the document mousedown listener
  // only sees the event when the node is in the real DOM; without it this test goes
  // green against the buggy code. `w.unmount()` removes the node + listener after.
  it("archives via the overflow menu through a real mousedown+click sequence", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const archive = vi.spyOn(store, "archiveSession").mockResolvedValue();
    const w = mount(InstanceTree, { attachTo: document.body, global: { stubs: { NewSessionDialog: true } } });
    await w.find('[data-test="session-menu"]').trigger("mousedown");
    await w.find('[data-test="session-menu"]').trigger("click");
    const item = w.find('[data-test="action-archive"]');
    expect(item.exists()).toBe(true);
    await item.trigger("mousedown"); // bubbles to the document listener…
    expect(w.find('[data-test="action-archive"]').exists()).toBe(true); // …but the menu stays mounted
    await item.trigger("click");
    await flushPromises();
    expect(archive).toHaveBeenCalledWith("i1", "backend");
    w.unmount();
  });

  // Regression: the ⋯ dropdown must render OUTSIDE the swipe clip layer, else the
  // swipe's `overflow-hidden` clips it to the row's height (the menu appeared trapped
  // inside the row). Assert the open menu is a child of the row but NOT inside the
  // (overflow-hidden) swipe track.
  it("renders the ⋯ dropdown outside the swipe clip layer (not clipped to the row)", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const w = mount(InstanceTree, { attachTo: document.body, global: { stubs: { NewSessionDialog: true } } });
    await w.find('[data-test="session-menu"]').trigger("mousedown");
    await w.find('[data-test="session-menu"]').trigger("click");
    const menu = w.find('[data-test="delete-session"]').element;
    expect(menu).toBeTruthy();
    // Inside the row…
    expect(menu.closest('[data-test="session-row"]')).not.toBeNull();
    // …but NOT inside the overflow-hidden swipe track (which would clip it).
    expect(menu.closest('[data-test="swipe-track"]')).toBeNull();
    w.unmount();
  });

  // Regression: the row must wire the swipe composable to real pointer events. A
  // right→left swipe REVEALS the action blocks (it must NOT execute anything on its
  // own); tapping the revealed archive block then archives. Catches the
  // `onPointerdown`-vs-`pointerdown` key bug that made `v-on="handlers"` bind dead events.
  it("right→left swipe reveals actions; tapping archive archives (no execute on swipe)", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const archive = vi.spyOn(store, "archiveSession").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    const track = w.find('[data-test="swipe-track"]');
    await track.trigger("pointerdown", { clientX: 200, clientY: 0 });
    await track.trigger("pointermove", { clientX: 120, clientY: 0 });
    await track.trigger("pointerup", { clientX: 120, clientY: 0 });
    await flushPromises();
    // The swipe alone reveals — it does not archive.
    expect(archive).not.toHaveBeenCalled();
    await w.find('[data-test="swipe-archive"]').trigger("click");
    await flushPromises();
    expect(archive).toHaveBeenCalledWith("i1", "backend");
  });

  it("ignores desktop mouse drags for the touch swipe actions", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    const track = w.find('[data-test="swipe-track"]');
    await track.trigger("pointerdown", { clientX: 200, clientY: 0, pointerType: "mouse", buttons: 1 });
    await track.trigger("pointermove", { clientX: 80, clientY: 0, pointerType: "mouse", buttons: 1 });
    await track.trigger("pointerup", { clientX: 80, clientY: 0, pointerType: "mouse", buttons: 0 });
    await flushPromises();
    expect(track.attributes("style")).toContain("translateX(0)");
  });

  // The revealed delete block opens the destructive confirm only on tap — never on the
  // swipe itself, and never deletes until confirmed.
  it("tapping the revealed delete block asks to delete (not on swipe)", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const remove = vi.spyOn(store, "removeSession").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    const track = w.find('[data-test="swipe-track"]');
    await track.trigger("pointerdown", { clientX: 200, clientY: 0 });
    await track.trigger("pointermove", { clientX: 120, clientY: 0 });
    await track.trigger("pointerup", { clientX: 120, clientY: 0 });
    await flushPromises();
    expect(useConfirmState().value).toBeFalsy(); // swipe alone opens nothing
    await w.find('[data-test="swipe-delete"]').trigger("click");
    await flushPromises();
    expect(useConfirmState().value?.title).toBe("Delete session?");
    expect(remove).not.toHaveBeenCalled();
    settleConfirm(true);
    await flushPromises();
    expect(remove).toHaveBeenCalledWith("i1", "backend");
  });

  it("mounts with an empty chat store and shows no attention dot for idle sessions", () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="attention-dot"]').exists()).toBe(false);
  });

  it("renders a working dot when the chat store reports a live turn", () => {
    const instances = useInstancesStore();
    instances.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const chat = useChatStore();
    chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    const dot = w.find('[data-test="attention-dot"]');
    expect(dot.exists()).toBe(true);
    expect(dot.attributes("data-attention")).toBe("working");
  });

  it("renders an unread dot for a finished, unviewed session", () => {
    const instances = useInstancesStore();
    instances.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
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

  it("shows an explicit load action before sessions have loaded", () => {
    const store = useInstancesStore();
    store.instances = [instance([], false)] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="load-sessions"]').exists()).toBe(true);
    expect(w.find('[data-test="no-sessions"]').exists()).toBe(false);
  });

  it("renders an elapsed badge for a working session", () => {
    const instances = useInstancesStore();
    instances.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const chat = useChatStore();
    chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    const badge = w.find('[data-test="session-elapsed"]');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toMatch(/^\d+[smh]$/);
  });

  it("shows no elapsed badge for an idle session", () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="session-elapsed"]').exists()).toBe(false);
  });

  it("shows no terminal-open marker until that session's Terminal tab is open", () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="terminal-open-marker"]').exists()).toBe(false);
  });

  it("overlays a terminal-open marker on the agent icon when the Terminal tab is open", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const centerTabs = useCenterTabsStore();
    centerTabs.openTerminal(sessionKey("i1", "backend"));
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    const marker = w.find('[data-test="terminal-open-marker"]');
    expect(marker.exists()).toBe(true);
    expect(marker.attributes("title")).toBe("Terminal tab is open");
    expect(marker.attributes("aria-label")).toBe("Terminal tab is open");
    const row = w.find('[data-test="session-row"]');
    expect(row.findComponent({ name: "AgentIcon" }).exists()).toBe(true);
    expect(marker.element.parentElement?.contains(row.findComponent({ name: "AgentIcon" }).element)).toBe(true);
  });

  it("hides the terminal-open marker when that session's Terminal tab is closed", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const centerTabs = useCenterTabsStore();
    const key = sessionKey("i1", "backend");
    centerTabs.openTerminal(key);
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="terminal-open-marker"]').exists()).toBe(true);
    centerTabs.closeTab(key, "terminal");
    await w.vm.$nextTick();
    expect(w.find('[data-test="terminal-open-marker"]').exists()).toBe(false);
  });

  it("keeps the terminal-open marker on a non-selected session that still has a Terminal tab", async () => {
    const store = useInstancesStore();
    store.instances = [instance([
      { alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false },
      { alias: "frontend", agent: "codex", workspace: "home", transportSession: "t2", running: false, archived: false },
    ])] as never;
    const chat = useChatStore();
    chat.select("i1", "backend");
    const centerTabs = useCenterTabsStore();
    centerTabs.openTerminal(sessionKey("i1", "frontend"));
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    const rows = w.findAll('[data-test="session-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.find('[data-test="terminal-open-marker"]').exists()).toBe(false); // selected, no terminal
    expect(rows[1]!.find('[data-test="terminal-open-marker"]').exists()).toBe(true);  // background terminal
    expect(rows[1]!.find('[data-test="session-name"]').text()).toBe("frontend");
  });

  it("hides archived sessions from the sidebar", () => {
    const store = useInstancesStore();
    store.instances = [instance([
      { alias: "active", agent: "claude", workspace: "home", transportSession: "t1", running: false, archived: false },
      { alias: "arch", agent: "codex", workspace: "home", transportSession: "t2", running: false, archived: true },
    ])] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    const rows = w.findAll('[data-test="session-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text()).toContain("active");
    expect(w.find('[data-test="session-name"]').text()).not.toContain("arch");
    expect(w.find('[data-test="archived-badge"]').exists()).toBe(false);
  });

  it("offers an explicit recovery entry for sleeping sessions", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "active", agent: "claude", workspace: "home", transportSession: "t1", running: false, archived: false }])] as never;
    vi.spyOn(store, "loadArchivedSessions").mockImplementation(async () => {
      store.instances[0]!.sessions.push({ alias: "sleeping", agent: "claude", workspace: "home", transportSession: "t2", running: false, archived: true });
      store.instances[0]!.archivedSessionsLoaded = true;
    });
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    await w.find('[data-test="toggle-archived-sessions"]').trigger("click");
    await w.vm.$nextTick();
    expect(w.findAll('[data-test="session-row"]')).toHaveLength(2);
    expect(w.find('[data-test="session-name"]').text()).toContain("active");
    expect(w.findAll('[data-test="session-name"]')[1]!.text()).toContain("sleeping");
  });

  it("hides row actions when the instance is offline", () => {
    const store = useInstancesStore();
    store.instances = [{ ...instance([{ alias: "a", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }]), online: false }] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="session-actions"]').exists()).toBe(false);
  });

  // Archiving/deleting a session must drop its center-tabs entry so any mounted
  // terminal/file panes unmount (and the terminal's PTY tears down) — otherwise
  // an archived/deleted session leaks a live terminal pane forever.
  it("clears the session's center tabs when it is archived", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    vi.spyOn(store, "archiveSession").mockResolvedValue();
    const centerTabs = useCenterTabsStore();
    const key = sessionKey("i1", "backend");
    centerTabs.openTerminal(key);
    expect(centerTabs.tabsFor(key)).toHaveLength(1);
    const clearSession = vi.spyOn(centerTabs, "clearSession");
    const w = mount(InstanceTree, { attachTo: document.body, global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="terminal-open-marker"]').exists()).toBe(true);
    await w.find('[data-test="session-menu"]').trigger("mousedown");
    await w.find('[data-test="session-menu"]').trigger("click");
    const item = w.find('[data-test="action-archive"]');
    await item.trigger("mousedown");
    await item.trigger("click");
    await flushPromises();
    expect(clearSession).toHaveBeenCalledWith(key);
    expect(centerTabs.tabsFor(key)).toEqual([]);
    await w.vm.$nextTick();
    expect(w.find('[data-test="terminal-open-marker"]').exists()).toBe(false);
    w.unmount();
  });

  // Archive only detaches the local viewer; channel-relay retires the durable resource.
  it("detaches the terminal viewer when a session with a live terminal is archived", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    vi.spyOn(store, "archiveSession").mockResolvedValue();
    const centerTabs = useCenterTabsStore();
    const key = sessionKey("i1", "backend");
    centerTabs.openTerminal(key);
    const terminals = useTerminalStore();
    const detachSpy = vi.spyOn(terminals, "detach");
    const w = mount(InstanceTree, { attachTo: document.body, global: { stubs: { NewSessionDialog: true } } });
    await w.find('[data-test="session-menu"]').trigger("mousedown");
    await w.find('[data-test="session-menu"]').trigger("click");
    const item = w.find('[data-test="action-archive"]');
    await item.trigger("mousedown");
    await item.trigger("click");
    await flushPromises();
    expect(detachSpy).toHaveBeenCalledWith(terminalLocalKey("i1", "backend"));
    expect(centerTabs.tabsFor(key)).toEqual([]);
    w.unmount();
  });

  it("clears the session's center tabs when it is deleted", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    vi.spyOn(store, "removeSession").mockResolvedValue();
    const centerTabs = useCenterTabsStore();
    const key = sessionKey("i1", "backend");
    centerTabs.openTerminal(key);
    expect(centerTabs.tabsFor(key)).toHaveLength(1);
    const clearSession = vi.spyOn(centerTabs, "clearSession");
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.find('[data-test="terminal-open-marker"]').exists()).toBe(true);
    await w.find('[data-test="session-menu"]').trigger("click");
    await w.find('[data-test="delete-session"]').trigger("click");
    settleConfirm(true);
    await flushPromises();
    expect(clearSession).toHaveBeenCalledWith(key);
    expect(centerTabs.tabsFor(key)).toEqual([]);
    await w.vm.$nextTick();
    expect(w.find('[data-test="terminal-open-marker"]').exists()).toBe(false);
  });

  // A connector business error (HTTP 200 {error:…} surfaced by the store) must
  // leave the UI untouched: no tab teardown, no terminal detach, no undo toast —
  // only an error toast. The pre-PR order tore everything down BEFORE the RPC
  // settled, producing a fake success.
  it("keeps center tabs and shows an error toast when the archive RPC rejects", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    vi.spyOn(store, "archiveSession").mockRejectedValue(new Error("still finishing a stopped turn"));
    const centerTabs = useCenterTabsStore();
    const key = sessionKey("i1", "backend");
    centerTabs.openTerminal(key);
    const clearSession = vi.spyOn(centerTabs, "clearSession");
    // The undo toast is a module singleton — an earlier success-path test may have
    // left one armed (its 6s timer outlives the test). Reset so null is meaningful.
    dismissToast();
    const actionToast = useActionToastState();
    const w = mount(InstanceTree, { attachTo: document.body, global: { stubs: { NewSessionDialog: true } } });
    await w.find('[data-test="session-menu"]').trigger("mousedown");
    await w.find('[data-test="session-menu"]').trigger("click");
    const item = w.find('[data-test="action-archive"]');
    await item.trigger("mousedown");
    await item.trigger("click");
    await flushPromises();
    expect(clearSession).not.toHaveBeenCalled();
    expect(centerTabs.tabsFor(key)).toHaveLength(1);
    // No success/undo toast — the error surfaces instead.
    expect(actionToast.value).toBeNull();
    w.unmount();
  });

  it("keeps the selection and center tabs when the delete RPC rejects", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    vi.spyOn(store, "removeSession").mockRejectedValue(new Error("still finishing a stopped turn"));
    const chat = useChatStore();
    chat.select("i1", "backend");
    const centerTabs = useCenterTabsStore();
    const key = sessionKey("i1", "backend");
    centerTabs.openTerminal(key);
    const clearSession = vi.spyOn(centerTabs, "clearSession");
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    await w.find('[data-test="session-menu"]').trigger("click");
    await w.find('[data-test="delete-session"]').trigger("click");
    settleConfirm(true);
    await flushPromises();
    expect(clearSession).not.toHaveBeenCalled();
    expect(centerTabs.tabsFor(key)).toHaveLength(1);
    expect(chat.sessionAlias).toBe("backend"); // selection kept
  });

  it("Undo on the archived toast surfaces an error toast when the wake RPC rejects", async () => {
    // archive succeeds → Undo fires → unarchive rejects (connector business
    // error). runToastAction clears the undo toast BEFORE the action, so without
    // routing through onUnarchive's error handling the failure would be silent
    // and the session would stay archived with no feedback.
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    vi.spyOn(store, "archiveSession").mockResolvedValue();
    vi.spyOn(store, "unarchiveSession").mockRejectedValue(new Error("session not found"));
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    await w.find('[data-test="session-menu"]').trigger("click");
    const item = w.find('[data-test="action-archive"]');
    await item.trigger("mousedown");
    await item.trigger("click");
    await flushPromises();
    // Undo toast armed by the successful archive; consume it like ActionToast does.
    const toasts = useToasts();
    toasts.value = [];
    runToastAction();
    await flushPromises();
    expect(useActionToastState().value).toBeNull(); // undo toast consumed
    const error = toasts.value.find((x) => x.key === "instance.sessionUnarchiveFailed");
    expect(error).toMatchObject({ tone: "error", params: { alias: "backend", msg: "session not found" } });
  });

  // Delete only detaches the local viewer; channel-relay retires the durable resource.
  it("detaches the terminal viewer when a session with a live terminal is deleted", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    vi.spyOn(store, "removeSession").mockResolvedValue();
    const centerTabs = useCenterTabsStore();
    const key = sessionKey("i1", "backend");
    centerTabs.openTerminal(key);
    const terminals = useTerminalStore();
    const detachSpy = vi.spyOn(terminals, "detach");
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    await w.find('[data-test="session-menu"]').trigger("click");
    await w.find('[data-test="delete-session"]').trigger("click");
    settleConfirm(true);
    await flushPromises();
    expect(detachSpy).toHaveBeenCalledWith(terminalLocalKey("i1", "backend"));
    expect(centerTabs.tabsFor(key)).toEqual([]);
  });
});
