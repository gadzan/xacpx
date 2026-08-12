import { describe, it, expect, beforeEach, vi } from "vitest";
import { nextTick } from "vue";
import { setActivePinia, createPinia } from "pinia";
import { useCenterTabsStore, sessionKey, TAB_DROP_END } from "../stores/center-tabs";
import { draftKey, loadFileDraft, saveFileDraft } from "../lib/file-drafts";

beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear(); });
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

  it("closeTab clears the closed file tab's draft (abandoned edit does not come back)", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts");
    saveFileDraft(draftKey(K, "a.ts"), "draft content");
    expect(loadFileDraft(draftKey(K, "a.ts"))).toBe("draft content");
    s.closeTab(K, "file:a.ts");
    expect(loadFileDraft(draftKey(K, "a.ts"))).toBeNull();
  });

  it("closeTab on a file tab with no draft is a no-op for drafts (doesn't throw / doesn't create one)", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts");
    s.closeTab(K, "file:a.ts");
    expect(loadFileDraft(draftKey(K, "a.ts"))).toBeNull();
  });

  it("closeTab on a diff or terminal tab does not touch any file draft", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts");
    saveFileDraft(draftKey(K, "a.ts"), "draft content");
    s.openDiff(K, "b.ts");
    s.openTerminal(K);
    s.closeTab(K, "diff:b.ts");
    s.closeTab(K, "terminal");
    expect(loadFileDraft(draftKey(K, "a.ts"))).toBe("draft content");
  });

  it("closing one file's tab does not clear a different file's draft", () => {
    const s = useCenterTabsStore();
    s.openFile(K, "a.ts"); s.openFile(K, "b.ts");
    saveFileDraft(draftKey(K, "a.ts"), "draft a");
    saveFileDraft(draftKey(K, "b.ts"), "draft b");
    s.closeTab(K, "file:b.ts");
    expect(loadFileDraft(draftKey(K, "a.ts"))).toBe("draft a");
    expect(loadFileDraft(draftKey(K, "b.ts"))).toBeNull();
  });

  it("clearSession clears drafts for every file tab in that session, but not other sessions'", () => {
    const s = useCenterTabsStore();
    const K2 = sessionKey("i1", "s2");
    s.openFile(K, "a.ts"); s.openFile(K, "b.ts"); s.openTerminal(K);
    s.openFile(K2, "c.ts");
    saveFileDraft(draftKey(K, "a.ts"), "draft a");
    saveFileDraft(draftKey(K, "b.ts"), "draft b");
    saveFileDraft(draftKey(K2, "c.ts"), "draft c");
    s.clearSession(K);
    expect(loadFileDraft(draftKey(K, "a.ts"))).toBeNull();
    expect(loadFileDraft(draftKey(K, "b.ts"))).toBeNull();
    expect(loadFileDraft(draftKey(K2, "c.ts"))).toBe("draft c");
  });

  it("activeFor defaults to chat for an unknown session", () => {
    const s = useCenterTabsStore();
    expect(s.activeFor(sessionKey("x", "y"))).toBe("chat");
    expect(s.tabsFor(sessionKey("x", "y"))).toEqual([]);
  });

  it("openTerminal adds a terminal tab without autostart metadata", () => {
    const s = useCenterTabsStore();
    s.openTerminal(K);
    const term = s.tabsFor(K).find((t) => t.kind === "terminal");
    expect(term).toEqual({ kind: "terminal", id: "terminal" });
  });

  it("persists tab state to sessionStorage after the debounce window", async () => {
    vi.useFakeTimers();
    try {
      const s = useCenterTabsStore();
      s.openFile(K, "a.ts");
      await nextTick(); // the (pre-flush) watcher arms the debounce
      expect(sessionStorage.getItem("xacpx.center-tabs.v1")).toBeNull(); // not synchronous anymore
      vi.advanceTimersByTime(200);
      const raw = sessionStorage.getItem("xacpx.center-tabs.v1");
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!)[K].tabs.map((t: { id: string }) => t.id)).toEqual(["file:a.ts"]);
      expect(JSON.parse(raw!)[K].activeId).toBe("file:a.ts");
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a burst of mutations into a single persisted write", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(Storage.prototype, "setItem");
    try {
      const s = useCenterTabsStore();
      s.openFile(K, "a.ts");
      await nextTick();
      s.openFile(K, "b.ts");
      s.setActive(K, "chat");
      s.setDirty(K, "file:a.ts", true);
      await nextTick();
      vi.advanceTimersByTime(200);
      const writes = spy.mock.calls.filter(([k]) => k === "xacpx.center-tabs.v1");
      expect(writes.length).toBe(1); // one trailing write for the whole burst
      const parsed = JSON.parse(writes[0][1])[K];
      expect(parsed.tabs.map((t: { id: string }) => t.id)).toEqual(["file:a.ts", "file:b.ts"]);
      expect(parsed.activeId).toBe("chat");
      expect(parsed.tabs[0].dirty).toBe(true); // final state, nothing lost
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("pagehide flushes a pending write synchronously (reload right after a mutation restores it)", async () => {
    vi.useFakeTimers();
    try {
      const s = useCenterTabsStore();
      s.openFile(K, "a.ts");
      await nextTick(); // watcher armed, debounce still pending
      expect(sessionStorage.getItem("xacpx.center-tabs.v1")).toBeNull();
      window.dispatchEvent(new Event("pagehide"));
      const raw = sessionStorage.getItem("xacpx.center-tabs.v1");
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!)[K].activeId).toBe("file:a.ts");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hydrates tab state from sessionStorage on a fresh store", () => {
    sessionStorage.setItem(
      "xacpx.center-tabs.v1",
      JSON.stringify({ [K]: { tabs: [{ kind: "file", id: "file:a.ts", path: "a.ts" }], activeId: "file:a.ts" } }),
    );
    const s = useCenterTabsStore(); // fresh pinia from beforeEach ran BEFORE we set storage? see note
    expect(s.tabsFor(K).map((t) => t.id)).toEqual(["file:a.ts"]);
    expect(s.activeFor(K)).toBe("file:a.ts");
  });

  it("strips legacy autostart from restored terminal tabs", () => {
    sessionStorage.setItem(
      "xacpx.center-tabs.v1",
      JSON.stringify({ [K]: { tabs: [{ kind: "terminal", id: "terminal", autostart: true }], activeId: "terminal" } }),
    );
    const s = useCenterTabsStore();
    const term = s.tabsFor(K).find((t) => t.kind === "terminal");
    expect(term).toEqual({ kind: "terminal", id: "terminal" });
  });

  it("discards corrupt storage and bad session entries without throwing", () => {
    sessionStorage.setItem("xacpx.center-tabs.v1", "{not json");
    expect(() => useCenterTabsStore()).not.toThrow();
    expect(useCenterTabsStore().tabsFor(K)).toEqual([]);

    // Pinia memoizes the store per active pinia instance — calling useCenterTabsStore() again
    // here would just return the already-hydrated store above, not re-read storage. Activate a
    // fresh pinia so the next call re-triggers the factory's hydrate() against the new data.
    setActivePinia(createPinia());
    sessionStorage.setItem(
      "xacpx.center-tabs.v1",
      JSON.stringify({ [K]: { tabs: "nope", activeId: 5 }, "i1::s2": { tabs: [{ kind: "file", id: "file:b.ts", path: "b.ts" }], activeId: "file:b.ts" } }),
    );
    const s2 = useCenterTabsStore();
    expect(s2.tabsFor(K)).toEqual([]); // bad entry dropped
    expect(s2.tabsFor(sessionKey("i1", "s2")).map((t) => t.id)).toEqual(["file:b.ts"]); // good entry kept
  });
});

test("setDirty/isDirty track a file tab's unsaved state", () => {
  const s = useCenterTabsStore();
  const key = sessionKey("i1", "a");
  s.openFile(key, "src/x.ts");
  expect(s.isDirty(key, "file:src/x.ts")).toBe(false);
  s.setDirty(key, "file:src/x.ts", true);
  expect(s.isDirty(key, "file:src/x.ts")).toBe(true);
});

test("closeTabGuarded closes a clean tab without asking", () => {
  const s = useCenterTabsStore();
  const key = sessionKey("i1", "a");
  s.openFile(key, "src/x.ts");
  const confirm = vi.fn(() => false);
  expect(s.closeTabGuarded(key, "file:src/x.ts", confirm)).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
  expect(s.tabsFor(key).some((t) => t.id === "file:src/x.ts")).toBe(false);
});

test("openFile on an already-open dirty file preserves the dirty flag (close guard stays armed)", () => {
  const s = useCenterTabsStore();
  const key = sessionKey("i1", "a");
  s.openFile(key, "src/x.ts");
  s.setDirty(key, "file:src/x.ts", true);
  s.openFile(key, "src/x.ts"); // re-open same path (e.g. clicked in the tree again)
  expect(s.isDirty(key, "file:src/x.ts")).toBe(true);
  // guard still prompts:
  expect(s.closeTabGuarded(key, "file:src/x.ts", () => false)).toBe(false);
  expect(s.tabsFor(key).some((t) => t.id === "file:src/x.ts")).toBe(true);
});

test("closeTabGuarded blocks a dirty tab when confirm is declined", () => {
  const s = useCenterTabsStore();
  const key = sessionKey("i1", "a");
  s.openFile(key, "src/x.ts");
  s.setDirty(key, "file:src/x.ts", true);
  expect(s.closeTabGuarded(key, "file:src/x.ts", () => false)).toBe(false);
  expect(s.tabsFor(key).some((t) => t.id === "file:src/x.ts")).toBe(true);
  expect(s.closeTabGuarded(key, "file:src/x.ts", () => true)).toBe(true);
  expect(s.tabsFor(key).some((t) => t.id === "file:src/x.ts")).toBe(false);
});
