import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import CenterTabStrip from "../components/CenterTabStrip.vue";
import { useCenterTabsStore, sessionKey, TAB_DROP_END } from "../stores/center-tabs";

const g = { global: { mocks: { $t: (k: string) => k } } };

// center-tabs now persists to sessionStorage (task 2); clear it alongside the pinia reset so
// tabs opened in one test don't leak into the next test's store via hydrate().
beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear(); });

describe("CenterTabStrip", () => {
  it("renders the pinned chat tab plus one tab per open file/terminal", () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");
    store.openTerminal(K);

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });

    expect(w.find('[data-test="tab-chat"]').exists()).toBe(true);
    expect(w.findAll('[data-test="tab"]')).toHaveLength(2);
  });

  it("shows the basename of the file path as the tab label", () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");
    store.openTerminal(K);

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });
    const fileTab = w.findAll('[data-test="tab"]').find((t) => t.attributes("data-tab-id") === "file:src/a.ts")!;
    expect(fileTab.exists()).toBe(true);
    expect(fileTab.text()).toContain("a.ts");
    expect(fileTab.text()).not.toContain("src/a.ts");
  });

  it("marks the active tab with the accent styling", () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");
    store.openTerminal(K); // now terminal is active
    store.setActive(K, "file:src/a.ts"); // reactivate the file tab

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });
    const fileTab = w.findAll('[data-test="tab"]').find((t) => t.attributes("data-tab-id") === "file:src/a.ts")!;
    const terminalTab = w.findAll('[data-test="tab"]').find((t) => t.attributes("data-tab-id") === "terminal")!;
    expect(fileTab.classes().join(" ")).toContain("accent");
    expect(terminalTab.classes().join(" ")).not.toContain("accent");
    expect(w.find('[data-test="tab-chat"]').classes().join(" ")).not.toContain("accent");
  });

  it("clicking a tab activates it via the store", async () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");
    store.openTerminal(K);
    const setActive = vi.spyOn(store, "setActive");

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });
    const fileTab = w.findAll('[data-test="tab"]').find((t) => t.attributes("data-tab-id") === "file:src/a.ts")!;
    await fileTab.trigger("click");
    expect(setActive).toHaveBeenCalledWith(K, "file:src/a.ts");

    await w.find('[data-test="tab-chat"]').trigger("click");
    expect(setActive).toHaveBeenLastCalledWith(K, "chat");
  });

  it("clicking a tab's close button closes it via the store (guarded) without also activating it", async () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");
    store.openTerminal(K);
    store.setActive(K, "chat");
    const setActive = vi.spyOn(store, "setActive");
    // The close button routes through closeTabGuarded (Task 7), which asks for confirmation
    // only when the tab is dirty. This tab is clean, so the guard closes it without prompting
    // — asserted both via the guard call and the resulting store state (closeTabGuarded calls
    // the store's OWN closeTab internally via a closure reference, which a spy on the
    // store-object's `closeTab` property can't observe).
    const closeTabGuarded = vi.spyOn(store, "closeTabGuarded");

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });
    const fileTab = w.findAll('[data-test="tab"]').find((t) => t.attributes("data-tab-id") === "file:src/a.ts")!;
    await fileTab.find('[data-test="tab-close"]').trigger("click");

    expect(closeTabGuarded).toHaveBeenCalledWith(K, "file:src/a.ts", expect.any(Function));
    expect(store.tabsFor(K).some((t) => t.id === "file:src/a.ts")).toBe(false); // actually closed
    expect(setActive).not.toHaveBeenCalled(); // @click.stop must not also bubble into activation
  });

  it("wires pointerdown for drag without throwing, and each tab carries data-tab-id", () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");
    store.openTerminal(K);

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });
    const tabs = w.findAll('[data-test="tab"]');
    expect(tabs.map((t) => t.attributes("data-tab-id")).sort()).toEqual(["file:src/a.ts", "terminal"]);
    for (const t of tabs) {
      expect(() => t.trigger("pointerdown")).not.toThrow();
    }
  });

  it("suppresses text selection on the strip so a touch press-hold starts a drag instead of highlighting a label", () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });
    expect(w.element.className).toContain("select-none");
  });

  it("hides the native scrollbar on the strip (edge fade stands in for it)", () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });
    expect(w.element.className).toContain("no-scrollbar");
  });

  it("renders its own border/background chrome when standalone (default)", () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });
    const cls = w.element.className;
    expect(cls).toContain("border-b");
    expect(cls).toContain("bg-surface");
  });

  it("drops its own border/background chrome when bare, so it slots into a host row", () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");

    const w = mount(CenterTabStrip, { props: { sessionKey: K, bare: true }, ...g });
    const cls = w.element.className;
    expect(cls).not.toContain("border-b");
    expect(cls).not.toContain("bg-surface");
    // Still a working strip: chat + the open file tab both render.
    expect(w.find('[data-test="tab-chat"]').exists()).toBe(true);
    expect(w.findAll('[data-test="tab"]')).toHaveLength(1);
  });

  it("lifts the dragged tab (scale/opacity) once a pointer drag crosses the threshold", async () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");
    // jsdom has no elementFromPoint; stub it so the drag composable's default
    // resolveId doesn't throw. Returning null keeps overId null — draggingId (which
    // drives the lift class) is set from the armed tab before resolveId runs.
    (document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });
    const fileTab = w.findAll('[data-test="tab"]').find((t) => t.attributes("data-tab-id") === "file:src/a.ts")!;
    expect(fileTab.classes()).not.toContain("scale-95"); // not lifted at rest

    await fileTab.trigger("pointerdown", { clientX: 100 });
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 120, clientY: 0, bubbles: true })); // dx=20 >= 4px
    await w.vm.$nextTick();

    expect(fileTab.classes()).toContain("scale-95");
    expect(fileTab.classes()).toContain("opacity-50");

    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 120, bubbles: true })); // end gesture, remove listeners
    delete (document as unknown as { elementFromPoint?: () => null }).elementFromPoint;
  });

  it("renders a trailing end-of-strip drop zone carrying the END sentinel id, after the last tab", () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");
    store.openTerminal(K);

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });
    const endZone = w.find(`[data-tab-id="${TAB_DROP_END}"]`);
    expect(endZone.exists()).toBe(true);
    // Not a tab: no [data-test="tab"] marker, no visible label/close button.
    expect(endZone.attributes("data-test")).not.toBe("tab");
    expect(endZone.find('[data-test="tab-close"]').exists()).toBe(false);
  });
});
