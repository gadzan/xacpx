import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import CenterTabStrip from "../components/CenterTabStrip.vue";
import { useCenterTabsStore, sessionKey } from "../stores/center-tabs";

const g = { global: { mocks: { $t: (k: string) => k } } };

beforeEach(() => setActivePinia(createPinia()));

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
    const fileTab = w.findAll('[data-test="tab"]').find((t) => t.attributes("data-tab-id") === "src/a.ts")!;
    expect(fileTab.exists()).toBe(true);
    expect(fileTab.text()).toContain("a.ts");
    expect(fileTab.text()).not.toContain("src/a.ts");
  });

  it("marks the active tab with the accent styling", () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");
    store.openTerminal(K); // now terminal is active
    store.setActive(K, "src/a.ts"); // reactivate the file tab

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });
    const fileTab = w.findAll('[data-test="tab"]').find((t) => t.attributes("data-tab-id") === "src/a.ts")!;
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
    const fileTab = w.findAll('[data-test="tab"]').find((t) => t.attributes("data-tab-id") === "src/a.ts")!;
    await fileTab.trigger("click");
    expect(setActive).toHaveBeenCalledWith(K, "src/a.ts");

    await w.find('[data-test="tab-chat"]').trigger("click");
    expect(setActive).toHaveBeenLastCalledWith(K, "chat");
  });

  it("clicking a tab's close button closes it via the store without also activating it", async () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");
    store.openTerminal(K);
    store.setActive(K, "chat");
    const setActive = vi.spyOn(store, "setActive");
    const closeTab = vi.spyOn(store, "closeTab");

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });
    const fileTab = w.findAll('[data-test="tab"]').find((t) => t.attributes("data-tab-id") === "src/a.ts")!;
    await fileTab.find('[data-test="tab-close"]').trigger("click");

    expect(closeTab).toHaveBeenCalledWith(K, "src/a.ts");
    expect(setActive).not.toHaveBeenCalled(); // @click.stop must not also bubble into activation
  });

  it("wires pointerdown for drag without throwing, and each tab carries data-tab-id", () => {
    const store = useCenterTabsStore();
    const K = sessionKey("i1", "s1");
    store.openFile(K, "src/a.ts");
    store.openTerminal(K);

    const w = mount(CenterTabStrip, { props: { sessionKey: K }, ...g });
    const tabs = w.findAll('[data-test="tab"]');
    expect(tabs.map((t) => t.attributes("data-tab-id")).sort()).toEqual(["src/a.ts", "terminal"]);
    for (const t of tabs) {
      expect(() => t.trigger("pointerdown")).not.toThrow();
    }
  });
});
