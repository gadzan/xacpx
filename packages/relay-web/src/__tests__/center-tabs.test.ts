import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useCenterTabsStore, sessionKey, TAB_DROP_END } from "../stores/center-tabs";

beforeEach(() => setActivePinia(createPinia()));
const K = sessionKey("i1", "s1");

describe("center-tabs store", () => {
  it("opens a file tab, dedupes by path, and activates it", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts");
    s.openFile(K, "a.ts"); // dedupe
    expect(s.tabsFor(K).map(t => t.id)).toEqual(["file:a.ts"]);
    expect(s.activeFor(K)).toBe("file:a.ts");
  });

  it("diff and terminal ids are namespaced/fixed", () => {
    const s = useCenterTabsStore();
    s.openDiff(K, "a.ts");
    s.openTerminal(K);
    expect(s.tabsFor(K).map(t => t.id)).toEqual(["diff:a.ts", "terminal"]);
    s.openTerminal(K); // one terminal per session
    expect(s.tabsFor(K).filter(t => t.kind === "terminal").length).toBe(1);
  });

  it("file ids are namespaced so they can't collide with the terminal tab or a diff tab", () => {
    const s = useCenterTabsStore();
    // A root file literally named "terminal" must not collide with the fixed terminal id.
    s.openFile(K, "terminal");
    s.openTerminal(K);
    expect(s.tabsFor(K).map(t => t.id)).toEqual(["file:terminal", "terminal"]);
    expect(s.tabsFor(K).length).toBe(2);

    // A file whose path is literally "diff:x" must not collide with the diff tab of "x".
    const K2 = sessionKey("i1", "s2");
    s.openFile(K2, "diff:x");
    s.openDiff(K2, "x");
    expect(s.tabsFor(K2).map(t => t.id)).toEqual(["file:diff:x", "diff:x"]);
    expect(s.tabsFor(K2).length).toBe(2);
  });

  it("closing the active tab activates the left neighbor, else chat", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts"); s.openFile(K, "b.ts"); // active = b.ts
    s.closeTab(K, "file:b.ts");
    expect(s.activeFor(K)).toBe("file:a.ts");
    s.closeTab(K, "file:a.ts");
    expect(s.activeFor(K)).toBe("chat");
    expect(s.tabsFor(K)).toEqual([]);
  });

  it("closing a non-active tab keeps the active one", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts"); s.openFile(K, "b.ts"); s.setActive(K, "chat");
    s.closeTab(K, "file:a.ts");
    expect(s.activeFor(K)).toBe("chat");
    expect(s.tabsFor(K).map(t => t.id)).toEqual(["file:b.ts"]);
  });

  it("reorder moves the dragged tab before the target", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts"); s.openFile(K, "b.ts"); s.openFile(K, "c.ts");
    s.reorder(K, "file:c.ts", "file:a.ts"); // c before a
    expect(s.tabsFor(K).map(t => t.id)).toEqual(["file:c.ts", "file:a.ts", "file:b.ts"]);
  });

  it("reorder moves the dragged tab to the end when the target is the END sentinel", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts"); s.openFile(K, "b.ts"); s.openFile(K, "c.ts");
    s.reorder(K, "file:a.ts", TAB_DROP_END);
    expect(s.tabsFor(K).map(t => t.id)).toEqual(["file:b.ts", "file:c.ts", "file:a.ts"]);
  });

  it("reorder to END is a no-op when the dragged tab is missing", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts"); s.openFile(K, "b.ts");
    s.reorder(K, "file:missing.ts", TAB_DROP_END);
    expect(s.tabsFor(K).map(t => t.id)).toEqual(["file:a.ts", "file:b.ts"]);
  });

  it("tabs are isolated per session and clearSession removes them", () => {
    const s = useCenterTabsStore();
    const K2 = sessionKey("i1", "s2");
    s.openFile(K, "a.ts"); s.openTerminal(K2);
    expect(s.tabsFor(K).length).toBe(1);
    expect(s.tabsFor(K2).length).toBe(1);
    expect(s.allOpenTabs().length).toBe(2);
    s.clearSession(K);
    expect(s.tabsFor(K)).toEqual([]);
    expect(s.allOpenTabs().length).toBe(1);
  });

  it("activeFor defaults to chat for an unknown session", () => {
    const s = useCenterTabsStore();
    expect(s.activeFor(sessionKey("x", "y"))).toBe("chat");
    expect(s.tabsFor(sessionKey("x", "y"))).toEqual([]);
  });
});
